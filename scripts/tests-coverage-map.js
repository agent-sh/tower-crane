#!/usr/bin/env node
'use strict';

// Builds tests-coverage-map.json, the source file -> test files map `tower-crane tests map
// refresh` pins as tests.map, from V8 coverage of a real test run (lib/tests-coverage.js).
//
//   node scripts/tests-coverage-map.js run --dir DIR [--out FILE] -- CMD [ARGS...]
//     runs a node:test command in this directory with coverage scoped per test file
//   node scripts/tests-coverage-map.js merge [--expect N] --out FILE MAP...
//     joins the maps of one run's shards, refusing unless there are N of them
//
// test/run.js does the same as `run` when TC_TEST_COVERAGE_DIR is set, which CI uses.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Coverage = require('../lib/tests-coverage');

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
}

function headSha(root) {
  const r = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse HEAD in ${root} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// The environment a test command needs for a scoped coverage run in dir.
function scopeEnv(env, dir, root, preload = true) {
  fs.mkdirSync(path.join(dir, 'runner'), { recursive: true });
  const out = { ...env, [Coverage.SCOPE_ENV]: JSON.stringify({ dir, root }), NODE_V8_COVERAGE: path.join(dir, 'runner') };
  if (preload) out.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${JSON.stringify(require.resolve('../lib/tests-coverage-scope'))}`.trim();
  return out;
}

function write(file, map) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'run') {
    const split = args.indexOf('--');
    const own = split < 0 ? args : args.slice(0, split);
    const cmd = split < 0 ? [] : args.slice(split + 1);
    const given = option(own, '--dir');
    const out = option(own, '--out');
    if (!given || !cmd.length || own.length) throw new Error('usage: tests-coverage-map.js run --dir DIR [--out FILE] -- CMD [ARGS...]');
    const dir = path.resolve(given);
    const root = process.cwd();
    const r = cp.spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: scopeEnv(process.env, dir, root), shell: process.platform === 'win32' });
    const map = Coverage.collect(dir, root, headSha(root));
    const file = out || path.join(dir, 'tests-coverage-map.json');
    write(file, map);
    console.error(`tests-coverage-map: ${Object.keys(map.map).length} files covered by ${map.tests.length} test files at ${map.sha}; wrote ${file}`);
    return r.status ?? 1;
  }
  if (command === 'merge') {
    const out = option(args, '--out');
    const expect = option(args, '--expect');
    if (!out || !args.length) throw new Error('usage: tests-coverage-map.js merge [--expect N] --out FILE MAP...');
    // A shard whose map is missing would leave its files' sources mapped to nothing.
    if (expect != null && args.length !== Number(expect)) throw new Error(`expected ${expect} shard maps, got ${args.length}: ${args.join(' ')}`);
    const map = Coverage.merge(args.map((file) => {
      const part = JSON.parse(fs.readFileSync(file, 'utf8'));
      const error = Coverage.artifactError(part);
      if (error) throw new Error(`${file}: ${error}`);
      return part;
    }));
    write(out, map);
    console.error(`tests-coverage-map: merged ${args.length} maps: ${Object.keys(map.map).length} files, ${map.tests.length} test files at ${map.sha}`);
    return 0;
  }
  throw new Error('usage: tests-coverage-map.js (run --dir DIR [--out FILE] -- CMD... | merge [--expect N] --out FILE MAP...)');
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

module.exports = { scopeEnv, headSha, write };
