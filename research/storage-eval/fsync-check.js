'use strict';
// Equal durability check: counts fsync and fdatasync calls per acknowledged
// write with strace, so "fsync per acknowledged write" is measured, not
// assumed. Each option runs the same sequence of writes one at a time:
// note transitions (task record + event) and messages (event only).
// Usage: node fsync-check.js --datasets DIR --work DIR --a-tree DIR --out FILE [--dataset live] [--writes 20]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { Resp } = require('./stores/resp');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? d : process.argv[i + 1]; };
const DATASET = arg('dataset', 'live');
const WRITES = Number(arg('writes', 20));
const A_TREE = path.resolve(arg('a-tree'));
const SRC = path.resolve(arg('datasets'), DATASET);
const NODE = process.execPath;
const PORT = 6390;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_CRANE_')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function counts(file) {
  const out = { fsync: 0, fdatasync: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.at(-1) === 'fsync' || m.at(-1) === 'fdatasync') out[m.at(-1)] = Number(m[3]);
  }
  return out;
}

function writes(option, cfg) {
  const ops = [];
  for (let i = 0; i < WRITES; i++) {
    ops.push(i % 2 === 0
      ? { op: 'transition', a: { task: 'T155', agent: 'bench-w1', kind: 'note', args: { text: `fs-${i}` } } }
      : { op: 'send', a: { from: 'orchestrator', to: 'bench-h1', task: 'T155', text: `fs-${i}` } });
  }
  return ops.map(({ op, a }) => {
    if (option !== 'A-cli') return [path.join(__dirname, 'op.js'), option, JSON.stringify(cfg), op, JSON.stringify(a)];
    const base = [path.join(A_TREE, 'bin', 'tower-crane.js'), '--state', cfg.dir];
    return op === 'send'
      ? [...base, '--agent', 'orchestrator', 'msg', '--to', a.to, '--task', a.task, a.text]
      : [...base, '--agent', a.agent, 'task', 'note', a.task, a.args.text];
  });
}

// The owner process runs under strace from its start: attaching to a running
// process needs ptrace rights that Yama withholds from a sibling.
async function startServer(option, cfg, work, trace) {
  // Its own process group, so one signal stops strace and the traced server.
  const traced = (cmd, args, opts) => spawn('strace', ['-f', '-tt', '-e', 'trace=fsync,fdatasync', '-o', trace, cmd, ...args], { ...opts, detached: true });
  let proc;
  if (option === 'D') {
    proc = traced('valkey-server', ['--port', String(PORT), '--bind', '127.0.0.1', '--dir', work, '--appendonly', 'yes', '--appendfsync', 'always',
      '--save', '', '--appenddirname', 'appendonlydir', '--logfile', path.join(work, 'valkey.log')], { stdio: 'ignore', env });
    for (;;) {
      try {
        const c = await Resp.connect({ port: PORT });
        const info = await c.call('INFO', 'persistence');
        c.close();
        if (/^loading:0\r?$/m.test(info)) break;
      } catch { /* not up */ }
      await sleep(20);
    }
  } else {
    const backend = option === 'C-files' ? ['--backend', 'files', '--dir', cfg.dir] : ['--backend', 'sqlite', '--db', cfg.db];
    proc = traced(NODE, [path.join(__dirname, 'stores', 'service.js'), ...backend, '--socket', cfg.socket], { stdio: ['ignore', 'pipe', 'inherit'], env });
    await new Promise((resolve) => { let b = ''; proc.stdout.on('data', (d) => { b += d; if (b.includes('ready')) resolve(); }); });
  }
  return proc;
}

async function check(option) {
  const work = path.resolve(arg('work'), `fsync-${option}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const cfg = { aTree: A_TREE };
  if (['A-cli', 'A-proto', 'C-files'].includes(option)) {
    execFileSync('cp', ['-r', path.join(SRC, 'files'), path.join(work, 'files')]);
    cfg.dir = path.join(work, 'files');
  }
  if (['B', 'C-sqlite'].includes(option)) {
    execFileSync('cp', [path.join(SRC, 'store.sqlite'), path.join(work, 'store.sqlite')]);
    cfg.db = path.join(work, 'store.sqlite');
  }
  if (option === 'D') {
    execFileSync('cp', ['-r', path.join(SRC, 'valkey', 'appendonlydir'), path.join(work, 'appendonlydir')]);
    cfg.port = PORT;
  }
  if (option.startsWith('C-')) cfg.socket = path.join(work, 'svc.sock');
  const trace = path.join(work, 'strace.txt');
  const argvs = writes(option, cfg);
  let acked = 0;
  let serverCounts = null;
  if (['A-cli', 'A-proto', 'B'].includes(option)) {
    // The writing process is the client; trace it and its children.
    const script = path.join(work, 'run.sh');
    fs.writeFileSync(script, argvs.map((a) => [NODE, ...a].map((x) => `'${x.replaceAll("'", "'\\''")}'`).join(' ') + ' >/dev/null && echo ACK').join('\n') + '\n');
    const r = spawnSync('strace', ['-f', '--seccomp-bpf', '-c', '-e', 'trace=fsync,fdatasync', '-o', trace, 'sh', script], { env, encoding: 'utf8' });
    acked = (r.stdout.match(/ACK/g) || []).length;
  } else {
    // The owner process writes; count its syncs between the first and the last write.
    const proc = await startServer(option, cfg, work, trace);
    await sleep(500);
    const calls = () => fs.readFileSync(trace, 'utf8').split('\n').filter((l) => /\b(fsync|fdatasync)\(/.test(l));
    const before = calls().length;
    for (const a of argvs) {
      const r = spawnSync(NODE, a, { env, encoding: 'utf8' });
      if (r.status === 0) acked++;
    }
    await sleep(300);
    const during = calls().slice(before);
    serverCounts = { fsync: during.filter((l) => /\bfsync\(/.test(l)).length, fdatasync: during.filter((l) => /\bfdatasync\(/.test(l)).length };
    if (option === 'D') {
      const c = await Resp.connect({ port: PORT });
      await c.call('SHUTDOWN', 'NOSAVE').catch(() => {});
    }
    const gone = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    await Promise.race([gone, sleep(3000)]);
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    await gone;
  }
  const c = serverCounts || counts(trace);
  fs.rmSync(work, { recursive: true, force: true });
  return { option, dataset: DATASET, writes: argvs.length, acked, ...c, syncs_per_ack: acked ? (c.fsync + c.fdatasync) / acked : null };
}

async function main() {
  const out = [];
  const only = arg('only');
  for (const option of only ? only.split(',') : ['A-cli', 'A-proto', 'B', 'C-files', 'C-sqlite', 'D']) {
    const r = await check(option);
    out.push(r);
    process.stdout.write(`${JSON.stringify(r)}\n`);
  }
  fs.mkdirSync(path.dirname(arg('out')), { recursive: true });
  const prev = fs.existsSync(arg('out')) ? JSON.parse(fs.readFileSync(arg('out'), 'utf8')) : [];
  const merged = [...prev.filter((p) => !out.some((o) => o.option === p.option)), ...out];
  fs.writeFileSync(arg('out'), JSON.stringify(merged, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
