'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');

test('concurrent claims on one task: exactly one wins', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Contested', '--acceptance', 'a']);
  const agents = ['w-1', 'w-2', 'w-3', 'w-4'];
  const results = await Promise.all(agents.map((a) => h.runAsync(['claim', 'T1', '--agent', a])));
  const winners = results.map((r, i) => [r.code, agents[i]]).filter(([code]) => code === 0);
  assert.equal(winners.length, 1, JSON.stringify(results));
  for (const r of results) if (r.code !== 0) assert.equal(r.code, 1, r.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claim.agent, winners[0][1]);
  const events = require('node:fs').readFileSync(require('node:path').join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.cmd === 'claim').length, 1);
});

test('an expired lease frees the task for another agent', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['claim', 'T1', '--agent', 'w-1', '--lease', '30']);
  const held = h.run(['claim', 'T1', '--agent', 'w-2']);
  assert.equal(held.code, 1);
  assert.match(held.stderr, /claimed by w-1/);
  assert.deepEqual(h.json(['ready']).ready, []);

  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1']);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.claim.agent, 'w-2');
  assert.equal(task.claim.from, 'todo');
  const late = h.run(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'w-1']);
  assert.equal(late.code, 1);
  assert.match(late.stderr, /only the claimant \(w-2\)/);
});

test('claiming a task again as its current holder renews the lease', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['claim', 'T1', '--agent', 'w-1', '--lease', '1']);
  const before = h.readState('tasks.json').tasks[0].claim;

  h.ok(['claim', 'T1', '--agent', 'w-1', '--lease', '5']);
  const after = h.readState('tasks.json').tasks[0].claim;
  assert.deepEqual([after.agent, after.since, after.from], [before.agent, before.since, before.from]);
  assert.ok(Date.parse(after.until) > Date.parse(before.until), 'a repeat claim extends the lease');
});

test('the workers limit caps tasks in progress', (t) => {
  const h = makeRepo(t);
  h.init(['--workers', '1']);
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const r = h.run(['claim', 'T2', '--agent', 'w-2']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /workers limit is reached .*project set --workers/);
  h.ok(['release', 'T1', '--reason', 'switching to T2', '--agent', 'w-1']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  h.ok(['claim', 'T2', '--agent', 'w-2']);
  h.ok(['project', 'set', '--workers', '2']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
});

test('renewing an expired lease takes a worker slot like a claim', (t) => {
  const h = makeRepo(t);
  h.init(['--workers', '1']);
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  h.ok(['claim', 'T2', '--agent', 'w-2']);

  const late = h.run(['renew', 'T1', '--agent', 'w-1']);
  assert.equal(late.code, 1, late.stderr);
  assert.match(late.stderr, /T1's lease expired and the workers limit is reached \(1 worker slots held, limit 1\)/);
  const inProgress = h.json(['status']).in_progress.filter((x) => !x.expired);
  assert.deepEqual(inProgress.map((x) => x.id), ['T2'], 'one task in progress, as the limit says');

  h.ok(['renew', 'T2', '--agent', 'w-2']);
  h.ok(['submit', 'T2', '--sha', 'abcdef1', '--agent', 'w-2']);
  h.ok(['renew', 'T1', '--agent', 'w-1']);
  assert.ok(Date.parse(h.readState('tasks.json').tasks[0].claim.until) > Date.now(), 'with a slot free, the late renewal stands');
  h.ok(['submit', 'T1', '--sha', 'abcdef2', '--agent', 'w-1']);
});

test('renewing an expired claim passes the readiness checks a claim does', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['renew', 'T1', '--agent', 'w-1']);
  // The lease expires before each blocker lands: a live claim cannot change its dependencies without --interrupt.
  const expire = () => {
    const doc = h.readState('tasks.json');
    doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
    h.writeState('tasks.json', doc);
  };
  const refuseRenewal = (refusal) => {
    const claim = structuredClone(h.readState('tasks.json').tasks[0].claim);
    const renew = h.run(['renew', 'T1', '--agent', 'w-1']);
    assert.equal(renew.code, 1, renew.stdout);
    assert.match(renew.stderr, refusal);
    assert.deepEqual(h.readState('tasks.json').tasks[0].claim, claim, 'a refused renewal leaves the expired claim unchanged');
  };
  // Clearing each blocker after its refusal shows the same expired claim renews once it is ready.
  const cases = [
    { add: ['task', 'update', 'T1', '--dep', 'T2'], clear: ['task', 'update', 'T1', '--dep', ''], refusal: /T1 is blocked: depends on T2 \(todo\)/ },
    { add: ['task', 'update', 'T1', '--needs-owner', 'await prerequisite'], clear: ['task', 'update', 'T1', '--needs-owner', ''], refusal: /T1 is blocked: needs owner: await prerequisite/ },
  ];
  for (const c of cases) {
    expire();
    h.ok(c.add);
    refuseRenewal(c.refusal);
    h.ok(c.clear);
    h.ok(['renew', 'T1', '--agent', 'w-1']);
    assert.ok(Date.parse(h.readState('tasks.json').tasks[0].claim.until) > Date.now(), 'once the blocker is gone, the renewal stands');
  }

  expire();
  h.ok(['ask', '--question', 'Ship on Friday?', '--option', 'yes', '--option', 'no', '--blocks', 'T1']);
  refuseRenewal(/T1 is blocked: waits for decision D1: Ship on Friday\?/);
});

test('only the claimant submits, renews or releases', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  const early = h.run(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'w-1']);
  assert.equal(early.code, 1);
  assert.match(early.stderr, /not in progress; claim it/);
  h.ok(['claim', 'T1', '--agent', 'w-1', '--lease', '5']);
  for (const args of [['submit', 'T1', '--sha', 'abcdef1'], ['renew', 'T1'], ['release', 'T1', '--reason', 'x']]) {
    const r = h.run([...args, '--agent', 'w-2']);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /only the claimant/);
  }
  const before = h.readState('tasks.json').tasks[0].claim.until;
  h.ok(['renew', 'T1', '--agent', 'w-1', '--lease', '120']);
  assert.ok(Date.parse(h.readState('tasks.json').tasks[0].claim.until) > Date.parse(before));
  assert.equal(h.run(['submit', 'T1', '--sha', 'not-a-sha', '--agent', 'w-1']).code, 2);
  h.ok(['submit', 'T1', '--sha', 'ABCDEF1234', '--branch', 'feat/x', '--pr', '12', '--summary', 'did it', '--agent', 'w-1']);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(
    [task.status, task.sha, task.branch, task.pr, task.submitted_by, task.claim],
    ['submitted', 'abcdef1234', 'feat/x', 12, 'w-1', null],
  );
  assert.match(task.notes[0].text, /did it/);
});

test('the owner can release any claim', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['release', 'T1', '--reason', 'worker is stuck']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'todo');
  assert.equal(task.notes[0].agent, 'owner');
  assert.match(task.notes[0].text, /released claim held by w-1: worker is stuck/);
});
