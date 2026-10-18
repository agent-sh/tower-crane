'use strict';

// test/fixtures/report-guard.js: a test file whose process ends before the
// runner has all its tests fails instead of passing with tests missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempRoot } = require('./tmp-root');

const GUARD = path.join(__dirname, 'fixtures', 'report-guard.js');

// Runs one test file the way test/run.js does, with extra preloads.
function runFile(t, source, preloads = []) {
  fs.mkdirSync(tempRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot(), 'report-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.test.js');
  fs.writeFileSync(file, source);
  for (const [name, text] of preloads) fs.writeFileSync(path.join(dir, name), text);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return cp.spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', `--require=${GUARD}`,
    ...preloads.map(([name]) => `--require=${path.join(dir, name)}`), file], { cwd: dir, env, encoding: 'utf8' });
}

test('a runner too busy to drain the pipe still gets every test of a file that force-exits', (t) => {
  // The runner's event loop stays blocked while the file runs, as on a loaded host; the file's
  // report outgrows the pipe before the runner reads it.
  const stall = 'if (!process.env.NODE_TEST_CONTEXT) setInterval(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500), 10).unref();\n'; // wait-allow: block the runner's event loop so the file's report outgrows the pipe before the runner reads it
  const r = runFile(t, "const test = require('node:test');\nfor (let i = 0; i < 120; i++) test(`test ${i}`, () => {});\n", [['stall.js', stall]]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# tests 120$/m);
});

test('a process.exit() before the last test fails the file', (t) => {
  const r = runFile(t, "const test = require('node:test');\ntest('one', () => {});\ntest('exits', () => { process.exit(0); });\ntest('never runs', () => {});\n");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /exited before all its tests finished/);
});
