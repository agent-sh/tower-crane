'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

const entry = path.basename(process.argv[1] || '');

// Holds back the output release deadline, so a test can watch the supervisor
// wait on a retained pipe however long the machine takes to show it.
if (entry === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_HOLD_OUTPUT_RELEASE) {
  const schedule = global.setTimeout;
  global.setTimeout = function heldRelease(fn, ms, ...args) {
    return schedule(fn, fn?.name === 'outputReleaseDeadline' ? 2147483647 : ms, ...args);
  };
}

if (entry === 'tower-crane.js' && process.env.TOWER_CRANE_TEST_MONITOR_ARGV) {
  const original = cp.spawn;
  cp.spawn = function captureMonitorArgv(file, args, options) {
    if (args.some((arg) => path.basename(arg) === 'spawn-monitor.js')) {
      writeAtomic(process.env.TOWER_CRANE_TEST_MONITOR_ARGV, JSON.stringify({ file, args }));
    }
    return original.call(this, file, args, options);
  };
}

if (entry === 'tower-crane.js'
  && process.argv.includes('spawn')
  && process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND
  && process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND) {
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalReadSync = fs.readSync;
  const originalExistsSync = fs.existsSync;
  const logs = new Set();
  let held = false;
  // The CLI reads the log whole or in appended chunks; either read that first
  // returns the monitor's exit holds the process.
  const hold = (text) => {
    if (held || !text.includes('"cmd":"spawn exit"')) return;
    held = true;
    writeAtomic(process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND, String(process.pid));
    const deadline = Date.now() + 300000;
    while (!originalExistsSync.call(fs, process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND)
      && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  fs.readFileSync = function holdForegroundSpend(file, ...args) {
    const result = originalReadFileSync.call(this, file, ...args);
    if (typeof file === 'string' && path.basename(file) === 'events.jsonl') {
      hold(Buffer.isBuffer(result) ? result.toString('utf8') : String(result));
    }
    return result;
  };
  fs.openSync = function trackLog(file, ...args) {
    const fd = originalOpenSync.call(this, file, ...args);
    if (typeof file === 'string' && path.basename(file) === 'events.jsonl') logs.add(fd);
    return fd;
  };
  fs.closeSync = function untrackLog(fd) {
    logs.delete(fd);
    return originalCloseSync.call(this, fd);
  };
  fs.readSync = function holdForegroundSpendChunk(fd, buffer, ...args) {
    const n = originalReadSync.call(this, fd, buffer, ...args);
    if (logs.has(fd) && n > 0) {
      const offset = typeof args[0] === 'number' ? args[0] : args[0]?.offset ?? 0;
      hold(Buffer.from(buffer.buffer, buffer.byteOffset + offset, n).toString('utf8'));
    }
    return n;
  };
}
