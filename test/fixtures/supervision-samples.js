'use strict';

const path = require('node:path');
const fs = require('node:fs');

if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_SAMPLES) {
  const append = fs.appendFileSync;
  const note = (kind, detail = {}) => append(process.env.TOWER_CRANE_TEST_SAMPLES, JSON.stringify({ kind, at: Date.now(), ...detail }) + '\n');
  const processes = require(path.join(path.dirname(process.argv[1]), 'processes.js'));
  const cpu = processes.cpuTicks;
  processes.cpuTicks = function sampledCpu(pid) {
    const ticks = cpu(pid);
    note('cpu', { ticks });
    return ticks;
  };
  const read = fs.readFileSync;
  const open = fs.openSync;
  // A reader between a commit's event append and its renames reads the
  // staged tasks.json.<event id>.commit in place of tasks.json. The task
  // view opens tasks.json and reads it into a buffer it keeps.
  const state = (file) => typeof file === 'string' && /^tasks\.json(\.E[0-9a-f-]{36}\.commit)?$/.test(path.basename(file));
  fs.readFileSync = function sampledRead(file, ...args) {
    if (state(file)) note('state');
    return read.call(this, file, ...args);
  };
  fs.openSync = function sampledOpen(file, ...args) {
    if (state(file)) note('state');
    return open.call(this, file, ...args);
  };
  const stat = fs.lstatSync;
  fs.lstatSync = function sampledPath(file, ...args) {
    if (path.basename(file) === 'progress.txt') note('path');
    return stat.call(this, file, ...args);
  };
}
