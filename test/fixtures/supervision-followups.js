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
  const originalExistsSync = fs.existsSync;
  let held = false;
  // The CLI reads the log from the database (lib/db.js); the first read that
  // returns the monitor's exit holds the process.
  const hold = (rows) => {
    if (held || !rows.some((r) => typeof r?.body === 'string' && r.body.includes('"cmd":"spawn exit"'))) return;
    held = true;
    writeAtomic(process.env.TOWER_CRANE_TEST_HOLD_SPAWN_SPEND, String(process.pid));
    const deadline = Date.now() + 300000;
    while (!originalExistsSync.call(fs, process.env.TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND)
      && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function holdForegroundSpend(request, parent, ...rest) {
    const mod = load.call(this, request, parent, ...rest);
    if (mod && typeof mod.eventsAfter === 'function' && typeof mod.taskEvents === 'function' && !mod.heldReads) {
      mod.heldReads = true;
      for (const name of ['eventsAfter', 'taskEvents', 'agentEvents']) {
        const read = mod[name];
        mod[name] = function heldRead(...args) {
          const rows = read.apply(this, args);
          hold(rows);
          return rows;
        };
      }
    }
    return mod;
  };
}
