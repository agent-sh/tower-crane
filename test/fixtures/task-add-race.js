'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

// TEST_ADD_FAIL=append fails the event append, before the commit point;
// TEST_ADD_FAIL=rename fails the rename of tasks.json, after it.
const state = process.env.TEST_ADD_STATE;
const rename = fs.renameSync;
const open = fs.openSync;
let failed = false;
const fail = (what) => {
  failed = true;
  throw Object.assign(new Error(`injected ${what} write failure`), { code: 'EIO' });
};
fs.renameSync = function failTaskWrite(source, target, ...args) {
  if (!failed && process.env.TEST_ADD_FAIL === 'rename' && target === path.join(state, 'tasks.json')) fail('tasks.json');
  return rename.call(this, source, target, ...args);
};
fs.openSync = function failEventAppend(file, flags, ...args) {
  if (!failed && process.env.TEST_ADD_FAIL === 'append' && file === path.join(state, 'events.jsonl') && flags === 'a+') fail('events.jsonl');
  return open.call(this, file, flags, ...args);
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
    ], { env, encoding: 'utf8', timeout: 60000 });
    writeAtomic(process.env.TEST_ADD_RESULT, JSON.stringify({
      status: child.status, stdout: child.stdout, stderr: child.stderr,
      error: child.error?.message,
    }));
  }
  return result;
};
