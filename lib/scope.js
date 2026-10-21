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
const HOT_TOKEN = /"([^"\r\n]*[/\\][^"\r\n]*)"|'([^'\r\n]*[/\\][^'\r\n]*)'|`([^`\r\n]*[/\\][^`\r\n]*)`|(?:^|[\s([<])((?:[A-Za-z]:)?[/\\]?(?:\.[/\\])?[\w@.*?{},-]+(?:[/\\][\w@.*?{},-]*)+)/g;
const ALWAYS = ['CHANGELOG.md'];

function tokens(text, matcher = TOKEN) {
  const out = [];
  for (const m of String(text || '').matchAll(matcher)) {
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

function hotPathErrors(value) {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((p) => typeof p === 'string' && p.trim()
    && !path.isAbsolute(p.trim()) && !p.includes('\\') && !p.includes('\0') && !p.trim().split('/').includes('..'))
    ? [] : ['hot_paths must be an array of non-blank repository-relative globs without parent components'];
}

// Intersect glob automata rather than enumerate tracked files: a brief can
// name a new file or directory which does not exist at either git ref yet.
function globMachine(pattern) {
  const states = [[]];
  const add = () => states.push([]) - 1;
  const build = (text, start) => {
    let at = start;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = add();
      if (c === '{' && text.indexOf('}', i) > i) {
        const end = text.indexOf('}', i);
        for (const part of text.slice(i + 1, end).split(',')) states[build(part, at)].push({ to: next });
        i = end;
      } else if (c === '*') {
        const double = text[i + 1] === '*';
        if (double && text[i + 2] === '/') {
          const loop = add();
          states[at].push({ to: next }, { to: loop });
          states[loop].push({ to: loop, kind: 'any' }, { to: next, char: '/' });
          i += 2;
        } else {
          states[at].push({ to: at, kind: double ? 'any' : 'segment' }, { to: next });
          if (double) i++;
        }
      } else states[at].push({ to: next, ...(c === '?' ? { kind: 'segment' } : { char: c }) });
      at = next;
    }
    return at;
  };
  const text = pattern.trim().replace(/^\.\//, '');
  const end = build(text.endsWith('/') ? `${text}**` : text, 0);
  return { states, end };
}

function globsOverlap(a, b) {
  const left = globMachine(a), right = globMachine(b), pending = [[0, 0]], seen = new Set();
  const accepts = (edge, c) => edge.char === c || edge.kind === 'any' || edge.kind === 'segment' && c !== '/';
  while (pending.length) {
    const [l, r] = pending.pop(), key = `${l}:${r}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (l === left.end && r === right.end) return true;
    for (const x of left.states[l]) {
      if (x.char === undefined && !x.kind) pending.push([x.to, r]);
      else for (const y of right.states[r]) {
        if (y.char === undefined && !y.kind) continue;
        if ([x.char, y.char, '/', 'x'].some((c) => c !== undefined && accepts(x, c) && accepts(y, c))) pending.push([x.to, y.to]);
      }
    }
    for (const y of right.states[r]) if (y.char === undefined && !y.kind) pending.push([l, y.to]);
  }
  return false;
}

const hotSnapshots = new WeakMap();
const hotInputs = (st) => JSON.stringify([st.project.hot_paths, st.project.base,
  st.project.hot_paths?.length ? st.tasks.tasks.map((t) => [t.id, t.sha, t.branch, t.worktree, t.stack,
    t.status !== 'cancelled' && !require('./stack').merged(st, t), require('./stack').targetBase(st, t)]) : []]);

function invalidateHotPaths(st) {
  hotSnapshots.delete(st);
}

function bindHotPaths(st, snapshot) {
  if (!snapshot) return;
  if (snapshot.inputs !== hotInputs(st)) throw Object.assign(require('./util').refuse('hot path inputs changed while taking the state lock; retry'), { hotPathsChanged: true });
  hotSnapshots.set(st, snapshot);
}

// Read git before a state mutation. Under its lock readiness uses this
// snapshot, while briefs and holder statuses are read from the locked state.
function prepareHotPaths(st) {
  const cached = hotSnapshots.get(st);
  if (cached) return cached;
  const S = require('./state');
  const snapshot = { inputs: hotInputs(st), files: new Map(), tree: { files: new Set(), dirs: new Set(['']), roots: [] } };
  if (!st.project.hot_paths?.length) {
    hotSnapshots.set(st, snapshot);
    return snapshot;
  }
  const repo = S.findRepo(st.dir, process.cwd());
  if (repo) {
    const active = st.tasks.tasks.filter((t) => t.status !== 'cancelled' && !require('./stack').merged(st, t));
    const refs = [...new Set([st.project.base, `origin/${st.project.base}`, ...active.map((t) => t.branch || t.sha).filter(Boolean)])];
    snapshot.tree = tree(repo.root, refs);
    const git = (root, args) => cp.execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0').filter(Boolean);
    for (const task of active) {
      const files = new Set();
      const base = require('./stack').targetBase(st, task);
      const bases = [base, `origin/${base}`];
      const hasWorktree = task.worktree?.path && fs.existsSync(task.worktree.path);
      const root = hasWorktree ? task.worktree.path : repo.root;
      const head = hasWorktree ? 'HEAD' : task.branch || task.sha;
      if (head) {
        for (const ref of bases) {
          try {
            const mergeBase = git(root, ['merge-base', ref, head])[0].trim();
            for (const f of git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, head])) files.add(f);
            if (task.worktree?.path === root) {
              for (const f of git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head])) files.add(f);
              for (const f of git(root, ['ls-files', '--others', '--exclude-standard', '-z'])) files.add(f);
            }
            break;
          } catch {
            // A missing local ref adds nothing; the brief still holds its paths.
          }
        }
      }
      snapshot.files.set(task.id, [...files]);
    }
  }
  hotSnapshots.set(st, snapshot);
  return snapshot;
}

function hotScopePaths(brief, t) {
  const section = /^## Scope[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(brief)?.[1] || '';
  const paths = [];
  for (let token of tokens(section, HOT_TOKEN)) {
    if (path.isAbsolute(token)) {
      token = t.roots.map((root) => path.relative(root, token))
        .find((p) => p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p));
    }
    if (token) {
      token = token.split(path.sep).join('/');
      const bare = token.replace(/\/+$/, '');
      if (!hotPathErrors([token]).length) paths.push(t.dirs.has(bare) ? `${bare}/` : token);
    }
  }
  for (const word of section.split(/[\s`"'();]+/).map((w) => w.replace(/[.,:;]+$/, ''))) {
    if (!word.includes('/')) {
      if (t.dirs.has(word) && word) paths.push(`${word}/`);
      else if (t.files.has(word) || /^[\w@*?{},-]+\.[\w.*?{},-]+$/.test(word)) paths.push(word);
    }
  }
  return [...new Set(paths)];
}

function hotPathReasons(st, task, now) {
  if (!st.project.hot_paths?.length) return [];
  const snapshot = prepareHotPaths(st);
  const T = require('./tasks'), Stack = require('./stack');
  const touches = (t, glob) => [...hotScopePaths(briefText(T.briefPath(st.dir, t.id)), snapshot.tree),
    ...(snapshot.files.get(t.id) || [])].some((p) => globsOverlap(p, glob));
  const parent = Stack.parent(st, task);
  const allowed = new Set(parent ? Stack.chain(st, parent).map((t) => t.id) : []);
  const reserved = new Set(T.reservations(st, now).map((r) => r.task));
  const holders = st.tasks.tasks.filter((t) => t.id !== task.id && t.status !== 'cancelled' && !Stack.merged(st, t)
    && (['in_progress', 'submitted', 'rework', 'accepted'].includes(t.status) || reserved.has(t.id)));
  return st.project.hot_paths.flatMap((glob) => touches(task, glob)
    ? holders.filter((t) => !allowed.has(t.id) && touches(t, glob)).map((t) => `waits on hot path ${glob} held by ${t.id}`) : []);
}

module.exports = { tokens, named, tree, check, briefText, line, hotPathErrors, globsOverlap, hotScopePaths, prepareHotPaths, invalidateHotPaths, bindHotPaths, hotPathReasons };
