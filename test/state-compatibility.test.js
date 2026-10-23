'use strict';

const { waitOnRepo, killPid } = require('./signals');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { makeTaskRepo, dispatch } = require('./helpers');
const S = require('../lib/state');
const Sharing = require('../lib/sharing');
const { performance } = require('node:perf_hooks');

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

function heldWorker(h) {
  const ready = path.join(h.base, 'ready');
  const finish = path.join(h.base, 'finish');
  const edited = path.join(h.base, 'edited');
  const script = `
const fs = require('node:fs');
// The test signals this pid, so it publishes the file whole.
fs.writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)});
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
  h.ok(['ask', '--kind', 'technical', '--question', 'Current decision?', '--agent', 'current-worker']);
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
    await waitOnRepo(h, () => fs.existsSync(worker.ready), 'worker did not start');
    h.ok(['claim', 'T1', '--agent', 'worker-T1-1', '--lease', '1']);
    S.withLock(h.state, () => futureState(h));
    // The shortened lease and future event force a state read and renewal.
    await waitOnRepo(h, () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8')
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
  h.ok(['ask', '--kind', 'technical', '--question', 'Future blocker?', '--blocks', 'T1']);
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
test(`${change} drains the supervisor without killing an edit`, async (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  // The supervisor's first state read and stat after the change are refused
  // once, as a Windows reader is while a writer renames a file into place.
  const busy = path.join(h.base, 'busy-read');
  const { run: running, until, signal, output } = dispatch(t, h, { hooks: { HOOK_BUSY_READ: busy } });
  let liveBeforeExit;
  try {
    await signal(worker.ready);
    // The harness can report ready before dispatch commits. Future writers
    // must wait for that lock and publish complete files, as the CLI does.
    S.withLock(h.state, () => {
      fs.writeFileSync(busy, '');
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
    await until(() => /supervision stopped.*worker.*finish/i.test(output()), 'the supervisor reports a clean schema stop');
    killPid(Number(fs.readFileSync(worker.ready, 'utf8')), 0);
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

// Windows refuses a file a scanner or the indexer holds open with EPERM,
// EBUSY or EACCES. The table runs with those codes taken as Windows takes them.
test('a sharing refusal is waited out with backoff and a lasting one fails at the bound', () => {
  const busy = Sharing.SHARING_BUSY.splice(0);
  Sharing.SHARING_BUSY.push('EPERM', 'EBUSY', 'EACCES');
  const refusal = (code) => Object.assign(new Error(`${code}: refused, stat 'events.jsonl'`), { code });
  try {
    for (const row of [
      { name: 'transient EPERM', code: 'EPERM', refusals: 3, calls: 4 },
      { name: 'transient EBUSY', code: 'EBUSY', refusals: 3, calls: 4 },
      { name: 'transient EACCES', code: 'EACCES', refusals: 1, calls: 2 },
      { name: 'missing file', code: 'ENOENT', refusals: Infinity, calls: 1, fails: true },
      { name: 'lasting EPERM', code: 'EPERM', refusals: Infinity, fails: true, bound: 200 },
      { name: 'lasting EBUSY', code: 'EBUSY', refusals: Infinity, fails: true, bound: 200 },
    ]) {
      let calls = 0;
      const started = performance.now();
      const read = () => Sharing.sharingRetry(() => {
        if (++calls <= row.refusals) throw refusal(row.code);
        return 'read';
      }, row.bound);
      if (!row.fails) assert.equal(read(), 'read', row.name);
      else assert.throws(read, (e) => e.code === row.code
        && (!row.bound || e.message.includes(`still refused after ${row.bound} ms`)), row.name);
      const elapsed = performance.now() - started;
      if (row.calls) assert.equal(calls, row.calls, row.name);
      if (row.bound) {
        // Backoff spaces the attempts out instead of spinning, and the wait ends at the bound.
        assert.ok(calls > 2 && calls < row.bound / 5, `${row.name}: ${calls} attempts`);
        assert.ok(elapsed >= row.bound && elapsed < row.bound + 1000, `${row.name}: ${elapsed} ms`); // wait-allow: the retry's time bound is the contract under test
      }
    }
  } finally {
    Sharing.SHARING_BUSY.splice(0, Infinity, ...busy);
  }
  if (process.platform !== 'win32') {
    // Elsewhere these codes are a permission failure, which no wait ends.
    let calls = 0;
    assert.throws(() => Sharing.sharingRetry(() => { calls++; throw refusal('EPERM'); }), { code: 'EPERM' });
    assert.equal(calls, 1);
  }
});

// Where a scanner's refusal starts within a read decides which part of the
// read meets it first. Wherever that is, a read that meets a refusal lasting
// past the bound fails after one wait; one that waited again from a later
// read got through once the scanner let go, and the supervisor below never
// failed. Each row opens the window at every state access of its operation in
// turn, as the scanner hook does (test/fixtures/hooks.js HOOK_SHARING_WINDOW).
// Each refusal moves a virtual clock on, so a wait is a few attempts.
test('a lasting refusal fails a state read after one wait, wherever in the read it starts', (t) => {
  const h = fixture(t);
  // The scanner hook's files, and a commit's staged copies, which a scanner holds as well.
  const STATE_FILE = /^((project|tasks|decisions)\.json(\.E[0-9a-f-]{36}\.commit)?|events(\.cuts)?\.jsonl|progress\/[^/]+\.jsonl)$/;
  const WINDOW_MS = Sharing.SHARING_RETRY_MS + 1500;
  const calls = ['statSync', 'lstatSync', 'openSync', 'readFileSync'];
  const realFs = Object.fromEntries(calls.map((name) => [name, fs[name]]));
  const realNow = performance.now;
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const busy = Sharing.SHARING_BUSY.splice(0, Infinity, 'EPERM');
  let skew = 0;
  let accesses = 0;
  let from = Infinity;
  let opened = null;
  let closed = false;
  // Every access to project.json while the lock is held is refused, for good.
  let whileLocked = false;
  // Reads of decisions.json still to be followed by a commit's append.
  let appends = 0;
  const append = () => {
    const fd = realFs.openSync(path.join(h.state, 'events.jsonl'), 'a');
    try {
      fs.writeSync(fd, JSON.stringify({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), cmd: 'appended', task: null, detail: {} }) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  };
  for (const name of calls) {
    fs[name] = function (target, ...rest) {
      const rel = typeof target === 'string' ? path.relative(h.state, path.resolve(target)).split(path.sep).join('/') : '';
      if (STATE_FILE.test(rel) && (++accesses >= from && !closed || whileLocked && rel === 'project.json' && fs.existsSync(path.join(h.state, 'lock')))) {
        opened ??= performance.now();
        // The first refusal at or past the window's end still happens and closes it.
        if (performance.now() - opened >= WINDOW_MS) closed = true; // wait-allow: the virtual clock the refusals move on
        skew += 500;
        throw Object.assign(new Error(`EPERM: operation not permitted, ${name} '${target}'`), { code: 'EPERM' });
      }
      const result = realFs[name].call(this, target, ...rest);
      if (name === 'readFileSync' && rel === 'decisions.json' && appends > 0) {
        appends--;
        append();
      }
      return result;
    };
  }
  Object.defineProperty(performance, 'now', { value: () => realNow.call(performance) + skew, configurable: true });
  const ctx = { stateDir: h.state, agent: 'reader', env: {} };
  // A commit past its commit point: its event ends the log and its file is still staged.
  const staged = () => {
    const id = `E${crypto.randomUUID()}`;
    fs.writeFileSync(path.join(h.state, `tasks.json.${id}.commit`), fs.readFileSync(path.join(h.state, 'tasks.json')));
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), cmd: 'staged', task: null, detail: {} }) + '\n');
  };
  let release = null;
  try {
    for (const row of [
      { name: 'a read', run: () => S.loadState(h.state) },
      { name: 'a read that keeps its snapshot', before: () => { release = S.retainEvents(h.state); S.loadState(h.state); }, run: () => S.loadState(h.state) },
      { name: 'a write', run: () => S.mutate(ctx, 'read', () => {}) },
      { name: 'a read while a logged commit is staged', before: staged, run: () => S.loadState(h.state) },
      // Every lock-free read loses to an append, so the read ends under the lock.
      { name: 'a read that falls back to the lock', before: () => { appends = 5; }, run: () => S.loadState(h.state) },
    ]) {
      const attempt = (start) => {
        release?.();
        release = null;
        appends = 0;
        row.before?.();
        accesses = 0;
        from = start;
        opened = null;
        closed = false;
        try {
          row.run();
          return { opened };
        } catch (error) {
          return { opened, error, elapsed: performance.now() - opened };
        } finally {
          from = Infinity;
        }
      };
      const clean = attempt(Infinity);
      assert.ifError(clean.error);
      assert.equal(appends, 0, `${row.name}: every append landed during the read`);
      const total = accesses;
      assert.ok(total > 3, `${row.name}: ${total} state accesses`);
      for (let start = 1; start <= total; start++) {
        const { opened: met, error, elapsed } = attempt(start);
        // A path that took fewer accesses this time met no refusal.
        if (met === null) continue;
        const where = `${row.name}, refused from access ${start} of ${total}`;
        assert.ok(error, `${where}: the read got through once the refusal ended`);
        assert.equal(error.code, 'EPERM', `${where}: ${error.stack}`);
        assert.match(error.message, new RegExp(`still refused after ${Sharing.SHARING_RETRY_MS} ms`), where);
        assert.ok(elapsed < 2 * Sharing.SHARING_RETRY_MS, `${where}: failed ${elapsed} ms after the first refusal`); // wait-allow: the retry's time bound is the contract under test
      }
    }
    // A writer recovers a staged commit under the lock before it reads. A
    // refusal there counts as a busy lock (docs/state/storage.md): the commit
    // stays staged until recovery can read the schema, and the writer fails
    // at the lock wait. One that read on finished the commit unchecked.
    staged();
    const commits = () => fs.readdirSync(h.state).filter((name) => name.endsWith('.commit')).length;
    assert.equal(commits(), 1);
    whileLocked = true;
    assert.throws(() => S.mutate(ctx, 'read', () => {}), (error) => error.code === 3 && /holds an interrupted commit's file open/.test(error.message));
    assert.equal(commits(), 1, 'the commit stays staged');
    whileLocked = false;
    S.mutate(ctx, 'read', () => {});
    assert.equal(commits(), 0, 'the next writer finishes it');
  } finally {
    release?.();
    Object.assign(fs, realFs);
    if (ownNow) Object.defineProperty(performance, 'now', ownNow);
    else delete performance.now;
    Sharing.SHARING_BUSY.splice(0, Infinity, ...busy);
  }
});

// A lease about to run out makes the supervisor read the state, and renew it
// through the event log, while every state file is held.
function holdStateFiles(h, scanner) {
  S.withLock(h.state, () => {
    fs.writeFileSync(scanner, '');
    const tasks = h.readState('tasks.json');
    assert.ok(tasks.tasks[0].claim, 'the supervisor holds the lease');
    tasks.tasks[0].claim.until = new Date(Date.now() + 1000).toISOString();
    writeState(h, 'tasks.json', tasks);
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'scanner holds', task: 'T1', detail: {},
    }) + '\n');
  });
}

test('the supervisor waits out a scanner holding its state files and log', async (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  const scanner = path.join(h.base, 'scanner');
  const { run: running, until, signal } = dispatch(t, h, { hooks: { HOOK_SHARING_WINDOW: scanner, HOOK_SHARING_IN: 'spawn-monitor.js' } });
  try {
    await signal(worker.ready);
    holdStateFiles(h, scanner);
    await until(() => S.readEvents(h.state).some((e) => e.cmd === 'renew'), 'the supervisor renews the lease through the refusals');
  } finally {
    fs.writeFileSync(worker.finish, '');
  }
  const result = await running;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(worker.edited, 'utf8'), 'edit finished');
  assert.doesNotMatch(result.stderr, /supervisor failed|is gone/);
  const refused = fs.readFileSync(scanner, 'utf8');
  for (const call of ['statSync project.json', 'statSync events.jsonl', 'openSync events.jsonl', 'readFileSync tasks.json']) {
    assert.ok(refused.includes(`${call}\n`), `the supervisor met a refused ${call}:\n${refused}`);
  }
});

test('the supervisor fails at the bound, naming the refusal, when a scanner keeps its state', async (t) => {
  const h = fixture(t);
  const worker = heldWorker(h);
  const scanner = path.join(h.base, 'scanner');
  // The refusals end after the failure, so the supervisor still records its exit.
  const hooks = { HOOK_SHARING_WINDOW: scanner, HOOK_SHARING_IN: 'spawn-monitor.js', HOOK_SHARING_REFUSALS: '0', HOOK_SHARING_WINDOW_MS: String(Sharing.SHARING_RETRY_MS + 1500) };
  const { run: running, until, signal, output } = dispatch(t, h, { hooks });
  let elapsed;
  try {
    await signal(worker.ready);
    holdStateFiles(h, scanner);
    await until(() => fs.readFileSync(scanner, 'utf8'), 'the first refusal');
    const started = performance.now();
    await until(() => /supervisor failed/.test(output()), 'the supervisor gives up');
    elapsed = performance.now() - started;
  } finally {
    fs.writeFileSync(worker.finish, '');
  }
  const result = await running;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`supervisor failed: EPERM: operation not permitted, \\w+ '[^']+' \\(still refused after ${Sharing.SHARING_RETRY_MS} ms`));
  assert.doesNotMatch(result.stderr, /is gone/);
  // One wait, not one per read that met the refusal.
  assert.ok(elapsed < 2 * Sharing.SHARING_RETRY_MS, `the supervisor failed ${elapsed} ms after the first refusal`); // wait-allow: the retry's time bound is the contract under test
});
