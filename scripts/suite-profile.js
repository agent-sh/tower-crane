#!/usr/bin/env node
'use strict';

// Profiles a full suite run: per-file and per-test wall time, and how much of
// it the test's process tree spent on CPU. The rest is waiting: on timers,
// child processes that run detached, I/O and the scheduler on a loaded host.
//
//   node scripts/suite-profile.js [--test-concurrency=3] [--top 30] [--json out.json] [files...]
//
// It runs test/run.js with this file preloaded into every test process. A test's
// CPU is its process's own plus that of the children it reaped while it ran; a
// detached process another CLI started is reaped by init, so its CPU counts as
// waiting. Tests that overlap in one process (describe concurrency) share their
// CPU and are marked as overlapped; their file totals still hold. Linux only,
// since children's CPU comes from /proc/self/stat.

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
  return {
    files: [...byFile.values()].sort((a, b) => b.wall_ms - a.wall_ms),
    tests: leaves.map((r) => ({ file: rel(r.file), name: r.name, wall_ms: r.wall_ms, cpu_ms: r.overlapped ? null : r.cpu_ms }))
      .sort((a, b) => b.wall_ms - a.wall_ms),
    test_count: leaves.length,
    test_wall_ms: sum(leaves, 'wall_ms'),
    serial_wall_ms: sum(serial, 'wall_ms'),
    serial_cpu_ms: sum(serial, 'cpu_ms'),
    file_wall_ms: sum([...byFile.values()], 'wall_ms'),
    file_cpu_ms: sum([...byFile.values()], 'cpu_ms'),
  };
}

const share = (wait, wall) => (wall > 0 ? `${Math.round(100 * Math.max(0, wait) / wall)}%` : '-');
const sec = (ms) => (ms / 1000).toFixed(1);

function report(s, { wall_ms: wall, concurrency, top }) {
  const lines = [];
  lines.push(`suite wall ${sec(wall)} s at ${concurrency} file workers; ${s.test_count} tests, ${sec(s.test_wall_ms)} s summed test time`);
  lines.push(`files: ${sec(s.file_wall_ms)} s of process time, ${sec(s.file_cpu_ms)} s CPU: ${share(s.file_wall_ms - s.file_cpu_ms, s.file_wall_ms)} waiting`);
  lines.push(`serial tests: ${sec(s.serial_wall_ms)} s, ${sec(s.serial_cpu_ms)} s CPU: ${share(s.serial_wall_ms - s.serial_cpu_ms, s.serial_wall_ms)} waiting`);
  lines.push('', `| # | test | file | wall s | CPU s | waiting |`, '| ---: | --- | --- | ---: | ---: | ---: |');
  s.tests.slice(0, top).forEach((t, i) => lines.push(`| ${i + 1} | ${t.name.replace(/\|/g, '\\|')} | \`${t.file}\` | ${sec(t.wall_ms)} | ${t.cpu_ms === null ? '-' : sec(t.cpu_ms)} | ${t.cpu_ms === null ? 'overlapped' : share(t.wall_ms - t.cpu_ms, t.wall_ms)} |`));
  lines.push('', `| file | tests | process wall s | CPU s | waiting |`, '| --- | ---: | ---: | ---: | ---: |');
  for (const f of s.files.slice(0, top)) lines.push(`| \`${f.file}\` | ${f.tests} | ${sec(f.wall_ms)} | ${sec(f.cpu_ms)} | ${share(f.wall_ms - f.cpu_ms, f.wall_ms)} |`);
  return lines.join('\n');
}

if (require.main !== module) {
  if (process.env[DIR_ENV] && process.env.NODE_TEST_CONTEXT === 'child-v8') record(process.env[DIR_ENV]);
  module.exports = { summarize, report };
  return;
}

const cp = require('node:child_process');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
let top = 30;
let json = null;
let concurrency = 3;
const pass = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top') top = Number(args[++i]);
  else if (args[i] === '--json') json = path.resolve(args[++i]);
  else {
    const m = /^--test-concurrency=(\d+)$/.exec(args[i]);
    if (m) concurrency = Number(m[1]);
    pass.push(args[i]);
  }
}
if (!pass.some((a) => a.startsWith('--test-concurrency'))) pass.unshift(`--test-concurrency=${concurrency}`);
const base = process.env.TOWER_CRANE_TEST_TMP || process.env.TMPDIR || require('node:os').tmpdir();
fs.mkdirSync(base, { recursive: true });
const dir = fs.mkdtempSync(path.join(base, 'suite-profile-'));
const started = Date.now();
const result = cp.spawnSync(process.execPath, [path.join(root, 'test', 'run.js'), `--require=${__filename}`, ...pass], {
  cwd: root, stdio: 'inherit', env: { ...process.env, [DIR_ENV]: dir },
});
const wall = Date.now() - started;
const records = fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
fs.rmSync(dir, { recursive: true, force: true });
const s = summarize(records, root);
console.log(`\n${report(s, { wall_ms: wall, concurrency, top })}`);
if (json) fs.writeFileSync(json, JSON.stringify({ wall_ms: wall, concurrency, status: result.status, ...s }, null, 2));
process.exitCode = result.status ?? 1;
