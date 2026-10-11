'use strict';

const { childClosed, waitOnRepo } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');

const waitForExit = childClosed;

function waitForImportedTitle(h, title) {
  return waitOnRepo(h, () => h.readState('tasks.json').tasks.some((task) => task.title === title));
}

test('a closed stdout pipe exits quietly after completing the state write', async (t) => {
  const h = makeRepo(t);
  h.init();

  const title = 'x'.repeat(1024 * 1024);
  const child = cp.spawn(process.execPath, [BIN, 'plan', 'import', '-', '--json'], {
    cwd: h.repo,
    env: h.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);
  let stdoutBytes = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.once('data', (chunk) => {
    stdoutBytes += chunk.length;
    child.stdout.destroy();
  });
  child.stdin.end(JSON.stringify([{ title, acceptance: ['ready'] }]));

  const result = await exited;
  assert.ok(stdoutBytes > 0, 'the test closed stdout after receiving its first bytes');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, stderr);
  assert.doesNotMatch(stderr, /write EPIPE|Unhandled 'error' event/);
  assert.equal(h.readState('tasks.json').tasks[0].title, title);
});

test('a closed stderr pipe preserves the command exit code', async (t) => {
  const h = makeRepo(t);
  const child = cp.spawn(process.execPath, [BIN, 'task'], {
    cwd: h.repo,
    env: h.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = waitForExit(child);
  child.once('spawn', () => child.stderr.destroy());

  const result = await exited;
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
});

test('a closed stderr pipe does not truncate large stdout output', async (t) => {
  const h = makeRepo(t);
  h.init();
  const sketch = path.join(h.state, 'sketch.html');
  fs.rmSync(sketch);
  fs.mkdirSync(sketch);

  const title = 'y'.repeat(1024 * 1024);
  const child = cp.spawn(process.execPath, [BIN, 'plan', 'import', '-', '--json'], {
    cwd: h.repo,
    env: h.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);
  child.once('spawn', () => child.stderr.destroy());
  child.stdin.end(JSON.stringify([{ title, acceptance: ['ready'] }]));
  await waitForImportedTitle(h, title);
  await new Promise((resolve) => setTimeout(resolve, 100)); // wait-allow: keep stdout undrained to exercise pipe backpressure after the state write
  const exitedBeforeDrain = child.exitCode !== null;

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  const result = await exited;
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(exitedBeforeDrain, false, 'healthy stdout backpressure keeps the CLI alive until drained');
  assert.ok(stdout.length > title.length, 'large JSON output drained from the healthy stream');
  assert.equal(JSON.parse(stdout).added[0].title, title);
});

test('serve stops when its stdout pipe closes', async (t) => {
  const h = makeRepo(t);
  h.init();
  const child = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
    cwd: h.repo,
    env: h.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('spawn', () => child.stdout.destroy());

  const result = await exited;
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, stderr);
  assert.doesNotMatch(stderr, /write EPIPE|Unhandled 'error' event/);
});
