'use strict';

// Preloaded into a CLI process: counts the state lock holdings it takes and
// the event log bytes it reads while holding one, and writes both on exit.
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file');
const handles = new Set();
const STAGING = /^lock\.\d+\.([0-9a-f]{16})\.new$/;
let marker = null;
let holdings = 0;
let lockedBytes = 0;
const open = fs.openSync;
const close = fs.closeSync;
const read = fs.readSync;
const readFile = fs.readFileSync;
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
const isLog = (file) => path.basename(String(file)) === 'events.jsonl';
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
fs.openSync = function (file, ...args) {
  const fd = open.call(this, file, ...args);
  if (isLog(file)) handles.add(fd);
  return fd;
};
fs.closeSync = function (fd) {
  handles.delete(fd);
  return close.call(this, fd);
};
fs.readSync = function (fd, ...args) {
  const n = read.call(this, fd, ...args);
  if (marker && handles.has(fd)) lockedBytes += n;
  return n;
};
fs.readFileSync = function (file, ...args) {
  const result = readFile.call(this, file, ...args);
  if (marker && isLog(file)) lockedBytes += Buffer.byteLength(result);
  return result;
};
process.on('exit', () => {
  writeAtomic(process.env.LOCKED_READS, JSON.stringify({ holdings, lockedBytes }));
});
