'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, ROOT } = require('./helpers');
const Scope = require('../lib/scope');
const S = require('../lib/state');
const StackFixture = require('./stack-fixture');

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

for (const [file, patterns] of [
  ['docs/state/tasks.md', [/`hot_paths`/, /waits on hot path <glob> held by T<n>/]],
  ['docs/state/decisions.md', [/\| `hot_paths` \| operational \|/]],
  ['docs/state/storage.md', [/`hot-path-cache\/<task>\.json`/]],
  ['scripts/cli-reference.md', [/init --hot-paths JSON/, /project set --hot-paths JSON/]],
]) {
test(`hot-path contract survives the split in ${file}`, () => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const pattern of patterns) assert.match(text, pattern);
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

test('project validation retains hot-path and archive checks together', (t) => {
  const h = fixture(t), project = h.readState('project.json');
  for (const [paths, days, hotError, archiveError] of [
    [['lib/hot.js'], 30, false, false],
    [['../outside'], 30, true, false],
    [['lib/hot.js'], 0, false, true],
    [['../outside'], 0, true, true],
  ]) {
    const errors = S.validateProject({ ...project, hot_paths: paths, archive: { retention_days: days } });
    assert.equal(errors.some((e) => e.includes('hot_paths')), hotError);
    assert.equal(errors.some((e) => e.includes('archive.retention_days')), archiveError);
    assert.equal(errors.length, Number(hotError) + Number(archiveError));
  }
});

test('hot-path, PR ownership, archive and broker verb settings retain their values, summaries and usage together', (t) => {
  const h = fixture(t);
  const verb = { argv: [process.execPath, 'lib/hot.js'], source: { commit: h.git(['rev-parse', 'HEAD']), paths: ['lib/hot.js'] }, timeout_sec: 60 };
  for (const { paths, owners, idle, verbs, retention } of [
    { paths: ['lib/hot.js'], owners: 2, idle: 20, verbs: { hot: verb }, retention: 7 },
    { paths: ['lib/*.js'], owners: 0, idle: 60, verbs: null, retention: 30 },
  ]) {
    h.ok(['project', 'set', '--hot-paths', JSON.stringify(paths), '--owners', String(owners), '--owner-idle-minutes', String(idle), '--broker-verbs', JSON.stringify(verbs), '--archive-retention-days', String(retention)]);
    const project = h.json(['project', 'show']);
    assert.deepEqual(project.hot_paths, paths);
    assert.equal(project.limits.owners, owners);
    assert.equal(project.limits.owner_idle_minutes, idle);
    assert.equal(project.archive.retention_days, retention);
    const summary = h.ok(['project', 'show']);
    assert.ok(summary.includes(`hot_paths: ${JSON.stringify(paths)}`));
    assert.ok(summary.includes(`${owners} PR owners idle up to ${idle} min`));
    assert.ok(summary.includes(`archive.retention_days: ${retention}`));
    if (verbs) {
      assert.deepEqual(project.broker.verbs.hot.argv, verb.argv);
      assert.equal(project.broker.verbs.hot.timeout_sec, verb.timeout_sec);
      assert.match(summary, /broker verb hot: .*pinned [0-9a-f]{12}/);
    } else {
      assert.equal(project.broker?.verbs, undefined);
      assert.ok(!summary.includes('broker verb hot:'));
    }
  }
  const help = h.ok(['project', 'set', '--help']);
  for (const flag of ['[--hot-paths JSON]', '[--owners N]', '[--owner-idle-minutes MIN]', '[--broker-verbs JSON]', '[--archive-retention-days DAYS]']) assert.ok(help.includes(flag), flag);
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

function recoveryState(task, state, agent) {
  task.status = state === 'reserved todo' ? 'todo' : state.startsWith('expired') || state === 'live' ? 'in_progress' : state;
  task.claim = task.status === 'in_progress' ? {
    agent, from: state === 'expired rework' ? 'rework' : 'todo',
    since: new Date(Date.now() - 60000).toISOString(),
    until: new Date(Date.now() + (state === 'live' ? 60000 : -1000)).toISOString(),
  } : null;
}

function reservation(h, id, agent) {
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
    at: new Date().toISOString(), cmd: 'spawn', task: id, agent: 'orchestrator',
    detail: { role: 'worker', agent, attempt: 1, pid: 424201, reserved: true, active: true },
  }) + '\n');
}

const recoveryCases = [
  { candidate: 'rework', holder: 'rework', pass: true },
  { candidate: 'rework', holder: 'submitted', pass: true },
  { candidate: 'rework', holder: 'accepted', pass: true },
  { candidate: 'rework', holder: 'expired todo', pass: true },
  { candidate: 'expired todo', holder: 'expired todo', pass: true },
  { candidate: 'expired rework', holder: 'rework', pass: true },
  { candidate: 'expired todo', holder: 'rework', verb: 'renew', pass: true },
  { candidate: 'expired rework', holder: 'submitted', verb: 'renew', pass: true },
  { candidate: 'rework', holder: 'live', pass: false },
  { candidate: 'expired todo', holder: 'live', verb: 'renew', pass: false },
  { candidate: 'rework', holder: 'reservation', pass: false },
  { candidate: 'expired todo', holder: 'reservation', pass: false },
  { candidate: 'todo', holder: 'rework', pass: false },
  { candidate: 'todo', holder: 'expired todo', pass: false },
  { candidate: 'rework', holder: 'rework', diff: true, pass: true },
  { candidate: 'reserved todo', holder: 'rework', pass: true },
  { candidate: 'reserved todo', holder: 'submitted', pass: true },
  { candidate: 'reserved todo', holder: 'live', pass: false },
  { candidate: 'reserved todo', holder: 'reservation', pass: true },
  { candidate: 'reserved todo', holder: 'reservation', peerFirst: true, pass: false },
];

for (const c of recoveryCases) {
test(`hot-path recovery ${c.candidate} ${c.verb || 'claim'} against ${c.peerFirst ? 'earlier ' : ''}${c.holder}${c.diff ? ' diff' : ''}`, (t) => {
  const h = fixture(t);
  if (c.diff) {
    h.ok(['brief', 'set', 'T2', '-'], { input: '## Scope\n\nlib/cold.js\n' });
    const wt = h.json(['worktree', 'T2']);
    fs.writeFileSync(path.join(wt.path, 'lib/hot.js'), 'module.exports = 5;\n');
  }
  const doc = h.readState('tasks.json');
  recoveryState(doc.tasks[0], c.candidate, 'worker-1');
  recoveryState(doc.tasks[1], c.holder === 'reservation' ? 'todo' : c.holder, 'worker-2');
  h.writeState('tasks.json', doc);
  if (c.peerFirst) reservation(h, 'T2', 'worker-2');
  if (c.candidate === 'reserved todo') reservation(h, 'T1', 'worker-1');
  if (c.holder === 'reservation' && !c.peerFirst) reservation(h, 'T2', 'worker-2');
  const ready = h.json(['ready']).ready.some((r) => r.id === 'T1');
  assert.equal(ready, c.pass, 'ready and claim use the same recovery blockers');
  const result = h.run([c.verb || 'claim', 'T1', '--agent', 'worker-1']);
  assert.equal(result.code, c.pass ? 0 : 1, result.stderr);
  if (!c.pass) {
    assert.match(result.stderr, /waits on hot path lib\/hot.js held by T2/);
    assert.match(h.ok(['status']), /T1 waits on hot path lib\/hot.js held by T2/);
  } else if (c.holder === 'rework' || c.holder.startsWith('expired') || c.holder === 'reservation') {
    const second = h.run(['claim', 'T2', '--agent', 'worker-2']);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /waits on hot path lib\/hot.js held by T1/);
    h.ok(['release', 'T1', '--reason', 'recover peer next', '--agent', 'worker-1']);
    h.ok(['claim', 'T2', '--agent', 'worker-2']);
  }
  if (c.peerFirst) {
    h.ok(['claim', 'T2', '--agent', 'worker-2']);
    h.ok(['release', 'T2', '--reason', 'consume next reservation', '--agent', 'worker-2']);
    h.ok(['claim', 'T1', '--agent', 'worker-1']);
  }
});
}

for (const { descendant, depth } of ['submitted', 'accepted', 'rework', 'live']
  .flatMap((descendant) => [1, 2].map((depth) => ({ descendant, depth })))) {
test(`stack parent recovery with ${descendant} hot-path descendant at depth ${depth}`, (t) => {
  const f = StackFixture.stacked(t), h = f.h;
  let child = { id: 'T2', sha: f.upper.sha, wt: f.upper.wt, pr: '12' };
  if (depth === 2) {
    const id = f.add('grandchild', 'T2'), wt = h.json(['worktree', id]);
    child = { id, wt, sha: f.submit(id, 13, wt), pr: '13' };
  }
  h.ok(['project', 'set', '--hot-paths', '["T1.txt"]']);
  for (const id of new Set(['T1', 'T2', child.id])) h.ok(['brief', 'set', id, '-'], { input: '## Scope\n\nT1.txt\n' });
  h.ok(['rework', 'T1', '--reason', 'recover lower stack']);
  const doc = h.readState('tasks.json');
  recoveryState(doc.tasks.find((task) => task.id === child.id), descendant, `worker-${child.id}`);
  h.writeState('tasks.json', doc);
  const result = h.run(['claim', 'T1', '--agent', 'worker-T1']);
  assert.equal(result.code, descendant === 'live' ? 1 : 0, result.stderr);
  if (descendant === 'live') {
    assert.match(result.stderr, new RegExp(`waits on hot path T1.txt held by ${child.id}`));
    h.ok(['submit', child.id, '--sha', child.sha, '--branch', child.wt.branch, '--pr', child.pr, '--agent', `worker-${child.id}`]);
    h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  }
});
}

test('concurrent hot-path recovery claims grant one live worker', async (t) => {
  const h = fixture(t), doc = h.readState('tasks.json');
  for (const task of doc.tasks.slice(0, 2)) recoveryState(task, 'rework', `worker-${task.id}`);
  h.writeState('tasks.json', doc);
  const results = await Promise.all(['T1', 'T2'].map((id) => h.runAsync(['claim', id, '--agent', `worker-${id}`])));
  assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find((r) => r.code !== 0).stderr, /waits on hot path lib\/hot.js held by T[12]/);
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
  const f = StackFixture.setup(t);
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

test('automatic refill serializes overlapping recovery candidates while unrelated work starts', async (t) => {
  const h = require('./automation-helpers').refillFixture(t);
  const { waitFor } = require('./canary');
  h.ok(['task', 'update', 'T4', '--status', 'cancelled']);
  h.ok(['project', 'set', '--workers', '3', '--hot-paths', '["value.js"]']);
  for (const [id, file] of [['T1', 'value.js'], ['T2', 'value.js'], ['T3', 'test/value.test.js']]) {
    h.ok(['brief', 'set', id, '-'], { input: `## Scope\n\n${file}\n` });
  }
  const doc = h.readState('tasks.json');
  for (const task of doc.tasks.slice(0, 2)) recoveryState(task, 'rework', `worker-${task.id}`);
  h.writeState('tasks.json', doc);
  const first = h.run(['wait', '--after', '0', '--types', 'spawn', '--task', 'T3', '--timeout', '300', '--agent', 'orchestrator']);
  assert.equal(first.code, 0, first.stderr);
  await waitFor(h.marker('T1'));
  await waitFor(h.marker('T3'));
  assert.equal(fs.existsSync(h.marker('T2')), false);
  assert.match(h.ok(['status']), /T2 waits on hot path value.js held by T1/);
});
