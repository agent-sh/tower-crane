'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_TASKKILL) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const snapshot = `${process.pid} ${process.ppid} ${Date.now()} 0 bm9kZQ==\n`;
  const run = cp.spawnSync;
  cp.spawnSync = function observedTreeStop(file, args, options) {
    if (file !== 'taskkill') return run.call(this, file, args, options);
    fs.appendFileSync(process.env.TOWER_CRANE_TEST_TASKKILL, JSON.stringify(args) + '\n');
    return { status: 128, stdout: '', stderr: 'process already exited' };
  };
  const exec = cp.execFile;
  cp.execFile = function oneShot(file, args, options, callback) {
    if (file !== 'powershell.exe') return exec.call(this, file, args, options, callback);
    process.nextTick(callback, null, snapshot, '');
  };
  const spawn = cp.spawn;
  cp.spawn = function sampler(file, args, options) {
    if (file !== 'powershell.exe') return spawn.call(this, file, args, options);
    // Containment requests framed snapshots over stdin; one-shot process
    // queries above retain their own transport.
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on('data', () => process.nextTick(() => {
      if (!child.killed) child.stdout.write(snapshot + 'TC_SNAPSHOT_END\n');
    }));
    child.kill = () => {
      if (child.killed) return false;
      child.killed = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.emit('exit', 0, null);
      return true;
    };
    return child;
  };
}
