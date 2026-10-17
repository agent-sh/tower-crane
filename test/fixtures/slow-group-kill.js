'use strict';

const path = require('node:path');

// A group whose last member takes a moment to die after SIGKILL (a core dump,
// an uninterruptible read): the supervisor's group SIGKILL lands this many ms late.
const delay = Number(process.env.TOWER_CRANE_TEST_SLOW_GROUP_KILL);
if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && delay > 0) {
  const kill = process.kill;
  process.kill = function delayedGroupKill(pid, signal) {
    if (pid < 0 && signal === 'SIGKILL') {
      setTimeout(() => { try { kill.call(process, pid, signal); } catch { /* The group is gone. */ } }, delay); // wait-allow: the late SIGKILL this fixture stands for
      return true;
    }
    return kill.call(process, pid, signal);
  };
}
