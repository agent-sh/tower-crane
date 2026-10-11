'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('the asker or the owner withdraws an open decision with a reason; it leaves the open list and stays in history', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Waits on a decision', '--acceptance', 'the withdrawal frees it']);
  const orchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };

  // The orchestrator asks for an owner-required change; the engine opens D1 for the owner.
  const escalated = h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator'], orchestrator);
  assert.equal(escalated.code, 1, escalated.stderr);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');

  // Neither another agent nor a task process posing as the asker can withdraw it; refusals write no event.
  const before = events(h);
  const stranger = h.run(
    ['decision', 'withdraw', 'D1', '--reason', 'moot', '--agent', 'worker-other'],
    { env: { TOWER_CRANE_AGENT: 'worker-other' } },
  );
  assert.equal(stranger.code, 1, stranger.stderr);
  assert.match(stranger.stderr, /only the agent that opened D1 \(orchestrator\) or the owner/);
  const spoofed = h.run(
    ['decision', 'withdraw', 'D1', '--reason', 'moot', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker-other', TOWER_CRANE_TASK: 'T1' } },
  );
  assert.equal(spoofed.code, 1, spoofed.stderr);
  assert.match(spoofed.stderr, /only the agent that opened D1/);
  assert.deepEqual(events(h), before, 'a refused withdrawal writes no event');

  // The asker withdraws it with a reason, without an owner answer.
  h.ok(['decision', 'withdraw', 'D1', '--reason', 'T1 was released by its worker', '--agent', 'orchestrator'], orchestrator);
  const withdrawn = h.readState('decisions.json').decisions[0];
  assert.deepEqual([withdrawn.status, withdrawn.answer, withdrawn.withdrawn_by, withdrawn.withdraw_reason], [
    'withdrawn', null, 'orchestrator', 'T1 was released by its worker',
  ]);
  const withdrawEvent = events(h).findLast((event) => event.cmd === 'decision withdraw');
  assert.equal(withdrawEvent.type, 'decision-withdrawn');
  assert.equal(withdrawEvent.agent, 'orchestrator');
  assert.deepEqual([withdrawEvent.detail.decision, withdrawEvent.detail.reason], ['D1', 'T1 was released by its worker']);

  // It is off the open list and the status screen, and history still shows it with its reason.
  assert.equal(h.ok(['decisions', '--open']), 'no open decisions');
  assert.match(h.ok(['decisions']), /D1\s+withdrawn\s+.*withdrawn: T1 was released by its worker/);
  assert.match(h.ok(['status']), /open decisions: none/);

  // A withdrawn decision cannot be answered or withdrawn again.
  const answerAfter = h.run(['answer', 'D1', '--choice', 'yes', '--agent', 'owner']);
  assert.equal(answerAfter.code, 1, answerAfter.stderr);
  assert.match(answerAfter.stderr, /already withdrawn/);
  const again = h.run(['decision', 'withdraw', 'D1', '--reason', 'again', '--agent', 'orchestrator'], orchestrator);
  assert.equal(again.code, 1, again.stderr);
  assert.match(again.stderr, /already withdrawn/);

  // The owner can withdraw a worker's decision that blocks a task; the task reads the reason and becomes ready.
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1', '--agent', 'worker-ask']);
  assert.doesNotMatch(h.ok(['ready']), /T1/);
  h.ok(['decision', 'withdraw', 'D2', '--reason', 'the store is out of scope', '--agent', 'owner']);
  const owned = h.readState('decisions.json').decisions[1];
  assert.deepEqual([owned.status, owned.withdrawn_by], ['withdrawn', 'owner']);
  assert.match(h.readState('tasks.json').tasks[0].notes.at(-1).text, /decision D2 withdrawn: the store is out of scope/);
  assert.match(h.ok(['ready']), /T1/);

  // An answered decision is not withdrawn; the owner's answer stands.
  h.ok(['ask', '--kind', 'technical', '--question', 'Keep the cache?', '--option', 'yes', '--option', 'no', '--agent', 'worker-ask']);
  h.ok(['answer', 'D3', '--choice', 'yes', '--agent', 'owner']);
  const late = h.run(
    ['decision', 'withdraw', 'D3', '--reason', 'moot', '--agent', 'worker-ask'],
    { env: { TOWER_CRANE_AGENT: 'worker-ask' } },
  );
  assert.equal(late.code, 1, late.stderr);
  assert.match(late.stderr, /already answered \(yes\)/);
  assert.equal(h.readState('decisions.json').decisions[2].status, 'answered');
});
