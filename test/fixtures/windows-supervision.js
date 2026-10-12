'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && (process.env.TOWER_CRANE_TEST_TASKKILL || process.env.TOWER_CRANE_TEST_MONITOR_CLAIM)) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const run = cp.spawnSync;
  cp.spawnSync = function observedTreeStop(file, args, options) {
    if (file !== 'taskkill') return run.call(this, file, args, options);
    if (process.env.TOWER_CRANE_TEST_TASKKILL) fs.appendFileSync(process.env.TOWER_CRANE_TEST_TASKKILL, JSON.stringify(args) + '\n');
    return { status: 128, stdout: '', stderr: 'process already exited' };
  };
  if (process.env.TOWER_CRANE_TEST_MONITOR_CLAIM) {
    const state = require(path.join(path.dirname(process.argv[1]), 'state'));
    const mutate = state.mutate;
    const barrier = process.env.TOWER_CRANE_TEST_MONITOR_CLAIM;
    state.mutate = function delayedMonitorClaim(ctx, command, ...args) {
      if (command === 'claim') {
        fs.writeFileSync(barrier, '');
        const end = performance.now() + 30000;
        while (!fs.existsSync(`${barrier}.go`)) {
          if (performance.now() >= end) throw new Error('monitor claim barrier was not released');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      const result = mutate.call(this, ctx, command, ...args);
      if (command === 'claim') fs.writeFileSync(`${barrier}.done`, '');
      return result;
    };
  }
}
