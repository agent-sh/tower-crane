'use strict';

// Contained launches the CLI plans as on a host with a user manager
// (containment-manager.js answers systemctl), without registering a unit:
// each launch of the containment runner records its limits, CPU weight and
// target slice in TC_FAKE_SCOPE_LOG, then runs the command as the runner does
// once its scope is ready.
require('./containment-manager');
const fs = require('node:fs');
const cp = require('node:child_process');

// TC_FAKE_NO_MANAGER: the user manager does not answer, so launches use the watchdog.
const spawnSync = cp.spawnSync;
cp.spawnSync = (file, args, opts) => (process.env.TC_FAKE_NO_MANAGER && file === 'systemctl'
  ? { status: 1, stdout: '', stderr: 'no user manager' } : spawnSync(file, args, opts));
const spawn = cp.spawn;
cp.spawn = (file, args = [], opts = {}) => {
  if (!String(args[0] || '').endsWith('containment-runner.js')) return spawn(file, args, opts);
  const [, settings, target, unit, command, ...rest] = args;
  fs.appendFileSync(process.env.TC_FAKE_SCOPE_LOG, JSON.stringify({ settings: JSON.parse(settings), target, unit }) + '\n');
  const slice = target.startsWith('@') ? target.slice(1).split(':')[1] : 'nested';
  // A group the launcher accepts as this unit's scope; it has no cgroup files, so its counters read zero.
  fs.writeFileSync(opts.env.TOWER_CRANE_CONTAINMENT_REPORT, JSON.stringify({ unit, group: `/sys/fs/cgroup/fake/${slice}/${unit}` }));
  const env = { ...opts.env, TOWER_CRANE_SCOPED: '1', NODE_OPTIONS: opts.env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS };
  delete env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_REPORT;
  return spawn(command, rest, { ...opts, env });
};
