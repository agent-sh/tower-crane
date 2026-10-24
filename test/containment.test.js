'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cachedFixture } = require('./helpers');
const { readPublished } = require('./atomic-file');
const { gateFixture } = require('./gate-helpers');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const HARNESS = path.join(__dirname, 'fixtures', 'containment-harness.js');
process.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
const memory = 512 * 1024 * 1024;
const systemd = C.canScope();

function diagnostics(result) {
  return result.stderr + (result.containment?.error || '');
}

function fixture(t) {
  const h = cachedFixture(t, 'containment', (h) => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(memory)]);
    h.ok(['task', 'add', '--title', 'Bound fake agent', '--acceptance', 'contained', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Finite fake harness.\n' });
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  return h;
}

test('resource settings are persisted, validated and operational', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.readState('project.json').resources, { tasks_max: 64, memory_max_bytes: memory });
  assert.match(h.ok(['project', 'show']), /resources: .*"tasks_max":64/);
  const before = h.readState('project.json');
  const refused = h.run(['project', 'set', '--tasks-max', '40', '--agent', 'worker']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /orchestrator or the owner/);
  assert.deepEqual(h.readState('project.json'), before);
  for (const v of ['0', '-1']) assert.equal(h.run(['project', 'set', '--tasks-max', v]).code, 2);
  h.ok(['project', 'set', '--tasks-max', '40', '--agent', 'orchestrator']);
  assert.equal(h.readState('project.json').resources.tasks_max, 40);
  assert.deepEqual(C.errors({ tasks_max: 0, memory_max_bytes: -1 }).length, 2);
});

test('defaults reserve half the effective slice capacity', () => {
  const d = C.defaults({ memory: 1024 ** 3, tasks: 200 });
  assert.ok(d.memory_max_bytes <= 512 * 1024 * 1024);
  assert.ok(d.tasks_max <= 100);
  assert.ok(d.tasks_max > 0);
});

test('default task cap covers measured test demand when the host budget allows it', () => {
  const slots = Math.max(1, Math.ceil(os.availableParallelism() / 4));
  const host = { tasks: 2 * slots * 2000, memory: 40 * 1024 ** 3 };
  const limits = C.defaults(host);
  assert.equal(limits.tasks_max, 2000);
  assert.ok(limits.tasks_max > 299, 'Chrome threads and test subprocesses need headroom above the measured 299-task peak');
  assert.equal(limits.memory_max_bytes, Math.floor(host.memory / (2 * slots)));
});

test('unlimited Linux PID budgets fall back to kernel limits, including pid_max', {
  skip: process.platform !== 'linux',
}, () => {
  const original = fs.readFileSync;
  const slots = Math.max(1, Math.ceil(os.availableParallelism() / 4));
  const budget = 2 * slots * 2000;
  try {
    for (const threads of [String(budget), 'max']) {
      fs.readFileSync = (file, ...args) => {
        if (file === '/proc/sys/kernel/threads-max') return threads;
        if (file === '/proc/sys/kernel/pid_max') return String(budget);
        if (file === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/user@1000.service/agents.slice/test.scope\n';
        if (String(file).startsWith('/sys/fs/cgroup/') && String(file).endsWith('/pids.max')) return 'max';
        return original(file, ...args);
      };
      assert.equal(C.capacity().tasks, budget);
      assert.equal(C.defaults({ memory, tasks: Infinity }).tasks_max, 2000);
    }
    fs.readFileSync = (file, ...args) => String(file).startsWith('/proc/sys/kernel/')
      ? 'max' : original(file, ...args);
    assert.throws(() => C.defaults({ memory, tasks: Infinity }), { code: 'resource-monitor-failed' });
    const caps = { tasks_max: 64, memory_max_bytes: memory };
    assert.deepEqual(C.resolveGate({ resources: caps }, { memory, tasks: Infinity }), caps);
  } finally { fs.readFileSync = original; }
});

test('gate defaults leave measured full-suite headroom and preserve explicit caps', async (t) => {
  const h = cachedFixture(t, 'gate-defaults', h => h.init(['--executors', '3']));
  const project = h.readState('project.json');
  assert.deepEqual(project.resources, {}, 'init must not persist agent defaults as gate overrides');
  const host = { tasks: 4000, memory: 14 * 1024 ** 3 };
  const limits = C.resolveGate(project, host);
  assert.equal(limits.tasks_max, 666);
  assert.equal(limits.memory_max_bytes, Math.floor(host.memory / 6));
  assert.ok(303 <= limits.tasks_max * 2 / 3, 'measured task peak needs at least one third headroom');
  assert.ok(1196244992 <= limits.memory_max_bytes * 2 / 3, 'measured memory peak needs at least one third headroom');
  assert.equal(C.resolveGate({}, host).tasks_max, 1000, 'two executors by default');
  const explicit = { tasks_max: 64, memory_max_bytes: memory };
  assert.deepEqual(C.resolveGate({ resources: explicit }, host), explicit);
  const calls = [];
  const ctx = { project, exec: async (cmd, args, opts) => {
    calls.push(opts.resources);
    return { status: 0, stdout: '', stderr: '' };
  } };
  await G.shell(ctx, 'suite command');
  await G.exec(ctx, process.execPath, [], { processTree: true });
  assert.deepEqual(calls, [C.resolveGate(project), C.resolveGate(project)]);
  assert.match(h.ok(['project', 'show']), /gate resources: /);
});

test('fan-out roles get caps sized for their fleet and explicit caps apply to every role', (t) => {
  const host = { tasks: 4000, memory: 14 * 1024 ** 3 };
  const project = { gates: { executors: 3 } };
  const agent = C.resolve(project, 'worker', host);
  const gate = C.resolveGate(project, host);
  const fleet = C.defaults(host, 1);
  assert.deepEqual(fleet, { tasks_max: 2000, memory_max_bytes: 7 * 1024 ** 3 });
  assert.ok(fleet.tasks_max > 261, 'a spawn fence with 3 workers peaked at 261 tasks');
  for (const [role, expected] of [
    ['worker', agent], ['small', agent], [undefined, agent], ['orchestrator', fleet],
    ['reviewer', { tasks_max: Math.min(fleet.tasks_max, agent.tasks_max + gate.tasks_max),
      memory_max_bytes: Math.min(fleet.memory_max_bytes, agent.memory_max_bytes + gate.memory_max_bytes) }],
  ]) assert.deepEqual(C.resolve(project, role, host), expected, role);
  // One executor's gate share is already the whole half.
  assert.deepEqual(C.resolve({ gates: { executors: 1 } }, 'reviewer', host), fleet);
  const explicit = { tasks_max: 64, memory_max_bytes: memory };
  for (const role of ['worker', 'reviewer', 'orchestrator']) assert.deepEqual(C.resolve({ resources: explicit }, role, host), explicit);
  assert.deepEqual(C.resolve({ resources: { tasks_max: 64 } }, 'orchestrator', host), { ...fleet, tasks_max: 64 });
  const shown = h => h.ok(['project', 'show']);
  const h = fixture(t);
  assert.match(shown(h), /^reviewer resources: \{"tasks_max":64,/m);
  assert.match(shown(h), /^orchestrator resources: \{"tasks_max":64,/m);
});

test('reviewer spawns record the reviewer cap', async (t) => {
  const h = cachedFixture(t, 'reviewer-cap', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Reviewed fake agent', '--acceptance', 'contained', '--kind', 'docs']);
    h.ok(['claim', 'T1', '--agent', 'builder']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
    // Review selection picks a rung by diff size, so every candidate runs the finite command.
    for (const rung of ['review', 'easy', 'medium', 'hard']) {
      h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
        JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
    }
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  const result = h.run(['spawn', '--task', 'T1', '--role', 'review', '--wait']);
  assert.equal(result.code, 0, result.stderr);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const recorded = events.findLast((e) => e.detail?.role === 'reviewer' && e.detail.containment)?.detail.containment;
  assert.ok(recorded, result.stdout + result.stderr);
  // One agent share and one gate share, within the half both split.
  const host = C.capacity();
  const [agent, gate, fleet] = [C.defaults(host), C.resolveGate(h.readState('project.json'), host), C.defaults(host, 1)];
  const expected = Object.fromEntries(Object.keys(agent).map((key) => [key, Math.min(fleet[key], agent[key] + gate[key])]));
  assert.equal(recorded.tasks_max, expected.tasks_max);
  assert.equal(recorded.memory_max_bytes, expected.memory_max_bytes);
});

test('owner scope keys that containment replaces print a warning', (t) => {
  const h = fixture(t);
  assert.doesNotMatch(h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%"}']), /warning:/);
  assert.match(h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%","MemoryMax":"8G","TasksMax":"9"}']),
    /^warning: scope TasksMax, MemoryMax: containment replaces these on every real launch; set the caps with tower-crane project set --tasks-max N --memory-max-bytes N$/m);
  const rung = h.json(['ladder', 'set', 'easy', '--scope', '{"MemoryMax":"4G"}']);
  assert.deepEqual(rung.warnings, ['scope MemoryMax: containment replaces this on every real launch; set the caps with tower-crane project set --tasks-max N --memory-max-bytes N']);
  assert.doesNotMatch(h.ok(['ladder', 'set', 'easy', '--scope', '{}']), /warning:/);
});

test('nested attempt caps do not recursively shrink project defaults', () => {
  const slice = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice';
  const own = 'tower-crane-123-0123456789abcdef.scope';
  for (const [input, expected] of [
    [`${slice}/${own}/runner`, slice],
    [`${slice}/${own}/nested-${own}/runner`, slice],
    [`${slice}/external.scope/nested-${own}/runner`, `${slice}/external.scope`],
    [`${slice}/external.scope`, `${slice}/external.scope`],
  ]) assert.equal(C.budgetGroup(input), expected);
});

test('scope placement keeps the caller slice, including custom fences', () => {
  for (const [group, slice] of [
    ['/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice/session.scope', 'agents.slice'],
    ['/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/test-fence.slice/runner.scope/runner', 'test-fence.slice'],
  ]) assert.equal(C.callerSlice(group), slice);
  assert.throws(() => C.callerSlice('/sys/fs/cgroup/no-slice/runner'), /no systemd slice/);
});

function scopeHost(t, group) {
  const read = fs.readFileSync;
  const exists = fs.existsSync;
  t.mock.method(process, 'getuid', () => 1000);
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/cgroup') return `0::${group}\n`;
    if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return read(file, ...args);
  });
  t.mock.method(fs, 'existsSync', file => file === '/sys/fs/cgroup/cgroup.controllers' || exists(file));
}

test('scope probes ignore missing or stale session buses and use the resolved launch runtime', {
  skip: process.platform !== 'linux',
}, (t) => {
  scopeHost(t, '/user.slice/user-1000.slice/user@1000.service/agents.slice/session.scope');
  const cp = require('node:child_process');
  for (const [session, runtime, available] of [
    [undefined, '/run/user/1000', true],
    ['unix:path=/nonexistent', '/custom/runtime', true],
    ['unix:path=/nonexistent', '/custom/unavailable', false],
    [undefined, '/custom/run,time%dir', true],
    ['unix:path=/nonexistent', undefined, true],
    ['unix:path=/nonexistent', '', true],
  ]) {
    const file = require.resolve('../lib/containment');
    const cached = require.cache[file];
    delete require.cache[file];
    const F = require(file);
    require.cache[file] = cached;
    const env = { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: session };
    const calls = [];
    t.mock.method(cp, 'spawnSync', (file, args, opts) => {
      calls.push({ file, args, opts });
      if (file === 'systemd-run') return { status: 0, stdout: 'systemd 259 (259.5)\n' };
      return { status: file === 'systemctl' && available ? 0 : 1 };
    });
    assert.equal(F.canScope(env), available, JSON.stringify(env));
    // The systemd-run version is read only once the manager answers.
    assert.deepEqual(calls.slice(1).map(call => [call.file, ...call.args]), available ? [['systemd-run', '--version']] : []);
    assert.equal(calls[0].file, 'systemctl');
    assert.deepEqual(calls[0].args, ['--user', 'show-environment']);
    assert.equal(calls[0].opts.env.XDG_RUNTIME_DIR, runtime || '/run/user/1000');
    assert.equal(calls[0].opts.env.DBUS_SESSION_BUS_ADDRESS, session);
    assert.equal(env.XDG_RUNTIME_DIR, runtime);
    cp.spawnSync.mock.restore();
  }
});

test('new user scopes require the caller user manager or confirmed linger', {
  skip: process.platform !== 'linux',
}, (t) => {
  const cp = require('node:child_process');
  for (const [group, linger, status, expected] of [
    ['/user.slice/user-1000.slice/user@1000.service/agents.slice/session.scope', 'no', 0, true],
    ['/user.slice/user-1000.slice/session-2.scope', 'no', 0, false],
    ['/user.slice/user-1000.slice/session-2.scope', 'yes', 0, true],
    ['/system.slice/ci.service', 'no', 0, false],
    ['/system.slice/ci.service', 'yes', 0, true],
    ['/system.slice/ci.service', '', 1, false],
    ['/system.slice/ci.service', 'yes', 1, false],
    ['/user.slice/user-2000.slice/user@2000.service/agents.slice/session.scope', 'no', 0, false],
  ]) {
    scopeHost(t, group);
    const calls = [];
    t.mock.method(cp, 'spawnSync', (file, args, opts) => {
      calls.push({ file, args, opts });
      return file === 'loginctl' ? { status, stdout: `${linger}\n` } : { status: 0, stdout: 'systemd 259\n' };
    });
    const env = { TOWER_CRANE_TEST_CONTAINMENT: '1' };
    assert.equal(C.canScope(env), expected, `${group}: linger=${linger}, status=${status}`);
    if (!expected) assert.throws(() => C.spawn(process.execPath, ['-e', ''], {
      env, scope: { CPUQuota: '200%' }, resources: { tasks_max: 64, memory_max_bytes: memory },
    }), /configured outer scope requires.*logout-safe placement/);
    const login = calls.find(call => call.file === 'loginctl');
    if (group.includes('user@1000.service/')) assert.equal(login, undefined);
    else {
      assert.deepEqual(login.args, ['show-user', '1000', '-p', 'Linger', '--value']);
      assert.equal(login.opts.env, env);
    }
    t.mock.restoreAll();
  }
});

test('CLI launches use the watchdog before registration for unsafe placement or a missing private bus', {
  skip: process.platform !== 'linux',
}, (t) => {
  const manager = path.join(__dirname, 'fixtures', 'containment-manager.js');
  for (const reason of ['logout', 'private bus']) {
    const h = fixture(t);
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', 'console.log("survived launch")', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort']);
    h.env.NODE_OPTIONS += ` --require "${manager}"`;
    if (reason === 'logout') {
      h.env.TC_FAKE_CALLER_GROUP = '/user.slice/user-1000.slice/session-2.scope';
      h.env.TC_FAKE_LINGER = 'no';
    } else h.env.TC_FAKE_NO_BUS = '1';
    h.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent';
    h.env.TC_FAKE_MANAGER_LOG = path.join(h.base, 'placement.jsonl');
    h.env[C.MARK] = '';
    const result = h.run(['spawn', '--task', 'T1', '--wait']);
    const files = fs.readdirSync(path.join(h.state, 'logs')).map(name => fs.readFileSync(path.join(h.state, 'logs', name), 'utf8'));
    const output = result.stdout + result.stderr + files.join('\n');
    assert.equal(result.code, 0, output);
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const contained = events.find(e => e.detail?.containment)?.detail.containment;
    assert.equal(contained?.backend, 'watchdog', output);
    if (reason === 'logout') assert.match(output, /warning:.*outside user@.*linger.*logout.*watchdog/);
    assert.doesNotMatch(output, /resource-scope-failed/);
    assert.match(output, /survived launch/);
  }
});

test('a caller inside its own capped or delegated fence keeps attempts inside it', {
  skip: process.platform !== 'linux',
}, () => {
  const slice = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice';
  const original = { readFileSync: fs.readFileSync, accessSync: fs.accessSync };
  const cgroups = (here, files) => {
    fs.readFileSync = (file, ...args) => {
      if (file === '/proc/self/cgroup') return `0::${here.slice('/sys/fs/cgroup'.length)}\n`;
      if (Object.hasOwn(files, file)) return files[file];
      if (String(file).startsWith('/sys/fs/cgroup/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return original.readFileSync(file, ...args);
    };
    fs.accessSync = (file, ...args) => String(file).startsWith(slice) ? undefined : original.accessSync(file, ...args);
  };
  try {
    for (const [name, here, files, fence] of [
      // DefaultTasksMax caps every scope, so pids.max alone is no fence.
      ['terminal scope', `${slice}/app-terminal.scope`, { [`${slice}/app-terminal.scope/pids.max`]: '4915' }, undefined],
      ['capped slice only', `${slice}/session.scope`, { [`${slice}/memory.max`]: '42949672960' }, undefined],
      ['memory fence', `${slice}/fence.scope`, { [`${slice}/fence.scope/memory.max`]: '17179869184' }, `${slice}/fence.scope`],
      ['delegated fence', `${slice}/fence.scope/leaf`, { [`${slice}/fence.scope/cgroup.subtree_control`]: 'memory pids\n' }, `${slice}/fence.scope`],
      ['innermost fence', `${slice}/outer.scope/inner/leaf`, {
        [`${slice}/outer.scope/memory.max`]: '17179869184', [`${slice}/outer.scope/inner/memory.max`]: '1073741824',
      }, `${slice}/outer.scope/inner`],
    ]) {
      cgroups(here, files);
      assert.equal(C.fenceGroup(), fence, name);
    }
    // A delegated fence takes nested attempts; one without delegation runs them in place, never in a sibling scope.
    cgroups(`${slice}/fence.scope/leaf`, {
      [`${slice}/fence.scope/memory.max`]: '17179869184', [`${slice}/fence.scope/cgroup.subtree_control`]: 'memory pids\n',
    });
    assert.equal(C.canScope({}), true);
    cgroups(`${slice}/fence.scope`, { [`${slice}/fence.scope/memory.max`]: '17179869184' });
    assert.equal(C.canScope({}), false);
  } finally { Object.assign(fs, original); }
});

test('the sweep removes report directories and failed units of dead supervisors only', {
  // Only a cgroup launch sweeps; keepers are found through /proc.
  skip: process.platform !== 'linux' && 'systemd user units and /proc are Linux-only',
}, async (t) => {
  const h = fixture(t);
  const cache = path.join(h.base, 'sweep-cache');
  const dead = require('node:child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const unit = (pid) => `tower-crane-${pid}-0123456789abcdef.scope`;
  for (const name of [`tower-crane-containment-${dead}-a1`, `tower-crane-containment-${process.pid}-b2`, 'tower-crane-containment-c3', 'unrelated']) {
    fs.mkdirSync(path.join(cache, name), { recursive: true });
  }
  const cp = require('node:child_process');
  // A keeper of a dead supervisor's unit still has that unit's Result to read.
  const held = `tower-crane-${dead}-fedcba9876543210.scope`;
  const keeper = cp.spawn(process.execPath, ['-e', 'process.stdin.resume()', 'containment-keeper.js', JSON.stringify({ unit: held })],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => keeper.kill('SIGKILL'));
  await new Promise((resolve, reject) => { keeper.once('spawn', resolve); keeper.once('error', reject); });
  const original = cp.spawnSync;
  const calls = [];
  cp.spawnSync = (file, args, opts) => {
    if (file !== 'systemctl') return original(file, args, opts);
    calls.push(args);
    return { status: 0, stdout: `● ${unit(dead)} loaded failed failed ${unit(dead)}\n  ${unit(process.pid)} loaded failed failed\n  ${held} loaded failed failed\n`, stderr: '' };
  };
  try { C.sweep(cache, true); } finally { cp.spawnSync = original; }
  assert.deepEqual(fs.readdirSync(cache).sort(), [`tower-crane-containment-${process.pid}-b2`, 'tower-crane-containment-c3', 'unrelated']);
  assert.deepEqual(calls.at(-1), ['--user', 'reset-failed', unit(dead)]);
  calls.length = 0;
  C.sweep(path.join(h.base, 'missing-cache'), false);
  assert.deepEqual(calls, []);
});

test('a scope that settles failed is reset and a clean one is left alone', async () => {
  const cp = require('node:child_process');
  const original = cp.execFile;
  for (const [states, reset] of [[['deactivating', 'failed'], true], [['active', 'inactive'], false], [[''], false]]) {
    const calls = [];
    const done = new Promise((resolve) => {
      cp.execFile = (file, args, opts, callback) => {
        calls.push(args);
        if (args[1] === 'reset-failed') return resolve();
        const state = states.shift();
        process.nextTick(callback, null, `${state}\n`, '');
        if (!states.length && state !== 'failed') process.nextTick(resolve);
      };
    });
    try {
      C.settle('tower-crane-1-0123456789abcdef.scope');
      await done;
    } finally { cp.execFile = original; }
    assert.equal(calls.some((args) => args[1] === 'reset-failed'), reset, JSON.stringify(calls));
  }
});

test('a keeper reads its scope\'s Result before it resets the scope', { skip: process.platform !== 'linux' }, async (t) => {
  const cp = require('node:child_process');
  const unit = 'tower-crane-1-0123456789abcdef.scope';
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const spawnSync = cp.spawnSync;
  for (const [result, failed] of [['oom-kill', 1], ['success', exitCode]]) {
    const calls = [];
    t.mock.method(cp, 'spawnSync', (file, args, opts) => {
      if (file !== 'systemctl') return spawnSync(file, args, opts);
      calls.push(args);
      return { status: 0, stdout: `${result}\n`, stderr: '' };
    });
    const reset = new Promise((resolve) => t.mock.method(cp, 'execFile', (file, args, opts, callback) => {
      calls.push(args);
      if (args[1] === 'reset-failed') return resolve();
      process.nextTick(callback, null, 'failed\n', '');
    }));
    process.exitCode = exitCode;
    // The scope's cgroup is already gone, as after an OOM kill of every process in it.
    await C.guardRemaining({ rows: [], group: path.join('/sys/fs/cgroup', 'missing', unit), unit,
      limits: { tasks_max: 64, memory_max_bytes: memory }, baseline: { tasks: 0, memory: 0 } });
    // A keeper that never settles would leave the reset pending forever.
    if (calls.length > 1) await reset;
    assert.deepEqual(calls.map((args) => args.slice(1, 4)), [['show', unit, '-p'], ['show', unit, '-p'], ['reset-failed', unit]], result);
    assert.equal(calls[0][4], 'Result');
    assert.equal(process.exitCode, failed, result);
    cp.spawnSync.mock.restore();
    cp.execFile.mock.restore();
  }
});

test('launches reset their settled scope, and the next launch cleans up after a killed supervisor', {
  skip: process.platform !== 'linux' && 'Linux scope runner uses execve',
}, (t) => {
  const h = fixture(t);
  const manager = path.join(__dirname, 'fixtures', 'containment-manager.js');
  const cache = path.join(h.base, 'manager-cache');
  const log = path.join(h.base, 'manager.jsonl');
  const bin = path.join(h.base, 'no-systemd-run');
  fs.mkdirSync(bin);
  const script = (mode) => `
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
const child = C.spawn(process.execPath, ['-e', ''], { resources: { tasks_max: 64, memory_max_bytes: ${memory} } });
${mode === 'kill' ? "process.kill(process.pid, 'SIGKILL');" : "child.on('close', () => console.log(child.containment.unit));"}`;
  // Without systemd-run no real scope starts.
  const run = (mode, extra = {}) => require('node:child_process').spawnSync(process.execPath, ['--require', manager, '-e', script(mode)], {
    encoding: 'utf8', env: { ...h.env, PATH: bin, XDG_CACHE_HOME: cache, TC_FAKE_MANAGER_LOG: log, [C.MARK]: '', ...extra },
  });
  const killed = run('kill');
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const leaked = fs.readdirSync(cache).filter((name) => name.startsWith('tower-crane-containment-'));
  assert.deepEqual(leaked.map((name) => name.split('-')[3]), [String(killed.pid)]);
  const failedUnit = `tower-crane-${killed.pid}-0123456789abcdef.scope`;
  const next = run('wait', { TC_FAKE_FAILED_UNITS: `${failedUnit} loaded failed failed\n` });
  assert.equal(next.status, 0, next.stderr);
  const unit = next.stdout.trim();
  assert.match(unit, /^tower-crane-\d+-[a-f0-9]{16}\.scope$/);
  assert.deepEqual(fs.readdirSync(cache).filter((name) => name.startsWith('tower-crane-containment-')), []);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args.join(' ') === `--user reset-failed ${failedUnit}`), JSON.stringify(calls));
  assert.ok(calls.some((args) => args.join(' ') === `--user reset-failed ${unit}`), JSON.stringify(calls));
});

test('outer scope launches use supported OOM policy and retain caps', {
  skip: process.platform === 'win32' && 'scope runner uses execve',
}, async (t) => {
  const h = fixture(t);
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const runner = require.resolve('../lib/containment-runner');
  const unit = 'tower-crane-123-0123456789abcdef.scope';
  const limits = { tasks_max: 64, memory_max_bytes: memory };
  for (const configured of [false, true]) {
  for (const fleet of [false, true]) {
    const label = `${configured}-${fleet}`;
    const group = path.join(h.base, label, unit);
    fs.mkdirSync(group, { recursive: true });
    const log = path.join(h.base, `${label}.jsonl`);
    const report = path.join(h.base, `${label}-report.json`);
    const owner = configured ? { CPUQuota: '200%', MemoryMax: '1', TasksMax: '999', Slice: 'app.slice',
      OOMPolicy: 'stop', MemorySwapMax: '9G', Delegate: 'no' } : {};
    const result = await G.treeExec(process.execPath,
      [fake, ...C.scopeArguments(unit, 'test-fence.slice', limits, owner), process.execPath, runner,
        JSON.stringify({ ...limits, fleet }), '', unit, process.execPath, '-e',
        'console.log("scoped command ran", process.env.TOWER_CRANE_SCOPED)'], {
        env: { ...h.env, TC_FAKE_CGROUP: group, TC_FAKE_SYSTEMD_LOG: log,
          XDG_RUNTIME_DIR: path.join(h.base, 'runtime'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent',
          TOWER_CRANE_CONTAINMENT_REPORT: report },
      });
    const registration = fs.existsSync(report) ? JSON.parse(readPublished(report, 'utf8')) : {};
    assert.equal(result.status, 0, result.stderr + (registration.error || ''));
    assert.equal(result.stdout, 'scoped command ran 1\n');
    assert.equal(registration.group, group);
    assert.equal(registration.baseline, undefined);
    assert.equal(fs.readFileSync(path.join(group, 'memory.oom.group'), 'utf8'), fleet ? '0' : '1');
    const properties = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.equal(properties.OOMPolicy, 'continue');
    assert.equal(properties.TasksMax, String(limits.tasks_max));
    assert.equal(properties.MemoryMax, String(limits.memory_max_bytes));
    assert.equal(properties.MemorySwapMax, '0');
    assert.ok(['true', 'yes'].includes(properties.Delegate));
  }
  }
});

const scopeRuntimeCases = [
  ['runtime absent and bus stale', undefined, 'unix:path=/nonexistent/stale-bus'],
  ['runtime and bus absent', undefined, undefined],
  ['runtime empty and bus stale', '', 'unix:path=/nonexistent/stale-bus'],
  ['custom runtime and bus stale', '/custom/runtime', 'unix:path=/nonexistent/stale-bus'],
];

test('all outer scopes share the probe runtime directory and preserve the command environment', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const h = fixture(t);
  const cp = require('node:child_process');
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const unit = 'tower-crane-123-0123456789abcdef.scope';
  const limits = { tasks_max: 64, memory_max_bytes: memory };
  for (const [name, runtime, bus] of scopeRuntimeCases) {
  for (const configured of [false, true]) {
    for (const fleet of [false, true]) {
      const label = `${name}-${configured}-${fleet}`;
      const group = path.join(h.base, label, unit);
      fs.mkdirSync(group, { recursive: true });
      const report = path.join(h.base, `${label}-report.json`);
      const env = { ...h.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus,
        TC_FAKE_CGROUP: group, TC_FAKE_SYSTEMD_LOG: path.join(h.base, `${label}.jsonl`),
        TOWER_CRANE_CONTAINMENT_REPORT: report };
      const spawnSync = cp.spawnSync;
      scopeHost(t, '/user.slice/user-1000.slice/user@1000.service/test-fence.slice/session.scope');
      t.mock.method(cp, 'spawnSync', (file, args, opts) => {
        if (file !== 'systemctl') return spawnSync(file, args, opts);
        assert.deepEqual(args, ['--user', 'show-environment']);
        assert.equal(opts.env.XDG_RUNTIME_DIR, runtime || '/run/user/1000');
        return { status: 0 };
      });
      let plan;
      try {
        plan = C.launchPlan(process.execPath, ['-e', `console.log(JSON.stringify({
          scoped: process.env.TOWER_CRANE_SCOPED,
          runtime: process.env.XDG_RUNTIME_DIR ?? null,
          bus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null
        }))`], { env, resources: limits, scope: configured ? { CPUQuota: '200%' } : {}, fleet }, unit);
      } finally { t.mock.restoreAll(); }
      assert.equal(plan.argv[0], 'systemd-run', label);
      const result = await G.treeExec(process.execPath, [fake, ...plan.argv.slice(1)], {
        env: { ...env, ...plan.scopeEnv },
      });
      const registration = fs.existsSync(report) ? JSON.parse(readPublished(report, 'utf8')) : {};
      assert.equal(result.status, 0, `${label}: ${result.stderr}${registration.error || ''}`);
      assert.deepEqual(JSON.parse(result.stdout), { scoped: '1', runtime: runtime ?? null, bus: bus ?? null }, label);
      assert.equal(env.XDG_RUNTIME_DIR, runtime, 'planning does not mutate the caller environment');
      assert.equal(fs.readFileSync(path.join(group, 'memory.oom.group'), 'utf8'), fleet ? '0' : '1');
    }
  }
  }
});

test('outer scopes pass --expand-environment=no only where systemd-run has it and keep argv literal', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const h = fixture(t);
  const cp = require('node:child_process');
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const unit = 'tower-crane-123-0123456789abcdef.scope';
  const limits = { tasks_max: 64, memory_max_bytes: memory };
  for (const version of ['252', '253', '254', '259', 'none']) {
    for (const configured of [false, true]) {
      const label = `systemd ${version}${configured ? ' configured' : ''}`;
      const group = path.join(h.base, 'versions', label, unit);
      fs.mkdirSync(group, { recursive: true });
      const report = path.join(h.base, 'versions', `${label}.json`);
      const env = { ...h.env, XDG_RUNTIME_DIR: path.join(h.base, 'runtime'), TC_FAKE_CGROUP: group,
        TC_FAKE_SYSTEMD_LOG: path.join(h.base, 'versions', `${label}.jsonl`), TC_FAKE_SYSTEMD_VERSION: version,
        TOWER_CRANE_CONTAINMENT_REPORT: report };
      // The version is cached per PATH, so each row loads the module afresh.
      const file = require.resolve('../lib/containment');
      const cached = require.cache[file];
      delete require.cache[file];
      const F = require(file);
      require.cache[file] = cached;
      scopeHost(t, '/user.slice/user-1000.slice/user@1000.service/test-fence.slice/session.scope');
      t.mock.method(cp, 'spawnSync', (file, args) => {
        if (file === 'systemd-run') return version === 'none' ? { status: 1, stdout: '' } : { status: 0, stdout: `systemd ${version} (${version}-1)\n` };
        return { status: file === 'systemctl' ? 0 : 1 };
      });
      const plan = () => F.launchPlan(process.execPath, ['-e', 'console.log(process.argv[1])', '${HOME} $HOME'],
        { env, resources: limits, scope: configured ? { CPUQuota: '200%' } : {} }, unit);
      let planned;
      try {
        if (version === 'none' && configured) {
          assert.throws(plan, /resource-scope-failed: configured outer scope requires/, label);
          continue;
        }
        planned = plan();
      } finally { t.mock.restoreAll(); }
      if (version === 'none') {
        assert.equal(planned.kernel, false, label);
        assert.equal(planned.argv[0], process.execPath, label);
        continue;
      }
      assert.equal(planned.argv[0], 'systemd-run', label);
      assert.equal(planned.argv.includes('--expand-environment=no'), Number(version) >= 254, label);
      const result = await G.treeExec(process.execPath, [fake, ...planned.argv.slice(1)], { env: { ...env, ...planned.scopeEnv } });
      const registration = fs.existsSync(report) ? JSON.parse(readPublished(report, 'utf8')) : {};
      assert.equal(result.status, 0, `${label}: ${result.stderr}${registration.error || ''}`);
      assert.equal(result.stdout, '${HOME} $HOME\n', label);
    }
  }
});

test('CLI configured-scope dry runs show the private-socket runtime and preserve its original value', {
  skip: process.platform !== 'linux',
}, (t) => {
  const h = fixture(t);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
    '--clear', 'profile', '--clear', 'effort', '--scope', '{"CPUQuota":"200%"}']);
  const manager = path.join(__dirname, 'fixtures', 'containment-manager.js');
  for (const [name, runtime, bus] of scopeRuntimeCases) {
    const result = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: {
      NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require ${JSON.stringify(manager)}`,
      TC_FAKE_MANAGER_LOG: path.join(h.base, 'runtime-manager.log'),
      XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: bus,
    } });
    assert.equal(result.argv[0], 'systemd-run', name);
    assert.equal(result.env.XDG_RUNTIME_DIR, runtime || `/run/user/${process.getuid()}`, name);
    const runner = result.argv.findIndex(arg => arg.endsWith('containment-runner.js'));
    assert.equal(JSON.parse(result.argv[runner + 1]).xdg_runtime_dir, runtime ?? null, name);
  }
});

test('ordinary fixture launches preserve hooks and spawn options without containment', async () => {
  const h = fixture();
  const env = { ...h.env };
  delete env.TOWER_CRANE_TEST_CONTAINMENT;
  const child = C.spawn(process.execPath, ['-e', 'console.log("fixture")'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    resources: { tasks_max: 1, memory_max_bytes: 1 },
  });
  assert.equal(child.containment, undefined);
  const output = [];
  child.stdout.on('data', (data) => output.push(data));
  const status = await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  assert.equal(status, 0);
  assert.equal(Buffer.concat(output).toString(), 'fixture\n');
  await h.cleanup();
});

test('configured outer scopes refuse a missing manager before launching the command', async (t) => {
  const h = fixture(t);
  const launched = path.join(h.base, 'unexpected-launch');
  const fake = path.join(__dirname, 'fixtures', 'containment-systemd.js');
  const script = `
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
try {
  const child = C.spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'ran')`)}], {
    scope: { CPUQuota: '200%' }, resources: { tasks_max: 64, memory_max_bytes: ${memory} },
  });
  child.on('close', () => process.exitCode = 1);
} catch (error) {
  if (error.code !== 'resource-scope-failed') throw error;
  console.log(error.code);
}`;
  const result = await G.treeExec(process.execPath, ['--require', fake, '-e', script], {
    env: { ...h.env, TC_FAKE_NO_MANAGER: '1', [C.MARK]: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'resource-scope-failed\n');
  assert.equal(fs.existsSync(launched), false);
});

test('a scope at its memory cap is read every millisecond for a bounded window, so an OOM the kernel has not announced is found', async (t) => {
  const h = fixture(t);
  const group = path.join(h.base, 'cap-watch');
  fs.mkdirSync(group);
  fs.writeFileSync(path.join(group, 'cgroup.events'), 'populated 1\nfrozen 0\n');
  const events = (max, oom) => fs.writeFileSync(path.join(group, 'memory.events.local'),
    `low 0\nhigh 0\nmax ${max}\noom ${oom}\noom_kill ${oom}\noom_group_kill 0\n`);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // wait-allow: fixed windows of the cap watch under test
  for (const [name, max, after, expected] of [
    ['OOM inside the window', 3, 0, 'resource-memory-max'],
    ['below its cap', 0, 0, null],
    // The window ends, so a scope that stays at its cap does not keep the reads going.
    ['OOM after the window', 3, 60, null],
  ]) {
    events(0, 0);
    let notify;
    t.mock.method(fs, 'watch', (file, listener) => {
      notify = listener;
      return { on() {}, unref() {}, close() {} };
    });
    let found = null;
    const stop = C.watchOom(group, { tasks: 0, memory: 0 }, (reason) => { found = reason; });
    fs.watch.mock.restore();
    // The kernel announces the cap events, then holds the next notice for 10 ms.
    events(max, 0);
    notify();
    if (after) await pause(after);
    events(max, 1);
    await pause(60);
    stop();
    assert.equal(found, expected, name);
  }
});

test('local cgroup events distinguish a child cap from the parent cap', (t) => {
  const h = fixture(t);
  const group = path.join(h.base, 'cgroup-events');
  fs.mkdirSync(group);
  for (const [file, text] of [
    ['pids.events', 'max 1\n'], ['pids.events.local', 'max 0\n'],
    ['memory.events', 'oom_kill 1\n'], ['memory.events.local', 'oom 0\noom_group_kill 0\n'],
  ]) fs.writeFileSync(path.join(group, file), text);
  assert.equal(C.limitReason(group, { tasks: 0, memory: 0 }), null);
  fs.writeFileSync(path.join(group, 'memory.events.local'), 'oom 1\noom_group_kill 1\n');
  assert.equal(C.limitReason(group, { tasks: 0, memory: 0 }), 'resource-memory-max');
  fs.writeFileSync(path.join(group, 'pids.peak'), '299');
  fs.writeFileSync(path.join(group, 'memory.peak'), '955630223');
  assert.deepEqual(C.scopeMetrics(group), { pids_peak: 299, memory_peak_bytes: 955630223, refused_forks: 0 });
});

test('nested cap failures leave the parent running when local events are available', async () => {
  for (const [mode, reason] of [['nested-limit', 'resource-tasks-max'], ['nested-memory', 'resource-memory-max']]) {
    const localEvents = !systemd || fs.existsSync(path.join(C.currentGroup(),
      mode === 'nested-limit' ? 'pids.events.local' : 'memory.events.local'));
    // A watchdog parent sums the RSS of its whole tree: the storm's leaves that start before
    // the child's sampler stops them and, on Windows, that sampler's PowerShell.
    const result = await G.treeExec(process.execPath, [HARNESS, mode, 'unused'], {
      resources: { tasks_max: 128, memory_max_bytes: 4 * memory }, timeout: 10000, // wait-allow: finite nested cap probe deadline
    });
    if (!localEvents && result.resource_reason === reason) continue;
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.resource_reason, undefined, result.stderr);
    assert.ok(result.stdout.includes(`child: ${reason}\nparent-survived`), result.stdout + result.stderr);
  }
});

test('fake harness nested launches and detached grandchildren retain containment', async (t) => {
  const h = fixture(t);
  const file = path.join(h.base, 'nested.jsonl');
  let admittedPid;
  const result = await G.treeExec(process.execPath, [HARNESS, 'nested', file], {
    resources: { tasks_max: 64, memory_max_bytes: memory }, timeout: 10000,
    onSpawn: pid => { admittedPid = pid; },
  });
  assert.equal(result.status, 0, diagnostics(result));
  assert.equal(result.error, undefined, result.stderr);
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  assert.equal(admittedPid, records[0].pid, 'the governor must measure the actual harness process');
  if (result.containment.backend === 'cgroup') {
    const parent = C.currentGroup().split('/');
    const slice = parent.findLastIndex((name) => name.endsWith('.slice'));
    // A caller outside its user manager, as a hosted runner's system service is, has no slice
    // that manager can reach, so the scope takes the slice of the same name under the manager.
    const uid = process.getuid();
    const fence = parent.includes(`user@${uid}.service`) ? parent.slice(0, slice + 1).join('/') + '/'
      : `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/${parent[slice]}/`;
    assert.ok(result.containment.group.startsWith(fence), `${result.containment.group} is not under ${fence}`);
    assert.equal(records[0].inherited, result.containment.group);
    assert.ok(records[1].inherited.startsWith(records[0].inherited + path.sep));
    for (const record of records) assert.ok(record.group.startsWith(records[0].inherited + path.sep), JSON.stringify(record));
  } else assert.equal(result.containment.backend, 'watchdog');
});

test('Node preloads run once inside the launched command containment', async (t) => {
  const h = fixture(t);
  const preload = path.join(h.base, 'preload.js');
  const log = path.join(h.base, 'preload.jsonl');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
fs.appendFileSync(process.env.CONTAINMENT_PRELOAD_LOG, JSON.stringify({
  group: process.platform === 'linux' ? C.currentGroup() : null,
  inherited: process.env[C.MARK] || null,
  bootstrap: process.env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS || null,
}) + '\\n');
`);
  const result = await G.treeExec(process.execPath, ['-e', 'console.log("loaded")'], {
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, CONTAINMENT_PRELOAD_LOG: log },
    resources: { tasks_max: 64, memory_max_bytes: memory },
  });
  assert.equal(result.status, 0, diagnostics(result));
  const records = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].bootstrap, null);
  if (result.containment.backend === 'cgroup') {
    assert.equal(records[0].inherited, result.containment.group);
    assert.ok(records[0].group.startsWith(result.containment.group + path.sep));
  }
});

test('fast scoped commands preserve stdout-only diagnostics and registration', async () => {
  for (let n = 0; n < 3; n++) {
    const result = await G.treeExec(process.execPath, ['-e', 'console.log("useful diagnostic"); process.exitCode = 1'], {
      resources: { tasks_max: 64, memory_max_bytes: memory },
    });
    assert.equal(result.status, 1, diagnostics(result));
    assert.equal(result.resource_reason, undefined, diagnostics(result));
    assert.equal(result.stderr, '');
    assert.match(G.errText(result), /useful diagnostic/);
  }
});

test('lightweight gate helpers retain cancellation without a separate resource scope', async () => {
  const result = await G.exec({ signal: new AbortController().signal, project: { resources: { tasks_max: 64, memory_max_bytes: memory } } },
    process.execPath, ['-e', 'console.log("auxiliary")'], {});
  assert.equal(result.ok, true, result.stderr);
  assert.equal(result.containment, undefined);
});

test('finite nested fork storm fails the gate command and leaves another attempt running', async (t) => {
  // The sibling must outlive the storm's detection, which a Windows CIM snapshot can take
  // seconds to make; the test stops it at the end.
  const sibling = C.spawn(process.execPath, ['-e', 'console.log("untouched"); setTimeout(() => {}, 60000)'], { // wait-allow: finite isolation probe lifetime
    resources: { tasks_max: 64, memory_max_bytes: memory }, stdio: ['ignore', 'pipe', 'pipe'],
  }); // wait-allow: finite sibling lifetime tests isolation
  t.after(() => sibling.kill('SIGKILL'));
  await new Promise((accept, reject) => {
    sibling.stdout.once('data', accept);
    sibling.once('error', reject);
    sibling.once('exit', () => reject(new Error('sibling exited before starting')));
  });
  const result = await G.exec({ exec: G.treeExec, project: { resources: { tasks_max: systemd ? 32 : 4, memory_max_bytes: memory } } },
    process.execPath, [HARNESS, 'nested-storm', 'unused'], {
    resources: { tasks_max: systemd ? 32 : 4, memory_max_bytes: memory }, timeout: 10000, // wait-allow: finite resource probe deadline
  });
  assert.equal(result.resource_reason, 'resource-tasks-max', result.stderr);
  assert.equal(result.error?.code, 'resource-tasks-max');
  assert.equal(result.ok, false);
  assert.equal(sibling.exitCode, null);
  assert.equal(sibling.signalCode, null);
  assert.equal(sibling.resourceReason, undefined);
});

test('bounded memory growth fails with resource-memory-max', async () => {
  const result = await G.exec({ exec: G.treeExec, project: { resources: { tasks_max: 64, memory_max_bytes: 96 * 1024 * 1024 } } },
    process.execPath, [HARNESS, 'memory', 'unused'], {
    resources: { tasks_max: 64, memory_max_bytes: 96 * 1024 * 1024 }, timeout: 10000, // wait-allow: finite resource probe deadline
  });
  assert.equal(result.resource_reason, 'resource-memory-max', result.stderr);
  assert.equal(result.ok, false);
});

test('CLI spawn records cap failure in events and status', async (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--tasks-max', systemd ? '32' : '4']);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
    JSON.stringify([process.execPath, HARNESS, 'storm', 'unused', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.notEqual(result.code, 0);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const failed = events.findLast((e) => e.cmd === 'spawn phase' && e.detail.reason === 'resource-tasks-max');
  assert.ok(failed, result.stdout + result.stderr);
  assert.equal(failed.detail.phase, 'blocked');
  assert.equal(events.some((e) => e.cmd === 'spawn retry'), false);
  assert.match(h.ok(['status']), /resource-tasks-max/);
});

test('CLI cleanup records a capped gate command and names its failure', (t) => {
  const h = cachedFixture(t, 'contained-gate', (h) => {
    h.init(['--tasks-max', systemd ? '32' : '4', '--memory-max-bytes', String(memory)]);
    const sha = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Gate resource cap', '--acceptance', 'bounded']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    h.ok(['project', 'set', '--clean-cmd',
      [process.execPath, HARNESS, 'storm', 'unused'].map(G.shellQuote).join(' ')]);
  });
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  const result = h.run(['check', 'clean', 'T1', '--json'],
    { env: { TOWER_CRANE_CLEAN_CMD: '' } });
  assert.equal(result.code, 1, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.ok, false);
  assert.match(gate.summary, /resource-tasks-max/);
  assert.equal(gate.resource_reason, 'resource-tasks-max');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.detail.resource_reason === 'resource-tasks-max'));
  assert.match(h.ok(['inbox']), /resource-tasks-max/);
});
