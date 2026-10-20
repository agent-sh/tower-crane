'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
    return { label, ...JSON.parse(fs.readFileSync(meter, 'utf8')) };
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
  ];
  for (const run of runs) assert.ok(run.rows < OTHER / 10, `${run.label} read ${run.rows} event rows of a ${OTHER}-event log`);
  assert.equal(runs.find((r) => r.label === 'hook poll').rows, 0, 'an empty poll reads no events');
});

// The bulk of a log is finished tasks' events: gate receipts, live spend,
// hook reports, reaction receipts, dispatches and their exits.
const CLOSED_CMDS = ['check tests', 'spend live', 'hook report', 'automation', 'automation queued', 'spawn', 'spawn exit', 'submit', 'rework', 'claim', 'renew', 'task note'];

function viewFixture(t) {
  return cachedFixture(t, 'view-paths', (h) => {
    h.init();
    for (const title of ['Open task', 'Closed task']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Do it.\n' });
    h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
    const events = Array.from({ length: OTHER }, (_, i) => {
      const cmd = CLOSED_CMDS[i % CLOSED_CMDS.length];
      const id = `E${crypto.randomUUID()}`;
      const detail = cmd === 'automation' ? { source: id, phase: 'done', error: null }
        : cmd === 'automation queued' ? { source: id }
          : ['spawn', 'spawn exit'].includes(cmd) ? { agent: 'worker-T2-1', role: 'worker', pid: 1, code: 0 }
            : { agent: 'worker-T2-1', tokens: i, until: new Date().toISOString(), ok: true, type: 'tests', summary: 'ran' };
      return { id, at: new Date().toISOString(), agent: 'worker-T2-1', cmd, task: 'T2', detail, type: cmd, to: 'orchestrator' };
    });
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
    return { label, ...JSON.parse(fs.readFileSync(meter, 'utf8')) };
  };
  const runs = [
    read('status', ['status', '--json']),
    read('inbox', ['inbox', '--json', '--agent', 'orchestrator']),
    // An observer refreshes the inbox at startup and records its snapshot.
    read('observer', ['wait', '--observe', '--inbox', '--timeout', '1', '--agent', 'orchestrator']), // wait-allow: the startup pass is what is measured; the bound ends the wait after it
  ];
  for (const run of runs) assert.ok(run.rows < OTHER / 10, `${run.label} read ${run.rows} event rows of a ${OTHER}-event log`);
});
