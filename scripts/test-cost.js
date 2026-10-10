#!/usr/bin/env node
'use strict';

// Measures each test file alone: wall seconds and CPU seconds of the file's
// reaped process tree, median of N runs, with at most J files at once.
// --before DIR measures another checkout too, interleaved with this one so
// both see the same machine load, and prints them side by side.
// Linux only, since the CPU figure comes from /proc cutime and cstime.
// Every fixture must await its children's exit; test/browser.js does so in
// file teardown. Background children abandoned at exit cannot be counted.
//
//   node scripts/test-cost.js [--runs 3] [--jobs 4] [--before DIR] [--after DIR] [--json out.json] [files...]
//
// With --json, each sample is also appended to out.json.samples.jsonl as it
// completes, and a later run with the same --json resumes from them.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRepoSeed, cleanupRepoSeed } = require('../test/repo-seed');

const ROOT = path.join(__dirname, '..');
// The wrapper waits for the file's runner, so the kernel adds every reaped
// descendant's CPU time to the wrapper's cutime and cstime.
const WRAPPER = `
const cp = require('node:child_process');
const fs = require('node:fs');
const argv = JSON.parse(process.argv[1]);
const start = process.hrtime.bigint();
const r = cp.spawnSync(process.execPath, argv, { stdio: 'ignore', timeout: 600000, killSignal: 'SIGKILL' });
const wall = Number(process.hrtime.bigint() - start) / 1e9;
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
const tick = 100;
const cpu = (Number(f[13]) + Number(f[14])) / tick;
process.stdout.write(JSON.stringify({ wall, cpu, status: r.status }));
`;

function measure(root, argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const isolated = { ...env };
    delete isolated.NODE_TEST_CONTEXT;
    const child = cp.spawn(process.execPath, ['-e', WRAPPER, JSON.stringify(argv)], { cwd: root, env: isolated });
    let out = '';
    let error = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (error += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`measurement failed: ${error}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  if (process.platform !== 'linux') throw new Error('test-cost reads /proc; run it on Linux');
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    return args.splice(i, 2)[1];
  };
  const runs = Number(opt('--runs', '3'));
  const jobs = Math.min(4, Math.max(1, require('node:os').availableParallelism() - 1), Number(opt('--jobs', '4')));
  if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(jobs) || jobs < 1) throw new Error('runs and jobs must be positive integers');
  const before = opt('--before', null);
  const after = opt('--after', ROOT);
  const jsonOut = opt('--json', null);
  const listed = (root) => require(path.join(root, 'test', 'run.js')).testFiles();
  const trees = [...(before ? [['before', path.resolve(before)]] : []), ['after', path.resolve(after)]];
  const filesOf = new Map(trees.map(([name, root]) => [name, args.length ? args.filter((f) => fs.existsSync(path.join(root, f))) : listed(root)]));
  const seed = createRepoSeed();
  const samples = new Map();
  const log = jsonOut ? `${jsonOut}.samples.jsonl` : null;
  if (log && fs.existsSync(log)) {
    for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      const { key, sample } = JSON.parse(line);
      if (!samples.has(key)) samples.set(key, []);
      samples.get(key).push(sample);
    }
  }
  const done = new Map([...samples].map(([key, list]) => [key, list.length]));
  const queue = [];
  for (let i = 0; i < runs; i++) {
    const longest = Math.max(...[...filesOf.values()].map((f) => f.length));
    for (let j = 0; j < longest; j++) {
      for (const [name, root] of trees) {
        const file = filesOf.get(name)[j];
        const key = `${name} ${file}`;
        if (file && (done.get(key) || 0) > i) continue;
        if (file) queue.push({ name, root, file });
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: jobs }, async () => {
      while (queue.length) {
        const job = queue.shift();
        const key = `${job.name} ${job.file}`;
        if (!samples.has(key)) samples.set(key, []);
        const sample = await measure(job.root, ['--test', '--test-concurrency=1', '--test-timeout=300000', job.file],
          { ...process.env, TC_TEST_REPO_SEED: seed.repo });
        samples.get(key).push(sample);
        if (log) fs.appendFileSync(log, JSON.stringify({ key, sample }) + '\n');
      }
    }));
  } finally {
    cleanupRepoSeed(seed);
  }
  const stat = (name, file) => {
    const s = samples.get(`${name} ${file}`);
    if (!s) return null;
    return { wall: median(s.map((x) => x.wall)), cpu: median(s.map((x) => x.cpu)), failed: s.filter((x) => x.status !== 0).length };
  };
  const files = [...new Set([...filesOf.values()].flat())];
  const rows = files.map((file) => ({ file, ...Object.fromEntries(trees.map(([name]) => [name, stat(name, file)])) }))
    .sort((a, b) => ((b.before || b.after)?.cpu || 0) - ((a.before || a.after)?.cpu || 0));
  const cell = (s) => (s ? `${s.cpu.toFixed(1)} | ${s.wall.toFixed(1)}${s.failed ? ` (failed ${s.failed}/${runs})` : ''}` : '- | -');
  const total = (name) => rows.reduce((acc, r) => ({ cpu: acc.cpu + (r[name]?.cpu || 0), wall: acc.wall + (r[name]?.wall || 0) }), { cpu: 0, wall: 0 });
  const head = trees.map(([name]) => `${name} CPU s | ${name} wall s`).join(' | ');
  console.log(`| file | ${head} |`);
  console.log(`| --- |${trees.map(() => ' ---: | ---: |').join('')}`);
  for (const r of rows) console.log(`| ${r.file} | ${trees.map(([name]) => cell(r[name])).join(' | ')} |`);
  console.log(`| total | ${trees.map(([name]) => cell(total(name))).join(' | ')} |`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ runs, jobs, rows, totals: Object.fromEntries(trees.map(([name]) => [name, total(name)])) }, null, 2) + '\n');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { measure, median };
