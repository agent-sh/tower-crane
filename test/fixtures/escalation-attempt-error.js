'use strict';

const fs = require('node:fs');

// The first attempt creates the file; Windows sharing errors affect replacement.
if (process.env.TOWER_CRANE_AGENT === 'worker-T1-2') {
  const rename = fs.renameSync;
  const file = process.env.HOOK_ESCALATION_ATTEMPTS;
  const errors = process.env.HOOK_ESCALATION_ATTEMPT_ERROR === 'EPERM'
    ? ['EPERM', 'EACCES', 'EBUSY'] : [process.env.HOOK_ESCALATION_ATTEMPT_ERROR];
  fs.renameSync = function attemptPublication(from, to) {
    if (to === file && errors.length) {
      const code = errors.shift();
      fs.appendFileSync(file + '.errors', code + '\n');
      throw Object.assign(new Error(`${code}: attempt publication '${from}' -> '${to}'`), { code });
    }
    return rename.call(this, from, to);
  };
}
