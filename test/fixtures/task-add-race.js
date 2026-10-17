'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

// TEST_ADD_FAIL=append fails the commit before it lands, which rolls it
// back; TEST_ADD_FAIL=rename fails the command right after its commit.
const state = process.env.TEST_ADD_STATE;
let failed = false;
const fail = (what) => {
  failed = true;
  throw Object.assign(new Error(`injected ${what} write failure`), { code: 'EIO' });
};
process.on('tower-crane:state-step', (step, dir) => {
  if (failed || path.resolve(String(dir)) !== path.resolve(state)) return;
  if (process.env.TEST_ADD_FAIL === 'append' && step === 'commit') fail('database');
  if (process.env.TEST_ADD_FAIL === 'rename' && step === 'committed') fail('post-commit');
});

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
    writeAtomic(process.env.TEST_ADD_RESULT, JSON.stringify({
      status: child.status, stdout: child.stdout, stderr: child.stderr,
      error: child.error?.message,
    }));
  }
  return result;
};
