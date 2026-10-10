#!/usr/bin/env node
'use strict';

// Maps what each test file covers with node:test's own coverage, which also
// reaches the CLI processes a test starts: the lib lines it runs, and how many
// of them no other file runs. A file with no unique lines re-checks code the
// rest of the suite already runs, so it is a candidate to merge or delete.
//
//   node scripts/test-coverage.js [--jobs 4] [--json out.json] [files...]

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepoSeed, cleanupRepoSeed } = require('../test/repo-seed');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const jobs = Number(opt('--jobs', '4'));
const jsonOut = opt('--json', null);
const files = args.length ? args : require('../test/run.js').testFiles();

function lcov(file, out, seed) {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [
      '--test', '--test-concurrency=1', '--experimental-test-coverage', '--test-coverage-include=lib/**',
      '--test-coverage-include=bin/**', '--test-reporter=lcov', `--test-reporter-destination=${out}`, file,
    ], { cwd: ROOT, env: { ...process.env, TC_TEST_REPO_SEED: seed.repo }, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
  });
}

// lcov records: SF:<file>, DA:<line>,<hits>, end_of_record.
function hits(text) {
  const lines = new Set();
  let source = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) source = path.relative(ROOT, line.slice(3));
    else if (line.startsWith('DA:') && source) {
      const [n, count] = line.slice(3).split(',').map(Number);
      if (count > 0) lines.add(`${source}:${n}`);
    }
  }
  return lines;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || os.tmpdir(), 'tower-crane-coverage-'));
  const seed = createRepoSeed();
  const covered = new Map();
  const queue = [...files];
  try {
    await Promise.all(Array.from({ length: jobs }, async () => {
      while (queue.length) {
        const file = queue.shift();
        const out = path.join(scratch, `${file.replace(/[\\/]/g, '_')}.lcov`);
        await lcov(file, out, seed);
        covered.set(file, fs.existsSync(out) ? hits(fs.readFileSync(out, 'utf8')) : new Set());
      }
    }));
  } finally {
    cleanupRepoSeed(seed);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const count = new Map();
  for (const set of covered.values()) for (const key of set) count.set(key, (count.get(key) || 0) + 1);
  const rows = files.map((file) => {
    const set = covered.get(file);
    const unique = [...set].filter((key) => count.get(key) === 1);
    const modules = new Map();
    for (const key of unique) {
      const mod = key.slice(0, key.lastIndexOf(':'));
      modules.set(mod, (modules.get(mod) || 0) + 1);
    }
    const top = [...modules].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m} ${n}`).join(', ');
    return { file, lines: set.size, unique: unique.length, top };
  }).sort((a, b) => a.unique - b.unique);
  console.log('| file | lib lines run | lines no other file runs | where the unique lines are |');
  console.log('| --- | ---: | ---: | --- |');
  for (const r of rows) console.log(`| ${r.file} | ${r.lines} | ${r.unique} | ${r.top || '-'} |`);
  console.log(`\n${count.size} lib lines run by the suite`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2) + '\n');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
