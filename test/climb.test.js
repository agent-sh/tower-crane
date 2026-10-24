'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { cachedFixture } = require('./helpers');
const Climb = require('../lib/climb');

function setup(t) {
  return cachedFixture(t, 'climb', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Retry handling', '--acceptance', 'Retries work']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Implement retry handling.\n' });
  });
}

const rung = (h) => h.json(['spawn', '--task', 'T1', '--dry-run']).rung;
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const tier = (h) => h.json(['task', 'show', 'T1']).tier;

function reviewFail(h, digit, file) {
  const sha = digit.repeat(40);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha,
    '--revision', h.revision(), '--summary', `1 blocking finding: ${file}:12 - Duplicate delivery`]);
  h.ok(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
}

function conflict(h, digit) {
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', digit.repeat(40), '--agent', 'worker']);
  h.ok(['rework', 'T1', '--reason', `merge conflict with main at ${digit.repeat(7)}`, '--agent', 'orchestrator']);
}

test('an urgent medium task dispatches on hard unless a recorded reason keeps it lower', (t) => {
  const h = setup(t);
  assert.equal(tier(h), 'medium');
  h.ok(['task', 'update', 'T1', '--priority', 'urgent', '--agent', 'orchestrator']);
  assert.equal(tier(h), 'hard');
  assert.equal(rung(h), 'hard');
  const status = h.json(['status']);
  assert.deepEqual(status.climbs.map(({ id, from, to, reason }) => ({ id, from, to, reason })),
    [{ id: 'T1', from: 'medium', to: 'hard', reason: 'urgent' }]);
  assert.match(h.ok(['status']), /climbed: T1 medium -> hard \(urgent\)/);

  const refused = h.run(['task', 'update', 'T1', '--tier', 'medium', '--agent', 'orchestrator']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /T1 is urgent, so it runs on hard; pass --tier-reason/);
  h.ok(['task', 'update', 'T1', '--tier', 'medium', '--tier-reason', 'one-line config fix', '--agent', 'orchestrator']);
  assert.equal(rung(h), 'medium');
  assert.deepEqual(h.json(['status']).climbs, []);
  // A reason recorded before the task turned urgent keeps its tier as well.
  h.ok(['task', 'update', 'T1', '--priority', 'normal', '--agent', 'orchestrator']);
  h.ok(['task', 'update', 'T1', '--priority', 'urgent', '--agent', 'orchestrator']);
  assert.equal(rung(h), 'medium');
  assert.equal(h.run(['task', 'update', 'T1', '--tier-reason', 'no tier', '--agent', 'orchestrator']).code, 2);
});

test('two review FAILs at medium put the next attempt on hard, and task update --tier overrides it', (t) => {
  const h = setup(t);
  reviewFail(h, 'a', 'lib/retry.js');
  assert.equal(rung(h), 'medium', 'one rework does not climb');
  reviewFail(h, 'b', 'lib/queue.js');
  assert.equal(tier(h), 'hard');
  assert.equal(rung(h), 'hard');
  const climb = events(h).filter((e) => e.task === 'T1' && e.cmd === 'climb');
  assert.equal(climb.length, 1);
  assert.equal(climb[0].detail.from, 'medium');
  assert.equal(climb[0].detail.to, 'hard');
  assert.deepEqual(climb[0].detail.reworks, [2, 3]);
  assert.match(h.ok(['status']), /climbed: T1 medium -> hard \(2 reworks from its own work at medium\)/);

  h.ok(['task', 'update', 'T1', '--tier', 'medium', '--agent', 'orchestrator']);
  assert.equal(rung(h), 'medium');
  assert.deepEqual(h.json(['status']).climbs, []);
  // The override starts the count again at the rung it set.
  reviewFail(h, 'c', 'lib/store.js');
  assert.equal(rung(h), 'medium');
});

test('two conflict reworks at medium do not climb', (t) => {
  const h = setup(t);
  conflict(h, 'a');
  conflict(h, 'b');
  assert.equal(rung(h), 'medium');
  assert.deepEqual(h.json(['status']).climbs, []);
  // Nor do they add to a later review FAIL's count.
  reviewFail(h, 'c', 'lib/retry.js');
  assert.equal(rung(h), 'medium');
});

test('only a failed review or a failed tests, clean or ci gate main does not share is the task\'s own work', () => {
  const rows = [
    ['review FAIL', null, true, true],
    ['tests failure', { type: 'tests', ok: false }, false, true],
    ['host probe failure in the tests gate', { type: 'tests', ok: false, host_probes: [{ ok: false }] }, false, true],
    ['clean failure', { type: 'clean', ok: false }, false, true],
    ['ci failure', { type: 'ci', ok: false }, false, true],
    ['tests failure main shares', { type: 'tests', ok: false, main_failure: { base: 'abc' } }, false, false],
    ['ci failure main shares', { type: 'ci', ok: false, main_failure: { base: 'abc' } }, false, false],
    ['merge conflict', { type: 'merge', ok: false }, false, false],
    ['sources failure', { type: 'sources', ok: false }, false, false],
    ['passing gate', { type: 'tests', ok: true }, false, false],
    ['manual, conflict or stack sync rework', null, false, false],
  ];
  for (const [name, failed, fromReview, own] of rows) assert.equal(Climb.ownWork(failed, fromReview), own, name);
});
