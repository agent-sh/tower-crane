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
// Single-valued keys get the trusted value or a default that runs nothing of
// the repository's.
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
const NAMED = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|merge\..+\.driver|remote\..+\.(uploadpack|receivepack)|gpg(\..+)?\.program)$/;
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

// rev-parse asked only where the repository is reads config but no object,
// index or hook, so it runs nothing the repository names and needs no scan.
// Most of the CLI's git calls are these.
const LOCATE = new Set(['--git-common-dir', '--git-dir', '--absolute-git-dir', '--show-toplevel',
  '--path-format=absolute', '--path-format=relative', '--is-inside-work-tree', '--is-bare-repository']);
function locatesOnly(args) {
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  return args[i] === 'rev-parse' && i + 1 < args.length && args.slice(i + 1).every((a) => LOCATE.has(a));
}

function unsafe() {
  return refuse('cannot read git configuration safely; refusing to start git or gh');
}

function scanGit(args, dir, env) {
  const r = cp.spawnSync('git', args, {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 60000 });
  if (r.error || r.signal) throw unsafe();
  return r;
}

// `git config -z` output: key, newline, value per entry, after the scope
// when `scoped`.
function parseList(stdout, scoped) {
  const fields = String(stdout || '').split('\0');
  const step = scoped ? 2 : 1;
  const out = [];
  for (let i = 0; i + step < fields.length; i += step) {
    const entry = fields[i + step - 1];
    const nl = entry.indexOf('\n');
    out.push({ scope: scoped ? fields[i] : 'local', key: nl < 0 ? entry : entry.slice(0, nl), value: nl < 0 ? '' : entry.slice(nl + 1) });
  }
  return out;
}

function configEntries(dir, env) {
  const r = scanGit(['config', '--list', '--show-scope', '-z'], dir, env);
  // Partial output can omit a repository driver, leaving its command enabled.
  if (r.status !== 0) throw unsafe();
  return parseList(r.stdout, true);
}

const INCLUDE = /^include(if\..+)?\.path$/;

// Every key the repository's config files can set, reading each file they
// include whatever its condition. The scan in `dir` resolves includeIf for
// `dir` only, while git also runs in the worktrees it creates for tasks and
// gates, where a gitdir: or onbranch: condition can match. A new worktree
// starts with no config.worktree of its own, so only the shared config and
// the one for `dir` can name a driver.
function includedKeys(dir, env) {
  const r = scanGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'], dir, env);
  if (r.status !== 0) throw unsafe();
  const [common, own] = String(r.stdout).trim().split(/\r?\n/);
  const keys = [];
  const seen = new Set();
  const read = (file) => {
    file = path.resolve(file);
    // Git skips an include it cannot find.
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const list = scanGit(['config', '--file', file, '--no-includes', '--list', '-z'], dir, env);
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

// The environment for git run by Tower Crane in `dir`. Hooks come only from
// a trusted absolute core.hooksPath, otherwise the null device, so the
// repository's hooks directory is never read. The credential helper list is
// cleared, then refilled with the trusted helpers in their order.
function gitEnv(dir, base = process.env) {
  const env = { ...base };
  // core.gitProxy uses the first match, so later config cannot neutralize it.
  // The environment takes precedence over the entire repository proxy list.
  env.GIT_PROXY_COMMAND ??= '';
  const entries = configEntries(dir, env);
  // A relative hooks path resolves inside the checkout, which the worker writes.
  const hooks = entries.filter((e) => e.key === 'core.hookspath' && TRUSTED.has(e.scope)).pop()?.value;
  const pairs = [['core.hookspath', hooks && (path.isAbsolute(hooks) || hooks.startsWith('~/')) ? hooks : os.devNull]];
  for (const [key, fallback] of Object.entries(FIXED)) {
    const trusted = entries.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
    pairs.push([key, trusted ? trusted.value : fallback]);
  }
  const local = entries.filter((e) => !TRUSTED.has(e.scope));
  if (local.some((e) => INCLUDE.test(e.key))) local.push(...includedKeys(dir, env));
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
  return env;
}

// Only the bare names: the shims run the worker's own git and gh by path.
// gh runs git itself (gh stack sync rebases and pushes), and that git
// inherits the same environment.
function withGitEnv(command, rest) {
  if (command !== 'git' && command !== 'gh') return rest;
  if (command === 'git' && Array.isArray(rest[0]) && locatesOnly(rest[0])) return rest;
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

module.exports = { assertUnlocked, mutation,
  execFileSync: runner('execFileSync'), execFile: runner('execFile'),
  spawnSync: runner('spawnSync'), spawn: runner('spawn') };
