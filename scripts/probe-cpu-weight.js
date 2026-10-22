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
  assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
  return JSON.parse(result.stdout.trim());
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
parentPort.postMessage('ready');
let x = 1;
for (;;) { for (let i = 0; i < 1000000; i++) x = Math.imul(x ^ i, 1664525) + 1013904223; }
`, { eval: true }));
  Promise.all(workers.map((worker) => new Promise((resolve) => worker.once('message', resolve))))
    .then(() => console.log('ready'));
  // The probe kills the scope when measurements finish; this is the crash backstop.
  setTimeout(() => process.exit(1), TIMEOUT); // wait-allow: finite host measurement deadline
}

const summary = (runs) => ({ median_ms: [...runs].sort((a, b) => a - b)[1], min_ms: Math.min(...runs), max_ms: Math.max(...runs), runs_ms: runs });

async function benchmark() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const project = fs.mkdtempSync(path.join(cache, 'tc-other-build-'));
  let gate;
  try {
    const cores = os.availableParallelism();
    const objects = Array.from({ length: 2 * cores }, (_, i) => `unit-${i}.o`);
    // Fixed compiler work, no network, no shared build cache, all available CPUs.
    const source = Array.from({ length: 256 }, (_, f) =>
      `unsigned f${f}(unsigned x) {\n${Array.from({ length: 80 }, (_, i) => `x = (x ^ ${i + f + 1}u) * 1664525u + 1013904223u;`).join('\n')}\nreturn x;\n}`).join('\n');
    for (let i = 0; i < objects.length; i++) fs.writeFileSync(path.join(project, `unit-${i}.c`), source);
    fs.writeFileSync(path.join(project, 'Makefile'), `all: ${objects.join(' ')}\n%.o: %.c\n\tcc -O2 -c $< -o $@\n`);
    const build = async () => {
      for (const object of objects) fs.rmSync(path.join(project, object), { force: true });
      const start = performance.now();
      const result = await gates.treeExec('make', ['-s', '-j', String(cores)], {
        cwd: project, resources: caps(), cpuWeight: G.cpuWeight({}, 'worker'), timeout: 60000,
        env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
      });
      assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
      return performance.now() - start;
    };
    await build();
    const before = [];
    for (let i = 0; i < 3; i++) before.push(await build());
    gate = C.spawn(process.execPath, [__filename, '--cpu-gate'], {
      cpuWeight: G.cpuWeight({}, 'tests'), resources: caps(),
      env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gate startup timed out')), 30000); // wait-allow: bounded startup
      let output = '';
      gate.stdout.on('data', (chunk) => { output += chunk; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
      gate.once('error', (error) => { clearTimeout(timer); reject(error); });
      gate.once('close', () => { clearTimeout(timer); reject(new Error('gate exited before startup')); });
    });
    const after = [];
    for (let i = 0; i < 3; i++) {
      assert.equal(gate.exitCode, null, 'CPU gate must run throughout each build');
      after.push(await build());
    }
    const baseline = summary(before);
    const contended = summary(after);
    const change = Math.abs(contended.median_ms / baseline.median_ms - 1);
    const report = { host: os.hostname(), cores, compiler: cp.execFileSync('cc', ['--version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0],
      workload: 'independent generated C project, 256 functions per translation unit, 2 units per core, cc -O2, make -j all cores',
      build_weight: 100, gate_weight: 1, before: baseline, with_gate: contended, absolute_change: change };
    console.log(JSON.stringify(report));
    assert.ok(change < 0.1, `median build time changed ${(change * 100).toFixed(2)}%, must be under 10%`);
  } finally {
    if (gate && gate.exitCode === null) {
      gate.kill('SIGKILL');
      await new Promise((resolve) => gate.once('close', resolve));
    }
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

module.exports = { summary };
