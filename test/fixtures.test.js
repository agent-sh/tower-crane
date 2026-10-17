'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { makeRepo, copyRepo, shortCacheRoot, TMP_ROOT, ROOT, HARNESS_GUARD, processesIn, assertNoProcessesIn } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { waitUntil, childExit } = require('./signals');

// Runs f and returns the fixture directories it made, recorded by wrapping mkdtemp.
function recordFixtureDirs(f) {
  const made = [];
  const mkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = function (prefix, ...rest) {
    const dir = mkdtempSync.call(this, prefix, ...rest);
    if (path.basename(prefix) === 'tower-crane-') made.push(dir);
    return dir;
  };
  try {
    f();
  } finally {
    fs.mkdtempSync = mkdtempSync;
  }
  return made;
}

test('a fixture copy that fails leaves no temp directory behind', (t) => {
  const made = recordFixtureDirs(() => {
    assert.throws(() => copyRepo(t, path.join(TMP_ROOT, 'no-such-fixture')), { code: 'ENOENT' });
  });
  assert.equal(made.length, 1);
  assert.equal(fs.existsSync(made[0]), false, made[0]);
});

test('a fresh fixture whose setup fails leaves no temp directory behind', (t) => {
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = function (dir, ...rest) {
    // baseEnv creates the owner key directory inside every fixture; a full disk fails it here.
    if (path.basename(dir) === 'owner') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return mkdirSync.call(this, dir, ...rest);
  };
  let made;
  try {
    made = recordFixtureDirs(() => {
      assert.throws(() => makeRepo(t), { code: 'ENOSPC' });
    });
  } finally {
    fs.mkdirSync = mkdirSync;
  }
  assert.equal(made.length, 1);
  assert.equal(fs.existsSync(made[0]), false, made[0]);
});

// shortCacheRoot reads the account's home from the password database, so the
// test stands a fake home in for it and runs the helper with a recording context.
function withAccountHome(home, f) {
  const os = require('node:os');
  const saved = { userInfo: os.userInfo, runtime: process.env.XDG_RUNTIME_DIR };
  os.userInfo = () => ({ ...saved.userInfo(), homedir: home });
  delete process.env.XDG_RUNTIME_DIR;
  const ctx = { hooks: [], notes: [], after(fn) { this.hooks.push(fn); }, diagnostic(msg) { this.notes.push(msg); } };
  try {
    return { root: f(ctx), ctx };
  } finally {
    os.userInfo = saved.userInfo;
    if (saved.runtime !== undefined) process.env.XDG_RUNTIME_DIR = saved.runtime;
  }
}

test('shortCacheRoot measures the real path of a linked cache and never makes a missing one', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, (t) => {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'short-cache-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A ~/.cache that links to a longer directory: short as named, too long once resolved.
  const linked = path.join(base, 'linked');
  const target = path.join(base, 'target-'.padEnd(80, 'x'));
  fs.mkdirSync(linked);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(linked, '.cache'));
  const fits = Buffer.byteLength(path.join(linked, '.cache', 'tc-test-XXXXXX'));
  const long = withAccountHome(linked, (ctx) => shortCacheRoot(ctx, fits));
  assert.equal(long.root, null, 'the resolved cache is too long');
  assert.equal(long.ctx.notes.length, 1, 'the skip is reported');
  assert.match(long.ctx.notes[0], /resolves to .*target-x/);
  assert.deepEqual(fs.readdirSync(target), [], 'nothing is made under the long target');
  // No ~/.cache: the helper passes the base over and says so, making nothing.
  const bare = path.join(base, 'bare');
  fs.mkdirSync(bare);
  const missing = withAccountHome(bare, (ctx) => shortCacheRoot(ctx, 4096));
  assert.equal(missing.root, null);
  assert.equal(missing.ctx.notes.length, 1, 'the missing cache is reported');
  assert.match(missing.ctx.notes[0], /not made here/);
  assert.deepEqual(fs.readdirSync(bare), [], 'no cache is made');
  // A ~/.cache link to a missing directory is reported as such.
  const dangling = path.join(base, 'dangling');
  fs.mkdirSync(dangling);
  fs.symlinkSync(path.join(base, 'gone'), path.join(dangling, '.cache'));
  const broken = withAccountHome(dangling, (ctx) => shortCacheRoot(ctx, 4096));
  assert.equal(broken.root, null);
  assert.equal(broken.ctx.notes.length, 1);
  assert.match(broken.ctx.notes[0], /link to a missing directory/);
  assert.equal(fs.existsSync(path.join(base, 'gone')), false, 'the link target is not made');
  // An existing ~/.cache gives a root there, and only the root goes after the test.
  fs.mkdirSync(path.join(bare, '.cache'));
  const kept = withAccountHome(bare, (ctx) => shortCacheRoot(ctx, 4096));
  assert.ok(kept.root && kept.root.startsWith(path.join(bare, '.cache') + path.sep), kept.root);
  assert.equal(fs.existsSync(kept.root), true);
  for (const hook of kept.ctx.hooks) hook();
  assert.deepEqual(fs.readdirSync(path.join(bare, '.cache')), [], 'the existing cache stays, without the root');
});

// Linux CI alone runs /proc; the lsof variants stand in for macOS, where the
// leak check would otherwise pass without looking.
test('the fixture process probe uses lsof off Linux and reports a skip where nothing probes', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'probe-')));
  const inside = path.join(base, 'inside');
  const sibling = `${base}-sibling`;
  fs.mkdirSync(inside);
  fs.mkdirSync(sibling);
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });
  const hold = async (cwd) => {
    const child = cp.spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    t.after(async () => { child.stdin.end(); await childExit(child); });
    return child;
  };
  const held = await hold(inside);
  await hold(sibling);
  const lsofRuns = cp.spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;
  for (const platform of ['linux', ...(lsofRuns ? ['darwin', 'freebsd'] : [])]) {
    if (platform === 'linux' && process.platform !== 'linux') continue;
    assert.deepEqual(processesIn(base, { platform }), { pids: [held.pid] }, platform);
  }
  // macOS lsof adds an f line per file; a removed directory may carry the deleted suffix.
  const lsof = () => ({ status: 1, stdout: `p11\nfcwd\nn${inside}\np12\nfcwd\nn${sibling}\np13\nfcwd\nn${base} (deleted)\np14\nfcwd\nn/\n` });
  assert.deepEqual(processesIn(base, { platform: 'darwin', lsof }), { pids: [11, 13] });
  const missing = () => ({ error: Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' }) });
  assert.deepEqual(processesIn(base, { platform: 'darwin', lsof: missing }), { skip: 'lsof did not run: ENOENT' });
  assert.deepEqual(processesIn(base, { platform: 'darwin', lsof: () => ({ status: 1, stdout: '' }) }), { skip: 'lsof listed nothing (exit 1)' });
  assert.deepEqual(processesIn(base, { platform: 'win32' }), { skip: 'Windows has no working-directory probe' });
  const notes = [];
  assertNoProcessesIn({ diagnostic: (note) => notes.push(note) }, base, { platform: 'win32' });
  assert.deepEqual(notes, ['process leak check skipped: Windows has no working-directory probe']);
  assert.throws(() => assertNoProcessesIn({ diagnostic: (note) => notes.push(note) }, base, { platform: 'darwin', lsof }),
    /no process the test started outlives its fixture/);
});

// Detached, the repack and prune that a commit starts outlive the commit and
// delete loose objects while fixture cleanup removes the directory, which
// leaves the fixture behind. Git 2.54 and later start one after any commit
// that leaves 100 loose objects; gc.auto=1 with three in objects/17 makes the
// gc task due on every version.
test('auto-maintenance a fixture commit starts has finished when the commit returns', (t) => {
  const h = makeRepo(t);
  h.git(['config', 'gc.auto', '1']);
  h.git(['config', 'maintenance.gc.enabled', 'true']);
  const bucket = [];
  for (let i = 0; bucket.length < 3; i++) {
    const body = `due ${i}\n`;
    const id = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    if (!id.startsWith('17')) continue;
    fs.writeFileSync(path.join(h.repo, `due-${i}.txt`), body);
    bucket.push(id);
  }
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'due maintenance']);
  const dir = path.join(h.repo, '.git', 'objects', '17');
  const loose = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(loose, [], 'the commit returned before its maintenance packed and pruned the loose objects');
  for (const id of bucket) assert.equal(h.git(['cat-file', '-t', id]), 'blob');
});

test('fixture cleanup removes a broker socket left by a killed monitor', {
  skip: process.platform === 'win32' && 'Windows brokers use named pipes',
}, async (t) => {
  const h = makeRepo(t);
  const script = `
const path = require('node:path');
require(${JSON.stringify(path.join(ROOT, 'lib/broker.js'))}).start({
  state: ${JSON.stringify(h.state)}, task: 'T1', agent: 'worker', role: 'worker',
  harness: 'claude', broker: ${JSON.stringify(path.join(h.state, 'brokers', 'w'.repeat(100), 'broker.json'))},
}).then(() => console.log('ready'));
`;
  const child = cp.spawn(process.execPath, ['-e', script], { env: h.env });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`broker exited ${code}`)));
  });
  const { socket } = JSON.parse(fs.readFileSync(path.join(h.state, 'brokers', 'w'.repeat(100), 'broker.json'), 'utf8'));
  const dir = path.dirname(socket);
  assert.ok(fs.existsSync(socket));
  assert.match(path.basename(dir), /^tower-crane-[A-Za-z0-9]{6}$/);
  // SIGKILL bypasses the monitor's broker.close(), including its external temp directory.
  child.kill('SIGKILL');
  await closed;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await h.cleanup();
  assert.equal(fs.existsSync(dir), false, 'the fixture owns the killed broker socket too');
});

// A rung with no stub resolves its harness from PATH. In a non-live run that
// must be the guard, and the test that owns the fixture fails at cleanup.
test('a fixture spawn without a stub reaches the harness guard and fails its test, not a real codex or claude', {
  skip: !HARNESS_GUARD ? 'a live opt-in lifts the guard' : process.platform === 'win32' && 'the guard self-test runs on POSIX hosts',
}, async () => {
  const h = makeRepo();
  try {
    const first = (h.env.PATH || h.env.Path).split(path.delimiter)[0];
    assert.equal(first, HARNESS_GUARD.dir, 'the guard comes first on every fixture PATH');
    h.init();
    // The fixture ladder runs medium on codex and hard on claude.
    for (const [title, tier] of [['Codex', 'medium'], ['Claude', 'hard']]) {
      const id = h.ok(['task', 'add', '--title', title, '--acceptance', 'works', '--tier', tier]);
      h.ok(['brief', 'set', id, '-'], { input: `Run ${title}.\n` });
      h.ok(['spawn', '--task', id, '--agent', 'orchestrator']);
    }
    const calls = () => {
      // read-published: the guard appends hits; nothing replaces the file.
      try { return fs.readFileSync(HARNESS_GUARD.hits, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    };
    const mine = () => calls().filter((hit) => hit.state === h.state).map((hit) => hit.name).sort();
    await waitUntil(() => new Set(mine()).size >= 2, { what: 'both rungs did not reach the harness guard' });
    assert.deepEqual([...new Set(mine())], ['claude', 'codex']);
  } finally {
    await assert.rejects(h.cleanup(), /a non-live test started a real harness instead of a stub:[\s\S]*"name":"(codex|claude)"/);
  }
});

test('gate fixture creation and restoration recover from an incomplete native directory copy', (t) => {
  const cpSync = fs.cpSync;
  let interrupt = false;
  let failures = 0;
  fs.cpSync = function (source, destination, options) {
    if (interrupt && path.basename(source) === '.git') {
      interrupt = false;
      failures++;
      fs.mkdirSync(destination, { recursive: true });
      throw Object.assign(new Error('incomplete native directory copy'), {
        code: 'ENOENT', path: path.join(destination, 'objects'), syscall: 'cp',
      });
    }
    return cpSync.call(this, source, destination, options);
  };
  try {
    let first;
    for (const phase of ['create', 'restore']) {
      const h = makeRepo(t);
      h.init();
      interrupt = true;
      const sha = gateFixture(h);
      assert.equal(interrupt, false, phase);
      first ||= sha;
      assert.equal(sha, first);
      assert.equal(h.git(['rev-parse', 'HEAD']), sha);
      assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 1;\n');
      h.ok(['task', 'add', '--title', phase, '--acceptance', 'regression passes with the change']);
      h.ok(['claim', 'T1', '--agent', 'worker']);
      h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
      gateEvidence(h, 'tests', 'orchestrator');
    }
    assert.equal(failures, 2);
  } finally {
    fs.cpSync = cpSync;
  }
});
