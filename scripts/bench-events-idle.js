'use strict';

// Linux CPU and rchar probe. Keep fixtures and CPU profiles on disk under ~/.cache.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const cache = process.env.XDG_CACHE_HOME;
if (process.platform !== 'linux' || !cache) throw new Error('set XDG_CACHE_HOME to a directory under ~/.cache on Linux');
process.env.TOWER_CRANE_TEST_TMP = cache;
const { makeTaskRepo, BIN, HOOKS } = require('../test/helpers');
const S = require('../lib/state');
const label = process.argv[2] || 'idle';
if (!/^[\w-]+$/.test(label)) throw new Error('label must contain only letters, numbers, underscores or hyphens');
const profiles = path.join(cache, `profiles-${label}`);
fs.mkdirSync(profiles, { recursive: true });
const hz = Number(cp.execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sample(pid) {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
  return { ticks: Number(fields[11]) + Number(fields[12]), rchar: Number(/rchar: (\d+)/.exec(io)[1]) };
}

async function measure(run) {
  const h = makeTaskRepo(null, [{ args: ['--title', 'Idle reader', '--tier', 'easy', '--acceptance', 'idle'], brief: 'Hold.' }]);
  const finish = path.join(h.base, 'finish');
  const ready = path.join(h.base, 'ready');
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(finish)})) process.exit(0); }, 100);`;
  let waiter;
  let closed;
  let writer;
  try {
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 0, stall_ms: 120000 })]);
    const file = path.join(h.state, 'events.jsonl');
    const row = JSON.stringify({ at: new Date().toISOString(), agent: 'fixture', cmd: 'hook progress', task: null, detail: { text: 'x'.repeat(900) } }) + '\n';
    const fd = fs.openSync(file, 'a');
    try {
      for (let n = 0; n < Math.ceil(50 * 1024 * 1024 / Buffer.byteLength(row)); n++) fs.writeSync(fd, row);
    } finally {
      fs.closeSync(fd);
    }
    // Node passes the profiler flags to the real monitor as well as the dispatch CLI.
    h.json(['spawn', '--task', 'T1'], { env: { ...h.env, NODE_OPTIONS: `--require "${HOOKS}" --cpu-prof --cpu-prof-dir="${profiles}"` } });
    const monitor = S.readEvents(h.state).findLast((e) => e.cmd === 'spawn').detail.monitor_pid;
    waiter = cp.spawn(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${profiles}`, '--require', HOOKS, BIN,
      'wait', '--observe', '--agent', 'orchestrator', '--for', 'unused', '--timeout', '60'], {
      cwd: h.repo, env: h.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    waiter.stderr.on('data', (d) => { stderr += d; });
    closed = once(waiter, 'close');
    let appended = 0;
    writer = setInterval(() => { fs.appendFileSync(file, row); appended += Buffer.byteLength(row); }, 1000);
    // Exclude cold startup and initial history loading from idle measurements.
    await pause(5000);
    if (!fs.existsSync(ready)) throw new Error('monitor harness not ready');
    const before = [sample(waiter.pid), sample(monitor)];
    const appendedBefore = appended;
    const start = performance.now();
    await pause(12000);
    const seconds = (performance.now() - start) / 1000;
    const after = [sample(waiter.pid), sample(monitor)];
    const measurements = after.map((a, i) => ({
      reader: ['wait', 'spawn-monitor'][i], cpu_percent: 100 * (a.ticks - before[i].ticks) / hz / seconds,
      rchar: a.rchar - before[i].rchar, appended: appended - appendedBefore, seconds,
    }));
    console.log(JSON.stringify({ label, run, measurements }));
    if (stderr) throw new Error(stderr);
    return measurements;
  } finally {
    clearInterval(writer);
    if (waiter) { waiter.kill('SIGINT'); await closed; }
    fs.writeFileSync(finish, '');
    await pause(1500);
    await h.cleanup();
  }
}

(async () => {
  const results = [];
  for (let run = 1; run <= 3; run++) results.push(...await measure(run));
  fs.writeFileSync(path.join(cache, `${label}.json`), JSON.stringify(results, null, 2) + '\n');
  for (const reader of ['wait', 'spawn-monitor']) {
    const samples = results.filter((m) => m.reader === reader);
    const range = (key) => {
      const values = samples.map((m) => m[key]).sort((a, b) => a - b);
      return { median: values[1], min: values[0], max: values[2] };
    };
    console.log(JSON.stringify({ reader, cpu_percent: range('cpu_percent'), rchar: range('rchar') }));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
