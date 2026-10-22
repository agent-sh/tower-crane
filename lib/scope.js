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
const committedCache = new Map();
const SHA = /^[0-9a-f]{40,64}$/i;

function hotPool(st, candidates = []) {
  const T = require('./tasks'), Stack = require('./stack');
  const selected = new Set(candidates);
  const reserved = new Set(T.reservations(st, Date.now()).map((r) => r.task));
  return st.tasks.tasks.filter((t) => selected.has(t.id) || t.status !== 'cancelled' && !Stack.merged(st, t)
    && (['in_progress', 'submitted', 'rework', 'accepted'].includes(t.status) || reserved.has(t.id)));
}

function briefStamp(st, id) {
  try {
    const s = fs.statSync(require('./tasks').briefPath(st.dir, id));
    return [s.mtimeMs, s.ctimeMs, s.size];
  } catch { return null; }
}

const hotInputs = (st, candidates) => JSON.stringify([st.project.hot_paths, st.project.base,
  hotPool(st, candidates).map((t) => [t.id, t.sha, t.branch, t.worktree, t.stack,
    require('./stack').targetBase(st, t), briefStamp(st, t.id)])]);

function invalidateHotPaths(st) {
  hotSnapshots.delete(st);
}

function bindHotPaths(st, snapshot) {
  if (!snapshot) return;
  if (snapshot.inputs !== hotInputs(st, snapshot.candidates)) throw Object.assign(require('./util').refuse('hot path inputs changed while taking the state lock; retry'), { hotPathsChanged: true });
  const current = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  snapshot.pool = snapshot.pool.map((t) => current.get(t.id));
  hotSnapshots.set(st, snapshot);
}

function hotGit(root, args) {
  cp.assertUnlocked('git');
  return cp.execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// Use the worktree base rule without fetching from a read-only observation.
function hotBase(snapshot, base) {
  if (snapshot.bases.has(base)) return snapshot.bases.get(base);
  const name = base.replace(/^origin\//, '');
  const local = snapshot.refs.get(`refs/heads/${name}`), remote = snapshot.refs.get(`refs/remotes/origin/${name}`);
  if (base.startsWith('origin/')) {
    snapshot.bases.set(base, remote);
    return remote;
  }
  let chosen = local || remote;
  if (remote && (!local || local === remote)) chosen = remote;
  else if (local && remote) {
    try { hotGit(snapshot.repo.root, ['merge-base', '--is-ancestor', local, remote]); chosen = remote; }
    catch (error) { if (error.lockedCommand) throw error; }
  }
  snapshot.bases.set(base, chosen);
  return chosen;
}

function hotHead(snapshot, task) {
  const root = task.worktree?.path;
  if (root && fs.existsSync(root)) {
    try {
      const dot = path.join(root, '.git');
      const admin = fs.statSync(dot).isDirectory() ? dot
        : path.resolve(root, /^gitdir: (.+)\r?$/m.exec(fs.readFileSync(dot, 'utf8'))[1].trim());
      const head = fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim();
      if (SHA.test(head)) return head;
      const ref = /^ref: (.+)$/.exec(head)?.[1];
      if (ref && snapshot.refs.has(ref)) return snapshot.refs.get(ref);
    } catch { /* A missing worktree falls back to its recorded branch. */ }
  }
  return snapshot.refs.get(`refs/heads/${task.branch || task.worktree?.branch}`)
    || snapshot.refs.get(`refs/remotes/origin/${task.branch}`) || (SHA.test(task.sha || '') ? task.sha : null);
}

function hotCommitted(st, snapshot, task, base, head) {
  const file = path.join(st.dir, 'hot-path-cache', `${task.id}.json`);
  const key = `${st.dir}:${task.id}`, valid = (v) => v?.version === 1 && v.base === base && v.head === head
    && Array.isArray(v.files) && v.files.every((f) => typeof f === 'string' && f && !f.includes('\0') && !f.startsWith('/') && !f.split('/').includes('..'));
  let cached = committedCache.get(key);
  if (!valid(cached)) {
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cached = null; }
  }
  if (valid(cached)) { committedCache.set(key, cached); return cached.files; }
  const files = hotGit(snapshot.repo.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${base}...${head}`]).split('\0').filter(Boolean);
  cached = { version: 1, base, head, files };
  committedCache.set(key, cached);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    require('./state').writeAtomic(file, JSON.stringify(cached) + '\n');
  } catch {
    // A read-only state directory can still use the process cache.
  }
  return files;
}

function hotFiles(st, snapshot, task) {
  if (snapshot.files.has(task.id)) return snapshot.files.get(task.id);
  cp.assertUnlocked('git');
  const files = new Set();
  if (snapshot.repo) {
    const base = hotBase(snapshot, require('./stack').targetBase(st, task));
    const head = hotHead(snapshot, task);
    if (base && head) {
      try { for (const f of hotCommitted(st, snapshot, task, base, head)) files.add(f); }
      catch (error) { if (error.lockedCommand) throw error; }
    }
    if (task.worktree?.path && fs.existsSync(task.worktree.path)) {
      try {
        const status = hotGit(task.worktree.path, ['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all']);
        for (const row of status.split('\0')) if (row.length > 3) files.add(row.slice(3));
      } catch (error) { if (error.lockedCommand) throw error; }
    }
  }
  const result = [...files];
  snapshot.files.set(task.id, result);
  return result;
}

function hotMatches(st, snapshot, task, diff = true) {
  let scoped = snapshot.scopes.get(task.id);
  if (!scoped) {
    const t = { ...snapshot.tree, isDirectory: (word) => {
      try { return fs.statSync(path.join(task.worktree?.path || snapshot.repo?.root || st.dir, word)).isDirectory(); }
      catch { return false; }
    } };
    const paths = hotScopePaths(briefText(require('./tasks').briefPath(st.dir, task.id)), t);
    scoped = new Set(st.project.hot_paths.filter((g) => paths.some((p) => globsOverlap(p, g))));
    snapshot.scopes.set(task.id, scoped);
  }
  if (!diff || scoped.size === st.project.hot_paths.length) return scoped;
  if (!snapshot.matches.has(task.id)) {
    const files = hotFiles(st, snapshot, task);
    const matchers = gates()?.globToRegExp;
    snapshot.matches.set(task.id, new Set([...scoped, ...st.project.hot_paths.filter((g) => files.some((f) => matchers ? matchers(g).test(f) : globsOverlap(f, g)))]));
  }
  return snapshot.matches.get(task.id);
}

// A view loads an index lazily. A readiness transaction warms only its
// candidates and possible holders before taking the state lock.
function prepareHotPaths(st, { candidates } = {}) {
  let snapshot = hotSnapshots.get(st);
  if (!snapshot) {
    cp.assertUnlocked('git');
    const repo = st.project.hot_paths?.length ? require('./state').findRepo(st.dir, process.cwd()) : null;
    snapshot = { candidates: candidates || [], repo, pool: hotPool(st, candidates || []), files: new Map(), scopes: new Map(), matches: new Map(), bases: new Map(), refs: new Map(),
      tree: { files: new Set(), dirs: new Set(['']), roots: [] } };
    if (repo) {
      const refs = hotGit(repo.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes/origin']);
      for (const line of refs.trim().split('\n')) { const [ref, sha] = line.split(' '); if (ref && sha) snapshot.refs.set(ref, sha); }
      const base = hotBase(snapshot, st.project.base);
      snapshot.tree = tree(repo.root, base ? [base] : []);
    }
    hotSnapshots.set(st, snapshot);
  }
  if (candidates) {
    snapshot.candidates = candidates;
    snapshot.pool = hotPool(st, candidates);
    if (st.project.hot_paths?.length) for (const task of snapshot.pool) hotMatches(st, snapshot, task);
    snapshot.inputs = hotInputs(st, candidates);
  }
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
      if (word && (t.dirs.has(word) || t.isDirectory?.(word))) paths.push(`${word}/`);
      else if (t.files.has(word) || /^[\w@*?{},-]+\.[\w.*?{},-]+$/.test(word)) paths.push(word);
    }
  }
  return [...new Set(paths)];
}

function hotPathReasons(st, task, now) {
  if (!st.project.hot_paths?.length) return [];
  const snapshot = prepareHotPaths(st);
  const candidate = hotMatches(st, snapshot, task);
  if (!candidate.size) return [];
  const T = require('./tasks'), Stack = require('./stack');
  const parent = Stack.parent(st, task);
  const allowed = new Set(parent ? Stack.chain(st, parent).map((t) => t.id) : []);
  const reservations = T.reservations(st, now);
  const reserved = new Set(reservations.map((r) => r.task));
  const ownReservation = reservations.findIndex((r) => r.task === task.id);
  const recovering = task.status === 'rework' || T.leaseExpired(task, now) || ownReservation >= 0;
  const live = new Set(T.workerHolders(st, now)
    .filter((h) => h.kind === 'lease' || ownReservation < 0
      || reservations.findIndex((r) => r.task === h.task) < ownReservation)
    .map((h) => h.task));
  // Passive holders must not form a cycle between tasks resuming work.
  // Live worker slots still serialize their edits, including stack parents.
  // Unclaimed workers consume overlapping reservations in dispatch order.
  const holders = snapshot.pool.filter((t) => t.id !== task.id && t.status !== 'cancelled' && !Stack.merged(st, t)
    && (recovering ? live.has(t.id) : ['in_progress', 'submitted', 'rework', 'accepted'].includes(t.status) || reserved.has(t.id)));
  return [...candidate].flatMap((glob) => holders.filter((t) => !allowed.has(t.id) && hotMatches(st, snapshot, t).has(glob))
    .map((t) => `waits on hot path ${glob} held by ${t.id}`));
}

module.exports = { tokens, named, tree, check, briefText, line, hotPathErrors, globsOverlap, hotScopePaths, hotBase, prepareHotPaths, invalidateHotPaths, bindHotPaths, hotPathReasons };
