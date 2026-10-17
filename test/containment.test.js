'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const C = require('../lib/containment');
const G = require('../lib/gates/common');
const HARNESS = path.join(__dirname, 'fixtures', 'containment-harness.js');
const memory = 512 * 1024 * 1024;
const systemd = process.platform === 'linux' && fs.existsSync('/sys/fs/cgroup/cgroup.controllers')
  && cp.spawnSync('systemctl', ['--user', 'show-environment'],
  { stdio: 'ignore', timeout: 2000 }).status === 0; // wait-allow: match the launcher's bounded user-manager probe

function fixture(t) {
  return cachedFixture(t, 'containment', (h) => {
    h.init(['--tasks-max', '64', '--memory-max-bytes', String(memory)]);
    h.ok(['task', 'add', '--title', 'Bound fake agent', '--acceptance', 'contained', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Finite fake harness.\n' });
  });
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

test('fake harness nested launches and detached grandchildren retain containment', async (t) => {
  const h = fixture(t);
  const file = path.join(h.base, 'nested.jsonl');
  const result = await G.treeExec(process.execPath, [HARNESS, 'nested', file], {
    resources: { tasks_max: 64, memory_max_bytes: memory }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined, result.stderr);
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 3);
  if (result.containment.backend === 'cgroup') {
    assert.equal(records[0].inherited, result.containment.group);
    assert.ok(records[1].inherited.startsWith(records[0].inherited + path.sep));
    for (const record of records) assert.ok(record.group.startsWith(records[0].inherited + path.sep), JSON.stringify(record));
  } else assert.equal(result.containment.backend, 'watchdog');
});

test('finite nested fork storm fails the gate command and leaves another attempt running', async (t) => {
  const sibling = C.spawn(process.execPath, ['-e', 'console.log("untouched"); setTimeout(() => {}, 3000)'], { // wait-allow: finite isolation probe lifetime
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
  const result = h.run(['check', 'clean', 'T1', '--json'],
    { env: { TOWER_CRANE_CLEAN_CMD: '' } });
  assert.equal(result.code, 1, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.ok, false);
  assert.match(gate.summary, /resource-tasks-max/);
  assert.equal(gate.resource_reason, 'resource-tasks-max');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.detail.resource_reason === 'resource-tasks-max'));
});
