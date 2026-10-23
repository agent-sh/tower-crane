'use strict';

// Contained launches the CLI plans as on a host with a user manager
// (containment-manager.js answers systemctl), without starting a unit: each
// systemd-run scope launch records its slice, CPU weight and the runner's
// settings in TC_FAKE_SCOPE_LOG, then runs the command as the runner does once
// its scope is ready.
require('./containment-manager');
const fs = require('node:fs');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

// TC_FAKE_NO_MANAGER: the user manager does not answer, so launches use the watchdog.
const spawnSync = cp.spawnSync;
cp.spawnSync = (file, args, opts) => (process.env.TC_FAKE_NO_MANAGER && file === 'systemctl'
  ? { status: 1, stdout: '', stderr: 'no user manager' } : spawnSync(file, args, opts));
const spawn = cp.spawn;
cp.spawn = (file, args = [], opts = {}) => {
  if (file !== 'systemd-run') return spawn(file, args, opts);
  const separator = args.indexOf('--');
  const scope = args.slice(0, separator);
  const slice = scope.find((arg) => arg.startsWith('--slice='))?.slice('--slice='.length);
  const at = scope.findIndex((arg, n) => arg === '-p' && scope[n + 1].startsWith('CPUWeight='));
  const [, , settings, target, unit, command, ...rest] = args.slice(separator + 1);
  fs.appendFileSync(process.env.TC_FAKE_SCOPE_LOG, JSON.stringify({ settings: JSON.parse(settings), target, unit, slice,
    cpu_weight: at < 0 ? undefined : Number(scope[at + 1].slice('CPUWeight='.length)) }) + '\n');
  // A group the launcher accepts as this unit's scope; it has no cgroup files, so its counters read zero.
  writeAtomic(opts.env.TOWER_CRANE_CONTAINMENT_REPORT, JSON.stringify({ unit, group: `/sys/fs/cgroup/fake/${slice}/${unit}` }));
  const env = { ...opts.env, TOWER_CRANE_SCOPED: '1', NODE_OPTIONS: opts.env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS };
  delete env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_REPORT;
  return spawn(command, rest, { ...opts, env });
};
