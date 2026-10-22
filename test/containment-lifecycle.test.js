'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const { cachedFixture, detachedAlive } = require('./helpers');
const { waitOnRepo, killPid } = require('./signals');
const { readPublished } = require('./atomic-file');
const fixture = path.join(__dirname, 'fixtures', 'containment-lifecycle.js');
process.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
// The fixture's times stretch on Windows, where a CIM snapshot and a stop take about a second each.
const scale = process.platform === 'win32' ? 5 : 1;

for (const [mode, retained, cli] of [
  ['cooperative', false, false], ['delayed', false, false], ['ignore', false, false],
  ['delayed', true, false], ['ignore', true, false], ['cooperative', false, true],
]) {
test(`natural exit gives ${mode} leftovers SIGTERM before killing (${retained ? 'retained sibling' : cli ? 'CLI' : 'scope'})`, {
  skip: process.platform === 'win32' && 'POSIX SIGTERM handlers',
}, async t => {
  const h = cachedFixture(t, 'term-grace', h => h.init(['--tasks-max', '128', '--memory-max-bytes', String(1024 ** 3)]));
  const dir = path.join(h.base, 'term');
  fs.mkdirSync(dir);
  const ownerReady = path.join(dir, 'owner.json');
  const program = path.join(dir, 'agent.js');
  const atomic = require.resolve('./atomic-file');
  fs.writeFileSync(program, `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {writeAtomic}=require(${JSON.stringify(atomic)});
const dir=${JSON.stringify(dir)};
const mode=${JSON.stringify(mode)};
if(process.argv[2]==='leaf'||process.argv[2]==='retained'){
 const kind=process.argv[2];
 process.on('SIGTERM',()=>{
  writeAtomic(path.join(dir,kind+'.term'),'TERM');
  if(kind==='leaf'&&mode!=='ignore')setTimeout(()=>{ // wait-allow: emulate asynchronous cleanup in the TERM handler
   writeAtomic(path.join(dir,'cleaned'),'done');process.exit(0);
  },mode==='delayed'?100:0); // wait-allow: emulate asynchronous cleanup in the TERM handler
 });
 writeAtomic(path.join(dir,kind+'.ready'),'ready');
 setInterval(()=>{},100); // wait-allow: leftover stays alive until TERM cleanup or the final kill
}else{
 const leaf=cp.spawn(process.execPath,[__filename,'leaf'],{stdio:'ignore'});
 const kept=${retained} ? cp.spawn(process.execPath,[__filename,'retained'],{stdio:'ignore'}) : null;
 const timer=setInterval(()=>{
  if(!fs.existsSync(path.join(dir,'leaf.ready'))||kept&&!fs.existsSync(path.join(dir,'retained.ready')))return;
  clearInterval(timer);
  Promise.resolve(kept ? require(${JSON.stringify(require.resolve('../lib/containment'))}).processIdentity(kept.pid) : null).then(identity=>{
   writeAtomic(${JSON.stringify(ownerReady)},JSON.stringify({leaf:leaf.pid,retained:kept?.pid,identity}));
   process.exit(0);
  });
 },25); // wait-allow: exit the owner only after its leftovers installed signal handlers
}
`);
  let owned;
  t.after(() => {
    if (fs.existsSync(ownerReady)) owned ||= JSON.parse(readPublished(ownerReady, 'utf8'));
    for (const pid of [owned?.leaf, owned?.retained].filter(Boolean)) {
      if (detachedAlive({ pid })) killPid(pid, 'SIGKILL');
    }
  });
  const began = performance.now();
  if (cli) {
    h.ok(['task', 'add', '--title', 'Natural TERM cleanup', '--acceptance', 'handler runs', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Clean leftovers on TERM.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, program, 'parent', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
    h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
    const result = await h.runAsync(['spawn', '--task', 'T1', '--wait']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  } else {
    const child = C.spawn(process.execPath, [program, 'parent'], {
      env: { ...h.env, TOWER_CRANE_TEST_CONTAINMENT: '1' }, stdio: 'ignore',
      resources: { tasks_max: 128, memory_max_bytes: 1024 ** 3 },
      retained: () => {
        if (!fs.existsSync(ownerReady)) return [];
        const identity = JSON.parse(readPublished(ownerReady, 'utf8')).identity;
        return identity ? [identity] : [];
      },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    await child.containmentDone;
    assert.equal(!!child.containment.retained?.length, retained);
  }
  owned = JSON.parse(readPublished(ownerReady, 'utf8'));
  assert.equal(fs.existsSync(path.join(dir, 'leaf.term')), true, 'leftover handled SIGTERM');
  assert.equal(fs.existsSync(path.join(dir, 'cleaned')), mode !== 'ignore');
  await waitOnRepo(h, () => !detachedAlive({ pid: owned.leaf }), 'leftover exited after cleanup');
  if (mode === 'ignore') assert.ok(performance.now() - began >= 5000, 'ignored TERM still receives the five-second grace'); // wait-allow: contract requires five seconds before killing a TERM-ignoring leftover
  if (retained) {
    assert.equal(detachedAlive({ pid: owned.retained }), true);
    assert.equal(fs.existsSync(path.join(dir, 'retained.term')), false, 'the independent retained process gets no TERM');
  }
});
}

test('managed ownership separates independent work from ordinary and gate-owned descendants', () => {
  const P = require('../lib/processes');
  for (const [command, expected] of [
    ['node "/tool with spaces/spawn-monitor.js" job.json', true],
    ['node /tmp/tool/lib/containment-keeper.js "{}"', true],
    ['node bin/tower-crane.js --agent worker wait --timeout 10', true],
    ['tower-crane check tests T1', true],
    ['node bin/tower-crane.js project set --name check', false],
    ['node watcher.js "example tower-crane wait"', false],
  ]) assert.equal(P.managedCommand(command), expected, command);
  const rows = [
    { pid: 1, parent: 0, start: 'a', envNames: [] },
    { pid: 2, parent: 1, start: 'b', envNames: ['TOWERCRANE_SUPERVISOR'] },
    { pid: 3, parent: 2, start: 'c', envNames: [] },
    { pid: 4, parent: 1, start: 'd', envNames: ['TOWERCRANE_GATE_RUN_outer'] },
    { pid: 5, parent: 1, start: 'e', envNames: ['TOWERCRANE_GATE_RUN_new'] },
    { pid: 6, parent: 5, start: 'f', envNames: [] },
    { pid: 7, parent: 1, start: 'g', envNames: [], command: 'node bin/tower-crane.js wait --timeout 10' },
  ];
  for (const [identities, expected] of [
    [[], []],
    [[{ pid: 2, start: 'b' }], [2, 3]],
    [[{ pid: 5, start: 'e' }], [5, 6]],
    [[{ pid: 7, start: 'g' }], [7]],
    [[{ pid: 2, start: 'reused' }], []],
  ]) assert.deepEqual(C.managed(rows, identities, 1).map(row => row.pid), expected);
});

test('a Windows root that exited before its first snapshot keeps the children it launched', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  // Windows rows: no process group, creation time in epoch ms. The root, pid 10, launched at 1000.
  const rows = [
    { pid: 11, parent: 10, group: null, start: 1050 },
    { pid: 12, parent: 11, group: null, start: 1100 },
    { pid: 13, parent: 10, group: null, start: 500 }, // a child of an earlier process that had pid 10
    { pid: 14, parent: 10, group: null, start: 950 }, // within the creation clock's tick
    { pid: 15, parent: 99, group: null, start: 1200 },
  ];
  const root = { pid: 10, parent: 1, group: null, start: 1001 };
  try {
    for (const [name, os, snapshot, launch, expected] of [
      ['exited root', 'win32', rows, 1000, [11, 12, 14]],
      ['live root', 'win32', [root, ...rows.filter(r => r.pid !== 13)], 1000, [10, 11, 12, 14]],
      ['no launch time', 'win32', rows, undefined, []],
      ['Linux reparents', 'linux', rows, 1000, []],
    ]) {
      Object.defineProperty(process, 'platform', { ...platform, value: os });
      const known = new Map(launch === undefined ? [] : [[10, launch]]);
      assert.deepEqual(C.descendants(snapshot, 10, known).map(r => r.pid), expected, name);
    }
  } finally { Object.defineProperty(process, 'platform', platform); }
});

const cases = [
  ['supervisor', 'zero', 'caller', 'none', true],
  // Windows' identity query outlasts the owner's 400 ms; elsewhere a delay stands in for it.
  ['supervisor', 'zero', 'slow-identity', 'none', true],
  ['supervisor', 'nonzero', 'agent', 'none', true],
  ['supervisor', 'signal', 'agent', 'none', true],
  ['wait', 'zero', 'agent', 'none', true],
  ['gate', 'zero', 'agent', 'none', true],
  ['supervisor', 'zero', 'gate-owner', 'none', false],
  ['supervisor', 'zero', 'agent', 'tasks', false],
  ['supervisor', 'zero', 'agent', 'memory', false],
  ['supervisor', 'zero', 'unrecorded', 'none', false],
  ['wait', 'nonzero', 'unrecorded', 'none', false],
  ['gate', 'signal', 'unrecorded', 'none', false],
];
for (const [kind, ending, owner, late, survives] of cases) {
  test(`retained ${kind}: ${ending} exit, ${owner} owner, ${late} late limit`, async (t) => {
    const h = cachedFixture(t, 'lifecycle', h => h.init());
    h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
    if (owner === 'unrecorded') h.env.TC_UNRECORDED_FIXTURE = '1';
    if (owner === 'slow-identity') h.env.TC_IDENTITY_DELAY_MS = '600';
    const dir = path.join(h.base, 'result');
    fs.mkdirSync(dir);
    const args = [fixture, owner === 'caller' ? 'caller' : 'agent', dir, kind, ending, late];
    const limits = { tasks_max: late === 'tasks' ? (C.canScope() ? 32 : 4) : 64,
      memory_max_bytes: (late === 'memory' ? 384 : 512) * 1024 ** 2 };
    let metadata;
    let reason;
    if (owner === 'gate-owner') {
      const result = await G.treeExec(process.execPath, args, { resources: limits, env: h.env, timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      metadata = result.containment;
    } else {
      // A keeper that took over the scope reads its Result first, so only the keeper settles it.
      const settled = [];
      const execFile = cp.execFile;
      t.mock.method(cp, 'execFile', function (file, args, ...rest) {
        if (file === 'systemctl' && args.includes('ActiveState')) settled.push(args[2]);
        return execFile.call(this, file, args, ...rest);
      });
      if (late !== 'none') {
        // The keeper releases the late probe as it starts. A memory probe's OOM empties a
        // systemd scope, whose manager then removes it with its counters, so that keeper
        // starts only once the kernel ended the probe: the launcher's watch must see it.
        const preload = path.join(h.base, 'keeper-preload.js');
        fs.writeFileSync(preload, `
const path=require('node:path');
const {writeAtomic,readPublished}=require(${JSON.stringify(require.resolve('./atomic-file'))});
const dir=${JSON.stringify(dir)};
writeAtomic(path.join(dir,'probe.go'),'go');
if(process.env.TC_KEEPER_HOLD){
 const [id]=JSON.parse(readPublished(path.join(dir,'identities.json'),'utf8'));
 const P=require(${JSON.stringify(require.resolve('../lib/processes'))});
 while(P.processState({pid:id.pid,start_ticks:id.start})!=='exited')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25); // wait-allow: hold the keeper until the kernel ended the probe
}
`);
        const spawn = cp.spawn;
        t.mock.method(cp, 'spawn', function (file, args, options) {
          if (!String(args?.[0]).endsWith('containment-keeper.js')) return spawn.apply(this, arguments);
          const hold = late === 'memory' && child.containment.unit ? '1' : '';
          return spawn.call(this, file, ['--require', preload, ...args], { ...options, env: { ...options.env, TC_KEEPER_HOLD: hold } });
        });
      }
      // The caller row deliberately terminates its own launcher to prove the
      // detached keeper retains the bound after that launcher is gone.
      const child = C.spawn(process.execPath, args, {
        resources: owner === 'caller' ? { tasks_max: 128, memory_max_bytes: 768 * 1024 ** 2 } : limits,
        env: h.env, stdio: 'ignore', timeout: 10000, // wait-allow: independent safety deadline for finite lifecycle probes
        retained: () => {
          try { return JSON.parse(readPublished(path.join(dir, 'identities.json'), 'utf8')); } catch { return []; }
        },
      });
      child.on('resourceLimit', value => { reason = value; });
      await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      await child.containmentDone;
      metadata = owner === 'caller' ? JSON.parse(readPublished(path.join(dir, 'closed.json'), 'utf8')) : child.containment;
      if (owner === 'agent' && child.containment.unit) {
        assert.equal(settled.includes(child.containment.unit), !metadata.retained?.length, JSON.stringify(metadata));
      }
      // A keeper outlives its caller, so its working directory must not pin the fixture or the tool.
      if (owner === 'agent' && metadata.keeper_pid && process.platform === 'linux') {
        const cwd = fs.readlinkSync(`/proc/${metadata.keeper_pid}/cwd`);
        for (const dir of [h.base, path.join(__dirname, '..')]) {
          assert.ok(!(cwd + path.sep).startsWith(fs.realpathSync(dir) + path.sep), `keeper cwd ${cwd} is inside ${dir}`);
        }
      }
    }
    if (late !== 'none') {
      const [id] = JSON.parse(readPublished(path.join(dir, 'identities.json'), 'utf8'));
      const work = { pid: id.pid, ...process.platform === 'linux' ? { startTicks: id.start } : {},
        ...process.platform === 'win32' ? { startTime: require('./windows-process').startTime(id.pid) } : {} };
      t.after(() => { if (detachedAlive(work)) killPid(work.pid, 'SIGKILL'); });
      await waitOnRepo(h, () => reason, 'late limit reported');
      await waitOnRepo(h, () => !detachedAlive(work), 'late limit stopped the dispatched work');
    }
    await new Promise(resolve => setTimeout(resolve, 2200 * scale)); // wait-allow: all finite fixture children and the keeper end
    if (survives) {
      assert.equal(fs.existsSync(path.join(dir, 'managed.done')), true);
      assert.equal(fs.existsSync(path.join(dir, 'grandchild.done')), true);
      assert.ok(metadata.retained?.length, JSON.stringify(metadata));
    } else if (late !== 'none') {
      assert.equal(reason, late === 'tasks' ? 'resource-tasks-max' : 'resource-memory-max', JSON.stringify(metadata));
      assert.equal(fs.existsSync(path.join(dir, 'managed.done')), false);
    } else {
      assert.equal(metadata.retained, undefined);
    }
    assert.equal(fs.existsSync(path.join(dir, 'ordinary.done')), false);
    if (!survives) assert.equal(fs.existsSync(path.join(dir, 'managed.done')), false);
  });
}

// Only a systemd scope reaches the handover in the row above; nested groups keep their counters.
test('a launcher keeps its OOM watch on a scope until the keeper reports its own watch', async (t) => {
  const { EventEmitter } = require('node:events');
  const { TMP_ROOT } = require('./helpers');
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'handover-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const [name, before, end, after, expected] of [
    // The OOM empties the scope and the manager removes it before the keeper is ready.
    ['OOM announced while the keeper starts, scope then removed', 'oom', 'ready', null, 'resource-memory-max'],
    ['OOM counted but not yet announced when the keeper is ready', 'counted', 'ready', null, 'resource-memory-max'],
    ['fork refused while the keeper starts', 'tasks', 'ready', null, 'resource-tasks-max'],
    ['keeper exits before it is ready', null, 'exit', null, null],
    ['keeper fails to start', null, 'error', null, null],
    ['OOM after the keeper reported its watch', null, 'ready', 'oom', null],
  ]) {
    const group = path.join(base, name.replace(/\W+/g, '-'));
    fs.mkdirSync(group);
    fs.writeFileSync(path.join(group, 'cgroup.events'), 'populated 1\nfrozen 0\n');
    const events = (oom) => fs.writeFileSync(path.join(group, 'memory.events.local'),
      `low 0\nhigh 0\nmax ${oom}\noom ${oom}\noom_kill ${oom}\noom_group_kill 0\n`);
    events(0);
    fs.writeFileSync(path.join(group, 'pids.events.local'), 'max 0\n');
    let notify;
    t.mock.method(fs, 'watch', (file, listener) => {
      notify = listener;
      return { on() {}, unref() {}, close() {} };
    });
    const found = [];
    const stop = C.watchOom(group, { tasks: 0, memory: 0 }, reason => found.push(reason));
    fs.watch.mock.restore();
    const keeper = new EventEmitter();
    let settled = false;
    const done = C.handOver(keeper, group, { tasks: 0, memory: 0 }, false, stop, reason => found.push(reason))
      .then(() => { settled = true; });
    if (before === 'oom') {
      events(1);
      notify();
      fs.rmSync(group, { recursive: true });
    } else if (before === 'counted') events(1);
    else if (before === 'tasks') fs.writeFileSync(path.join(group, 'pids.events.local'), 'max 1\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, `${name}: the handover waits for the keeper`);
    if (end === 'ready') keeper.emit('message', { ready: true });
    else if (end === 'error') keeper.emit('error', new Error('spawn failed'));
    // Every keeper exits in the end; the handover reads the counters once.
    keeper.emit('exit', 0, null);
    await done;
    if (after === 'oom') {
      events(1);
      notify();
    }
    assert.equal(found[0] ?? null, expected, name);
    assert.ok(found.length <= 1, `${name}: ${found}`);
  }
});

test('a CLI worker fixture named like a supervisor ends with its worker', async (t) => {
  const h = cachedFixture(t, 'lifecycle-cli', h => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(512 * 1024 ** 2)]);
    h.ok(['task', 'add', '--title', 'Independent dispatch', '--acceptance', 'survives', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Finite independent dispatch.\n' });
    const dir = path.join(h.base, 'result');
    fs.mkdirSync(dir);
    h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command',
      JSON.stringify([process.execPath, fixture, 'agent', dir, 'supervisor', 'zero', 'none', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort']);
  });
  // The cached configuration names the seed's result directory; replace the
  // command with this copy's directory before its real CLI dispatch.
  const dir = path.join(h.base, 'result');
  h.ok(['ladder', 'set', 'easy', '--command',
    JSON.stringify([process.execPath, fixture, 'agent', dir, 'supervisor', 'zero', 'none', '{prompt}'])]);
  h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
  h.env.TC_UNRECORDED_FIXTURE = '1';
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await new Promise(resolve => setTimeout(resolve, 2200 * scale)); // wait-allow: bounded dispatched fixture lifetime
  assert.equal(fs.existsSync(path.join(dir, 'managed.done')), false);
  assert.equal(fs.existsSync(path.join(dir, 'grandchild.done')), false);
  assert.equal(fs.existsSync(path.join(dir, 'ordinary.done')), false);
});

test('a detached Windows contained agent stops its job tree with taskkill /T', {
  skip: process.platform !== 'win32' && 'Windows detached process and job behavior',
}, async t => {
  const h = cachedFixture(t, 'windows-contained-job', h => h.init());
  const ready = path.join(h.base, 'ready.json');
  const go = path.join(h.base, 'grow');
  const program = path.join(h.base, 'agent.js');
  const atomic = require.resolve('./atomic-file');
  fs.writeFileSync(program, `
const fs=require('node:fs'),cp=require('node:child_process');
if(process.argv[2]==='leaf'){
 setTimeout(()=>{},10000); // wait-allow: finite detached Windows descendant lifetime
}else{
 const child=cp.spawn(process.execPath,[__filename,'leaf'],{detached:true,stdio:'ignore'});
 child.unref();
 require(${JSON.stringify(atomic)}).writeAtomic(${JSON.stringify(ready)},JSON.stringify({pid:child.pid}));
 const timer=setInterval(()=>{
  if(fs.existsSync(${JSON.stringify(go)})){clearInterval(timer);global.block=Buffer.alloc(192*1024**2,1);}
 },25); // wait-allow: grow only after the test has recorded the detached child's identity
 setTimeout(()=>{},10000); // wait-allow: finite contained agent lifetime
}
`);
  const child = C.spawn(process.execPath, [program], {
    detached: true, stdio: 'ignore', preserveManaged: false,
    env: { ...h.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
    resources: { tasks_max: 64, memory_max_bytes: 128 * 1024 ** 2 },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(() => child.kill('SIGKILL'));
  await waitOnRepo(h, () => fs.existsSync(ready), 'detached contained Windows child');
  const leaf = JSON.parse(readPublished(ready, 'utf8'));
  leaf.startTime = require('./windows-process').startTime(leaf.pid);
  t.after(() => { if (detachedAlive(leaf)) killPid(leaf.pid, 'SIGKILL'); });
  fs.writeFileSync(go, '');
  await closed;
  assert.equal(child.resourceReason, 'resource-memory-max');
  await waitOnRepo(h, () => !detachedAlive(leaf), 'taskkill /T stops the detached job descendant');
});
