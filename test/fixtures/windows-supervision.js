'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_TASKKILL) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const run = cp.spawnSync;
  cp.spawnSync = function observedTreeStop(file, args, options) {
    if (file !== 'taskkill') return run.call(this, file, args, options);
    fs.appendFileSync(process.env.TOWER_CRANE_TEST_TASKKILL, JSON.stringify(args) + '\n');
    return { status: 128, stdout: '', stderr: 'process already exited' };
  };
}
