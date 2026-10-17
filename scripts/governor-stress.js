#!/usr/bin/env node
'use strict';

// The host governor's stress test: three projects whose wait loops dispatch
// memory-heavy workers and whose gate loops run a fork-heavy suite, beside an
// outside memory hog Tower Crane did not start, all inside one small cgroup.
// The governor must keep that cgroup from its OOM killer.
//
//   node scripts/governor-stress.js [--memory MiB] [--seconds S] [--control] [--simulate]
//
// By default the script runs itself again inside a transient systemd user
// scope with MemoryMax, no swap and a task cap, so a failure stays inside it,
// and reads the scope's memory.events. --control runs the same processes
// without Tower Crane, to show the load alone reaches the OOM killer.
// --simulate runs without a scope, against a fake cgroup whose use is the sum
// of every visible process's anonymous memory, and counts the samples past
// its limit instead of OOM kills; for a sandbox with no user manager.
// The report is printed as JSON and kept beside the run's files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');
const MiB = 1024 * 1024;

function flags(argv) {
  const out = { memory: 3072, seconds: 120, control: false, simulate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memory') out.memory = Number(argv[++i]);
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--control') out.control = true;
    else if (a === '--simulate') out.simulate = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(out.memory >= 512) || !(out.seconds >= 10)) throw new Error('--memory needs at least 512 MiB and --seconds at least 10');
  return out;
}

const f = flags(process.argv.slice(2));
const LIMIT = f.memory * MiB;
// Sizes as fractions of the cgroup: three projects of three workers and a
// suite each, with the hog at its peak, need about twice the limit.
const WORKER_MB = Math.round(f.memory * 0.08);
const CHILD_MB = Math.round(f.memory * 0.02);
const CHILDREN = 8;
const HOG_PEAK = 0.5;

if (!f.simulate && !process.env.GOVERNOR_STRESS_SCOPE) {
  const unit = `tower-crane-governor-stress-${process.pid}`;
  const r = cp.spawnSync('systemd-run', ['--user', '--scope', '--quiet', `--unit=${unit}`,
    '-p', `MemoryMax=${LIMIT}`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=4096',
    '--setenv=GOVERNOR_STRESS_SCOPE=1', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, GOVERNOR_STRESS_SCOPE: '1' } });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

const ownCgroup = () => (fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::')) || '0::/').slice(3).trim();
const cgroupDir = path.join('/sys/fs/cgroup', ownCgroup());
const keyed = (text) => Object.fromEntries(String(text || '').trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([k, v]) => [k, Number(v)]));
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

const base = fs.mkdtempSync(path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tc-governor-stress-'));
const stop = path.join(base, 'stop');
const host = path.join(base, 'host');

// Fixture programs.
fs.writeFileSync(path.join(base, 'worker.js'), `
const fs = require('node:fs');
const cp = require('node:child_process');
if (process.env.TOWER_CRANE_TASK) cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', process.env.TOWER_CRANE_TASK], { stdio: 'ignore' });
const held = [];
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(stop)})) process.exit(0);
  if (held.length * 16 < ${WORKER_MB}) held.push(Buffer.alloc(16 * 1024 * 1024, held.length + 1));
}, 100);
`);
fs.writeFileSync(path.join(base, 'fork.js'), `
const cp = require('node:child_process');
let left = ${CHILDREN};
for (let i = 0; i < ${CHILDREN}; i++) {
  const c = cp.spawn(process.execPath, ['-e', 'const b = Buffer.alloc(${CHILD_MB} * 1024 * 1024, 7); setTimeout(() => process.exit(b[0] === 7 ? 0 : 1), 3000)'], { stdio: 'ignore' });
  c.on('exit', (code) => { if (code) process.exitCode = 1; if (--left === 0) process.exit(process.exitCode || 0); });
}
`);
fs.writeFileSync(path.join(base, 'hog.js'), `
// Not Tower Crane's: small while Tower Crane fills the cgroup, then a fast
// ramp to the peak, a hold, a release and a second ramp.
const fs = require('node:fs');
const limit = ${LIMIT};
const plan = [[0.05, 30], [${HOG_PEAK}, 30], [0.1, 15], [${HOG_PEAK}, 1e9]];
const held = [];
let peak = 0;
let step = 0;
let since = Date.now();
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(stop)})) { fs.writeFileSync(process.argv[2], String(peak)); process.exit(0); }
  const [target, seconds] = plan[Math.min(step, plan.length - 1)];
  const want = Math.floor(target * limit / (32 * 1024 * 1024));
  if (held.length < want) held.push(Buffer.alloc(32 * 1024 * 1024, 1));
  else if (held.length > want) held.length = want;
  peak = Math.max(peak, held.length * 32 * 1024 * 1024);
  if (Date.now() - since > seconds * 1000) { step++; since = Date.now(); }
}, 200);
`);

function anonymousTotal() {
  let sum = 0;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const m = /^RssAnon:\s+(\d+)\s*kB/m.exec(readText(`/proc/${name}/status`) || '');
    if (m) sum += Number(m[1]) * 1024;
  }
  return sum;
}

// The simulated cgroup: one slice whose use is every visible process's anonymous memory.
function writeSimulated(used) {
  const write = (rel, text) => {
    const file = path.join(host, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  };
  const real = (rel) => readText(path.join('/proc', rel)) || '';
  write('proc/meminfo', real('meminfo'));
  write('proc/pressure/memory', real('pressure/memory') || 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  write('proc/pressure/cpu', real('pressure/cpu') || 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
  write('proc/loadavg', real('loadavg'));
  write('proc/self/cgroup', '0::/stress.slice/run.scope\n');
  write('sys/fs/cgroup/stress.slice/memory.current', `${used}\n`);
  write('sys/fs/cgroup/stress.slice/memory.max', `${LIMIT}\n`);
  write('sys/fs/cgroup/stress.slice/memory.high', 'max\n');
  write('sys/fs/cgroup/stress.slice/memory.stat', `anon ${used}\nactive_file 0\ninactive_file 0\n`);
}

function sample() {
  if (f.simulate) {
    const used = anonymousTotal();
    writeSimulated(used);
    return { used, oom_kill: used > LIMIT ? 1 : 0 };
  }
  const stat = keyed(readText(path.join(cgroupDir, 'memory.stat')));
  const current = Number(readText(path.join(cgroupDir, 'memory.current')));
  return { used: current - (stat.active_file || 0) - (stat.inactive_file || 0), current, oom_kill: keyed(readText(path.join(cgroupDir, 'memory.events'))).oom_kill || 0 };
}

const samples = [];
let sampler;
function startSampling() {
  const first = sample();
  samples.push({ t: 0, ...first });
  const start = Date.now();
  sampler = setInterval(() => samples.push({ t: Date.now() - start, ...sample() }), 250);
}

async function control() {
  const kids = [];
  const env = { ...process.env };
  delete env.TOWER_CRANE_TASK;
  for (let i = 0; i < 9; i++) kids.push(cp.spawn(process.execPath, [path.join(base, 'worker.js')], { stdio: 'ignore', env }));
  const forks = setInterval(() => { for (let i = 0; i < 3; i++) kids.push(cp.spawn(process.execPath, [path.join(base, 'fork.js')], { stdio: 'ignore' })); }, 4000);
  kids.push(cp.spawn(process.execPath, [path.join(base, 'hog.js'), path.join(base, 'hog-peak')], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, f.seconds * 1000));
  clearInterval(forks);
  fs.writeFileSync(stop, '');
  await new Promise((r) => setTimeout(r, 2000));
  for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* exited */ } }
  return {};
}

async function governed() {
  const { makeRepo } = require('../test/helpers');
  const projects = [makeRepo(), makeRepo(), makeRepo()];
  const [first] = projects;
  for (const h of projects) {
    // One user on one host: the first project's cache, and in a simulation the fake host.
    h.env.XDG_CACHE_HOME = first.env.XDG_CACHE_HOME;
    if (f.simulate) h.env.TOWER_CRANE_HOST_ROOT = host;
    else delete h.env.TOWER_CRANE_HOST_ROOT;
    h.init(['--workers', '3', '--tests-cmd', `node ${JSON.stringify(path.join(base, 'fork.js'))}`, '--tests-mode', 'run-only',
      '--governor', JSON.stringify({ expected_mb: { worker: Math.round(f.memory * 0.12), tests: Math.round(f.memory * 0.25) } })]);
    for (let i = 1; i <= 4; i++) {
      h.ok(['task', 'add', '--title', `worker ${i}`, '--acceptance', 'holds memory', '--tier', 'easy']);
      h.ok(['brief', 'set', `T${i}`, '-'], { input: 'Fixture process, no model.\n' });
    }
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, path.join(base, 'worker.js'), '{brief}']), '--clear', 'profile', '--clear', 'effort']);
    h.ok(['task', 'add', '--title', 'suite', '--acceptance', 'forks', '--kind', 'docs']);
    h.git(['commit', '-q', '--allow-empty', '-m', 'suite head']);
    h.ok(['claim', 'T5', '--agent', 'gate-fixture']);
    h.ok(['submit', 'T5', '--agent', 'gate-fixture', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', 'main']);
  }
  const hog = cp.spawn(process.execPath, [path.join(base, 'hog.js'), path.join(base, 'hog-peak')], { stdio: 'ignore' });
  const waits = projects.map((h, i) => {
    const w = h.spawnCli(['wait', '--follow']);
    w.stdout.resume();
    w.stderr.pipe(fs.createWriteStream(path.join(base, `wait-${i + 1}.log`)));
    return w;
  });
  const gates = projects.map((h) => ({ ok: 0, deferred: 0, stopped: 0, failed: 0 }));
  const deadline = Date.now() + f.seconds * 1000;
  const loops = projects.map(async (h, i) => {
    while (Date.now() < deadline) {
      const r = await h.runAsync(['check', 'tests', 'T5']);
      if (r.code === 0) gates[i].ok++;
      else if (/stopped by the host governor/.test(r.stderr)) gates[i].stopped++;
      else if (/deferred by the host governor/.test(r.stderr)) gates[i].deferred++;
      else gates[i].failed++;
      // A suite every few seconds per project, so workers take most of the room.
      await new Promise((res) => setTimeout(res, 3000));
    }
  });
  await Promise.all(loops);
  fs.writeFileSync(stop, '');
  for (const w of waits) w.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 4000));
  const events = projects.map((h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse));
  const registry = require('../lib/governor').read(projects[0].env);
  const result = {
    gates,
    workers: events.map((ev) => ({
      dispatched: ev.filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length,
      stopped_by_governor: ev.filter((e) => e.cmd === 'spawn phase' && /host governor/.test(e.detail.reason || '')).length,
      ends: ev.filter((e) => e.cmd === 'spawn phase' && ['blocked', 'stopped', 'waiting'].includes(e.detail.phase))
        .map((e) => `${e.task} ${e.detail.agent} ${e.detail.phase}: ${String(e.detail.reason).slice(0, 60)}`),
    })),
    governor_stops: registry?.stops.length ?? null,
    governor_stop_list: (registry?.stops || []).map((x) => `${path.basename(path.dirname(x.project))} ${x.task} ${x.kind} ${x.agent} ${x.at}`),
    governor_stops_by_kind: (registry?.stops || []).reduce((n, x) => ({ ...n, [x.kind]: (n[x.kind] || 0) + 1 }), {}),
    learned_peaks_mb: Object.fromEntries(['worker', 'tests'].map((k) => [k, Math.round(Math.max(0, ...(registry?.history || []).filter((x) => x.kind === k).map((x) => x.peak)) / MiB)])),
  };
  try { hog.kill('SIGKILL'); } catch { /* exited */ }
  for (const h of projects) await h.cleanup().catch((e) => process.stderr.write(`cleanup: ${e.message}\n`));
  return result;
}

(async () => {
  const before = f.simulate ? 0 : keyed(readText(path.join(cgroupDir, 'memory.events'))).oom_kill || 0;
  startSampling();
  const started = Date.now();
  const extra = f.control ? await control() : await governed();
  clearInterval(sampler);
  const after = f.simulate ? samples.filter((x) => x.oom_kill).length : keyed(readText(path.join(cgroupDir, 'memory.events'))).oom_kill || 0;
  const peak = Math.max(...samples.map((x) => x.used));
  const report = {
    mode: f.control ? 'control' : 'governed', simulated: f.simulate, cgroup: f.simulate ? 'simulated' : ownCgroup(),
    limit_mb: f.memory, seconds: Math.round((Date.now() - started) / 1000), samples: samples.length,
    peak_used_mb: Math.round(peak / MiB), peak_fraction: Math.round((peak / LIMIT) * 1000) / 1000,
    memory_peak_mb: f.simulate ? null : Math.round(Number(readText(path.join(cgroupDir, 'memory.peak')) || 0) / MiB),
    oom_kills: f.simulate ? null : after - before, samples_over_limit: f.simulate ? after : null,
    hog_peak_mb: Math.round(Number(readText(path.join(base, 'hog-peak')) || 0) / MiB),
    sizes_mb: { worker: WORKER_MB, suite_children: CHILDREN, suite_child: CHILD_MB, hog_peak: Math.round(f.memory * HOG_PEAK) },
    ...extra,
  };
  fs.writeFileSync(path.join(base, 'report.json'), JSON.stringify({ report, samples }, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nsamples: ${path.join(base, 'report.json')}\n`);
})().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
