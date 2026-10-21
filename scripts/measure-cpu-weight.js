#!/usr/bin/env node
'use strict';

// Host measurements for per-project slices and gate CPU weights (T485), run as
// tests gate host probes from the worktree root. Every scope is a transient
// user scope started with the engine's own scopeArguments, in the slice
// projectSlice names, and every busy process is pinned to the same few CPUs, so
// the scopes contend for them while the rest of the host stays free.
//
//   node scripts/measure-cpu-weight.js fairness
//     Four groups contend: a Tower Crane project's gate and agent, another
//     project's agent and a session scope outside Tower Crane. Each layout
//     prints every group's CPU-seconds and share.
//   node scripts/measure-cpu-weight.js gate WEIGHT [--summary]
//     One run of the same tests gate command in a project's slice at WEIGHT,
//     next to three agent scopes of the same project. Appends wall time and
//     CPU-seconds to a results file in TMPDIR, which every probe of one gate
//     run shares; --summary also prints the median of each weight's runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../lib/containment');

// The tests gate command this repository pins, on three CLI-heavy files.
const GATE_FILES = ['test/ladder.test.js', 'test/authority.test.js', 'test/state-compatibility.test.js'];
const PINNED = 4;
const AGENTS = 3;
const AGENT_THREADS = 4;
const WARMUP_MS = 3000;
const WINDOW_MS = 20000;
const GATE_DEADLINE_MS = 8 * 60000;
// The longest any busy process lives, whatever happens to this probe.
const BURN_LIMIT_S = 600;
const RESULTS = path.join(os.tmpdir(), 'tower-crane-cpu-weight.jsonl');

const units = new Set();
const children = new Set();
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function cpus() {
  const line = fs.readFileSync('/proc/self/status', 'utf8').split('\n').find((l) => l.startsWith('Cpus_allowed_list:'));
  const list = line.split(':')[1].trim().split(',').flatMap((part) => {
    const [a, b = a] = part.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  if (list.length < PINNED * 2) throw new Error(`needs at least ${PINNED * 2} CPUs, has ${list.length}`);
  return list.slice(-PINNED).join(',');
}

function systemctl(args) {
  return cp.spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 5000 });
}

async function controlGroup(unit, child) {
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
    const r = systemctl(['show', '-p', 'ControlGroup', '--value', unit]);
    const group = r.stdout?.trim();
    if (group && fs.existsSync(path.join('/sys/fs/cgroup', group, 'cpu.stat'))) return path.join('/sys/fs/cgroup', group);
    await pause(100);
  }
  throw new Error(`scope ${unit} did not start`);
}

const read = (file) => fs.readFileSync(file, 'utf8').trim();
const usage = (group) => Number(/^usage_usec (\d+)$/m.exec(read(path.join(group, 'cpu.stat')))[1]) / 1e6;
const weightOf = (group) => (fs.existsSync(path.join(group, 'cpu.weight')) ? Number(read(path.join(group, 'cpu.weight'))) : null);

// A scope as the engine starts one; it runs command until it exits or is stopped.
async function scope(name, slice, weight, limits, command, stdio = 'ignore') {
  const unit = `tc-cpu-${process.pid}-${name}.scope`;
  units.add(unit);
  const child = cp.spawn('systemd-run', [...C.scopeArguments(unit, slice, limits, {}, weight), ...command], { stdio: ['ignore', stdio, 'inherit'] });
  children.add(child);
  const exited = new Promise((resolve) => child.on('exit', (code) => { children.delete(child); resolve(code); }));
  const group = await controlGroup(unit, child);
  return { name, unit, child, exited, group, slice, weight };
}

function burner(name, slice, weight, cpuList, threads) {
  const busy = `const { Worker } = require('node:worker_threads'); for (let i = 1; i < ${threads}; i++) new Worker('for (;;);', { eval: true }); for (;;);`;
  return scope(name, slice, weight, { tasks_max: 256, memory_max_bytes: 1024 ** 3 },
    ['timeout', String(BURN_LIMIT_S), 'taskset', '-c', cpuList, process.execPath, '-e', busy]);
}

function stop() {
  if (units.size) systemctl(['stop', ...units]);
  for (const child of children) child.kill('SIGKILL');
  units.clear();
}

async function sample(groups, ms) {
  const start = groups.map((g) => usage(g.group));
  await pause(ms);
  return groups.map((g, i) => usage(g.group) - start[i]);
}

async function fairness() {
  const caller = C.callerSlice();
  const list = cpus();
  const tower = C.projectSlice(caller, path.join(os.tmpdir(), 'measure-project-a'));
  const other = C.projectSlice(caller, path.join(os.tmpdir(), 'measure-project-b'));
  const layouts = [
    // Before this change: every scope flat in the caller's slice at the default weight.
    { name: 'flat, gate at 100', gate: [caller, 100], agent: [caller, 100], other: [caller, 100] },
    // A boosted gate without project slices would take CPU from every other scope in the slice.
    { name: 'flat, gate at 400', gate: [caller, 400], agent: [caller, 100], other: [caller, 100] },
    { name: 'project slices, gate at 400', gate: [tower, 400], agent: [tower, 100], other: [other, 100] },
  ];
  const out = { cpus: list, caller, window_s: WINDOW_MS / 1000, layouts: [] };
  for (const layout of layouts) {
    try {
      const groups = [
        await burner('gate', ...layout.gate, list, PINNED),
        await burner('agent', ...layout.agent, list, PINNED),
        await burner('other-project', ...layout.other, list, PINNED),
        await burner('session', caller, 100, list, PINNED),
      ];
      await pause(WARMUP_MS);
      const used = await sample(groups, WINDOW_MS);
      const total = used.reduce((a, b) => a + b, 0);
      const row = { layout: layout.name, groups: groups.map((g, i) => ({
        group: g.name, slice: g.slice, cpu_weight: weightOf(g.group), slice_weight: g.slice === caller ? null : weightOf(path.dirname(g.group)),
        cpu_s: +used[i].toFixed(2), share: +(used[i] / total).toFixed(3) })) };
      const share = (name) => row.groups.find((g) => g.group === name).share;
      // The Tower Crane project's two scopes against the other project and the session.
      row.tower_crane_share = +(share('gate') + share('agent')).toFixed(3);
      row.gate_to_agent = +(share('gate') / share('agent')).toFixed(2);
      out.layouts.push(row);
      console.log(`${layout.name}: Tower Crane project ${pct(row.tower_crane_share)} (gate ${pct(share('gate'))}, agent ${pct(share('agent'))}), `
        + `other project ${pct(share('other-project'))}, session ${pct(share('session'))} of ${total.toFixed(1)} CPU-s on CPUs ${list}`);
    } finally { stop(); }
    await pause(1000);
  }
  console.log(JSON.stringify(out));
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function gate(weight, summary) {
  const caller = C.callerSlice();
  const list = cpus();
  const slice = C.projectSlice(caller, path.join(os.tmpdir(), 'measure-project-a'));
  let row;
  try {
    const agents = [];
    for (let i = 1; i <= AGENTS; i++) agents.push(await burner(`agent-${i}`, slice, 100, list, AGENT_THREADS));
    await pause(WARMUP_MS);
    const before = agents.map((a) => usage(a.group));
    const run = await scope(`gate-${weight}`, slice, weight, { tasks_max: 8192, memory_max_bytes: 6 * 1024 ** 3 },
      [process.execPath, __filename, 'gate-child', list], 'pipe');
    let text = '';
    run.child.stdout.on('data', (d) => { text += d; });
    const code = await run.exited;
    const agentCpu = agents.reduce((sum, a, i) => sum + usage(a.group) - before[i], 0);
    const result = JSON.parse(text.trim().split('\n').pop());
    row = { weight, cpus: list, slice, ...result, exit: code, agents: AGENTS, agent_threads: AGENT_THREADS, agent_cpu_s: +agentCpu.toFixed(1), at: new Date().toISOString() };
  } finally { stop(); }
  fs.appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
  if (row.status !== 0) throw new Error(`the gate command failed with ${row.status}; its log is ${row.log}`);
  if (summary) {
    const rows = read(RESULTS).split('\n').map((line) => JSON.parse(line));
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const w of [...new Set(rows.map((r) => r.weight))].sort((a, b) => a - b)) {
      const runs = rows.filter((r) => r.weight === w);
      console.log(`weight ${w}: ${runs.length} runs, median wall ${median(runs.map((r) => r.wall_s))} s, median CPU ${median(runs.map((r) => r.cpu_s))} CPU-s; `
        + `runs ${runs.map((r) => `${r.wall_s} s/${r.cpu_s} CPU-s`).join(', ')}`);
    }
  }
}

// Inside the gate's scope: the tests gate command, then the scope's own CPU time.
function gateChild(list) {
  const log = path.join(os.tmpdir(), `tower-crane-cpu-weight-${process.pid}.log`);
  // The suite as the gate runs it, without the gate's own Tower Crane variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TOWER_CRANE_')));
  env.TOWER_CRANE_TEST_TMP = path.join(os.tmpdir(), 'cpu-weight-tests');
  fs.mkdirSync(env.TOWER_CRANE_TEST_TMP, { recursive: true });
  const fd = fs.openSync(log, 'w');
  const started = performance.now();
  const r = cp.spawnSync('taskset', ['-c', list, process.execPath, 'test/run.js', '--test-concurrency=3', ...GATE_FILES],
    { stdio: ['ignore', fd, fd], env, timeout: GATE_DEADLINE_MS });
  const wall = (performance.now() - started) / 1000;
  fs.closeSync(fd);
  const group = C.currentGroup();
  console.log(JSON.stringify({ files: GATE_FILES, status: r.status, signal: r.signal, wall_s: +wall.toFixed(1),
    cpu_s: +usage(group).toFixed(1), cpu_weight: weightOf(group), slice_weight: weightOf(path.dirname(group)), log }));
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(1); });
  if (mode === 'fairness') return fairness();
  if (mode === 'gate' && C.validWeight(Number(args[0]))) return gate(Number(args[0]), args.includes('--summary'));
  if (mode === 'gate-child') return gateChild(args[0]);
  throw new Error('usage: measure-cpu-weight.js fairness | gate WEIGHT [--summary]');
}

main().catch((error) => { stop(); console.error(error.stack || error.message); process.exitCode = 1; });
