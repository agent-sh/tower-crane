'use strict';

// GitHub for a sandboxed agent. Its sandbox holds no GitHub credential: no
// GH_TOKEN, no git credential helper that answers, no gh login. Its git and
// gh shims send a push or a gh command to the spawn's broker (lib/broker.js),
// which checks it here, outside the sandbox, against the agent's role and
// task, and runs it with the user's own login.
//
// A push names only a commit. The destination is the task's branch on the
// task repository's origin, which the broker reads and checks itself. The
// agent's shim sends a pack of the commit, built in its sandbox; the broker
// indexes it into a repository of its own, which hashes every object it
// receives, and the checks and the push read only that repository, never the
// object store or config the agent writes.
// A gh command is parsed with the flag table of lib/gh-flags.json, runs in
// the project's recorded repository with no local repository for gh to
// read, and in an environment holding nothing but what gh needs.
//
// Processes here run with node's child_process, not lib/commands.js: that
// module hardens git started in a repository the agent writes, and these
// run in the broker's own repository or in none.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse, usage } = require('./util');
const S = require('./state');

const FLAGS = require('./gh-flags.json').commands;

// The variables gh and the API take a token from.
const TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// --- gh arguments -----------------------------------------------------------

// gh's flags parse like pflag: --name=value, --name value, -x value, -xvalue
// and clusters of one-letter booleans. A flag the table does not list for the
// command is refused, so a value is never taken for a positional or back.
function parseGh(args) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw usage('gh arguments must be strings');
  const command = args.slice(0, 2).join(' ');
  const table = FLAGS[command];
  if (!table || args.length < 2 || args[0].startsWith('-') || args[1].startsWith('-')) {
    throw refuse(`gh ${args.slice(0, 2).join(' ')} is not available to a sandboxed agent; it may run ${Object.keys(FLAGS).join(', ')}`);
  }
  const short = Object.fromEntries(Object.entries(table).filter(([, f]) => f.short).map(([name, f]) => [f.short, name]));
  const flags = [];
  const pos = [];
  let rest = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (rest || a === '-' || !a.startsWith('-')) {
      pos.push(a);
    } else if (a === '--') {
      rest = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const spec = Object.hasOwn(table, name) ? table[name] : null;
      if (!spec) throw usage(`gh ${command} has no flag --${name}`);
      if (spec.value) {
        if (eq < 0 && i + 1 >= args.length) throw usage(`gh ${command} --${name} needs a value`);
        flags.push({ name, value: eq < 0 ? args[++i] : a.slice(eq + 1) });
      } else {
        const value = eq < 0 ? undefined : a.slice(eq + 1);
        if (value !== undefined && !['true', 'false'].includes(value)) throw usage(`gh ${command} --${name} takes true or false`);
        flags.push({ name, ...(value === undefined ? {} : { value }) });
      }
    } else {
      for (let j = 1; j < a.length; j++) {
        const name = Object.hasOwn(short, a[j]) ? short[a[j]] : null;
        if (!name) throw usage(`gh ${command} has no flag -${a[j]}`);
        if (table[name].value) {
          const inline = a.slice(j + 1);
          if (!inline && i + 1 >= args.length) throw usage(`gh ${command} -${a[j]} needs a value`);
          flags.push({ name, value: inline || args[++i] });
          break;
        }
        flags.push({ name });
      }
    }
  }
  return { command, flags, pos };
}

// The arguments in one spelling: long flags with = values, then "--" and the
// positionals, so gh reads them as this parser did.
function buildGh({ command, flags, pos }) {
  const table = FLAGS[command];
  return [...command.split(' '), ...flags.map((f) => (table[f.name].value || f.value !== undefined ? `--${f.name}=${f.value}` : `--${f.name}`)),
    ...(pos.length ? ['--', ...pos] : [])];
}

// --- the task ---------------------------------------------------------------

// The role's agent file, as lib/agents.js renders its shims.
function rolePolicy(job) {
  const A = require('./agents');
  return A.policy(A.load(job.role === 'worker' && job.rung === 'research' ? 'researcher' : job.role));
}

function taskOf(job) {
  const st = S.loadState(job.state);
  const task = st.tasks.tasks.find((t) => t.id === job.task);
  if (!task) throw refuse(`no task ${job.task}`);
  return { st, project: st.project, task };
}

function briefOf(job) {
  try {
    return fs.readFileSync(path.join(job.state, 'briefs', `${job.task}.md`), 'utf8');
  } catch {
    return '';
  }
}

// The task repository's git directory, as spawn found it on the host.
function commonDir(job) {
  return job.dispatch?.gitDirs?.common || job.dispatch?.repo?.commonDir || null;
}

const GITHUB = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;
const LOCAL = /^(?:\/|file:\/\/|[A-Za-z]:[\\/])/;

// origin's URLs under key, read from the repository's config file without
// its includes or URL rewriting.
function originUrls(common, key) {
  const r = cp.spawnSync('git', ['config', '--file', path.join(common, 'config'), '--no-includes', '--get-all', key],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

// Where a push goes: origin's push URL. Agents can write the config file, so
// the URL must be the project's recorded GitHub repository, or a path on this
// machine for a project that records none (test fixtures).
function pushTarget(common, repo) {
  const pushUrls = originUrls(common, 'remote.origin.pushurl');
  const urls = pushUrls.length ? pushUrls : originUrls(common, 'remote.origin.url');
  if (urls.length !== 1) throw refuse(`the task repository's origin has ${urls.length} push URLs; the broker pushes to exactly one`);
  const [url] = urls;
  if (repo) {
    const m = GITHUB.exec(url);
    if (!m || m[1].toLowerCase() !== repo.toLowerCase()) throw refuse(`origin pushes to ${url}, not to the project's repository ${repo}`);
    return url;
  }
  if (LOCAL.test(url)) return url;
  throw refuse(`origin pushes to ${url}, and the project records no repository to check it against (tower-crane project set --repo)`);
}

// Where a fetch reads: origin's URL, which must be the project's recorded
// GitHub repository. A fetch hands the agent what the broker reads with the
// user's login, so no other URL is taken, not even a path on this machine,
// which could name a repository the sandbox hides. A local origin the
// sandbox can read is fetched there, without the broker.
function fetchTarget(common, repo) {
  const urls = originUrls(common, 'remote.origin.url');
  if (urls.length !== 1) throw refuse(`the task repository's origin has ${urls.length} URLs; the broker fetches from exactly one`);
  const [url] = urls;
  if (!repo) throw refuse(`origin is ${url}, and the project records no repository to check it against (tower-crane project set --repo)`);
  const m = GITHUB.exec(url);
  if (!m || m[1].toLowerCase() !== repo.toLowerCase()) throw refuse(`origin is ${url}, not the project's repository ${repo}`);
  return url;
}

// Workflow files a task may change: those its title, acceptance or brief
// names, by file or by a directory above it.
function workflowAllowed(task, brief) {
  const named = require('./scope').tokens([task.title, ...(task.acceptance || []), brief].join('\n'))
    .map((t) => t.replace(/\\/g, '/').replace(/\/+$/, '')).filter((t) => t === '.github' || t.startsWith('.github/'));
  return (file) => named.some((t) => file === t || file.startsWith(`${t}/`));
}
const WORKFLOW = /^\.github\/(?:workflows|actions)\//;

// --- processes --------------------------------------------------------------

// Runs a command in a process group of its own, which io.track lets the
// broker stop with the agent. Output goes to io when stream is set, and is
// collected otherwise. A bounded command (git talking to the remote, under
// the cache lock) is stopped with what it started after LIMITS.idleMs
// without a byte of output or LIMITS.totalMs in all, and its result names
// the limit in stalled.
function run(command, args, { cwd, env, input, stream, bounded }, io) {
  return new Promise((resolve) => {
    const child = cp.spawn(command, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true });
    io.track(child);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      // A string, or a stream such as the pack the agent sends.
      if (typeof input === 'string') child.stdin.end(input);
      else input.on('error', () => child.stdin.destroy()).pipe(child.stdin);
    }
    let stdout = '';
    let stderr = '';
    let stalled = null;
    let idle = null;
    let total = null;
    const arm = () => {
      if (!bounded || stalled) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), LIMITS.idleMs);
    };
    // ssh or a remote helper git started can hold the output pipes open
    // after git is gone, and then close never comes: destroy them too.
    const stop = (reason) => {
      stalled = reason;
      require('./broker').stopTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    if (bounded) {
      total = setTimeout(() => stop('total'), LIMITS.totalMs);
      arm();
    }
    child.stdout.setEncoding('utf8').on('data', (d) => { arm(); if (stream) io.stdout(d); else stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { arm(); if (stream) io.stderr(d); else stderr += d; });
    const done = (result) => {
      clearTimeout(idle);
      clearTimeout(total);
      resolve({ ...result, stalled });
    };
    child.on('error', (e) => done({ code: 127, stdout, stderr: `${stderr}${command}: ${e.message}\n` }));
    child.on('close', (code) => done({ code: stalled ? 1 : code ?? 1, stdout, stderr }));
  });
}

// What a terminal shows of git's output: each line as its last carriage
// return left it, so progress reads as its final state.
function shown(text) {
  return String(text).split('\n').map((line) => line.replace(/\r+$/, '').split('\r').pop()).join('\n').trim();
}

// The broker's environment for git: the user's own, without anything that
// would point git at another repository, and without git's tracing, whose
// output would reach the agent with the push's stderr.
const GIT_DROP = /^(?:GIT_TRACE.*|GIT_CURL_VERBOSE|GIT_REDACT_COOKIES|GIT_SSH_VARIANT_DEBUG)$/i;
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_QUARANTINE_PATH', 'GIT_REPLACE_REF_BASE']) delete env[key];
  for (const key of Object.keys(env)) if (GIT_DROP.test(key)) delete env[key];
  return env;
}

// The directory gh reads its config and hosts from, as gh finds it.
function ghConfigDir(env) {
  if (env.GH_CONFIG_DIR) return path.resolve(env.GH_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.APPDATA) return path.resolve(env.APPDATA, 'GitHub CLI');
  return path.resolve(env.HOME || os.homedir(), '.config', 'gh');
}

// Whether file is dir or inside it, through links on either side.
function within(file, dir) {
  const real = (p) => {
    const rest = [];
    for (let at = path.resolve(p); ; at = path.dirname(at)) {
      try { return path.join(fs.realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet */ }
      if (path.dirname(at) === at) return path.resolve(p);
      rest.push(path.basename(at));
    }
  };
  const rel = path.relative(real(dir), real(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// What gh needs from the user's environment: where its login is, the
// session bus its keyring answers on, and the network settings. gh's --jq
// can read any variable it runs with, so nothing else goes in.
const GH_KEEP = /^(?:PATH|PATHEXT|HOME|USER|LOGNAME|USERNAME|USERPROFILE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMDATA|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|GH_CONFIG_DIR|GH_HOST|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_(?:FILE|DIR))$/i;

function ghEnv(job) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => GH_KEEP.test(k) || TOKEN_ENV.includes(k.toUpperCase())));
  const config = ghConfigDir(env);
  const inside = [job.state, job.cwd, commonDir(job)].filter(Boolean).find((d) => within(config, d));
  if (inside) throw refuse(`gh's config directory ${config} is inside ${inside}, which an agent can write; the broker runs gh with the user's own config only`);
  // gh runs git to find a local repository; this one does not exist.
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1',
    GIT_DIR: path.join(job.state, 'push', 'no-repository') };
}

// --- gh ---------------------------------------------------------------------

// Commands whose first positional names a pull request, and those that
// change one: they act on the task's own pull request only.
const PR_WRITES = new Set(['pr close', 'pr comment', 'pr edit', 'pr merge', 'pr ready', 'pr reopen', 'pr review']);
const PR_SELECTOR = new Set(['pr checks', 'pr diff', 'pr view', ...PR_WRITES]);
// Flags that act on the host rather than on GitHub: a browser, an editor, a
// file read by path, a saved form, the token itself.
const HOST_FLAGS = new Set(['web', 'editor', 'recover', 'show-token', 'attach']);

// The gh command the broker runs for args, checked against the role and task.
function ghCommand(job, args, env) {
  const policy = rolePolicy(job);
  const why = require('./shim').ghDenied(args, policy);
  if (why) throw refuse(`${why} is not allowed by this agent's agent file`);
  const parsed = parseGh(args);
  const { command, flags, pos } = parsed;
  if (job.body_fix && (command === 'pr create'
    || command === 'pr edit' && flags.some((f) => !['repo', 'body', 'body-file', 'title'].includes(f.name)))) {
    throw refuse('PR-body repair permits only gh pr edit --body, --body-file or --title');
  }
  const { project, task } = taskOf(job);
  const repo = project.repo;
  if (!repo) throw refuse('gh through the broker needs the project\'s repository (tower-crane project set --repo)');
  const table = FLAGS[command];
  const token = TOKEN_ENV.some((k) => env[k]);
  const kept = [];
  for (const f of flags) {
    if (HOST_FLAGS.has(f.name)) throw refuse(`gh ${command} --${f.name} would act on the broker's host; a sandboxed agent cannot use it`);
    if (table[f.name].value === 'file' && !(f.name === 'body-file' && f.value === '-')) {
      throw refuse(`gh ${command} --${f.name} reads a file on the broker's host; the gh shim sends --body-file content itself`);
    }
    if (f.name === 'jq' && token) throw refuse(`gh --jq can read the token gh runs with here; use --json and read the output`);
    if (f.name === 'repo') {
      if (f.value.toLowerCase() !== repo.toLowerCase()) throw refuse(`gh runs in the project's repository ${repo} only, not ${f.value}`);
      continue;
    }
    if (f.name === 'head' && command === 'pr create' && f.value !== task.branch) {
      throw refuse(`a pull request comes from the task branch ${task.branch}, not ${f.value}`);
    }
    kept.push(f);
  }
  for (const p of pos) if (/:\/\/|(?:^|\/)github\.com\//i.test(p)) throw refuse(`gh runs in the project's repository ${repo} only; name a pull request by number or branch, not ${p}`);
  if (command === 'repo view' && pos.length && pos[0].toLowerCase() !== repo.toLowerCase()) throw refuse(`gh repo view shows the project's repository ${repo} only`);
  const out = { command, flags: kept, pos: [...pos] };
  if (table.repo) out.flags.push({ name: 'repo', value: repo });
  if (command === 'repo view' && !pos.length) out.pos = [repo];
  if (command === 'pr create' && !kept.some((f) => f.name === 'head')) {
    if (!task.branch) throw refuse(`${job.task} has no branch for a pull request`);
    out.flags.push({ name: 'head', value: task.branch });
  }
  // No local branch here: a pull request command without one is the task's.
  if (PR_SELECTOR.has(command) && !out.pos.length) {
    if (!task.branch) throw refuse(`${job.task} has no branch; name the pull request`);
    out.pos = [task.branch];
  }
  return { parsed: out, repo, branch: task.branch, write: PR_WRITES.has(command) };
}

// The number of the task's own pull request that selector names.
async function ownPr(job, cmd, env, io) {
  const r = await run('gh', ['pr', 'view', `--repo=${cmd.repo}`, '--json', 'number,headRefName,isCrossRepository', '--', cmd.parsed.pos[0]],
    { cwd: job.state, env }, io);
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { pr = null; }
  if (r.code !== 0 || !pr) throw refuse(`cannot read pull request ${cmd.parsed.pos[0]}: ${String(r.stderr).trim() || `gh exited ${r.code}`}`);
  if (pr.isCrossRepository || pr.headRefName !== cmd.branch) {
    throw refuse(`pull request #${pr.number} is from ${pr.headRefName}, not the task branch ${cmd.branch}; a sandboxed agent changes its own pull request only`);
  }
  return String(pr.number);
}

async function gh(job, args, input, io) {
  const env = ghEnv(job);
  const cmd = ghCommand(job, args, env);
  if (cmd.write) cmd.parsed.pos = [await ownPr(job, cmd, env, io), ...cmd.parsed.pos.slice(1)];
  const r = await run('gh', buildGh(cmd.parsed), { cwd: job.state, env, input, stream: true }, io);
  return r.code;
}

// --- push -------------------------------------------------------------------

// The broker opens nothing in the task repository's object store. The agent
// can write it, so a file there could be rewritten content under an object's
// name, or a link or an alternates entry that points the broker, which reads
// with the user's permissions, at a repository the agent's sandbox hides. So
// the agent's shim builds a pack of the commit inside the sandbox, from what
// the agent can read, and sends it on the request's connection. The broker
// indexes it into its own repository, push/cache.git in the state directory,
// which no sandbox can write: index-pack computes each object's id from its
// content and fsck checks the objects. The remote's branches come in by
// fetch. The checks and the push read only that repository. It stays between
// pushes, so a push fetches only what the remote added since the last one.
const CACHE = 'cache.git';

function pushRoot(job) {
  const root = path.join(job.state, 'push');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  return root;
}

// One push at a time uses the cache, so no two fetches race on its refs. The
// lock is the directory cache.lock holding one marker file named by its
// holder's nonce, with the holder's pid and start time inside. It is taken by
// renaming a prepared directory onto it, which fails while it holds a marker.
// A stale holder is removed by unlinking its own marker by name and then
// removing the directory only if it is empty, so a waiter that read the same
// stale holder as another can never remove the lock the other took since.
// Waiting ends when the agent hangs up.
async function lockCache(root, io) {
  const P = require('./processes');
  const crypto = require('node:crypto');
  const lock = path.join(root, 'cache.lock');
  let told = false;
  for (;;) { // spin-allow: waits only while a live holder keeps the lock; its exit frees it
    const nonce = crypto.randomBytes(8).toString('hex');
    const staging = path.join(root, `cache.lock.${process.pid}.${nonce}`);
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, nonce), JSON.stringify({ pid: process.pid, ...P.identity(process.pid) }));
    try {
      fs.renameSync(staging, lock);
      if (fs.existsSync(path.join(lock, nonce))) {
        return () => {
          fs.rmSync(path.join(lock, nonce), { force: true });
          try { fs.rmdirSync(lock); } catch { /* another holder's already */ }
        };
      }
    } catch (e) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const exited = (file) => {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* removed meanwhile */ }
      return holder ? P.processState(holder) === 'exited' : null;
    };
    let live = false;
    let names = [];
    try {
      names = fs.readdirSync(lock);
    } catch (e) {
      // A plain file is the lock of an earlier version: one holder, removed
      // once it exited.
      if (e.code === 'ENOTDIR') {
        if (exited(lock)) fs.rmSync(lock, { force: true });
        else live = true;
      }
    }
    for (const name of names) {
      if (exited(path.join(lock, name)) === false) live = true;
      else fs.rmSync(path.join(lock, name), { force: true });
    }
    if (!live) {
      try { fs.rmdirSync(lock); } catch { /* taken meanwhile, or never there */ }
      // A lock that cannot be removed must not stop the event loop.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (io.gone?.()) throw refuse('the agent hung up while its push waited for another');
      continue;
    }
    if (io.gone?.()) throw refuse('the agent hung up while its push waited for another');
    if (!told) io.stderr('tower-crane: the broker waits for another push from this project to finish\n');
    told = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// The remote's object format, from the length of the ids it lists, or the
// pushed commit's for a remote with no refs. Never from the task repository's
// config, which the agent writes.
async function remoteFormat(url, sha, env, io) {
  const r = await run('git', ['ls-remote', url], { cwd: os.homedir(), env, bounded: true }, io);
  if (r.stalled) throw stalledRemote(r, `the broker's ls-remote of ${url}`);
  const id = r.code === 0 ? r.stdout.split('\n')[0].split('\t')[0] : '';
  return (id || sha).length === 64 ? 'sha256' : 'sha1';
}

// What a git or broker killed mid-push left: lock files and temporary packs
// in the cache, and quarantines beside it. The broker holds the cache lock,
// so no other push is at work.
function clearLeftovers(root, dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && (entry.name.endsWith('.lock') || entry.name.startsWith('tmp_pack_'))) fs.rmSync(path.join(entry.parentPath, entry.name), { force: true });
  }
  for (const name of fs.readdirSync(root)) if (name.startsWith('quarantine-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// Bounds on the agent's pack. GitHub refuses a push over 2 GiB, so a bigger
// pack is refused here. pack-objects writes nothing while it searches for
// deltas, which takes minutes for a large history, so a sender is stuck only
// after a longer silence; then the push ends and frees the cache lock. A
// pack that keeps trickling is ended after totalMs, so no slow agent holds
// the lock that every other push and fetch of the project waits on: 2 GiB
// moves in under an hour at 600 KB/s, which a local socket far exceeds.
// git's own transfers with the remote take the same limits (stalledRemote).
const LIMITS = { input: 2 * 1024 ** 3, idleMs: 10 * 60 * 1000, totalMs: 60 * 60 * 1000 };

// What a stalled or slow transfer is refused with.
function overLimit(reason, what) {
  return reason === 'total' ? `${what} took longer than ${Math.round(LIMITS.totalMs / 1000)} s`
    : `${what} stalled for ${Math.round(LIMITS.idleMs / 1000)} s`;
}

// git talking to the remote holds the cache lock that every push and fetch
// of the project waits on, so a remote that stops answering (a dropped
// network, a hung server) is stopped under the same limits as the agent's
// pack. With --progress, git prints about once a second while the remote
// counts and compresses objects and while they move, so a live transfer is
// never silent for long. The 10 minutes cover silent work on either side:
// the remote's checks of a push, and the connectivity check and foreground
// gc a fetch runs in the cache. A network that drops without a reset, which
// ssh and https otherwise wait on forever, ends within them.
function stalledRemote(r, what) {
  return refuse(`${overLimit(r.stalled, what)}; the broker stopped it and freed the cache lock, try again`);
}

// The pack, ended with an error after LIMITS.idleMs without a byte or
// LIMITS.totalMs in all; out.reason says which.
function idleBounded(body) {
  const out = new (require('node:stream').PassThrough)();
  let timer;
  const stop = (reason) => {
    out.reason = reason;
    out.destroy(new Error('stalled'));
    body.destroy();
  };
  const total = setTimeout(() => stop('total'), LIMITS.totalMs);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop('idle'), LIMITS.idleMs);
  };
  const clear = () => {
    clearTimeout(timer);
    clearTimeout(total);
  };
  arm();
  body.on('error', () => out.destroy(new Error('the agent hung up')));
  body.on('data', arm);
  body.on('end', clear);
  body.on('close', clear);
  out.on('close', clear);
  body.pipe(out);
  return out;
}

// Moves a quarantine's objects into the cache: packs before their indexes,
// so git never sees an index without its pack. index-pack has just written
// them, and Windows refuses their rename while a scanner holds them.
function migrate(from, to) {
  const order = (n) => (n.endsWith('.idx') ? 2 : n.endsWith('.pack') ? 0 : 1);
  for (const entry of fs.readdirSync(from, { withFileTypes: true, recursive: true }).filter((e) => e.isFile())
    .sort((a, b) => order(a.name) - order(b.name))) {
    const rel = path.relative(from, path.join(entry.parentPath, entry.name));
    if (rel.split(path.sep).some((part) => part.startsWith('tmp_'))) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) S.renameRetry(path.join(entry.parentPath, entry.name), dest, true);
  }
}

// The cache, made on first use in the remote's object format, and made again
// when the format differs. gc runs in the foreground, inside the lock.
function makeCache(dir, format) {
  fs.rmSync(dir, { recursive: true, force: true });
  const init = cp.spawnSync('git', ['init', '--quiet', '--bare', '--template=', `--object-format=${format}`, dir],
    { encoding: 'utf8', env: gitEnv(), timeout: 30000, windowsHide: true });
  if (init.status !== 0) throw refuse(`cannot prepare the push: ${String(init.stderr).trim()}`);
  fs.appendFileSync(path.join(dir, 'config'), '[gc]\n\tautoDetach = false\n[maintenance]\n\tautoDetach = false\n');
}

// Brings the cache, made if missing, up to date with the remote's branches.
// The caller holds the cache lock. sha, the pushed commit, gives the object
// format of a remote with no refs.
async function syncCache({ root, dir, url, sha, env, git }, io) {
  if (!fs.existsSync(path.join(dir, 'HEAD'))) makeCache(dir, await remoteFormat(url, sha, env, io));
  clearLeftovers(root, dir);
  // Progress is the fetch's only output, so a fetch that moves is never idle.
  const fetchRemote = async () => {
    const r = await git(['fetch', '--quiet', '--progress', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      url, '+refs/heads/*:refs/remotes/origin/*'], { bounded: true });
    if (r.stalled) throw stalledRemote(r, `the broker's fetch from ${url}`);
    return r;
  };
  let fetched = await fetchRemote();
  if (fetched.code !== 0) {
    // A cache in another format than the remote's cannot fetch from it.
    const format = await remoteFormat(url, sha, env, io);
    if ((await git(['rev-parse', '--show-object-format'])).stdout.trim() !== format) {
      makeCache(dir, format);
      fetched = await fetchRemote();
    }
  }
  if (fetched.code !== 0) throw refuse(`cannot read the remote's branches: ${shown(fetched.stderr)}`);
}

// Files a push may change only when the task names them: workflows, the
// local actions under .github/actions, and the action.yml or action.yaml of
// any other local action (uses: ./path) a workflow in the pushed commit runs.
async function protectedFiles(git, sha) {
  const grep = await git(['grep', '-h', '-I', '-E', '^[[:space:]-]*uses:[[:space:]]*[\'"]?\\./', sha, '--', '.github/workflows']);
  if (grep.code > 1) throw refuse(`cannot read the workflows of ${sha}: ${String(grep.stderr).trim()}`);
  const actions = new Set();
  for (const line of grep.stdout.split('\n')) {
    const m = /uses:\s*['"]?\.\/([^'"#\s]*)/.exec(line);
    if (!m) continue;
    const dir = path.posix.normalize(m[1] || '.').replace(/\/+$/, '');
    for (const name of ['action.yml', 'action.yaml']) actions.add(dir === '.' ? name : `${dir}/${name}`);
  }
  return (file) => WORKFLOW.test(file) || actions.has(file);
}

// Pushes request.sha to the task branch on origin, with the user's
// credentials, after checking that the role pushes, the agent sent the
// commit's objects, and no commit the remote lacks changes a workflow file
// the task does not name. io.need asks the agent for a pack and io.body is
// the pack it sends.
async function push(job, request, io) {
  if (job.body_fix) throw refuse('PR-body repair cannot push commits; use normal rework for code changes');
  if (rolePolicy(job).gitPush !== 'branch') throw refuse(`${job.agent} is a ${job.role}; its agent file allows no push`);
  const { project, task } = taskOf(job);
  const branch = task.branch;
  if (!branch) throw refuse(`${job.task} has no branch to push`);
  if (branch === project.base) throw refuse(`${branch} is the project's base branch; an agent pushes only its task branch`);
  const sha = String(request?.sha || '');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw usage('the broker pushes a full commit sha');
  const common = commonDir(job);
  if (!common) throw refuse('the broker has no task repository to push from');
  const url = pushTarget(common, project.repo);
  const root = pushRoot(job);
  const env = gitEnv();
  const dir = path.join(root, CACHE);
  // Until the checks pass, the agent's objects are in a quarantine that git
  // reads beside the cache's own, as receive-pack does, so a refused push
  // leaves nothing in the cache.
  let quarantine = null;
  const git = (args, opts = {}) => run('git', ['--git-dir', dir, ...args], { cwd: dir, ...opts,
    env: quarantine ? { ...env, GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(dir, 'objects') } : env }, io);
  const unlock = await lockCache(root, io);
  try {
    await syncCache({ root, dir, url, sha, env, git }, io);
    // Every object of the commit the remote lacks, read without error.
    const complete = () => git(['rev-list', '--objects', '--quiet', sha, '--not', '--remotes']);
    if ((await complete()).code !== 0) {
      if (!io.need || !io.body) throw refuse('the agent sent no pack for the push; its shim is older than the broker');
      const have = (await git(['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'])).stdout.split('\n').filter(Boolean);
      quarantine = fs.mkdtempSync(path.join(root, 'quarantine-'));
      fs.mkdirSync(path.join(quarantine, 'pack'));
      io.need({ have });
      let stalled = false;
      const body = idleBounded(io.body).on('error', () => { stalled = true; });
      const indexed = await git(['index-pack', '--stdin', '--fix-thin', '--strict', `--max-input-size=${LIMITS.input}`], { input: body });
      if (io.body.unframed) throw refuse(io.body.unframed);
      if (stalled) throw refuse(overLimit(body.reason, `the agent's pack for ${sha}`));
      if (indexed.code !== 0 || (await complete()).code !== 0) {
        throw refuse(`commit ${sha} is not in the task repository, or its objects did not arrive whole: ${String(indexed.stderr).trim() || 'objects are missing'}`);
      }
    }
    if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) throw refuse(`${sha} is not a commit`);
    const allowed = workflowAllowed(task, briefOf(job));
    const commits = await git(['rev-list', sha, '--not', '--remotes']);
    if (commits.code !== 0) throw refuse(`cannot list the commits to push: ${String(commits.stderr).trim()}`);
    if (commits.stdout.trim()) {
      // A merge lists only the files it changed against every parent, so a
      // workflow change merged in from a branch the remote has is not its own.
      const files = await git(['diff-tree', '--stdin', '-r', '--root', '--cc', '--name-only', '--no-commit-id'], { input: commits.stdout });
      if (files.code !== 0) throw refuse(`cannot list the files the push changes: ${String(files.stderr).trim()}`);
      const guarded = await protectedFiles(git, sha);
      const workflows = [...new Set(files.stdout.split('\n').filter((f) => f && guarded(f) && !allowed(f)))];
      if (workflows.length) {
        throw refuse(`the push changes ${workflows.join(', ')}; ${job.task} does not name it, so CI workflow changes go through the owner or a task whose brief names the file`);
      }
    }
    if (quarantine) {
      migrate(quarantine, path.join(dir, 'objects'));
      fs.rmSync(quarantine, { recursive: true, force: true });
      quarantine = null;
    }
    const kept = await git(['update-ref', 'refs/push/task', sha]);
    if (kept.code !== 0) throw refuse(`cannot keep ${sha} in the broker's repository: ${String(kept.stderr).trim()}`);
    io.stderr(`tower-crane: the broker pushes ${sha.slice(0, 12)} to ${branch} on ${url}\n`);
    const pushed = await git(['push', '--progress', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', url, `${sha}:refs/heads/${branch}`],
      { stream: true, bounded: true });
    if (pushed.stalled) throw stalledRemote(pushed, `the broker's push to ${url}`);
    return pushed.code;
  } finally {
    if (quarantine) fs.rmSync(quarantine, { recursive: true, force: true });
    unlock();
  }
}

// --- fetch ------------------------------------------------------------------

// The branches a task's agent fetches: the project's base, the base its pull
// request targets when the task is stacked, and its own branch.
function fetchable(st, task) {
  return [...new Set([st.project.base, require('./stack').targetBase(st, task), task.branch].filter(Boolean))];
}

// The most commits an agent names as its own. The request line holds at
// most 1 MiB (lib/broker.js), and 8000 SHA-256 ids fill about half of it.
const MAX_HAVE = 8000;

// Fetches origin's branches for an agent whose sandbox cannot: it holds no
// credential, and ssh there may not even start. The broker brings its cache
// up to date with the user's login, then sends the agent each branch it may
// fetch ({refs}, null for one origin lacks) and a thin pack of their commits
// past those the agent says it has ({pack} lines, base64), which the agent's
// shim indexes into the task repository, where git hashes every object it
// receives. request.branches narrows the branches to fetch; request.have
// lists commits the agent holds, which only bound the pack. The broker reads
// nothing of the task repository but origin's URL in its config.
async function fetch(job, request, io) {
  const { st, project, task } = taskOf(job);
  const allowed = fetchable(st, task);
  const asked = Array.isArray(request?.branches) ? request.branches : [];
  if (!asked.every((b) => typeof b === 'string')) throw usage('the broker fetches branches named by strings');
  const other = asked.filter((b) => !allowed.includes(b));
  if (other.length) throw refuse(`${job.task} fetches ${allowed.join(', ')} from origin, not ${other.join(', ')}`);
  const branches = asked.length ? [...new Set(asked)] : allowed;
  const common = commonDir(job);
  if (!common) throw refuse('the broker has no task repository to fetch for');
  const url = fetchTarget(common, project.repo);
  const have = (Array.isArray(request?.have) ? request.have : [])
    .filter((h) => typeof h === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(h)).slice(0, MAX_HAVE);
  const root = pushRoot(job);
  const env = gitEnv();
  const dir = path.join(root, CACHE);
  const git = (args, opts = {}) => run('git', ['--git-dir', dir, ...args], { cwd: dir, ...opts, env }, io);
  const unlock = await lockCache(root, io);
  try {
    await syncCache({ root, dir, url, sha: '', env, git }, io);
    const refs = {};
    for (const b of branches) {
      const r = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}^{commit}`]);
      refs[b] = r.code === 0 ? r.stdout.trim() : null;
    }
    io.refs({ url, refs });
    const tips = [...new Set(Object.values(refs).filter(Boolean))];
    if (!tips.length) return 0;
    // Only commits the cache holds bound the pack; pack-objects refuses an
    // unknown one.
    const known = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: have.map((h) => `${h}\n`).join('') });
    const bounds = known.stdout.split('\n').filter((l) => / commit$/.test(l)).map((l) => `^${l.split(' ')[0]}`);
    return await sendPack(dir, env, [...tips, ...bounds], io);
  } finally {
    unlock();
  }
}

// Streams a thin pack of the revisions to the agent, waiting for the
// connection to drain, so a large pack is never held in memory whole. An
// agent that stops reading for LIMITS.idleMs, or has not read the whole pack
// after LIMITS.totalMs, ends the fetch, which frees the cache lock for other
// pushes and fetches.
function sendPack(dir, env, revs, io) {
  return new Promise((resolve) => {
    const child = cp.spawn('git', ['--git-dir', dir, 'pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'],
      { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    io.track(child);
    child.stdin.on('error', () => {});
    child.stdin.end(revs.map((r) => `${r}\n`).join(''));
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    let stalled = null;
    let timer = null;
    // pack-objects' stdout may be paused for a full connection, and a
    // paused pipe never reports the child's close, which unlocks the cache:
    // destroy it too.
    const stop = (reason) => {
      stalled = reason;
      child.kill();
      child.stdout.destroy();
    };
    const total = setTimeout(() => stop('total'), LIMITS.totalMs);
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(total);
    });
    child.stdout.on('data', (chunk) => {
      if (!io.pack(chunk)) {
        child.stdout.pause();
        clearTimeout(timer);
        timer = setTimeout(() => stop('idle'), LIMITS.idleMs);
        io.drained(() => {
          clearTimeout(timer);
          child.stdout.resume();
        });
      }
    });
    child.on('error', (e) => resolve(refused(io, `cannot pack the fetch: ${e.message}`)));
    child.on('close', (code) => resolve(code === 0 && !stalled ? 0
      : refused(io, stalled ? overLimit(stalled, 'the agent\'s read of the fetch\'s pack')
        : `cannot pack the fetch: ${stderr.trim() || `git exited ${code}`}`)));
  });
}

function refused(io, message) {
  io.stderr(`tower-crane: ${message}\n`);
  return 1;
}

module.exports = { TOKEN_ENV, GITHUB, LIMITS, parseGh, buildGh, ghCommand, gh, push, fetch, fetchable, lockCache, pushTarget, fetchTarget, workflowAllowed, FLAGS };
