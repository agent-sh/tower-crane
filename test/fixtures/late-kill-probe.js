'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');

// A supervisor a loaded machine stalls right after its group SIGKILL: its
// monotonic clock moves this many ms at its first look at the group after
// that signal, while no timer of its own has run in between.
const late = Number(process.env.TOWER_CRANE_TEST_LATE_KILL_PROBE);
if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && late > 0) {
  const now = performance.now.bind(performance);
  let offset = 0;
  let armed = false;
  Object.defineProperty(performance, 'now', { value: () => now() + offset });
  const kill = process.kill;
  process.kill = function lateKillProbe(pid, signal) {
    if (pid < 0 && signal === 'SIGKILL') armed = true;
    else if (pid < 0 && signal === 0 && armed) {
      armed = false;
      offset += late;
    }
    return kill.call(process, pid, signal);
  };
}
