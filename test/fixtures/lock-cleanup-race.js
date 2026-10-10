'use strict';

const fs = require('node:fs');
const path = require('node:path');

const point = process.env.LOCK_RACE_POINT;
const operation = { mkdir: 'mkdirSync', write: 'writeFileSync', rename: 'renameSync' }[point];
const original = fs[operation];
let failed = false;

fs[operation] = function concurrentCleanup(target, ...args) {
  if (typeof target !== 'string') return original.call(this, target, ...args);
  const staging = point === 'write' ? path.dirname(target) : target;
  if (typeof staging === 'string' && staging.endsWith('.new')
    && path.dirname(staging) === process.env.HOOK_STATE
    && (!failed || process.env.LOCK_RACE_ALWAYS)) {
    failed = true;
    fs.appendFileSync(process.env.LOCK_RACE_ATTEMPTS, `${path.basename(staging)}\n`);
    if (point === 'mkdir') {
      throw Object.assign(new Error('temporary directory already exists'), { code: 'EEXIST' });
    }
    // Another process removes the directory before the real filesystem call.
    fs.rmSync(staging, { recursive: true });
  }
  return original.call(this, target, ...args);
};
