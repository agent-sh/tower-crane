'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, copyRepo, TMP_ROOT } = require('./helpers');
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
