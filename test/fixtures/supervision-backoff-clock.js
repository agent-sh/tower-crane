'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js') {
  if (process.env.TOWER_CRANE_TEST_BACKOFF_CLOCK) {
    // Keep backoff pending while the test checks lease renewal and fencing.
    Object.defineProperty(performance, 'now', {
      value: () => Number(fs.readFileSync(process.env.TOWER_CRANE_TEST_BACKOFF_CLOCK, 'utf8')),
    });
  } else {
    const now = performance.now.bind(performance);
    const schedule = global.setTimeout;
    let elapsed = 0;
    Object.defineProperty(performance, 'now', { value: () => now() + elapsed });
    // Exercise the real supervisor's default outage budget without making CI
    // wait fifteen minutes. CLI locks and short cleanup timers stay in real time.
    global.setTimeout = function acceleratedBackoff(fn, ms, ...args) {
      if (ms < 30000 || ms > 600000) return schedule(fn, ms, ...args);
      return schedule(() => {
        elapsed += ms;
        fn(...args);
      }, ms / 1000);
    };
  }
}
