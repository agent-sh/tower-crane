'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuse } = require('./util');

let mutations = 0;

function assertUnlocked(command) {
  if (mutations && /^(git|gh)(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(command))) {
    const e = refuse(`${command} cannot run inside a state mutation; prepare commands outside the lock and compare before applying`);
    e.lockedCommand = true;
    throw e;
  }
}

function mutation(fn) {
  mutations++;
  try { return fn(); }
  finally { mutations--; }
}

// A sandboxed worker may write the repository's git directory (writeOutside:
// git), and git runs commands its config and hooks name. Git started here runs
// outside every sandbox, so it takes those settings only from the system,
// global and command scopes, which no worker writes. Git that gh starts here
// gets the same. Command-scope entries (GIT_CONFIG_COUNT) come last, so they
// win over the repository's.
// The keys come from the command-running entries of `git help --config`
// (git 2.53.0). Left out, since the CLI never reaches them: core.editor,
// sequence.editor, core.pager and pager.<cmd> (no editor or tty pager runs
// here), trailer.<key>.cmd (no --trailer), difftool, mergetool, sendemail,
// browser, man, guitool and gitcvs commands (porcelain the CLI does not run)
// and uploadpack.packObjectsHook (honored only from protected config).
// gc.recentObjectsHook runs in prune and repack, which the CLI reaches only
// through the gc --auto that fetch, commit, merge and rebase start, so
// auto-maintenance is off whatever its scope.
// Single-valued keys get the trusted value or a default that runs nothing of
// the repository's.
const OFF = { 'maintenance.auto': 'false' };
const FIXED = {
  'core.fsmonitor': 'false',
  'core.sshcommand': 'ssh',
  'core.askpass': '',
  'core.alternaterefscommand': '',
  'diff.external': '',
  'remote.origin.uploadpack': 'git-upload-pack',
  'remote.origin.receivepack': 'git-receive-pack',
  'protocol.ext.allow': 'never',
  'fetch.recursesubmodules': 'false',
  'submodule.recurse': 'false',
};
// Keys named per driver, URL or remote: each one the repository sets gets
// the trusted value back, or is emptied, which makes git refuse to run it.
const NAMED = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|remote\..+\.(uploadpack|receivepack)|gpg(\..+)?\.program|gpg\..+\.defaultkeycommand)$/;
const CREDENTIAL = /^credential\.(.+\.)?helper$/;
const TRUSTED = new Set(['system', 'global', 'command']);

// The directory git will run in: opts.cwd, then each leading -C.
function gitDir(args, opts) {
  let dir = opts?.cwd || process.cwd();
  for (let i = 0; i < args.length && String(args[i]).startsWith('-'); i++) {
    if (args[i] === '-C') dir = path.resolve(dir, String(args[++i]));
    else if (args[i] === '-c') i++;
  }
  return dir;
}

// These read config and refs but no object, index or hook, so they run
// nothing the repository names (GIT_TRACE shows no child process with every
// setting above planted) and need no scan. They are most of the CLI's git
// calls. A rev-parse that names a revision can read an object, which in a
// partial clone starts a fetch.
const LOCATE = new Set(['--git-common-dir', '--git-dir', '--absolute-git-dir', '--show-toplevel',
  '--path-format=absolute', '--path-format=relative', '--is-inside-work-tree', '--is-bare-repository']);
function runsNothing(args) {
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const [command, sub] = [args[i], args[i + 1]];
  if (command === 'rev-parse') return i + 1 < args.length && args.slice(i + 1).every((a) => LOCATE.has(a));
  if (command === 'worktree') return ['list', 'prune', 'lock', 'unlock'].includes(sub);
  return command === 'remote' && sub === 'get-url';
}

function unsafe() {
  return refuse('cannot read git configuration safely; refusing to start git or gh');
}

function scanGit(args, dir, env, input) {
  const r = cp.spawnSync('git', args, {
    cwd: dir, env, input, encoding: 'utf8', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 60000 });
  if (r.error || r.signal) throw unsafe();
  return r;
}

// `git config -z` output: key, newline, value per entry, after the scope and
// origin when `scoped`.
function parseList(stdout, scoped) {
  const fields = String(stdout || '').split('\0');
  const step = scoped ? 3 : 1;
  const out = [];
  for (let i = 0; i + step < fields.length; i += step) {
    const entry = fields[i + step - 1];
    const nl = entry.indexOf('\n');
    out.push({ scope: scoped ? fields[i] : 'local', origin: scoped ? fields[i + 1] : '',
      key: nl < 0 ? entry : entry.slice(0, nl), value: nl < 0 ? '' : entry.slice(nl + 1) });
  }
  return out;
}

function configEntries(dir, env) {
  const r = scanGit(['config', '--list', '--show-scope', '--show-origin', '-z'], dir, env);
  // Partial output can omit a repository driver, leaving its command enabled.
  if (r.status !== 0) throw unsafe();
  return parseList(r.stdout, true);
}

const DIR = '\0dir';

// A file's bytes, DIR and its mode for a directory (git passes over a git
// directory it cannot enter), null when it is missing, or the error code;
// the reuse check below compares these.
function fileState(file) {
  try { return fs.readFileSync(file, 'latin1'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    try {
      const st = fs.statSync(file);
      if (st.isDirectory()) return `${DIR}${st.mode}`;
    } catch { /* the read error stands */ }
    return `\0${e.code}`;
  }
}

// The git directories for a checkout root, found the way git finds them:
// `.git` is the repository or names it, and a worktree's commondir names the
// shared one. Null when the environment or a missing `.git` lets git look
// elsewhere.
function layout(dir, env) {
  if (['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY'].some((k) => env[k] !== undefined)) return null;
  const dotgit = path.join(dir, '.git');
  const state = fileState(dotgit);
  let own = dotgit;
  if (!state?.startsWith(DIR)) {
    const m = state && /^gitdir: (.+?)\r?\n?$/.exec(state);
    if (!m) return null;
    own = path.resolve(dir, m[1]);
  }
  const commondir = fileState(path.join(own, 'commondir'));
  const common = commondir && !commondir.startsWith('\0') ? path.resolve(own, commondir.trim()) : own;
  return { own, common, files: [dotgit, path.join(own, 'HEAD'), path.join(own, 'commondir'),
    path.join(common, 'objects'), path.join(common, 'refs'), path.join(common, 'config'), path.join(own, 'config.worktree')] };
}

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };

const INCLUDE = /^include(if\..+)?\.path$/;

// Every key the repository's config files set, reading each file they
// include whatever its condition. The scan in `dir` resolves includeIf for
// `dir` only, while git also runs in the worktrees it creates for tasks and
// gates, where a gitdir: or onbranch: condition can match. A new worktree
// starts with no config.worktree of its own, so only the shared config and
// the one for `dir` can name a driver. Git parses the bytes recorded in
// `files` from stdin, so the keys found are those of the recorded state even
// if a file changes meanwhile.
function repositoryKeys(dir, env, { common, own }, files) {
  const keys = [];
  const seen = new Set();
  const read = (file) => {
    file = path.resolve(file);
    if (seen.has(file)) return;
    seen.add(file);
    if (!files.has(file)) files.set(file, fileState(file));
    const state = files.get(file);
    // Git skips an include it cannot find.
    if (state === null) return;
    if (state.startsWith('\0')) throw unsafe();
    const list = scanGit(['config', '--file', '-', '--no-includes', '--list', '-z'], dir, env, Buffer.from(state, 'latin1'));
    if (list.status !== 0) throw unsafe();
    for (const e of parseList(list.stdout, false)) {
      if (!INCLUDE.test(e.key)) { keys.push(e); continue; }
      // ~user/ and %(prefix)/ name places this scan does not resolve.
      if (e.value.startsWith('~/')) read(path.join(env.HOME || os.homedir(), e.value.slice(2)));
      else if (/^(~|%\()/.test(e.value)) throw unsafe();
      else read(path.resolve(path.dirname(file), e.value));
    }
  };
  read(path.join(common, 'config'));
  read(path.join(own, 'config.worktree'));
  return keys;
}

// A process runs dozens of git calls in one checkout, and each scan is a git
// process of its own. A result is reused for the same directory and caller
// environment while each file it was built from holds the recorded bytes;
// they are read again before each call. gh and git calls differ in their
// environment, so each keeps its own.
const scans = new Map();
const unchanged = (files) => [...files].every(([file, state]) => fileState(file) === state);

// The environment for git run by Tower Crane in `dir`. Hooks come only from
// a trusted absolute core.hooksPath, otherwise the null device, so the
// repository's hooks directory is never read. The credential helper list is
// cleared, then refilled with the trusted helpers in their order.
function gitEnv(dir, base = process.env) {
  dir = path.resolve(dir);
  const key = JSON.stringify(base);
  const hit = scans.get(dir)?.get(key);
  if (hit && unchanged(hit.files)) return { ...hit.env };
  const env = { ...base };
  // core.gitProxy uses the first match, so later config cannot neutralize it.
  // The environment takes precedence over the entire repository proxy list.
  env.GIT_PROXY_COMMAND ??= '';
  // Recorded before the scan: a change during it shows on the next call.
  const where = layout(dir, env);
  const files = new Map(where ? where.files.map((f) => [f, fileState(f)]) : []);
  const entries = configEntries(dir, env);
  // A relative hooks path resolves inside the checkout, which the worker writes.
  const hooks = entries.filter((e) => e.key === 'core.hookspath' && TRUSTED.has(e.scope)).pop()?.value;
  const pairs = [['core.hookspath', hooks && (path.isAbsolute(hooks) || hooks.startsWith('~/')) ? hooks : os.devNull],
    ...Object.entries(OFF)];
  // Git reads GIT_SSH and SSH_ASKPASS only when core.sshCommand and
  // core.askPass are unset, so the defaults carry them. core.sshCommand runs
  // through sh on every platform; GIT_SSH names a program.
  const defaults = { ...FIXED,
    'core.sshcommand': env.GIT_SSH ? `'${env.GIT_SSH.replace(/'/g, `'\\''`)}'` : FIXED['core.sshcommand'],
    'core.askpass': env.SSH_ASKPASS || FIXED['core.askpass'] };
  for (const [key, fallback] of Object.entries(defaults)) {
    const trusted = entries.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
    pairs.push([key, trusted ? trusted.value : fallback]);
  }
  const local = entries.filter((e) => !TRUSTED.has(e.scope));
  let dirs = null;
  if (where || local.some((e) => INCLUDE.test(e.key))) {
    const r = scanGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], dir, env);
    const [common, own] = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/) : [];
    if (common && own) dirs = { common, own };
    else if (local.length) throw unsafe();
  }
  if (dirs) local.push(...repositoryKeys(dir, env, dirs, files));
  const untrusted = new Set(local.filter((e) => NAMED.test(e.key) && !(e.key in FIXED)).map((e) => e.key));
  for (const key of untrusted) {
    const trusted = entries.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
    pairs.push([key, trusted ? trusted.value : '']);
    if (!trusted && key.startsWith('filter.')) pairs.push([key.replace(/\.[^.]+$/, '.required'), 'false']);
  }
  pairs.push(['credential.helper', '']);
  for (const e of entries) if (TRUSTED.has(e.scope) && CREDENTIAL.test(e.key)) pairs.push([e.key, e.value]);
  let n = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  for (const [key, value] of pairs) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  // Reused only when git found the directories the layout names and read
  // repository config from no file outside the record.
  const origin = (e) => e.origin.startsWith('file:') && path.resolve(dir, e.origin.slice(5));
  const same = (a, b) => real(a) !== null && real(a) === real(b);
  const recorded = new Set([...files.keys()].map(real).filter(Boolean));
  if (where && dirs && same(where.common, dirs.common) && same(where.own, dirs.own)
    && local.every((e) => !e.origin || origin(e) && recorded.has(real(origin(e))))) {
    for (const e of entries) if (TRUSTED.has(e.scope) && origin(e) && !files.has(origin(e))) files.set(origin(e), fileState(origin(e)));
    for (const d of scans.keys()) if (!fs.existsSync(d)) scans.delete(d);
    if (!scans.has(dir)) scans.set(dir, new Map());
    scans.get(dir).set(key, { files, env: { ...env } });
  }
  return env;
}

// Only the bare names: the shims run the worker's own git and gh by path.
// gh runs git itself (gh stack sync rebases and pushes), and that git
// inherits the same environment.
function withGitEnv(command, rest) {
  if (command !== 'git' && command !== 'gh') return rest;
  if (command === 'git' && Array.isArray(rest[0]) && runsNothing(rest[0])) return rest;
  const next = Array.isArray(rest[0]) ? [...rest] : [[], ...rest];
  const opts = next[1] && typeof next[1] === 'object' ? next[1] : null;
  const dir = command === 'git' ? gitDir(next[0], opts) : opts?.cwd || process.cwd();
  const merged = { ...opts, env: gitEnv(dir, opts?.env || process.env) };
  next.splice(1, opts ? 1 : 0, merged);
  return next;
}

function runner(method) {
  return (command, ...args) => {
    assertUnlocked(command);
    return cp[method](command, ...withGitEnv(command, args));
  };
}

module.exports = { assertUnlocked, mutation, gitEnv,
  execFileSync: runner('execFileSync'), execFile: runner('execFile'),
  spawnSync: runner('spawnSync'), spawn: runner('spawn') };
