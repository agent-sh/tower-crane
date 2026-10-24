'use strict';
// One run of the four workloads for one option on one dataset. Every
// operation is a fresh process, as a CLI command or a harness hook is.
// Usage: node bench.js --option O --dataset NAME --run I --datasets DIR --work DIR --a-tree DIR --out FILE [--quick]
// Options: A-cli (the T254 CLI itself), A-proto, B, C-files, C-sqlite, D, and
// B-cli: the CLI of the tree --a-tree names on its own state.db (T267), which
// its first command migrates from the dataset's files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Resp } = require('./stores/resp');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const OPTION = arg('option');
const DATASET = arg('dataset');
const RUN = Number(arg('run'));
const QUICK = process.argv.includes('--quick');
const A_TREE = path.resolve(arg('a-tree'));
const WORK = path.resolve(arg('work'), `${OPTION}-${DATASET}-r${RUN}`);
const SRC = path.resolve(arg('datasets'), DATASET);
const OP = path.join(__dirname, 'op.js');
const NODE = process.execPath;
// Options that run a real CLI; the others run the storage prototypes in op.js.
const CLI = ['A-cli', 'B-cli'].includes(OPTION);
const PORT = 6390;

const CFG = {
  hookSeconds: QUICK ? 4 : 20, hookAgents: 8, sendEveryMs: 500,
  transSeconds: QUICK ? 6 : 30, writers: 6, pacedHookMs: 1000,
  replayReps: 3, recentEvents: 1000,
  crashCycles: QUICK ? 2 : 5, crashMinMs: 1500, crashMaxMs: 4000, crashHookAgents: 4, crashSendEveryMs: 100,
};
const WRITER_TASKS = ['T155', 'T166', 'T189', 'T194', 'T195', 'T196'];
const HOOK_TASKS = [...WRITER_TASKS, 'T202', 'T206'];

const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Kill points depend on dataset and run only, so every option meets the same schedule.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(RUN * 1000 + ['live', 's50', 's200'].indexOf(DATASET));

const TICK = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim());
function procCpu(pid, children) {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  // Fields after the name: utime=11 stime=12 cutime=13 cstime=14 (0-based here).
  return (children ? Number(f[13]) + Number(f[14]) : Number(f[11]) + Number(f[12])) / TICK;
}
let server = null;
function cpuNow() {
  let s = procCpu(process.pid, true);
  if (server && !server.exited) {
    try { s += procCpu(server.proc.pid, false); } catch { /* gone */ }
  }
  return s;
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_CRANE_')));
env.TMPDIR = process.env.TMPDIR || path.join(os.homedir(), '.cache', 'tct');
// BENCH_LOCK_TRACE=FILE has a CLI log each state lock holding (lib/state.js traceLock).
if (process.env.BENCH_LOCK_TRACE) env.TOWER_CRANE_LOCK_TRACE = path.resolve(process.env.BENCH_LOCK_TRACE);

// ---------------------------------------------------------------- setup

function setup() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const cfg = { aTree: A_TREE };
  if (['A-cli', 'B-cli', 'A-proto', 'C-files'].includes(OPTION)) {
    execFileSync('cp', ['-r', path.join(SRC, 'files'), path.join(WORK, 'files')]);
    cfg.dir = path.join(WORK, 'files');
  }
  if (['B', 'C-sqlite'].includes(OPTION)) {
    execFileSync('cp', [path.join(SRC, 'store.sqlite'), path.join(WORK, 'store.sqlite')]);
    cfg.db = path.join(WORK, 'store.sqlite');
  }
  if (OPTION === 'D') {
    execFileSync('cp', ['-r', path.join(SRC, 'valkey', 'appendonlydir'), path.join(WORK, 'appendonlydir')]);
    cfg.port = PORT;
  }
  if (OPTION.startsWith('C-')) cfg.socket = path.join(WORK, 'svc.sock');
  if (CLI) {
    const agents = [...HOOK_TASKS.map((t, i) => [`bench-h${i + 1}`, t]), ...WRITER_TASKS.map((t, i) => [`bench-w${i + 1}`, t])];
    for (const [agent, task] of agents) {
      const home = path.join(cfg.dir, 'homes', agent);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'hook.json'), JSON.stringify({ agent, task, state: cfg.dir, harness: 'claude', attempt: 1 }));
    }
  }
  if (OPTION === 'B-cli') {
    // The first command moves the files into state.db; the workloads start after it.
    const t0 = now();
    execFileSync(NODE, [...cliArgs(cfg, 'validate', {}).slice(0, 3), '--agent', 'orchestrator', 'task', 'show', WRITER_TASKS[0]], { env, stdio: 'ignore' });
    cfg.migrate_ms = now() - t0;
  }
  return cfg;
}

async function startServer(cfg) {
  const t0 = now();
  let proc;
  if (OPTION === 'D') {
    proc = spawn('valkey-server', ['--port', String(PORT), '--bind', '127.0.0.1', '--dir', WORK, '--appendonly', 'yes',
      '--appendfsync', 'always', '--save', '', '--appenddirname', 'appendonlydir', '--logfile', path.join(WORK, 'valkey.log')],
    { stdio: 'ignore', env });
  } else {
    const backend = OPTION === 'C-files' ? ['--backend', 'files', '--dir', cfg.dir] : ['--backend', 'sqlite', '--db', cfg.db];
    proc = spawn(NODE, ['--max-old-space-size=8192', path.join(__dirname, 'stores', 'service.js'), ...backend, '--socket', cfg.socket],
      { stdio: ['ignore', 'pipe', 'inherit'], env });
  }
  const s = { proc, exited: false };
  proc.once('exit', () => { s.exited = true; });
  if (OPTION === 'D') {
    for (;;) {
      if (s.exited) throw new Error('valkey-server exited at startup');
      try {
        const c = await Resp.connect({ port: PORT });
        const info = await c.call('INFO', 'persistence');
        c.close();
        // Anchored: INFO also has async_loading:0 while the load is running.
        if (/^loading:0\r?$/m.test(info)) break;
      } catch { /* loading or not listening yet */ }
      await sleep(20);
    }
  } else {
    await new Promise((resolve, reject) => {
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/ready (\{.*\})\n/);
        if (m) { s.redone = JSON.parse(m[1]).redone; resolve(); }
      });
      proc.once('exit', (code) => reject(new Error(`service exited ${code}`)));
    });
  }
  server = s;
  return now() - t0;
}

async function stopServer(signal = 'SIGTERM') {
  if (!server || server.exited) return;
  const gone = new Promise((r) => server.proc.once('exit', r));
  if (OPTION === 'D' && signal === 'SIGTERM') {
    try { const c = await Resp.connect({ port: PORT }); await c.call('SHUTDOWN').catch(() => {}); } catch { server.proc.kill('SIGTERM'); }
  } else {
    server.proc.kill(signal);
  }
  await gone;
}

// ---------------------------------------------------------------- operations

const live = new Set();
const randomSha = () => crypto.randomBytes(20).toString('hex');

function cliArgs(cfg, op, a) {
  const base = [path.join(A_TREE, 'bin', 'tower-crane.js'), '--state', cfg.dir];
  switch (op) {
    case 'hook': return [...base, '--agent', a.agent, 'hook', 'inbox', '--binding', path.join(cfg.dir, 'homes', a.agent, 'hook.json'), '--payload', '{}'];
    case 'send': return [...base, '--agent', 'orchestrator', 'msg', '--to', a.to, '--task', a.task, a.text];
    case 'transition': {
      const who = ['--agent', a.agent];
      if (a.kind === 'claim') return [...base, ...who, 'claim', a.task];
      if (a.kind === 'submit') return [...base, ...who, 'submit', a.task, '--sha', randomSha()];
      if (a.kind === 'evidence') return [...base, ...who, 'evidence', a.task, '--type', 'note', '--ok', '--summary', a.args?.text || 'ok'];
      if (a.kind === 'rework') return [...base, ...who, 'rework', a.task, '--reason', a.args?.text || 'again'];
      if (a.kind === 'note') return [...base, ...who, 'task', 'note', a.task, a.args.text];
      break;
    }
    case 'validate': return [...base, '--agent', 'orchestrator', 'validate'];
    default:
  }
  throw new Error(`no CLI form for ${op}`);
}

// Runs one operation in a fresh process; resolves with wall time from spawn to exit.
function runOp(cfg, op, a, { cli = CLI } = {}) {
  // A CLI has no replay or verify command. For A-cli those read its files the
  // way A-proto does; for B-cli, stores/cli.js reads state.db through the tree's lib.
  const viaCli = cli && !['replay', 'offsetBack', 'verify'].includes(op);
  const argv = viaCli ? cliArgs(cfg, op, a) : [OP, OPTION === 'A-cli' ? 'A-proto' : OPTION, JSON.stringify(cfg), op, JSON.stringify(a)];
  return new Promise((resolve) => {
    const t0 = now();
    const p = spawn(NODE, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    live.add(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code, signal) => {
      live.delete(p);
      const ms = now() - t0;
      if (viaCli) {
        const ok = code === 0;
        resolve({ ok, code, signal, ms, drift: op === 'validate' ? (out + err).split('\n').filter((l) => /drift|lacks|log records/i.test(l)).slice(0, 10) : undefined, delivered: op === 'hook' && ok && out.trim().length > 0 ? 1 : 0,
          conflict: code === 3 || /is (todo|rework|submitted|in_progress)|not in progress|not claimed/.test(err), error: ok ? null : err.trim().slice(0, 300) });
        return;
      }
      let r = {};
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch { r = { ok: false, error: (err || out).slice(0, 300) }; }
      resolve({ ok: code === 0 && r.ok, code, signal, ms, inner_ms: r.ms, result: r.result, delivered: r.result?.delivered || 0,
        busy: !!r.result?.busy, batch: r.result?.batch, conflict: !!r.conflict, error: r.ok ? null : (r.error || err).slice(0, 300) });
    });
  });
}

function killLive() {
  for (const p of live) {
    try { p.kill('SIGKILL'); } catch { /* exited */ }
  }
}

// ---------------------------------------------------------------- phases

function phaseStats(t0, cpu0) {
  const wall = (now() - t0) / 1000;
  const cpu = cpuNow() - cpu0;
  return { wall_s: wall, cpu_s: cpu, cores: cpu / wall, load: os.loadavg()[0] };
}

async function phaseHooks(cfg) {
  const r = { empty: [], delivered: [], sends: [], busy: 0, errors: [], load_before: os.loadavg()[0] };
  const agents = HOOK_TASKS.slice(0, CFG.hookAgents).map((task, i) => ({ agent: `bench-h${i + 1}`, task }));
  const t0 = now();
  const cpu0 = cpuNow();
  const until = t0 + CFG.hookSeconds * 1000;
  const pollers = agents.map(({ agent, task }) => (async () => {
    while (now() < until) {
      const x = await runOp(cfg, 'hook', { agent, task });
      if (!x.ok) { r.errors.push(x.error); continue; }
      (x.delivered ? r.delivered : r.empty).push(x.ms);
      if (x.busy) r.busy++;
    }
  })());
  const sender = (async () => {
    for (let i = 0; now() < until; i++) {
      const to = agents[i % agents.length];
      const x = await runOp(cfg, 'send', { from: 'orchestrator', to: to.agent, task: to.task, text: `m-${RUN}-${i}` });
      if (x.ok) r.sends.push(x.ms); else r.errors.push(x.error);
      await sleep(CFG.sendEveryMs);
    }
  })();
  await Promise.all([...pollers, sender]);
  return { ...r, ...phaseStats(t0, cpu0) };
}

async function phaseTransitions(cfg) {
  const r = { claim: [], submit: [], evidence: [], rework: [], hooks: [], conflicts: 0, errors: [], cycles: 0, load_before: os.loadavg()[0] };
  const t0 = now();
  const cpu0 = cpuNow();
  const until = t0 + CFG.transSeconds * 1000;
  const queue = [];
  let wake = null;
  const back = new Map();
  const step = async (task, agent, kind) => {
    for (let tries = 0; tries < 20; tries++) {
      const x = await runOp(cfg, 'transition', { task, agent, kind, args: { text: `${kind}-${RUN}` } });
      if (x.ok) { r[kind].push(x.ms); return true; }
      if (x.conflict) r.conflicts++; else r.errors.push(`${kind} ${task}: ${x.error}`);
      if (now() >= until) return false;
      await sleep(100);
    }
    return false;
  };
  const writers = WRITER_TASKS.slice(0, CFG.writers).map((task, i) => (async () => {
    const agent = `bench-w${i + 1}`;
    while (now() < until) {
      if (!await step(task, agent, 'claim')) break;
      if (!await step(task, agent, 'submit')) break;
      if (!await step(task, agent, 'evidence')) break;
      if (now() >= until) break;
      const done = new Promise((res) => back.set(task, res));
      queue.push(task);
      if (wake) wake();
      if (!await done) break;
      r.cycles++;
    }
  })());
  // Automation: send each submitted task back, as the review reaction does.
  // It runs until every writer has stopped, so no writer waits on it forever.
  let writersDone = false;
  const automation = (async () => {
    for (;;) {
      if (queue.length) {
        const task = queue.shift();
        const ok = now() < until && await step(task, 'orchestrator', 'rework');
        back.get(task)(ok);
        continue;
      }
      if (writersDone) break;
      await new Promise((res) => { wake = res; setTimeout(res, 200); });
    }
  })();
  const hooks = WRITER_TASKS.slice(0, CFG.writers).map((task, i) => (async () => {
    while (now() < until) {
      const x = await runOp(cfg, 'hook', { agent: `bench-w${i + 1}`, task });
      if (x.ok) r.hooks.push(x.ms); else r.errors.push(`hook: ${x.error}`);
      await sleep(CFG.pacedHookMs);
    }
  })());
  await Promise.all(writers);
  writersDone = true;
  if (wake) wake();
  await Promise.all([automation, ...hooks]);
  return { ...r, ...phaseStats(t0, cpu0) };
}

async function phaseReplay(cfg) {
  const off = await runOp(cfg, 'offsetBack', { n: CFG.recentEvents });
  if (!off.ok) throw new Error(`offsetBack failed: ${off.error}`);
  const r = { from0: [], recent: [], count0: null, countRecent: null, inner0: [], innerRecent: [] };
  for (let i = 0; i < CFG.replayReps; i++) {
    const a = await runOp(cfg, 'replay', { from: 0 });
    const b = await runOp(cfg, 'replay', { from: off.result });
    if (!a.ok || !b.ok) throw new Error(`replay failed: ${a.error || b.error}`);
    r.from0.push(a.ms); r.recent.push(b.ms); r.inner0.push(a.inner_ms); r.innerRecent.push(b.inner_ms);
    r.count0 = a.result.count; r.countRecent = b.result.count;
  }
  return r;
}

async function verify(cfg) {
  if (OPTION.startsWith('C-')) {
    const x = await runOp(cfg, 'verify', {});
    if (!x.ok) throw new Error(`verify failed: ${x.error}`);
    return x.result;
  }
  const x = await runOp(cfg, 'verify', {});
  if (!x.ok) throw new Error(`verify failed: ${x.error}`);
  return x.result;
}

async function phaseCrash(cfg) {
  const ackedNotes = new Set();
  const ackedMsgs = new Set();
  const cycles = [];
  const agents = HOOK_TASKS.slice(0, CFG.crashHookAgents).map((task, i) => ({ agent: `bench-h${i + 1}`, task }));
  for (let c = 1; c <= CFG.crashCycles; c++) {
    let crashing = false;
    let inflightAtKill = 0;
    let n = 0;
    const writers = WRITER_TASKS.map((task, w) => (async () => {
      while (!crashing) {
        const text = `tok-r${RUN}-c${c}-w${w}-${n++}`;
        const x = await runOp(cfg, 'transition', { task, agent: `bench-w${w + 1}`, kind: 'note', args: { text } });
        if (x.ok && !x.signal) ackedNotes.add(text);
      }
    })());
    const sender = (async () => {
      for (let i = 0; !crashing; i++) {
        const to = agents[i % agents.length];
        const text = `tok-r${RUN}-c${c}-m${i}`;
        const x = await runOp(cfg, 'send', { from: 'orchestrator', to: to.agent, task: to.task, text });
        if (x.ok && !x.signal) ackedMsgs.add(text);
        await sleep(CFG.crashSendEveryMs);
      }
    })();
    const pollers = agents.map(({ agent, task }) => (async () => {
      while (!crashing) await runOp(cfg, 'hook', { agent, task });
    })());
    const killAt = CFG.crashMinMs + random() * (CFG.crashMaxMs - CFG.crashMinMs);
    await sleep(killAt);
    crashing = true;
    inflightAtKill = live.size;
    if (server) server.proc.kill('SIGKILL');
    killLive();
    await Promise.all([...writers, sender, ...pollers]);
    if (server) await new Promise((r) => (server.exited ? r() : server.proc.once('exit', r)));
    // Recovery: restart the owner process if there is one, then time the first acknowledged write.
    const t0 = now();
    const restartMs = server ? await startServer(cfg) : 0;
    let first = null;
    let firstErrors = 0;
    while (now() - t0 < 120000) {
      const text = `tok-r${RUN}-c${c}-post`;
      const x = await runOp(cfg, 'transition', { task: WRITER_TASKS[0], agent: 'bench-w1', kind: 'note', args: { text } });
      if (x.ok) { ackedNotes.add(text); first = now() - t0; break; }
      firstErrors++;
      await sleep(50);
    }
    const tv = now();
    const v = await verify(cfg);
    const verifyMs = now() - tv;
    // validate reads the whole plan and takes tens of seconds here, so it
    // runs once, after the last crash.
    let validate = null;
    if (CLI && c === CFG.crashCycles) {
      const x = await runOp(cfg, 'validate', {});
      validate = { ok: x.ok, ms: x.ms, drift_lines: x.drift, error: x.ok ? null : x.error };
    }
    const taskTok = new Set(v.taskTokens);
    const noteTok = new Set(v.noteTokens);
    const msgTok = new Set(v.msgTokens);
    const lostNotes = [...ackedNotes].filter((t) => !taskTok.has(t) || !noteTok.has(t));
    const lostMsgs = [...ackedMsgs].filter((t) => !msgTok.has(t));
    cycles.push({
      cycle: c, kill_at_ms: Math.round(killAt), inflight_at_kill: inflightAtKill,
      acked_notes: ackedNotes.size, acked_msgs: ackedMsgs.size,
      lost_acked: lostNotes.length + lostMsgs.length, lost_examples: [...lostNotes, ...lostMsgs].slice(0, 5),
      state_without_event: [...taskTok].filter((t) => !noteTok.has(t)).length,
      event_without_state: [...noteTok].filter((t) => !taskTok.has(t)).length,
      inbox_mismatch: v.inboxMismatch, bad_lines: v.badLines, torn_tail: !!v.tornTail, integrity: v.integrity ?? null,
      restart_ms: restartMs, redone_after_restart: server?.redone ?? null, first_write_ms: first, first_write_failures: firstErrors, verify_ms: verifyMs, validate,
    });
  }
  return { cycles };
}

// ---------------------------------------------------------------- main

async function main() {
  const out = arg('out');
  const cfg = setup();
  const result = { option: OPTION, dataset: DATASET, run: RUN, quick: QUICK, started: new Date().toISOString(), host: { cpus: os.cpus().length, load_start: os.loadavg() }, cfg: CFG };
  if (cfg.migrate_ms !== undefined) result.migrate_ms = cfg.migrate_ms;
  try {
    if (OPTION === 'D' || OPTION.startsWith('C-')) result.startup_ms = await startServer(cfg);
    result.hooks = await phaseHooks(cfg);
    process.stderr.write(`[${OPTION} ${DATASET} r${RUN}] hooks done\n`);
    result.transitions = await phaseTransitions(cfg);
    process.stderr.write(`[${OPTION} ${DATASET} r${RUN}] transitions done\n`);
    result.replay = await phaseReplay(cfg);
    result.crash = await phaseCrash(cfg);
    process.stderr.write(`[${OPTION} ${DATASET} r${RUN}] crash done\n`);
  } catch (e) {
    result.error = String(e.stack || e);
    process.stderr.write(`[${OPTION} ${DATASET} r${RUN}] failed: ${e.stack}\n`);
  } finally {
    killLive();
    await stopServer().catch(() => {});
  }
  result.finished = new Date().toISOString();
  result.host.load_end = os.loadavg();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result) + '\n');
  if (!process.argv.includes('--keep')) fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(result.error ? 1 : 0);
}

main();
