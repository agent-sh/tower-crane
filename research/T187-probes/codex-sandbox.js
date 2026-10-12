'use strict';
// What a codex permission profile can express for reads under $HOME, run
// against the real codex sandbox (`codex sandbox`) on the host: nested user
// namespaces are refused inside an agent's sandbox. No model call is made.
//
//   node research/T187-probes/codex-sandbox.js [path/to/codex]
//
// The default codex is the one installed next to this node. A scratch
// CODEX_HOME keeps the user's config out; probe files are created under
// $HOME/.cache/tower-crane-t187-probe-<pid> and removed at exit. Only
// readable/denied verdicts are printed, never file contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const home = fs.realpathSync(os.homedir());
const codex = process.argv[2] || path.join(path.dirname(process.execPath), 'codex');
const scratch = path.join(home, '.cache', `tower-crane-t187-probe-${process.pid}`);
const codexHome = path.join(scratch, 'codex-home');
const allowedRead = path.join(scratch, 'allowed-read');
const allowedWrite = path.join(scratch, 'allowed-write');
const secret = path.join(home, `tower-crane-t187-secret-test-${process.pid}`);
const nodePrefix = path.dirname(path.dirname(fs.realpathSync(process.execPath)));

fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, 'config.toml'), '');
for (const d of [allowedRead, allowedWrite]) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'file'), 'probe\n');
}
fs.writeFileSync(secret, 'probe\n');
process.on('exit', () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(secret, { force: true });
});

const targets = {
  secret, allowedRead: path.join(allowedRead, 'file'), allowedWrite: path.join(allowedWrite, 'file'),
  gh: path.join(home, '.config', 'gh'), claude: path.join(home, '.claude', '.credentials.json'),
  codexAuth: path.join(home, '.codex', 'auth.json'), aws: path.join(home, '.aws'),
  docker: path.join(home, '.docker', 'config.json'), npmrc: path.join(home, '.npmrc'),
  netrc: path.join(home, '.netrc'), gitconfig: path.join(home, '.gitconfig'), homeDir: home,
  etc: '/etc/hostname', usr: '/usr/bin/git',
};
// Runs inside the sandbox: report each target as readable or the error code.
const check = `const fs=require("fs");const t=${JSON.stringify(targets)};const o={};for(const[k,p]of Object.entries(t)){try{const s=fs.statSync(p);if(s.isDirectory())fs.readdirSync(p);else fs.closeSync(fs.openSync(p,"r"));o[k]="readable"}catch(e){o[k]="ERR "+e.code}}try{fs.writeFileSync(${JSON.stringify(path.join(allowedWrite, 'w'))},"x");o.writeAllowed="wrote"}catch(e){o.writeAllowed="ERR "+e.code}console.log(JSON.stringify(o))`;

// Every top-level directory except the ones on the way to $HOME is readable;
// on that way, every sibling is. What stays out is $HOME itself.
function outsideHome() {
  const roots = [];
  let dir = '/';
  for (const part of home.split(path.sep).filter(Boolean)) {
    for (const e of fs.readdirSync(dir)) {
      if (e === part || (dir === '/' && ['proc', 'dev', 'sys'].includes(e))) continue;
      roots.push(path.join(dir, e));
    }
    dir = path.join(dir, part);
  }
  return roots;
}

const toml = (rules) => `{${Object.entries(rules).map(([k, v]) => `${JSON.stringify(k)}=${typeof v === 'string' ? JSON.stringify(v) : toml(v)}`).join(',')}}`;
const variants = {
  // T106's shape: read everything, hide $HOME, reopen a read-only path in it.
  nestedRead: { ':root': 'read', ':tmpdir': 'write', [home]: 'none', [allowedRead]: 'read', [nodePrefix]: 'read', [allowedWrite]: 'write' },
  // No :root. Read only the listed roots, so $HOME is never mounted.
  restricted: { ':minimal': 'read', ':tmpdir': 'write', ...Object.fromEntries(outsideHome().map((p) => [p, 'read'])), [allowedRead]: 'read', [nodePrefix]: 'read', [allowedWrite]: 'write' },
};

const out = { codex: cp.spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(), home: '~', variants: {} };
for (const [name, rules] of Object.entries(variants)) {
  const r = cp.spawnSync(codex, ['sandbox', '-c', 'default_permissions="t187"', '-c', `permissions.t187.filesystem=${toml(rules)}`,
    '-c', 'permissions.t187.network={enabled=false}', '--', process.execPath, '-e', check], {
    encoding: 'utf8', cwd: allowedWrite, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60000,
  });
  let result;
  try { result = JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { result = { exit: r.status, stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-1500) }; }
  out.variants[name] = { rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k.split(home).join('~'), v])), result };
}
const text = JSON.stringify(out, null, 2).split(home).join('~');
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'codex-sandbox.json'), `${text}\n`);
console.log(text);
