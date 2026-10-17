'use strict';
// Storage cost without process startup: one process runs the same operation
// sequentially, no concurrency, so the number is what the storage layer adds
// to each command. bench.js measures the same operations end to end, a fresh
// process each, under load.
// Usage: node microbench.js --datasets DIR --work DIR --a-tree DIR --out FILE [--n 200]
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Resp } = require('./stores/resp');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? d : process.argv[i + 1]; };
const N = Number(arg('n', 200));
const A_TREE = path.resolve(arg('a-tree'));
const NODE = process.execPath;
const PORT = 6393;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOWER_CRANE_')));

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}

async function server(option, cfg, work) {
  let proc;
  if (option === 'D') {
    proc = spawn('valkey-server', ['--port', String(PORT), '--bind', '127.0.0.1', '--dir', work, '--appendonly', 'yes', '--appendfsync', 'always',
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
    proc = spawn(NODE, ['--max-old-space-size=8192', path.join(__dirname, 'stores', 'service.js'), ...backend, '--socket', cfg.socket], { stdio: ['ignore', 'pipe', 'inherit'], env });
    await new Promise((resolve) => { let b = ''; proc.stdout.on('data', (d) => { b += d; if (b.includes('ready')) resolve(); }); });
  }
  return proc;
}

async function measure(option, dataset) {
  const src = path.resolve(arg('datasets'), dataset);
  const work = path.resolve(arg('work'), `micro-${option}-${dataset}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const cfg = { aTree: A_TREE };
  if (['A-proto', 'C-files'].includes(option)) { execFileSync('cp', ['-r', path.join(src, 'files'), path.join(work, 'files')]); cfg.dir = path.join(work, 'files'); }
  if (['B', 'C-sqlite'].includes(option)) { execFileSync('cp', [path.join(src, 'store.sqlite'), path.join(work, 'store.sqlite')]); cfg.db = path.join(work, 'store.sqlite'); }
  if (option === 'D') { execFileSync('cp', ['-r', path.join(src, 'valkey', 'appendonlydir'), path.join(work, 'appendonlydir')]); cfg.port = PORT; }
  if (option.startsWith('C-')) cfg.socket = path.join(work, 'svc.sock');
  const proc = option === 'D' || option.startsWith('C-') ? await server(option, cfg, work) : null;
  const S = option.startsWith('C-') ? null : require({ 'A-proto': './stores/files', B: './stores/sqlite', D: './stores/valkey' }[option]);
  const call = require('./stores/service').call;
  // Each operation opens the store, as a command does; only process startup is left out.
  const op = async (name, a) => {
    if (S) {
      const h = await S.open(cfg);
      try {
        return name === 'hook' ? await S.hook(h, a.agent, a.task) : await S.transition(h, a.task, a.agent, a.kind, a.args);
      } finally { S.close(h); }
    }
    const r = await call(cfg.socket, name, a);
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  const out = { option, dataset, hook: [], note: [] };
  const n = option === 'A-proto' ? Math.min(N, 30) : N;
  for (let i = 0; i < n; i++) {
    let t = performance.now();
    await op('hook', { agent: 'bench-h1', task: 'T155' });
    out.hook.push(performance.now() - t);
    t = performance.now();
    await op('transition', { task: 'T155', agent: 'bench-w1', kind: 'note', args: { text: `micro-${i}` } });
    out.note.push(performance.now() - t);
  }
  if (proc) { proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r)); }
  fs.rmSync(work, { recursive: true, force: true });
  return { option, dataset, n, hook_p50: pct(out.hook, 50), hook_p95: pct(out.hook, 95), note_p50: pct(out.note, 50), note_p95: pct(out.note, 95) };
}

async function main() {
  const res = [];
  for (const dataset of ['live', 's50', 's200']) {
    for (const option of ['A-proto', 'B', 'C-files', 'C-sqlite', 'D']) {
      const r = await measure(option, dataset);
      res.push(r);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    }
  }
  fs.mkdirSync(path.dirname(arg('out')), { recursive: true });
  fs.writeFileSync(arg('out'), JSON.stringify(res, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
