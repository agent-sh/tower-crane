'use strict';

// What a dispatch reports when its supervisor does not start, and what keeps a
// supervisor's own start from waiting on the agent's git shims.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, pinRung } = require('./helpers');

function setup(t) {
  return cachedFixture(t, 'task', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Idempotency key on retries', '--acceptance', 'processed once']);
    h.ok(['brief', 'set', 'T1', '-'], { input: '- start from the webhook handler\n' });
  });
}

const commandRung = (h) => pinRung(h, 'small', { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });

// A preload that runs only in the supervisor, before its main module.
function monitorHook(h, name, body) {
  const file = path.join(h.base, `${name}.js`);
  fs.writeFileSync(file, `if (process.argv[1] && process.argv[1].endsWith('spawn-monitor.js')) {\n${body}\n}\n`);
  return { NODE_OPTIONS: `--require "${file.replace(/\\/g, '/')}"` };
}

const logs = (h) => (fs.existsSync(path.join(h.state, 'logs')) ? fs.readdirSync(path.join(h.state, 'logs')) : []);

// The supervisor reads git config for the harness before it reports. That
// read used to run the agent's git shim, which first waits up to 5 s for the
// placeholder cleanup directory, three times over: a directory a killed shim
// left behind made every start miss the dispatch's 10 s window.
test('a held placeholder cleanup directory does not keep the supervisor from starting', (t) => {
  const h = setup(t);
  commandRung(h);
  fs.mkdirSync(path.join(h.repo, '.git', 'tower-crane-reap'));
  const started = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).agent, 'small-T1-1');
});

test('a supervisor that exits before it reports names its exit code and keeps its log', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'git-fails', `
const cp = require('node:child_process');
cp.spawnSync = () => {
  process.stderr.write('planted: git is broken on this host\\n');
  throw new Error('planted git failure');
};`);
  // The first rename of the log is refused, as Windows does while the
  // supervisor's handle or a scanner's lingers; the failure is still reported.
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env, hooks: { HOOK_BUSY_RENAME: '-startup-failed-' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /supervisor startup failed: the supervisor exited with code 1 before it reported ready: planted git failure/);
  assert.doesNotMatch(failed.stderr, /installed and on PATH/);
  const kept = logs(h);
  assert.equal(kept.length, 1, kept.join(', '));
  assert.match(kept[0], /^T1-small-T1-1-startup-failed-.+\.log$/);
  assert.match(fs.readFileSync(path.join(h.state, 'logs', kept[0]), 'utf8'), /planted: git is broken on this host/);
  assert.ok(failed.stderr.includes(`The supervisor log is kept at ${path.join(h.state, 'logs', kept[0])}`), failed.stderr);
  assert.match(failed.stderr, /it ends:\n(.*\n)*planted: git is broken on this host/);
  // The kept log frees the agent's own log name for the next spawn.
  const next = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).agent, 'small-T1-1');
});

test('a failed start whose log rename stays refused reports the failure and keeps the log under its own name, which the next spawn moves aside', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'git-fails-held-log', `
const cp = require('node:child_process');
cp.spawnSync = () => {
  process.stderr.write('planted: git is broken on this host\\n');
  throw new Error('planted git failure');
};`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env, hooks: { HOOK_BUSY_RENAME: '-startup-failed-', HOOK_BUSY_RENAME_TIMES: '0' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /supervisor startup failed: the supervisor exited with code 1 before it reported ready: planted git failure/);
  assert.doesNotMatch(failed.stderr, /EPERM/);
  assert.deepEqual(logs(h), ['T1-small-T1-1.log']);
  assert.ok(failed.stderr.includes(`The supervisor log is kept at ${path.join(h.state, 'logs', 'T1-small-T1-1.log')}`), failed.stderr);
  assert.match(failed.stderr, /it ends:\n(.*\n)*planted: git is broken on this host/);
  // A failed start records no spawn, so the next one is the same agent with the same log name.
  const next = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).agent, 'small-T1-1');
  assert.match(next.stderr, /tower-crane: moved .*T1-small-T1-1\.log, left by a start that failed before it was recorded, to .*T1-small-T1-1-startup-failed-.+\.log\n/);
  const kept = logs(h).sort();
  assert.equal(kept.length, 2, kept.join(', '));
  assert.match(kept[0], /^T1-small-T1-1-startup-failed-.+\.log$/);
  assert.equal(kept[1], 'T1-small-T1-1.log');
  assert.match(fs.readFileSync(path.join(h.state, 'logs', kept[0]), 'utf8'), /planted: git is broken on this host/);
});

test('a supervisor that stalls before it reports says so and keeps its log', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'git-stalls', `
const cp = require('node:child_process');
cp.spawnSync = () => {
  process.stderr.write('planted: waiting on git\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); // wait-allow: a git call that outlasts the startup window
  throw new Error('unreachable');
};`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /supervisor startup failed: the supervisor did not report ready within 10 s/);
  assert.doesNotMatch(failed.stderr, /installed and on PATH/);
  assert.match(failed.stderr, /The supervisor log is kept at .*; it ends:\nplanted: waiting on git/);
  assert.equal(logs(h).length, 1);
});

test('a harness the supervisor cannot find is reported as a PATH problem, with nothing kept', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'harness-missing', `
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function (file, args, opts) {
  return spawn.call(this, ${JSON.stringify(path.join(h.base, 'missing-harness'))}, args, opts);
};`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /could not start .*: spawn .*missing-harness ENOENT; check that it is installed and on PATH/);
  assert.doesNotMatch(failed.stderr, /supervisor startup failed|log is kept/);
  assert.deepEqual(logs(h), []);
});
