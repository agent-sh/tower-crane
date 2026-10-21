'use strict';

// The gate scratch proof's nesting (probe-gate-scratch.js) for the test files
// that start brokers, within a host probe's deadline. CI's complete proof runs
// the whole suite.
const os = require('node:os');
const path = require('node:path');
const { probe } = require('./probe-gate-scratch');

const FILES = ['test/broker.test.js', 'test/sandbox-extensions.test.js', 'test/spawn.test.js'];

const result = probe({
  cache: process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-gate-proof'),
  command: `node test/run.js --test-concurrency=3 ${FILES.join(' ')}`,
});
console.log(JSON.stringify({ ok: result.ok, cleanup_ok: result.cleanup_ok, outer: result.outer, gate: result.gate?.summary }, null, 2));
if (!result.ok) process.exitCode = 1;
