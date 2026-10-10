'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Signal when the supervisor's tool writer encounters the held lock.
if (process.argv[2] === 'hook' && process.argv[3] === 'tool') {
  const rename = fs.renameSync;
  let signalled = false;
  fs.renameSync = function toolWriter(from, to, ...args) {
    try {
      return rename.call(this, from, to, ...args);
    } catch (error) {
      if (!signalled && path.resolve(to) === process.env.TOWER_CRANE_TEST_HOOK_LOCK) {
        signalled = true;
        fs.writeFileSync(process.env.TOWER_CRANE_TEST_HOOK_READY, String(process.pid));
      }
      throw error;
    }
  };
}
