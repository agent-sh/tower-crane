'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const entry = path.basename(process.argv[1] || '');

if (entry === 'tower-crane.js' && process.env.TOWER_CRANE_TEST_MONITOR_ARGV) {
  const original = cp.spawn;
  cp.spawn = function captureMonitorArgv(file, args, options) {
    if (args.some((arg) => path.basename(arg) === 'spawn-monitor.js')) {
      fs.writeFileSync(process.env.TOWER_CRANE_TEST_MONITOR_ARGV, JSON.stringify({ file, args }));
    }
    return original.call(this, file, args, options);
  };
}

if (entry === 'tower-crane.js'
  && process.argv.includes('spawn')
  && process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND
  && process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND) {
  const originalReadFileSync = fs.readFileSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originalExistsSync = fs.existsSync;
  let held = false;
  fs.readFileSync = function holdForegroundSpend(file, ...args) {
    const result = originalReadFileSync.call(this, file, ...args);
    const text = Buffer.isBuffer(result) ? result.toString('utf8') : String(result);
    if (!held && typeof file === 'string' && path.basename(file) === 'events.jsonl'
      && text.includes('"cmd":"spawn exit"')) {
      held = true;
      originalWriteFileSync.call(this, process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND, String(process.pid));
      const deadline = Date.now() + 300000;
      while (!originalExistsSync.call(this, process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND)
        && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  };
}
