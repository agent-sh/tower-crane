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
process.on('exit', () => {
  writeAtomic(process.env.EVENT_ROWS, JSON.stringify({ rows, snapshots }));
});
