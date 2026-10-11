'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');

// A docs task needs only a review from a reviewer spawn, which keeps
// "get this dependency accepted" short in tests about readiness.
function acceptDocs(h, id) {
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['claim', id, '--agent', 'w-1']);
  h.ok(['submit', id, '--sha', sha, '--agent', 'w-1']);
  h.reviewer(id, 'r-1');
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', id]);
}

test('ready lists only unblocked tasks and --all says why the rest wait', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Base', '--acceptance', 'a', '--kind', 'docs']);
  h.ok(['task', 'add', '--title', 'Needs base', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Needs owner', '--acceptance', 'c', '--needs-owner', 'add the staging credential']);
  h.ok(['task', 'add', '--title', 'Waits for decision', '--acceptance', 'd']);
  assert.equal(h.ok(['ask', '--question', 'Redis or Postgres?', '--option', 'redis', '--option', 'postgres', '--recommend', 'postgres', '--blocks', 'T4']), 'D1');

  const r = h.json(['ready', '--all']);
  assert.deepEqual(r.ready.map((x) => x.id), ['T1']);
  const why = Object.fromEntries(r.blocked.map((b) => [b.id, b.reasons]));
  assert.deepEqual(why.T2, ['depends on T1 (todo)']);
  assert.deepEqual(why.T3, ['needs owner: add the staging credential']);
  assert.deepEqual(why.T4, ['waits for decision D1: Redis or Postgres?']);
  assert.equal(h.json(['ready']).blocked, undefined, 'blocked tasks only with --all');

  const claim = h.run(['claim', 'T4', '--agent', 'w-1']);
  assert.equal(claim.code, 1);
  assert.match(claim.stderr, /T4 is blocked: waits for decision D1/);

  // Answering unblocks only the tasks the decision names, and leaves the answer on them.
  const wrong = h.run(['answer', 'D1', '--choice', 'mysql']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /redis, postgres/);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);
  h.ok(['answer', 'D1', '--choice', 'postgres', '--note', 'keys must survive a flush'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  const d = h.readState('decisions.json').decisions[0];
  assert.deepEqual([d.status, d.answer, d.answered_by], ['answered', 'postgres', 'orchestrator']);
  assert.equal(d.answer_rule, 'owner-technical-delegation');
  assert.match(h.readState('tasks.json').tasks[3].notes[0].text, /decision D1 answered: postgres/);
  assert.equal(h.run(['answer', 'D1', '--choice', 'redis']).code, 1);
  assert.deepEqual(h.json(['decisions', '--open']), []);

  h.ok(['owner-done', 'T3', '--note', 'credential is in the vault']);
  assert.equal(h.readState('tasks.json').tasks[2].needs_owner, null);
  assert.equal(h.run(['owner-done', 'T3']).code, 1, 'nothing left for the owner');

  acceptDocs(h, 'T1');
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id).sort(), ['T2', 'T3', 'T4']);
});

test('ready puts tasks that unblock the most work first', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Leaf', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Root', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'Mid', '--acceptance', 'a', '--dep', 'T2']);
  h.ok(['task', 'add', '--title', 'Top', '--acceptance', 'a', '--dep', 'T3']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'After other', '--acceptance', 'a', '--dep', 'T5']);
  const r = h.json(['ready']).ready;
  assert.deepEqual(r.map((x) => [x.id, x.unblocks]), [['T2', 2], ['T5', 1], ['T1', 0]]);
});

test('status summarizes counts, decisions, owner tasks, spend and expired leases', (t) => {
  const h = makeRepo(t);
  h.init(['--budget-hours', '10', '--budget-tokens', '1000']);
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b', '--needs-owner', 'buy the domain']);
  h.ok(['task', 'add', '--title', 'C', '--acceptance', 'c']);
  h.ok(['ask', '--question', 'Which region?', '--option', 'eu', '--option', 'us', '--blocks', 'T3']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['spend', 'T1', '--minutes', '90', '--tokens', '600']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 60000).toISOString();
  h.writeState('tasks.json', doc);

  const s = h.json(['status']);
  assert.equal(s.counts.in_progress, 1);
  assert.deepEqual(s.ready.map((x) => x.id), ['T1'], 'an expired lease makes the task ready again');
  assert.deepEqual(s.decisions_open.map((d) => d.id), ['D1']);
  assert.deepEqual(s.needs_owner.map((x) => x.id), ['T2']);
  assert.deepEqual(s.expired_leases.map((x) => [x.id, x.agent]), [['T1', 'w-1']]);
  assert.equal(s.spend.minutes, 90);
  assert.equal(s.spend.tokens, 600);
  const text = h.ok(['status']);
  assert.match(text, /spend: 1\.5 hours of 10 \(15%\), 600 tokens of 1k \(60%\)/);
  assert.match(text, /expired leases: T1 \(w-1/);
});
