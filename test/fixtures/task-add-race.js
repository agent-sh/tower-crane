'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const state = process.env.TEST_ADD_STATE;
const rename = fs.renameSync;
let failed = false;
fs.renameSync = function failTaskWrite(source, target, ...args) {
  if (!failed && target === path.join(state, 'tasks.json')) {
    failed = true;
    throw Object.assign(new Error('injected tasks.json write failure'), { code: 'EIO' });
  }
  return rename.call(this, source, target, ...args);
};

const rmdir = fs.rmdirSync;
let replaced = false;
fs.rmdirSync = function addAtLockRelease(dir, ...args) {
  const result = rmdir.call(this, dir, ...args);
  if (failed && !replaced && dir === path.join(state, 'lock')) {
    replaced = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    env.TOWER_CRANE_OWNER_KEY = env.TEST_ADD_OWNER_KEY;
    // Start a real add at the first instant the failed mutation's id is reusable.
    const child = cp.spawnSync(process.execPath, [
      process.env.TEST_ADD_BIN, '--state', state,
      'task', 'add', '--title', 'Different task', '--acceptance', 'no inherited brief',
    ], { env, encoding: 'utf8', timeout: 300000 });
    fs.writeFileSync(process.env.TEST_ADD_RESULT, JSON.stringify({
      status: child.status, stdout: child.stdout, stderr: child.stderr,
      error: child.error?.message,
    }));
  }
  return result;
};
