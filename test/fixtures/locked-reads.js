'use strict';

// Preloaded into a CLI process: counts the state lock holdings it takes and
// the event rows it reads of the state while holding one (from the steps
// lib/db.js reaches), and writes both on exit.
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file');
const STAGING = /^lock\.\d+\.([0-9a-f]{16})\.new$/;
let marker = null;
let holdings = 0;
let lockedRows = 0;
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
fs.renameSync = function (from, to, ...args) {
  const result = rename.call(this, from, to, ...args);
  const m = STAGING.exec(path.basename(String(from)));
  if (m && path.basename(String(to)) === 'lock') {
    marker = path.join(String(to), m[1]);
    holdings += 1;
  }
  return result;
};
fs.unlinkSync = function (file, ...args) {
  if (marker && path.resolve(String(file)) === path.resolve(marker)) marker = null;
  return unlink.call(this, file, ...args);
};
process.on('tower-crane:state-step', (step, dir, n) => {
  if (marker && step === 'events') lockedRows += n || 0;
});
process.on('exit', () => {
  writeAtomic(process.env.LOCKED_READS, JSON.stringify({ holdings, lockedRows }));
});
