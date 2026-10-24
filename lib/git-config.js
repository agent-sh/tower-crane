'use strict';

// The global git configuration a sandboxed agent runs with. Its sandbox
// cannot read the user's home, so the user's global settings are flattened
// from every file they include into a file in the agent's home, without the
// credential helpers and auth headers. The agent holds no credential: its
// broker pushes the task branch (lib/github-broker.js). git runs here, so
// this is read before the state lock, like the other git state a spawn
// records.

const cp = require('./commands');
const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

// Credentials, and include directives whose files are already flattened in.
const DROP = /^(?:credential\.|include\.|includeif\.)|^http\.(?:.+\.)?extraheader$|^sendemail\.(?:.+\.)?smtppass$/i;
// A URL's userinfo, in a key's subsection (url.<base>.insteadOf) or a value
// (a proxy): always for http and https, where it is a token or password, and
// elsewhere when it holds a password, so ssh://git@host keeps its user.
const USERINFO = /\b(https?:\/\/)[^/@\s]*@|\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]*:[^/@\s]*@/gi;
const strip = (text) => text.replace(USERINFO, (_, web, other) => web || other);
// Paths git expands with HOME, which is the agent's own in the sandbox.
const PATHS = { 'core.excludesfile': 'ignore', 'core.attributesfile': 'attributes' };

const quote = (v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;

function serialize(entries) {
  let out = '';
  let current = null;
  for (const [key, value] of entries) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    const sub = first === last ? null : key.slice(first + 1, last);
    const header = `[${key.slice(0, first)}${sub === null ? '' : ` "${sub.replace(/[\\"]/g, '\\$&')}"`}]`;
    if (header !== current) out += `${header}\n`;
    current = header;
    out += value === null ? `\t${key.slice(last + 1)}\n` : `\t${key.slice(last + 1)} = ${quote(value)}\n`;
  }
  return out;
}

// cwd is the task's worktree, so conditional includes resolve for its
// repository. Returns the file's text and the user files it points git at,
// which the sandbox must let the agent read.
function render(cwd, env, home) {
  const r = cp.spawnSync('git', ['config', '--global', '--list', '--includes', '-z'], {
    cwd, env: { ...env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
  });
  if (r.error) throw refuse(`cannot read the global git config (${r.error.message})`);
  // A user without a global file gets only the cleared helper list.
  if (r.status !== 0 && !/unable to read config file/.test(r.stderr)) {
    throw refuse(`cannot read the global git config: ${String(r.stderr).trim()}`);
  }
  const entries = (r.status === 0 ? r.stdout : '').split('\0').filter(Boolean).map((e) => {
    const nl = e.indexOf('\n');
    return nl < 0 ? [e, null] : [e.slice(0, nl), e.slice(nl + 1)];
  }).filter(([key]) => !DROP.test(key)).map(([key, value]) => [strip(key), value === null ? null : strip(value)]);
  const xdg = env.XDG_CONFIG_HOME ? path.resolve(cwd, env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const reads = [];
  for (const [key, file] of Object.entries(PATHS)) {
    const set = entries.filter(([k]) => k.toLowerCase() === key);
    for (const entry of set) {
      if (typeof entry[1] === 'string' && /^~[/\\]/.test(entry[1])) entry[1] = path.join(home, entry[1].slice(2));
    }
    const value = set.at(-1)?.[1];
    if (value === undefined && fs.existsSync(path.join(xdg, 'git', file))) entries.push([key, path.join(xdg, 'git', file)]);
    const used = value === undefined ? path.join(xdg, 'git', file) : value;
    if (used && fs.existsSync(path.resolve(cwd, used))) reads.push(path.resolve(cwd, used));
  }
  return { text: serialize([...entries, ...NO_HELPER]), reads };
}

// An empty helper clears the system's helpers, so git asks no helper at all.
const NO_HELPER = [['credential.helper', '']];
// For a dispatch that recorded no rendered config.
const CLEARED = serialize(NO_HELPER);

// A rendered text with entries that win over the user's, the cleared helper
// list still last.
function append(text, entries) {
  const base = text.endsWith(CLEARED) ? text.slice(0, -CLEARED.length) : text;
  return `${base}${serialize(entries)}${CLEARED}`;
}

module.exports = { render, serialize, append, CLEARED };
