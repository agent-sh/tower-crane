'use strict';

const path = require('node:path');

// A group whose last member is still there when the supervisor first looks
// after its group SIGKILL (a core dump, an uninterruptible read). The signal
// lands once that look has seen the group, not after a fixed delay, so the
// supervisor always has to wait for the group and the kill keeps the whole
// SIGKILL deadline a real dispatch gets, however late the supervisor runs.
if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_SLOW_GROUP_KILL) {
  let land = null;
  const kill = process.kill;
  process.kill = function heldGroupKill(pid, signal) {
    if (pid < 0 && signal === 'SIGKILL') {
      land = () => { try { kill.call(process, pid, signal); } catch { /* The group is gone. */ } };
      return true;
    }
    if (pid < 0 && signal === 0 && land) {
      setImmediate(land);
      land = null;
    }
    return kill.call(process, pid, signal);
  };
}
