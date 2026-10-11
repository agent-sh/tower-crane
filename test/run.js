'use strict';

// npm test runs the whole suite; `npm test -- FILE... [--test-* flags]` runs
// only the files given. File workers stay below the machine's core count,
// since every file also starts CLI and git processes of its own.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function testFiles() {
  return [
    ...fs.readdirSync(__dirname).filter((file) => file.endsWith('.test.js')).map((file) => `test/${file}`),
    ...fs.readdirSync(path.join(__dirname, 'gates')).filter((file) => file.endsWith('.test.js')).map((file) => `test/gates/${file}`),
  ].sort();
}
if (require.main !== module) {
  module.exports = { testFiles };
  return;
}

const given = process.argv.slice(2);
const flags = [];
const files = [];
let requested = 4;
for (let i = 0; i < given.length; i++) {
  const arg = given[i];
  if (arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')) {
    const value = arg === '--test-concurrency' ? given[++i] : arg.slice('--test-concurrency='.length);
    if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
      console.error('--test-concurrency requires a positive integer');
      process.exit(1);
    }
    requested = Number(value);
  } else if (arg.startsWith('--')) flags.push(arg);
  else files.push(arg);
}
const concurrency = Math.min(4, Math.max(1, os.availableParallelism() - 1), requested);
const args = [
  '--test', `--test-concurrency=${concurrency}`,
  // The clean git seed every test repository copies, built once per run.
  `--test-global-setup=${path.join(__dirname, 'global-setup.js')}`,
  // A hung test fails after five minutes, about three times the slowest test
  // measured on a loaded machine, instead of holding CI to its job timeout.
  '--test-timeout=300000', '--test-force-exit',
  ...flags,
];
const shard = process.env.TC_TEST_SHARD;
if (shard) args.push(`--test-shard=${shard}`);
// A sandboxed run skips tests.host_only files; the tests gate runs them on the host. Only a sandbox
// loads the helper, so an ordinary run needs no lib/ modules.
const selected = files.length ? files : testFiles();
const { run, skipped, refused } = process.env.TOWER_CRANE_SANDBOX === '1'
  ? require('../lib/tests-host-only').split(selected, process.env)
  : { run: selected, skipped: [], refused: [] };
if (refused.length) {
  console.error(`tower-crane: a sandboxed run with tests.host_only names test files, not directories or globs: ${refused.join(' ')}`);
  process.exit(1);
}
if (skipped.length) console.error(`tower-crane: skipped host-only tests in this sandbox, the tests gate runs them on the host: ${skipped.join(' ')}`);
args.push(...run);

const env = { ...process.env };
delete env.TC_TEST_SHARD;
// A runner invoked from a test must launch a new run, not Node's recursive no-op.
delete env.NODE_TEST_CONTEXT;
// With every file skipped there is nothing to run; node --test with no file would search the directory.
const result = run.length ? cp.spawnSync(process.execPath, args, { stdio: 'inherit', env }) : { status: 0 };
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.signal) {
  process.exitCode = 128 + (os.constants.signals[result.signal] || 0);
} else {
  process.exitCode = result.status ?? 1;
}
