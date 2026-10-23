'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { cachedFixture } = require('./helpers');
const StateFiles = require('./state-files');
const S = require('../lib/state');
const Db = require('../lib/db');

const ROWS = path.join(__dirname, 'fixtures', 'rows-read.js').replace(/\\/g, '/');
// Events of another task: what a replay of the whole log would read.
const OTHER = 3000;

function fixture(t) {
  return cachedFixture(t, 'hot-paths', (h) => {
    h.init();
    for (const title of ['Hot task', 'Busy task']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Do it.\n' });
    const events = Array.from({ length: OTHER }, () => ({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), agent: 'worker-T2-1',
      cmd: 'renew', task: 'T2', detail: { until: new Date().toISOString() }, type: 'renew', to: 'orchestrator' }));
    StateFiles.withDb(h.state, () => S.withLock(h.state, () => Db.commit(h.state, { events })));
  });
}

// The hot paths read what they need through the database's indexes: one
// task's events, an agent's inbox, the events past a cursor. None replays
// the log, which here holds thousands of another task's events.
test('hook polls, writes and waits read only their own events, not the whole log', (t) => {
  const h = fixture(t);
  const agent = 'worker-T1-1';
  const binding = path.join(h.state, 'homes', agent, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ agent, task: 'T1', state: h.state, harness: 'claude', attempt: 1 }));
  const sha = h.git(['rev-parse', 'HEAD']);
  const meter = path.join(h.base, 'rows.json');
  const read = (label, args) => {
    const r = h.run(args, { env: { EVENT_ROWS: meter, NODE_OPTIONS: `--require "${ROWS}"` } });
    assert.ok([0, 2].includes(r.code), `${label}: ${r.stderr}`);
    return { label, stdout: r.stdout, ...JSON.parse(fs.readFileSync(meter, 'utf8')) };
  };
  const cursor = String(StateFiles.logEnd(h.state));
  const runs = [
    read('claim', ['claim', 'T1', '--agent', agent]),
    read('msg', ['msg', '--to', agent, '--task', 'T1', 'hello', '--agent', 'owner']),
    read('hook delivery', ['hook', 'inbox', '--binding', binding, '--agent', agent, '--payload', '{}']),
    read('hook poll', ['hook', 'inbox', '--binding', binding, '--agent', agent, '--payload', '{}']),
    read('task note', ['task', 'note', 'T1', 'progress', '--agent', agent]),
    read('submit', ['submit', 'T1', '--sha', sha, '--agent', agent]),
    read('evidence', ['evidence', 'T1', '--type', 'note', '--ok', '--summary', 'checked', '--agent', agent]),
    read('rework', ['rework', 'T1', '--reason', 'again', '--agent', 'owner']),
    // A worker waits on its own task from a cursor, as the work skill has it do.
    read('wait', ['wait', '--task', 'T1', '--after', cursor, '--timeout', '1', '--agent', agent]), // wait-allow: events past the cursor return at once; the bound only ends a wait that finds none
    // An owner's wait decides from its task's events; this one owns nothing and exits at once.
    read('wait --own', ['wait', '--own', '--task', 'T1', '--timeout', '1', '--agent', agent]), // wait-allow: the first check reports the exit; the bound only ends a wait that finds none
  ];
  for (const run of runs) assert.ok(run.rows < OTHER / 10, `${run.label} read ${run.rows} event rows of a ${OTHER}-event log`);
  assert.equal(runs.find((r) => r.label === 'hook poll').rows, 0, 'an empty poll reads no events');
});

// The bulk of a log is finished tasks' events: gate receipts, live spend,
// hook reports, reaction receipts, dispatches and their exits.
const CLOSED_CMDS = ['check tests', 'spend live', 'hook report', 'automation', 'automation queued', 'executor', 'spawn', 'spawn exit', 'submit', 'rework', 'claim', 'renew', 'task note'];

function viewFixture(t) {
  return cachedFixture(t, 'view-paths', (h) => {
    h.init();
    for (const title of ['Open task', 'Closed task', 'Submitted task', 'Accepted task']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Do it.\n' });
    h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
    // A submitted task's gates, reviews and PR-body repair, and an accepted
    // one's merge blockers, are read per task.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.repo, encoding: 'utf8' }).trim();
    for (const [id, pr] of [['T3', '7'], ['T4', '8']]) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', sha, '--pr', pr, '--branch', `fixture-${id}`, '--agent', 'worker']);
    }
    StateFiles.withDb(h.state, () => S.mutate({ stateDir: h.state, agent: 'owner' }, 'accept', (st) => {
      st.tasks.tasks.find((task) => task.id === 'T4').status = 'accepted';
    }));
    // The closed task finished a month ago; one of its gate runs crashed then.
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const events = Array.from({ length: OTHER }, (_, i) => {
      const cmd = CLOSED_CMDS[i % CLOSED_CMDS.length];
      const id = `E${crypto.randomUUID()}`;
      // Executor leases taken and released in pairs; their pid is long gone.
      const lease = Math.floor(i / CLOSED_CMDS.length);
      const detail = cmd === 'automation' ? { source: id, phase: 'done', error: null }
        : cmd === 'automation queued' ? { source: id }
          : cmd === 'executor' ? { lease: `cpu:closed-${lease >> 1}`, phase: lease % 2 ? 'done' : 'running', kind: 'tests', pid: 2147483646 }
          : ['spawn', 'spawn exit'].includes(cmd) ? { agent: 'worker-T2-1', role: 'worker', pid: 1, code: 0 }
            : { agent: 'worker-T2-1', tokens: i, until: old, ok: true, type: 'tests', summary: 'ran', ...(i === 0 ? { native_crash: [{ test: 'old', signal: 'SIGSEGV' }] } : {}) };
      return { id, at: old, agent: 'worker-T2-1', cmd, task: 'T2', detail, type: cmd, to: 'orchestrator' };
    });
    // A lease the merge line moved to another task: one it released, and one
    // it still holds under the task it moved to.
    const lease = (task, detail) => ({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), agent: 'orchestrator', cmd: 'executor', task,
      detail: { kind: 'head check', pid: 2147483646, ...detail }, type: 'executor', to: 'orchestrator' });
    events.push(lease('T3', { lease: 'cpu:moved', phase: 'running' }), lease('T4', { lease: 'cpu:moved', phase: 'running' }),
      lease('T4', { lease: 'cpu:moved', phase: 'done' }), lease('T3', { lease: 'cpu:held', phase: 'running' }),
      lease('T4', { lease: 'cpu:held', phase: 'running' }));
    // A crash this week, which status counts.
    events.push({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), agent: 'orchestrator', cmd: 'check tests', task: 'T3',
      detail: { ok: false, type: 'tests', summary: 'crashed', native_crash: [{ test: 'new', signal: 'SIGSEGV' }] }, type: 'check tests', to: 'orchestrator' });
    StateFiles.withDb(h.state, () => S.withLock(h.state, () => Db.commit(h.state, { events })));
  });
}

// status, inbox and the orchestrator's observer read task rows, indexed
// events and the latest entries of a few commands; none replays the log,
// which here holds thousands of a cancelled task's events.
test('status, inbox and an observing wait read only indexed rows, not the whole log', (t) => {
  const h = viewFixture(t);
  const meter = path.join(h.base, 'rows.json');
  const read = (label, args) => {
    const r = h.run(args, { env: { EVENT_ROWS: meter, NODE_OPTIONS: `--require "${ROWS}"` } });
    assert.ok([0, 2].includes(r.code), `${label}: ${r.stderr}`);
    return { label, stdout: r.stdout, ...JSON.parse(fs.readFileSync(meter, 'utf8')) };
  };
  const runs = [
    read('status', ['status', '--json']),
    read('status text', ['status']),
    read('inbox', ['inbox', '--json', '--agent', 'orchestrator']),
    // An observer refreshes the inbox at startup and records its snapshot.
    read('observer', ['wait', '--observe', '--inbox', '--timeout', '1', '--agent', 'orchestrator']), // wait-allow: the startup pass is what is measured; the bound ends the wait after it
  ];
  for (const run of runs) assert.ok(run.rows < OTHER / 100, `${run.label} read ${run.rows} event rows of a ${OTHER}-event log`);
  // Only this week's gate runs are read for the crash count.
  assert.match(runs[1].stdout, /^native crashes: 1 in the last 7 days, last T3 at /m);
});

// The benchmark behind docs/state/storage.md's status and inbox numbers runs
// both views on its own copy of a state directory and records their latency.
test('the views benchmark times status and inbox on a copy of the state', (t) => {
  const h = viewFixture(t);
  const out = path.join(h.base, 'views.json');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'research', 'storage-eval', 'views.js'), '--state', h.state,
    '--work', path.join(h.base, 'views'), '--tree', `head=${path.join(__dirname, '..')}`, '--runs', '2', '--warmup', '0', '--out', out], { encoding: 'utf8' });
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(result.trees, ['head']);
  for (const view of ['status', 'inbox']) {
    const s = result.summary.head[view];
    assert.equal(s.n, 2);
    assert.ok(s.p50 > 0 && s.p95 >= s.p50, `${view}: ${JSON.stringify(s)}`);
    assert.ok(s.output_bytes > 0, `${view} printed nothing`);
  }
});

// A merge of an already merged task, which the merge queue's entry answers
// before it reserves a turn, checks the merge's own event by index.
test('a repeated merge reads only the merged task\'s events, not the whole log', (t) => {
  const h = cachedFixture(t, 'merged-repeat', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Merged task', '--acceptance', 'done']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.repo, encoding: 'utf8' }).trim();
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--pr', '7', '--branch', 'fixture-T1', '--agent', 'worker']);
    const events = Array.from({ length: OTHER }, () => ({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), agent: 'worker-T2-1',
      cmd: 'renew', task: 'T2', detail: { until: new Date().toISOString() }, type: 'renew', to: 'orchestrator' }));
    StateFiles.withDb(h.state, () => {
      S.mutate({ stateDir: h.state, agent: 'owner' }, 'merge', (st, emit) => {
        const task = st.tasks.tasks.find((x) => x.id === 'T1');
        const merge = { type: 'merge', source: 'merge', ok: true, sha: task.sha, revision: task.revision, commands: ['gh pr merge 7'] };
        task.status = 'accepted';
        task.evidence.push({ ...merge, agent: 'owner', at: new Date().toISOString(), summary: 'merged' });
        emit(task.id, merge);
      });
      S.withLock(h.state, () => Db.commit(h.state, { events }));
    });
    return { sha };
  });
  const meter = path.join(h.base, 'rows.json');
  const r = h.run(['merge', 'T1', '--agent', 'orchestrator'], { env: { EVENT_ROWS: meter, NODE_OPTIONS: `--require "${ROWS}"` } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`already merged at ${h.sha}`));
  const { rows } = JSON.parse(fs.readFileSync(meter, 'utf8'));
  assert.ok(rows < OTHER / 10, `merge read ${rows} event rows of a ${OTHER}-event log`);
});

// A select over every event (a long-lived reader's) and one by index pick the same events.
test('an indexed select and a select over every event agree', (t) => {
  const h = viewFixture(t);
  const T = require('../lib/tasks');
  StateFiles.withDb(h.state, () => {
    const all = S.loadState(h.state).events;
    const week = new Date(Date.now() - 7 * 86400000).toISOString();
    const specs = [
      { cmds: ['check tests'] },
      { cmds: ['check tests'], since: week },
      { tasks: ['T2'], taskCmds: ['spawn', 'spawn exit'], since: week },
      { tasks: ['T3', 'T4'], taskCmds: ['submit', 'claim'] },
      { tasks: ['T3'] },
      { ids: [all[0].id, all.at(-1).id], cmds: ['accept'] },
    ];
    for (const spec of specs) {
      const ids = (events) => events.map((e) => e.id);
      assert.deepEqual(ids(T.select(S.loadState(h.state).log, spec)), ids(T.select(all, spec)), JSON.stringify(spec));
    }
    assert.equal(T.select(all, { cmds: ['check tests'], since: week }).length, 1, 'the week holds one gate run');
    // Each lease's latest event, kept while it is running: the indexed read
    // and the fold over every event name the same ones.
    const fold = new Map();
    for (const e of all) if (e.cmd === 'executor') fold.set(e.detail.lease, e);
    const open = [...fold.values()].filter((e) => e.detail.phase === 'running');
    assert.deepEqual(S.loadState(h.state).log.openLeases().map((e) => e.id), open.map((e) => e.id));
    assert.ok(open.some((e) => e.detail.lease === 'cpu:held' && e.task === 'T4'), 'a moved lease is open under the task it moved to');
    assert.ok(!open.some((e) => e.detail.lease === 'cpu:moved'), 'a released lease is not open');
  });
});

// The gate queue folds a working set read by index. A merged task's merge
// head can still be owed its reaction, and a request made for that task
// moves it: requests are read by command across tasks, so the queue matches
// the fold over the whole log.
test('the gate queue honours a request for a merged task\'s queued merge reaction', (t) => {
  const h = cachedFixture(t, 'merged-request', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Merged task', '--acceptance', 'done']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.repo, encoding: 'utf8' }).trim();
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--pr', '7', '--branch', 'fixture-T1', '--agent', 'worker']);
  });
  const ctx = { stateDir: h.state, agent: 'owner' };
  const A = require('../lib/automation');
  const T = require('../lib/tasks');
  StateFiles.withDb(h.state, () => {
    S.mutate(ctx, 'merge', (st, emit) => {
      const task = st.tasks.tasks.find((x) => x.id === 'T1');
      const merge = { type: 'merge', source: 'merge', ok: true, sha: task.sha, revision: task.revision, commands: ['gh pr merge 7'] };
      task.status = 'accepted';
      task.evidence.push({ ...merge, agent: 'owner', at: new Date().toISOString(), summary: 'merged' });
      emit(task.id, merge);
    });
    const head = T.select(S.loadState(h.state).log, { tasks: ['T1'], taskCmds: ['merge'] })[0];
    S.mutate(ctx, 'gates prioritize', (st, emit) => {
      emit('T1', { source: head.id }, 'automation queued');
      emit('T1', { reason: 'merge reaction first', queued: 1, sources: [head.id] });
    });
    const st = S.loadState(h.state);
    assert.ok(st.log, 'the snapshot reads the log by index');
    const queue = A.gateQueue(st);
    assert.deepEqual(queue.queued, [{ id: 'T1', prioritized: { reason: 'merge reaction first', agent: 'owner', at: queue.queued[0]?.prioritized?.at, rank: 1 } }]);
    assert.ok(queue.queued[0].prioritized.at, 'the request moved the merge reaction');
    const whole = S.loadState(h.state);
    const events = whole.events;
    assert.deepEqual(A.gateQueue({ ...whole, log: null, events }), queue, 'the working set gives the whole log\'s queue');
  });
});
