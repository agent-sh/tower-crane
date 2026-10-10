'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');
const { clearPlaceholders, REAP_DIR, REAP_STALE_MS } = require('../lib/git-placeholders');

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
  process.env.TOWER_CRANE_PROC = procTable(h, pids);
  t.after(() => {
    if (previous === undefined) delete process.env.TOWER_CRANE_PROC;
    else process.env.TOWER_CRANE_PROC = previous;
  });
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

async function waitFor(file) {
  const deadline = performance.now() + 15000;
  while (!fs.existsSync(file)) {
    assert.ok(performance.now() < deadline, `waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('two preparations overlap a gate removal without pruning their initializing registrations', { timeout: 30000 }, async (t) => {
  const h = makeRepo(t);
  const script = path.join(h.base, 'gate.js');
  const ready = path.join(h.base, 'gate-ready');
  const release = path.join(h.base, 'gate-release');
  const addRelease = path.join(h.base, 'add-release');
  const hook = path.join(h.base, 'hook.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, '');
const deadline = performance.now() + 20000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (performance.now() > deadline) process.exit(1);
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
const deadline = performance.now() + 20000;
while (!fs.existsSync(${JSON.stringify(addRelease)})) {
  if (performance.now() > deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
  fs.writeFileSync(path.join(h.repo, '.git', 'hooks', 'post-checkout'),
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
      assert.equal(fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim(), '../..');
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
    { cwd: h.repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(push.status, 0, push.stderr);
  // Git reports a blocked upstream write without a failing status.
  assert.doesNotMatch(push.stderr, /could not lock config/);
  assert.match(push.stderr, /removed empty read-only placeholder .*config\.lock/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(h.git(['config', '--get', 'branch.task-T1.remote']), remote);
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

test('a cleanup keeps placeholders while another cleanup holds the git directory', { timeout: 30000 }, (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const lock = path.join(commonDir, 'config.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  fs.mkdirSync(path.join(commonDir, REAP_DIR));
  const messages = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    return true;
  });
  assert.deepEqual(clearPlaceholders(commonDir), []);
  assert.equal(fs.existsSync(lock), true);
  assert.match(messages.join(''), /another cleanup holds/);
});

test('a cleanup removes the directory a dead cleanup left behind, then the placeholder', (t) => {
  const h = makeRepo(t);
  h.init();
  const commonDir = path.join(h.repo, '.git');
  const lock = path.join(commonDir, 'index.lock');
  fs.writeFileSync(lock, '', { mode: 0o444 });
  const dir = path.join(commonDir, REAP_DIR);
  fs.mkdirSync(dir);
  const old = new Date(Date.now() - REAP_STALE_MS - 1000);
  fs.utimesSync(dir, old, old);
  t.mock.method(process.stderr, 'write', () => true);
  onlyProcesses(t, h);
  assert.deepEqual(clearPlaceholders(commonDir).map((file) => path.basename(file)), ['index.lock']);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(dir), false);
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

test('a lock held by a same-user process whose descriptors are unreadable is kept', { skip: HOLDER_SKIP, timeout: 30000 }, async (t) => {
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

test('a zombie of this user holds nothing, so it keeps no placeholder', { skip: HOLDER_SKIP, timeout: 30000 }, async (t) => {
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
