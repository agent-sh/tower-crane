'use strict';

// Run on the host so /proc contains the host fleet, not the worker namespace.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const assert = require('node:assert/strict');
const BASE = '26f0b38e2d8c9497f85115db4a5f47c19fd468a6';
const root = path.resolve(__dirname, '..');

function containment(version) {
  if (version === 'after') return require('../lib/containment');
  const filename = path.join(root, 'lib', 'containment.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(cp.execFileSync('git', ['show', `${BASE}:lib/containment.js`],
    { cwd: root, encoding: 'utf8', timeout: 5000 }), filename);
  return loaded.exports;
}

function enterMeasurementGroup(group, C) {
  const caller = C.currentGroup();
  if (!group || path.dirname(group) !== caller || !/^keeper-cpu-[a-zA-Z0-9]+$/.test(path.basename(group))) {
    throw new Error('measurement requires a private child cgroup');
  }
  if (fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim()) {
    throw new Error('measurement cgroup is already occupied');
  }
  fs.writeFileSync(path.join(group, 'cgroup.procs'), String(process.pid));
  assert.equal(C.currentGroup(), group, 'measurement must enter its private cgroup before guarding it');
}

function measurementRun(version) {
  // A private child stays inside the caller's resource fence. Any keeper kill
  // targets only this measurement worker, including on the baseline's error path.
  const group = fs.mkdtempSync(path.join(containment('after').currentGroup(), 'keeper-cpu-'));
  try {
    const result = cp.spawnSync(process.execPath, [__filename, version, group],
      { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmdirSync(group);
  }
}

async function measure(version, group) {
  const C = containment(version);
  enterMeasurementGroup(group, C);
  let scans = 0;
  const readdir = fs.readdirSync;
  fs.readdirSync = function (dir, ...args) {
    if (dir === '/proc') scans++;
    return readdir.call(this, dir, ...args);
  };
  await C.guardRemaining({ group, rows: [],
    baseline: C.counters(group), limits: { tasks_max: Number.MAX_SAFE_INTEGER, memory_max_bytes: Number.MAX_SAFE_INTEGER } });
  setTimeout(() => {
    const cpu = process.cpuUsage();
    const started = performance.now();
    const warmScans = scans;
    setTimeout(() => {
      const used = process.cpuUsage(cpu);
      const wall = performance.now() - started;
      console.log(JSON.stringify({ version, cpu_ms_per_second: (used.user + used.system) / wall,
        proc_scans: scans - warmScans, elapsed_ms: wall }));
      process.exit(0);
    }, 3000); // wait-allow: bounded CPU measurement window
  }, 500); // wait-allow: exclude module startup and initial page-size discovery
}

async function main() {
  if (process.platform !== 'linux') throw new Error('keeper CPU probe requires a Linux cgroup host');
  const count = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).length;
  if (fs.statSync('/').uid !== 0) throw new Error('run outside the worker sandbox with the host root mapping');
  if (process.argv[2]) return measure(process.argv[2], process.argv[3]);
  const latency = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    cp.execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,lstart=,command='],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    latency.push(performance.now() - started);
  }
  const readings = { before: [], after: [] };
  for (let i = 0; i < 3; i++) {
    for (const version of ['before', 'after']) {
      const reading = measurementRun(version);
      assert.equal(reading.proc_scans === 0, version === 'after', JSON.stringify(reading));
      readings[version].push(reading);
    }
  }
  const summarize = values => {
    const sorted = values.toSorted((a, b) => a - b);
    return { median: sorted[1], min: sorted[0], max: sorted[2] };
  };
  const before = summarize(readings.before.map(row => row.cpu_ms_per_second));
  const after = summarize(readings.after.map(row => row.cpu_ms_per_second));
  console.log(JSON.stringify({ baseline_sha: BASE, host_processes: count,
    ps_latency_ms: summarize(latency), cpu_ms_per_keeper_second: { before, after },
    reduction_percent: 100 * (1 - after.median / before.median), readings }, null, 2));
  assert.ok(after.median < before.median, 'cgroup polling must cost less CPU than host-wide snapshots');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { enterMeasurementGroup, measurementRun };
