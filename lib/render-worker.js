'use strict';

// Draws the sketch after a write, in a process of its own, so the write
// returns once its commit is synced (render.js later). One worker draws and
// one waits behind it: a worker that finds both slots taken has nothing to
// add, since the waiter reads the state after taking its turn.
// Usage: node render-worker.js STATE_DIR

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const { sleepSync } = require('./util');

// Long enough for a render of a large state to finish ahead of the waiter.
const WAIT_MS = 120000;

function main(dir) {
  const slots = path.join(dir, 'render');
  fs.mkdirSync(slots, { recursive: true });
  const next = S.tryMarkedLock(path.join(slots, 'next'), { keepLive: true });
  if (!next) return;
  let drawing = null;
  try {
    const deadline = Date.now() + WAIT_MS;
    while (!(drawing = S.tryMarkedLock(path.join(slots, 'lock'), { keepLive: true }))) {
      if (Date.now() > deadline) return;
      sleepSync(50);
    }
  } finally {
    S.releaseMarkedLock(next);
  }
  try {
    require('./render').render({ stateDir: dir });
  } finally {
    S.releaseMarkedLock(drawing);
  }
}

try {
  main(path.resolve(process.argv[2]));
} catch (e) {
  // Nobody waits for this process; the next write or `render` draws again.
  process.stderr.write(`tower-crane: background render failed: ${e.message}\n`);
  process.exitCode = 1;
}
