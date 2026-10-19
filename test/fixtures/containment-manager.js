'use strict';

// A user manager the supervisor can reach: every systemctl call is logged and
// answered here, and the caller sits in a plain session scope of agents.slice.
const fs = require('node:fs');
const cp = require('node:child_process');
const log = process.env.TC_FAKE_MANAGER_LOG;
const record = (args) => fs.appendFileSync(log, JSON.stringify(args) + '\n');
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => file === '/proc/self/cgroup'
  ? '0::/user.slice/user-1000.slice/user@1000.service/agents.slice/session.scope\n'
  : readFileSync(file, ...args);
const existsSync = fs.existsSync;
fs.existsSync = (file) => file === '/sys/fs/cgroup/cgroup.controllers' || existsSync(file);
const spawnSync = cp.spawnSync;
cp.spawnSync = (file, args, opts) => {
  if (file !== 'systemctl') return spawnSync(file, args, opts);
  record(args);
  return { status: 0, stdout: args.includes('list-units') ? process.env.TC_FAKE_FAILED_UNITS || '' : '', stderr: '' };
};
cp.execFile = (file, args, opts, callback) => {
  record(args);
  // The scope settles as failed, as an OOM leaves it.
  process.nextTick(callback, null, args.includes('show') ? 'failed\n' : '', '');
};
