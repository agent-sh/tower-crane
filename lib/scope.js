'use strict';

// The scope gate: the files a submitted diff changes, compared with the
// repository paths the task's title, acceptance and brief name. A token counts
// as a path when it has a slash and its directory exists in the repository at
// the base or the submitted head, so prose such as "and/or" or
// "AGENTS.md/CLAUDE.md" names nothing. Test files under the project's test
// layouts and the changelog are always in scope. A task that names no path is
// scoped to the whole repository. Out-of-scope files are flagged, not
// refused: the reviewer and the orchestrator judge them.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');

// The gates are an optional install; without them a glob names nothing and
// only the changelog is always in scope.
function gates() {
  try {
    return require('./gates/tests');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

const TOKEN = /"([^"\r\n]*[/\\][^"\r\n]*)"|'([^'\r\n]*[/\\][^'\r\n]*)'|`([^`\r\n]*[/\\][^`\r\n]*)`|(?:^|[\s([<])((?:[A-Za-z]:)?[/\\]?(?:\.[/\\])?[\w@.-]+(?:[/\\][\w@.*-]*)+)/g;
const ALWAYS = ['CHANGELOG.md'];

function tokens(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/^\.\//, '').replace(/[.,:;]+$/, '');
    if (t && !t.startsWith('..') && !out.includes(t)) out.push(t);
  }
  return out;
}

function tree(root, refs) {
  const files = new Set();
  for (const ref of refs) {
    try {
      const out = cp.execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', '-z', ref], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const f of out.split('\0')) if (f) files.add(f);
    } catch {
      // A ref this repository does not have adds nothing.
    }
  }
  const dirs = new Set(['']);
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  const roots = [path.resolve(root)];
  try {
    const out = cp.execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const field of out.split('\0')) if (field.startsWith('worktree ')) roots.push(path.resolve(field.slice(9)));
  } catch {
    // The main checkout still scopes absolute paths if registrations are unavailable.
  }
  return { files, dirs, roots: [...new Set(roots)].sort((a, b) => b.length - a.length) };
}

const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// The tokens that name a place in the repository, each with its matcher.
function named(text, t) {
  const out = [];
  const add = (token) => {
    if (path.isAbsolute(token)) {
      const relative = (t.roots || []).map((root) => path.relative(root, token))
        .find((p) => p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p));
      if (relative === undefined) return false;
      token = relative;
    }
    token = token.split(path.sep).join('/');
    const bare = token.replace(/\/+$/, '');
    let entry;
    if (!bare) {
      entry = { path: './', match: { test: () => true } };
    } else if (token.includes('*')) {
      const globToRegExp = gates()?.globToRegExp;
      if (!globToRegExp) return false;
      const lead = token.slice(0, token.indexOf('*'));
      if (t.dirs.has(lead.endsWith('/') ? lead.slice(0, -1) : parent(lead))) entry = { path: token, match: globToRegExp(token) };
    } else if (t.dirs.has(bare)) {
      entry = { path: `${bare}/`, match: { test: (f) => f.startsWith(`${bare}/`) } };
    } else if (t.files.has(bare) || (!/\s/.test(bare) && t.dirs.has(parent(bare)))) {
      entry = { path: bare, match: { test: (f) => f === bare } };
    }
    if (!entry) return false;
    if (!out.some((p) => p.path === entry.path)) out.push(entry);
    return true;
  };
  for (const token of tokens(text)) {
    if (!add(token)) for (const inner of tokens(token)) if (inner !== token) add(inner);
  }
  return out;
}

// tree is what tree() read for the diff, before any state lock: child
// processes cannot run inside a state mutation.
function check({ task, brief, files, tree: t, project }) {
  const text = [task.title, ...(task.acceptance || []), brief].join('\n');
  const paths = named(text, t);
  if (!paths.length) return { basis: 'repo', named: [], outside: [] };
  const tests = gates()?.testMatcher(project || {}) || {};
  const inScope = (f) => ALWAYS.includes(f) || (tests.match && tests.match(f)) || paths.some((p) => p.match.test(f));
  return { basis: 'named', named: paths.map((p) => p.path), outside: files.filter((f) => !inScope(f)) };
}

function briefText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function line(scope) {
  if (!scope) return '';
  if (scope.error) return `scope: not checked (${scope.error})`;
  if (scope.basis === 'repo') return 'scope: the brief and acceptance name no repository path; the whole repository is in scope';
  if (!scope.outside.length) return `scope: every changed file is under ${scope.named.join(', ')}`;
  return `scope: ${scope.outside.length} changed file${scope.outside.length === 1 ? '' : 's'} outside the paths the brief and acceptance name (${scope.named.join(', ')}): ${scope.outside.join(', ')}`;
}

module.exports = { tokens, named, tree, check, briefText, line };
