'use strict';

// The real CLI takes the macOS watchdog path while its finite agent runs unchanged.
Object.defineProperty(process, 'platform', { value: 'darwin' });
const cp = require('node:child_process');
const execFile = cp.execFile;
let calls = 0;
cp.execFile = function (file, args, opts, done) {
  if (file === 'ps' && args[0] === '-axo') {
    calls++;
    if (process.env.TC_SAMPLE_MODE === 'slow' && calls === 2) {
      return execFile.call(this, process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], opts, done); // wait-allow: the snapshot fixture exceeds the watchdog's two-second deadline
    }
    if (process.env.TC_SAMPLE_MODE === 'always' || (process.env.TC_SAMPLE_MODE !== 'slow' && calls === 2)) {
      return process.nextTick(done, Object.assign(new Error('sample timed out'), { code: 'ETIMEDOUT' }));
    }
  }
  return execFile.call(this, file, args, opts, done);
};
