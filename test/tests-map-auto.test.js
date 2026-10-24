'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const SUITE = 'test/value.test.js';

function setup(t) {
  const h = cachedFixture(t, 'automatic-map', (seed) => {
    gateFixture(seed);
    seed.init(['--repo', 'acme/demo', '--base', 'main']);
    seed.env.HOOK_CLOCK_FILE = path.join(seed.base, 'clock');
    fs.writeFileSync(seed.env.HOOK_CLOCK_FILE, String(Date.now()));
    seed.env.TC_MAP_GITHUB = path.join(seed.base, 'github.json');
    fs.writeFileSync(path.join(seed.base, 'tools', 'gh'),
      `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures', 'tests-map-gh.js'))});\n`);
    seed.ok(['project', 'set', '--tests-map', JSON.stringify({ '**/*.md': [], 'data.json': [SUITE], 'gone.js': [SUITE] })]);
    const file = path.join(seed.base, 'map.json');
    fs.writeFileSync(file, JSON.stringify({ sha: BASE, tests: [SUITE], map: { 'old.js': [SUITE] } }));
    seed.ok(['tests', 'map', 'refresh', '--file', file]);
  });
  h.now = () => Number(fs.readFileSync(h.env.HOOK_CLOCK_FILE, 'utf8'));
  h.advance = (ms) => fs.writeFileSync(h.env.HOOK_CLOCK_FILE, String(h.now() + ms));
  h.github = () => JSON.parse(fs.readFileSync(h.env.TC_MAP_GITHUB, 'utf8'));
  h.save = (data) => fs.writeFileSync(h.env.TC_MAP_GITHUB, JSON.stringify(data));
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.refreshes = () => h.logs().filter((e) => e.cmd === 'tests map refresh');
  h.pass = (inbox = false) => {
    const args = ['wait', '--after', '0', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator']; // wait-allow: one bounded automation pass, with no runnable tasks
    if (inbox) args.push('--inbox', '--observe');
    const r = h.run(args);
    assert.equal(r.code, 2, r.stderr);
    return r;
  };
  h.runData = (patch = {}) => ({ id: 42, workflow_id: 1, run_number: 42, name: 'CI', event: 'schedule',
    status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: HEAD,
    created_at: new Date(h.now()).toISOString(), ...patch });
  h.save({ calls: [], runs: [h.runData()], comparison: 'ahead',
    artifacts: [{ name: 'tests-coverage-map', expired: false }],
    artifact: { sha: HEAD, tests: [SUITE], map: { 'new.js': [SUITE] } } });
  return h;
}

test('automation refreshes green scheduled and manual coverage once, preserving declared entries', (t) => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const h = setup(t);
    h.save({ ...h.github(), runs: [h.runData({ event })] });
    const pass = h.pass();
    assert.deepEqual(h.readState('project.json').tests.map, {
      '**/*.md': [], 'data.json': [SUITE], 'new.js': [SUITE],
    }, JSON.stringify({ stderr: pass.stderr, calls: h.github().calls }));
    const refresh = h.refreshes().at(-1);
    assert.deepEqual([refresh.detail.run, refresh.detail.sha, refresh.detail.automatic, refresh.agent], [42, HEAD, true, 'orchestrator']);
    const calls = h.github().calls;
    h.pass();
    assert.deepEqual(h.github().calls, calls, 'a second wait reuses the hourly receipt');
    h.advance(HOUR);
    h.pass();
    assert.equal(h.refreshes().length, 2, 'the same run never refreshes twice');
    assert.equal(h.github().calls.filter((a) => a[0] === 'run').length, 1);
    assert.match(h.ok(['status']), /tests.map from run 42 at bbbbbbbbbb, 1h old/);
    assert.deepEqual(h.json(['status']).tests_map, { run: 42, sha: HEAD,
      at: refresh.detail.built_at, age_ms: HOUR, stale: false });
  }
});

test('automation rejects red, incomplete, older, divergent and missing coverage runs', (t) => {
  for (const [name, patch] of [
    ['red', { run: { conclusion: 'failure' } }],
    ['incomplete', { run: { status: 'in_progress', conclusion: null } }],
    ['push', { run: { event: 'push' } }],
    ['other branch', { run: { head_branch: 'feature' } }],
    ['same sha', { run: { head_sha: BASE } }],
    ['older sha', { comparison: 'behind' }],
    ['divergent sha', { comparison: 'diverged' }],
    ['missing artifact', { artifacts: [] }],
    ['expired artifact', { artifacts: [{ name: 'tests-coverage-map', expired: true }] }],
    ['wrong artifact sha', { artifact: { sha: BASE, tests: [SUITE], map: { 'new.js': [SUITE] } } }],
  ]) {
    const h = setup(t);
    const before = h.readState('project.json');
    const { run, ...settings } = patch;
    h.save({ ...h.github(), ...settings, runs: [h.runData(run)] });
    h.pass();
    assert.deepEqual(h.readState('project.json'), before, name);
    assert.equal(h.refreshes().length, 1, name);
    const calls = h.github().calls;
    h.pass();
    assert.deepEqual(h.github().calls, calls, `${name}: retries are hourly`);
  }
});

test('failed polls are hourly and a newer run cannot roll back an already-used run', (t) => {
  const h = setup(t);
  h.save({ ...h.github(), fail: true });
  assert.match(h.pass().stderr, /GitHub unavailable/);
  h.advance(HOUR - 1);
  h.pass();
  assert.equal(h.github().calls.length, 1);
  h.advance(1);
  h.save({ ...h.github(), fail: false });
  h.pass();
  assert.equal(h.refreshes().at(-1).detail.run, 42);
  h.advance(HOUR);
  h.save({ ...h.github(), runs: [h.runData({ id: 41, head_sha: 'c'.repeat(40) })] });
  const downloads = h.github().calls.filter((a) => a[0] === 'run').length;
  h.pass();
  assert.equal(h.refreshes().length, 2);
  assert.equal(h.github().calls.filter((a) => a[0] === 'run').length, downloads);
});

for (const [name, receipt, correction, candidate, ignored] of [
  ['changed map after automatic refresh', 'automatic', 'changed', {}, true],
  ['unchanged map after automatic refresh', 'automatic', 'unchanged', {}, true],
  ['cleared and restored map', 'automatic', 'clear', {}, true],
  ['file pin after automatic refresh', 'automatic', 'file', {}, true],
  ['changed map after manual run refresh', 'manual', 'changed', {}, true],
  ['older unused run after a correction', 'automatic', 'changed', { id: 41, head_sha: 'c'.repeat(40) }, true],
  ['same-SHA new run after a correction', 'automatic', 'changed', { id: 43 }, true],
  ['earlier used run after a newer receipt', 'history', 'changed', {}, true],
  ['new run after a correction', 'automatic', 'changed', { id: 43, head_sha: 'c'.repeat(40) }, false],
]) {
  test(`coverage refresh history survives ${name}`, (t) => {
    const h = setup(t);
    if (receipt === 'manual') h.ok(['tests', 'map', 'refresh', '--from-run', '42']);
    else h.pass();
    if (receipt === 'history') {
      h.save({ ...h.github(), artifact: { sha: 'c'.repeat(40), tests: [SUITE], map: { 'new.js': [SUITE] } } });
      h.ok(['tests', 'map', 'refresh', '--from-run', '43']);
    }
    const manual = correction === 'unchanged' ? h.readState('project.json').tests.map
      : { '**/*.md': [], 'data.json': [SUITE], 'new.js': ['test/other.test.js'] };
    if (correction === 'file') {
      const file = path.join(h.base, 'correction.json');
      fs.writeFileSync(file, JSON.stringify({ sha: BASE, tests: ['test/other.test.js'], map: { 'new.js': ['test/other.test.js'] } }));
      h.ok(['tests', 'map', 'refresh', '--file', file]);
    } else {
      if (correction === 'clear') {
        h.ok(['project', 'set', '--tests-map', 'null']);
        h.advance(HOUR);
        const calls = h.github().calls.length;
        h.pass();
        assert.equal(h.github().calls.length, calls, 'clearing the map stops polling');
      }
      h.ok(['project', 'set', '--tests-map', JSON.stringify(manual)]);
    }
    const run = h.runData(candidate);
    h.save({ ...h.github(), runs: [run], artifact: { sha: run.head_sha, tests: [SUITE], map: { 'new.js': [SUITE] } } });
    const refreshes = h.refreshes().length;
    const downloads = h.github().calls.filter((a) => a[0] === 'run').length;
    h.advance(HOUR);
    h.pass();
    assert.deepEqual(h.readState('project.json').tests.map,
      ignored ? manual : { '**/*.md': [], 'data.json': [SUITE], 'new.js': [SUITE] });
    assert.equal(h.refreshes().length, refreshes + (ignored ? 0 : 1));
    assert.equal(h.github().calls.filter((a) => a[0] === 'run').length, downloads + (ignored ? 0 : 1));
    h.advance(HOUR);
    h.pass();
    assert.equal(h.refreshes().length, refreshes + (ignored ? 0 : 1), 'later polls never reuse the run');
  });
}

test('concurrent wait hosts reserve only one coverage poll', async (t) => {
  const h = setup(t);
  const args = ['wait', '--after', '0', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator']; // wait-allow: two bounded host passes exercise the shared reservation
  const passes = await Promise.all([h.runAsync(args), h.runAsync(args)]);
  for (const pass of passes) assert.equal(pass.code, 2, pass.stderr);
  assert.equal(h.github().calls.filter((a) => a[1]?.includes('/actions/runs?')).length, 1);
  assert.equal(h.refreshes().length, 2);
});

for (const [name, delay, reserved, polls] of [
  ['a newer host reservation', 2, 1, 0],
  ['an equal-time host reservation', 2, 2, 0],
  ['a reservation expiring during the wait', HOUR + 2, 0, 1],
  ['no competing host after a delay', 2, null, 1],
]) {
  test(`locked coverage polling uses current time with ${name}`, (t) => {
    const h = setup(t);
    h.save({ ...h.github(), runs: [] });
    const start = h.now();
    h.env.TC_MAP_POLL_DELAY = JSON.stringify({ now: start + delay,
      read_at: reserved == null ? null : new Date(start + reserved).toISOString() });
    h.env.NODE_OPTIONS += ` --require=${JSON.stringify(path.join(__dirname, 'fixtures', 'tests-map-poll-delay.js'))}`;
    h.pass();
    assert.equal(h.github().calls.filter((a) => a[1]?.includes('/actions/runs?')).length, polls);
    const receipt = h.readState('tests-map-cache.json');
    assert.equal(Date.parse(receipt.read_at), start + (polls ? delay : reserved));
    delete h.env.TC_MAP_POLL_DELAY;
    fs.writeFileSync(h.env.HOOK_CLOCK_FILE, String(Date.parse(receipt.read_at) + HOUR - 1));
    h.pass();
    assert.equal(h.github().calls.length, polls, 'the locked reservation owns the full hourly interval');
  });
}

for (const [name, offset] of [['the current reservation', 0], ['a newer host reservation', HOUR]]) {
  test(`a failed coverage read preserves ${name}`, (t) => {
    const h = setup(t);
    const receipt = { repo: 'acme/demo', base: 'main', read_at: new Date(h.now() + offset).toISOString() };
    h.save({ ...h.github(), fail: true,
      supersedingPoll: { file: path.join(h.state, 'tests-map-cache.json'), receipt } });
    assert.match(h.pass().stderr, /GitHub unavailable/);
    const cached = h.readState('tests-map-cache.json');
    assert.equal(cached.read_at, receipt.read_at);
    assert.equal(Object.hasOwn(cached, 'error'), offset === 0, 'a failed read belongs only to its own reservation');
    h.advance(HOUR - 1);
    h.pass();
    assert.equal(h.github().calls.length, 1, 'a delayed failure cannot reopen the hourly interval');
  });
}

for (const [name, offset] of [['the current reservation', 0], ['a newer host reservation', HOUR]]) {
  test(`a delayed failed poll publishes a complete clock and ${name}`, (t) => {
    const h = setup(t);
    const polledAt = h.now() + 2;
    const receipt = { repo: 'acme/demo', base: 'main', read_at: new Date(polledAt + offset).toISOString() };
    h.env.TC_MAP_POLL_DELAY = JSON.stringify({ now: polledAt });
    h.env.NODE_OPTIONS += ` --require=${JSON.stringify(path.join(__dirname, 'fixtures', 'tests-map-poll-delay.js'))}`;
    h.save({ ...h.github(), fail: true,
      supersedingPoll: { file: path.join(h.state, 'tests-map-cache.json'), receipt } });

    assert.match(h.pass().stderr, /GitHub unavailable/);
    const cached = h.readState('tests-map-cache.json');
    assert.deepEqual({ repo: cached.repo, base: cached.base, read_at: cached.read_at }, receipt);
    assert.equal(Object.hasOwn(cached, 'error'), offset === 0);
    assert.equal(h.now(), polledAt + offset, 'the clock published by both fixtures is complete');
    const calls = h.github().calls;
    assert.equal(calls.length, 1, 'the shared mock keeps the failed request');
    assert.match(calls[0][1], /\/actions\/runs\?/);

    delete h.env.TC_MAP_POLL_DELAY;
    h.advance(HOUR - 1);
    h.pass();
    assert.deepEqual(h.github().calls, calls, 'the published receipt keeps the full hourly retry interval');
  });
}

test('a coverage map past three days has one offline inbox item and one notification until refreshed', (t) => {
  const h = setup(t);
  h.save({ ...h.github(), runs: [] });
  h.advance(3 * DAY);
  assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).items.filter((i) => i.kind === 'tests_map_stale'), []);
  h.advance(1);
  const stale = () => h.json(['inbox', '--agent', 'orchestrator']).items.filter((i) => i.kind === 'tests_map_stale');
  assert.equal(stale().length, 1);
  assert.equal(h.github().calls.length, 0, 'foreground status and inbox stay offline');
  h.pass(true);
  h.advance(HOUR);
  h.pass(true);
  assert.equal(stale().length, 1);
  assert.equal(h.logs().filter((e) => e.cmd === 'inbox item' && e.detail.item === 'tests_map_stale:project').length, 1);
  h.advance(HOUR);
  h.save({ ...h.github(), runs: [h.runData()] });
  h.pass();
  h.pass(true);
  assert.deepEqual(stale(), []);
  assert.equal(h.json(['status']).tests_map.stale, false);
});
