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

test('the host transport probe passes on a private peer and fails without one', {
  skip: process.platform !== 'linux',
}, async t => {
  const peer = await start(t);
  const missing = fs.mkdtempSync(path.join(path.dirname(peer.root), 't423-missing-'));
  t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  const script = path.join(__dirname, '..', 'scripts', 'probe-containment-transport.js');
  const hook = path.join(__dirname, 'fixtures', 'probe-transport-host.js');
  // The peer answers on this process's event loop, so the probe runs asynchronously.
  const run = runtime => G.treeExec(process.execPath, ['--require', hook, script], {
    env: { ...process.env, [C.MARK]: '', XDG_RUNTIME_DIR: runtime, TOWER_CRANE_TEST_PEER_RUNTIME: runtime }, timeout: 30000,
  });
  const ok = await run(peer.root);
  assert.equal(ok.status, 0, ok.stderr);
  for (const name of ['runtime unset, stale bus', 'runtime empty, stale bus', 'runtime present, no session bus', 'custom runtime, stale bus']) {
    assert.match(ok.stdout, new RegExp(`${name}: canScope=true, systemd-run scope planned`));
  }
  assert.ok(peer.calls.length >= 4, `${ok.stdout}${JSON.stringify(peer.calls)}`);
  assert.ok(peer.calls.every(call => call.member === 'Get' || call.member === 'GetEnvironment'), JSON.stringify(peer.calls));
  const failed = await run(missing);
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.match(failed.stderr, /runtime unset, stale bus: real user manager must retain kernel scopes/);
});

test('every systemctl call of a launch and its cleanup dials the probe runtime', {
  skip: process.platform !== 'linux',
}, async t => {
  const h = cachedFixture(t, 'manager-calls', h => h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]));
  const manager = path.join(__dirname, 'fixtures', 'containment-manager.js');
  const bin = path.join(h.base, 'killed-systemd-run');
  fs.mkdirSync(bin, { recursive: true });
  // The scope dies before its runner reports, so the launch reads Result, kills the unit and settles it.
  fs.writeFileSync(path.join(bin, 'systemd-run'), '#!/bin/sh\nexit 137\n', { mode: 0o755 });
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  const failed = `tower-crane-${dead}-0123456789abcdef.scope`;
  const script = `
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
const child = C.spawn(process.execPath, ['-e', ''], { resources: { tasks_max: 64, memory_max_bytes: ${512 * 1024 ** 2} }, stdio: 'ignore' });
child.on('close', () => child.containmentDone.then(() => console.log(JSON.stringify({ unit: child.containment.unit, reason: child.resourceReason }))));`;
  for (const [name, runtime, expected] of [
    ['runtime unset', undefined, `/run/user/${process.getuid()}`],
    ['runtime empty', '', `/run/user/${process.getuid()}`],
    ['custom runtime', path.join(h.base, 'custom-runtime'), path.join(h.base, 'custom-runtime')],
  ]) {
    const log = path.join(h.base, `${name}.jsonl`);
    const runtimes = path.join(h.base, `${name}-runtime.jsonl`);
    const env = { ...h.env, PATH: bin, XDG_CACHE_HOME: path.join(h.base, `${name}-cache`), TC_FAKE_MANAGER_LOG: log,
      TC_FAKE_MANAGER_RUNTIME_LOG: runtimes, TC_FAKE_FAILED_UNITS: `${failed} loaded failed failed\n`,
      TOWER_CRANE_TEST_CONTAINMENT: '1', [C.MARK]: '' };
    delete env.DBUS_SESSION_BUS_ADDRESS;
    if (runtime === undefined) delete env.XDG_RUNTIME_DIR;
    else env.XDG_RUNTIME_DIR = runtime;
    const result = await G.treeExec(process.execPath, ['--require', manager, '-e', script], { env, timeout: 30000 });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const { unit, reason } = JSON.parse(result.stdout);
    assert.equal(reason, 'resource-scope-failed', name);
    const calls = fs.readFileSync(runtimes, 'utf8').trim().split('\n').map(JSON.parse);
    const seen = calls.map(call => call.args.join(' '));
    for (const call of [
      '--user show-environment',
      '--user list-units --all --state=failed --plain --no-legend tower-crane-*.scope',
      `--user reset-failed ${failed}`,
      `--user show ${unit} -p Result --value`,
      `--user kill --kill-whom=all --signal=SIGKILL ${unit}`,
      `--user show ${unit} -p ActiveState --value`,
      `--user reset-failed ${unit}`,
    ]) assert.ok(seen.includes(call), `${name}: ${call} in ${JSON.stringify(seen)}`);
    assert.deepEqual(calls.filter(call => call.runtime !== expected), [], name);
  }
});

test('a keeper reads Result and settles its scope through its launch runtime', {
  skip: process.platform !== 'linux',
}, async t => {
  const unit = 'tower-crane-1-0123456789abcdef.scope';
  const exitCode = process.exitCode;
  const saved = process.env.XDG_RUNTIME_DIR;
  t.after(() => {
    process.exitCode = exitCode;
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  });
  const spawnSync = cp.spawnSync;
  for (const [name, inherited, launch, expected] of [
    ['both unset', undefined, undefined, `/run/user/${process.getuid()}`],
    ['inherited empty', '', undefined, `/run/user/${process.getuid()}`],
    ['launch runtime differs', '/keeper/inherited', '/launch/runtime', '/launch/runtime'],
    ['launch runtime only', undefined, '/launch/runtime', '/launch/runtime'],
  ]) {
    if (inherited === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = inherited;
    const calls = [];
    t.mock.method(cp, 'spawnSync', (file, args, opts) => {
      if (file !== 'systemctl') return spawnSync(file, args, opts);
      calls.push({ args, runtime: opts.env?.XDG_RUNTIME_DIR ?? null });
      return { status: 0, stdout: 'oom-kill\n', stderr: '' };
    });
    const reset = new Promise(resolve => t.mock.method(cp, 'execFile', (file, args, opts, callback) => {
      calls.push({ args, runtime: opts.env?.XDG_RUNTIME_DIR ?? null });
      if (args[1] === 'reset-failed') return resolve();
      process.nextTick(callback, null, 'failed\n', '');
    }));
    await C.guardRemaining({ rows: [], group: path.join('/sys/fs/cgroup', 'missing', unit), unit, runtime: launch,
      limits: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 }, baseline: { tasks: 0, memory: 0 } });
    await reset;
    assert.deepEqual(calls.map(call => call.args[1]), ['show', 'show', 'reset-failed'], name);
    assert.deepEqual(calls.map(call => call.runtime), Array(3).fill(expected), name);
    t.mock.restoreAll();
  }
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
      if (file === 'systemd-run') return { status: 0, stdout: 'systemd 259\n' };
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
