'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, copyRepo, TMP_ROOT, ROOT } = require('./helpers');

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
