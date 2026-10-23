'use strict';

const { fileWritten, childExit } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const { makeRepo, ROOT, HOOKS } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');
const { clearPlaceholders, REAP_DIR, REAP_WAIT_MS } = require('../lib/git-placeholders');
const { windowsFileIds, BASE } = require('./fixtures/windows-file-ids');

function orphan(h, name = 'orphan') {
  const dir = path.join(h.repo, '.git', 'worktrees', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['commondir', 'config.worktree']) {
    fs.writeFileSync(path.join(dir, file), '', { mode: 0o444 });
  }
  return dir;
}

// A process table listing only the given processes, for a test that removes a
// placeholder: a process elsewhere on the host with unreadable descriptors would
// otherwise keep the placeholder the test plants.
function procTable(h, pids = []) {
  const dir = fs.mkdtempSync(path.join(h.base, 'proc-'));
  for (const pid of pids) fs.symlinkSync(`/proc/${pid}`, path.join(dir, String(pid)));
  return dir;
}

// Points the holder check at a process table for the rest of the test.
function onlyProcesses(t, h, pids = []) {
  const previous = process.env.TOWER_CRANE_PROC;
  const table = procTable(h, pids);
  process.env.TOWER_CRANE_PROC = table;
  t.after(() => {
    if (previous === undefined) delete process.env.TOWER_CRANE_PROC;
    else process.env.TOWER_CRANE_PROC = previous;
  });
  return table;
}

function gateTask(h, script) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  h.init(['--tests-cmd', command, '--tests-mode', 'run-only']);
  h.ok(['task', 'add', '--title', 'Gate', '--acceptance', 'temporary checkout stays consistent']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
}

test('preparation prunes empty sandbox admin placeholders without removing a locked initialization', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Prepared', '--acceptance', 'valid registration']);
  const broken = orphan(h);
  const locked = orphan(h, 'initializing');
  fs.writeFileSync(path.join(locked, 'locked'), 'initializing');
  const wt = h.json(['worktree', 'T1']);
  assert.equal(fs.existsSync(broken), false);
  assert.ok(fs.existsSync(path.join(locked, 'locked')));
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), h.git(['rev-parse', 'main']));
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 2);
});

test('preparation retries a disappearing gate commondir once and reports persistent failure', async (t) => {
  for (const persistent of [false, true]) {
    await t.test(persistent ? 'persistent error is reported' : 'transient removal is retried', (t) => {
      const h = makeRepo(t);
      h.init();
      h.ok(['task', 'add', '--title', 'Prepared', '--acceptance', 'valid registration']);
      const attempts = path.join(h.base, 'add-attempts');
      const preload = path.join(h.base, 'retiring-gate.js');
      fs.writeFileSync(preload, `
const fs = require('node:fs'), cp = require('node:child_process');
const run = cp.execFileSync;
cp.execFileSync = function retiringGate(command, args, options) {
  if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
    // read-published: attempts are appended; nothing replaces the file.
    const previous = fs.existsSync(${JSON.stringify(attempts)}) ? fs.readFileSync(${JSON.stringify(attempts)}, 'utf8') : '';
    fs.appendFileSync(${JSON.stringify(attempts)}, '.');
    if (${persistent} || !previous) {
      const error = new Error('retiring worktree metadata');
      error.stderr = 'fatal: failed to read .git/worktrees/wt/commondir: Success\\n';
      throw error;
    }
  }
  return run.call(this, command, args, options);
};
`);
      const result = h.run(['worktree', 'T1', '--json'], {
        env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
      });
      assert.equal(fs.readFileSync(attempts, 'utf8'), '..', 'the add is retried exactly once');
      if (persistent) {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /failed to read .*commondir/);
        assert.equal(h.readState('tasks.json').tasks[0].branch, null);
        assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
      } else {
        assert.equal(result.code, 0, result.stderr);
        const wt = JSON.parse(result.stdout);
        assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), h.git(['rev-parse', 'main']));
        assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 2);
      }
    });
  }
});

for (const code of [0, 1]) {
  test(`gate cleanup prunes sandbox admin placeholders after a command exits ${code}`, (t) => {
    const h = makeRepo(t);
    const script = path.join(h.base, 'gate.js');
    const broken = path.join(h.repo, '.git', 'worktrees', 'orphan');
    fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(broken)};
fs.mkdirSync(dir, { recursive: true });
for (const file of ['commondir', 'config.worktree']) fs.writeFileSync(path.join(dir, file), '', { mode: 0o444 });
process.exit(${code});
`);
    gateTask(h, script);
    assert.equal(h.run(['check', 'tests', 'T1']).code, code);
    assert.equal(fs.existsSync(broken), false);
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  });
}

const waitFor = (file) => fileWritten(file);

test('two preparations overlap a gate removal without pruning their initializing registrations', { timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  const script = path.join(h.base, 'gate.js');
  const ready = path.join(h.base, 'gate-ready');
  const release = path.join(h.base, 'gate-release');
  const addRelease = path.join(h.base, 'add-release');
  const hook = path.join(h.base, 'hook.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, '');
const deadline = performance.now() + 300000;
const parent = process.ppid;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (performance.now() > deadline || process.ppid !== parent) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
  gateTask(h, script);
  h.ok(['task', 'add', '--title', 'First', '--acceptance', 'valid registration']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'valid registration']);
  fs.writeFileSync(hook, `
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.cwd());
if (name === 'wt') process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(h.base)}, name + '-ready'), '');
const deadline = performance.now() + 300000;
const parent = process.ppid;
while (!fs.existsSync(${JSON.stringify(addRelease)})) {
  if (performance.now() > deadline || process.ppid !== parent) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
  // CLI checkouts run hooks only from trusted config, including this synchronization hook.
  const hooks = path.join(h.base, 'hooks');
  fs.mkdirSync(hooks);
  h.git(['config', '--global', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'post-checkout'),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hook)}\n`, { mode: 0o755 });
  const gate = h.runAsync(['check', 'tests', 'T1']);
  const additions = [];
  try {
    await waitFor(ready);
    additions.push(h.runAsync(['worktree', 'T2', '--json']), h.runAsync(['worktree', 'T3', '--json']));
    await Promise.all(['T2-first-ready', 'T3-second-ready'].map((name) => waitFor(path.join(h.base, name))));
    const broken = orphan(h);
    fs.writeFileSync(release, '');
    const removed = await gate;
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(fs.existsSync(broken), false);
    fs.writeFileSync(addRelease, '');
    for (const result of await Promise.all(additions)) {
      assert.equal(result.code, 0, result.stderr);
      const wt = JSON.parse(result.stdout);
      assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), h.git(['rev-parse', 'main']));
    }
    const listing = h.git(['worktree', 'list', '--porcelain']);
    assert.equal(listing.match(/^worktree /gm).length, 3);
    assert.doesNotMatch(listing, /locked|prunable/);
    for (const name of fs.readdirSync(path.join(h.repo, '.git', 'worktrees'))) {
      const admin = path.join(h.repo, '.git', 'worktrees', name);
      assert.ok(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim());
      assert.ok(fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim());
      // A task worktree's admin directory moved out of worktrees/; commondir is relative to where it is now.
      // On Windows it stays where git put it, and git writes the relative path with forward slashes.
      const real = fs.realpathSync.native(admin);
      const named = fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim();
      assert.equal(path.isAbsolute(named), false, named);
      assert.equal(fs.realpathSync.native(path.resolve(real, named)), fs.realpathSync.native(path.join(h.repo, '.git')));
    }
  } finally {
    fs.writeFileSync(release, '');
    fs.writeFileSync(addRelease, '');
    await Promise.all([gate, ...additions]);
  }
});

test('a sandboxed git push clears an empty read-only lock placeholder that would block its upstream config', (t) => {
  const h = makeRepo(t);
  h.init();
  h.git(['checkout', '-q', '-b', 'task-T1']);
  const remote = path.join(h.base, 'origin.git');
  h.git(['init', '-q', '--bare', remote]);
  // What a sandbox mask leaves behind in the main checkout's git directory.
  const lock = path.join(h.repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const env = { ...h.env, TOWER_CRANE_PROC: procTable(h) };
  const push = cp.spawnSync(process.execPath, [path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'push', '-u', remote, 'HEAD:refs/heads/task-T1'],
    { cwd: h.repo, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(push.status, 0, push.stderr);
  // Git reports a blocked upstream write without a failing status.
  assert.doesNotMatch(push.stderr, /could not lock config/);
  assert.match(push.stderr, /removed empty read-only placeholder .*config\.lock/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(h.git(['config', '--get', 'branch.task-T1.remote']), remote);
});

test('a placeholder is removed while a process holds another file whose id rounds to the same Number, as on Windows', { skip: !fs.existsSync('/proc/self') && 'needs /proc to take the directory' }, (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const other = path.join(h.base, 'other-file');
  fs.writeFileSync(other, '');
  // One process, holding the other file open.
  const table = onlyProcesses(t, h);
  fs.mkdirSync(path.join(table, '4194304', 'fd'), { recursive: true });
  fs.symlinkSync(other, path.join(table, '4194304', 'fd', '3'));
  // The lock gets 2^63 and the other file the next id: a Number rounds both to
  // 2^63, a bigint keeps them apart. Every other file sits far from both.
  const lockIno = fs.lstatSync(lock, { bigint: true }).ino;
  const otherIno = fs.lstatSync(other, { bigint: true }).ino;
  t.after(windowsFileIds((ino) => {
    if (ino === lockIno) return BASE;
    if (ino === otherIno) return BASE + 1n;
    return BASE + 2n ** 32n + ino;
  }));
  const ids = [lock, other].map((file) => fs.lstatSync(file, { bigint: true }).ino);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(Number(ids[0]), Number(ids[1]));
  assert.deepEqual(clearPlaceholders(path.join(h.repo, '.git')), [lock]);
  assert.equal(fs.existsSync(lock), false);
});

test('a sandboxed git call outside any repository runs without a placeholder cleanup', (t) => {
  const h = makeRepo(t);
  const outside = path.join(h.base, 'outside');
  fs.mkdirSync(outside);
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const env = { ...h.env, TOWER_CRANE_PROC: procTable(h) };
  const init = cp.spawnSync(process.execPath, [path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'init', '-q', 'fresh'],
    { cwd: outside, env, encoding: 'utf8', timeout: 300000 });
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(outside, 'fresh', '.git')));
});

test('a lock that a process holds is kept when the git directory is reached through a symlink', { skip: !fs.existsSync('/proc/self/fd') && 'needs /proc to see which process holds the lock' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const link = path.join(h.base, 'git-link');
  fs.symlinkSync(path.join(h.repo, '.git'), link);
  const holder = cp.spawn(process.execPath, ['-e', `require('node:fs').openSync(${JSON.stringify(lock)}, 'r'); console.log('open'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    assert.deepEqual(clearPlaceholders(link), []);
  } finally {
    holder.kill();
  }
  assert.equal(fs.existsSync(lock), true);
});

// The pid namespace a cleanup records in its marker, null without /proc.
function pidns() {
  try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}

// What a command sandbox sets in the commands it confines: Tower Crane for its
// sandboxed agents, claude and codex for their own sandboxes.
const SANDBOX_MARKS = ['TOWER_CRANE_SANDBOX', 'SANDBOX_RUNTIME', 'CODEX_SANDBOX'];
const unmarked = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SANDBOX_MARKS.includes(k)));

// Sets the sandbox marks of this process for the rest of the test, the ones
// not given unset, and returns a function that sets them again.
function sandboxMarks(t, marks) {
  const saved = Object.fromEntries(SANDBOX_MARKS.map((k) => [k, process.env[k]]));
  const set = (values) => {
    for (const k of SANDBOX_MARKS) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
  };
  set(marks);
  t.after(() => set(saved));
  return set;
}

const BOOT_ID = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
const OWN_START = (() => {
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  } catch { return null; }
})();
// No pid namespace counts this high: Linux caps pids at 2^22.
const NO_PID = 99999999;

// Puts a held directory in place with one marker, as a cleanup leaves it.
function plantMarker(commonDir, holder, nonce = '0123456789abcdef') {
  const dir = path.join(commonDir, REAP_DIR);
  fs.mkdirSync(dir);
  const file = path.join(dir, nonce);
  fs.writeFileSync(file, typeof holder === 'string' ? holder : JSON.stringify({ host: os.hostname(), boot_id: BOOT_ID, ...holder }));
  return file;
}

// A cleanup in a process of its own, which takes the directory without waiting.
function judge(h, commonDir, env) {
  return cp.spawnSync(process.execPath, ['--require', HOOKS, '-e',
    `require(${JSON.stringify(path.join(ROOT, 'lib', 'git-placeholders.js'))}).clearPlaceholders(${JSON.stringify(commonDir)}, { waitMs: 0 })`],
  { env: { ...unmarked(h.env), ...env }, encoding: 'utf8' });
}

// A git call through the agent shim, which cleans up placeholders first, with
// the test hooks preloaded; it runs in a repository with no placeholder of its own.
function shimGit(h, hooks, args = ['status', '--short']) {
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  return [process.execPath, ['--require', HOOKS, path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', ...args],
    { cwd: h.repo, env: { ...h.env, TOWER_CRANE_PROC: procTable(h), HOOK_STATE: h.state, ...hooks } }];
}

// A holder paused past any age limit still holds the directory. Taking it over
// would let the paused cleanup rename a live lock that this one then moved away.
test('a cleanup keeps placeholders while a live cleanup holds the git directory, whatever its age', { timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const signal = path.join(h.base, 'reap-taken');
  const holder = cp.spawn(...shimGit(h, { HOOK_REAP_TAKEN: signal }));
  t.after(() => holder.kill('SIGKILL'));
  await fileWritten(signal);
  const lock = path.join(commonDir, 'index.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const dir = path.join(commonDir, REAP_DIR);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  onlyProcesses(t, h);
  assert.deepEqual(clearPlaceholders(commonDir), []);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(dir), true);
  assert.match(messages.join(''), /another cleanup holds/);
  assert.ok(messages.join('').includes(`remove ${dir} if no cleanup is running`));
  // From another pid namespace the holder's pid means nothing, but its
  // namespace still has live processes.
  if (process.platform === 'linux') {
    const other = cp.spawnSync(process.execPath, ['--require', HOOKS, '-e',
      `require(${JSON.stringify(path.join(ROOT, 'lib', 'git-placeholders.js'))}).clearPlaceholders(${JSON.stringify(commonDir)})`],
    { env: { ...unmarked(h.env), HOOK_PIDNS: 'pid:[4026511111]', TOWER_CRANE_SANDBOX: '0' }, encoding: 'utf8' });
    assert.match(other.stderr, /another cleanup holds/);
    assert.equal(fs.existsSync(lock), true);
  }
  fs.writeFileSync(`${signal}.go`, '');
  assert.deepEqual(await childExit(holder), { code: 0, signal: null });
});

// A stopped agent's process group is killed, and with it a git shim that holds
// the directory. Left behind, it made every later cleanup, so every git call
// through a shim, wait 5 s; a supervisor runs three before it reports its start.
test('a cleanup killed while it holds the git directory leaves nothing that keeps the next one waiting', { timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const killed = cp.spawnSync(...shimGit(h, { HOOK_DIE_REAP: '1' }));
  assert.notEqual(killed.status, 0);
  assert.equal(fs.existsSync(path.join(commonDir, REAP_DIR)), true, 'the killed cleanup held the directory');
  const lock = path.join(commonDir, 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  onlyProcesses(t, h);
  assert.deepEqual(clearPlaceholders(commonDir), [lock]);
  assert.doesNotMatch(messages.join(''), /another cleanup holds/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(path.join(commonDir, REAP_DIR)), false);
  // A taker killed before its rename leaves its prepared directory; a later
  // cleanup removes it once its marker names a process that is gone, in this
  // pid namespace or in a sandbox's that has no process left, and keeps a live
  // taker's.
  const holder = (pid, ns) => JSON.stringify({ pid, host: os.hostname(), pidns: ns, start_ticks: null });
  const staging = (pid, nonce, ns = pidns()) => {
    const dir = path.join(commonDir, `${REAP_DIR}.${pid}.${nonce}.new`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, nonce), holder(pid, ns));
    return dir;
  };
  const dead = staging(killed.pid, '0123456789abcdef');
  const sandboxed = staging(2, '00112233445566ff', 'pid:[4026599999]');
  const live = staging(process.pid, 'fedcba9876543210');
  sandboxMarks(t, { TOWER_CRANE_SANDBOX: '0' });
  clearPlaceholders(commonDir);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(sandboxed), process.platform !== 'linux');
  assert.equal(fs.existsSync(live), true);
});

// A sandboxed agent's shim runs in a pid namespace of its own, so its pid means
// nothing outside. Once no process is left in that namespace, a cleanup on the
// host removes its marker; a cleanup inside a sandbox cannot see the host's
// processes and keeps it.
test('a cleanup killed inside a command sandbox is judged by its pid namespace', { timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  cp.spawnSync(...shimGit(h, { HOOK_DIE_REAP: '1', HOOK_PIDNS: 'pid:[4026599999]' }));
  const dir = path.join(commonDir, REAP_DIR);
  const [marker] = fs.readdirSync(dir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, marker), 'utf8')).pidns, 'pid:[4026599999]');
  const lock = path.join(commonDir, 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  onlyProcesses(t, h);
  const mark = sandboxMarks(t, { TOWER_CRANE_SANDBOX: '1' });
  if (process.platform === 'linux') {
    assert.deepEqual(clearPlaceholders(commonDir), []);
    assert.match(messages.join(''), /another cleanup holds/);
  }
  mark({ TOWER_CRANE_SANDBOX: '0' });
  assert.deepEqual(clearPlaceholders(commonDir), process.platform === 'linux' ? [lock] : []);
  assert.equal(fs.existsSync(dir), process.platform !== 'linux');
});

// Pid namespace inodes are reused, and a namespace lives on after a shim killed
// alone while its sandboxed command runs. Either kept a dead holder's marker
// for as long as the namespace had a process, and every cleanup waited 5 s.
// The test's own pid namespace stands for such a namespace, seen by a cleanup
// that reports another one; it has live processes, none of them the holder.
test('a marker from another pid namespace is judged by its holder, not by what else runs there', { skip: process.platform !== 'linux' && 'pid namespaces are Linux only', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const dir = path.join(commonDir, REAP_DIR);
  const outside = { HOOK_PIDNS: 'pid:[4026511111]', TOWER_CRANE_SANDBOX: '0' };
  // A pid no process has, and this process's pid with another start time.
  for (const [pid, start_ticks] of [[NO_PID, OWN_START], [process.pid, `${OWN_START}0`]]) {
    plantMarker(commonDir, { pid, pidns: pidns(), start_ticks });
    const r = judge(h, commonDir, outside);
    assert.doesNotMatch(r.stderr, /another cleanup holds/, `pid ${pid}`);
    assert.equal(fs.existsSync(dir), false, `pid ${pid}`);
  }
  // The holder itself keeps the directory.
  const live = plantMarker(commonDir, { pid: process.pid, pidns: pidns(), start_ticks: OWN_START });
  const r = judge(h, commonDir, outside);
  assert.match(r.stderr, /another cleanup holds/);
  assert.equal(fs.existsSync(live), true);
});

// A process whose pid namespace link cannot be read, such as a root
// container's, can have the innermost pid of a dead holder's marker. Only the
// exact start keeps the marker for it when the marker has no offset to place
// one by: one from 0.1.0, or from a holder that could not read its offset.
test('a marker without an offset is not kept by an unreadable process with its pid', { skip: (process.platform !== 'linux' || process.geteuid() === 0) && 'needs a namespace link this user cannot read', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const dir = path.join(commonDir, REAP_DIR);
  const table = fs.mkdtempSync(path.join(h.base, 'proc-'));
  const other = path.join(table, '5555');
  fs.mkdirSync(path.join(other, 'ns'), { recursive: true });
  fs.writeFileSync(path.join(other, 'status'), 'Name:\tcontainer\nState:\tS (sleeping)\nNSpid:\t5555\t924\n');
  fs.writeFileSync(path.join(other, 'stat'), `5555 (container) ${['S', ...Array(18).fill('0'), '777'].join(' ')} 0 0\n`);
  fs.chmodSync(path.join(other, 'ns'), 0);
  // Readable again before the repository's own cleanup removes the table.
  try {
    const env = { HOOK_PIDNS: 'pid:[4026511111]', TOWER_CRANE_SANDBOX: '0', TOWER_CRANE_PROC: table };
    for (const offset of [{}, { boottime_offset_ns: null }, { boottime_offset_ns: '0' }]) {
      plantMarker(commonDir, { pid: 924, pidns: 'pid:[4026599999]', start_ticks: '1', ...offset });
      const r = judge(h, commonDir, env);
      assert.doesNotMatch(r.stderr, /another cleanup holds/, JSON.stringify(offset));
      assert.equal(fs.existsSync(dir), false, JSON.stringify(offset));
    }
    // The exact start still keeps it.
    plantMarker(commonDir, { pid: 924, pidns: 'pid:[4026599999]', start_ticks: '777' });
    assert.match(judge(h, commonDir, env).stderr, /another cleanup holds/);
  } finally {
    fs.chmodSync(path.join(other, 'ns'), 0o755);
  }
});

const UNSHARE = process.platform === 'linux' && cp.spawnSync('unshare', ['-Urpf', '--mount-proc', 'true'], { stdio: 'ignore' }).status === 0;

// The holder sits in a real pid namespace of its own, under a host name of its
// own, as a shim in a sandbox that names its own host does.
test('a cleanup on the host keeps the directory while a cleanup in a sandbox of its own holds it', { skip: !UNSHARE && 'needs unshare for a pid namespace', timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const signal = path.join(h.base, 'reap-taken');
  const [node, args, opts] = shimGit(h, { HOOK_REAP_TAKEN: signal, HOOK_HOSTNAME: 'localhost' });
  const holder = cp.spawn('unshare', ['-Urpf', '--mount-proc', node, ...args], { ...opts, stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await fileWritten(signal);
  const dir = path.join(commonDir, REAP_DIR);
  const [marker] = fs.readdirSync(dir);
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, marker), 'utf8'));
  assert.notEqual(recorded.pidns, pidns());
  assert.equal(recorded.host, 'localhost');
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  sandboxMarks(t, {});
  assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), []);
  assert.match(messages.join(''), /another cleanup holds/);
  assert.equal(fs.existsSync(path.join(dir, marker)), true);
  fs.writeFileSync(`${signal}.go`, '');
  assert.deepEqual(await childExit(holder), { code: 0, signal: null });
});

const UNSHARE_TIME = UNSHARE && cp.spawnSync('unshare', ['-Urpf', '-T', '--boottime', '1', '--mount-proc', 'true'], { stdio: 'ignore' }).status === 0;
const BOOTTIME = 100000;

// /proc shows start times shifted by the reader's time namespace, so a holder
// under unshare -T records a start 100000 s later than the host reads for it.
// It is alive in this pid namespace and in one of its own, and a marker from
// before offsets were recorded is kept too, since its holder is in another time
// namespace. Once the holder is gone, its marker is gone.
test('a cleanup keeps the directory while a holder in a time namespace of its own holds it', { skip: !UNSHARE_TIME && 'needs unshare for a time namespace', timeout: 300000 }, async (t) => {
  for (const pidNamespace of [[], ['-pf', '--mount-proc']]) {
    const h = makeRepo(t);
    h.init();
    const commonDir = path.join(h.repo, '.git');
    const dir = path.join(commonDir, REAP_DIR);
    const signal = path.join(h.base, 'reap-taken');
    const [node, args, opts] = shimGit(h, { HOOK_REAP_TAKEN: signal });
    const holder = cp.spawn('unshare', ['-Ur', ...pidNamespace, '-T', '--boottime', String(BOOTTIME), node, ...args], { ...opts, stdio: 'ignore' });
    t.after(() => holder.kill('SIGKILL'));
    await fileWritten(signal);
    const [nonce] = fs.readdirSync(dir);
    const marker = path.join(dir, nonce);
    const recorded = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(recorded.boottime_offset_ns, String(BOOTTIME * 1e9));
    const messages = [];
    const write = t.mock.method(process.stderr, 'write', (chunk) => {
      messages.push(String(chunk));
      return true;
    });
    sandboxMarks(t, {});
    const name = pidNamespace.length ? 'own pid namespace' : 'this pid namespace';
    assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), [], name);
    assert.match(messages.join(''), /another cleanup holds/, name);
    assert.equal(fs.existsSync(marker), true, name);
    const { boottime_offset_ns: _, ...older } = recorded;
    fs.writeFileSync(marker, JSON.stringify(older));
    assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), [], `${name}, no offset recorded`);
    assert.equal(fs.existsSync(marker), true, `${name}, no offset recorded`);
    write.mock.restore();
    fs.writeFileSync(`${signal}.go`, '');
    assert.deepEqual(await childExit(holder), { code: 0, signal: null });
    plantMarker(commonDir, recorded, nonce);
    clearPlaceholders(commonDir, { waitMs: 0 });
    assert.equal(fs.existsSync(dir), false, `${name}: a holder that is gone`);
  }
});

// claude's sandbox sets SANDBOX_RUNTIME=1 and codex's sets CODEX_SANDBOX in the
// commands they confine, so a git call there that lost TOWER_CRANE_SANDBOX is
// still inside: it cannot see the host's processes, and a live holder there
// would look gone.
test('a cleanup that claude or codex marks as sandboxed keeps a marker from another pid namespace', { skip: process.platform !== 'linux' && 'pid namespaces are Linux only', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const marker = plantMarker(commonDir, { pid: NO_PID, pidns: 'pid:[4026599999]', start_ticks: '1' });
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  onlyProcesses(t, h);
  const mark = sandboxMarks(t, {});
  for (const marks of [{ SANDBOX_RUNTIME: '1' }, { CODEX_SANDBOX: 'seccomp' }]) {
    mark({ ...marks, TOWER_CRANE_SANDBOX: '0' });
    messages.length = 0;
    assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), [], JSON.stringify(marks));
    assert.match(messages.join(''), /another cleanup holds/, JSON.stringify(marks));
    assert.equal(fs.existsSync(marker), true, JSON.stringify(marks));
  }
  mark({ TOWER_CRANE_SANDBOX: '0' });
  clearPlaceholders(commonDir, { waitMs: 0 });
  assert.equal(fs.existsSync(path.join(commonDir, REAP_DIR)), false);
});

// A devcontainer or a docker container on the same repository runs on this
// kernel, with this boot id and a host name of its own, and does not see the
// host's processes. A sandbox can name its own host too (claude's project-hook
// sandbox names it localhost), and only a cleanup in the initial pid namespace
// sees every process on the kernel.
test('a marker from another host name on this boot is judged only from the initial pid namespace', { skip: !BOOT_ID && 'needs a boot id', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const dir = path.join(commonDir, REAP_DIR);
  const table = procTable(h);
  const dead = { pid: NO_PID, start_ticks: '1' };
  // A container judges a marker from the host, whose holder it cannot see.
  plantMarker(commonDir, { ...dead, pidns: 'pid:[4026531836]' });
  const container = judge(h, commonDir, { HOOK_HOSTNAME: 'devcontainer', HOOK_PIDNS: 'pid:[4026511111]', TOWER_CRANE_PROC: table });
  assert.match(container.stderr, /another cleanup holds/);
  assert.equal(fs.existsSync(dir), true);
  fs.rmSync(dir, { recursive: true });
  // The host judges a marker from a sandbox that names its own host.
  plantMarker(commonDir, { ...dead, host: 'localhost', pidns: 'pid:[4026599999]' });
  const nested = judge(h, commonDir, { HOOK_PIDNS: 'pid:[4026522222]', TOWER_CRANE_PROC: table, TOWER_CRANE_SANDBOX: '0' });
  assert.match(nested.stderr, /another cleanup holds/);
  assert.equal(fs.existsSync(dir), true);
  const host = judge(h, commonDir, { HOOK_PIDNS: 'pid:[4026531836]', TOWER_CRANE_PROC: table, TOWER_CRANE_SANDBOX: '0' });
  assert.doesNotMatch(host.stderr, /another cleanup holds/);
  assert.equal(fs.existsSync(dir), false);
});

// A marker is renamed into place only after it is written, so one that does
// not parse was cut short by a crash of the machine. Before markers were
// synced, that left an empty one, and every cleanup waited 5 s on it until it
// was removed by hand.
test('a marker that does not parse is gone once it predates this boot', { skip: !fs.existsSync('/proc/self') && 'needs /proc to take the directory', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const dir = path.join(commonDir, REAP_DIR);
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  onlyProcesses(t, h);
  const fresh = plantMarker(commonDir, '');
  assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), []);
  assert.match(messages.join(''), /another cleanup holds/);
  assert.equal(fs.existsSync(fresh), true);
  const before = new Date(Date.now() - os.uptime() * 1000 - 60000);
  fs.utimesSync(fresh, before, before);
  const lock = path.join(commonDir, 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  assert.deepEqual(clearPlaceholders(commonDir, { waitMs: 0 }), [lock]);
  assert.equal(fs.existsSync(dir), false);
});

// A taker killed between creating its prepared directory and writing its
// marker leaves a directory that names no one; a live taker writes its marker
// at once.
test('a prepared directory left without a marker is swept once it is older than the wait', { skip: !fs.existsSync('/proc/self') && 'needs /proc to take the directory', timeout: 300000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const prepared = (nonce) => {
    const dir = path.join(commonDir, `${REAP_DIR}.${NO_PID}.${nonce}.new`);
    fs.mkdirSync(dir);
    return dir;
  };
  const old = prepared('0123456789abcdef');
  const then = new Date(Date.now() - REAP_WAIT_MS - 60000);
  fs.utimesSync(old, then, then);
  const recent = prepared('fedcba9876543210');
  onlyProcesses(t, h);
  clearPlaceholders(commonDir);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
});

// Python makes this process non-dumpable, so its descriptors are unreadable to
// a same-user cleanup while its status still shows its uid.
const PY_HOLDER = `
import ctypes, sys, time
ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)
f = open(sys.argv[1])
print('open', flush=True)
time.sleep(60)
`;
const PYTHON = cp.spawnSync('python3', ['-I', '-c', 'pass']).status === 0;
const HOLDER_SKIP = !fs.existsSync('/proc/self/fd') ? 'needs /proc to see which process holds the lock'
  : process.getuid?.() === 0 ? 'root reads every descriptor table'
    : !PYTHON && 'needs python3 to make a process non-dumpable';

test('a lock held by a same-user process whose descriptors are unreadable is kept', { skip: HOLDER_SKIP, timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const holder = cp.spawn('python3', ['-I', '-c', PY_HOLDER, lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    assert.throws(() => fs.readdirSync(`/proc/${holder.pid}/fd`), { code: 'EACCES' });
    assert.deepEqual(clearPlaceholders(path.join(h.repo, '.git')), []);
  } finally {
    holder.kill();
  }
  assert.equal(fs.existsSync(lock), true);
});

// The forked child exits at once and its parent never waits, so it stays a zombie.
const PY_ZOMBIE = `
import os, time
pid = os.fork()
if pid == 0:
    os._exit(0)
time.sleep(0.5)
print(pid, flush=True)
time.sleep(60)
`;

test('a zombie of this user holds nothing, so it keeps no placeholder', { skip: HOLDER_SKIP, timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const lock = path.join(h.repo, '.git', 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const parent = cp.spawn('python3', ['-I', '-c', PY_ZOMBIE], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const pid = await new Promise((resolve) => parent.stdout.once('data', (data) => resolve(String(data).trim())));
    assert.match(fs.readFileSync(`/proc/${pid}/status`, 'utf8'), /^State:\s+Z\b/m);
    onlyProcesses(t, h, [pid]);
    assert.deepEqual(clearPlaceholders(path.join(h.repo, '.git')).map((file) => path.basename(file)), ['config.lock']);
  } finally {
    parent.kill();
  }
  assert.equal(fs.existsSync(lock), false);
});
