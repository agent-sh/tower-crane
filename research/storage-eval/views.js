'use strict';
// status and inbox latency for each CLI tree on its own copy of one state
// directory, runs interleaved so background load drifts over every tree alike.
// Each run is a fresh process, as an orchestrator's command is.
// Usage: node views.js --state DIR --work DIR --tree NAME=DIR [--tree NAME=DIR ...] [--runs N] [--warmup N] --out FILE
// --state is a migrated state directory (prepare.js --cli, then one command of
// the newest tree). Each tree gets a copy, so indexes one tree adds on open do
// not speed up another. Benchmark-only edit: the copy's project records no
// repository, so inbox reads no GitHub; its PR and CI reads are the network's
// time, the same in every tree, and not storage. Each copy is the
// `.tower-crane` of a repository of its own, which commands run from, as an
// orchestrator runs them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const STATE = path.resolve(arg('state'));
const WORK = path.resolve(arg('work'));
const RUNS = Number(arg('runs') || 30);
const WARMUP = Number(arg('warmup') || 2);
const TREES = all('tree').map((t) => { const [name, dir] = t.split('='); return { name, dir: path.resolve(dir) }; });
const COMMANDS = [['status', '--json'], ['inbox', '--json']];

// CPU seconds of this process's waited-for children (Linux), so each run's
// CPU is the difference across it: the comparison that load moves least.
const TICK = process.platform === 'linux' ? Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) : 0;
function childCpu() {
  if (!TICK) return 0;
  const s = fs.readFileSync('/proc/self/stat', 'utf8');
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return (Number(f[13]) + Number(f[14])) / TICK;
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}

function copyState(tree) {
  const repo = path.join(WORK, tree.name);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const dir = path.join(repo, '.tower-crane');
  execFileSync('cp', ['-r', STATE, dir]);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(dir, `state.db${suffix}`), { force: true });
  // The project document lives in state.db; the newest tree's lib edits it
  // there, as a command would, without a commit of its own.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  const project = JSON.parse(db.prepare("SELECT body FROM docs WHERE name = 'project'").get().body);
  project.repo = null;
  db.prepare("UPDATE docs SET body = ? WHERE name = 'project'").run(JSON.stringify(project));
  db.close();
  return dir;
}

function run(tree, state, cmd) {
  const env = { ...process.env, TOWER_CRANE_STATE: state, TOWER_CRANE_AGENT: 'orchestrator' };
  for (const k of ['TOWER_CRANE_TASK', 'TOWER_CRANE_BROKER', 'TOWER_CRANE_VIA']) delete env[k];
  const t0 = performance.now();
  const c0 = childCpu();
  const r = spawnSync(process.execPath, [path.join(tree.dir, 'bin', 'tower-crane.js'), ...cmd], { cwd: path.dirname(state), env, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ms = performance.now() - t0;
  const cpu = (childCpu() - c0) * 1000;
  if (r.status !== 0) throw new Error(`${tree.name} ${cmd.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 500)}`);
  return { ms, cpu, bytes: r.stdout.length };
}

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const states = new Map(TREES.map((t) => [t.name, copyState(t)]));
  const samples = Object.fromEntries(TREES.map((t) => [t.name, Object.fromEntries(COMMANDS.map(([c]) => [c, []]))]));
  const cpu = Object.fromEntries(TREES.map((t) => [t.name, Object.fromEntries(COMMANDS.map(([c]) => [c, []]))]));
  const output = {};
  for (const t of TREES) for (const cmd of COMMANDS) for (let i = 0; i < WARMUP; i++) run(t, states.get(t.name), cmd);
  const load = [os.loadavg()[0]];
  for (let i = 0; i < RUNS; i++) {
    for (const t of TREES) {
      for (const cmd of COMMANDS) {
        const r = run(t, states.get(t.name), cmd);
        samples[t.name][cmd[0]].push(r.ms);
        cpu[t.name][cmd[0]].push(r.cpu);
        output[`${t.name} ${cmd[0]}`] = r.bytes;
      }
    }
  }
  load.push(os.loadavg()[0]);
  const summary = {};
  for (const t of TREES) {
    summary[t.name] = {};
    for (const [c] of COMMANDS) {
      const xs = samples[t.name][c];
      const cs = cpu[t.name][c];
      summary[t.name][c] = { n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)),
        cpu_ms_per_op: Math.round(cs.reduce((a, b) => a + b, 0) / cs.length), output_bytes: output[`${t.name} ${c}`] };
    }
  }
  const result = { at: new Date().toISOString(), node: process.version, cores: os.cpus().length, load_1m: load, runs: RUNS, warmup: WARMUP,
    trees: TREES.map((t) => t.name), summary, samples, cpu };
  fs.writeFileSync(path.resolve(arg('out')), JSON.stringify(result, null, 2) + '\n');
  for (const t of TREES) for (const [c] of COMMANDS) {
    const s = summary[t.name][c];
    process.stdout.write(`${t.name.padEnd(12)} ${c.padEnd(7)} p50 ${String(s.p50).padStart(5)} ms  p95 ${String(s.p95).padStart(5)} ms  CPU ${String(s.cpu_ms_per_op).padStart(5)} ms/op  (${s.output_bytes} bytes out)\n`);
  }
}

main();
