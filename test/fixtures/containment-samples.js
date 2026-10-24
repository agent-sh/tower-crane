'use strict';

// The real CLI takes the macOS watchdog path while its finite agent runs unchanged.
Object.defineProperty(process, 'platform', { value: 'darwin' });
const cp = require('node:child_process');
const execFile = cp.execFile;
const spawn = cp.spawn;
let calls = 0;
let sampling = false;
cp.spawn = function (file, args, opts) {
  const child = spawn.call(this, file, args, opts);
  // Identity lookup runs before launch; inject failures only once the finite agent starts.
  if (args?.includes('setTimeout(() => {}, 3000)')) sampling = true; // wait-allow: match the finite agent's timer command before injecting sampling failures
  return child;
};
cp.execFile = function (file, args, opts, done) {
  if (sampling && file === 'ps' && args[0] === '-axo' && args[1].startsWith('pid=,ppid=')) {
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
