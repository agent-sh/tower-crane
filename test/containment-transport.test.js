'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const { cachedFixture, BIN } = require('./helpers');
const { start, fields } = require('./fixtures/systemd-peer');

test('peer header decoding exposes fixed fields and ignores foreign codes', () => {
  for (const type of ['s', 'u', 'g']) {
    const chunks = [];
    let size = 16;
    const append = b => { chunks.push(b); size += b.length; };
    const align = n => append(Buffer.alloc((n - size % n) % n));
    const uint = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); append(b); };
    const sig = s => append(Buffer.concat([Buffer.from([s.length]), Buffer.from(s), Buffer.from([0])]));
    const field = (code, type, value) => {
      align(8);
      append(Buffer.from([code]));
      sig(type);
      if (type === 'u') { align(4); uint(value); }
      else if (type === 's') { align(4); uint(Buffer.byteLength(value)); append(Buffer.from(value)); append(Buffer.from([0])); }
      else sig(value);
    };
    field(1, 's', '/org/freedesktop/systemd1');
    field(3, 's', 'Get');
    field(255, type, type === 'u' ? 99 : type === 'g' ? 's' : '__proto__');
    const headers = Buffer.concat(chunks);
    const fixed = Buffer.alloc(16);
    fixed[0] = 108;
    fixed[1] = 1;
    fixed[3] = 1;
    fixed.writeUInt32LE(7, 8);
    fixed.writeUInt32LE(headers.length, 12);
    assert.deepEqual(fields(Buffer.concat([fixed, headers])), {
      path: '/org/freedesktop/systemd1', interface: undefined, member: 'Get', destination: undefined, serial: 7,
    }, type);
  }
});

function freshContainment() {
  const file = require.resolve('../lib/containment');
  const cached = require.cache[file];
  delete require.cache[file];
  const fresh = require(file);
  require.cache[file] = cached;
  return fresh;
}

function host(t) {
  const read = fs.readFileSync;
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', file => file === '/sys/fs/cgroup/cgroup.controllers' || exists(file));
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/cgroup') return `0::/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/agents.slice/session.scope\n`;
    if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return read(file, ...args);
  });
}

test('a real CLI manager probe works on a private peer that rejects Hello', {
  skip: process.platform !== 'linux',
}, async t => {
  const h = cachedFixture(t, 'peer-transport', h => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
    h.ok(['task', 'add', '--title', 'Peer transport', '--acceptance', 'kernel containment', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Use the private manager.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  });
  const peer = await start(t);
  const preload = path.join(h.base, 'cgroup.js');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.existsSync = file => file === '/sys/fs/cgroup/cgroup.controllers' || exists(file);
fs.readFileSync = (file, ...args) => {
  if (file === '/proc/self/cgroup') return '0::/user.slice/user-' + process.getuid()
    + '.slice/user@' + process.getuid() + '.service/test-fence.slice/session.scope\\n';
  if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  return read(file, ...args);
};
`);
  for (const scope of ['{}', '{"CPUQuota":"200%"}']) {
    h.ok(['ladder', 'set', 'easy', '--scope', scope]);
    for (const bus of [undefined, 'unix:path=/nonexistent/stale-bus']) {
      const result = await G.treeExec(process.execPath,
        [BIN, 'spawn', '--task', 'T1', '--dry-run', '--state', h.state, '--agent', 'orchestrator', '--json'], {
          cwd: h.root, env: { ...h.env, NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require ${JSON.stringify(preload)}`,
            XDG_RUNTIME_DIR: peer.root, DBUS_SESSION_BUS_ADDRESS: bus, [C.MARK]: '' },
          timeout: 10000,
        });
      assert.equal(result.status, 0, result.stderr);
      const planned = JSON.parse(result.stdout);
      assert.equal(planned.containment.backend, 'cgroup', JSON.stringify({ calls: peer.calls, auth: peer.auth }));
      assert.equal(planned.argv[0], 'systemd-run');
      assert.equal(planned.env.XDG_RUNTIME_DIR, peer.root);
    }
  }
  assert.equal(peer.calls.length, 4);
  assert.ok(peer.calls.every(call => call.member === 'Get' || call.member === 'GetEnvironment'), JSON.stringify(peer.calls));
});

test('manager probe results are cached per process for success and failure', {
  skip: process.platform !== 'linux',
}, t => {
  host(t);
  for (const initial of [true, false]) {
    const F = freshContainment();
    let available = initial;
    const calls = [];
    t.mock.method(cp, 'spawnSync', (file, args, opts) => {
      calls.push({ file, args, opts });
      return { status: available ? 0 : 1 };
    });
    const env = { XDG_RUNTIME_DIR: '/cache-test/runtime', PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale' };
    assert.equal(F.canScope(env), initial);
    available = !initial;
    assert.equal(F.canScope({ ...env }), initial);
    assert.equal(F.canScope(env), initial);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'systemctl');
    assert.deepEqual(calls[0].args, ['--user', 'show-environment']);
    assert.equal(F.canScope({ ...env, XDG_RUNTIME_DIR: '/cache-test/other' }), !initial);
    assert.equal(calls.length, 2);
    assert.equal(F.canScope({ ...env, PATH: '/other/bin' }), !initial);
    assert.equal(calls.length, 3);
    assert.equal(F.canScope({ ...env, DBUS_SESSION_BUS_ADDRESS: undefined }), !initial);
    assert.equal(calls.length, 4);
    cp.spawnSync.mock.restore();
  }
});

test('outside caller warnings omit the fence key', { skip: process.platform !== 'linux' }, async t => {
  host(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/proc/self/cgroup'
    ? `0::/user.slice/user-${process.getuid()}.slice/session-2.scope\n` : read(file, ...args));
  const spawn = cp.spawnSync;
  t.mock.method(cp, 'spawnSync', (file, ...args) => file === 'loginctl'
    ? { status: 0, stdout: 'no\n' } : spawn(file, ...args));
  const child = C.spawn(process.execPath, ['-e', ''], {
    env: { ...process.env, [C.MARK]: '', TOWER_CRANE_TEST_CONTAINMENT: '1' },
    resources: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 }, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  await child.containmentDone;
  assert.equal(child.containment.backend, 'watchdog');
  assert.match(child.containment.warning, /logout/);
  assert.equal(Object.hasOwn(child.containment, 'fence'), false);
});
