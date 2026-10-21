#!/usr/bin/env node
'use strict';

// Runs test files in parallel lanes, each lane running them again until it has
// passed the given number of times in a row, so a race that only shows under
// load fails here instead of in a merge-queue suite.
//
//   node scripts/repeat-test.js [--copies N] [--runs N] FILE...
//
// The first failing run stops every lane; its output is printed and the
// script exits 1.

const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function flags(argv) {
  const out = { copies: 4, runs: 20, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--copies' || argv[i] === '--runs') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${argv[i - 1]} needs a positive integer`);
      out[argv[i - 1].slice(2)] = value;
    } else out.files.push(argv[i]);
  }
  if (!out.files.length) throw new Error('usage: node scripts/repeat-test.js [--copies N] [--runs N] FILE...');
  return out;
}

async function main() {
  const { copies, runs, files } = flags(process.argv.slice(2));
  const running = new Set();
  let failed = null;
  const runOnce = () => new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'test', 'run.js'), '--test-concurrency=4', ...files],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    running.add(child);
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code, signal) => {
      running.delete(child);
      resolve({ code, signal, output });
    });
  });
  const started = Date.now();
  const lane = async (n) => {
    for (let run = 1; run <= runs && !failed; run++) {
      const result = await runOnce();
      if (failed) return;
      if (result.code !== 0) {
        failed = { lane: n, run, ...result };
        for (const child of running) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* It already exited. */ }
        }
        return;
      }
      process.stdout.write(`lane ${n} run ${run}/${runs} passed\n`);
    }
  };
  await Promise.all(Array.from({ length: copies }, (_, i) => lane(i + 1)));
  const seconds = Math.round((Date.now() - started) / 1000);
  if (failed) {
    process.stdout.write(failed.output);
    process.stdout.write(`\nlane ${failed.lane} run ${failed.run} failed (${failed.signal || `exit ${failed.code}`}) after ${seconds} s: ${files.join(' ')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${files.join(' ')} passed ${runs} times in a row in each of ${copies} parallel copies (${seconds} s)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
