'use strict';
// One storage operation in a fresh process, the way a CLI command or a hook
// runs. Usage: node op.js OPTION CONFIG_JSON OP ARGS_JSON
// Prints one JSON line. Exit 0 when acknowledged, 3 when refused by its
// precondition, 1 on any other failure.
const { performance } = require('node:perf_hooks');

const STORES = { 'A-proto': './stores/files', B: './stores/sqlite', D: './stores/valkey' };

async function run(option, cfg, op, a) {
  if (option.startsWith('C-')) {
    if (op === 'replay' || op === 'offsetBack') {
      // Readers of the log read the backend directly; the service is not in that path.
      const S = require(option === 'C-files' ? './stores/files' : './stores/sqlite');
      const h = S.open(option === 'C-files' ? { dir: cfg.dir, aTree: cfg.aTree } : { db: cfg.db });
      try { return op === 'replay' ? S.replay(h, a.from) : S.offsetBack(h, a.n); } finally { S.close(h); }
    }
    const r = await require('./stores/service').call(cfg.socket, op, a);
    if (!r.ok) {
      const e = new Error(r.error);
      if (r.conflict) e.code = 'CONFLICT';
      throw e;
    }
    return { ...r.result, batch: r.batch };
  }
  const S = require(STORES[option]);
  const h = await S.open(cfg);
  try {
    switch (op) {
      case 'transition': return await S.transition(h, a.task, a.agent, a.kind, a.args);
      case 'send': return await S.send(h, a.from, a.to, a.task, a.text);
      case 'hook': return await S.hook(h, a.agent, a.task);
      case 'replay': return await S.replay(h, a.from);
      case 'offsetBack': return await S.offsetBack(h, a.n);
      case 'verify': return await S.verify(h);
      default: throw new Error(`unknown op ${op}`);
    }
  } finally {
    S.close(h);
  }
}

async function main() {
  const [option, cfg, op, args] = process.argv.slice(2);
  const t0 = performance.now();
  try {
    const result = await run(option, JSON.parse(cfg), op, JSON.parse(args || '{}'));
    process.stdout.write(JSON.stringify({ ok: true, ms: performance.now() - t0, result }) + '\n');
    process.exitCode = 0;
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, ms: performance.now() - t0, conflict: e.code === 'CONFLICT', error: String(e.message).slice(0, 300) }) + '\n');
    process.exitCode = e.code === 'CONFLICT' ? 3 : 1;
  }
}

main();
