'use strict';

const fs = require('node:fs');
const path = require('node:path');

if (process.argv.includes('wait') && process.env.TOWER_CRANE_TEST_RECOVERY_LOCK) {
  const rename = fs.renameSync;
  let acquisitions = 0;
  fs.renameSync = function timeoutRecovery(from, to) {
    if (to === path.join(process.env.HOOK_STATE, 'lock') && ++acquisitions === 2) {
      fs.writeFileSync(process.env.TOWER_CRANE_TEST_RECOVERY_LOCK, 'recovery lock timeout');
      throw Object.assign(new Error('state lock timeout'), { code: 3 });
    }
    return rename.call(this, from, to);
  };
}
