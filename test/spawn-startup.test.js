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

// The dispatch's startup window (lib/spawn.js STARTUP_MS).
const STARTUP_MS = 10000;

const commandRung = (h) => pinRung(h, 'small', { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });

// A preload that runs only in the supervisor, before its main module.
function monitorHook(h, name, body) {
  const file = path.join(h.base, `${name}.js`);
  fs.writeFileSync(file, `if (process.argv[1] && process.argv[1].endsWith('spawn-monitor.js')) {\n${body}\n}\n`);
  return { NODE_OPTIONS: `--require "${file.replace(/\\/g, '/')}"` };
}

// The last line of a kept startup-failed log: the phases the start finished.
function keptPhases(file) {
  const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').pop();
  const match = /^tower-crane: startup phases in ms: (\{.*\})$/.exec(last);
  assert.ok(match, `the kept log does not end with its startup phases: ${last}`);
  return JSON.parse(match[1]);
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
  // read-published: the stub appends calls; nothing replaces the file, and the spawn has exited.
  const seen = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  // The supervisor's later git calls act for the parent and still go through its shim.
  assert.match(seen, /^worktree list/m, 'the stub records supervisor calls');
  assert.doesNotMatch(seen, /^config --list/m, seen);
  assert.doesNotMatch(seen, /^rev-parse --path-format=absolute/m, seen);
});

// With every PATH directory a parent agent's shims, dropping them all left an
// empty PATH, and git was then looked up in the current directory: the
// agent's worktree, which the agent writes.
test('a nested spawn whose whole PATH is the parent\'s shims does not run a git from the worktree', { skip: process.platform === 'win32' && 'the parent shim stub is a shell script' }, (t) => {
  const h = setup(t);
  commandRung(h);
  const realGit = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, 'git'))
    .find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
  const parent = path.join(h.base, 'parent-home');
  fs.mkdirSync(path.join(parent, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(parent, '.tower-crane-origin.json'), '{}\n');
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(path.join(parent, 'bin', 'git'), `#!/bin/sh\nexec ${q(realGit)} "$@"\n`, { mode: 0o755 });
  const ran = path.join(h.base, 'worktree-git-ran');
  fs.writeFileSync(path.join(h.repo, 'git'), `#!/bin/sh\necho "$*" >> ${q(ran)}\nexit 1\n`, { mode: 0o755 });
  h.git(['add', 'git']);
  h.git(['commit', '-q', '-m', 'a git in the checkout']);
  const started = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env: { PATH: path.join(parent, 'bin') } });
  // read-published: the planted git appends; nothing replaces the file, and the spawn has exited.
  assert.equal(fs.existsSync(ran), false, fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '');
  // With no host git left, the scan cannot read the config and the start is refused.
  assert.equal(started.code, 1, started.stderr);
  assert.match(started.stderr, /exited with code 1 before it reported ready: cannot read git configuration safely/);
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
  const phases = keptPhases(path.join(h.state, 'logs', kept[0]));
  assert.ok(phases.total >= phases.receipt && phases.receipt >= 0, JSON.stringify(phases));
  assert.ok(phases.supervisor.boot > 0, 'the exit receipt carries the phases the supervisor finished');
  assert.equal(phases.supervisor.launch, undefined);
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

// A rename keeps the mtime, so a log moved aside from an older start was the
// oldest one and went in the same prune whose message named it.
test('a log moved aside is kept by the prune that follows it', (t) => {
  const h = setup(t);
  commandRung(h);
  const dir = path.join(h.state, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'T1-small-T1-1.log');
  fs.writeFileSync(stale, 'an earlier failed start\n');
  fs.utimesSync(stale, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const newer = [];
  for (let i = 0; i < 5; i++) {
    const name = `T1-small-T1-2-startup-failed-2026-02-0${i + 1}T00-00-00-000Z.log`;
    fs.writeFileSync(path.join(dir, name), `failure ${i}\n`);
    const at = new Date(Date.UTC(2026, 1, i + 1));
    fs.utimesSync(path.join(dir, name), at, at);
    newer.push(name);
  }
  const started = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  assert.equal(started.code, 0, started.stderr);
  const aside = started.stderr.match(/left by a start that failed before it was recorded, to (.+)\n/)?.[1];
  assert.ok(aside, started.stderr);
  assert.equal(fs.readFileSync(aside, 'utf8'), 'an earlier failed start\n');
  assert.deepEqual(logs(h).filter((name) => name.includes('-startup-failed-')).sort(), [...newer.slice(1), path.basename(aside)].sort());
});

// The wait for the supervisor's report blocks the event loop, so only the
// process table shows that the supervisor is gone.
test('a supervisor killed before it reports ends the wait early', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'killed', `process.kill(process.pid, 'SIGKILL');`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  // Only the wait's own exit check says "exited"; a wait that ran out says "within 10 s".
  assert.match(failed.stderr, /supervisor startup failed: the supervisor exited before it reported ready/);
});

// A start that runs out of time is the one the phases explain, so its log is
// kept even when the supervisor wrote nothing.
test('a supervisor that stalls silently before it reports says so and keeps a log of the phases it finished', (t) => {
  const h = setup(t);
  commandRung(h);
  const env = monitorHook(h, 'git-stalls', `
const cp = require('node:child_process');
cp.spawnSync = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); // wait-allow: a git call that outlasts the startup window
  throw new Error('unreachable');
};`);
  const failed = h.run(['spawn', '--role', 'small', '--task', 'T1'], { env });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /supervisor startup failed: the supervisor did not report ready within 10 s/);
  assert.doesNotMatch(failed.stderr, /installed and on PATH/);
  assert.match(failed.stderr, /The supervisor log is kept at .*; it ends:\ntower-crane: startup phases in ms: \{/);
  const kept = logs(h);
  assert.equal(kept.length, 1);
  const phases = keptPhases(path.join(h.state, 'logs', kept[0]));
  t.diagnostic(`stalled startup_ms ${JSON.stringify(phases)}`);
  assert.ok(phases.total >= STARTUP_MS && phases.receipt >= STARTUP_MS, JSON.stringify(phases));
  assert.equal(phases.ready, undefined, 'a small agent has no handshake');
  assert.ok(phases.supervisor.boot > 0, 'the supervisor wrote the phases it finished beside the receipt');
  assert.equal(phases.supervisor.setup, undefined, 'it stalled in setup');
});

// Each recorded phase is a whole number of ms within the dispatch's own
// window. A worker without the lease gate, as on Windows, also records its
// handshake. The diagnostic puts each platform's timings in the CI log.
for (const [role, hooks] of [['small', {}], ['worker', { HOOK_NO_SH: '1' }]]) {
  test(`a ${role} spawn records how long each startup phase took`, (t) => {
    const h = setup(t);
    const rung = role === 'small' ? 'small' : h.json(['spawn', '--task', 'T1', '--dry-run']).rung;
    pinRung(h, rung, { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });
    const started = h.run(['spawn', ...(role === 'small' ? ['--role', 'small'] : []), '--task', 'T1', '--wait', '--json'], { hooks });
    assert.equal(started.code, 0, started.stderr);
    const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .find((e) => e.cmd === 'spawn' && e.detail.role === role);
    const phases = event.detail.startup_ms;
    t.diagnostic(`${process.platform} ${role} startup_ms ${JSON.stringify(phases)}`);
    const handshake = role === 'worker';
    const supervisorKeys = handshake ? ['boot', 'setup', 'go_wait', 'launch'] : ['boot', 'setup', 'launch'];
    assert.deepEqual(Object.keys(phases).sort(), [...(handshake ? ['lease', 'ready'] : []), 'receipt', 'supervisor', 'total'].sort());
    assert.deepEqual(Object.keys(phases.supervisor).sort(), supervisorKeys.sort());
    for (const value of [...Object.values(phases).filter((v) => typeof v === 'number'), ...Object.values(phases.supervisor)]) {
      assert.ok(Number.isInteger(value) && value >= 0, JSON.stringify(phases));
    }
    // A successful start ends before its deadlines; a slow host can come
    // close to one, so the bound only rules out nonsense.
    assert.ok(phases.total > 0 && phases.total < 2 * STARTUP_MS * (handshake ? 2 : 1), JSON.stringify(phases));
    assert.ok(phases.supervisor.boot > 0, 'Node takes time to start');
    // Rounding to whole ms lets each sum pass the total by under 1 ms a term.
    const sum = (values) => values.reduce((a, b) => a + b, 0);
    assert.ok(sum([phases.ready || 0, phases.lease || 0, phases.receipt]) <= phases.total + 3, JSON.stringify(phases));
    assert.ok(sum(Object.values(phases.supervisor)) <= phases.total + 4, 'the supervisor runs inside the dispatch window');
  });
}

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
  const live = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']); // wait-allow: a child that outlives the test, killed after it
  t.after(() => live.kill('SIGKILL'));
  // Synchronous, as in the dispatch: the event loop cannot reap the child meanwhile.
  const until = Date.now() + 10000; // wait-allow: a bound on the child's exit, which takes about 50 ms
  while (!P.psZombie(done.pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: a bounded poll for the child's exit
  assert.equal(P.psZombie(done.pid), true);
  assert.equal(P.childExited(done.pid, 'darwin'), true);
  assert.equal(P.psZombie(live.pid), false);
  assert.equal(P.childExited(live.pid, 'darwin'), false);
});

test('only systems without a process table of their own ask ps, and a failed ps proves nothing', (t) => {
  const live = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']); // wait-allow: a child that outlives the test, killed after it
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
