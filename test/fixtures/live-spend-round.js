'use strict';

// One stress round of test/live-spend.test.js: COPIES runs of the file at
// once (default 12), so supervisors, harnesses and CLI calls of different
// copies compete for the machine as they do on a loaded CI runner. The runner
// caps its own file workers at 4, so the copies are separate runs. Exits 1,
// with each failing copy's failures, when any copy fails.
//   node test/fixtures/live-spend-round.js [--round N] [--copies COPIES]

const cp = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const round = option('--round', 1);
const copies = option('--copies', 12);
if (!Number.isSafeInteger(copies) || copies < 1) {
  console.error('--copies requires a positive integer');
  process.exit(1);
}
const root = path.join(__dirname, '..', '..');
const runs = Array.from({ length: copies }, (_, copy) => new Promise((resolve) => {
  const child = cp.spawn(process.execPath, [path.join(root, 'test', 'run.js'), 'test/live-spend.test.js'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code, signal) => resolve({ copy, code, signal, out }));
}));
Promise.all(runs).then((results) => {
  const failed = results.filter((r) => r.code !== 0);
  for (const r of results) {
    const count = (name) => new RegExp(`^ℹ ${name} (\\d+)$`, 'm').exec(r.out)?.[1];
    console.log(`round ${round} copy ${r.copy}: exit ${r.code ?? r.signal}, pass ${count('pass') ?? '-'}, fail ${count('fail') ?? '-'}`);
  }
  for (const r of failed) {
    // The runner lists every failure after its summary.
    const at = r.out.indexOf('✖ failing tests:');
    console.log(`\nround ${round} copy ${r.copy} failures:\n${(at < 0 ? r.out.slice(-4000) : r.out.slice(at)).slice(0, 8000)}`);
  }
  console.log(`round ${round}: ${copies - failed.length} of ${copies} copies passed`);
  process.exit(failed.length ? 1 : 0);
});
