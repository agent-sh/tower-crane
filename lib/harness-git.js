'use strict';

// The git environment of a sandboxed harness process. The harness (claude,
// codex) runs its own git outside its sandbox, in the worktree the agent
// writes, and git runs commands that repository config and hooks name. The
// sandbox keeps the shared config and hooks read-only (lib/agents.js
// protectedGit); this environment makes sure that even a write it missed
// runs nothing: command-scope entries (GIT_CONFIG_COUNT) win over every
// config file, and the system config is not read at all.

const cp = require('./commands');
const os = require('node:os');
const path = require('node:path');

// Single-valued keys that run a command: the trusted (global or command
// scope) value, or one that runs nothing of the repository's.
const FIXED = {
  'core.fsmonitor': 'false',
  'core.sshcommand': 'ssh',
  'core.askpass': '',
  'core.alternaterefscommand': '',
  'diff.external': '',
  'protocol.ext.allow': 'never',
  'submodule.recurse': 'false',
  'fetch.recursesubmodules': 'false',
};
// Background gc and maintenance write the shared info/ and objects/info/
// from whichever git triggers them.
const QUIET = [['gc.auto', '0'], ['maintenance.auto', 'false']];
// Keys named per driver, remote or tool that run a command, and what an
// untrusted one becomes when no trusted value exists.
const NAMED = [
  [/^filter\..+\.(clean|smudge|process)$/, ''],
  [/^diff\..+\.(command|textconv)$/, ''],
  [/^merge\..+\.driver$/, ''],
  [/^remote\..+\.uploadpack$/, 'git-upload-pack'],
  [/^remote\..+\.receivepack$/, 'git-receive-pack'],
  [/^gpg\.program$/, 'gpg'],
  [/^gpg\.ssh\.program$/, 'ssh-keygen'],
  [/^gpg\.x509\.program$/, 'gpgsm'],
  [/^gpg\.openpgp\.program$/, 'gpg'],
  [/^gpg\.ssh\.defaultkeycommand$/, ''],
  [/^trailer\..+\.(command|cmd)$/, ''],
  [/^(difftool|mergetool|browser|man)\..+\.(cmd|path)$/, ''],
];
const CREDENTIAL = /^credential\.(.+\.)?helper$/;
const TRUSTED = new Set(['global', 'command']);
// The env names the entries this module added, so the git shim can tell
// them from the caller's own (lib/shim.js).
const MARK = 'TOWER_CRANE_GIT_ENV';

// `git config --list --show-scope -z`: scope, key and value per entry.
function entries(cwd, env) {
  const r = cp.spawnSync('git', ['config', '--list', '--show-scope', '-z'], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 });
  if (r.error || r.status !== 0) return [];
  const fields = String(r.stdout).split('\0');
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const nl = fields[i + 1].indexOf('\n');
    out.push({ scope: fields[i], key: nl < 0 ? fields[i + 1] : fields[i + 1].slice(0, nl), value: nl < 0 ? '' : fields[i + 1].slice(nl + 1) });
  }
  return out;
}

// The entries that neutralize what the repository's config (local and
// worktree scope, includes too) can make git run, for git started in cwd.
function pairs(cwd, env) {
  const list = entries(cwd, { ...env, GIT_CONFIG_NOSYSTEM: '1' });
  const trusted = (key) => list.filter((e) => e.key === key && TRUSTED.has(e.scope)).pop();
  // A relative hooks path resolves inside the checkout, and ~/ in the
  // agent's HOME, both of which an agent can write.
  const hooks = trusted('core.hookspath')?.value;
  const out = [['core.hookspath', hooks && path.isAbsolute(hooks) ? hooks : os.devNull]];
  for (const [key, fallback] of Object.entries(FIXED)) out.push([key, trusted(key)?.value ?? fallback]);
  out.push(...QUIET);
  const untrusted = [...new Set(list.filter((e) => !TRUSTED.has(e.scope)).map((e) => e.key))];
  for (const key of untrusted) {
    const named = NAMED.find(([re]) => re.test(key));
    if (!named) continue;
    out.push([key, trusted(key)?.value ?? named[1]]);
    if (key.startsWith('filter.') && !trusted(key)) out.push([key.replace(/\.[^.]+$/, '.required'), 'false']);
  }
  // An empty helper clears the list git built so far; the trusted helpers
  // then come back in their order.
  for (const key of new Set(['credential.helper', ...untrusted.filter((k) => CREDENTIAL.test(k))])) {
    out.push([key, '']);
    for (const e of list) if (e.key === key && TRUSTED.has(e.scope)) out.push([key, e.value]);
  }
  return out;
}

// env plus the neutralizing entries, appended after any it already has.
// The scan runs git, so a caller inside a state mutation passes the pairs it
// took before.
function harnessEnv(env, cwd, add = null) {
  const out = { ...env, GIT_CONFIG_NOSYSTEM: '1' };
  // Only the harness's sandbox may mark a command as confined (sandboxedEnv).
  delete out.SANDBOX_RUNTIME;
  delete out.CODEX_SANDBOX;
  // core.gitProxy takes the first match, so later config cannot override
  // it; the environment wins over all of it.
  out.GIT_PROXY_COMMAND ??= '';
  const from = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  add ??= pairs(cwd, out);
  add.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${from + i}`] = key;
    out[`GIT_CONFIG_VALUE_${from + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(from + add.length);
  out[MARK] = `${from}:${from + add.length}`;
  return out;
}

const ours = (key) => key === 'core.hookspath' || Object.hasOwn(FIXED, key) || CREDENTIAL.test(key)
  || /^filter\..+\.required$/.test(key) || NAMED.some(([re]) => re.test(key));

// The agent's own commands inherit the harness environment, but they run
// inside the sandbox, where the repository's hooks and drivers may run as
// they would for the owner: the git shim drops the entries harnessEnv added
// there, all but gc and maintenance. claude's sandbox sets SANDBOX_RUNTIME
// and codex's CODEX_SANDBOX in the commands they confine; the harness
// process has neither, so its own git keeps every entry.
function sandboxedEnv(env) {
  const m = /^(\d+):(\d+)$/.exec(env[MARK] || '');
  if (!m || !(env.SANDBOX_RUNTIME === '1' || env.CODEX_SANDBOX)) return env;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const count = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  const quiet = new Set(QUIET.map(([k]) => k));
  const keep = [];
  for (let i = 0; i < count; i++) {
    const key = env[`GIT_CONFIG_KEY_${i}`];
    if (key === undefined) break;
    // A sandbox appends its own entries after these; only harnessEnv's go.
    if (i >= from && i < to && !quiet.has(key) && ours(key)) continue;
    keep.push([key, env[`GIT_CONFIG_VALUE_${i}`] ?? '']);
  }
  const out = { ...env };
  for (let i = 0; i < count; i++) {
    delete out[`GIT_CONFIG_KEY_${i}`];
    delete out[`GIT_CONFIG_VALUE_${i}`];
  }
  keep.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(keep.length);
  delete out[MARK];
  return out;
}

module.exports = { harnessEnv, sandboxedEnv, pairs, MARK, QUIET };
