'use strict';

// Counts what this process reads of the state after its first directory
// watch is installed: event rows, and whole snapshots (every document and
// task row), from the steps lib/db.js reaches.
const fs = require('node:fs');
const { writeAtomic } = require('../atomic-file');
let rows = 0;
let baseline = 0;
let snapshots = 0;
let snapshotBaseline = 0;
process.on('tower-crane:state-step', (step, dir, n) => {
  if (step === 'events') rows += n || 0;
  if (step === 'snapshot') snapshots++;
});
const watch = fs.watch;
fs.watch = function (...args) {
  // The first check runs in microtasks before this baseline, including startup reconciliation.
  setImmediate(() => { baseline = rows; snapshotBaseline = snapshots; });
  return watch.apply(this, args);
};
process.on('exit', () => {
  writeAtomic(process.env.EVENT_READ_BUDGET, JSON.stringify({ rows: rows - baseline, snapshots: snapshots - snapshotBaseline }));
});
if (process.connected) process.once('message', (message) => {
  if (message !== 'stop') throw new Error('unexpected meter command');
  process.disconnect();
  process.emit('SIGTERM');
});
