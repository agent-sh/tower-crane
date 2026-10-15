'use strict';

// What a dispatch reports when its supervisor does not start, and what keeps a
// supervisor's own start from waiting on the agent's git shims.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, pinRung } = require('./helpers');
const P = require('../lib/processes');

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

// A spawn inside another agent inherits that agent's PATH, which starts with
// its git shim. The supervisor's config scan skipped only its own agent's
// shims, so it still ran the parent's, with the same placeholder wait.
test('a nested spawn\'s supervisor scans git config without the parent agent\'s shim', { skip: process.platform === 'win32' && 'the parent shim stub is a shell script' }, (t) => {
  const h = setup(t);
  commandRung(h);
  const realGit = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, 'git'))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  assert.ok(realGit, 'git on PATH');
  // A parent agent's shim directory: bin/ beside the origin mark of its home.
  const parent = path.join(h.base, 'parent-home');
  fs.mkdirSync(path.join(parent, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(parent, '.tower-crane-origin.json'), '{}\n');
  const calls = path.join(h.base, 'parent-shim-calls');
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(path.join(parent, 'bin', 'git'), `#!/bin/sh\nif [ -n "$TOWERCRANE_SUPERVISOR" ]; then printf '%s\\n' "$*" >> ${q(calls)}; fi\nexec ${q(realGit)} "$@"\n`, { mode: 0o755 });
  const started = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], {
    env: { PATH: path.join(parent, 'bin') + path.delimiter + process.env.PATH },
  });
  assert.equal(started.code, 0, started.stderr);
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(seen, /^config --list --show-scope -z$/m, seen);
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

// Each failed start keeps a log; a task whose start keeps failing must not
// fill logs/ with them.
test('a failed start keeps the task\'s newest startup-failed logs and removes older ones', (t) => {
  const h = setup(t);
  commandRung(h);
  const dir = path.join(h.state, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const old = [];
  for (let i = 0; i < 6; i++) {
    const name = `T1-small-T1-1-startup-failed-2026-01-0${i + 1}T00-00-00-000Z.log`;
    fs.writeFileSync(path.join(dir, name), `old failure ${i}\n`);
    const at = new Date(Date.UTC(2026, 0, i + 1));
    fs.utimesSync(path.join(dir, name), at, at);
    old.push(name);
  }
  const other = 'T2-small-T2-1-startup-failed-2026-01-01T00-00-00-000Z.log';
  fs.writeFileSync(path.join(dir, other), 'another task\n');
  fs.utimesSync(path.join(dir, other), new Date(0), new Date(0));
  const env = monitorHook(h, 'git-fails-prune', `
const cp = require('node:child_process');
cp.spawnSync = () => {
  process.stderr.write('planted: git is broken on this host\\n');
  throw new Error('planted git failure');
};`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  const after = logs(h).sort();
  const fresh = after.filter((name) => name.startsWith('T1-') && !old.includes(name));
  assert.equal(fresh.length, 1, after.join(', '));
  assert.deepEqual(after, [...old.slice(2), fresh[0], other].sort());
});

// The wait for the supervisor's report blocks the event loop, so only the
// process table shows that the supervisor is gone.
test('a supervisor killed before it reports ends the wait early', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'killed', `process.kill(process.pid, 'SIGKILL');`);
  const at = Date.now();
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /supervisor startup failed: the supervisor exited before it reported ready/);
  assert.ok(Date.now() - at < 8000, `took ${Date.now() - at} ms`);
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

// macOS has no /proc, and an exited child that the blocked event loop has not
// reaped still takes signals there, so the dispatch asks ps for its state.
// This runs the same ps query on a real unreaped child here.
test('ps shows an unreaped child as exited and a running one as not', { skip: process.platform === 'win32' && 'Windows has no ps; the signal check sees the exit' }, (t) => {
  const done = cp.spawn(process.execPath, ['-e', '']);
  const live = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => live.kill('SIGKILL'));
  // Synchronous, as in the dispatch: the event loop cannot reap the child meanwhile.
  const until = Date.now() + 10000;
  while (!P.psZombie(done.pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: a bounded poll for the child's exit
  assert.equal(P.psZombie(done.pid), true);
  assert.equal(P.childExited(done.pid, 'darwin'), true);
  assert.equal(P.psZombie(live.pid), false);
  assert.equal(P.childExited(live.pid, 'darwin'), false);
});

test('only systems without a process table of their own ask ps, and a failed ps proves nothing', (t) => {
  const live = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => live.kill('SIGKILL'));
  const asked = [];
  const ps = (out) => (cmd, args) => { asked.push([cmd, ...args].join(' ')); return out; };
  assert.equal(P.childExited(live.pid, 'darwin', ps({ status: 0, stdout: 'Z+\n' })), true);
  assert.deepEqual(asked, [`ps -o stat= -p ${live.pid}`]);
  assert.equal(P.childExited(live.pid, 'freebsd', ps({ status: 0, stdout: 'S\n' })), false);
  assert.equal(P.childExited(live.pid, 'darwin', ps({ error: new Error('spawnSync ps ETIMEDOUT') })), false);
  assert.equal(P.childExited(live.pid, 'darwin', ps({ status: 1, stdout: '' })), false);
  asked.length = 0;
  assert.equal(P.childExited(live.pid, 'linux', ps({ status: 0, stdout: 'Z\n' })), false);
  assert.equal(P.childExited(live.pid, 'win32', ps({ status: 0, stdout: 'Z\n' })), false);
  assert.deepEqual(asked, []);
});
