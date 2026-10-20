'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { runaways } = require('../lib/runaway');

const now = Date.now();
const entry = (agent, tokens, extra = {}) => ({ agent, tokens, input: tokens, cached: tokens * 0.96, output: 0, ...extra });
const done = (id, size, tokens, tier = 'hard') => ({ id, size, tier, status: 'accepted', spend: { tokens, minutes: 20 } });
function state(history, entries, extra = {}) {
  const task = {
    id: 'T267', title: 'Large task', tier: 'hard', size: 'L', status: 'in_progress',
    claim: { agent: 'worker-6', since: new Date(now - 60000).toISOString(), until: new Date(now + 60000).toISOString() },
    spend: { tokens: entries.reduce((n, e) => n + (e.tokens || 0), 0), entries }, ...extra,
  };
  return { tasks: { tasks: [...history, task] }, events: [] };
}

test('spend medians select tier and size, then explicitly fall back to tier or project', () => {
  const variants = [
    { name: 'three L samples', history: [done('T1', 'L', 10e6), done('T2', 'L', 20e6), done('T3', 'L', 30e6), ...[4, 5, 6, 7].map((i) => done(`T${i}`, 'S', 1e6))], median: 20e6, from: 'tier-size', text: /the hard L median of 20M/ },
    { name: 'two L samples use tier', history: [done('T1', 'L', 10e6), done('T2', 'L', 20e6), done('T3', 'S', 1e6)], median: 10e6, from: 'tier', text: /the hard median of 10M .*hard L has 2 accepted tasks with tokens/ },
    { name: 'short tier uses project', history: [done('T1', 'L', 10e6), done('T2', 'S', 1e6, 'easy'), done('T3', 'M', 2e6, 'easy')], median: 2e6, from: 'project', text: /the project median of 2M .*hard L has 1 accepted task with tokens/ },
  ];
  for (const v of variants) {
    const result = runaways(state(v.history, [entry('worker-6', 200e6)]), now);
    assert.equal(result.norms.sizes.hard.L.median, v.median, v.name);
    assert.equal(result.norms.sizes.hard.L.from, v.from, v.name);
    assert.match(result.flags.find((f) => f.rule === 'spend').text, v.text, v.name);
  }
});

test('task totals and worker spend stay separate across workers and usage routes', () => {
  const history = [1, 2, 3].map((i) => done(`T${i}`, 'L', 33e6));
  const entries = [entry('worker-4', 272e6), entry('worker-5', 123.15e6), entry('worker-6', 1.25e6)];
  const st = state(history, entries);
  st.events = [1, 2, 3, 4, 5, 6].map((i) => ({ cmd: 'spawn', task: 'T267', detail: { agent: `worker-${i}`, role: 'worker' } }));
  const flags = runaways(st, now).flags;
  assert.deepEqual(flags.map((f) => [f.rule, f.agent]), [['spend', null]]);
  assert.match(flags[0].text, /T267 has spent 396\.4M tokens over 6 workers \(current worker-6: 1\.3M tokens\)/);
  assert.match(flags[0].text, /96% cached, 15\.9M uncached tokens/);
  for (const variant of [
    [entry('worker-6', 272e6)],
    [entry('worker-6', 200e6, { source: 'spawn:worker-6' }), entry('worker-6', 72e6, { source: 'spawn:worker-6:route:1' })],
  ]) {
    const result = runaways(state(history, variant), now).flags;
    const worker = result.find((f) => f.rule === 'worker-spend');
    assert.equal(worker.agent, 'worker-6');
    assert.equal(worker.value, 272e6);
    assert.match(worker.text, /worker-6 has spent 272M tokens.*96% cached, 10\.9M uncached tokens/);
  }
});

test('cache text distinguishes measured zero, unknown and partially reported breakdowns', () => {
  const history = [1, 2, 3].map((i) => done(`T${i}`, 'L', 1e6));
  for (const [entries, expected] of [
    [[entry('worker-6', 10e6, { input: 8e6, cached: 6e6, output: 2e6 })], /60% cached, 4M uncached tokens/],
    [[entry('worker-6', 10e6, { cached: 0 })], /0% cached, 10M uncached tokens/],
    [[entry('worker-6', 10e6, { cached: null })], /cached share unknown, uncached tokens unknown/],
    [[entry('worker-6', 9e6), entry('worker-6', 1e6, { input: null, cached: null, output: null })], /cached share unknown, uncached tokens unknown/],
    [[entry('worker-6', 10e6), { agent: 'worker-6', tokens: null, minutes: 5, source: 'manual' }], /96% cached, 0\.4M uncached tokens/],
  ]) {
    for (const f of runaways(state(history, entries), now).flags) assert.match(f.text, expected);
  }
});

test('worker alarms exclude reviewer spend, respect the threshold, and require a live claim', () => {
  const history = [1, 2, 3].map((i) => done(`T${i}`, 'L', 1e6));
  const st = state(history, [entry('reviewer', 10e6, { rung: 'review' }), entry('worker-6', 5.5e6)]);
  assert.deepEqual(runaways(st, now).flags.map((f) => f.rule), ['spend']);
  assert.match(runaways(st, now).flags[0].text, /over 1 worker \(current worker-6: 5\.5M tokens\)/);
  for (const extra of [{ status: 'accepted' }, { claim: null }]) {
    assert.deepEqual(runaways(state(history, [entry('worker-6', 10e6)], extra), now).flags, []);
  }
  assert.deepEqual(runaways(state([], [entry('worker-6', 10e6)]), now).flags, []);
});

test('CLI status and board identify a multi-worker task and its current worker with the same size median', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = h.git(['rev-parse', 'HEAD']);
  for (const [i, size] of ['L', 'L', 'L', 'S', 'S', 'S'].entries()) {
    const id = h.ok(['task', 'add', '--title', `Done ${i}`, '--size', size, '--tier', 'hard', '--acceptance', 'done', '--kind', 'docs']).match(/T\d+/)[0];
    const agent = `w-${i}`;
    h.ok(['claim', id, '--agent', agent]);
    h.ok(['spend', id, '--tokens', size === 'L' ? '10000000' : '1000000', '--agent', agent]);
    h.ok(['submit', id, '--sha', sha, '--agent', agent]);
    h.reviewer(id, `r-${i}`, sha);
    h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', sha, '--agent', `r-${i}`]);
    h.ok(['accept', id]);
  }
  h.ok(['task', 'add', '--title', 'Multi-worker', '--size', 'L', '--tier', 'hard', '--acceptance', 'done']);
  h.ok(['claim', 'T7', '--agent', 'old-worker']);
  h.ok(['spend', 'T7', '--tokens', '58000000', '--input', '58000000', '--cached', '55680000', '--output', '0', '--agent', 'old-worker']);
  h.ok(['release', 'T7', '--reason', 'handoff', '--agent', 'old-worker']);
  h.ok(['claim', 'T7', '--agent', 'current-worker']);
  h.ok(['spend', 'T7', '--tokens', '2000000', '--input', '2000000', '--cached', '1920000', '--output', '0', '--agent', 'current-worker']);
  const flags = h.json(['status']).runaways;
  assert.deepEqual(flags.map((f) => [f.rule, f.agent]), [['spend', null]]);
  const text = h.ok(['status']);
  assert.match(text, /runaway: T7: T7 has spent 60M tokens over 2 workers \(current current-worker: 2M tokens\)/);
  assert.match(text, /96% cached, 2\.4M uncached tokens.*the hard L median of 10M/);
  const page = () => fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const item = page().match(/data-key="runaway-T7-spend">[\s\S]*?<\/li>/)[0];
  assert.match(item, /T7 has spent 60M tokens over 2 workers/);
  assert.doesNotMatch(item, /<span>current-worker<\/span>|current-worker T7 has spent/);
  assert.match(page(), /data-key="top-T7">[\s\S]*?the hard L median of 10M/);
  h.ok(['spend', 'T7', '--tokens', '58000000', '--input', '58000000', '--cached', '55680000', '--output', '0', '--agent', 'current-worker']);
  assert.match(h.ok(['status']), /runaway: T7 current-worker: current-worker has spent 60M tokens/);
  assert.match(page(), /data-key="runaway-T7-worker-spend">[\s\S]*?Worker spend on[\s\S]*?current-worker has spent 60M tokens/);
});
