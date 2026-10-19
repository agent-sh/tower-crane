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
    read('wait', ['wait', '--task', 'T1', '--after', cursor, '--timeout', '1', '--agent', agent]),
  ];
  for (const run of runs) assert.ok(run.rows < OTHER / 10, `${run.label} read ${run.rows} event rows of a ${OTHER}-event log`);
  assert.equal(runs.find((r) => r.label === 'hook poll').rows, 0, 'an empty poll reads no events');
});
