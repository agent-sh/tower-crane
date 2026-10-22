'use strict';

// Linux host probe: CPU-seconds per minute and RSS of one idle spawn monitor
// and one `wait --follow` host over a state the size of a busy project's (500
// tasks, a 116 MB log of 135k lines in the mix such a log has), median of
// three one-minute windows with no event appended. Then the agent exits and
// the probe times how long its monitor takes to exit.
//
//   node scripts/bench-supervision.js [--compare REF] [--windows N] [--window-s S]
//
// --compare REF runs the same load on REF's tree first (git archive of the
// merge base of HEAD and REF), so both columns come from one host and load.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const WINDOWS = Number(flag('--windows', 3));
const WINDOW_MS = Number(flag('--window-s', 60)) * 1000;
const WARMUP_MS = 20000;
const EXIT_BOUND_MS = 120000;
const LOG_BYTES = 116 * 1024 * 1024;
const LOG_LINES = 135000;
const FILLER_TASKS = 500;
if (process.platform !== 'linux') throw new Error('the probe reads /proc; run it on Linux');
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const ROOT = path.resolve(__dirname, '..');
const hz = Number(cp.execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function sample(pid) {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const rss = Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024;
  return { ticks: Number(fields[11]) + Number(fields[12]), rss };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Event lines in the proportions and sizes of the measured log: progress
// lines that readers skip, live usage, hook reports, reaction receipts,
// messages, notes, spawns and their exits, and large test gate records.
function padding(tasks) {
  const filler = (n) => 'x'.repeat(n);
  const kinds = [
    [27, (t, i) => ({ agent: `worker-${t}-1`, cmd: 'hook progress', task: t, detail: { tool: 'Bash', text: filler(160) } })],
    [24, (t, i) => ({ agent: `worker-${t}-1`, cmd: 'spend live', task: t, detail: { agent: `worker-${t}-1`, minutes: 0, tokens: i, input: i, cached: 0, output: 1, rung: 'hard', harness: 'claude', model: 'm', profile: null, source: `live:${t}`, live: { state: 'live', interval_ms: 30000 }, note: filler(300) } })],
    [10, (t) => ({ agent: `worker-${t}-1`, cmd: 'hook report', task: t, detail: { kind: 'tool', text: filler(520) } })],
    [7, (t, i) => ({ agent: 'orchestrator', cmd: 'automation', task: t, detail: { source: `E${i}`, phase: 'done', error: null } })],
    [3, (t) => ({ agent: `worker-${t}-1`, cmd: 'msg', task: t, detail: { to: 'orchestrator', text: filler(1200) } })],
    [3, (t) => ({ agent: 'orchestrator', cmd: 'task note', task: t, detail: { text: filler(500) } })],
    [2, (t, i) => ({ agent: 'orchestrator', cmd: 'spawn', task: t, detail: { agent: `worker-${t}-1`, role: 'worker', rung: 'hard', harness: 'claude', pid: 2 ** 22 + i, monitor_pid: 2 ** 22 + i + 1, host: 'bench-elsewhere', phase: 'running', attempt: 1, cwd: filler(900) } })],
    [2, (t, i) => ({ agent: `worker-${t}-1`, cmd: 'spawn exit', task: t, detail: { agent: `worker-${t}-1`, pid: 2 ** 22 + i - 1, code: 0, signal: null, retry: 0, host: 'bench-elsewhere', log: filler(700) } })],
    [1, (t) => ({ agent: 'orchestrator', cmd: 'check tests', task: t, detail: { type: 'tests', ok: true, sha: 'a'.repeat(40), revision: 1, summary: '' } })],
  ];
  const weights = kinds.reduce((sum, [w]) => sum + w, 0);
  const lines = [];
  let bytes = 0;
  const at = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; lines.length < LOG_LINES; i++) {
    let pick = i % weights;
    const [, make] = kinds.find(([w]) => (pick -= w) < 0);
    const task = tasks[i % tasks.length];
    const line = JSON.stringify({ at: new Date(at + i * 10).toISOString(), ...make(task, i), id: `Ebench-${i}` }) + '\n';
    lines.push(line);
    bytes += line.length;
  }
  // The test gate records carry the rest of the measured size, as they do.
  const checks = lines.filter((line) => line.includes('"cmd":"check tests"')).length;
  const summary = filler(Math.max(0, Math.round((LOG_BYTES - bytes) / checks)));
  return lines.map((line) => (line.includes('"cmd":"check tests"') ? line.replace('"summary":""', `"summary":"${summary}"`) : line));
}

function fill(h) {
  const doc = h.readState('tasks.json');
  const base = doc.tasks[0];
  const ids = [];
  for (let n = 0; n < FILLER_TASKS; n++) {
    const id = `T${n + 2}`;
    ids.push(id);
    doc.tasks.push({ ...structuredClone(base), id, title: `Finished task ${id}`, status: 'cancelled',
      notes: Array.from({ length: 20 }, (_, i) => ({ at: '2026-10-01T00:00:00.000Z', agent: 'orchestrator', text: `note ${i} ${'n'.repeat(1000)}` })),
      spend: { minutes: 0, tokens: 20, entries: Array.from({ length: 20 }, () => ({ at: '2026-10-01T00:00:00.000Z', agent: `worker-${id}-1`,
        minutes: 0, tokens: 1, input: 1, cached: 0, output: 0, rung: null, harness: null, model: null, profile: null, source: 'manual', cost_usd: null })) } });
  }
  doc.next = FILLER_TASKS + 2;
  const lines = padding(ids);
  const file = path.join(h.state, 'events.jsonl');
  const fd = fs.openSync(file, 'a');
  try {
    for (let i = 0; i < lines.length; i += 1000) fs.writeSync(fd, lines.slice(i, i + 1000).join(''));
  } finally {
    fs.closeSync(fd);
  }
  doc.last_event = `Ebench-${lines.length - 1}`;
  h.writeState('tasks.json', doc);
}

async function measure() {
  process.env.TOWER_CRANE_TEST_TMP ||= path.join(cache, 'tc-bench');
  fs.mkdirSync(process.env.TOWER_CRANE_TEST_TMP, { recursive: true });
  const { makeTaskRepo, BIN, HOOKS } = require('../test/helpers');
  const S = require('../lib/state');
  const h = makeTaskRepo(null, [{ args: ['--title', 'Idle worker', '--tier', 'easy', '--acceptance', 'idle'], brief: 'Hold.' }]);
  const finish = path.join(h.base, 'finish');
  const ready = path.join(h.base, 'ready');
  const harness = path.join(ROOT, 'test', 'fixtures', 'bench-idle-harness.js');
  let host;
  let closed;
  try {
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, harness, ready, finish, '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 0, stall_ms: 3600000 })]);
    h.ok(['task', 'note', 'T1', 'bench', '--agent', 'orchestrator']);
    fill(h);
    // --profile DIR records the first window's CPU profile of both processes.
    const profile = flag('--profile');
    const profiler = path.join(ROOT, 'test', 'fixtures', 'window-profiler.js');
    const env = profile ? { ...h.env, WINDOW_PROFILE_DIR: profile } : h.env;
    const prof = profile ? ['--require', profiler] : [];
    // The monitor the dispatch starts inherits the preload.
    h.json(['spawn', '--task', 'T1'], profile ? { env: { ...env, NODE_OPTIONS: `--require "${HOOKS}" --require "${profiler}"` } } : undefined);
    const monitor = S.readEvents(h.state).findLast((e) => e.cmd === 'spawn').detail.monitor_pid;
    host = cp.spawn(process.execPath, [...prof, '--require', HOOKS, BIN, 'wait', '--follow', '--agent', 'orchestrator'], {
      cwd: h.repo, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    host.stdout.on('data', (d) => { stdout += d; });
    host.stderr.on('data', (d) => { stderr += d; });
    closed = once(host, 'close');
    const started = performance.now();
    while (!stdout.includes('"type":"ready"') || !fs.existsSync(ready)) {
      if (performance.now() - started > 300000 || host.exitCode !== null) throw new Error(`wait host not ready: ${stderr}`);
      await pause(200);
    }
    await pause(WARMUP_MS);
    const log = path.join(h.state, 'events.jsonl');
    const windows = [];
    for (let w = 0; w < WINDOWS; w++) {
      const size = fs.statSync(log).size;
      const profiled = profile && w === 0;
      if (profiled) for (const pid of [monitor, host.pid]) process.kill(pid, 'SIGUSR2');
      const before = [sample(monitor), sample(host.pid)];
      const start = performance.now();
      await pause(WINDOW_MS);
      if (profiled) for (const pid of [monitor, host.pid]) process.kill(pid, 'SIGUSR2');
      const minutes = (performance.now() - start) / 60000;
      const after = [sample(monitor), sample(host.pid)];
      windows.push({
        appended: fs.statSync(log).size - size,
        monitor: { cpu_s_per_min: (after[0].ticks - before[0].ticks) / hz / minutes, rss_mb: after[0].rss / 2 ** 20 },
        follow: { cpu_s_per_min: (after[1].ticks - before[1].ticks) / hz / minutes, rss_mb: after[1].rss / 2 ** 20 },
      });
    }
    // The agent exits; its monitor records the exit, hands off and exits.
    fs.writeFileSync(finish, '');
    const exitStart = performance.now();
    while (alive(monitor) && performance.now() - exitStart < EXIT_BOUND_MS) await pause(100);
    const monitorExitS = alive(monitor) ? null : (performance.now() - exitStart) / 1000;
    return { windows, monitor_exit_s: monitorExitS, log_bytes: fs.statSync(log).size, stderr: stderr.trim().slice(-2000) };
  } finally {
    if (host && host.exitCode === null) { host.kill('SIGINT'); await closed; }
    fs.writeFileSync(finish, '');
    await pause(1500);
    await h.cleanup();
  }
}

function summary(result) {
  const pick = (who, key) => median(result.windows.map((w) => w[who][key]));
  return {
    monitor_cpu_s_per_min: pick('monitor', 'cpu_s_per_min'), monitor_rss_mb: pick('monitor', 'rss_mb'),
    follow_cpu_s_per_min: pick('follow', 'cpu_s_per_min'), follow_rss_mb: pick('follow', 'rss_mb'),
    monitor_exit_s: result.monitor_exit_s,
  };
}

async function compare(ref) {
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const base = cp.execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(cache, 'tc-bench-base-'));
  try {
    cp.execFileSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', base, dir], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    fs.copyFileSync(__filename, path.join(dir, 'scripts', path.basename(__filename)));
    const rows = {};
    for (const [name, root] of [['before', dir], ['after', ROOT]]) {
      const run = cp.spawnSync(process.execPath, [path.join(root, 'scripts', path.basename(__filename)), '--windows', String(WINDOWS), '--window-s', String(WINDOW_MS / 1000)],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 2 ** 20 });
      if (run.status !== 0) throw new Error(`${name} run exited ${run.status}`);
      rows[name] = JSON.parse(run.stdout.trim().split('\n').at(-1));
      console.log(JSON.stringify({ [name]: rows[name], commit: name === 'before' ? base : head }));
    }
    console.log(JSON.stringify({ before: summary(rows.before), after: summary(rows.after) }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ref = flag('--compare');
(ref ? compare(ref) : measure().then((result) => {
  console.error(JSON.stringify(summary(result)));
  console.log(JSON.stringify(result));
})).catch((e) => { console.error(e); process.exitCode = 1; });
