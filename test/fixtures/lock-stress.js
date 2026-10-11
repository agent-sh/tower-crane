'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { main } = require('../../bin/tower-crane');

// Expose the interval between mkdir and marker creation with an old mtime,
// as a sweeper sees it after a clock jump or a suspended writer.
if (process.env.LOCK_STRESS_AGE_STAGING) {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = function agedStaging(dir, ...args) {
    const result = mkdir.call(this, dir, ...args);
    if (path.dirname(dir) === process.env.HOOK_STATE && dir.endsWith('.new')) {
      const old = new Date(Date.now() - 120000);
      fs.utimesSync(dir, old, old);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return result;
  };
}

async function run() {
  const barrier = process.env.LOCK_STRESS_BARRIER;
  fs.writeFileSync(path.join(barrier, String(process.pid)), '');
  await require('../signals').fileWritten(path.join(barrier, 'go'), { check: () => true });
  const end = performance.now() + 3000; // wait-allow: limit the amount of stress work; barrier readiness uses a file signal
  let writes = 0;
  do {
    const code = await main(['task', 'note', 'T1', `${process.pid}:${writes}`]);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
    writes++;
  } while (performance.now() < end);
  console.log(JSON.stringify({ writes }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
