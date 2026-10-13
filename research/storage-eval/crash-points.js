'use strict';
// Deterministic crash points, next to the random kill -9 of bench.js. strace
// kills the writing process (the CLI for A and B, the owner for C and D) with
// SIGKILL at the first write, or the first sync, to its commit file. Then the
// store is reopened and checked: the unacknowledged write may be absent or
// present, but a task change must never be present without its event.
// Usage: node crash-points.js --datasets DIR --work DIR --a-tree DIR --out FILE [--dataset live]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { Resp } = require('./stores/resp');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? d : process.argv[i + 1]; };
const DATASET = arg('dataset', 'live');
const A_TREE = path.resolve(arg('a-tree'));
const SRC = path.resolve(arg('datasets'), DATASET);
const NODE = process.execPath;
// Not the bench port, so this can never meet a bench server.
const PORT = 6392;
const OP = path.join(__dirname, 'op.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_CRANE_')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(option, work) {
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
  return cfg;
}

function commitFile(option, cfg, work) {
  if (['A-cli', 'A-proto', 'C-files'].includes(option)) return path.join(cfg.dir, 'events.jsonl');
  if (['B', 'C-sqlite'].includes(option)) return `${cfg.db}-wal`;
  const manifest = fs.readFileSync(path.join(work, 'appendonlydir', 'appendonly.aof.manifest'), 'utf8');
  return path.join(work, 'appendonlydir', /file (\S+) seq \d+ type i/.exec(manifest)[1]);
}

const SYSCALLS = { write: 'write,pwrite64,writev,pwritev,pwritev2', sync: 'fsync,fdatasync' };

function strace(file, point, log) {
  return ['strace', '-f', '-qq', '-o', log, '-P', file, '-e', `trace=${SYSCALLS[point]}`, '-e', `inject=${SYSCALLS[point]}:signal=KILL:when=1`];
}

function noteArgv(option, cfg, text) {
  if (option === 'A-cli') {
    return [NODE, path.join(A_TREE, 'bin', 'tower-crane.js'), '--state', cfg.dir, '--agent', 'bench-w1', 'task', 'note', 'T155', text];
  }
  return [NODE, OP, option, JSON.stringify(cfg), 'transition', JSON.stringify({ task: 'T155', agent: 'bench-w1', kind: 'note', args: { text } })];
}

function serverArgv(option, cfg, work) {
  if (option === 'D') {
    return ['valkey-server', '--port', String(PORT), '--bind', '127.0.0.1', '--dir', work, '--appendonly', 'yes', '--appendfsync', 'always',
      '--save', '', '--appenddirname', 'appendonlydir', '--logfile', path.join(work, 'valkey.log')];
  }
  const backend = option === 'C-files' ? ['--backend', 'files', '--dir', cfg.dir] : ['--backend', 'sqlite', '--db', cfg.db];
  return [NODE, path.join(__dirname, 'stores', 'service.js'), ...backend, '--socket', cfg.socket];
}

async function ready(option, proc) {
  if (option === 'D') {
    for (;;) {
      if (proc.exitCode !== null) throw new Error('server exited');
      try {
        const c = await Resp.connect({ port: PORT });
        const info = await c.call('INFO', 'persistence');
        c.close();
        if (/^loading:0\r?$/m.test(info)) return;
      } catch { /* not up */ }
      await sleep(20);
    }
  }
  await new Promise((resolve, reject) => {
    let b = '';
    proc.stdout.on('data', (d) => { b += d; if (b.includes('ready')) resolve(); });
    proc.once('exit', () => reject(new Error('server exited')));
  });
}

async function startServer(option, cfg, work, prefix = []) {
  const argv = [...prefix, ...serverArgv(option, cfg, work)];
  const proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'inherit'], env, detached: true });
  await ready(option, proc);
  return proc;
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  const gone = new Promise((r) => proc.once('exit', r));
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
  await gone;
}

function verify(option, cfg) {
  const r = spawnSync(NODE, [OP, option === 'A-cli' ? 'A-proto' : option, JSON.stringify(cfg), 'verify', '{}'], { env, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim()).result;
}

async function scenario(option, point) {
  const work = path.resolve(arg('work'), `cp-${option}-${point}`);
  const cfg = setup(option, work);
  const file = commitFile(option, cfg, work);
  const log = path.join(work, 'strace.txt');
  const text = `tok-cp-${option}-${point}`;
  let acked = false;
  let killed = false;
  let server = null;
  let restartMs = null;
  if (option.startsWith('C-') || option === 'D') {
    server = await startServer(option, cfg, work, strace(file, point, log));
    const argv = noteArgv(option, cfg, text);
    const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', timeout: 20000 });
    acked = r.status === 0;
    await Promise.race([new Promise((res) => server.once('exit', res)), sleep(3000)]);
    killed = server.exitCode !== null || server.signalCode !== null;
    await stop(server);
    // Recovery: a plain restart of the owner process.
    const t0 = Date.now();
    server = await startServer(option, cfg, work);
    restartMs = Date.now() - t0;
  } else {
    const argv = [...strace(file, point, log), ...noteArgv(option, cfg, text)];
    const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', timeout: 120000 });
    acked = r.status === 0;
    killed = r.status === 137 || r.signal === 'SIGKILL' || /killed by SIGKILL/.test(fs.readFileSync(log, 'utf8'));
  }
  const after = `tok-cp-${option}-${point}-after`;
  const argv = noteArgv(option, cfg, after);
  const next = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', timeout: 120000 });
  const v = option.startsWith('C-') ? JSON.parse(spawnSync(NODE, [OP, option, JSON.stringify(cfg), 'verify', '{}'], { env, encoding: 'utf8' }).stdout.trim()).result : verify(option, cfg);
  await stop(server);
  const inTask = v.taskTokens.includes(text);
  const inLog = v.noteTokens.includes(text);
  const result = {
    option, point, file: path.basename(file), killed, acked,
    unacked_in_task: inTask, unacked_in_log: inLog,
    consistent: inTask === inLog && v.inboxMismatch === 0 && v.badLines === 0 && (v.integrity ?? 'ok') === 'ok',
    torn_tail: !!v.tornTail, next_write_ok: next.status === 0 && v.taskTokens.includes(after) && v.noteTokens.includes(after),
    restart_ms: restartMs,
  };
  fs.rmSync(work, { recursive: true, force: true });
  return result;
}

async function main() {
  const out = [];
  const options = (arg('only') || 'A-cli,A-proto,B,C-files,C-sqlite,D').split(',');
  for (const option of options) {
    for (const point of ['write', 'sync']) {
      // T254 never syncs the event log, so A-cli has no sync point to stop at.
      if (option === 'A-cli' && point === 'sync') {
        out.push({ option, point, skipped: 'T254 does not fsync events.jsonl' });
        continue;
      }
      const r = await scenario(option, point);
      out.push(r);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    }
  }
  fs.mkdirSync(path.dirname(arg('out')), { recursive: true });
  fs.writeFileSync(arg('out'), JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
