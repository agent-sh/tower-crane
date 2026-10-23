'use strict';

// The git environment of a sandboxed harness process. The harness (claude,
// codex) runs its own git outside its sandbox, in the worktree the agent
// writes, and git runs commands that repository config and hooks name. The
// sandbox keeps the shared config and hooks read-only (lib/agents.js
// protectedGit); this environment makes sure that even a write it missed
// runs nothing: command-scope entries (GIT_CONFIG_PARAMETERS) win over every
// config file, and the system config is not read at all.

const cp = require('./commands');
const Parameters = require('./git-parameters');
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
// The env names the span of GIT_CONFIG_PARAMETERS, in characters, that this
// module added, so the git shim can tell its entries from the caller's own
// (lib/shim.js).
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
  // Status visits gitlinks even without submodule.recurse. Their writable
  // configs can name new drivers after this scan, so do not inspect them.
  out.push(['diff.ignoresubmodules', 'all']);
  out.push(...QUIET);
  const untrusted = [...new Set(list.filter((e) => !TRUSTED.has(e.scope)).map((e) => e.key))];
  for (const key of untrusted) {
    const named = NAMED.find(([re]) => re.test(key));
    if (!named) continue;
    out.push([key, trusted(key)?.value ?? named[1]]);
    if (key.startsWith('filter.') && !trusted(key)) out.push([key.replace(/\.[^.]+$/, '.required'), 'false']);
  }
  // An empty helper clears the list git built so far, URL-specific helpers
  // included, so every trusted helper then comes back in its order. A
  // sandboxed agent's rendered config adds none: its broker pushes.
  for (const key of new Set(['credential.helper', ...untrusted.filter((k) => CREDENTIAL.test(k))])) out.push([key, '']);
  for (const e of list) if (CREDENTIAL.test(e.key) && TRUSTED.has(e.scope)) out.push([e.key, e.value]);
  return out;
}

// env plus the neutralizing entries, appended after any it already has.
// Inherited GIT_CONFIG_COUNT entries move into GIT_CONFIG_PARAMETERS ahead of
// them (git-parameters.js), so the env holds no GIT_CONFIG_KEY_<n>. The scan
// runs git, so a caller inside a state mutation passes the pairs it took
// before.
function harnessEnv(env, cwd, add = null) {
  const out = Parameters.fromCount({ ...env, GIT_CONFIG_NOSYSTEM: '1' });
  // Only the harness's sandbox may mark a command as confined (sandboxedEnv).
  delete out.SANDBOX_RUNTIME;
  delete out.CODEX_SANDBOX;
  // core.gitProxy takes the first match, so later config cannot override
  // it; the environment wins over all of it.
  out.GIT_PROXY_COMMAND ??= '';
  add ??= pairs(cwd, out);
  const name = Parameters.key(out);
  const before = out[name] || '';
  out[name] = Parameters.append(before, add);
  const from = before && add.length ? before.length + 1 : before.length;
  out[MARK] = `${from}:${out[name].length}`;
  return out;
}

const ours = (key) => key === 'core.hookspath' || key === 'diff.ignoresubmodules' || Object.hasOwn(FIXED, key) || CREDENTIAL.test(key)
  || /^filter\..+\.required$/.test(key) || NAMED.some(([re]) => re.test(key));

// The agent's own commands inherit the harness environment, but they run
// inside the sandbox, where the repository's hooks and drivers may run as
// they would for the owner: the git shim drops the entries harnessEnv added
// there, all but gc and maintenance. claude's sandbox sets SANDBOX_RUNTIME
// and codex's CODEX_SANDBOX in the commands they confine; the harness
// process has neither, so its own git keeps every entry. A span that no
// longer holds what harnessEnv wrote keeps every entry too.
function sandboxedEnv(env) {
  const m = /^(\d+):(\d+)$/.exec(env[MARK] || '');
  if (!m || !(env.SANDBOX_RUNTIME === '1' || env.CODEX_SANDBOX)) return env;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const name = Parameters.key(env);
  const text = String(env[name] ?? '');
  const span = from <= to && to <= text.length ? Parameters.split(text.slice(from, to)) : null;
  if (!span || (from > 0 && text[from - 1] !== ' ') || (to < text.length && text[to] !== ' ')) return env;
  const quiet = new Set(QUIET.map(([k]) => k));
  const kept = span.filter((e) => quiet.has(e.name) || !ours(e.name)).map((e) => e.raw);
  const joined = [text.slice(0, from).trimEnd(), ...kept, text.slice(to).trimStart()].filter(Boolean).join(' ');
  const out = { ...env, [name]: joined };
  if (!joined) delete out[name];
  delete out[MARK];
  return out;
}

module.exports = { harnessEnv, sandboxedEnv, pairs, MARK, QUIET };
