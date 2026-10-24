'use strict';

// Counts the event rows this process reads of the state, and its whole
// snapshots, from the steps lib/db.js reaches, and writes them to
// EVENT_ROWS when it exits.
const { writeAtomic } = require('../atomic-file');
let rows = 0;
let snapshots = 0;
process.on('tower-crane:state-step', (step, dir, n) => {
  if (step === 'events') rows += n || 0;
  if (step === 'snapshot') snapshots++;
});
// Only the command itself reports: the sketch worker a write starts inherits
// the environment and may exit after it, over its count.
const cli = require('node:path').basename(process.argv[1] || '') === 'tower-crane.js';
process.on('exit', () => {
  if (cli) writeAtomic(process.env.EVENT_ROWS, JSON.stringify({ rows, snapshots }));
});
