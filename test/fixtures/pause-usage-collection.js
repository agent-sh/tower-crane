'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const barrier = process.env.USAGE_COLLECT_BARRIER;
if (barrier && path.basename(process.argv[1] || '') === 'spawn-monitor.js') {
  const spawnSync = cp.spawnSync;
  cp.spawnSync = function (command, args, options) {
    if (args?.[1] === 'spend') {
      fs.writeFileSync(barrier, 'paused');
      // A failed test must not strand the collector indefinitely.
      const deadline = performance.now() + 300000;
      while (!fs.existsSync(`${barrier}.go`)) {
        if (performance.now() >= deadline) throw new Error('usage collection barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return spawnSync.call(this, command, args, options);
  };
}
