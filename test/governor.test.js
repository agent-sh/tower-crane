'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const G = require('../lib/governor');
const { makeRepo, cachedFixture, BIN } = require('./helpers');
const { writeHost, GiB } = require('./host');
const { waitOnRepo, killPid } = require('./signals');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); // read-published: the log is only appended
const linuxOnly = process.platform !== 'linux' && 'the governor measures and signals by Linux process start times';

// Readings and registries in memory: the budget arithmetic alone.
function reading({ limit = 10, used = 2, some = 0, full = 0, cpu = 0, load = 0, cores = 8 } = {}) {
  return { levels: [{ name: '/tests.slice', used: used * GiB, limit: limit * GiB }], binding: '/tests.slice',
    pressure: { memory: { some: { avg10: some }, full: { avg10: full } }, cpu: { some: { avg10: cpu } } }, load, cores };
}
const unit = (kind, started, extra = {}) => ({ id: `${kind}-${started}`, kind, started_at: new Date(Date.UTC(2026, 9, 17, 12, started)).toISOString(), expected: 0, measured: 0, ...extra });
const registry = (units = [], others = [], history = []) => ({ units, others, history });
const s = G.settings({});
const need = 1.5 * GiB;

test('the budget admits work only under every defer line, counting growth, other sessions and pressure', () => {
  const now = Date.now();
  const recent = (gib, minutesAgo) => ({ at: new Date(now - minutesAgo * 60000).toISOString(), bytes: gib * GiB });
  const cases = [
    ['room under the line', reading({ used: 2 }), registry(), true],
    ['exactly at the line', reading({ used: 7 }), registry(), true],
    ['past the line', reading({ used: 7.1 }), registry(), false, /tests\.slice has 7\.1 GiB of 10\.0 GiB in use.*8\.6 GiB is over the 85% line \(8\.5 GiB\)/],
    ['admitted units may still grow', reading({ used: 2 }), registry([unit('worker', 1, { expected: 4 * GiB, measured: GiB }), unit('tests', 2, { expected: 4 * GiB, measured: GiB })]), false, /Tower Crane work may grow 6\.0 GiB/],
    ['an owner waiting on its submitted head grows no further', reading({ used: 2 }), registry([unit('worker', 1, { expected: 8 * GiB, measured: GiB, waiting: true })]), true],
    ['other sessions may return to their recent peak', reading({ used: 4 }), registry([], [recent(8, 3)]), false, /other sessions 3\.6 GiB toward their peak of the last 30 minutes/],
    ['a peak\'s claim fades over the window', reading({ used: 4 }), registry([], [recent(8, 25)]), true],
    ['a peak past the window no longer counts', reading({ used: 4 }), registry([], [recent(9, 31)]), true],
    ['memory stall', reading({ some: 10 }), registry(), false, /memory pressure: some avg10 10% is at or over 10%/],
    ['cpu stall', reading({ cpu: 60 }), registry(), false, /cpu pressure: some avg10 60% is at or over 60%/],
    ['load', reading({ load: 16, cores: 8 }), registry(), false, /load: 16 on 8 cores is at or over 16/],
  ];
  for (const [name, r, reg, ok, reason] of cases) {
    const verdict = G.assess(r, reg, s, need, 'worker', now);
    assert.equal(verdict.ok, ok, `${name}: ${verdict.reasons.join('; ')}`);
    if (reason) assert.match(verdict.reasons.join('; '), reason, name);
  }
  const budget = G.assess(reading({ used: 4 }), registry([unit('worker', 1, { expected: 2 * GiB, measured: GiB })], [recent(5, 1)]), s, 0, null, now).budget;
  const round = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]));
  assert.deepEqual(round(budget), round({ level: '/tests.slice', limit: 10 * GiB, used: 4 * GiB, defer_line: 8.5 * GiB, stop_line: 9.5 * GiB,
    tower_crane: GiB, growth: GiB, growth_rule: 'sum', growth_sum: GiB, growth_largest: GiB, growth_ratio: 1, growth_raised_until: null, growth_samples: 0, growth_samples_min: 20,
    others: 3 * GiB, others_room: 2 * GiB * (1 - 1 / 30), need: 0, units: 1, projects: 1 }));
});

test('running units reserve their summed room until enough windows exist, then the share of it sets grew into together', () => {
  const now = Date.UTC(2026, 9, 20, 2, 0);
  const at = new Date(now - 3600000).toISOString();
  const ratios = (...r) => r.map((ratio) => ({ at, ratio }));
  const many = (n, r) => Array.from({ length: n }, () => r);
  const raised = (ratio, minutes) => ({ ratio, at, until: new Date(now + minutes * 60000).toISOString() });
  // Two workers measuring 1 GiB each, expected 3 GiB each: 4 GiB of room, 2 GiB the largest unit's.
  const cases = [
    ['no samples: the sum', [], null, 'sum', 4, 0],
    ['one short of the minimum: the sum', ratios(...many(19, 0.2)), null, 'sum', 4, 19],
    ['the minimum: under 100 samples the largest ratio seen', ratios(...many(19, 0.2), 0.6), null, 'measured', 2.4, 20],
    ['the 99th of 100', ratios(...Array.from({ length: 100 }, (_, i) => (i + 1) / 100)), null, 'measured', 3.96, 100],
    ['never below the largest unit\'s room', ratios(...many(20, 0.2)), null, 'measured', 2, 20],
    ['a ratio past 1 reserves more than the sum', ratios(...many(20, 1.5)), null, 'measured', 6, 20],
    ['a crossed window raises the ratio over the percentile', ratios(...many(20, 0.6)), raised(0.9, 30), 'raised', 3.6, 20],
    ['and over the sum before enough windows exist', ratios(...many(5, 0.6)), raised(1.3, 30), 'raised', 5.2, 5],
    ['a raise lower than the percentile leaves it', ratios(...many(20, 0.6)), raised(0.4, 30), 'measured', 2.4, 20],
    ['an expired raise no longer counts', ratios(...many(20, 0.6)), raised(0.9, -1), 'measured', 2.4, 20],
  ];
  for (const [name, growth, raise, rule, gib, samples] of cases) {
    const reg = { ...registry([unit('worker', 1, { expected: 3 * GiB, measured: GiB }), unit('worker', 2, { expected: 3 * GiB, measured: GiB })]), growth, raised: raise };
    const r = G.reserve(reg, s, now);
    assert.deepEqual([r.rule, Math.round(r.bytes / GiB * 100) / 100, r.samples, r.sum, r.largest], [rule, gib, samples, 4 * GiB, 2 * GiB], name);
    assert.equal(G.assess(reading({ limit: 100 }), reg, s, 0, null, now).budget.growth, r.bytes, `${name}: the budget reserves it`);
  }
  assert.equal(G.reserve({ ...registry([unit('worker', 1, { expected: 3 * GiB })]), growth: ratios(...many(20, 0.2)) }, s, now).bytes, 3 * GiB,
    'a unit admitted a moment ago and not yet measured keeps its whole room');
  assert.deepEqual(G.reserve(registry(), s, now), { sum: 0, largest: 0, ratio: 1, samples: 0, min: 20, rule: 'sum', raised_until: null, bytes: 0 }, 'nothing running reserves nothing');
});

test('a growth window follows its own units on its own level and samples the share of their room they grew into', () => {
  const small = G.settings({ governor: { growth_samples_min: 3 } });
  const t0 = Date.UTC(2026, 9, 20, 2, 0);
  const at = new Date(t0 - 3600000).toISOString();
  const a = unit('worker', 1, { expected: 3 * GiB, measured: GiB });
  const b = unit('worker', 2, { expected: 3 * GiB, measured: GiB });
  const reg = { ...registry([a, b]), windows: [], growth: [0.25, 0.25, 0.25].map((ratio) => ({ at, ratio })), raised: null };
  assert.deepEqual(G.observe(reg, reading({ limit: 36, used: 15 }), small, t0), []);
  assert.equal(reg.windows.length, 1, 'a window opens with the running units');
  const w0 = reg.windows[0];
  assert.deepEqual([w0.rule, w0.sum, w0.largest, w0.reserved, w0.reserved_ratio, w0.used, w0.base], ['measured', 4 * GiB, 2 * GiB, 2 * GiB, 0.25, 15 * GiB, 2 * GiB]);
  // The set grows by 1.5 GiB together; a unit admitted after the window opened is not part of it.
  a.measured = 1.5 * GiB;
  b.measured = 2 * GiB;
  reg.units.push(unit('tests', 3, { expected: 2 * GiB, measured: 5 * GiB }));
  G.observe(reg, reading({ limit: 36, used: 22 }), small, t0 + 30000);
  assert.equal(reg.windows.length, 1, 'the next window opens a minute after the last');
  assert.deepEqual([reg.windows[0].total, reg.windows[0].grew], [3.5 * GiB, 1.5 * GiB]);
  // The host binds for a moment: the window keeps reading the level it opened on.
  const flipped = { ...reading({ limit: 36, used: 20 }), binding: 'host' };
  flipped.levels = [...flipped.levels, { name: 'host', used: 50 * GiB, limit: 64 * GiB }];
  G.observe(reg, flipped, small, t0 + 45000);
  assert.equal(reg.windows[0].slice_peak, 22 * GiB, 'another level\'s use is not the window\'s peak');
  // A unit that ended gave its memory back; the window keeps the most the set reached.
  reg.units = reg.units.filter((u) => u !== a);
  G.observe(reg, reading({ limit: 36, used: 18 }), small, t0 + 60000);
  assert.equal(reg.windows.length, 2, 'a second window opens each minute');
  const closed = G.observe(reg, reading({ limit: 36, used: 18 }), small, t0 + 60 * 60000);
  assert.equal(closed.length, 1, 'the first window closes after growth_window_min');
  const w = closed[0];
  assert.deepEqual([w.total, w.ratio, w.predicted, w.actual, w.slice_peak, w.crossed], [3.5 * GiB, 0.375, 17 * GiB, 16.5 * GiB, 22 * GiB, false]);
  assert.deepEqual(reg.growth.map((g) => g.ratio), [0.25, 0.25, 0.25, 0.375], 'its ratio is a sample');
  assert.equal(reg.raised, null, 'a window within its reservation raises nothing');
  reg.units = [];
  assert.equal(reg.windows.length, 2, 'the closing tick opened the next minute\'s window');
  assert.equal(G.observe(reg, reading({ limit: 36, used: 3 }), small, t0 + 61 * 60000).length, 2, 'windows whose units all ended close');
  assert.deepEqual(reg.windows, [], 'nothing running opens no window');
  // A set with no room left has no ratio to sample.
  const full = { ...registry([unit('worker', 6, { expected: GiB, measured: 2 * GiB })]), windows: [], growth: [], raised: null };
  G.observe(full, reading({ limit: 36, used: 15 }), small, t0);
  full.units[0].measured = 3 * GiB;
  const [none] = G.observe(full, reading({ limit: 36, used: 16 }), small, t0 + 60 * 60000);
  assert.deepEqual([none.sum, none.ratio, none.crossed, full.growth, full.raised], [0, null, true, [], null]);
});

test('a window whose set grew past its reservation raises the next reservation for the same room, whatever rule was in force', () => {
  const small = G.settings({ governor: { growth_samples_min: 3 } });
  const t0 = Date.UTC(2026, 9, 20, 2, 0);
  const at = new Date(t0 - 3600000).toISOString();
  const ratios = (...r) => r.map((ratio) => ({ at, ratio }));
  // Two workers measuring 1 GiB each with 2 GiB of room each; the set grows by `grew` GiB in one window.
  const cases = [
    ['the sum, before enough windows exist', ratios(0.5, 0.5), 'sum', 4, 4.5, 4.5],
    ['measured, under 100 windows', ratios(0.5, 0.5, 0.5), 'measured', 2, 3, 3],
    // The new 1.125 joins 199 others; the percentile stays at 1 while the window's own ratio holds.
    ['measured, from 100 windows on', ratios(...Array.from({ length: 197 }, () => 0.5), 1, 1, 1), 'measured', 4, 4.5, 4.5],
    ['a raise already in force', ratios(0.5, 0.5, 0.5), 'raised', 3, 3.5, 3.5, { ratio: 0.75, at, until: new Date(t0 + 30 * 60000).toISOString() }],
  ];
  for (const [name, growth, rule, reserved, grew, next, raised = null] of cases) {
    const a = unit('worker', 1, { expected: 3 * GiB, measured: GiB });
    const b = unit('worker', 2, { expected: 3 * GiB, measured: GiB });
    const reg = { ...registry([a, b]), windows: [], growth, raised };
    G.observe(reg, reading({ limit: 36, used: 15 }), small, t0);
    assert.deepEqual([reg.windows[0].rule, reg.windows[0].reserved / GiB], [rule, reserved], `${name}: the reservation in force`);
    a.measured = GiB + grew * GiB / 2;
    b.measured = GiB + grew * GiB / 2;
    const [w] = G.observe(reg, reading({ limit: 36, used: 18 }), small, t0 + 60 * 60000);
    assert.deepEqual([w.grew / GiB, w.crossed], [grew, true], `${name}: the window crossed`);
    const fresh = [unit('worker', 4, { expected: 3 * GiB, measured: GiB }), unit('worker', 5, { expected: 3 * GiB, measured: GiB })];
    const after = G.reserve({ ...reg, units: fresh }, small, t0 + 60 * 60000 + 1000);
    assert.ok(after.bytes > reserved * GiB, `${name}: the next reservation is higher`);
    assert.equal(after.bytes / GiB, next, `${name}: at least what the set grew into`);
    assert.equal(G.reserve({ ...reg, units: fresh }, small, t0 + 120 * 60000).rule === 'raised', false, `${name}: the raise lasts growth_window_min`);
  }
});

test('status names the growth rule and its sample count, and closed windows go to the rolling log', { skip: linuxOnly }, (t) => {
  const h = makeRepo(t);
  h.init();
  writeHost(h.env.TOWER_CRANE_HOST_ROOT, { limit: 10, used: 2 });
  h.ok(['project', 'set', '--governor', '{"growth_samples_min":1}']);
  const project = h.readState('project.json');
  const held = G.admit({ stateDir: h.state, env: h.env, agent: 'orchestrator' }, { kind: 'tests', task: 'T1', project });
  t.after(() => held.release());
  assert.match(h.ok(['status']), /in 1 unit across 1 project, may grow 2\.0 GiB \(sum of unit peaks; 0 of 1 window before measured growth\);/);
  G.tick(h.env, project);
  // An hour later: the window the tick opened closes on the next tick.
  const file = G.registryFile(h.env);
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(reg.windows.length, 1);
  const ago = new Date(Date.now() - 3600000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...reg, ticked_at: ago, windows: reg.windows.map((w) => ({ ...w, at: ago })) }));
  G.tick(h.env, project);
  const logged = fs.readFileSync(G.windowsFile(h.env), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(logged.map((w) => [w.rule, w.sum, w.reserved, w.used, w.grew, w.ratio, w.crossed]), [['sum', 2 * GiB, 2 * GiB, 2 * GiB, 0, 0, false]]);
  assert.match(h.ok(['status']), /may grow 2\.0 GiB \(p99 ratio 0\.00 of 1 window times 2\.0 GiB of unit room, at least the largest unit's 2\.0 GiB\);/);
  const budget = h.json(['status']).governor.budget;
  assert.deepEqual([budget.growth_rule, budget.growth_ratio, budget.growth_samples, budget.growth_samples_min], ['measured', 0, 1, 1]);
});

test('the stop line, the stop order and the learned unit size', () => {
  assert.equal(G.overStop(reading({ used: 9.4 }), s), null);
  assert.match(G.overStop(reading({ used: 9.5 }), s), /tests\.slice has 9\.5 GiB of 10\.0 GiB in use, at or past the 95% stop line/);
  assert.match(G.overStop(reading({ full: 10 }), s), /memory pressure: full avg10 10% is at or over the 10% stop line/);
  const bound = { bound: true };
  const units = [unit('worker', 1, bound), unit('worker', 5, bound), unit('worker', 7), unit('tests', 2), unit('suite', 4), unit('reviewer', 3, bound),
    unit('orchestrator', 9, bound), unit('clean', 6, { stop: { at: 'x' } })];
  // Gates and suites first, then reviewers, then workers, newest first in each; never the orchestrator,
  // a unit already stopping, or an agent whose dispatch has not yet handed it to its supervisor.
  assert.deepEqual(G.victims(registry(units)).map((u) => u.id), ['suite-4', 'tests-2', 'reviewer-3', 'worker-5', 'worker-1']);
  const peak = (gib, project = '/p') => ({ kind: 'worker', project, peak: gib * GiB });
  assert.equal(G.expected(registry([], [], []), '/p', 'worker', s), 1536 * 1024 * 1024, 'no history: the configured size');
  assert.equal(G.expected(registry([], [], [peak(3), peak(0.5)]), '/p', 'worker', s), 3 * GiB, 'too few samples only raise it');
  assert.equal(G.expected(registry([], [], [peak(0.5), peak(0.7), peak(0.6), peak(9, '/other')]), '/p', 'worker', s), 0.7 * GiB, 'three of this project replace it');
  assert.equal(G.expected(registry([], [], [peak(0.5), peak(0.7), peak(0.6)]), '/q', 'worker', s), 0.7 * GiB, 'other projects stand in for none of its own');
});

test('governor settings are validated and set as an operational setting', (t) => {
  for (const [value, error] of [
    [{ defer_at: 0 }, /defer_at must be a fraction above 0 and at most 1/],
    [{ stop_at: 0.5 }, /stop_at must be at least governor\.defer_at/],
    [{ psi_cpu_defer: 101 }, /psi_cpu_defer must be a percentage/],
    [{ growth_window_min: 0 }, /growth_window_min must be a positive number/],
    [{ growth_samples_min: 2.5 }, /growth_samples_min must be a positive whole number/],
    [{ expected_mb: { gate: 1 } }, /expected_mb\.gate is not a unit kind/],
    [{ expected_mb: { worker: -1 } }, /expected_mb\.worker must be a positive number/],
    [{ lines: 1 }, /governor\.lines is not a governor setting/],
  ]) assert.match(G.errors(value).join('; '), error, JSON.stringify(value));
  const h = makeRepo(t);
  h.init();
  assert.match(h.run(['project', 'set', '--governor', '{"defer_at":2}']).stderr, /defer_at must be a fraction/);
  h.ok(['project', 'set', '--governor', '{"defer_at":0.7,"expected_mb":{"worker":512}}', '--agent', 'orchestrator']);
  assert.deepEqual(h.readState('project.json').governor, { defer_at: 0.7, expected_mb: { worker: 512 } });
  const audit = events(h).findLast((e) => e.cmd === 'setting');
  assert.deepEqual([audit.detail.actor, audit.detail.settings], ['orchestrator', { governor: 'operational' }]);
  assert.match(h.ok(['project', 'show']), /governor: \{"defer_at":0\.7,"expected_mb":\{"worker":512\}\}/);
  h.ok(['project', 'set', '--governor', 'null']);
  assert.equal(h.readState('project.json').governor, undefined);
});

test('the governor key lists in the contract and the --governor help name every setting', () => {
  const keys = Object.keys(G.DEFAULTS).sort();
  const root = path.join(__dirname, '..');
  const contract = fs.readFileSync(path.join(root, 'docs', 'state.md'), 'utf8').split('\n').find((l) => l.startsWith('`governor`, set through'));
  const listed = contract.slice(contract.indexOf('holds the lines'), contract.indexOf('Unknown keys'));
  assert.deepEqual([...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort(), keys, 'docs/state.md');
  const help = /host governor lines for this project\S* admissions \{([^}]*)\}/.exec(fs.readFileSync(path.join(root, 'bin', 'tower-crane.js'), 'utf8'));
  assert.deepEqual(help[1].split(', ').sort(), keys, 'bin/tower-crane.js --governor');
});

// A task an easy command-harness rung runs: it claims, then idles until stopped.
function supervised(h, ids) {
  for (const id of ids) {
    h.ok(['task', 'add', '--title', `Fixture ${id}`, '--acceptance', 'idles until stopped', '--tier', 'easy']);
    h.ok(['brief', 'set', id, '-'], { input: 'Fixture process, no model.\n' });
  }
  const script = `require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(BIN)},'claim',process.env.TOWER_CRANE_TASK],{env:require(${JSON.stringify(require.resolve('./agent-env'))}).fakeAgentEnv(process.env)});setInterval(()=>{},1000)`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, '{brief}']), '--clear', 'profile', '--clear', 'effort']);
}

test('a dispatch past the defer line waits with its reason in status, inbox and the board, and starts once there is room', { skip: linuxOnly }, async (t) => {
  const h = makeRepo(t);
  h.init();
  supervised(h, ['T1']);
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { limit: 10, used: 8 });
  const refused = h.run(['spawn', '--task', 'T1']);
  assert.equal(refused.code, 3, refused.stderr);
  assert.match(refused.stderr, /T1: worker deferred by the host governor: memory: tests\.slice has 8\.0 GiB of 10\.0 GiB in use, running Tower Crane work may grow 0\.0 GiB and other sessions 0\.0 GiB toward their peak of the last 30 minutes, and a worker needs 1\.5 GiB; 9\.5 GiB is over the 85% line \(8\.5 GiB\)/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo', 'nothing was claimed');
  const status = h.json(['status']);
  assert.equal(status.governor.state, 'deferring');
  assert.deepEqual(status.governor.deferred.map((d) => [d.task, d.kind]), [['T1', 'worker']]);
  assert.match(h.ok(['status']), /governor deferred: T1 worker since \S+: memory: tests\.slice has 8\.0 GiB/);
  assert.match(status.not_dispatched.find((b) => b.id === 'T1').reason, /^host governor deferred workers since \S+: memory: tests\.slice has 8\.0 GiB/);
  const inbox = h.json(['inbox']).items.find((i) => i.id === 'governor_deferred:T1:worker');
  assert.match(inbox.reason, /over the 85% line/);
  assert.deepEqual(inbox.action.argv, ['status']);
  h.ok(['render']);
  const board = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  const item = board.match(/<li class="qi" data-tier="turn" data-kind="governor"[\s\S]*?<\/li>/);
  assert.ok(item, 'the board shows the governor item');
  assert.match(item[0], /The host governor is deferring new work/);
  assert.match(item[0], /T1 worker waits since/);

  // Room again, and no reservation left for the other sessions' 8 GiB a moment ago.
  h.ok(['project', 'set', '--governor', '{"others_window_min":0.001}']);
  writeHost(host, { limit: 10, used: 2 });
  const started = h.json(['spawn', '--task', 'T1']);
  assert.ok(started.monitor_pid, 'the dispatch started once there was room');
  const after = h.json(['status']).governor;
  assert.deepEqual(after.deferred, [], 'admission clears the deferral');
  assert.deepEqual(after.units.map((u) => [u.task, u.kind]), [['T1', 'worker']], 'the supervisor holds the worker\'s place');
});

test('every project on the host draws on one budget', (t) => {
  const a = makeRepo(t);
  const b = makeRepo(t);
  a.init();
  b.init();
  // One user and one host: the same cache directory and the same machine.
  b.env.XDG_CACHE_HOME = a.env.XDG_CACHE_HOME;
  b.env.TOWER_CRANE_HOST_ROOT = a.env.TOWER_CRANE_HOST_ROOT;
  writeHost(a.env.TOWER_CRANE_HOST_ROOT, { limit: 13, used: 2 });
  supervised(b, ['T1']);
  const project = a.readState('project.json');
  const held = [];
  t.after(() => held.forEach((u) => u.release()));
  for (const task of ['T1', 'T2', 'T3', 'T4']) held.push(G.admit({ stateDir: a.state, env: a.env, agent: 'orchestrator' }, { kind: 'tests', task, project }));
  const refused = b.run(['spawn', '--task', 'T1']);
  assert.equal(refused.code, 3, refused.stderr);
  assert.match(refused.stderr, /running Tower Crane work may grow 8\.0 GiB/);
  const seen = b.json(['status']).governor.budget;
  assert.deepEqual([seen.units, seen.projects], [4, 1], 'project b sees project a\'s four gates');
  held.forEach((u) => u.release());
  const dry = b.run(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(G.view({ stateDir: b.state, env: b.env }, b.readState('project.json')).budget.units, 0, 'released places free the budget');
});

test('a release that meets a busy registry lands once the lock is free, so no place outlives its unit', async (t) => {
  const S = require('../lib/state');
  const h = makeRepo(t);
  h.init();
  const env = h.env;
  const unit = G.admit({ stateDir: h.state, env, agent: 'orchestrator' }, { kind: 'tests', task: 'T1', project: h.readState('project.json') });
  // This process holds the lock, as a stuck writer would, while the release runs.
  const lock = S.tryMarkedLock(G.registryLock(env), { keepLive: true });
  assert.ok(lock);
  try {
    unit.release();
    assert.equal(G.read(env).units.length, 1, 'the release could not write');
  } finally {
    S.releaseMarkedLock(lock);
  }
  await waitOnRepo(h, () => G.read(env).units.length === 0, 'the queued release lands');
  // A bind, which a dispatch about to exit makes, says whether it landed.
  const next = G.admit({ stateDir: h.state, env, agent: 'orchestrator' }, { kind: 'worker', task: 'T1', project: h.readState('project.json') });
  const held = S.tryMarkedLock(G.registryLock(env), { keepLive: true });
  let landed;
  try { landed = next.bind(process.pid, undefined, 'worker-T1-1'); } finally { S.releaseMarkedLock(held); }
  assert.equal(landed, false, 'a bind past its wait reports that it did not land');
  assert.equal(next.bind(process.pid, undefined, 'worker-T1-1'), true);
  assert.deepEqual(G.read(env).units.map((u) => [u.agent, u.bound]), [['worker-T1-1', true]]);
  next.release();
});

// A submitted task whose tests command records that it started, then holds until killed.
function heldGate(h, submit = true) {
  h.git(['remote', 'remove', 'origin']);
  h.started = path.join(h.base, 'suite-started');
  h.release = path.join(h.base, 'suite-release');
  fs.writeFileSync(path.join(h.repo, 'hold.js'), `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
// The gate's process group ends it when the gate stops; a release file ends it as passed.
const timer = setInterval(() => { if (fs.existsSync(process.argv[3])) { clearInterval(timer); process.exit(0); } }, 20);
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'holding suite']);
  h.git(['switch', '-qc', 'change']);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'new\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'head change']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.init(['--tests-cmd', `node hold.js ${JSON.stringify(h.started)} ${JSON.stringify(h.release)}`, '--tests-mode', 'run-only']);
  h.ok(['task', 'add', '--title', 'held suite', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  if (submit) h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'change']);
}

test('past the stop line a running gate stops without a verdict and says why', { skip: linuxOnly }, async (t) => {
  const h = makeRepo(t);
  heldGate(h);
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { limit: 10, used: 2 });
  let child;
  const run = h.runAsync(['check', 'tests', 'T1'], { onSpawn: (c) => { child = c; } });
  t.after(() => { if (child && child.exitCode === null) killPid(child.pid, 'SIGKILL'); });
  await waitOnRepo(h, () => fs.existsSync(h.started), 'the tests command starts');
  const suitePid = Number(fs.readFileSync(h.started, 'utf8'));
  writeHost(host, { limit: 10, used: 9.6 });
  const done = await run;
  assert.equal(done.code, 3, done.stderr);
  assert.match(done.stderr, /T1: tests gate stopped by the host governor: memory: tests\.slice has 9\.6 GiB of 10\.0 GiB in use, at or past the 95% stop line \(9\.5 GiB\); it runs again once there is room/);
  assert.throws(() => killPid(suitePid, 0), { code: 'ESRCH' }, 'the suite process was stopped');
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests'), [], 'no verdict was recorded');
  const stops = h.json(['status']).governor.stops;
  assert.deepEqual(stops.map((x) => [x.task, x.kind]), [['T1', 'tests']]);
  assert.ok(h.json(['inbox']).items.some((i) => i.kind === 'governor_stopped' && i.task === 'T1' && /95% stop line/.test(i.reason)));
});

test('a gate that joins a run already going takes no place in the budget', { skip: linuxOnly }, async (t) => {
  const h = makeRepo(t);
  heldGate(h);
  // Room for one tests gate only.
  writeHost(h.env.TOWER_CRANE_HOST_ROOT, { limit: 10, used: 2 });
  h.ok(['project', 'set', '--governor', '{"expected_mb":{"tests":4000}}']);
  let first;
  const holder = h.runAsync(['check', 'tests', 'T1'], { onSpawn: (c) => { first = c; } });
  t.after(() => { if (first && first.exitCode === null) killPid(first.pid, 'SIGKILL'); });
  await waitOnRepo(h, () => fs.existsSync(h.started), 'the first run starts its suite');
  let stderr = '';
  const joiner = h.runAsync(['check', 'tests', 'T1'], { onSpawn: (c) => c.stderr.on('data', (d) => { stderr += d; }) });
  await waitOnRepo(h, () => /joining the tests run/.test(stderr), 'the second run joins the first');
  assert.equal(G.read(h.env).units.length, 1, 'only the running gate holds a place');
  fs.writeFileSync(h.release, '');
  const [a, b] = await Promise.all([holder, joiner]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /joined the run by/);
});

test('a wait defers a gate reaction under pressure and runs it once there is room', { skip: linuxOnly }, async (t) => {
  const h = makeRepo(t);
  heldGate(h, false);
  fs.writeFileSync(h.release, '');
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { limit: 10, used: 2, memorySome: 15 });
  let child;
  let stdout = '';
  let stderr = '';
  const wait = h.runAsync(['wait', '--follow'], { onSpawn: (c) => {
    child = c;
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
  } });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await wait; } });
  await waitOnRepo(h, () => stdout.includes('"type":"ready"'), 'the wait is ready');
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'change']);
  await waitOnRepo(h, () => /T1: tests gate deferred by the host governor: memory pressure: some avg10 15% is at or over 10%/.test(stderr), 'the wait defers the tests gate');
  assert.equal(fs.existsSync(h.started), false, 'the suite did not start');
  assert.ok(events(h).some((e) => e.cmd === 'automation' && e.task === 'T1' && e.detail.phase === 'deferred'), 'the reaction is deferred, not failed');
  assert.deepEqual(h.json(['status']).governor.deferred.map((d) => [d.task, d.kind]), [['T1', 'tests']]);
  writeHost(host, { limit: 10, used: 2 });
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'tests' && e.ok), 'the tests gate runs once there is room');
  assert.ok(fs.existsSync(h.started), 'the suite ran');
});

test('only owed governor receipts remain deferred in the persistent gate queue', () => {
  const A = require('../lib/automation');
  const P = require('../lib/processes');
  const task = { id: 'T1', status: 'submitted', sha: 'a'.repeat(40), revision: 1, evidence: [] };
  const source = { id: 'submit-1', task: 'T1', cmd: 'submit', detail: { sha: task.sha, revision: 1 } };
  const governor = { task: 'T1', kind: 'tests', until: Date.now() + 5000, reason: 'pressure' };
  for (const [name, receipt, owed, deferred, changed = {}] of [
    ['no receipt', null, true, false],
    ['governor retry interval', { phase: 'deferred', governor }, true, true],
    ['governor retry due', { phase: 'deferred', governor: { ...governor, until: 0 } }, true, true],
    ['legacy governor deferral', { phase: 'deferred', error: 'T1: tests gate deferred by the host governor: pressure' }, true, true],
    ['legacy governor stop', { phase: 'deferred', error: 'T1: tests gate stopped by the host governor: pressure; it runs again once there is room' }, true, true],
    ['legacy registry lock', { phase: 'deferred', error: "the host governor's registry is locked (/fixture/governor.lock); retry" }, true, true],
    ['completed', { phase: 'done' }, false, false],
    ['exception', { phase: 'error' }, false, false],
    ['interrupted wait', { phase: 'deferred', error: 'wait interrupted' }, false, false],
    ['unknown mergeability', { phase: 'deferred' }, false, false],
    ['dead executor', { phase: 'running', pid: 2147483647 }, true, false],
    ['live executor', { phase: 'running', pid: process.pid, ...P.identity(process.pid) }, false, false],
    ['unobservable executor', { phase: 'running', pid: process.pid, host: 'another-host' }, false, false],
    ['task reworked', { phase: 'deferred', governor }, false, false, { status: 'rework' }],
    ['head moved', { phase: 'deferred', governor }, false, false, { sha: 'b'.repeat(40) }],
    ['revision moved', { phase: 'deferred', governor }, false, false, { revision: 2 }],
  ]) {
    const events = [source, { cmd: 'automation queued', task: 'T1', detail: { source: source.id } }];
    if (receipt) events.push({ cmd: 'automation', task: 'T1', at: new Date().toISOString(), detail: { source: source.id, ...receipt } });
    for (const cmd of ['submit', 'spawn exit', 'ci resolve', 'ci completed', 'automation reconcile']) {
      const st = { project: {}, tasks: { tasks: [{ ...task, ...changed }] }, events: [{ ...source, cmd }, ...events.slice(1)] };
      assert.equal(A.gateQueue(st).queued.length, owed ? 1 : 0, `${cmd}: ${name}`);
      assert.equal(A.gateQueue(st).deferred.length, deferred ? 1 : 0, `${cmd}: ${name}`);
      assert.equal(A.governorDeferred(st).length, deferred ? 1 : 0, `${cmd}: ${name}`);
      if (deferred) {
        st.events = st.events.filter((e) => e.cmd !== 'automation queued');
        assert.equal(A.gateQueue(st).queued.length, 1, `${cmd}: ${name} without an earlier queue entry`);
      }
    }
  }
});

test('a supervisor-deferred submission stays visible and a new wait retries its original turn', { skip: linuxOnly }, async (t) => {
  const { setup, configureHarness } = require('./automation-helpers');
  const h = setup(t, { ci: 'pending' });
  configureHarness(h);
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--executors', '1']);
  const hold = path.join(h.env.AUTOMATION_CONTEXT_DIR, 'worker-hold');
  h.env.AUTOMATION_WORKER_HOLD = hold;
  let supervisor;
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'], {
    onSpawn: (c) => { supervisor = c; },
  });
  t.after(() => { if (supervisor.exitCode === null) killPid(supervisor.pid, 'SIGKILL'); });
  await waitOnRepo(h, () => fs.existsSync(hold), 'the supervisor worker submits', { alive: supervisor });
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { limit: 10, used: 2, memorySome: 15 });
  fs.writeFileSync(`${hold}.go`, '');
  const ended = await spawned;
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stderr, /T1: tests gate deferred by the host governor/);
  const source = h.logs().find((e) => e.cmd === 'submit' && e.task === 'T1').id;
  const deferral = h.logs().find((e) => e.cmd === 'automation' && e.detail.source === source && e.detail.phase === 'deferred');
  assert.ok(deferral);
  assert.deepEqual(h.json(['status']).gate_queue.queued.map((q) => q.id), ['T1'], 'the supervisor leaves the submission owed in state');
  assert.match(h.ok(['status']), /^gate queue: .*deferred by the governor: T1/m);

  // The host registry expires hints after ten minutes; the owed reaction must still show.
  const clock = path.join(h.base, 'later-clock.js');
  fs.writeFileSync(clock, 'const now = Date.now; Date.now = () => now() + 11 * 60000;\n');
  const env = { NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require=${JSON.stringify(clock)}` };
  assert.deepEqual(h.json(['status'], { env }).governor.deferred, [], 'the registry hint has expired');
  const inbox = h.json(['inbox'], { env });
  assert.ok(inbox.items.some((i) => i.id === 'governor_deferred:T1:tests'), 'the inbox retains owed work beyond the registry hint');

  h.ok(['task', 'add', '--title', 'later submission', '--acceptance', 'checked']);
  h.submit('T2');
  h.ok(['project', 'set', '--paused', 'inspect gate queue']);
  const cursor = h.run(['wait', '--timeout', '0']);
  assert.equal(cursor.code, 2, cursor.stderr);
  const after = JSON.parse(cursor.stdout).cursor;
  // Both submissions become runnable after the original retry time.
  fs.writeFileSync(clock, `const NativeDate = Date;
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + 6000])); }
  static now() { return NativeDate.now() + 6000; }
};
`);
  writeHost(host, { limit: 10, used: 2 });
  let waiter;
  let stdout = '';
  const wait = h.runAsync(['wait', '--after', after, '--follow', '--agent', 'orchestrator'], {
    env,
    onSpawn: (c) => { waiter = c; c.stdout.on('data', (d) => { stdout += d; }); },
  });
  t.after(async () => { if (waiter.exitCode === null) { waiter.kill('SIGTERM'); await wait; } });
  await waitOnRepo(h, () => stdout.includes('"type":"ready"'), 'the new wait is ready');
  await waitOnRepo(h, () => h.readState('tasks.json').tasks.every((task) => task.evidence.some((e) => e.type === 'tests' && e.ok)), 'the new wait drains both submissions');
  const starts = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running');
  const retried = starts.findIndex((e, i) => i > 0 && e.detail.source === source);
  assert.ok(retried > 0, 'the original submit source is retried, rather than replaced by startup reconciliation');
  assert.ok(Date.parse(starts[retried].at) >= deferral.detail.governor.until, 'the retry interval is respected across processes');
  assert.ok(retried < starts.findIndex((e) => e.task === 'T2'), 'the original turn runs before the later submission');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === source && e.detail.phase === 'done'));
  assert.equal(h.json(['inbox']).items.some((i) => i.id === 'governor_deferred:T1:tests'), false, 'completed work clears the item');
});

for (const row of [
  { name: 'docs during the retry interval', interval: true },
  { name: 'docs after an inadmissible retry' },
  { name: 'smaller local CI during the retry interval', interval: true, local: true },
  { name: 'smaller local CI after an inadmissible retry', local: true },
  { name: 'CI completion after an inadmissible retry', completion: true },
  { name: 'CI failure rework after an inadmissible retry', completion: true, failed: true },
  { name: 'docs behind a prioritized inadmissible retry', prioritized: true },
]) {
  test(`held governor debt lets ${row.name} run and keeps its original turn`, { skip: linuxOnly }, (t) => {
    const h = cachedFixture(t, 'governor-held-queue', (repo) => {
      const h = require('./automation-helpers').setup(null, { ci: 'pending', repo });
      h.ok(['project', 'set', '--governor', '{"expected_mb":{"tests":8000}}']);
      writeHost(h.env.TOWER_CRANE_HOST_ROOT, { limit: 10, used: 2 });
      h.submit();
      assert.equal(h.consume().code, 2);
      assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.phase === 'deferred'));
      return { sha: h.sha };
    });
    writeHost(h.env.TOWER_CRANE_HOST_ROOT, { limit: 10, used: 2 });
    const logs = () => events(h);
    const github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
    const saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
    const add = (id, pr, kind) => {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'checked', '--kind', kind]);
      const state = github();
      state.prs[pr] = { ...state.prs[7], url: `https://github.com/acme/demo/pull/${pr}` };
      state.ci[h.sha] = 'success';
      saveGithub(state);
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', h.sha, '--pr', String(pr), '--agent', 'worker']);
      state.ci[h.sha] = 'pending';
      saveGithub(state);
    };
    const original = logs().find((e) => e.cmd === 'submit' && e.task === 'T1').id;
    const receipt = logs().find((e) => e.cmd === 'automation' && e.detail.source === original && e.detail.phase === 'deferred');
    add('T2', 8, 'docs');
    if (row.local) h.ok(['project', 'set', '--ci-local', JSON.stringify({
      command: [process.execPath, '-e', 'process.exit(0)'], timeout: 30,
    })]);
    if (row.prioritized) h.ok(['gates', 'prioritize', 'T1', '--reason', 'keep its requested turn']);
    if (row.completion) {
      const state = github();
      state.ci[h.sha] = row.failed ? 'failure' : 'success';
      saveGithub(state);
    }
    // The child clock exercises both sides of the retry time without a timed sleep.
    const clock = path.join(h.base, 'queue-clock.js');
    const writeClock = (at) => fs.writeFileSync(clock, `const NativeDate = Date;
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [${at}])); }
  static now() { return ${at}; }
};
`);
    const at = receipt.detail.governor.until + (row.interval ? -1 : 1);
    writeClock(at);
    const env = { NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require=${JSON.stringify(clock)}` };
    const blocked = row.completion
      ? h.run(['ci', 'completed', 'T2', '--sha', h.sha, '--agent', 'orchestrator'], { env })
      : h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], { env });
    assert.equal(blocked.code, row.completion ? 0 : 2, blocked.stderr);
    assert.ok(logs().some((e) => e.cmd === 'automation' && e.task === 'T2' && e.detail.phase === 'running'), 'T2 reaction started while T1 was held');
    assert.equal(logs().filter((e) => e.cmd === 'automation' && e.detail.source === original && e.detail.phase === 'running').length, 1, 'held work took no new executor');
    if (row.failed) assert.equal(h.readState('tasks.json').tasks.find((task) => task.id === 'T2').status, 'rework');
    else assert.ok(h.readState('tasks.json').tasks.find((task) => task.id === 'T2').evidence.some((e) => e.type === 'ci' && (row.local || row.completion ? e.ok : e.pending)));
    assert.ok(h.json(['status']).gate_queue.deferred.some((q) => q.id === 'T1'), 'held debt remains in the queue');
    assert.ok(h.json(['inbox']).items.some((i) => i.id === 'governor_deferred:T1:tests'), 'held debt remains in the inbox');

    add('T3', 9, 'code');
    h.ok(['project', 'set', '--paused', 'inspect queue order']);
    writeHost(h.env.TOWER_CRANE_HOST_ROOT, { limit: 20, used: 2 });
    const retryAt = Math.max(...logs().filter((e) => e.cmd === 'automation' && e.detail.governor).map((e) => e.detail.governor.until)) + 1;
    writeClock(retryAt);
    const resumed = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], { env });
    assert.equal(resumed.code, 2, resumed.stderr);
    const starts = logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running');
    const retried = starts.findIndex((e, i) => i > 0 && e.detail.source === original);
    assert.ok(retried > 0, 'the original source resumed');
    assert.ok(retried < starts.findIndex((e) => e.task === 'T3'), 'admissible deferred work resumed before the later submission');
  });
}

test('past the stop line the newest worker stops first, and processes Tower Crane did not start are left alone', { skip: linuxOnly }, async (t) => {
  const h = makeRepo(t);
  h.init();
  supervised(h, ['T1', 'T2']);
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { limit: 10, used: 1 });
  const older = h.json(['spawn', '--task', 'T1']);
  const newer = h.json(['spawn', '--task', 'T2']);
  const outside = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { outside.kill('SIGKILL'); } catch { /* gone */ } });
  // A place recorded for the outside process under another start time, as after a pid reuse.
  const project = h.readState('project.json');
  G.admit({ stateDir: h.state, env: h.env, agent: 'orchestrator' }, { kind: 'worker', task: 'T9', project }).bind(outside.pid, '1');
  const alive = (pid) => { try { killPid(pid, 0); return true; } catch { return false; } };
  writeHost(host, { limit: 10, used: 9.7 });
  await waitOnRepo(h, () => !alive(newer.monitor_pid), 'the newer worker\'s supervisor stops');
  // The host stays past the line, so once the newer one has exited the older one stops too.
  await waitOnRepo(h, () => !alive(older.monitor_pid), 'then the older worker\'s supervisor stops');
  assert.ok(alive(outside.pid), 'a process Tower Crane did not start is never signalled');
  await waitOnRepo(h, () => events(h).some((e) => e.task === 'T2' && e.cmd === 'spawn phase'
    && /^supervisor stopped by the host governor: memory: tests\.slice has 9\.7 GiB/.test(e.detail.reason || '')), 'the supervisor records why it stopped');
  const stops = h.json(['status']).governor.stops;
  assert.deepEqual(stops.map((x) => [x.task, x.kind, x.agent]), [['T2', 'worker', newer.agent], ['T1', 'worker', older.agent]], 'newest first');
  assert.match(h.ok(['status']), /governor stopped: T2 worker \(\S+\) at \S+: memory: tests\.slice has 9\.7 GiB of 10\.0 GiB in use, at or past the 95% stop line/);

  // Once there is room the stopped task is dispatched again in its kept worktree.
  h.ok(['project', 'set', '--governor', '{"others_window_min":0.001}']);
  writeHost(host, { limit: 10, used: 1 });
  h.ok(['release', '--dead']);
  const again = h.json(['spawn', '--task', 'T2']);
  assert.equal(again.cwd, newer.cwd, 'the same worktree');
});
