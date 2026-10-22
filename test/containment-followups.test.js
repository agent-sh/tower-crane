'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { cachedFixture, BIN } = require('./helpers');
const { waitOnRepo } = require('./signals');
const { readPublished } = require('./atomic-file');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const StateFiles = require('./state-files');

test('scope warnings have the same JSON contract for init, project and ladder', t => {
  const h = cachedFixture(t, 'warning-json', h => h.init());
  const scope = '{"MemoryMax":"4G"}';
  const expected = ['scope MemoryMax: containment replaces this on every real launch; set the caps with tower-crane project set --tasks-max N --memory-max-bytes N'];
  for (const args of [
    ['project', 'set', '--scope', scope],
    ['ladder', 'set', 'easy', '--scope', scope],
    ['init', '--state', path.join(h.base, 'new-state'), '--name', 'new', '--goal', 'g', '--scope', scope],
  ]) assert.deepEqual(h.json(args).warnings, expected, args.join(' '));
});

test('periodic sweeps remove dead and aged legacy reports while keeping live supervisors', t => {
  const h = cachedFixture(t, 'periodic-sweep', h => h.init());
  const cache = path.join(h.base, 'reports');
  fs.mkdirSync(cache);
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  const stale = path.join(cache, 'tower-crane-containment-Ab12Cd');
  const recent = path.join(cache, 'tower-crane-containment-Ef34Gh');
  const live = path.join(cache, `tower-crane-containment-${process.pid}-Ij56Kl`);
  const other = path.join(cache, 'other');
  for (const dir of [stale, recent, live, other]) fs.mkdirSync(dir);
  const old = new Date(Date.now() - require('node:os').uptime() * 1000 - 60000);
  fs.utimesSync(stale, old, old);
  C.sweepDue(cache, false);
  assert.equal(fs.existsSync(stale), false);
  for (const dir of [recent, live, other]) assert.equal(fs.existsSync(dir), true);
  const later = path.join(cache, `tower-crane-containment-${dead}-Mn78Op`);
  fs.mkdirSync(later);
  C.sweepDue(cache, false);
  assert.equal(fs.existsSync(later), true, 'busy ticks do not sweep repeatedly');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + C.SWEEP_INTERVAL_MS + 1);
  C.sweepDue(cache, false);
  assert.equal(fs.existsSync(later), false, 'the same process sweeps again');
});

test('a non-delegated fence reports watchdog fallback and omitted owner properties', { skip: process.platform !== 'linux' }, async t => {
  const read = fs.readFileSync;
  const fence = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice/fence.scope';
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === '/proc/self/cgroup') return `0::${fence.slice('/sys/fs/cgroup'.length)}\n`;
    if (file === path.join(fence, 'memory.max')) return '1073741824';
    if (file === path.join(fence, 'cgroup.subtree_control')) return '';
    return read(file, ...args);
  });
  const child = C.spawn(process.execPath, ['-e', ''], {
    env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
    scope: { CPUQuota: '200%' }, stdio: 'ignore',
    resources: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 },
  });
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(child.containment.fence, fence);
  assert.match(child.containment.warning, /owner.*scope properties were not applied/);
});

test('CLI spawn records its fence fallback and prints the omitted scope warning', { skip: process.platform !== 'linux' }, t => {
  const h = cachedFixture(t, 'fence-spawn', h => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
    h.ok(['task', 'add', '--title', 'Fence fallback', '--acceptance', 'visible', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Show the fence.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--scope', '{"CPUQuota":"200%"}']);
  });
  const fence = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/agents.slice/fixture-fence.scope';
  const preload = path.join(h.base, 'fence.js');
  fs.writeFileSync(preload, `
const fs=require('node:fs'),path=require('node:path');
const read=fs.readFileSync,stat=fs.statSync;
fs.readFileSync=(file,...args)=>{
 if(file==='/proc/self/cgroup')return ${JSON.stringify(`0::${fence.slice('/sys/fs/cgroup'.length)}\n`)};
 if(file===${JSON.stringify(path.join(fence, 'memory.max'))})return '1073741824';
 if(file===${JSON.stringify(path.join(fence, 'cgroup.subtree_control'))})return '';
 return read(file,...args);
};
fs.statSync=(file,...args)=>{
 if(path.basename(String(file))==='systemd-run')throw Object.assign(new Error('missing'),{code:'ENOENT'});
 return stat(file,...args);
};
`);
  const result = h.run(['spawn', '--task', 'T1', '--wait'], {
    env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, TOWER_CRANE_TEST_CONTAINMENT: '1' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stderr.includes(fence), result.stderr);
  assert.match(result.stderr, /owner.*scope properties were not applied/);
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const detail = events.find(e => e.cmd === 'spawn').detail.containment;
  assert.equal(detail.backend, 'watchdog');
  assert.equal(detail.fence, fence);
  assert.match(detail.warning, /scope properties were not applied/);
});

test('account home alone never disables containment outside a test worker', t => {
  const h = cachedFixture(t, 'account-containment', h => h.init());
  const result = cp.spawnSync(process.execPath, ['-e', `
    delete process.env.NODE_TEST_CONTEXT;
    const C = require(${JSON.stringify(require.resolve('../lib/containment'))});
    console.log(C.fixtureLaunch({ TC_ACCOUNT_HOME: 'ordinary-home' }));
  `], { env: { ...h.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'false\n');
});

test('a scoped runner killed before its report preserves timeout and abort errors', async t => {
  for (const mode of ['timeout', 'abort']) {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), containment: { backend: 'cgroup' } });
    t.mock.method(C, 'spawn', () => {
      setTimeout(() => { // wait-allow: reproduce cancellation before the runner publishes a report
        child.resourceReason = 'resource-scope-failed';
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
      }, 30); // wait-allow: reproduce cancellation before the runner publishes a report
      return child;
    });
    const controller = new AbortController();
    if (mode === 'abort') setTimeout(() => controller.abort(), 5); // wait-allow: finite cancellation probe
    const result = await G.treeExec('unused', [], {
      resources: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 },
      env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
      ...(mode === 'timeout' ? { timeout: 5, grace: 1 } : { signal: controller.signal }), // wait-allow: force cancellation before the fake report
    });
    assert.equal(result.error.code, mode === 'timeout' ? 'ETIMEDOUT' : 'ABORT_ERR');
    assert.equal(result.resource_reason, undefined);
    C.spawn.mock.restore();
  }
});

test('fleet and attempt scopes leave OOM handling to containment instead of systemd', () => {
  const limits = { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 };
  for (const fleet of [true, false]) {
    const args = C.scopeArguments('tower-crane-1-0123456789abcdef.scope', 'agents.slice', limits, { OOMPolicy: fleet ? 'kill' : 'stop' });
    assert.equal(args.filter(arg => arg.startsWith('OOMPolicy=')).at(-1), 'OOMPolicy=continue');
  }
});

test('fleet OOM events do not trigger a second kill of healthy descendants', t => {
  const h = cachedFixture(t, 'fleet-events', h => h.init());
  const group = path.join(h.base, 'fleet');
  fs.mkdirSync(group);
  fs.writeFileSync(path.join(group, 'cgroup.events'), 'populated 1\n');
  for (const [fleet, tasks, oom, expected] of [
    [false, 0, 1, 'resource-memory-max'], [true, 0, 1, null],
    [false, 1, 1, 'resource-memory-max'], [true, 1, 1, 'resource-tasks-max'],
    [false, 1, 0, 'resource-tasks-max'],
  ]) {
    fs.writeFileSync(path.join(group, 'memory.events.local'), `oom ${oom}\noom_group_kill 0\n`);
    fs.writeFileSync(path.join(group, 'pids.events.local'), `max ${tasks}\n`);
    assert.equal(C.limitReason(group, { tasks: 0, memory: 0 }, fleet), expected);
    let notify;
    t.mock.method(fs, 'watch', (file, listener) => {
      notify = listener;
      return { on() {}, unref() {}, close() {} };
    });
    let found = null;
    const stop = C.watchOom(group, { tasks: 0, memory: 0 }, reason => { found = reason; }, fleet);
    try {
      notify();
      assert.equal(found, expected, `watcher fleet=${fleet}, task events=${tasks}`);
    } finally {
      stop();
      fs.watch.mock.restore();
    }
  }
});

test('the governor retains the full scope through delayed registry attachment', { skip: process.platform !== 'linux' }, async t => {
  const Governor = require('../lib/governor');
  const S = require('../lib/state');
  const h = cachedFixture(t, 'scope-governor', h => h.init());
  const env = { ...h.env, XDG_CACHE_HOME: path.join(h.base, 'governor-cache') };
  const project = h.readState('project.json');
  const admitted = Governor.admit({ stateDir: h.state, env, agent: 'orchestrator' }, { kind: 'worker', task: 'T1', project });
  t.after(() => admitted.release());
  let tickAt = Date.now();
  for (const [busy, scope] of [
    [false, { backend: 'cgroup', group: '/sys/fs/cgroup/agents.slice/tower-crane-1-0123456789abcdef.scope' }],
    [true, { backend: 'cgroup', group: '/sys/fs/cgroup/agents.slice/tower-crane-2-0123456789abcdef.scope' }],
    [false, { backend: 'watchdog' }],
  ]) {
    const expected = scope.group?.slice('/sys/fs/cgroup'.length) || null;
    const lock = busy ? S.tryMarkedLock(Governor.registryLock(env), { keepLive: true }) : null;
    try { admitted.attach(process.pid, scope); }
    finally { if (lock) S.releaseMarkedLock(lock); }
    await waitOnRepo(h, () => Governor.read(env).units.find(u => u.id === admitted.id)?.cgroup === expected,
      'queued governor scope attachment', { signal: AbortSignal.timeout(10000) }); // wait-allow: finite bound for the governor retry timer
    const entry = Governor.read(env).units.find(u => u.id === admitted.id);
    assert.equal(entry.cgroup, expected, `registry busy: ${busy}, backend: ${scope.backend}`);
    assert.equal(entry.roots.filter(r => r.pid === process.pid).length, 1);
    if (expected) {
      const group = path.join(env.TOWER_CRANE_HOST_ROOT, 'sys/fs/cgroup', expected);
      fs.mkdirSync(path.join(group, 'runner'), { recursive: true });
      fs.writeFileSync(path.join(group, 'memory.current'), String(512 * 1024 ** 2));
      fs.writeFileSync(path.join(group, 'memory.stat'), `active_file ${32 * 1024 ** 2}\ninactive_file ${96 * 1024 ** 2}\n`);
      fs.writeFileSync(path.join(group, 'runner', 'memory.current'), String(1024 ** 2));
      tickAt += Governor.TICK_MS * 2;
      const clock = t.mock.method(Date, 'now', () => tickAt);
      try { Governor.tick(env, project); }
      finally { clock.mock.restore(); }
      const measured = Governor.read(env).units.find(u => u.id === admitted.id);
      assert.equal(measured.measured, 384 * 1024 ** 2, 'the full scope counts anonymous memory across child groups without page cache');
    }
  }
});

for (const failure of ['returned', 'thrown']) {
test(`wait follow retries an unchanged failed refill after its timer expires: ${failure}`, async t => {
  const { refillFixture } = require('./automation-helpers');
  const Automation = require('../lib/automation');
  const Spawn = require('../lib/spawn');
  const S = require('../lib/state');
  const { TowerCraneError } = require('../lib/util');
  const h = refillFixture(t);
  const ctx = { stateDir: h.state, env: h.env, agent: 'orchestrator', agentExplicit: true, flags: {}, pos: [] };
  const ready = require('../lib/inbox').dispatchable(S.loadState(h.state), true).map(task => task.id);
  assert.ok(ready.length > 1, 'multiple ready tasks keep separate refusal entries');
  const calls = [];
  t.mock.method(Spawn, 'spawn', async ctx => {
    calls.push(ctx.flags.task);
    if (failure === 'thrown') throw new TowerCraneError(1, 'temporarily refused');
    return { code: 1, text: 'temporarily refused' };
  });
  const attempt = {};
  await Automation.refillWorkers(ctx, attempt);
  assert.deepEqual(calls, ready);
  await Automation.refillWorkers(ctx, attempt);
  assert.deepEqual(calls, ready, 'unchanged task refusals are still cached');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 60001);
  await Automation.refillWorkers(ctx, attempt);
  assert.deepEqual(calls, [...ready, ...ready], 'each task can be repaired without a state event');
});
}

test('an idle CLI wait follower sweeps new leaks without another launch or event', { skip: process.platform !== 'linux' }, async t => {
  const h = cachedFixture(t, 'idle-sweep', h => h.init());
  const cache = path.join(h.base, 'cache');
  fs.mkdirSync(cache);
  const log = path.join(h.base, 'manager-log');
  const advance = path.join(h.base, 'advance');
  const preload = path.join(h.base, 'clock.js');
  fs.writeFileSync(preload, `
require(${JSON.stringify(path.join(__dirname, 'fixtures', 'containment-manager.js'))});
const fs = require('node:fs');
const now = Date.now;
Date.now = () => now() + (fs.existsSync(${JSON.stringify(advance)}) ? 60001 : 0);
const interval = global.setInterval;
global.setInterval = (fn, ms, ...args) => interval(fn, ms === 1000 ? 10 : ms, ...args);
`);
  const child = cp.spawn(process.execPath, ['--require', preload, BIN, 'wait', '--observe', '--follow', '--agent', 'orchestrator'], {
    cwd: h.repo, env: { ...h.env, XDG_CACHE_HOME: cache, TC_FAKE_MANAGER_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const output = [];
  child.stdout.on('data', data => output.push(data));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const deadline = AbortSignal.timeout(10000); // wait-allow: finite failure bound for an absent sweep
  await waitOnRepo(h, () => fs.existsSync(log) && readPublished(log, 'utf8').includes('list-units'), 'initial containment sweep', { signal: deadline });
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  const dir = path.join(cache, `tower-crane-containment-${dead}-dead`);
  fs.mkdirSync(dir);
  fs.writeFileSync(advance, '');
  await waitOnRepo(h, () => !fs.existsSync(dir), 'periodic containment sweep without an event', { signal: deadline });
  child.kill('SIGTERM');
  assert.equal(await closed, 0, stderr);
  assert.ok(Buffer.concat(output).toString().includes('"type":"ready"'));
});

test('CLI dry runs show the mandatory containment argv and scoped environment', { skip: process.platform !== 'linux' }, t => {
  const h = cachedFixture(t, 'containment-dry-run', h => {
    h.init();
    h.ok(['task', 'add', '--title', 'Dry containment', '--acceptance', 'real argv', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Print the actual launch.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  });
  const manager = path.join(__dirname, 'fixtures', 'containment-manager.js');
  const env = { NODE_OPTIONS: `--require ${JSON.stringify(manager)}`, TC_FAKE_MANAGER_LOG: path.join(h.base, 'manager') };
  for (const [scope, executable] of [['{}', process.execPath], ['{"CPUQuota":"200%"}', 'systemd-run']]) {
    h.ok(['ladder', 'set', 'easy', '--scope', scope]);
    const result = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.equal(result.argv[0], executable);
    assert.ok(result.argv.some(arg => arg.endsWith('containment-runner.js')));
    assert.equal(result.env.TOWER_CRANE_SCOPED, '1');
    assert.equal(result.containment.backend, 'cgroup');
    if (executable === 'systemd-run') {
      assert.ok(result.argv.includes('MemorySwapMax=0'));
      assert.ok(result.argv.includes('OOMPolicy=continue'));
    }
  }
});

test('macOS kill validation reads start times from one process snapshot', t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  let calls = 0;
  t.mock.method(cp, 'spawnSync', (file, args) => {
    assert.equal(file, 'ps');
    assert.deepEqual(args, ['-axo', 'pid=,lstart=']);
    calls++;
    return { status: 0, stdout: '99999991 Mon Oct 19 13:00:00 2026\n99999992 Mon Oct 19 13:00:01 2026\n' };
  });
  C.stopProcesses([
    { pid: 99999991, start: 'Mon Oct 19 13:00:00 2026' },
    { pid: 99999992, start: 'Mon Oct 19 13:00:00 2026' },
  ], null);
  assert.equal(calls, 1);
});

test('Windows cleanup preserves retained identities beneath non-kept ancestors', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const chain = [
    { pid: 100, parent: 1, start: 1000 },
    { pid: 200, parent: 100, start: 1001 },
    { pid: 300, parent: 200, start: 1002 },
  ];
  const sibling = { pid: 400, parent: 100, start: 1003 };
  const cases = [
    { name: 'reported grandparent', rows: chain, identities: [{ pid: 300, start: 1002 }], kept: [200, 300] },
    { name: 'ordinary sibling', rows: [...chain, sibling], identities: [{ pid: 300, start: 1002 }], kept: [200, 300] },
    { name: 'unfiltered snapshot', rows: [...chain, sibling], identities: [{ pid: 300, start: 1002 }], kept: [200, 300], unfiltered: true },
    { name: 'all targets spared', rows: chain, identities: [{ pid: 100, start: 1000 }], kept: [100, 200, 300], unfiltered: true },
    { name: 'reused identity', rows: chain, identities: [{ pid: 300, start: 999 }], kept: [] },
    { name: 'no recorded identity', rows: chain, identities: [], kept: [], late: [{ pid: 500, parent: 300, start: 1004 }] },
    { name: 'multiple retained branches', rows: [...chain, sibling, { pid: 600, parent: 400, start: 1005 }],
      identities: [{ pid: 300, start: 1002 }, { pid: 600, start: 1005 }], kept: [200, 300, 400, 600] },
    { name: 'PID reuse cycle', rows: [{ pid: 100, parent: 200, start: 1000 }, { pid: 200, parent: 100, start: 1001 }],
      identities: [], kept: [], order: [100, 200] },
    { name: 'cycle while retaining another root', rows: [
      { pid: 100, parent: 200, start: 1000 }, { pid: 200, parent: 100, start: 1001 },
      { pid: 700, parent: 1, start: 1002 },
    ], identities: [{ pid: 700, start: 1002 }], kept: [700], order: [100, 200] },
    { name: 'equal-time cycle', rows: [
      { pid: 100, parent: 200, start: 1000 }, { pid: 200, parent: 100, start: 1000 },
    ], identities: [], kept: [], order: [100, 200] },
    { name: 'self-parent', rows: [{ pid: 100, parent: 100, start: 1000 }], identities: [], kept: [], order: [100] },
    { name: 'three-node equal-time cycle', rows: [
      { pid: 100, parent: 300, start: 1000 }, { pid: 200, parent: 100, start: 1000 },
      { pid: 300, parent: 200, start: 1000 },
    ], identities: [], kept: [], order: [100, 200, 300] },
    { name: 'cycle beside an acyclic tree', rows: [
      { pid: 100, parent: 200, start: 1000 }, { pid: 200, parent: 100, start: 1000 },
      { pid: 400, parent: 1, start: 1001 }, { pid: 500, parent: 400, start: 1002 },
    ], identities: [], kept: [], order: [400, 500, 100, 200] },
    { name: 'parent newer than child', rows: [
      { pid: 200, parent: 100, start: 1000 }, { pid: 100, parent: 1, start: 1001 },
    ], identities: [], kept: [], order: [200, 100] },
    { name: 'chunked targets', rows: [...chain, ...Array.from({ length: 400 }, (_, i) => ({
      pid: 1000 + i, parent: 100, start: 2000 + i,
    }))], identities: [{ pid: 300, start: 1002 }], kept: [200, 300] },
  ];
  for (const item of cases) {
    const killed = new Set();
    const calls = [];
    const tree = [...item.rows, ...(item.late || [])];
    t.mock.method(cp, 'execFile', (file, args, options, callback) => {
      assert.equal(file, 'powershell.exe');
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const targets = /\$t = @\(([\d,]*)\)/.exec(script)[1].split(',').filter(Boolean).map(Number)
        .filter((_, index) => index % 2 === 0);
      const recursive = script.includes('taskkill.exe /PID $id /T /F');
      calls.push({ targets, recursive });
      for (const pid of targets) {
        killed.add(pid);
        if (recursive) {
          let changed;
          do {
            changed = false;
            for (const row of tree) if (killed.has(row.parent) && !killed.has(row.pid)) {
              killed.add(row.pid);
              changed = true;
            }
          } while (changed);
        }
      }
      process.nextTick(callback, null, targets.map(pid => `${pid} stopped`).join('\n'), '');
    });
    const retained = C.managed(item.rows, item.identities, 50);
    assert.deepEqual(retained.map(row => row.pid), item.kept, item.name);
    const keep = new Set(item.kept);
    await C.stopProcesses(item.unfiltered ? item.rows : item.rows.filter(row => !keep.has(row.pid)), null, keep);
    for (const pid of keep) assert.equal(killed.has(pid), false, `${item.name}: retained pid ${pid}`);
    for (const row of tree.filter(row => !keep.has(row.pid))) {
      assert.equal(killed.has(row.pid), true, `${item.name}: ordinary pid ${row.pid}`);
    }
    assert.ok(calls.every(call => call.recursive === !keep.size), `${item.name}: recursive kills require no retained identities`);
    if (item.order) assert.deepEqual(calls.flatMap(call => call.targets), item.order, item.name);
    if (item.name === 'chunked targets') assert.equal(calls.length, 2);
    cp.execFile.mock.restore();
  }
});

for (const delayed of [false, true]) {
test(`watchdog post-exit killing catches forks with ${delayed ? 'pending' : 'immediate'} parent stops`, { skip: process.platform !== 'linux' }, t => {
  const ids = [99999991];
  const stopped = [];
  const killed = [];
  const frozen = new Set();
  const read = fs.readFileSync;
  const readdir = fs.readdirSync;
  const stat = pid => {
    const fields = Array(22).fill('0');
    fields[0] = frozen.has(pid) ? 'T' : 'S';
    fields[1] = String(pid - 1);
    fields[2] = String(pid);
    fields[19] = String(pid);
    fields[21] = '1';
    return `${pid} (fixture) ${fields.join(' ')}`;
  };
  t.mock.method(fs, 'readdirSync', (dir, ...args) => dir === '/proc' ? ids.map(String) : readdir(dir, ...args));
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const match = /^\/proc\/(9999999[1-3])\/stat$/.exec(file);
    if (!match) return read(file, ...args);
    const pid = Number(match[1]);
    const result = stat(pid);
    if (delayed && stopped.includes(pid) && !frozen.has(pid)) {
      frozen.add(pid);
      if (ids.length < 3) ids.push(pid + 1);
    }
    return result;
  });
  const spawn = cp.spawnSync;
  t.mock.method(cp, 'spawnSync', (file, ...args) => file === 'getconf' ? { status: 0, stdout: '4096\n' } : spawn(file, ...args));
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 'SIGSTOP') {
      stopped.push(pid);
      if (!delayed && !frozen.has(pid)) {
        frozen.add(pid);
        if (ids.length < 3) ids.push(pid + 1);
      }
    }
    if (signal === 'SIGKILL') killed.push(pid);
    return true;
  });
  C.stopProcesses([{ pid: ids[0], start: String(ids[0]) }], null);
  assert.deepEqual([...new Set(stopped)], ids);
  assert.deepEqual(killed, ids);
});
}

for (const mode of ['EPERM', 'EACCES', 'ESRCH', 'pending', 'reused', 'spared']) {
test(`watchdog cleanup returns when a stop is ${mode}`, { skip: process.platform !== 'linux' }, t => {
  const pid = 99999991;
  const stopped = [];
  const killed = [];
  let elapsed = 0;
  let scans = 0;
  const read = fs.readFileSync;
  const readdir = fs.readdirSync;
  t.mock.method(require('node:perf_hooks').performance, 'now', () => elapsed);
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    if (dir !== '/proc') return readdir(dir, ...args);
    elapsed += 25;
    // A broken freeze loop fails its assertions instead of hanging this worker.
    if (++scans > 4) throw new Error('freeze did not finish');
    return [String(pid)];
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file !== `/proc/${pid}/stat`) return read(file, ...args);
    const fields = Array(22).fill('0');
    fields[0] = 'S';
    fields[2] = String(pid);
    fields[19] = String(mode === 'reused' ? pid + 1 : pid);
    fields[21] = '1';
    return `${pid} (fixture) ${fields.join(' ')}`;
  });
  const spawn = cp.spawnSync;
  t.mock.method(cp, 'spawnSync', (file, ...args) => file === 'getconf' ? { status: 0, stdout: '4096\n' } : spawn(file, ...args));
  t.mock.method(process, 'kill', (target, signal) => {
    assert.equal(target, pid);
    if (signal === 'SIGSTOP') stopped.push(target);
    if (signal === 'SIGKILL') killed.push(target);
    if (['EPERM', 'EACCES', 'ESRCH'].includes(mode)) throw Object.assign(new Error(mode), { code: mode });
    return true;
  });
  C.stopProcesses([{ pid, start: String(pid) }], null, new Set(mode === 'spared' ? [pid] : []));
  assert.ok(scans <= 4, 'the freeze phase ends within its reconciliation interval');
  assert.equal(stopped.length, mode === 'pending' ? 4 : ['reused', 'spared'].includes(mode) ? 0 : 1);
  assert.equal(killed.length, ['reused', 'spared'].includes(mode) ? 0 : 1, 'attempt a final kill without reusing or stopping spared identities');
});
}

test('empty delegated groups are removed after partial setup or nested cleanup', async t => {
  const h = cachedFixture(t, 'empty-delegated-group', h => h.init());
  for (const [index, children] of [[], ['runner'], ['runner', 'nested-attempt/runner']].entries()) {
    const group = path.join(h.base, `empty-group-${index}`);
    fs.mkdirSync(group);
    for (const name of children) fs.mkdirSync(path.join(group, name), { recursive: true });
    await C.guardRemaining({ rows: [], group, baseline: { tasks: 0, memory: 0 },
      limits: { tasks_max: 64, memory_max_bytes: 512 * 1024 ** 2 } });
    assert.equal(fs.existsSync(group), false, JSON.stringify(children));
  }
});
