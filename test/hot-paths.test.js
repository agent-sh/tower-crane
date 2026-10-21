'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const Scope = require('../lib/scope');

function fixture(t) {
  return cachedFixture(t, 'hot-paths', (h) => {
    fs.mkdirSync(path.join(h.repo, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'lib/hot.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(h.repo, 'lib/cold.js'), 'module.exports = 2;\n');
    h.git(['add', 'lib']);
    h.git(['commit', '-qm', 'seed paths']);
    h.init(['--workers', '3', '--hot-paths', '["lib/hot.js"]']);
    for (const [id, file] of [['T1', 'lib/hot.js'], ['T2', 'lib/hot.js'], ['T3', 'lib/cold.js']]) {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
      h.ok(['brief', 'set', id, '-'], { input: `## Why\n\nlib/cold.js is nearby.\n\n## Scope\n\n- ${file}\n\n## Notes\n\nlib/hot.js is an example.\n` });
    }
  });
}

test('hot glob intersection includes new paths, directories and glob alternatives', () => {
  const cases = [
    ['lib/hot.js', 'lib/hot.js', true],
    ['lib/hot.js', 'lib/cold.js', false],
    ['lib/', 'lib/hot.js', true],
    ['lib/', 'docs/*', false],
    ['lib/*.js', '**/hot.js', true],
    ['lib/*.js', 'lib/nested/hot.js', false],
    ['lib/**/*.js', 'lib/hot.js', true],
    ['lib/**/*.js', 'lib/new/hot.js', true],
    ['lib/**/hot.js', 'lib/newhot.js', false],
    ['lib/{hot,cold}.js', 'lib/cold.js', true],
    ['lib/{hot,cold}.js', 'lib/new.js', false],
    ['docs/state/', 'docs/state/*', true],
    ['docs/state/', 'docs/state.md', false],
    ['docs/new?.md', 'docs/new1.md', true],
    ['docs/new?.md', 'docs/new10.md', false],
    ['./lib/*', 'lib/new.js', true],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(Scope.globsOverlap(a, b), expected, `${a} intersects ${b}`);
    assert.equal(Scope.globsOverlap(b, a), expected, `${b} intersects ${a}`);
  }
});

test('Scope parsing keeps glob alternatives and includes only Scope paths', () => {
  const t = { roots: [path.resolve('fixture')], files: new Set(['README.md']), dirs: new Set(['lib']) };
  for (const [text, paths] of [
    ['lib/hot.js', ['lib/hot.js']],
    ['- lib/hot.js\n- lib/cold.js', ['lib/hot.js', 'lib/cold.js']],
    ['lib/{cold,other}.js', ['lib/{cold,other}.js']],
    ['docs/new?.md', ['docs/new?.md']],
    ['lib/new/', ['lib/new/']],
    ['lib', ['lib/']],
    ['README.md', ['README.md']],
    ['NEW.md', ['NEW.md']],
    [path.join(t.roots[0], 'lib/hot.js'), ['lib/hot.js']],
  ]) {
    const brief = `## Why\n\nlib/hot.js\n\n## Scope\n\n${text}\n\n## Notes\n\nlib/other.js\n`;
    assert.deepEqual(Scope.hotScopePaths(brief, t), paths, text);
  }
  assert.deepEqual(Scope.hotScopePaths('## Why\n\nlib/hot.js\n', t), []);
  assert.equal(Scope.hotScopePaths('## Scope\n\nlib/{cold,other}.js\n', t).some((p) => Scope.globsOverlap(p, 'lib/hot.js')), false);
});

test('hot_paths is a validated operational project setting with show and clear', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.json(['project', 'show']).hot_paths, ['lib/hot.js']);
  const refused = h.run(['project', 'set', '--hot-paths', '[]', '--agent', 'worker']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.deepEqual(h.json(['project', 'show']).hot_paths, ['lib/hot.js']);
  for (const value of ['{}', '[1]', '[""]', '["../lib/hot.js"]', '["/lib/hot.js"]', '["lib\\\\hot.js"]']) {
    const result = h.run(['project', 'set', '--hot-paths', value]);
    assert.equal(result.code, 2, `${value}: ${result.stderr}`);
  }
  h.ok(['project', 'set', '--hot-paths', '[" lib/*.js ","lib/*.js"]']);
  assert.deepEqual(h.json(['project', 'show']).hot_paths, ['lib/*.js']);
  assert.match(h.ok(['project', 'show']), /hot_paths: \["lib\/\*\.js"\]/);
  h.ok(['project', 'set', '--hot-paths', 'null']);
  assert.equal(h.json(['project', 'show']).hot_paths, undefined);
  h.ok(['project', 'set', '--hot-paths', '[]']);
  assert.deepEqual(h.json(['project', 'show']).hot_paths, []);
});

function merged(h, id) {
  const doc = h.readState('tasks.json'), task = doc.tasks.find((x) => x.id === id);
  task.status = 'accepted';
  task.claim = null;
  task.sha = h.git(['rev-parse', 'HEAD']);
  const detail = { type: 'merge', sha: task.sha, revision: task.revision, ok: true,
    source: 'merge', commands: ['git merge'], agent: 'orchestrator' };
  task.evidence.push(detail);
  h.writeState('tasks.json', doc);
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
    at: new Date().toISOString(), cmd: 'merge', task: id, agent: 'orchestrator', detail,
  }) + '\n');
}

test('claim waits on a hot scope while unrelated work starts, then resumes after merge', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1', 'T2', 'T3']);
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const result = h.run(['claim', 'T2', '--agent', 'worker-2']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /waits on hot path lib\/hot.js held by T1/);
  assert.match(h.ok(['status']), /waits on hot path lib\/hot.js held by T1/);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T3']);
  h.ok(['claim', 'T3', '--agent', 'worker-3']);
  merged(h, 'T1');
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
});

test('concurrent claims of overlapping tasks grant one holder while unrelated work claims', async (t) => {
  const h = fixture(t);
  const results = await Promise.all(['T1', 'T2', 'T3'].map((id) => h.runAsync(['claim', id, '--agent', `worker-${id}`])));
  assert.equal(results.slice(0, 2).filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results[2].code, 0, results[2].stderr);
  assert.match(results.slice(0, 2).find((r) => r.code !== 0).stderr, /waits on hot path lib\/hot.js held by T[12]/);
});

test('every in-flight lifecycle holds a hot path until cancellation or merge', (t) => {
  const h = fixture(t);
  for (const status of ['in_progress', 'submitted', 'rework', 'accepted']) {
    const doc = h.readState('tasks.json');
    doc.tasks[0].status = status;
    doc.tasks[0].claim = status === 'in_progress' ? {
      agent: 'worker-1', from: 'todo', since: new Date().toISOString(), until: new Date(Date.now() - 1000).toISOString(),
    } : null;
    h.writeState('tasks.json', doc);
    const result = h.run(['claim', 'T2', '--agent', 'worker-2']);
    assert.equal(result.code, 1, status);
    assert.match(result.stderr, /waits on hot path lib\/hot.js held by T1/);
  }
  const doc = h.readState('tasks.json');
  doc.tasks[0].status = 'rework';
  h.writeState('tasks.json', doc);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  h.ok(['claim', 'T2', '--agent', 'worker-2']);
});

test('diffs hold hot paths absent from Scope, including pending and submitted changes', (t) => {
  const h = fixture(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: '## Scope\n\nlib/cold.js\n' });
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const wt = h.json(['worktree', 'T1']);
  for (const stage of ['unstaged', 'staged', 'committed', 'submitted', 'ready diff']) {
    if (stage === 'unstaged') fs.writeFileSync(path.join(wt.path, 'lib/hot.js'), 'module.exports = 3;\n');
    if (stage === 'staged') h.git(['add', 'lib/hot.js'], wt.path);
    if (stage === 'committed') h.git(['commit', '-qm', 'change hot path'], wt.path);
    if (stage === 'submitted' || stage === 'ready diff') {
      const doc = h.readState('tasks.json');
      const task = doc.tasks[0];
      task.sha = h.git(['rev-parse', 'HEAD'], wt.path);
      task.status = stage === 'submitted' ? 'submitted' : 'todo';
      task.claim = null;
      if (stage === 'ready diff') {
        doc.tasks[1].status = 'submitted';
        h.ok(['brief', 'set', 'T2', '-'], { input: '## Scope\n\nlib/hot.js\n' });
      }
      h.writeState('tasks.json', doc);
    }
    const id = stage === 'ready diff' ? 'T1' : 'T2';
    const result = h.run(['claim', id, '--agent', 'worker-2']);
    assert.equal(result.code, 1, stage);
    assert.match(result.stderr, /waits on hot path lib\/hot.js held by T[12]/, stage);
  }
});

test('new untracked hot files and directory scopes hold a configured glob', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--hot-paths', '["lib/new*.js"]']);
  h.ok(['brief', 'set', 'T1', '-'], { input: '## Scope\n\nlib/cold.js\n' });
  h.ok(['brief', 'set', 'T2', '-'], { input: '## Scope\n\nlib/\n' });
  h.ok(['claim', 'T1', '--agent', 'worker-1']);
  const wt = h.json(['worktree', 'T1']);
  fs.writeFileSync(path.join(wt.path, 'lib/new-hot.js'), 'module.exports = 4;\n');
  const result = h.run(['claim', 'T2', '--agent', 'worker-2']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /waits on hot path lib\/new\*\.js held by T1/);
});

test('eligible dependent stacks share their parent hot path but still wait on other holders', (t) => {
  const f = require('./stack-fixture').setup(t);
  const h = f.h;
  h.ok(['project', 'set', '--hot-paths', '["T1.txt"]']);
  for (const id of ['T1', 'T2']) h.ok(['brief', 'set', id, '-'], { input: '## Scope\n\nT1.txt\n' });
  assert.match(h.ok(['ready']), /T2/);
  h.ok(['task', 'add', '--title', 'Other holder', '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T3', '-'], { input: '## Scope\n\nT1.txt\n' });
  const doc = h.readState('tasks.json');
  doc.tasks.find((x) => x.id === 'T3').status = 'rework';
  h.writeState('tasks.json', doc);
  assert.match(h.ok(['ready', '--all']), /waits on hot path T1.txt held by T3/);
});

test('automatic refill skips the overlapping ready task and starts it after the holder merges', async (t) => {
  const h = require('./automation-helpers').refillFixture(t);
  const { waitFor } = require('./canary');
  h.ok(['task', 'update', 'T4', '--status', 'cancelled']);
  h.ok(['project', 'set', '--workers', '3', '--hot-paths', '["value.js"]']);
  for (const [id, file] of [['T1', 'value.js'], ['T2', 'value.js'], ['T3', 'test/value.test.js']]) {
    h.ok(['brief', 'set', id, '-'], { input: `## Scope\n\n${file}\n` });
  }
  const first = h.run(['wait', '--after', '0', '--types', 'spawn', '--task', 'T3', '--timeout', '300', '--agent', 'orchestrator']);
  assert.equal(first.code, 0, first.stderr);
  await waitFor(h.marker('T1'));
  await waitFor(h.marker('T3'));
  assert.equal(fs.existsSync(h.marker('T2')), false);
  assert.match(h.ok(['status']), /T2 waits on hot path value.js held by T1/);
  fs.writeFileSync(`${h.marker('T1')}.go`, '');
  await waitFor(`${h.marker('T1')}.exited`);
  merged(h, 'T1');
  const next = h.run(['wait', '--after', '0', '--types', 'spawn', '--task', 'T2', '--timeout', '300', '--agent', 'orchestrator']);
  assert.equal(next.code, 0, next.stderr);
  await waitFor(h.marker('T2'));
});
