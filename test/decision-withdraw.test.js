'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture } = require('./helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('the orchestrator withdraws delegated questions with a reason while owner restrictions remain', (t) => {
  for (const row of [
    { name: 'technical question', allowed: true },
    { name: 'escalated technical question', flags: ['--setting', 'sandbox'], allowed: true },
    { name: 'escalated owner reason', flags: ['--setting', 'sandbox', '--owner-required', 'owner must decide'] },
    { name: 'escalated crisis', kind: 'crisis', flags: ['--setting', 'sandbox', '--crisis', 'security'] },
    { name: 'escalated credential', kind: 'credential', flags: ['--setting', 'sandbox'] },
    { name: 'technical policy off', policy: { orchestrator_technical: false } },
    { name: 'escalated policy off', flags: ['--setting', 'sandbox'], policy: { orchestrator_escalated_questions: false } },
    { name: 'forged orchestrator', flags: ['--setting', 'sandbox'],
      env: { TOWER_CRANE_AGENT: 'worker-other', TOWER_CRANE_TASK: 'T1' } },
    { name: 'another orchestrator approval', approval: true },
  ]) {
    const h = cachedFixture(t, 'withdraw-delegation', (h) => {
      h.init();
      h.ok(['task', 'add', '--title', 'Waits on a question', '--acceptance', 'a reason is recorded']);
    });
    if (row.policy) h.ok(['project', 'set', '--decision-delegation', JSON.stringify(row.policy), '--agent', 'owner']);
    let asker = 'worker-ask';
    if (row.approval) {
      const home = path.join(h.base, 'home');
      fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
      Object.assign(h.env, { HOME: home, USERPROFILE: home });
      h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
      h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command',
        '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
        ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
      asker = h.json(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait']).agent;
      assert.equal(h.run(['project', 'set', '--merge-admin', 'true', '--agent', asker]).code, 1);
      assert.equal(h.readState('decisions.json').decisions[0].approval_request, true);
    } else {
      h.ok(['ask', '--kind', row.kind || 'technical', '--question', row.name, '--option', 'a', '--option', 'b',
        '--blocks', 'T1', '--agent', asker, ...(row.flags || [])]);
    }
    const before = events(h);
    const args = ['decision', 'withdraw', 'D1', '--agent', 'orchestrator'];
    for (const reasonFlags of [[], ['--reason', '   ']]) {
      const missing = h.run([...args, ...reasonFlags]);
      assert.equal(missing.code, 2, `${row.name}: ${missing.stderr}`);
      assert.deepEqual(events(h), before);
    }
    const result = h.run([...args, '--reason', 'host receipt makes this moot'], { env: row.env || {} });
    assert.equal(result.code, row.allowed ? 0 : 1, `${row.name}: ${result.stderr}`);
    const d = h.readState('decisions.json').decisions[0];
    if (row.allowed) {
      assert.deepEqual([d.status, d.withdrawn_by, d.withdraw_reason],
        ['withdrawn', 'orchestrator', 'host receipt makes this moot']);
      assert.match(h.ok(['decisions']), /withdrawn: host receipt makes this moot/);
      assert.match(h.readState('tasks.json').tasks[0].notes.at(-1).text, /decision D1 withdrawn/);
      const event = events(h).findLast((e) => e.cmd === 'decision withdraw');
      assert.deepEqual([event.detail.withdrawn_by, event.detail.reason], ['orchestrator', d.withdraw_reason]);
      assert.match(h.ok(['ready']), /T1/);
      assert.match(h.run([...args, '--reason', 'again']).stderr, /already withdrawn/);
    } else {
      assert.equal(d.status, 'open');
      assert.deepEqual(events(h), before);
      if (row.approval) {
        h.ok(['decision', 'withdraw', 'D1', '--reason', 'original requester cancels it', '--agent', asker]);
        assert.equal(h.readState('decisions.json').decisions[0].withdrawn_by, asker);
      }
    }
  }
});

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
