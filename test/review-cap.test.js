'use strict';

// Which reviewer ends count toward the reviewer cap, and what the hold says.
// Pure logic over an event log, run in process; test/stack.test.js drives the
// wiring through a real spawn under a slow GitHub.

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const R = require('../lib/reviewer');

const SHA = 'a'.repeat(40);
// A pid that has exited: the process ran to its end before the test reads it.
const DEAD = cp.spawnSync(process.execPath, ['-e', '0']).pid;

function state(ends, { evidence = [], extra = [] } = {}) {
  const at = new Date().toISOString();
  const events = [];
  ends.forEach((end, i) => {
    const agent = `reviewer-T1-${i + 1}`;
    events.push({ at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent, role: 'reviewer', rung: 'review',
      sha: end.sha || SHA, revision: 1, pid: DEAD, attempt: 1, log: `/logs/${agent}.log`,
      monitor_pid: end.monitor === 'running' ? process.pid : DEAD } });
    if (end.receipt === false) return;
    events.push({ at, agent, cmd: 'spawn exit', task: 'T1', detail: { agent, pid: DEAD, attempt: 1, code: end.code ?? 1, signal: end.signal || null,
      availability_failure: end.outage === true || end.supervisor === true, ...(end.supervisor ? { supervisor_failed: true } : {}) } });
  });
  events.push(...extra);
  const task = { id: 'T1', sha: SHA, revision: 1, evidence };
  return { st: { events, tasks: { tasks: [task] }, project: {} }, task };
}

const crash = {};
const variants = [
  { name: 'three crashes', ends: [crash, crash, crash], counted: 3, exit: 'held' },
  { name: 'an outage is not counted', ends: [crash, crash, { outage: true }], counted: 2, exit: null },
  { name: 'a supervisor failure is counted though it is also an availability failure', ends: [crash, crash, { supervisor: true }], counted: 3, exit: 'held' },
  { name: 'a dead monitor without a receipt is counted', ends: [crash, crash, { receipt: false }], counted: 3, exit: 'held', missing: true },
  { name: 'a running monitor without a receipt is not counted yet', ends: [crash, crash, { receipt: false, monitor: 'running' }], counted: 2, exit: 'pending' },
  { name: 'an earlier head is not counted', ends: [{ sha: 'b'.repeat(40) }, crash, crash], counted: 2, exit: null },
  { name: 'an interrupted reviewer is not counted', ends: [crash, crash, crash], counted: 2, exit: null,
    extra: [{ at: '', agent: 'orchestrator', cmd: 'interrupt', task: 'T1', detail: { agent: 'reviewer-T1-1' } }] },
  { name: 'a reviewer with a verdict at this head is not counted', ends: [crash, crash, crash], counted: 2, exit: null,
    evidence: [{ type: 'review', ok: true, agent: 'reviewer-T1-2', sha: SHA, revision: 1 }] },
  { name: 'an outage after the cap stays held', ends: [crash, crash, crash, { outage: true }], counted: 3, exit: 'held' },
];

for (const v of variants) {
  test(`review cap: ${v.name}`, () => {
    const { st, task } = state(v.ends, v);
    assert.equal(R.failedReviews(st, task).length, v.counted);
    const exit = R.reviewExit(st, task);
    assert.equal(exit?.state ?? null, v.exit);
    if (v.missing) assert.equal(exit.missing, true);
  });
}

test('the hold at the cap names the reviewer that ended last and how it ended', () => {
  const cases = [
    [[crash, crash, crash, { outage: true }], /the last, reviewer-T1-4, ended with code 1 in an outage \(log \/logs\/reviewer-T1-4\.log\)/],
    [[crash, crash, { supervisor: true }], /the last, reviewer-T1-3, ended with code 1 after its supervisor failed/],
    [[crash, crash, { receipt: false }], /the last, reviewer-T1-3, ended without an exit receipt/],
    [[crash, crash, { signal: 'SIGKILL', code: null }], /the last, reviewer-T1-3, ended with signal SIGKILL/],
  ];
  for (const [ends, reason] of cases) {
    const { st, task } = state(ends);
    const exit = R.reviewExit(st, task);
    const notice = R.holdNotice(st, task, exit.spawn);
    assert.match(notice.reason, reason);
    assert.match(notice.reason, /^reviewers ended without a verdict \d times at this head and revision; .*then accept T1 dispatches the next reviewer$/);
    assert.equal(notice.cap, R.REVIEW_EXIT_CAP);
  }
});
