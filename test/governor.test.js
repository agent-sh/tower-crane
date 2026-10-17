'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const G = require('../lib/governor');
const { makeRepo, BIN } = require('./helpers');
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
    tower_crane: GiB, growth: GiB, others: 3 * GiB, others_room: 2 * GiB * (1 - 1 / 30), need: 0, units: 1, projects: 1 }));
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

// A task an easy command-harness rung runs: it claims, then idles until stopped.
function supervised(h, ids) {
  for (const id of ids) {
    h.ok(['task', 'add', '--title', `Fixture ${id}`, '--acceptance', 'idles until stopped', '--tier', 'easy']);
    h.ok(['brief', 'set', id, '-'], { input: 'Fixture process, no model.\n' });
  }
  const script = `require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(BIN)},'claim',process.env.TOWER_CRANE_TASK]);setInterval(()=>{},1000)`;
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
