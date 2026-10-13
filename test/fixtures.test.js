'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, copyRepo, TMP_ROOT, ROOT, HARNESS_GUARD } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

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
      try { return fs.readFileSync(HARNESS_GUARD.hits, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    };
    const mine = () => calls().filter((hit) => hit.state === h.state).map((hit) => hit.name).sort();
    for (let deadline = Date.now() + 60000; Date.now() < deadline && new Set(mine()).size < 2;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
