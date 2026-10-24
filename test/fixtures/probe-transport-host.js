'use strict';

// Runs scripts/probe-containment-transport.js against a fake private manager:
// the caller sits under user@UID.service and the default /run/user/UID runtime
// resolves to TOWER_CRANE_TEST_PEER_RUNTIME, so real systemctl dials the peer.
// Each systemctl call prints a dial line before the probe's case line, so the
// test can tell which case reached the manager.
const cp = require('node:child_process');
const fs = require('node:fs');

const uid = process.getuid();
const peer = process.env.TOWER_CRANE_TEST_PEER_RUNTIME;
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.existsSync = file => file === '/sys/fs/cgroup/cgroup.controllers' || exists(file);
fs.readFileSync = (file, ...args) => {
  if (file === '/proc/self/cgroup') return `0::/user.slice/user-${uid}.slice/user@${uid}.service/test-fence.slice/session.scope\n`;
  if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return read(file, ...args);
};
const spawnSync = cp.spawnSync;
cp.spawnSync = (file, args, opts) => {
  if (opts?.env?.XDG_RUNTIME_DIR === `/run/user/${uid}`) opts = { ...opts, env: { ...opts.env, XDG_RUNTIME_DIR: peer } };
  if (file === 'systemctl') console.log(`dial: XDG_RUNTIME_DIR=${opts.env.XDG_RUNTIME_DIR}, DBUS_SESSION_BUS_ADDRESS=${opts.env.DBUS_SESSION_BUS_ADDRESS ?? '<unset>'}`);
  return spawnSync(file, args, opts);
};
