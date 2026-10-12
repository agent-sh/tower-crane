'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');

function setup(t) {
  return cachedFixture(t, 'review-churn', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Review loop', '--kind', 'docs',
      '--acceptance', 'handles missing input', '--acceptance', 'handles bounds']);
    let sha;
    for (let round = 1; round <= 3; round++) {
      if (round > 1) h.ok(['rework', 'T1', '--reason', 'fix findings']);
      h.git(['commit', '--allow-empty', '-m', `Review head ${round}`]);
      sha = h.git(['rev-parse', 'HEAD']);
      h.ok(['claim', 'T1', '--agent', 'builder']);
      h.ok(['submit', 'T1', '--agent', 'builder', '--sha', sha]);
      const agent = `reviewer-${round}`;
      h.reviewer('T1', agent, sha);
      const summary = round < 3 ? `Acceptance item 1: missing input, round ${round}` : 'AC 2: bounds\ncheck';
      h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', agent, '--summary', summary]);
    }
    h.ok(['spend', 'T1', '--agent', 'builder', '--minutes', '12', '--tokens', '4200']);
    return { sha };
  });
}

const churn = (h) => h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_churn');

test('three failed reviews surface history and spend without holding rework', (t) => {
  const h = setup(t);
  const item = churn(h);
  assert.ok(item, 'three failed reviews must surface review_churn');
  assert.equal(item.task, 'T1');
  assert.equal(item.count, 3);
  assert.equal(item.churn_after, 3);
  assert.equal(item.revision, 3);
  assert.equal(new Set(item.reviews.map((r) => r.sha)).size, 3, 'failures count across heads');
  assert.deepEqual(item.reviews.map((r) => r.findings),
    ['Acceptance item 1: missing input, round 1', 'Acceptance item 1: missing input, round 2', 'AC 2: bounds check']);
  assert.deepEqual(item.reviews.map((r) => r.scope_change), ['first', 'same_acceptance_lines', 'added_acceptance_lines']);
  assert.deepEqual(item.reviews[2].new_acceptance_lines, [2]);
  assert.equal(item.spend.minutes, 12);
  assert.equal(item.spend.tokens, 4200);
  assert.match(item.reason, /bound scope, split.*change tier/i);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
  const status = h.json(['status']);
  assert.deepEqual(status.review_churn, [{ id: 'T1', revision: 3, count: 3 }]);
  assert.match(h.ok(['status']), /review churn: T1 3/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /review churn: 3/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /\| T1 \| 3 \| 3 \|/);
  h.ok(['rework', 'T1', '--reason', 'fix bounds', '--agent', 'orchestrator']);
  assert.equal(churn(h).count, 3);
  assert.ok(h.json(['ready']).ready.some((r) => r.id === 'T1'));
  h.ok(['claim', 'T1', '--agent', 'builder']);
  assert.equal(churn(h).count, 3);
  h.ok(['project', 'set', '--review-policy', '{"churn_after":4}', '--agent', 'orchestrator']);
  assert.equal(churn(h), undefined);
  h.ok(['project', 'set', '--review-policy', 'null', '--agent', 'orchestrator']);
  assert.equal(churn(h).count, 3);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  assert.equal(churn(h), undefined);
});

test('acceptance revision resets churn but retains the review evidence', (t) => {
  const h = setup(t);
  assert.equal(churn(h)?.count, 3, 'precondition: churn before revision');
  h.ok(['task', 'update', 'T1', '--acceptance', 'handles missing input and bounds within frozen scope']);
  assert.equal(churn(h), undefined);
  assert.deepEqual(h.json(['status']).review_churn, [{ id: 'T1', revision: 4, count: 0 }]);
  assert.match(h.ok(['status']), /review churn: T1 0/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /review churn: 0/);
  assert.equal(h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'review' && !e.ok).length, 3);
});

test('stack sync rework cannot restore reviews across an acceptance reset', (t) => {
  const { stacked } = require('./stack-fixture');
  const f = stacked(t);
  const h = f.h;
  const sha = f.upper.sha;
  const taskChurn = () => h.json(['status']).review_churn.find((r) => r.id === 'T2').count;
  const item = () => h.json(['inbox', '--agent', 'orchestrator']).items
    .find((i) => i.kind === 'review_churn' && i.task === 'T2');
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      h.ok(['rework', 'T2', '--reason', 'fix review']);
      h.ok(['claim', 'T2', '--agent', 'worker-T2']);
      h.ok(['submit', 'T2', '--sha', sha, '--agent', 'worker-T2']);
    }
    const agent = `churn-reviewer-${round}`;
    h.reviewer('T2', agent, sha);
    h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha,
      '--agent', agent, '--summary', 'Acceptance item 1: old scope finding']);
  }
  assert.equal(taskChurn(), 3);
  assert.equal(item().count, 3);
  h.ok(['rework', 'T2', '--reason', 'fix the rejected head']);
  assert.equal(taskChurn(), 3);
  h.ok(['task', 'update', 'T2', '--acceptance', 'new acceptance scope']);
  assert.equal(taskChurn(), 0);
  f.write((d) => { d.conflict = true; });
  for (const revision of [6, 7]) {
    const result = h.run(['stack', 'sync', 'T2']);
    assert.equal(result.code, 1);
    assert.match(result.stdout + result.stderr, /conflict/i);
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const rework = events.findLast((e) => e.cmd === 'rework' && e.task === 'T2');
    assert.equal(rework.detail.previous_revision, 3, 'stack sync keeps rejected-review context');
    assert.equal(rework.detail.revision, revision);
    assert.equal(taskChurn(), 0, 'stack retries must retain the acceptance reset');
    assert.equal(item(), undefined);
    const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
    assert.doesNotMatch(page, /review churn: 3/);
    assert.match(page, /review churn: 0/);
  }
  assert.equal(h.json(['task', 'show', 'T2']).evidence.filter((e) => e.type === 'review' && !e.ok).length, 3);
  // The conflict sent the parent back too; resubmit it before claiming the child.
  f.write((d) => { d.conflict = false; });
  h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  h.ok(['submit', 'T1', '--sha', f.sha, '--agent', 'worker-T1']);
  h.ok(['claim', 'T2', '--agent', 'worker-T2']);
  h.ok(['submit', 'T2', '--sha', sha, '--agent', 'worker-T2']);
  h.reviewer('T2', 'new-scope-reviewer', sha);
  h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', sha,
    '--agent', 'new-scope-reviewer', '--summary', 'Acceptance item 1: new scope finding']);
  assert.equal(taskChurn(), 1, 'reviews of the new scope still count');
  assert.equal(item(), undefined);
});

test('changing the builder preserves independent reviews of earlier submissions', (t) => {
  const h = setup(t);
  h.ok(['rework', 'T1', '--reason', 'new builder takes the fix']);
  h.ok(['claim', 'T1', '--agent', 'reviewer-1']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'reviewer-1']);
  assert.equal(churn(h).count, 3);
  assert.equal(h.json(['status']).review_churn[0].count, 3);
});

test('a delayed verdict keeps the builder identity from its reviewer dispatch', (t) => {
  const h = setup(t);
  h.ok(['rework', 'T1', '--reason', 'another builder resubmits the same head']);
  h.ok(['claim', 'T1', '--agent', 'reviewer-3']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'reviewer-3']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.sha, '--agent', 'reviewer-3',
    '--summary', 'Acceptance item 2: delayed verdict from the previous dispatch']);
  assert.equal(churn(h).count, 4);
});

test('review policy validates churn threshold through the CLI', (t) => {
  const h = setup(t);
  const { errors } = require('../lib/reviewer');
  for (const value of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(errors({ churn_after: value }).some((s) => s.includes('review.churn_after')), String(value));
  }
  for (const value of [1, 3, Number.MAX_SAFE_INTEGER]) assert.deepEqual(errors({ churn_after: value }), []);
  const bad = h.run(['project', 'set', '--review-policy', '{"churn_after":0}', '--agent', 'orchestrator']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /review.churn_after must be a positive safe integer/);
  assert.equal(h.json(['project', 'show']).review, undefined);
  h.ok(['project', 'set', '--review-policy', '{"churn_after":2}', '--agent', 'orchestrator']);
  assert.equal(churn(h).churn_after, 2);
});

test('churn compares explicit scope and excludes evidence that cannot stand for review', () => {
  const Churn = require('../lib/review-churn');
  const task = { id: 'T1', revision: 2, acceptance: ['input', 'bounds'], submitted_by: 'builder', evidence: [] };
  const entry = (summary, extra = {}) => ({ type: 'review', ok: false, revision: 2, agent: 'owner', summary, ...extra });
  task.evidence = [
    entry('old scope', { revision: 1 }), entry('passed', { ok: true }), entry('note', { type: 'note' }),
    entry('self', { agent: 'builder' }), entry('unspawned', { agent: 'imposter' }), entry('waived', { waived: true }),
    entry('lib/input.js:10 - null check'), entry('lib/input.js:10 - still missing'),
    entry('lib/bounds.js:20 - new condition'), entry('Unstructured finding'), entry('Acceptance line 99: invalid'),
  ];
  const result = Churn.history(task, [], {});
  assert.equal(result.count, 5);
  assert.deepEqual(result.reviews.map((r) => r.scope_change),
    ['first', 'same_finding_locations', 'added_finding_locations', 'unknown', 'unknown']);
  assert.deepEqual(result.reviews[2].new_finding_locations, ['lib/bounds.js:20']);
  assert.equal(Churn.count(task, []), 5);
});
