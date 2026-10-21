#!/usr/bin/env node
'use strict';

// Profiles a full suite run: per-file and per-test wall time, and how much of
// it the test's process tree spent on CPU. The rest is waiting: on timers,
// child processes that run detached, I/O and the scheduler on a loaded host.
//
//   node scripts/suite-profile.js [--test-concurrency=3] [--top 30] [--json out.json] [--runs N]
//     [--baseline REF | --baseline-dir DIR] [files...]
//
// It runs test/run.js with this file preloaded into every test process. A test's
// CPU is its process's own plus that of the children it reaped while it ran; a
// detached process another CLI started is reaped by init, so its CPU counts as
// waiting. Tests that overlap in one process (describe concurrency) share their
// CPU and are marked as overlapped; their file totals still hold. Linux only,
// since children's CPU comes from /proc/self/stat. While the suite runs it also
// samples the host's load and its own cgroup: memory, CPU time (which counts
// detached processes too) and CPU pressure (PSI). It sets no wall limit.
//
// --baseline REF checks REF out in a detached worktree under the temp root and
// runs it and this checkout in turn, --runs times each, baseline first, so
// both see the same load. It prints each run and the medians, and exits 1
// unless the medians of this checkout's CPU seconds and of its longest file's
// wall time are both lower. --baseline-dir DIR uses a checkout already there.

const fs = require('node:fs');
const path = require('node:path');

const DIR_ENV = 'TC_SUITE_PROFILE_DIR';

function childCpuMs() {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // cutime and cstime, in clock ticks of 10 ms on Linux.
    return (Number(f[13]) + Number(f[14])) * 10;
  } catch {
    return 0;
  }
}
function cpuMs() {
  const own = process.cpuUsage();
  return (own.user + own.system) / 1000 + childCpuMs();
}

// Preloaded into a test file's process: one JSON line per finished test and one for the file.
// A test open while another starts deeper is its parent. A describe opens as
// its file loads, so only leaves whose own runs intersect count as overlapped.
function record(dir) {
  const dc = require('node:diagnostics_channel');
  const { performance } = require('node:perf_hooks');
  const out = path.join(dir, `${process.pid}.jsonl`);
  const lines = [];
  const open = [];
  let file = null;
  const began = performance.now();
  dc.subscribe('tracing:node.test:start', (c) => {
    if (c.name === '<root>') return;
    file ||= c.file;
    const run = { name: c.name, nesting: c.nesting, at: performance.now(), cpu: cpuMs(), parent: false };
    for (const other of open) if (other.nesting < c.nesting) other.parent = true;
    open.push(run);
  });
  dc.subscribe('tracing:node.test:end', (c) => {
    if (c.name === '<root>') return;
    const i = open.findIndex((run) => run.name === c.name && run.nesting === c.nesting);
    if (i < 0) return;
    const [run] = open.splice(i, 1);
    lines.push({ name: c.name, nesting: c.nesting, file: c.file, pid: process.pid, leaf: !run.parent,
      start_ms: run.at - began, wall_ms: performance.now() - run.at, cpu_ms: cpuMs() - run.cpu });
  });
  process.once('exit', () => {
    lines.push({ file, process: true, wall_ms: performance.now() - began, cpu_ms: cpuMs() });
    try { fs.appendFileSync(out, lines.map((line) => JSON.stringify(line)).join('\n') + '\n'); } catch {}
  });
}

// Leaf tests only: a describe or a test with subtests holds its children's time.
function summarize(records, root) {
  const rel = (file) => (file ? path.relative(root, file).split(path.sep).join('/') : '?');
  const byFile = new Map();
  const leaves = records.filter((r) => !r.process && r.leaf);
  const byPid = new Map();
  for (const r of leaves) byPid.set(r.pid, [...(byPid.get(r.pid) || []), r]);
  for (const list of byPid.values()) {
    list.sort((a, b) => a.start_ms - b.start_ms);
    let reach = -Infinity;
    let last = null;
    for (const r of list) {
      if (r.start_ms < reach) r.overlapped = last.overlapped = true;
      if (r.start_ms + r.wall_ms > reach) { reach = r.start_ms + r.wall_ms; last = r; }
    }
  }
  for (const r of records) {
    const f = rel(r.file);
    const entry = byFile.get(f) || { file: f, tests: 0, test_wall_ms: 0, test_cpu_ms: 0, wall_ms: 0, cpu_ms: 0 };
    if (r.process) {
      entry.wall_ms += r.wall_ms;
      entry.cpu_ms += r.cpu_ms;
    } else if (r.leaf) {
      entry.tests++;
      entry.test_wall_ms += r.wall_ms;
      if (!r.overlapped) entry.test_cpu_ms += r.cpu_ms;
    }
    byFile.set(f, entry);
  }
  const serial = leaves.filter((r) => !r.overlapped);
  const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0);
  const files = [...byFile.values()].sort((a, b) => b.wall_ms - a.wall_ms);
  return {
    files,
    tests: leaves.map((r) => ({ file: rel(r.file), name: r.name, wall_ms: r.wall_ms, cpu_ms: r.overlapped ? null : r.cpu_ms }))
      .sort((a, b) => b.wall_ms - a.wall_ms),
    test_count: leaves.length,
    test_wall_ms: sum(leaves, 'wall_ms'),
    serial_wall_ms: sum(serial, 'wall_ms'),
    serial_cpu_ms: sum(serial, 'cpu_ms'),
    file_wall_ms: sum(files, 'wall_ms'),
    file_cpu_ms: sum(files, 'cpu_ms'),
    longest_file: files[0] ? { file: files[0].file, wall_ms: files[0].wall_ms } : null,
  };
}

// A test name is a table cell: cut a long name, then escape the escape character and the cell separator.
const NAME_CHARS = 100;
const cell = (text) => (text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS - 3)}...` : text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const share = (wait, wall) => (wall > 0 ? `${Math.round(100 * Math.max(0, wait) / wall)}%` : '-');
const sec = (ms) => (ms / 1000).toFixed(1);
const mib = (bytes) => Math.round(bytes / 1048576);
const load = (x) => x.toFixed(1);

// What the run's own cgroup saw: lines for the report, or none where the host has no such files.
function hostLines(host, wall) {
  if (!host) return [];
  const lines = [`host: ${host.cores} cores; 1-minute load ${load(host.load_start)} at start, peak ${load(host.load_peak)}, ${load(host.load_end)} at end`];
  if (host.cpu_ms != null) lines.push(`CPU: ${sec(host.cpu_ms)} s in cgroup ${host.cgroup}, detached processes included`);
  if (host.pressure) {
    const p = host.pressure;
    lines.push(`CPU pressure: some ${sec(p.some_ms)} s (${share(p.some_ms, wall)} of wall), full ${sec(p.full_ms)} s (${share(p.full_ms, wall)}); avg10 peak some ${p.some_avg10_peak.toFixed(1)}%, full ${p.full_avg10_peak.toFixed(1)}%`);
  } else lines.push('CPU pressure: no cgroup cpu.pressure to read');
  lines.push(host.memory_peak == null ? 'memory: no cgroup memory.current to read'
    : `memory: peak ${mib(host.memory_peak - host.memory_start)} MiB above the start in cgroup ${host.cgroup}`);
  return lines;
}

// The summary comes last, so the tail of a long log, such as a host probe's receipt, holds it with the top tests.
function report(s, { wall_ms: wall, concurrency, top, host }) {
  const lines = [];
  lines.push(`| file | tests | process wall s | CPU s | waiting |`, '| --- | ---: | ---: | ---: | ---: |');
  for (const f of s.files.slice(0, top)) lines.push(`| \`${f.file}\` | ${f.tests} | ${sec(f.wall_ms)} | ${sec(f.cpu_ms)} | ${share(f.wall_ms - f.cpu_ms, f.wall_ms)} |`);
  lines.push('', `| # | test | file | wall s | CPU s | waiting |`, '| ---: | --- | --- | ---: | ---: | ---: |');
  s.tests.slice(0, top).forEach((t, i) => lines.push(`| ${i + 1} | ${cell(t.name)} | \`${t.file}\` | ${sec(t.wall_ms)} | ${t.cpu_ms === null ? '-' : sec(t.cpu_ms)} | ${t.cpu_ms === null ? 'overlapped' : share(t.wall_ms - t.cpu_ms, t.wall_ms)} |`));
  lines.push('', `suite wall ${sec(wall)} s at ${concurrency} file workers; ${s.test_count} tests, ${sec(s.test_wall_ms)} s summed test time`);
  if (s.longest_file) lines.push(`longest file: \`${s.longest_file.file}\` ${sec(s.longest_file.wall_ms)} s`);
  lines.push(`files: ${sec(s.file_wall_ms)} s of process time, ${sec(s.file_cpu_ms)} s CPU: ${share(s.file_wall_ms - s.file_cpu_ms, s.file_wall_ms)} waiting`);
  lines.push(`serial tests: ${sec(s.serial_wall_ms)} s, ${sec(s.serial_cpu_ms)} s CPU: ${share(s.serial_wall_ms - s.serial_cpu_ms, s.serial_wall_ms)} waiting`);
  lines.push(...hostLines(host, wall));
  return lines.join('\n');
}

// One run's measures for the comparison. CPU seconds are the cgroup's where it
// can be read, since that counts the detached processes the file sums miss.
function measures(run) {
  const cgroup = run.host?.cpu_ms;
  return {
    cpu_ms: cgroup ?? run.file_cpu_ms,
    cpu_source: cgroup == null ? 'file processes' : 'cgroup',
    longest_ms: run.longest_file?.wall_ms ?? 0,
  };
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Runs as [{ tree: 'baseline' | 'head', ... }] in the order they ran. ok is
// whether the head's medians are both below the baseline's.
function compare(runs) {
  const rows = runs.map((r) => ({ ...r, ...measures(r) }));
  const of = (tree) => rows.filter((r) => r.tree === tree);
  const lines = ['| run | tree | status | wall s | CPU s | file CPU s | longest file s | load start, peak, end | CPU pressure some s |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |'];
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.tree} | ${r.status === 0 ? 'passed' : `exit ${r.status}`} | ${sec(r.wall_ms)} | ${sec(r.cpu_ms)} | ${sec(r.file_cpu_ms)} | ${sec(r.longest_ms)} | ${r.host ? [r.host.load_start, r.host.load_peak, r.host.load_end].map(load).join(', ') : '-'} | ${r.host?.pressure ? sec(r.host.pressure.some_ms) : '-'} |`));
  const base = of('baseline');
  const head = of('head');
  const verdicts = [];
  let ok = base.length > 0 && head.length > 0;
  for (const [key, what] of [['cpu_ms', `CPU seconds (${head[0]?.cpu_source ?? 'none'})`], ['longest_ms', 'longest file wall s']]) {
    if (!base.length || !head.length) break;
    const b = median(base.map((r) => r[key]));
    const h = median(head.map((r) => r[key]));
    const lower = h < b;
    ok &&= lower;
    verdicts.push(`median of ${head.length}: ${what} head ${sec(h)} vs baseline ${sec(b)} (${b > 0 ? `${h >= b ? '+' : ''}${(100 * (h - b) / b).toFixed(1)}%` : '-'}): ${lower ? 'lower' : 'not lower'}`);
  }
  const failed = head.filter((r) => r.status !== 0).length;
  if (failed) {
    ok = false;
    verdicts.push(`${failed} of ${head.length} head runs failed`);
  }
  return { ok, text: [...lines, '', ...verdicts].join('\n') };
}

// Reads the run's own cgroup (v2), so the gate's caps and other sessions stay out of the numbers.
function cgroupDir() {
  try {
    const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    return line ? line.slice(3) : null;
  } catch {
    return null;
  }
}
function cgroupRead(cgroup, name) {
  try {
    return cgroup === null ? null : fs.readFileSync(path.join('/sys/fs/cgroup', cgroup, name), 'utf8');
  } catch {
    return null;
  }
}
// cpu.stat usage_usec, in ms.
function cgroupCpuMs(cgroup) {
  const m = /^usage_usec (\d+)$/m.exec(cgroupRead(cgroup, 'cpu.stat') || '');
  return m ? Number(m[1]) / 1000 : null;
}
// cpu.pressure: `some` is time at least one task waited for a CPU, `full` all of them.
function cgroupPressure(cgroup) {
  const text = cgroupRead(cgroup, 'cpu.pressure');
  if (!text) return null;
  const line = (kind) => {
    const m = new RegExp(`^${kind} avg10=([\\d.]+) avg60=[\\d.]+ avg300=[\\d.]+ total=(\\d+)$`, 'm').exec(text);
    return m ? { avg10: Number(m[1]), total_ms: Number(m[2]) / 1000 } : null;
  };
  const some = line('some');
  // A cgroup's file has a full line; the host-wide one may not.
  return some ? { some, full: line('full') || { avg10: 0, total_ms: 0 } } : null;
}

// A wall time means little without the load beside it, so the run samples the host while the suite runs.
function sampleHost() {
  const os = require('node:os');
  const cgroup = cgroupDir();
  const memory = () => {
    const text = cgroupRead(cgroup, 'memory.current');
    return text === null ? null : Number(text);
  };
  const cpuStart = cgroupCpuMs(cgroup);
  const pressureStart = cgroupPressure(cgroup);
  const host = { cores: os.availableParallelism(), cgroup, load_start: os.loadavg()[0], load_peak: 0, memory_start: memory(), memory_peak: null };
  let someAvg = 0;
  let fullAvg = 0;
  const tick = () => {
    host.load_peak = Math.max(host.load_peak, os.loadavg()[0]);
    const m = memory();
    if (m !== null && host.memory_start !== null) host.memory_peak = Math.max(host.memory_peak ?? m, m);
    const p = cgroupPressure(cgroup);
    if (p) { someAvg = Math.max(someAvg, p.some.avg10); fullAvg = Math.max(fullAvg, p.full.avg10); }
  };
  tick();
  const timer = setInterval(tick, 1000);
  return () => {
    clearInterval(timer);
    tick();
    const cpuEnd = cgroupCpuMs(cgroup);
    const pressureEnd = cgroupPressure(cgroup);
    return { ...host, load_end: os.loadavg()[0],
      cpu_ms: cpuStart === null || cpuEnd === null ? null : cpuEnd - cpuStart,
      pressure: pressureStart && pressureEnd ? { some_ms: pressureEnd.some.total_ms - pressureStart.some.total_ms,
        full_ms: pressureEnd.full.total_ms - pressureStart.full.total_ms, some_avg10_peak: someAvg, full_avg10_peak: fullAvg } : null };
  };
}

if (require.main !== module) {
  if (process.env[DIR_ENV] && process.env.NODE_TEST_CONTEXT === 'child-v8') record(process.env[DIR_ENV]);
  module.exports = { summarize, report, compare };
  return;
}

const cp = require('node:child_process');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
let top = 30;
let json = null;
let concurrency = 3;
let runs = 1;
let baselineRef = null;
let baselineDir = null;
const pass = [];
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top') top = Number(args[++i]);
  else if (args[i] === '--json') json = path.resolve(args[++i]);
  else if (args[i] === '--runs') {
    runs = Number(args[++i]);
    if (!Number.isInteger(runs) || runs < 1) fail('--runs takes a positive whole number');
  } else if (args[i] === '--baseline') baselineRef = args[++i];
  else if (args[i] === '--baseline-dir') baselineDir = path.resolve(args[++i]);
  else {
    const m = /^--test-concurrency=(\d+)$/.exec(args[i]);
    if (m) concurrency = Number(m[1]);
    pass.push(args[i]);
  }
}
if (baselineRef !== null && baselineDir !== null) fail('--baseline and --baseline-dir name the same thing; give one');
if (baselineRef === '' || baselineRef === undefined) fail('--baseline takes a commit');
if (!pass.some((a) => a.startsWith('--test-concurrency'))) pass.unshift(`--test-concurrency=${concurrency}`);
const base = process.env.TOWER_CRANE_TEST_TMP || process.env.TMPDIR || require('node:os').tmpdir();
fs.mkdirSync(base, { recursive: true });

function profileRun(tree) {
  const dir = fs.mkdtempSync(path.join(base, 'suite-profile-'));
  const started = Date.now();
  const stopSampling = sampleHost();
  const child = cp.spawn(process.execPath, [path.join(tree, 'test', 'run.js'), `--require=${__filename}`, ...pass], {
    cwd: tree, stdio: 'inherit', env: { ...process.env, [DIR_ENV]: dir },
  });
  return new Promise((resolve) => child.on('close', (status) => {
    const wall = Date.now() - started;
    const host = stopSampling();
    const records = fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    fs.rmSync(dir, { recursive: true, force: true });
    resolve({ wall_ms: wall, concurrency, status: status ?? 1, host, ...summarize(records, tree) });
  }));
}

const git = (...a) => cp.execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function main() {
  let worktree = null;
  if (baselineRef !== null) {
    const sha = git('rev-parse', '--verify', '--quiet', `${baselineRef}^{commit}`);
    worktree = path.join(fs.mkdtempSync(path.join(base, 'suite-baseline-')), 'tree');
    git('worktree', 'add', '--detach', worktree, sha);
    baselineDir = worktree;
  }
  const done = [];
  try {
    for (let i = 1; i <= runs; i++) {
      for (const [tree, dir] of baselineDir ? [['baseline', baselineDir], ['head', root]] : [['head', root]]) {
        console.log(`\n# suite profile: ${tree} run ${i} of ${runs} in ${dir}`);
        const r = await profileRun(dir);
        done.push({ tree, ...r });
        console.log(`\n${report(r, { wall_ms: r.wall_ms, concurrency, top, host: r.host })}`);
      }
    }
  } finally {
    if (worktree) {
      git('worktree', 'remove', '--force', worktree);
      fs.rmSync(path.dirname(worktree), { recursive: true, force: true });
    }
  }
  const last = done.findLast((r) => r.tree === 'head');
  const brief = (r) => ({ tree: r.tree, status: r.status, wall_ms: r.wall_ms, file_cpu_ms: r.file_cpu_ms, longest_file: r.longest_file, host: r.host });
  const comparison = baselineDir ? compare(done) : null;
  if (comparison) console.log(`\n${comparison.text}`);
  if (json) fs.writeFileSync(json, JSON.stringify({ ...last, runs: done.map(brief), comparison }, null, 2));
  process.exitCode = done.some((r) => r.tree === 'head' && r.status !== 0) || (comparison && !comparison.ok) ? 1 : 0;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
