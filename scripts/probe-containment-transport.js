'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../lib/containment');

// containment caches the manager probe per runtime, PATH and bus, and two cases can
// share that key, so each case loads it afresh and dials the manager itself.
const containment = require.resolve('../lib/containment');
function fresh() {
  delete require.cache[containment];
  return require(containment);
}

assert.equal(process.platform, 'linux', 'this host probe requires Linux with a user manager');
const uid = process.getuid();
const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
fs.mkdirSync(cache, { recursive: true });
const custom = fs.mkdtempSync(path.join(cache, 't423-transport-'));
fs.symlinkSync(path.join(runtime, 'systemd'), path.join(custom, 'systemd'), 'dir');
const read = fs.readFileSync;
console.log(`inherited: XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR ?? '<unset>'}, DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS ?? '<unset>'}`);
try {
  // Gate probes inherit a delegated scope. Force the manager branch while keeping
  // the real client and socket, so delegation cannot hide a broken transport.
  fs.readFileSync = (file, ...args) => {
    if (file === '/proc/self/cgroup') return `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/t423-probe.scope\n`;
    if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('synthetic placement'), { code: 'ENOENT' });
    return read(file, ...args);
  };
  for (const [name, dir, bus] of [
    ['runtime unset, stale bus', undefined, 'unix:path=/nonexistent/t423-stale-bus'],
    ['runtime empty, stale bus', '', 'unix:path=/nonexistent/t423-stale-bus'],
    ['runtime present, no session bus', runtime, undefined],
    ['custom runtime, stale bus', custom, 'unix:path=/nonexistent/t423-stale-bus'],
  ]) {
    const F = fresh();
    const env = { ...process.env, [C.MARK]: '', XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: bus };
    assert.equal(F.canScope(env), true, `${name}: real user manager must retain kernel scopes`);
    const plan = F.launchPlan(process.execPath, ['-e', ''], {
      env, resources: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 },
    });
    assert.equal(plan.kernel, true, name);
    assert.equal(plan.argv[0], 'systemd-run', name);
    console.log(`${name}: canScope=true, systemd-run scope planned`);
  }
} finally {
  fs.readFileSync = read;
  fs.rmSync(custom, { recursive: true, force: true });
}
assert.equal(C.canScope(), true, 'host caller must support a real or delegated scope');
console.log('host caller: canScope=true');
