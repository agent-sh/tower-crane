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

const cases = [
  ['supervisor', 'zero', 'caller', 'none', true],
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
    }
    await new Promise(resolve => setTimeout(resolve, 2200)); // wait-allow: all finite fixture children and the keeper end
    if (survives) {
      assert.equal(fs.existsSync(path.join(dir, 'managed.done')), true);
      assert.equal(fs.existsSync(path.join(dir, 'grandchild.done')), true);
      assert.ok(metadata.retained?.length, JSON.stringify(metadata));
    } else if (late !== 'none') {
      assert.equal(reason, late === 'tasks' ? 'resource-tasks-max' : 'resource-memory-max');
      assert.equal(fs.existsSync(path.join(dir, 'managed.done')), false);
    } else {
      assert.equal(metadata.retained, undefined);
    }
    assert.equal(fs.existsSync(path.join(dir, 'ordinary.done')), false);
    if (!survives) assert.equal(fs.existsSync(path.join(dir, 'managed.done')), false);
  });
}

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
  await new Promise(resolve => setTimeout(resolve, 2200)); // wait-allow: bounded dispatched fixture lifetime
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
