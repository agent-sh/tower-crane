'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_TREE_STOP) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const run = cp.spawnSync;
  cp.spawnSync = function observedTreeStop(file, args, options) {
    const script = file === 'powershell.exe' ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : '';
    if (!script.includes('$t = Expand $t')) return run.call(this, file, args, options);
    fs.appendFileSync(process.env.TOWER_CRANE_TEST_TREE_STOP, /^\$t = @\(.*\)$/m.exec(script)[0] + '\n');
    return { status: 0, stdout: '', stderr: '' };
  };
  const exec = cp.execFile;
  cp.execFile = function snapshot(file, args, options, callback) {
    if (file !== 'powershell.exe') return exec.call(this, file, args, options, callback);
    process.nextTick(callback, null, `${process.pid} ${process.ppid} ${Date.now()} 0 bm9kZQ==\n`, '');
  };
}
