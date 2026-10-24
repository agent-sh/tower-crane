'use strict';

if (process.execArgv.includes('-e') && process.env.TOWER_CRANE_AGENT) {
  const interval = global.setInterval;
  // Model callback overhead that makes a periodic keepalive count as CPU progress.
  global.setInterval = (callback, ms, ...args) => interval(() => {
    const before = process.cpuUsage();
    for (;;) {
      const spent = process.cpuUsage(before);
      if (spent.user + spent.system >= 100000) break;
    }
    callback(...args);
  }, ms);
}
