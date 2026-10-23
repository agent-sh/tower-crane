'use strict';

// Provider credentials in the OS secret store. A rung names a credential
// (`credential: NAME`); its value lives in the Linux Secret Service (the
// login keyring, through secret-tool) or in a systemd-creds file encrypted
// for the user, never in an env file, argv, project.json, events or logs.
// Each harness gets it at the moment it needs it, outside its command
// sandbox: claude on Bedrock through a per-spawn loopback broker
// (lib/bedrock-broker.js), claude on the Anthropic API through apiKeyHelper,
// and codex through its provider's auth command. Both commands run
// lib/credential-helper.js, which reads the store with the functions here.
// docs/research/credentials-keyring.md has the measurements behind this.
//
// The user file (TOWER_CRANE_CONFIG, else ~/.config/tower-crane/config.json)
// may name a store per credential: "credentials": {"NAME": {"store": S}}.
// "auto", the default, is the Secret Service, then systemd-creds, on Linux.
// The macOS Keychain and Windows Credential Manager stores follow their
// documented behaviour, are untested, and run only when the owner names them.
// "env" reads a variable from an env file the owner keeps: the per-machine
// fallback, which ladder show names on every use.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse, usage } = require('./util');

const SERVICE = 'tower-crane';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORES = ['secret-service', 'systemd-creds', 'keychain', 'wincred', 'env'];
const UNTESTED = ['keychain', 'wincred'];
const LABELS = { 'secret-service': 'Secret Service', 'systemd-creds': 'systemd-creds', keychain: 'macOS Keychain', wincred: 'Windows Credential Manager', env: 'env file' };
// codex gives its auth command 5 s (timeout_ms, codex-cli 0.163.0). A locked
// keyring answers a lookup with an unlock prompt that may never be seen, so
// the Secret Service gets 3 s and systemd-creds, read next, the rest.
const LOOKUP_MS = 3000;
const DECRYPT_MS = 1500;
// The variables a route's provider takes a credential from. A route whose
// credential is in the store starts its harness without them, wherever they
// came from: the dispatcher's environment, env or env_file.
const AUTH_ENV = {
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validName = (name) => typeof name === 'string' && NAME.test(name);
const label = (store) => `${LABELS[store]}${UNTESTED.includes(store) ? ' (untested)' : ''}`;

function configFile(env = process.env) {
  return env.TOWER_CRANE_CONFIG ? path.resolve(env.TOWER_CRANE_CONFIG) : path.join(os.homedir(), '.config', 'tower-crane', 'config.json');
}

// systemd-creds files sit beside the user file, so a test's user file keeps
// its credentials with it, and the owner's sit in ~/.config/tower-crane.
function credentialsDir(file) {
  return path.join(path.dirname(file), 'credentials');
}

function credFile(file, name) {
  return path.join(credentialsDir(file), `${name}.cred`);
}

// What is wrong with the user file's "credentials" object.
function configErrors(value) {
  if (value === undefined) return [];
  if (!isObject(value)) return ['credentials must be an object of credential names'];
  const errs = [];
  for (const [name, entry] of Object.entries(value)) {
    const where = `credentials.${name}`;
    if (!validName(name)) errs.push(`${where}: a credential name is 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit`);
    if (!isObject(entry)) {
      errs.push(`${where} must be an object {"store": ...}`);
      continue;
    }
    for (const k of Object.keys(entry)) if (!['store', 'env_file', 'var'].includes(k)) errs.push(`${where}: unknown field ${k}; it takes store, and env_file and var for store env`);
    if (entry.store !== undefined && !['auto', ...STORES].includes(entry.store)) errs.push(`${where}.store must be auto, ${STORES.join(', ')}`);
    if (entry.store === 'env') {
      if (typeof entry.env_file !== 'string' || !entry.env_file.trim() || entry.env_file.includes('\0')) errs.push(`${where}: store env needs env_file, the file that holds the value`);
      if (typeof entry.var !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.var)) errs.push(`${where}: store env needs var, the variable in env_file that holds the value`);
    } else if (entry.env_file !== undefined || entry.var !== undefined) errs.push(`${where}: env_file and var apply only to store env`);
  }
  return errs;
}

// The user file's entry for a credential. A file that cannot be read or
// parsed counts as naming no store, so the helper still finds a credential
// in the default stores; ladder and spawn refuse a broken file themselves.
function entryOf(name, file) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no file, or one ladder refuses */ }
  const entry = isObject(doc) && isObject(doc.credentials) && isObject(doc.credentials[name]) ? doc.credentials[name] : {};
  return { store: 'auto', ...entry };
}

// The stores a lookup tries, in order.
function order(name, entry, { platform = process.platform } = {}) {
  if (entry.store !== 'auto') return [entry.store];
  return platform === 'linux' ? ['secret-service', 'systemd-creds'] : [];
}

function noStore(name, file, platform = process.platform) {
  const which = platform === 'darwin' ? 'keychain' : platform === 'win32' ? 'wincred' : null;
  return refuse(`credential ${name} has no store on this machine: ${which
    ? `the ${LABELS[which]} support is untested and off by default; opt in with "credentials": {"${name}": {"store": "${which}"}} in ${file}, or`
    : 'name one in'} "credentials": {"${name}": {"store": "env", "env_file": FILE, "var": VAR}} in ${file}`);
}

// libsecret finds the session bus at $XDG_RUNTIME_DIR/bus when no address
// is set (measured with libsecret-tools 0.21.7), so a caller that has neither
// gets the runtime directory of its uid.
function busEnv(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR || typeof process.getuid !== 'function') return env;
  return { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };
}

function run(cmd, args, { input, env, timeout }) {
  return cp.spawnSync(cmd, args, { input, env, timeout, encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

// A tool's own complaint, one line, for an error message. These tools never
// print the secret on stderr.
function why(r, tool) {
  if (r.error?.code === 'ENOENT') return `${tool} is not installed`;
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return `${tool} did not answer in time; the store may be locked`;
  return String(r.stderr || '').trim().split('\n').pop().slice(0, 200) || `${tool} exited ${r.status}`;
}

// PowerShell for the Credential Manager, from the documented CredReadW and
// CredWriteW (learn.microsoft.com). Untested: no Windows host ran it. The
// value travels on stdin.
const WINCRED = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class TcCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct C { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredReadW(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWriteW(ref C c, int flags);
  [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDeleteW(string t, int type, int flags);
  [DllImport("advapi32")] static extern void CredFree(IntPtr p);
  public static string Read(string t) { IntPtr p; if (!CredReadW(t, 1, 0, out p)) return null; var c = (C)Marshal.PtrToStructure(p, typeof(C)); var s = Marshal.PtrToStringUni(c.Blob, c.BlobSize / 2); CredFree(p); return s; }
  public static bool Write(string t, string v) { var b = Encoding.Unicode.GetBytes(v); var c = new C(); c.Type = 1; c.TargetName = t; c.Persist = 2; c.UserName = "tower-crane"; c.BlobSize = b.Length; c.Blob = Marshal.AllocHGlobal(b.Length); Marshal.Copy(b, 0, c.Blob, b.Length); try { return CredWriteW(ref c, 0); } finally { Marshal.FreeHGlobal(c.Blob); } }
  public static bool Delete(string t) { return CredDeleteW(t, 1, 0); }
}
'@
$t = $env:TC_CRED_TARGET
switch ($env:TC_CRED_OP) {
  'read' { $v = [TcCred]::Read($t); if ($v -eq $null) { exit 2 }; [Console]::Out.Write($v) }
  'write' { $v = [Console]::In.ReadToEnd(); if (-not [TcCred]::Write($t, $v)) { [Console]::Error.WriteLine('CredWrite failed'); exit 1 } }
  'delete' { if (-not [TcCred]::Delete($t)) { exit 2 } }
}`;

// The script goes on argv, encoded as PowerShell takes it, and holds no
// secret; a value to write goes on stdin.
function wincred(op, name, env, input) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINCRED, 'utf16le').toString('base64')], {
    input, env: { ...env, TC_CRED_OP: op, TC_CRED_TARGET: `${SERVICE}:${name}` }, timeout: LOOKUP_MS * 3,
  });
}

// The macOS `security` tool takes a password only on its argv or at a
// prompt; its interactive mode reads the command, password included, from
// stdin, so the value never reaches argv. Untested: no macOS host ran it.
function keychainQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// One store's answer for a credential: { found: value } or { absent: true }
// or { failed: reason }. Never throws.
function lookup(store, name, { env = process.env, file = configFile(env), entry = {} } = {}) {
  if (store === 'secret-service') {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'name', name], { env: busEnv(env), timeout: LOOKUP_MS });
    if (r.status === 0 && r.stdout) return { found: r.stdout };
    // secret-tool exits 1 with nothing on stderr when no item matches.
    if (r.status === 1 && !String(r.stderr).trim() && !r.error) return { absent: true };
    return { failed: why(r, 'secret-tool') };
  }
  if (store === 'systemd-creds') {
    const cred = credFile(file, name);
    if (!fs.existsSync(cred)) return { absent: true };
    const r = run('systemd-creds', ['--user', 'decrypt', `--name=${name}`, cred, '-'], { env, timeout: DECRYPT_MS });
    return r.status === 0 ? { found: r.stdout } : { failed: why(r, 'systemd-creds') };
  }
  if (store === 'keychain') {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { env, timeout: LOOKUP_MS });
    if (r.status === 0) return { found: r.stdout.replace(/\n$/, '') };
    // errSecItemNotFound
    return r.status === 44 ? { absent: true } : { failed: why(r, 'security') };
  }
  if (store === 'wincred') {
    const r = wincred('read', name, env);
    if (r.status === 0) return { found: r.stdout };
    return r.status === 2 ? { absent: true } : { failed: why(r, 'powershell.exe') };
  }
  if (store === 'env') {
    const envFile = expandHome(entry.env_file);
    let text;
    try { text = fs.readFileSync(envFile, 'utf8'); } catch (e) { return { failed: `cannot read ${envFile} (${e.code})` }; }
    let vars;
    try { vars = require('./spawn-settings').parseEnv(text, envFile); } catch (e) { return { failed: e.message }; }
    return vars[entry.var] ? { found: vars[entry.var] } : { absent: true };
  }
  return { failed: `unknown store ${store}` };
}

// The helper runs with the agent's HOME, so ~ is the account's home.
function expandHome(p) {
  const home = os.userInfo().homedir;
  return p === '~' ? home : /^~[/\\]/.test(p) ? path.join(home, p.slice(2)) : path.resolve(p);
}

// The credential's value and the store that held it, or a refusal that says
// where it looked and what fixes it, never the value.
function read(name, { env = process.env, file = configFile(env), platform = process.platform, store } = {}) {
  if (!validName(name)) throw usage(`credential name ${JSON.stringify(String(name)).slice(0, 80)} is not 1 to 64 letters, digits, dots, underscores or hyphens`);
  const entry = store ? { ...entryOf(name, file), store } : entryOf(name, file);
  const stores = order(name, entry, { platform });
  if (!stores.length) throw noStore(name, file, platform);
  const seen = [];
  for (const s of stores) {
    const r = lookup(s, name, { env, file, entry });
    if (r.found !== undefined) return { value: r.found, store: s };
    seen.push({ store: s, ...r });
  }
  const failed = seen.filter((s) => s.failed);
  const where = seen.map((s) => `${label(s.store)}: ${s.failed || 'not stored'}`).join('; ');
  if (!failed.length) {
    throw refuse(`tower-crane credential ${name} is not stored (${where}); store it with tower-crane credentials set ${name}${entry.store === 'env' ? `, or add ${entry.var} to ${entry.env_file}` : ''}`);
  }
  const hint = failed.some((s) => s.store === 'secret-service')
    ? `unlock the login keyring, or store it with systemd-creds: tower-crane credentials set ${name} --store systemd-creds`
    : `fix that store, or run tower-crane credentials set ${name}`;
  throw refuse(`tower-crane credential ${name} cannot be read (${where}); ${hint}`);
}

function check(name, opts = {}) {
  try {
    return { ok: true, store: read(name, opts).store };
  } catch (e) {
    return { ok: false, problem: e.message };
  }
}

// Where `credentials set` writes: the store named, else the user file's,
// else the first of the platform's defaults that takes it.
function write(name, value, { env = process.env, file = configFile(env), store, platform = process.platform } = {}) {
  if (!validName(name)) throw usage(`credential name ${JSON.stringify(String(name)).slice(0, 80)} is not 1 to 64 letters, digits, dots, underscores or hyphens`);
  if (typeof value !== 'string' || !value.length) throw usage('the credential value is empty');
  if (value.includes('\0')) throw usage('the credential value holds a NUL byte');
  const entry = store ? { ...entryOf(name, file), store } : entryOf(name, file);
  const stores = order(name, entry, { platform });
  if (!stores.length) throw noStore(name, file, platform);
  const failures = [];
  for (const s of stores) {
    const err = put(s, name, value, { env, file });
    if (!err) return { store: s, shadowed: shadows(name, s, stores, { env, file, entry }) };
    failures.push(`${label(s)}: ${err}`);
  }
  throw refuse(`could not store credential ${name} (${failures.join('; ')})`);
}

// A store read before the one just written that still holds the name: the
// new value would never be read.
function shadows(name, written, stores, opts) {
  const before = stores.slice(0, stores.indexOf(written));
  return before.filter((s) => lookup(s, name, opts).found !== undefined);
}

function put(store, name, value, { env, file }) {
  if (store === 'secret-service') {
    const r = run('secret-tool', ['store', `--label=${SERVICE} ${name}`, 'service', SERVICE, 'name', name], { input: value, env: busEnv(env), timeout: LOOKUP_MS * 3 });
    return r.status === 0 ? null : why(r, 'secret-tool');
  }
  if (store === 'systemd-creds') {
    const r = cp.spawnSync('systemd-creds', ['--user', 'encrypt', `--name=${name}`, '-', '-'], { input: value, env, timeout: LOOKUP_MS * 3, maxBuffer: 1 << 20, windowsHide: true });
    if (r.status !== 0) return why({ ...r, stderr: String(r.stderr || '') }, 'systemd-creds');
    const dir = credentialsDir(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, r.stdout, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, credFile(file, name));
    return null;
  }
  if (store === 'keychain') {
    const r = run('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${keychainQuote(name)} -w ${keychainQuote(value)}\n`, env, timeout: LOOKUP_MS * 3 });
    return r.status === 0 ? null : why(r, 'security');
  }
  if (store === 'wincred') {
    const r = wincred('write', name, env, value);
    return r.status === 0 ? null : why(r, 'powershell.exe');
  }
  if (store === 'env') return 'Tower Crane does not write env files; edit the file the user file names';
  return `unknown store ${store}`;
}

// Removes the credential from the named store, or from every store a lookup
// would try. Returns the stores that held it.
function remove(name, { env = process.env, file = configFile(env), store, platform = process.platform } = {}) {
  if (!validName(name)) throw usage(`credential name ${JSON.stringify(String(name)).slice(0, 80)} is not 1 to 64 letters, digits, dots, underscores or hyphens`);
  const entry = store ? { ...entryOf(name, file), store } : entryOf(name, file);
  if (entry.store === 'env') throw refuse(`credential ${name} reads ${entry.env_file}; remove ${entry.var} from that file yourself`);
  const stores = order(name, entry, { platform });
  if (!stores.length) throw noStore(name, file, platform);
  const removed = [];
  const failures = [];
  for (const s of stores) {
    const held = lookup(s, name, { env, file, entry });
    if (held.absent) continue;
    let err = null;
    if (s === 'secret-service') {
      const r = run('secret-tool', ['clear', 'service', SERVICE, 'name', name], { env: busEnv(env), timeout: LOOKUP_MS });
      err = r.status === 0 ? null : why(r, 'secret-tool');
    } else if (s === 'systemd-creds') {
      try { fs.rmSync(credFile(file, name)); } catch (e) { err = e.code === 'ENOENT' ? null : e.message; }
    } else if (s === 'keychain') {
      const r = run('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { env, timeout: LOOKUP_MS });
      err = r.status === 0 || r.status === 44 ? null : why(r, 'security');
    } else if (s === 'wincred') {
      const r = wincred('delete', name, env);
      err = r.status === 0 || r.status === 2 ? null : why(r, 'powershell.exe');
    }
    if (err) failures.push(`${label(s)}: ${held.failed || err}`);
    else removed.push(s);
  }
  if (failures.length) throw refuse(`could not remove credential ${name} (${failures.join('; ')})`);
  return removed;
}

// --- routes -------------------------------------------------------------

// How a route uses its credential: the claude Bedrock broker, claude's
// apiKeyHelper, codex's provider auth command, or not at all.
function mode(route) {
  if (!route?.credential) return null;
  if (route.harness === 'claude') return route.provider === 'bedrock' || route.upstream ? 'broker' : route.provider === 'anthropic' ? 'api-key-helper' : null;
  if (route.harness === 'codex') return 'auth-command';
  return null;
}

// The variables a route's harness starts without, since its credential
// reaches it another way.
function authEnv(route) {
  const m = mode(route);
  if (m === 'broker' && route.upstream) return [...AUTH_ENV.bedrock, ...AUTH_ENV.anthropic];
  if (m === 'broker' || m === 'auth-command') return AUTH_ENV.bedrock;
  if (m === 'api-key-helper') return AUTH_ENV.anthropic;
  return [];
}

// The helper argv a harness runs to read a credential, with the user file
// it reads named, since the harness's HOME is the agent's own.
function helperArgv(toolRoot, name, { env = process.env } = {}) {
  return [process.execPath, path.join(toolRoot, 'lib', 'credential-helper.js'), 'value', name, '--config', configFile(env)];
}

// What stops a route from running with its credential, checked before
// spawn starts anything: the harness takes no credential, the session bus
// is granted, or the store has none.
function preflight(route, settings, { env = process.env, from } = {}) {
  if (!route?.credential) return [];
  const name = route.credential;
  const m = mode(route);
  if (!m) {
    return [route.harness === 'claude'
      ? `credential ${name} on claude needs provider bedrock or anthropic; set it with tower-crane ladder set RUNG --provider`
      : `credential ${name} applies only to claude and codex rungs, not ${route.harness}`];
  }
  if (m === 'auth-command') {
    const provider = require('./ladder').codexProvider(route, env, from);
    if (!provider || provider === 'openai' || ['ollama', 'lmstudio', 'oss'].includes(provider)) {
      return [`credential ${name} on codex needs a provider that takes an auth command, amazon-bedrock or a custom one, and the route runs ${provider || 'an unknown provider'}`];
    }
  }
  // A sandboxed command that reaches the session bus can start a user unit
  // with systemd-run --user, and the user manager runs that unit outside the
  // sandbox as the owner, where every store and the helper answer it. No
  // store keeps a credential from such a command.
  if (settings?.sandbox?.session_bus === true) {
    return [`credential ${name} cannot run with sandbox.session_bus: a command in the sandbox can start a user unit over the session bus, and that unit runs outside the sandbox as the owner, where it can read the credential from any store; clear sandbox.session_bus (tower-crane project set --session-bus false), or drop the credential from this route`];
  }
  try {
    read(name, { env, file: configFile(env) });
  } catch (e) {
    return [e.message];
  }
  return [];
}

// What ladder show says about a route's credentials: the env store and
// env_file, each a credential path through a file or the environment.
function notices(rungName, route, env = process.env) {
  const out = [];
  if (route.credential) {
    const file = configFile(env);
    const entry = entryOf(route.credential, file);
    if (entry.store === 'env') out.push(`ladder ${rungName}: credential ${route.credential} reads ${entry.var} from ${entry.env_file} (store env, the per-machine fallback ${file} opts into)`);
    else if (UNTESTED.includes(entry.store)) out.push(`ladder ${rungName}: credential ${route.credential} uses the ${label(entry.store)} store`);
  }
  if (route.env_file !== undefined) out.push(`ladder ${rungName}: env_file ${route.env_file} puts its variables in the harness environment; a credential in the OS store keeps a secret out of it`);
  return out;
}

// --- CLI ----------------------------------------------------------------

function refuseTask(env) {
  if (env.TOWER_CRANE_TASK !== undefined || env.TOWER_CRANE_BROKER !== undefined) {
    throw refuse('a task process never manages credentials; the owner runs tower-crane credentials at a terminal');
  }
}

function storeFlag(flags) {
  if (flags.store === undefined) return undefined;
  if (!STORES.includes(flags.store)) throw usage(`--store must be one of ${STORES.join(', ')}`);
  return flags.store;
}

// A value typed at a terminal is not echoed. One piped in loses one
// trailing line break, which echo and a here-string add.
function readValue() {
  if (require('node:tty').isatty(0)) {
    process.stderr.write('value (not echoed, Enter ends it): ');
    const buf = Buffer.alloc(1);
    const bytes = [];
    process.stdin.setRawMode?.(true);
    try {
      for (;;) {
        let n;
        try { n = fs.readSync(0, buf, 0, 1, null); } catch (e) {
          if (e.code === 'EAGAIN') {
            require('./util').sleepSync(10);
            continue;
          }
          throw e;
        }
        if (n === 0 || buf[0] === 0x0d || buf[0] === 0x0a) break;
        if (buf[0] === 0x03) throw refuse('cancelled');
        if (buf[0] === 0x7f || buf[0] === 0x08) bytes.pop();
        else bytes.push(buf[0]);
      }
    } finally {
      process.stdin.setRawMode?.(false);
      process.stderr.write('\n');
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return require('./util').readStdin().replace(/\r?\n$/, '');
}

function shadowText(name, shadowed) {
  return shadowed.length ? `\nwarning: ${shadowed.map(label).join(', ')} also holds ${name} and is read first; remove it with tower-crane credentials rm ${name} --store ${shadowed[0]}` : '';
}

function setCommand(ctx) {
  refuseTask(ctx.env);
  const [name] = ctx.pos;
  const store = storeFlag(ctx.flags);
  const r = write(name, readValue(), { env: ctx.env, store });
  return { data: { name, store: r.store, ...(r.shadowed.length ? { shadowed_by: r.shadowed } : {}) }, text: `stored credential ${name} in ${label(r.store)}${shadowText(name, r.shadowed)}` };
}

function importCommand(ctx) {
  refuseTask(ctx.env);
  const { 'env-file': envFile, var: variable, name } = ctx.flags;
  const store = storeFlag(ctx.flags);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw usage('--var must be a variable name');
  const file = path.resolve(ctx.cwd, envFile.replace(/^~(?=[/\\]|$)/, ctx.env.HOME || os.homedir()));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw refuse(`cannot read ${file} (${e.code})`); }
  const vars = require('./spawn-settings').parseEnv(text, file);
  if (!vars[variable]) throw refuse(`${file} sets no ${variable}`);
  const r = write(name, vars[variable], { env: ctx.env, store });
  return {
    data: { name, store: r.store, from: { env_file: file, var: variable }, ...(r.shadowed.length ? { shadowed_by: r.shadowed } : {}) },
    text: `stored credential ${name} in ${label(r.store)} from ${variable} in ${file}; remove that line from the file once nothing else reads it${shadowText(name, r.shadowed)}`,
  };
}

// The names to check: those given, else the user file's and those the
// current project's ladder names, when there is one.
function namesToCheck(ctx) {
  if (ctx.pos.length) return ctx.pos;
  const names = new Set();
  try {
    const doc = JSON.parse(fs.readFileSync(configFile(ctx.env), 'utf8'));
    for (const n of Object.keys(isObject(doc?.credentials) ? doc.credentials : {})) names.add(n);
  } catch { /* no user file */ }
  try {
    const S = require('./state');
    const L = require('./ladder');
    const st = S.loadState(S.locateStateDir(undefined, ctx.env, ctx.cwd));
    const layers = L.resolve(st.project, ctx.env);
    for (const n of L.RUNGS) for (const route of L.routes(L.rungOf(layers, n))) if (route.credential) names.add(route.credential);
  } catch { /* not in a project */ }
  return [...names].sort();
}

function checkCommand(ctx) {
  const names = namesToCheck(ctx);
  if (!names.length) return { data: { credentials: [] }, text: `no credential is named in ${configFile(ctx.env)} or this project's ladder` };
  const results = names.map((name) => ({ name, ...check(name, { env: ctx.env }) }));
  return {
    data: { credentials: results },
    text: results.map((r) => (r.ok ? `${r.name}: stored in ${label(r.store)}` : `${r.name}: ${r.problem}`)).join('\n'),
    code: results.every((r) => r.ok) ? 0 : 1,
  };
}

function rmCommand(ctx) {
  refuseTask(ctx.env);
  const [name] = ctx.pos;
  const removed = remove(name, { env: ctx.env, store: storeFlag(ctx.flags) });
  return { data: { name, removed }, text: removed.length ? `removed credential ${name} from ${removed.map(label).join(', ')}` : `credential ${name} was not stored` };
}

module.exports = {
  SERVICE, STORES, UNTESTED, AUTH_ENV, LOOKUP_MS, validName, configFile, credentialsDir, credFile, configErrors, entryOf, order, lookup, read, check, write, remove,
  mode, authEnv, helperArgv, preflight, notices, setCommand, importCommand, checkCommand, rmCommand,
};
