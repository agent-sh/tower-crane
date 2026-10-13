'use strict';

const fs = require('node:fs');
const path = require('node:path');
const handles = new Set();
let bytes = 0;
let baseline = 0;
const open = fs.openSync;
const close = fs.closeSync;
const read = fs.readSync;
const readFile = fs.readFileSync;
fs.openSync = function (file, ...args) {
  const fd = open.call(this, file, ...args);
  if (path.basename(String(file)) === 'events.jsonl') handles.add(fd);
  return fd;
};
fs.closeSync = function (fd) {
  handles.delete(fd);
  return close.call(this, fd);
};
fs.readSync = function (fd, ...args) {
  const n = read.call(this, fd, ...args);
  if (handles.has(fd)) bytes += n;
  return n;
};
fs.readFileSync = function (file, ...args) {
  const result = readFile.call(this, file, ...args);
  if (path.basename(String(file)) === 'events.jsonl') bytes += Buffer.byteLength(result);
  return result;
};
const watch = fs.watch;
fs.watch = function (...args) {
  // The first check runs in microtasks before this baseline, including startup reconciliation.
  setImmediate(() => { baseline = bytes; });
  return watch.apply(this, args);
};
process.on('exit', () => {
  fs.writeFileSync(process.env.EVENT_READ_BUDGET, JSON.stringify({ bytes: bytes - baseline }));
});
