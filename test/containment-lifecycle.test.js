'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const { cachedFixture } = require('./helpers');
const { readPublished } = require('./atomic-file');
const fixture = path.join(__dirname, 'fixtures', 'containment-lifecycle.js');
process.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
// The fixture's times stretch on Windows, where a CIM snapshot and a stop take about a second each.
const scale = process.platform === 'win32' ? 5 : 1;

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
  for (const [marks, expected] of [
    [['TOWERCRANE_GATE_RUN_outer'], [2, 3, 5, 6, 7]],
    [['TOWERCRANE_GATE_RUN_outer', 'TOWERCRANE_GATE_RUN_new'], [2, 3, 7]],
  ]) assert.deepEqual(C.managed(rows, marks, new Map(), 1).map(row => row.pid), expected);
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
  ['supervisor', 'nonzero', 'agent', 'none', true],
  ['supervisor', 'signal', 'agent', 'none', true],
  ['wait', 'zero', 'agent', 'none', true],
  ['gate', 'zero', 'agent', 'none', true],
  ['supervisor', 'zero', 'gate-owner', 'none', false],
  ['supervisor', 'zero', 'agent', 'tasks', false],
  ['supervisor', 'zero', 'agent', 'memory', false],
];
for (const [kind, ending, owner, late, survives] of cases) {
  test(`retained ${kind}: ${ending} exit, ${owner} owner, ${late} late limit`, async (t) => {
    const h = cachedFixture(t, 'lifecycle', h => h.init());
    h.env.TOWER_CRANE_TEST_CONTAINMENT = '1';
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
    await new Promise(resolve => setTimeout(resolve, 2200 * scale)); // wait-allow: all finite fixture children and the keeper end
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

test('an unsandboxed CLI agent leaves its dispatched supervisor working after spawn --wait returns', async (t) => {
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
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  await new Promise(resolve => setTimeout(resolve, 2200 * scale)); // wait-allow: bounded dispatched fixture lifetime
  assert.equal(fs.existsSync(path.join(dir, 'managed.done')), true);
  assert.equal(fs.existsSync(path.join(dir, 'grandchild.done')), true);
  assert.equal(fs.existsSync(path.join(dir, 'ordinary.done')), false);
});
