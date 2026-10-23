'use strict';

// Test-thread grants (docs/state.md#test-threads): test/run.js inside Tower
// Crane asks the host governor for its file workers and resizes its pool as
// the grant changes; outside it keeps its request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const G = require('../lib/governor');
const B = require('../lib/broker');
const { makeRepo, ROOT } = require('./helpers');
const { writeHost } = require('./host');
const { waitUntil, childClosed, killGroup } = require('./signals');

const RUN = path.join(ROOT, 'test', 'run.js');
// What Tower Crane sets on a gate command or an agent (lib/test-grants.js mark).
const MARK = 'TOWER_CRANE_TEST_GRANT';
const mark = (h, label) => ({ [MARK]: JSON.stringify({ project: h.state, task: null, agent: null, kind: null, ...label }) });
const SIGNALS = path.join(__dirname, 'signals.js');
const posixOnly = process.platform === 'win32' && 'a killed runner is stopped with its process group';
// Every run here asks for two threads, which test/run.js caps at one below the cores.
const twoCores = os.availableParallelism() < 3 && 'a run of two threads needs three cores';

// Test files that log their start, wait for `go` in their run's directory and
// log their end; `fail` ones then fail.
function fixtures(dir, names, { fail = [] } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return names.map((name) => {
    const file = path.join(dir, `${name}.test.js`);
    fs.writeFileSync(file, `'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fileWritten } = require(${JSON.stringify(SIGNALS)});
const dir = ${JSON.stringify(dir)};
test(${JSON.stringify(name)}, async () => {
  fs.appendFileSync(path.join(dir, 'log'), 'start ${name}\\n');
  await fileWritten(path.join(dir, 'go'));
  fs.appendFileSync(path.join(dir, 'log'), 'end ${name}\\n');
  ${fail.includes(name) ? "throw new Error('planted failure');" : ''}
});
`);
    return file;
  });
}

const log = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } // read-published: the fixtures only append to the log
};
const starts = (dir) => log(dir).filter((l) => l.startsWith('start ')).length;
// The most files the log shows running at once, from line `from` on, counting those already running then.
function overlap(dir, from = 0) {
  const lines = log(dir);
  let now = lines.slice(0, from).reduce((n, l) => n + (l.startsWith('start ') ? 1 : -1), 0);
  let most = 0;
  for (const l of lines.slice(from)) {
    now += l.startsWith('start ') ? 1 : -1;
    most = Math.max(most, now);
  }
  return most;
}

function runner(t, h, dir, files, { request = 2, marked = true, env = {} } = {}) {
  const child = cp.spawn(process.execPath, [RUN, `--test-concurrency=${request}`, ...files], {
    cwd: ROOT,
    env: {
      ...h.env, TOWER_CRANE_TEST_TMP: h.base, TOWER_CRANE_INTERVALS: JSON.stringify({ test_grant: 100 }),
      ...(marked ? mark(h, { task: 'T1', kind: 'gate' }) : {}), ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  const r = { child, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (d) => { r.stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { r.stderr += d; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.platform === 'win32' ? child.kill() : killGroup(child.pid, 'SIGKILL'); } catch { /* Gone already. */ }
    }
  });
  r.said = (pattern) => waitUntil(() => pattern.test(r.stderr), { alive: child, what: () => `runner stderr ${pattern}\n${r.stderr}` });
  r.closed = () => childClosed(child);
  return r;
}

const waitStarts = (dir, n, r) => waitUntil(() => starts(dir) >= n, { paths: [dir], alive: r.child, what: () => `${n} files started in ${dir}\n${r.stderr}` });
const leases = (h) => (G.read(h.env)?.tests || []);

test('a run grows its pool when its grant rises and shrinks it when the grant falls, logging each change once', { skip: twoCores }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  // Load at twice the cores leaves no budget: the run keeps one thread.
  writeHost(host, { cores: 8, load: 20 });
  const dir = path.join(h.base, 'resize');
  const files = fixtures(dir, ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  const r = runner(t, h, dir, files);
  await r.said(/test threads: granted 1 of 2 \(host budget 0 of 7 on 8 cores/);
  await waitStarts(dir, 1, r);
  assert.deepEqual(leases(h).map((l) => [l.task, l.kind, l.requested, l.granted]), [['T1', 'gate', 2, 1]]);
  // The load goes: the grant rises to the request and a second file starts.
  writeHost(host, { cores: 8, load: 0 });
  await r.said(/test threads: grew to 2 of 2/);
  await waitStarts(dir, 2, r);
  // The load is back: the grant falls, and the two running files finish first.
  writeHost(host, { cores: 8, load: 20 });
  await r.said(/test threads: shrank to 1 of 2/);
  const before = log(dir).length;
  fs.writeFileSync(path.join(dir, 'go'), '');
  const done = await r.closed();
  assert.equal(done.code, 0, r.stderr);
  assert.equal(starts(dir), 6);
  assert.equal(overlap(dir, before + 2), 1, `after the two running files end, one file runs at a time\n${log(dir).join('\n')}`);
  assert.equal(r.stderr.match(/test threads: grew/g).length, 1, r.stderr);
  assert.equal(r.stderr.match(/test threads: shrank/g).length, 1, r.stderr);
  assert.match(r.stdout, /^ℹ tests 6$/m, 'the run prints its totals last');
  assert.deepEqual(leases(h), [], 'the lease ends with the run');
});

test('two runs share one budget: the second takes a thread and the first shrinks to make room, then grows back', { skip: twoCores }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  // Three cores: a budget of two threads.
  writeHost(host, { cores: 3, load: 0 });
  const dirA = path.join(h.base, 'a');
  const dirB = path.join(h.base, 'b');
  const a = runner(t, h, dirA, fixtures(dirA, ['a1', 'a2', 'a3', 'a4']));
  await waitStarts(dirA, 2, a);
  const b = runner(t, h, dirB, fixtures(dirB, ['b1', 'b2']), { env: mark(h, { task: 'T2', agent: 'worker-T2-1', kind: 'worker' }) });
  await b.said(/test threads: granted 1 of 2 \(host budget 2 of 2 on 3 cores, 2 granted to 2 runs\)/);
  await a.said(/test threads: shrank to 1 of 2/);
  await waitStarts(dirB, 1, b);
  assert.equal(starts(dirB), 1, 'B stays at its one thread while A holds the other');
  const held = leases(h);
  assert.deepEqual(held.map((l) => [l.task, l.granted]).sort(), [['T1', 1], ['T2', 1]]);
  assert.equal(held.reduce((n, l) => n + l.granted, 0), 2, 'the grants sum to the budget');
  // A's two running files end; at one thread the other two run one at a time.
  const before = log(dirA).length;
  fs.writeFileSync(path.join(dirA, 'go'), '');
  const doneA = await a.closed();
  assert.equal(doneA.code, 0, a.stderr);
  assert.equal(overlap(dirA, before + 2), 1, log(dirA).join('\n'));
  // With A gone, B grows into the whole budget.
  await b.said(/test threads: grew to 2 of 2/);
  await waitStarts(dirB, 2, b);
  fs.writeFileSync(path.join(dirB, 'go'), '');
  assert.equal((await b.closed()).code, 0, b.stderr);
  assert.deepEqual(leases(h), []);
});

test('a killed run gives its threads back: its own lease when it held it, and the broker\'s when a sandboxed agent ran it', { skip: posixOnly || twoCores }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { cores: 3, load: 0 });
  const dir = path.join(h.base, 'killed');
  const files = fixtures(dir, ['k1', 'k2', 'k3']);
  const r = runner(t, h, dir, files);
  await waitStarts(dir, 2, r);
  assert.equal(leases(h).length, 1);
  killGroup(r.child.pid, 'SIGKILL');
  await r.closed();
  // The next run on the host finds no lease of the dead runner and takes the whole budget.
  const next = G.testLease({ env: h.env, stateDir: h.state }, { requested: 2, task: 'T3' });
  t.after(() => next.release());
  assert.equal(next.grant, 2);
  assert.deepEqual(leases(h).map((l) => l.task), ['T3']);
  next.release();

  // A sandboxed agent's run: its spawn monitor holds the lease while the connection lasts.
  const saved = process.env.TOWER_CRANE_HOST_ROOT;
  process.env.TOWER_CRANE_HOST_ROOT = host;
  t.after(() => { process.env.TOWER_CRANE_HOST_ROOT = saved; });
  const broker = await B.start({ state: h.state, task: 'T4', agent: 'worker-T4-1', role: 'worker', harness: 'codex', cwd: h.repo,
    broker: path.join(h.base, 'brokers', 'worker-T4-1', B.FILE) });
  t.after(() => broker.close());
  const sdir = path.join(h.base, 'sandboxed');
  const s = runner(t, h, sdir, fixtures(sdir, ['s1', 's2', 's3']), { env: { ...broker.env, ...mark(h, { task: 'T4', kind: 'worker' }) } });
  await s.said(/test threads: granted 2 of 2/);
  await waitStarts(sdir, 2, s);
  assert.deepEqual(leases(h).map((l) => [l.task, l.agent, l.kind, l.holder.pid]), [['T4', 'worker-T4-1', 'worker', process.pid]], 'the monitor holds it as the agent');
  killGroup(s.child.pid, 'SIGKILL');
  await s.closed();
  await waitUntil(() => leases(h).length === 0, { what: 'the broker releases the lease of a run that died' });
});

test('outside Tower Crane, or with no governor to grant, a run keeps its request and its exit code', { skip: twoCores }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { cores: 8, load: 20 });
  // No mark: plain npm test or CI. Two at once whatever the load, and a failing file fails the run.
  const dir = path.join(h.base, 'plain');
  const files = fixtures(dir, ['p1', 'p2', 'p3'], { fail: ['p3'] });
  fs.writeFileSync(path.join(dir, 'go'), '');
  const r = runner(t, h, dir, files, { marked: false });
  const done = await r.closed();
  assert.equal(done.code, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /test threads/);
  assert.equal(starts(dir), 3);
  assert.equal(fs.existsSync(path.join(host, 'tower-crane-governor')), false, 'no lease, no registry');
  assert.match(r.stdout, /^ℹ fail 1$/m);
  assert.match(r.stdout, /✖ failing tests:[\s\S]*planted failure/, 'the failures come again at the end of the run');

  // A sandboxed run whose spawn monitor predates test-thread leases: it answers as for a command.
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\tct-old-broker-${process.pid}-${Date.now()}` : path.join(h.base, 'old.sock');
  const old = net.createServer((conn) => conn.once('data', () => conn.end(`${JSON.stringify({ code: 2, stdout: '', stderr: 'tower-crane: the broker runs commands, not help\n' })}\n`)));
  await new Promise((resolve) => old.listen(sock, resolve));
  t.after(() => old.close());
  const file = path.join(h.base, 'broker.json');
  fs.writeFileSync(file, JSON.stringify({ socket: sock, token: 'x', state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker' }));
  const odir = path.join(h.base, 'old');
  const ofiles = fixtures(odir, ['o1', 'o2', 'o3']);
  const o = runner(t, h, odir, ofiles, { env: { TOWER_CRANE_BROKER: file } });
  await o.said(/no grant from the host governor \(the state broker grants no test threads: tower-crane: the broker runs commands, not help\); running 2 at once/);
  await waitStarts(odir, 2, o);
  fs.writeFileSync(path.join(odir, 'go'), '');
  assert.equal((await o.closed()).code, 0, o.stderr);
  assert.equal(overlap(odir), 2);
});

test('status shows the test-thread budget, every holder and its grant', (t) => {
  const h = makeRepo(t);
  h.init();
  writeHost(h.env.TOWER_CRANE_HOST_ROOT, { cores: 3, load: 0 });
  const project = h.readState('project.json');
  const gate = G.testLease({ env: h.env, stateDir: h.state }, { requested: 4, task: 'T1', kind: 'gate', project });
  const worker = G.testLease({ env: h.env, stateDir: h.state }, { requested: 8, task: 'T2', agent: 'worker-T2-1', kind: 'worker', project });
  t.after(() => { gate.release(); worker.release(); });
  const text = h.ok(['status']);
  assert.match(text, /^test threads: budget 2 of 2 on 3 cores, other work load 0; 2 runs hold 2 of 12 requested$/m);
  const where = project.name ? ` in ${project.name}` : '';
  assert.match(text, new RegExp(`^test threads: T1 gate${where}: 1 of 4, pid ${process.pid}, since `, 'm'));
  assert.match(text, new RegExp(`^test threads: T2 worker-T2-1${where}: 1 of 8, pid ${process.pid}, since `, 'm'));
  const tests = h.json(['status']).governor.tests;
  assert.deepEqual([tests.budget, tests.cap, tests.cores, tests.runs, tests.granted], [2, 2, 3, 2, 2]);
  assert.deepEqual(tests.leases.map((l) => [l.task, l.kind, l.requested, l.granted]), [['T1', 'gate', 4, 1], ['T2', 'worker', 8, 1]]);
  gate.release();
  worker.release();
  assert.match(h.ok(['status']), /^test threads: budget 2 of 2 on 3 cores, other work load 0; 0 runs hold 0 of 0 requested$/m);
});

test('CPU pressure or load past the defer lines steps a run down by the overshoot, once per interval and not below one thread a run', (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { cores: 8, load: 0 });
  const lease = G.testLease({ env: h.env, stateDir: h.state }, { requested: 4, task: 'T1' });
  t.after(() => lease.release());
  assert.equal(lease.grant, 4);
  // Pressure 80 against a line of 60 cuts the threads held by 60/80: 4 becomes 3,
  // whoever caused it, the run's own files included.
  writeHost(host, { cores: 8, load: 0, cpuSome: 80 });
  assert.equal(lease.refresh().grant, 3);
  // The next step waits for the interval, so a reading that lags does not ratchet the run down.
  assert.equal(lease.refresh().grant, 3);
  // No growth past the line: a second run gets its one thread out of what is held.
  const second = G.testLease({ env: h.env, stateDir: h.state }, { requested: 4, task: 'T2' });
  t.after(() => second.release());
  assert.equal(second.grant, 1);
  assert.ok(lease.refresh().grant + second.refresh().grant <= 3, 'no growth past what the runs held');
  second.release();
  // Load past the cores is other work: the room itself shrinks.
  writeHost(host, { cores: 8, load: 20 });
  assert.equal(lease.refresh().grant, 1);
});

// A broker in this process, as in the spawn monitor, on the test's fake host
// with a short recheck interval; and a raw connection to it, as an agent
// controls one.
async function brokerFixture(t) {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  writeHost(host, { cores: 8, load: 0 });
  const saved = { root: process.env.TOWER_CRANE_HOST_ROOT, intervals: process.env.TOWER_CRANE_INTERVALS };
  process.env.TOWER_CRANE_HOST_ROOT = host;
  process.env.TOWER_CRANE_INTERVALS = JSON.stringify({ test_grant: 300 });
  t.after(() => {
    for (const [name, value] of [['TOWER_CRANE_HOST_ROOT', saved.root], ['TOWER_CRANE_INTERVALS', saved.intervals]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const file = path.join(h.base, 'brokers', 'worker-T1-1', B.FILE);
  const broker = await B.start({ state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'codex', cwd: h.repo, broker: file });
  t.after(() => broker.close());
  const raw = async () => {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Wherever the broker listens on this platform: its socket or named pipe, else its TCP port.
    const c = { sock: b.socket ? net.connect(b.socket) : net.connect(b.port, b.host), lines: [], closed: false };
    t.after(() => c.sock.destroy());
    let buf = '';
    c.sock.setEncoding('utf8').on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) { c.lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
    });
    c.sock.on('close', () => { c.closed = true; });
    c.sock.on('error', () => {});
    c.sock.write(`${JSON.stringify({ token: b.token, tests: { request: 2 } })}\n`);
    await waitUntil(() => c.lines.length >= 1 || c.closed, { what: 'the grant' });
    return c;
  };
  return { h, file, raw };
}

test('a sandboxed agent\'s broker leases one run at a time and tells a second one to take one thread', async (t) => {
  const { h, file } = await brokerFixture(t);
  const first = await B.testGrantSession(file, 2);
  t.after(() => first.close());
  await assert.rejects(B.testGrantSession(file, 2), (e) => e.leaseHeld === true && /already holds a test-thread lease/.test(e.message));
  assert.equal(leases(h).length, 1);
  first.close();
  await waitUntil(() => leases(h).length === 0, { what: 'the first lease is released' });
  const again = await B.testGrantSession(file, 2);
  t.after(() => again.close());
  assert.equal(again.state.grant, 2, 'a run after the first one ended gets a lease');
});

test('a flood of rechecks on a broker connection gets one registry refresh and one answer per interval', async (t) => {
  const { raw } = await brokerFixture(t);
  const c = await raw();
  assert.equal(c.lines[0].grant, 2);
  c.sock.write('\n'.repeat(1000));
  await waitUntil(() => c.lines.length >= 2, { what: 'the coalesced answer' });
  c.sock.write('\n');
  await waitUntil(() => c.lines.length >= 3, { what: 'the next answer' });
  assert.equal(c.lines.length, 3, `a thousand rechecks and one more got two answers, not ${c.lines.length - 1}`);
});

test('a broker connection whose line outgrows a request is ended, and its lease with it', async (t) => {
  const { h, raw } = await brokerFixture(t);
  const c = await raw();
  assert.equal(leases(h).length, 1);
  c.sock.write(`${'x'.repeat((1 << 20) + 1)}\n`);
  await waitUntil(() => c.closed || c.lines.length > 1, { what: 'an answer or the end of the connection' });
  assert.equal(c.closed, true, 'the broker ends a connection whose line outgrows a request');
  await waitUntil(() => leases(h).length === 0, { what: 'the lease of the ended connection is released' });
});

test('the core kept back covers a little other work, so a 4-core host with a gate and its runner still grants three threads', (t) => {
  const h = makeRepo(t);
  h.init();
  const host = h.env.TOWER_CRANE_HOST_ROOT;
  // Half a core of other work: the gate's CLI, the CI agent.
  writeHost(host, { cores: 4, load: 0.5 });
  const lease = G.testLease({ env: h.env, stateDir: h.state }, { requested: 3, task: 'T1' });
  t.after(() => lease.release());
  assert.equal(lease.grant, 3);
  // Past one core, other work comes off the budget.
  writeHost(host, { cores: 4, load: 2 });
  assert.equal(lease.refresh().grant, 2);
});
