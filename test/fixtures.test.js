'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, copyRepo, TMP_ROOT } = require('./helpers');

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
