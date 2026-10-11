'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeTaskRepo, BIN, HOOKS } = require('./helpers');
const S = require('../lib/state');

const writeState = (h, file, value) => S.writeAtomic(path.join(h.state, file), S.json(value));

function fixture(t) {
  return makeTaskRepo(t, [
    { args: ['--title', 'Current worker', '--tier', 'easy', '--acceptance', 'keeps working'], brief: 'Finish the edit.\n' },
    { args: ['--title', 'Future task', '--tier', 'easy', '--acceptance', 'stays opaque'], brief: 'Future work.\n' },
  ]);
}

function futureState(h) {
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].future_worker_field = { keep: true };
  if (tasks.tasks[0].claim) tasks.tasks[0].claim.until = new Date(Date.now() + 1000).toISOString();
  tasks.future_index = { next: 'opaque' };
  Object.assign(tasks.tasks[1], {
    status: 'archived', kind: 'future-kind', size: 'XL', tier: 'expert',
    needs: ['future-capability'], tier_range: { min: 'hard', max: 'expert' },
    future_field: { nested: ['preserve', 42] },
    evidence: [{ type: 'future-gate', payload: { proof: true } }],
    escalations: [{ source: 'future', from: 'hard', to: 'expert', reason: 'future tier' }],
    spend: { minutes: 0, tokens: 0, entries: [{
      at: new Date().toISOString(), agent: 'future', source: 'future', minutes: 0,
      tokens: null, input: null, cached: null, output: null,
      rung: 'expert', harness: 'future-harness', provider: 'future-provider', model: null, profile: null,
      live: { state: 'future-reading', interval_ms: 1000, error: 'FutureReadError', future_field: { keep: true } },
    }] },
  });
  writeState(h, 'tasks.json', tasks);
  writeState(h, 'decisions.json', {
    version: 1, next: 3, future_index: true, decisions: [
      { id: 'D1', question: 'Obsolete?', status: 'withdrawn', withdrawn_by: 'owner', withdraw_reason: 'No longer needed' },
      { id: 'D2', question: 'Future decision?', status: 'superseded', answer_rule: 'future-rule', future_field: { by: 'D3' } },
    ],
  });
  const event = { at: new Date().toISOString(), cmd: 'future command', type: 'future-event',
    task: 'T2', agent: 'future-tool', detail: { opaque: true }, future_field: ['unchanged'] };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify(event) + '\n');
  return { task: tasks.tasks[1], event };
}

async function until(fn, message) {
  const deadline = Date.now() + 30000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(typeof message === 'function' ? message() : message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function heldWorker(h) {
  const ready = path.join(h.base, 'ready');
  const finish = path.join(h.base, 'finish');
  const edited = path.join(h.base, 'edited');
  const script = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(finish)})) {
    fs.writeFileSync(${JSON.stringify(edited)}, 'edit finished');
    process.exit(0);
  }
}, 25);
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}']),
    '--clear', 'profile', '--clear', 'model', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 0, stall_ms: 60000 })]);
  return { ready, finish, edited };
}

test('additive state stays readable and survives unrelated CLI writes', (t) => {
  const h = fixture(t);
  const future = futureState(h);
  assert.deepEqual(h.json(['task', 'show', 'T2']).future_field, future.task.future_field);
  h.ok(['task', 'note', 'T1', 'Current tool still writes']);
  h.ok(['claim', 'T1', '--agent', 'current-worker']);
  h.ok(['ask', '--question', 'Current decision?', '--agent', 'current-worker']);
  assert.deepEqual(h.readState('tasks.json').tasks[1], future.task);
  assert.deepEqual(h.readState('tasks.json').future_index, { next: 'opaque' });
  const decisions = h.readState('decisions.json');
  assert.equal(decisions.future_index, true);
  assert.equal(decisions.decisions[1].status, 'superseded');
  assert.equal(decisions.decisions[1].answer_rule, 'future-rule');
  assert.deepEqual(decisions.decisions[1].future_field, { by: 'D3' });
  assert.ok(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').includes(JSON.stringify(future.event)));
  const refused = h.run(['spawn', '--task', 'T2', '--dry-run']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /T2.*unsupported.*(status|kind|tier)/);
  assert.equal(h.run(['task', 'add', '--title', 'bad', '--kind', 'future-kind']).code, 2);
  assert.equal(h.run(['evidence', 'T1', '--type', 'future-gate', '--ok', 'true']).code, 2);
  const cancel = h.run(['task', 'update', 'T2', '--status', 'cancelled']);
  assert.match(cancel.stderr, /unsupported status/);
  const tasks = h.readState('tasks.json');
  tasks.tasks[1].status = 'todo';
  h.writeState('tasks.json', tasks);
  const claim = h.run(['claim', 'T2', '--agent', 'another-worker']);
  assert.equal(claim.code, 1);
  assert.match(claim.stderr, /unsupported kind/);
});

test('a supervised worker survives additive state from a newer tool', async (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  const running = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json']);
  try {
    await until(() => fs.existsSync(worker.ready), 'worker did not start');
    h.ok(['claim', 'T1', '--agent', 'worker-T1-1', '--lease', '1']);
    S.withLock(h.state, () => futureState(h));
    // The shortened lease and future event force a state read and renewal.
    await until(() => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8')
      .split('\n').some((line) => line && JSON.parse(line).cmd === 'renew'), 'supervisor did not renew through the new state');
  } finally {
    fs.writeFileSync(worker.finish, '');
  }
  const result = await running;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(worker.edited, 'utf8'), 'edit finished');
  assert.deepEqual(h.readState('tasks.json').tasks[0].future_worker_field, { keep: true });
  assert.doesNotMatch(result.stderr, /supervisor failed/);
});

test('unknown decision statuses block only the tasks that need to interpret them', (t) => {
  const h = fixture(t);
  h.ok(['ask', '--question', 'Future blocker?', '--blocks', 'T1']);
  const decisions = h.readState('decisions.json');
  decisions.decisions[0].status = 'future-pending';
  h.writeState('decisions.json', decisions);
  const ready = h.json(['ready']);
  assert.equal(ready.ready.some((task) => task.id === 'T1'), false);
  assert.equal(ready.ready.some((task) => task.id === 'T2'), true);
  for (const args of [['claim', 'T1', '--agent', 'worker'], ['spawn', '--task', 'T1', '--dry-run']]) {
    const result = h.run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /decision D1 has unsupported status "future-pending".*upgrade/);
  }
  h.ok(['claim', 'T2', '--agent', 'other-worker']);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'future-pending');
});

test('unknown task statuses retain unexpired claims in lock and capacity checks', (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  h.ok(['project', 'set', '--workers', '1']);
  for (const id of ['T1', 'T2']) h.ok(['task', 'update', id, '--lock', 'shared-edit']);
  h.ok(['claim', 'T1', '--agent', 'first-worker']);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].status = 'future-paused';
  h.writeState('tasks.json', tasks);
  const first = tasks.tasks[0];
  const ready = h.json(['ready', '--all']);
  const blocked = ready.blocked.find((task) => task.id === 'T2');
  assert.ok(blocked, 'an unfamiliar status must not free the claimed resource');
  assert.match(blocked.reasons.join('; '), /shared-edit.*T1.*first-worker/);
  for (const args of [['claim', 'T2', '--agent', 'second-worker'], ['spawn', '--task', 'T2']]) {
    const result = h.run(args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /shared-edit.*T1.*first-worker/);
  }
  h.ok(['task', 'update', 'T2', '--lock', '']);
  for (const args of [['claim', 'T2', '--agent', 'second-worker'], ['spawn', '--task', 'T2']]) {
    const result = h.run(args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /1 worker slots held, limit 1.*T1.*first-worker/);
  }
  assert.deepEqual(h.readState('tasks.json').tasks[0], first);
  assert.equal(fs.existsSync(worker.ready), false);
  const expired = h.readState('tasks.json');
  expired.tasks[0].claim.until = '2000-01-01T00:00:00.000Z';
  h.writeState('tasks.json', expired);
  h.ok(['claim', 'T2', '--agent', 'second-worker']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'future-paused');
});

for (const tier of ['expert', 'easy']) {
test(`recovery and rework preserve unfamiliar routing with current tier ${tier}`, (t) => {
  const h = fixture(t);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha]);
  h.reviewer('T1', 'reviewer');
  const tasks = h.readState('tasks.json');
  Object.assign(tasks.tasks[0], { tier, tier_range: { min: 'easy', max: 'super-expert' } });
  h.writeState('tasks.json', tasks);
  const brief = fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8');
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', 'reviewer', '--summary', 'fix the result']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.tier, tier);
  assert.equal(task.status, 'submitted');
  assert.deepEqual(task.tier_range, tasks.tasks[0].tier_range);
  assert.equal(task.escalations, undefined);
  assert.equal(task.evidence.at(-1).ok, false, 'the review verdict remains recorded');
  const before = ['tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));
  const recovery = h.json(['recover', 'T1']);
  assert.match(recovery.waiting, /unsupported tier.*upgrade/);
  const rework = h.run(['rework', 'T1', '--reason', 'fix the result']);
  assert.equal(rework.code, 1);
  assert.match(rework.stderr, /unsupported tier.*upgrade/);
  assert.deepEqual(['tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8')), before);
  assert.equal(fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8'), brief);
});
}

test('newer schemas refuse dispatch and writes before any side effects', (t) => {
  const h = fixture(t);
  assert.equal(h.readState('project.json').schema_version, 1);
  const project = h.readState('project.json');
  project.schema_version = 2;
  h.writeState('project.json', project);
  const before = ['project.json', 'tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));
  for (const args of [['spawn', '--task', 'T1'], ['task', 'note', 'T1', 'cannot write']]) {
    const result = h.run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /state schema 2.*supports.*1.*upgrade/i);
  }
  assert.deepEqual(['project.json', 'tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8')), before);
  assert.equal(fs.existsSync(path.join(h.state, 'homes')), false);
  // Existing projects need no migration for the first schema contract.
  delete project.schema_version;
  h.writeState('project.json', project);
  h.ok(['task', 'note', 'T1', 'legacy schema']);
});

test('a schema bump during a lock-free CLI read reports incompatibility before payload errors', (t) => {
  const h = fixture(t);
  const hook = path.join(h.base, 'schema-bump.cjs');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const result = read.call(this, file, ...args);
  if (file === ${JSON.stringify(path.join(h.state, 'tasks.json'))}) {
    const project = JSON.parse(read(${JSON.stringify(path.join(h.state, 'project.json'))}, 'utf8'));
    project.schema_version = 2;
    fs.writeFileSync(${JSON.stringify(path.join(h.state, 'project.json'))}, JSON.stringify(project));
    return JSON.stringify({ version: 2, tasks: 'new representation' });
  }
  return result;
};
`);
  const result = h.run(['task', 'show', 'T1'], { env: { NODE_OPTIONS: `--require ${JSON.stringify(hook)}` } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /state schema 2.*supports.*1.*upgrade/i);
  assert.doesNotMatch(result.stderr, /tasks.json is invalid/);
});

for (const change of ['schema bump', 'unknown current task status', 'unknown blocking decision status']) {
// Windows starts the harness before its claim, so a drain that refuses the claim stops a worker that has no lease yet.
test(`${change} drains the supervisor without killing an edit`, { skip: process.platform === 'win32' && 'the lease gate is POSIX-only' }, async (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  let output = '';
  const child = cp.spawn(process.execPath, ['--require', HOOKS, BIN, 'spawn', '--task', 'T1', '--wait', '--json'], {
    cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, HOOK_PROCESSES_DIR: path.join(h.base, 'detached') },
  });
  child.stdout.resume();
  child.stderr.on('data', (data) => { output += data; });
  const running = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr: output })));
  let liveBeforeExit;
  try {
    await until(() => fs.existsSync(worker.ready), 'worker did not start');
    // The harness can report ready before dispatch commits. Future writers
    // must wait for that lock and publish complete files, as the CLI does.
    S.withLock(h.state, () => {
      if (change === 'schema bump') {
        const project = h.readState('project.json');
        project.schema_version = 2;
        writeState(h, 'project.json', project);
      } else {
        if (change === 'unknown current task status') {
          const tasks = h.readState('tasks.json');
          tasks.tasks[0].status = 'future-paused';
          writeState(h, 'tasks.json', tasks);
        } else {
          writeState(h, 'decisions.json', { version: 1, next: 2, decisions: [{
            id: 'D1', question: 'Future blocker?', status: 'future-pending', blocks: ['T1'],
          }] });
        }
        fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
          at: new Date().toISOString(), cmd: 'future pause', task: 'T1', detail: {},
        }) + '\n');
      }
    });
    await until(() => /supervision stopped.*worker.*finish/i.test(output),
      () => `supervisor did not report a clean schema stop:\n${output}`);
    process.kill(Number(fs.readFileSync(worker.ready, 'utf8')), 0);
    liveBeforeExit = S.readEvents(h.state).filter((e) => e.cmd === 'spend live');
  } finally {
    fs.writeFileSync(worker.finish, '');
  }
  const result = await running;
  assert.equal(result.code, 1, result.stderr);
  assert.equal(fs.readFileSync(worker.edited, 'utf8'), 'edit finished');
  assert.doesNotMatch(result.stderr, /supervisor failed/);
  assert.deepEqual(S.readEvents(h.state).filter((e) => e.cmd === 'spend live'), liveBeforeExit,
    'an incompatible supervisor does not write a final live-spend snapshot');
});
}
