'use strict';

// A manual merge racing the merge queue or an automatic merge: one merges and
// the other confirms, over many rounds.

const { stateEventLogged } = require('./signals');
const StateFiles = require('./state-files');
const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gateFixture } = require('./gate-helpers');
const { log, setup, child, event } = require('./events-helpers');

// Most of each race is waiting on the other side's jittered state calls, and
// each test races in a fixture of its own, so three run side by side.
describe('merge races', { concurrency: 3 }, () => {
// Five rounds took 235 to over 300 s on hosted Windows with three races side by
// side, at the 300 s hung-test timeout (runs 40099757929 to 40114715070), so the
// ten rounds run as five tests of two; the ten cover every stagger twice.
const PASSES = 5;
for (let pass = 1; pass <= PASSES; pass++) test(`a manual merge racing the merge queue under another task's reaction: one merges, the other confirms (pass ${pass} of ${PASSES})`, async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
  h.env.FIXTURE_MERGED_PER_PR = '1';
  const rounds = 2;
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(Array.from({ length: rounds * 2 - 1 }, (_, i) => ({ title: `Change ${i + 2}`, acceptance: ['works'] }))) });
  for (let i = 1; i <= rounds; i++) {
    // The lower task's reaction drains the line, so the queue merges the
    // upper task while holding only the lower task's reaction reservation.
    const [lower, upper] = [`T${i * 2 - 1}`, `T${i * 2}`];
    for (const [n, id] of [[i * 2 - 1, lower], [i * 2, upper]]) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--agent', 'worker', '--sha', h.sha, '--pr', String(n)]);
      h.ok(['accept', id, '--agent', 'owner', '--reason', 'race fixture',
        ...['tests', 'clean', 'review', 'ci'].flatMap((type) => ['--waive', type])]);
    }
    const after = String(StateFiles.logEnd(h.state));
    // State call jitter spreads the two merges over each other's checks.
    const jitter = { HOOK_JITTER_MS: '15' };
    const automatic = child(t, h, ['wait', '--agent', 'orchestrator', '--after', after, '--task', upper, '--types', 'merged', '--timeout', '300'], jitter);
    // Start near the queue's move from the lower task to the upper one.
    await stateEventLogged(h.state, (event) => event.type === 'merged' && event.task === lower, { signal: t.signal });
    await new Promise((resolve) => setTimeout(resolve, (((pass - 1) * rounds + i) % 5) * 120)); // wait-allow: stagger concurrent operations to exercise both race orderings
    const manual = await h.runAsync(['merge', upper], { hooks: jitter });
    assert.equal(manual.code, 0, `${upper}: ${manual.stderr}`);
    await event(automatic, 'merged', upper);
    const stops = log(h).filter((e) => (e.cmd === 'merge queue' && (e.detail.blocked || e.detail.error))
      || (e.cmd === 'automation' && [lower, upper].includes(e.task) && !['running', 'done'].includes(e.detail.phase)));
    assert.deepEqual(stops, [], `${upper}: the queue never stops on the manual merge`);
    const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    for (const [n, id] of [[i * 2 - 1, lower], [i * 2, upper]]) {
      assert.equal(calls.filter((a) => a[0] === 'pr' && a[1] === 'merge' && a[2] === String(n)).length, 1, `${id}: GitHub merged once`);
    }
    const merges = h.readState('tasks.json').tasks.find((x) => x.id === upper).evidence.filter((e) => e.type === 'merge');
    assert.equal(merges.length, 1, `${upper}: one merge receipt`);
    assert.equal(merges[0].ok, true);
    assert.equal(log(h).filter((e) => e.task === upper && e.type === 'merged').length, 1, `${upper}: one merged event`);
  }
});

// Thirty rounds of the same race, as three tests of ten for the same reason; each covers every stagger.
for (const part of [1, 2, 3]) test(`a manual merge racing an automatic merge of the same task: one merges, the other confirms, rounds ${part * 10 - 9} to ${part * 10} of 30`, async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
  const winners = { automation: 0, manual: 0 };
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ title: `Change ${i + 2}`, acceptance: ['works'] }))) });
  for (let i = 1; i <= 10; i++) {
    const round = (part - 1) * 10 + i;
    const id = `T${i}`;
    h.env.FIXTURE_MERGED = path.join(h.base, `merged-${i}`);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--agent', 'worker', '--sha', h.sha, '--pr', String(i)]);
    h.ok(['accept', id, '--agent', 'owner', '--reason', 'race fixture',
      ...['tests', 'clean', 'review', 'ci'].flatMap((type) => ['--waive', type])]);
    // The waiter's startup reconciliation merges the accepted task while the
    // manual merge starts, so both reach the merge gate together. The cursor
    // keeps a manual merge that finishes before the waiter starts visible.
    // Odd rounds start together; even rounds stagger the manual merge, so
    // either side reaches GitHub first.
    const after = String(StateFiles.logEnd(h.state));
    const automatic = child(t, h, ['wait', '--agent', 'orchestrator', '--after', after, '--task', id, '--types', 'merged', '--timeout', '300']);
    await new Promise((resolve) => setTimeout(resolve, round % 2 ? 0 : (round % 10) * 20)); // wait-allow: stagger concurrent operations to exercise both race orderings
    const manual = await h.runAsync(['merge', id]);
    assert.equal(manual.code, 0, `${id}: ${manual.stderr}`);
    const woke = await event(automatic, 'merged', id);
    assert.equal(woke.detail.ref, h.sha);
    const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter((a) => a[0] === 'pr' && a[1] === 'merge' && a[2] === String(i)).length, 1, `${id}: GitHub merged once`);
    const task = h.readState('tasks.json').tasks.find((x) => x.id === id);
    const merges = task.evidence.filter((e) => e.type === 'merge');
    assert.equal(merges.length, 1, `${id}: one merge receipt`);
    assert.equal(merges[0].ok, true);
    assert.equal(log(h).filter((e) => e.task === id && e.type === 'merged').length, 1, `${id}: one merged event`);
    assert.match(merges[0].summary, /^merged PR/);
    winners[merges[0].via === 'automation' ? 'automation' : 'manual']++;
    const receipts = log(h).filter((e) => e.cmd === 'automation' && e.task === id && e.detail.phase !== 'running');
    assert.deepEqual(receipts.filter((e) => e.detail.phase !== 'done'), [], `${id}: no automatic failure`);
  }
  t.diagnostic(`merged first: automation ${winners.automation}, manual ${winners.manual}`);
});
});
