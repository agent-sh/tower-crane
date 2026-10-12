'use strict';

const { ROOT, repo, task, submit, fs, path, cp, P, assert } = require('./harness');
const { shellQuote } = require(path.join(ROOT, 'lib/gates/common'));
const BIN = path.join(ROOT, 'bin/tower-crane.js');
const WATCHDOG_MS = 60000;

// Files and process closure are the barriers; the timer only bounds a broken probe.
function until(test, dirs, label) {
  return new Promise((resolve, reject) => {
    const watchers = [];
    const timer = setTimeout(() => finish(new Error(`probe watchdog: ${label}`)), WATCHDOG_MS);
    function finish(error, value) {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      if (error) reject(error);
      else resolve(value);
    }
    function check() {
      try { const value = test(); if (value) finish(null, value); }
      catch (e) { finish(e); }
    }
    for (const dir of dirs) watchers.push(fs.watch(dir, check));
    check();
  });
}

function processes(h) {
  const children = [];
  function start(args, extra = {}) {
    const child = cp.spawn(process.execPath, args, {
      cwd: h.repo, env: { ...h.env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tracked = { child, identity: { pid: child.pid, ...P.identity(child.pid) }, stdout: '', stderr: '', exit: null };
    for (const key of ['stdout', 'stderr']) child[key].on('data', (data) => {
      tracked[key] = (tracked[key] + data).slice(-8000);
    });
    tracked.closed = new Promise((resolve) => {
      child.once('error', (error) => { tracked.exit = { error: error.message }; resolve(tracked.exit); });
      child.once('close', (code, signal) => {
        tracked.exit = { code, signal };
        fs.writeFileSync(path.join(h.markers, `closed-${child.pid}`), JSON.stringify(tracked.exit));
        resolve(tracked.exit);
      });
    });
    children.push(tracked);
    return tracked;
  }
  async function close() {
    for (const p of children) {
      if (!p.exit && P.processState(p.identity) !== 'exited') {
        try { process.kill(-p.child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    }
    // Gate commands have their own process group, separate from the executor.
    for (const p of h.gates()) {
      if (P.processState(p) !== 'exited') {
        try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    }
    await Promise.all(children.map((p) => boundedClose(p)));
    assert.deepEqual(h.gates().filter((p) => P.processState(p) !== 'exited').map((p) => p.pid), [],
      'owned gate processes must exit before removing their scratch repository');
  }
  return { start, close };
}

async function boundedClose(p) {
  let timer;
  try {
    return await Promise.race([p.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`process did not close: ${p.child.pid}; ${p.stderr}`)), WATCHDOG_MS);
    })]);
  } finally { clearTimeout(timer); }
}

function setup() {
  assert.equal(process.platform, 'linux', 'signals and process-group probes require Linux');
  const h = repo();
  h.init(['--base', 'main']);
  h.markers = path.join(h.base, 'markers');
  fs.mkdirSync(h.markers);
  h.gates = () => {
    const file = path.join(h.markers, 'gates.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  const gate = path.join(h.base, 'gate.js');
  fs.writeFileSync(gate, `
const fs = require('node:fs'), path = require('node:path');
const P = require(${JSON.stringify(path.join(ROOT, 'lib/processes'))});
const dir = ${JSON.stringify(h.markers)}, log = path.join(dir, 'gates.jsonl');
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length + 1 : 1;
const keys = ['TOWER_CRANE_TASK', 'TOWER_CRANE_AGENT', 'HOME', 'XDG_CACHE_HOME'];
const release = path.join(dir, 'release-' + n);
const watcher = fs.watch(dir, () => { if (fs.existsSync(release)) { watcher.close(); process.exit(127); } });
fs.appendFileSync(log, JSON.stringify({run: n, pid: process.pid, ...P.identity(process.pid),
  env: Object.fromEntries(keys.map(k => [k, process.env[k] || null]))}) + '\\n');
if (fs.existsSync(release)) { watcher.close(); process.exit(127); }
`);
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--executors', '1',
    '--tests-cmd', `exec ${shellQuote(process.execPath)} ${shellQuote(gate)}`,
    '--clean-cmd', 'node -e "process.exit(127)"']);
  for (let i = 0; i < 2; i++) task(h, 'code', `Process probe ${i + 1}`);
  h.waitArgs = [BIN, 'wait', '--after', '0', '--types', 'never', '--follow', '--agent', 'orchestrator'];
  h.release = (n) => fs.writeFileSync(path.join(h.markers, `release-${n}`), '');
  return h;
}

async function queueSecond(h) {
  // This watcher has no free executor. It records the pending sources and exits.
  const r = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0']);
  assert.equal(r.code, 2, r.stderr);
  assert.ok(h.events().some((e) => e.cmd === 'automation queued' && e.task === 'T2'));
}

async function terminatedWaiter(killGate) {
  const h = setup();
  const manager = processes(h);
  try {
    submit(h, 'T1');
    submit(h, 'T2');
    const ack = path.join(h.markers, 'signal-received');
    const observer = path.join(h.base, 'signal-observer.js');
    // A one-shot observer acknowledges signal delivery without changing its disposition.
    fs.writeFileSync(observer, `process.prependOnceListener('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(ack)}, 'received'));`);
    const waiter = manager.start(['--require', observer, ...h.waitArgs]);
    await until(() => h.gates()[0], [h.markers], 'first gate start');
    const first = h.gates()[0];
    await queueSecond(h);
    waiter.child.kill('SIGTERM');
    await until(() => fs.existsSync(ack), [h.markers], 'executor received SIGTERM');
    const firstAliveAfterSignal = P.processState(first) === 'running';
    if (killGate && firstAliveAfterSignal) process.kill(-first.pid, 'SIGTERM');
    else h.release(1);
    await until(() => h.gates().length >= 2 || waiter.exit, [h.markers, h.state], 'next gate or executor exit');
    const second = h.gates()[1];
    const starts = h.events().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running');
    const gateEntry = h.snapshot().tasks.tasks[0].evidence.find((e) => e.type === 'tests');
    const next = starts.find((e) => e.task === 'T2' && e.detail.pid === waiter.child.pid);
    return {
      held: !second && !!waiter.exit,
      observed: {
        signals: killGate ? ['SIGTERM to executor', 'SIGTERM to first gate process group'] : ['SIGTERM to executor'],
        firstGateAliveAfterExecutorSignal: firstAliveAfterSignal,
        firstGateCommandSignal: gateEntry?.commands?.find((c) => c.command.startsWith('exec '))?.signal ?? null,
        secondGateStarted: !!second, sameExecutorStartedT2: !!next,
        executorStillAlive: !waiter.exit && P.processState(waiter.identity) === 'running',
        cleanup: 'SIGKILL to owned executor and remaining owned gate groups',
      },
    };
  } finally { await manager.close(); await h.cleanup(); }
}

async function supervisor() {
  const h = setup();
  const manager = processes(h);
  try {
    const tools = path.join(h.base, 'tools');
    fs.mkdirSync(tools);
    const workerLog = path.join(h.markers, 'worker.json');
    const worker = path.join(tools, 'codex');
    fs.writeFileSync(worker, `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
if (!process.env.TOWER_CRANE_TASK) { console.log('codex fixture'); process.exit(0); }
const keys = ['TOWER_CRANE_TASK', 'TOWER_CRANE_AGENT', 'HOME', 'XDG_CACHE_HOME'];
fs.writeFileSync(${JSON.stringify(workerLog)}, JSON.stringify({pid: process.pid,
  env: Object.fromEntries(keys.map(k => [k, process.env[k] || null]))}));
const run = args => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...args, '--agent', process.env.TOWER_CRANE_AGENT], {stdio: 'pipe'});
run(['claim', process.env.TOWER_CRANE_TASK]);
run(['submit', process.env.TOWER_CRANE_TASK, '--sha', ${JSON.stringify(h.git(['rev-parse', 'HEAD']))}]);
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
    fs.chmodSync(worker, 0o755);
    const gh = path.join(tools, 'gh');
    fs.writeFileSync(gh, `#!${process.execPath}\nif (process.argv[2] === 'auth') console.log('fixture-token'); else process.exit(1);\n`);
    fs.chmodSync(gh, 0o755);
    h.env.PATH = tools + path.delimiter + h.env.PATH;
    h.env.XDG_CACHE_HOME = path.join(h.base, 'dispatcher-cache');
    fs.mkdirSync(h.env.XDG_CACHE_HOME);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Exercise process lifecycle in this scratch repo.\n' });
    h.ok(['ladder', 'set', 'medium', '--harness', 'codex']);
    const spawned = manager.start([BIN, 'spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
    await until(() => h.gates()[0] || spawned.exit, [h.markers, h.state], 'supervisor gate start');
    assert.ok(h.gates()[0], `stub spawn failed: ${spawned.stderr}`);
    const exited = h.events().find((e) => e.cmd === 'spawn exit' && e.task === 'T1');
    assert.ok(exited, 'worker exit receipt precedes the first gate');
    const launch = h.events().find((e) => e.cmd === 'spawn' && e.task === 'T1');
    submit(h, 'T2');
    await queueSecond(h);
    h.release(1);
    await until(() => h.gates().length >= 2 || spawned.exit, [h.markers, h.state], 'supervisor takes unrelated queued task');
    const second = h.gates()[1];
    assert.ok(second, `second task did not start: ${spawned.stderr}`);
    const executor = h.events().findLast((e) => e.cmd === 'automation' && e.task === 'T2' && e.detail.phase === 'running');
    const workerEnv = JSON.parse(fs.readFileSync(workerLog, 'utf8'));
    const workerExited = P.processState({ pid: launch.detail.pid, host: launch.detail.host, start_ticks: launch.detail.start_ticks }) === 'exited';
    const inheritedWorkerEnv = Object.keys(workerEnv.env).filter((k) => workerEnv.env[k] !== null && second.env[k] === workerEnv.env[k]);
    const observed = {
      workerExited, workerExitReceipt: exited.detail.code,
      supervisorRunsT2: executor?.detail.pid === launch.detail.monitor_pid,
      spawnWaitStillPending: !spawned.exit,
      workerEnv: workerEnv.env, secondGateEnv: second.env, inheritedWorkerEnv,
      dispatcherCache: h.env.XDG_CACHE_HOME,
      duration: 'event barriers only; no 3.5-hour wait',
    };
    h.release(2);
    const finished = await boundedClose(spawned);
    assert.equal(finished.code, 0, spawned.stderr);
    observed.spawnExitAfterGates = finished.code;
    return observed;
  } finally { await manager.close(); await h.cleanup(); }
}

let supervisorObservation;
async function observedSupervisor() {
  // Both conclusions concern the same run, avoiding another stub dispatch.
  supervisorObservation ||= await supervisor();
  return supervisorObservation;
}

module.exports = [
  { id: 'P01', surface: 'executor shutdown', expected: 'SIGTERM stops the executor before any queued task starts.',
    run: () => terminatedWaiter(false) },
  { id: 'P02', surface: 'executor shutdown', expected: 'After SIGTERM to executor and active gate, the executor does not start the next queued task.',
    run: () => terminatedWaiter(true) },
  { id: 'P03', surface: 'supervisor lifetime', expected: 'A worker supervisor can remain an executor after worker exit and drain another task through the shared queue.',
    async run() {
      const observed = await observedSupervisor();
      assert.ok(observed.workerExited && observed.supervisorRunsT2 && observed.spawnWaitStillPending);
      return { verdict: 'by design', observed };
    } },
  { id: 'P04', surface: 'supervisor environment', expected: 'A departed worker supervisor uses dispatcher identity and environment for another task gate.',
    async run() {
      const observed = await observedSupervisor();
      return { held: !observed.inheritedWorkerEnv.includes('TOWER_CRANE_TASK')
        && !observed.inheritedWorkerEnv.includes('TOWER_CRANE_AGENT'), observed };
    } },
];
