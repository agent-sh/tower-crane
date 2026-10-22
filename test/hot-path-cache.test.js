'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const S = require('../lib/state');
const T = require('../lib/tasks');
const Scope = require('../lib/scope');
const Commands = require('../lib/commands');

function fixture(t) {
  return cachedFixture(t, 'hot-path-cache', (h) => {
    fs.mkdirSync(path.join(h.repo, 'lib'), { recursive: true });
    for (const name of ['hot', 'cold']) fs.writeFileSync(path.join(h.repo, `lib/${name}.js`), 'module.exports = 0;\n');
    h.git(['add', 'lib']);
    h.git(['commit', '-qm', 'base paths']);
    h.init(['--workers', '3', '--hot-paths', '["lib/hot.js"]']);
    for (const [id, file] of [['T1', 'lib/cold.js'], ['T2', 'lib/hot.js']]) {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
      h.ok(['brief', 'set', id, '-'], { input: `## Scope\n\n${file}\n` });
    }
  });
}

function observe(h, fn) {
  const previous = process.cwd(), original = Commands.execFileSync, calls = [];
  process.chdir(h.repo);
  Commands.execFileSync = (command, args, opts) => {
    if (command === 'git') calls.push(args);
    return original(command, args, opts);
  };
  try { return { result: fn(), calls }; }
  finally { Commands.execFileSync = original; process.chdir(previous); }
}

for (const variant of ['local behind', 'local ahead', 'diverged', 'remote only', 'local only']) {
test(`hot-path diffs choose the effective base with ${variant}`, (t) => {
  const h = fixture(t), start = h.git(['rev-parse', 'HEAD']);
  const remote = path.join(h.base, 'base-remote.git');
  h.git(['init', '--bare', remote]);
  h.git(['remote', 'set-url', 'origin', remote]);
  h.git(['push', 'origin', 'main']);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const wt = h.json(['worktree', 'T1']);
  h.git(['switch', '-c', 'base-update']);
  fs.writeFileSync(path.join(h.repo, 'lib/hot.js'), 'module.exports = 1;\n');
  h.git(['add', 'lib/hot.js']);
  h.git(['commit', '-qm', 'upstream hot change']);
  const updated = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', 'main']);
  if (['local behind', 'remote only'].includes(variant)) h.git(['push', 'origin', `${updated}:main`]);
  else {
    h.git(['merge', '--ff-only', updated]);
    if (variant === 'diverged') {
      h.git(['switch', '-c', 'remote-diverged', start]);
      fs.writeFileSync(path.join(h.repo, 'remote.txt'), 'remote\n');
      h.git(['add', 'remote.txt']);
      h.git(['commit', '-qm', 'remote diverged']);
      h.git(['push', 'origin', 'HEAD:main']);
      h.git(['switch', 'main']);
    }
    if (variant === 'local only') h.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  }
  if (variant === 'remote only') {
    h.git(['switch', 'base-update']);
    h.git(['update-ref', '-d', 'refs/heads/main']);
  }
  h.git(['merge', '--ff-only', updated], wt.path);
  fs.writeFileSync(path.join(wt.path, 'lib/cold.js'), 'module.exports = 2;\n');
  h.git(['add', 'lib/cold.js'], wt.path);
  h.git(['commit', '-qm', 'own cold change'], wt.path);
  assert.ok(h.json(['ready']).ready.some((row) => row.id === 'T2'), 'upstream hot changes do not hold the hot path');
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
});
}

test('base selection variants also cover stacked names and explicit remote refs', (t) => {
  const h = fixture(t), first = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'local.txt'), 'local\n');
  h.git(['add', 'local.txt']);
  h.git(['commit', '-qm', 'advance local']);
  const second = h.git(['rev-parse', 'HEAD']);
  for (const [name, local, remote, expected] of [
    ['main', first, second, second],
    ['main', second, first, second],
    ['tower-crane/lower', first, second, second],
    ['tower-crane/lower', second, first, second],
    ['main', null, second, second],
    ['main', second, null, second],
    ['origin/main', second, first, first],
    ['origin/main', second, null, undefined],
    ['missing', null, null, undefined],
  ]) {
    const branch = name.replace(/^origin\//, ''), refs = new Map();
    if (local) refs.set(`refs/heads/${branch}`, local);
    if (remote) refs.set(`refs/remotes/origin/${branch}`, remote);
    const snapshot = { refs, bases: new Map(), repo: { root: h.repo } };
    assert.equal(Scope.hotBase(snapshot, name), expected, `${name} ${local} ${remote}`);
    assert.equal(Scope.hotBase(snapshot, name), expected, 'base resolution is reused within a snapshot');
  }
});

test('hot-path cache follows branch heads, base heads and pending worktree changes', (t) => {
  const h = fixture(t);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const wt = h.json(['worktree', 'T1']);
  const read = () => observe(h, () => T.readyTasks(S.loadState(h.state), Date.now()));
  const first = read(), warm = read();
  assert.ok(first.result.some((row) => row.task.id === 'T2'));
  assert.equal(warm.calls.filter((a) => a.includes('diff')).length, 0, 'unchanged commit pairs reuse their diff');
  for (const stage of ['unstaged', 'staged', 'committed']) {
    if (stage === 'unstaged') fs.writeFileSync(path.join(wt.path, 'lib/hot.js'), 'module.exports = 3;\n');
    if (stage === 'staged') h.git(['add', 'lib/hot.js'], wt.path);
    if (stage === 'committed') h.git(['commit', '-qm', 'hot change'], wt.path);
    const result = read();
    assert.ok(!result.result.some((row) => row.task.id === 'T2'), stage);
  }
  h.git(['reset', '--hard', 'HEAD~1'], wt.path);
  assert.ok(read().result.some((row) => row.task.id === 'T2'), 'rewritten head invalidates cached paths');
  h.git(['switch', '-c', 'advanced-base']);
  fs.writeFileSync(path.join(h.repo, 'lib/cold.js'), 'module.exports = 4;\n');
  h.git(['add', 'lib/cold.js']);
  h.git(['commit', '-qm', 'advance remote base']);
  h.git(['update-ref', 'refs/remotes/origin/main', h.git(['rev-parse', 'HEAD'])]);
  h.git(['switch', 'main']);
  const advanced = read();
  assert.ok(advanced.result.some((row) => row.task.id === 'T2'), 'base refresh stays correct');
  assert.equal(advanced.calls.filter((a) => a.includes('diff')).length, 1, 'a new base tip invalidates the cached pair');
});

test('non-readiness mutations and live renewals do not prepare git snapshots', (t) => {
  const h = fixture(t);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  h.json(['worktree', 'T1']);
  const ctx = { stateDir: h.state, cwd: h.repo, env: { ...h.env, TOWER_CRANE_VIA: 'broker' }, agent: 'worker-1', pos: ['T1'], flags: {} };
  for (const command of ['task note', 'spend', 'evidence', 'spawn phase', 'wait reaction']) {
    const measured = observe(h, () => S.mutate(ctx, command, (_, emit) => emit('T1', { probe: command })));
    assert.equal(measured.calls.length, 0, command);
  }
  const renewal = observe(h, () => T.renew(ctx));
  assert.equal(renewal.calls.length, 0, 'live renewal needs no readiness snapshot');
  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  assert.ok(observe(h, () => T.renew(ctx)).calls.length > 0, 'expired renewal prepares readiness outside the lock');
});

test('snapshot costs one base tree and one brief read per task, and fresh states cannot run git under a lock', (t) => {
  const h = fixture(t);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  h.json(['worktree', 'T1']);
  const read = fs.readFileSync;
  let briefs = 0, measured;
  fs.readFileSync = (file, ...args) => {
    if (path.dirname(String(file)) === path.join(h.state, 'briefs')) briefs++;
    return read(file, ...args);
  };
  try {
    measured = observe(h, () => {
      const st = S.loadState(h.state);
      T.readyTasks(st, Date.now());
      T.blockedTasks(st, Date.now());
      T.blockedTasks(st, Date.now());
    });
  } finally { fs.readFileSync = read; }
  assert.equal(measured.calls.filter((a) => a.includes('ls-tree')).length, 1);
  assert.equal(briefs, 2);
  observe(h, () => {
    assert.throws(() => Commands.mutation(() => Scope.prepareHotPaths(S.loadState(h.state))), (error) => error.lockedCommand === true);
  });
});
