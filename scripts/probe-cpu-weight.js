'use strict';

// Host-only: real user scopes, compiler processes and kernel CPU scheduling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const C = require('../lib/containment');
const G = require('../lib/governor');
const gates = require('../lib/gates/common');
const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'lib', 'containment-runner.js');
const TIMEOUT = 8 * 60000;

function runOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function checkRun(result, label) {
  assert.ok(result.status === 0 && !result.error && !result.signal,
    `${label}: status ${result.status}, signal ${result.signal || 'none'}${result.error ? `, ${result.error.message}` : ''}\n${runOutput(result)}`);
}

function parseRun(result, label) {
  checkRun(result, label);
  try { return JSON.parse(result.stdout.trim()); }
  catch (error) { throw new Error(`${label}: invalid JSON\n${runOutput(result)}`, { cause: error }); }
}

function readback() {
  const group = path.dirname(C.currentGroup());
  const unit = path.basename(group);
  const weight = Number(cp.execFileSync('systemctl', ['--user', 'show', unit, '-p', 'CPUWeight', '--value'],
    { encoding: 'utf8', timeout: 5000 }).trim());
  return { unit, group, systemd_weight: weight, kernel_weight: Number(fs.readFileSync(path.join(group, 'cpu.weight'), 'utf8')) };
}

function caps() {
  const limits = C.resolveGate();
  // Independent test scopes retain the gate's slice and at least its caps.
  for (let dir = C.currentGroup(); dir.startsWith('/sys/fs/cgroup/'); dir = path.dirname(dir)) {
    for (const [key, file] of [['tasks_max', 'pids.max'], ['memory_max_bytes', 'memory.max']]) {
      const value = Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
      if (Number.isSafeInteger(value) && value > 0) limits[key] = Math.min(limits[key], value);
    }
  }
  return limits;
}

async function scope(mode, weight, action) {
  const unit = `tower-crane-${process.pid}-${crypto.randomBytes(8).toString('hex')}.scope`;
  const slice = C.callerSlice();
  const limits = caps();
  const runner = [process.execPath, RUNNER, JSON.stringify({ ...limits, cpuWeight: weight }),
    mode === 'dbus' ? `@${unit}:${slice}` : '', unit, process.execPath, __filename, action];
  const argv = mode === 'dbus' ? runner
    : ['systemd-run', ...C.scopeArguments(unit, slice, limits, { CPUWeight: '999' }, weight), ...runner];
  const result = await gates.treeExec(argv[0], argv.slice(1), {
    cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' }, timeout: TIMEOUT,
  });
  return parseRun(result, `${mode} scope ${action}`);
}

async function nestedWeights() {
  const reports = [];
  for (const [kind, expected] of [['worker', 200], ['tests', 7]]) {
    const child = C.spawn(process.execPath, ['-e', `
const fs = require('node:fs');
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
console.log(JSON.stringify({ group: C.currentGroup(), weight: Number(fs.readFileSync(C.currentGroup() + '/../cpu.weight', 'utf8')) }));
`], { cpuWeight: G.cpuWeight({ governor: { cpu_weight: { agents: 200, gates: 7 } } }, kind),
      resources: caps(), env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    const status = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(status, 0, Buffer.concat(errors).toString());
    const report = JSON.parse(Buffer.concat(output).toString());
    assert.equal(report.weight, expected);
    assert.ok(report.group.startsWith(path.dirname(C.currentGroup()) + '/nested-'), report.group);
    reports.push({ kind, ...report });
  }
  return reports;
}

function cpuGate() {
  const workers = Array.from({ length: os.availableParallelism() }, () => new Worker(`
const { parentPort } = require('node:worker_threads');
let x = 1;
const spin = () => { for (let i = 0; i < 1000000; i++) x = Math.imul(x ^ i, 1664525) + 1013904223; };
// Warm a full batch before readiness so JIT work is outside timed builds.
spin();
parentPort.postMessage('ready');
for (;;) spin();
`, { eval: true }));
  Promise.all(workers.map((worker) => new Promise((resolve) => worker.once('message', resolve))))
    .then(() => console.log('ready'));
  // The probe kills the scope when measurements finish; this is the crash backstop.
  setTimeout(() => process.exit(1), TIMEOUT); // wait-allow: finite host measurement deadline
}

const summary = (runs) => ({ median_ms: [...runs].sort((a, b) => a - b)[1], min_ms: Math.min(...runs), max_ms: Math.max(...runs), runs_ms: runs });

function comparison(before, withGate) {
  for (const samples of [before, withGate]) {
    assert.ok(Array.isArray(samples) && samples.length === 3 && samples.every((n) => Number.isFinite(n) && n > 0),
      'a comparison needs three positive finite timings per condition');
  }
  const baseline = summary(before);
  const contended = summary(withGate);
  const signed = (contended.median_ms - baseline.median_ms) / baseline.median_ms;
  return { before: baseline, with_gate: contended, signed_change: signed, absolute_change: Math.abs(signed) };
}

async function measureTrials({ build, startGate, waitGate, stopGate }) {
  const before = [];
  const withGate = [];
  const contended = async (trial) => {
    const gate = startGate();
    try {
      await waitGate(gate);
      withGate.push(await build('with_gate', trial, gate));
    } finally { await stopGate(gate); }
  };
  // Nearby controls and alternating order reduce drift from other host work.
  for (let trial = 0; trial < 3; trial++) {
    if (trial % 2 === 0) {
      before.push(await build('before', trial));
      await contended(trial);
    } else {
      await contended(trial);
      before.push(await build('before', trial));
    }
  }
  return comparison(before, withGate);
}

function cpuReading(group) {
  const usage = /^usage_usec (\d+)$/m.exec(fs.readFileSync(path.join(group, 'cpu.stat'), 'utf8'));
  assert.ok(usage && Number.isSafeInteger(Number(usage[1])), `missing CPU usage counter in ${group}`);
  return { group, weight: Number(fs.readFileSync(path.join(group, 'cpu.weight'), 'utf8')),
    cpu_max: fs.readFileSync(path.join(group, 'cpu.max'), 'utf8').trim(), usage_usec: Number(usage?.[1]) };
}

function hostReading() {
  const reading = G.probe();
  return { load: reading.load, cpu_some_avg10: reading.pressure.cpu?.some.avg10, cpu_some_avg60: reading.pressure.cpu?.some.avg60 };
}

async function benchmark() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const project = fs.mkdtempSync(path.join(cache, 'tc-other-build-'));
  const traces = [];
  let reported = false;
  try {
    const cores = os.availableParallelism();
    const objects = Array.from({ length: 2 * cores }, (_, i) => `unit-${i}.o`);
    // Fixed compiler work, no network, no shared build cache, all available CPUs.
    const source = Array.from({ length: 256 }, (_, f) =>
      `unsigned f${f}(unsigned x) {\n${Array.from({ length: 80 }, (_, i) => `x = (x ^ ${i + f + 1}u) * 1664525u + 1013904223u;`).join('\n')}\nreturn x;\n}`).join('\n');
    for (let i = 0; i < objects.length; i++) fs.writeFileSync(path.join(project, `unit-${i}.c`), source);
    fs.writeFileSync(path.join(project, 'Makefile'), `all: ${objects.join(' ')}\n%.o: %.c\n\tcc -O2 -c $< -o $@\n`);
    const build = async (condition, trial, gate) => {
      for (const object of objects) fs.rmSync(path.join(project, object), { force: true });
      const trace = { condition, trial, host_before: hostReading() };
      traces.push(trace);
      const gateBefore = gate ? cpuReading(gate.cpu.group) : null;
      const start = performance.now();
      const result = await gates.treeExec('make', ['-s', '-j', String(cores)], {
        cwd: project, resources: caps(), cpuWeight: G.cpuWeight({}, 'worker'), timeout: 60000,
        env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
        onSpawn(_pid, containment) {
          if (!containment?.group) return;
          try { trace.build_cpu = cpuReading(containment.group); }
          catch (error) { trace.build_cpu = { error: error.message }; }
        },
      });
      trace.elapsed_ms = performance.now() - start;
      trace.host_after = hostReading();
      checkRun(result, `build ${condition} ${trial}`);
      assert.equal(trace.build_cpu?.weight, G.cpuWeight({}, 'worker'), JSON.stringify(trace));
      if (gate) {
        assert.equal(gate.child.exitCode, null, 'CPU gate must run throughout each build');
        assert.equal(gate.child.signalCode, null, 'CPU gate must run throughout each build');
        const after = cpuReading(gate.cpu.group);
        assert.equal(after.weight, G.cpuWeight({}, 'tests'));
        assert.ok(after.usage_usec > gateBefore.usage_usec, 'CPU gate must consume CPU during the build');
        trace.gate_cpu = { ...after, usage_usec: after.usage_usec - gateBefore.usage_usec,
          core_share: (after.usage_usec - gateBefore.usage_usec) / (trace.elapsed_ms * 1000 * cores) };
      }
      return trace.elapsed_ms;
    };
    await build('warmup', null);
    const measured = await measureTrials({
      build,
      startGate() {
        const child = C.spawn(process.execPath, [__filename, '--cpu-gate'], {
          cpuWeight: G.cpuWeight({}, 'tests'), resources: caps(),
          env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const gate = { child, closed: false };
        gate.close = new Promise((resolve) => child.once('close', () => { gate.closed = true; resolve(); }));
        gate.ready = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('gate startup timed out')), 30000); // wait-allow: bounded startup
          let output = '';
          let errors = '';
          child.stderr.on('data', (chunk) => { errors += chunk; });
          child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('close', () => { clearTimeout(timer); reject(new Error(`gate exited before startup\n${errors}`)); });
        });
        return gate;
      },
      async waitGate(gate) {
        await gate.ready;
        gate.cpu = cpuReading(path.dirname(C.currentGroup(gate.child.pid)));
        assert.equal(gate.cpu.weight, G.cpuWeight({}, 'tests'));
      },
      async stopGate(gate) {
        if (!gate.closed && gate.child.exitCode === null && gate.child.signalCode === null) gate.child.kill('SIGKILL');
        await gate.close;
      },
    });
    const report = { trials: traces, host: os.hostname(), cores,
      compiler: cp.execFileSync('cc', ['--version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0],
      workload: 'independent generated C project, 256 functions per translation unit, 2 units per core, cc -O2, make -j all cores',
      order: 'three paired controls with alternating before/with order; gate workers warm up before ready',
      build_weight: G.cpuWeight({}, 'worker'), gate_weight: G.cpuWeight({}, 'tests'), ...measured };
    console.log(JSON.stringify(report));
    reported = true;
    assert.ok(measured.absolute_change < 0.1, `median build time changed ${(measured.signed_change * 100).toFixed(2)}%, absolute change must be under 10%`);
  } catch (error) {
    if (!reported) console.error(JSON.stringify({ partial_trials: traces }));
    throw error;
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

async function main() {
  const action = process.argv[2];
  if (action === '--readback') return console.log(JSON.stringify({ ...readback(), nested: await nestedWeights() }));
  if (action === '--benchmark') return benchmark();
  if (action === '--cpu-gate') return cpuGate();
  assert.equal(process.platform, 'linux', 'CPU weight acceptance needs a Linux host');
  assert.equal(fs.statSync('/').uid, 0, 'run outside the worker sandbox with the host root mapping');
  assert.ok(C.canScope(), 'requires delegated cgroups and a user systemd manager');
  const results = [];
  for (const mode of ['dbus', 'cli']) {
    for (const weight of [G.cpuWeight({}, 'worker'), G.cpuWeight({}, 'tests'), G.cpuWeight({ governor: { cpu_weight: { gates: 7 } } }, 'tests')]) {
      const result = await scope(mode, weight, '--readback');
      assert.equal(result.systemd_weight, weight);
      assert.equal(result.kernel_weight, weight);
      results.push({ mode, ...result });
    }
  }
  console.log(JSON.stringify({ scope_readback: results }));
  console.log(JSON.stringify({ build_contention: await scope('dbus', 100, '--benchmark') }));
}

if (require.main === module) main().catch((error) => { console.error(error.stack); process.exitCode = 1; });

module.exports = { summary, checkRun, parseRun, comparison, measureTrials };
