'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture } = require('./helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const snapshot = (h) => ['tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));

function setup(t) {
  return cachedFixture(t, 'labs', (h) => {
    h.init(['--workers', '6']);
    for (let i = 1; i <= 3; i++) {
      h.ok(['task', 'add', '--title', `Lab ${i}`, '--tier', 'easy', '--acceptance', 'hardware is exclusive']);
      h.ok(['brief', 'set', `T${i}`, '-'], { input: 'Use the lab.\n' });
    }
    // Exercise scheduling separately from the flags that create the fields.
    const doc = h.readState('tasks.json');
    doc.tasks[0].locks = ['lab/rdma', 'gpu/0'];
    doc.tasks[1].locks = ['lab/rdma'];
    doc.tasks[2].locks = ['gpu/1'];
    h.writeState('tasks.json', doc);
  });
}

async function until(fn, message) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function controlledHarness(h) {
  const script = path.join(h.base, 'worker.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const base = process.argv[2];
const task = process.env.TOWER_CRANE_TASK;
fs.writeFileSync(path.join(base, task + '.started'), '');
const timer = setInterval(() => {
  if (fs.existsSync(path.join(base, task + '.exit'))) {
    clearInterval(timer);
    process.exit(0);
  }
}, 25);
`);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, script, h.base, '{prompt}']),
    '--clear', 'profile', '--clear', 'effort']);
}

test('task add, update and old state expose locks and an environment label', (t) => {
  const h = makeRepo(t);
  h.init();
  const task = h.json(['task', 'add', '--title', 'RDMA', '--acceptance', 'exclusive',
    '--lock', ' lab/rdma ', '--lock', 'gpu/0', '--lock', 'lab/rdma', '--environment', ' lab ']);
  assert.deepEqual(task.locks, ['lab/rdma', 'gpu/0']);
  assert.equal(task.environment, 'lab');
  assert.match(h.ok(['task', 'show', 'T1']), /locks: lab\/rdma, gpu\/0/);
  assert.match(h.ok(['task', 'show', 'T1']), /environment: lab/);
  assert.deepEqual(h.json(['ready']).ready[0].locks, task.locks);
  assert.equal(h.json(['ready']).ready[0].environment, 'lab');
  const updated = h.json(['task', 'update', 'T1', '--lock', 'gpu/1', '--environment', 'staging']);
  assert.deepEqual(updated.locks, ['gpu/1']);
  assert.equal(updated.environment, 'staging');
  assert.equal(updated.revision, task.revision);
  const cleared = h.json(['task', 'update', 'T1', '--lock', '', '--environment', '']);
  assert.deepEqual(cleared.locks, []);
  assert.equal(cleared.environment, null);
  const doc = h.readState('tasks.json');
  delete doc.tasks[0].locks;
  delete doc.tasks[0].environment;
  h.writeState('tasks.json', doc);
  const old = h.json(['task', 'show', 'T1']);
  assert.deepEqual(old.locks, []);
  assert.equal(old.environment, null);
});

test('plan import accepts resource fields and rejects malformed state and plans', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['plan', 'import', '-'], { input: JSON.stringify([
    { title: 'Lab', acceptance: ['exclusive'], locks: ['lab/rdma'], environment: 'lab' },
  ]) });
  assert.deepEqual(h.json(['task', 'show', 'T1']).locks, ['lab/rdma']);
  for (const fields of [{ locks: 'lab' }, { locks: [''] }, { locks: [4] }, { environment: {} }]) {
    const before = snapshot(h);
    const r = h.run(['plan', 'import', '-'], {
      input: JSON.stringify([{ title: 'Bad', acceptance: ['a'], ...fields }]),
    });
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(snapshot(h), before);
    const doc = h.readState('tasks.json');
    Object.assign(doc.tasks[0], fields);
    h.writeState('tasks.json', doc);
    const invalid = h.run(['task', 'show', 'T1']);
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.match(invalid.stderr, /locks|environment/);
    Object.assign(doc.tasks[0], { locks: ['lab/rdma'], environment: 'lab' });
    h.writeState('tasks.json', doc);
  }
});

test('live leases hide conflicting tasks and refuse claims and spawns naming the holder', (t) => {
  const h = setup(t);
  controlledHarness(h);
  h.ok(['task', 'update', 'T1', '--environment', 'lab']);
  h.ok(['task', 'update', 'T2', '--environment', 'staging']);
  h.ok(['task', 'update', 'T3', '--environment', 'lab']);
  h.ok(['claim', 'T1', '--agent', 'lab-worker']);
  h.ok(['task', 'update', 'T3', '--lock', 'gpu/0']);
  const gpuBlocked = h.run(['claim', 'T3', '--agent', 'gpu-worker']);
  assert.equal(gpuBlocked.code, 1, gpuBlocked.stderr);
  assert.match(gpuBlocked.stderr, /gpu\/0.*T1.*lab-worker/);
  h.ok(['task', 'update', 'T3', '--lock', 'gpu/1']);
  h.ok(['claim', 'T3', '--agent', 'gpu-worker']);
  const before = snapshot(h);
  const ready = h.json(['ready', '--all']);
  assert.deepEqual(ready.ready, []);
  assert.match(ready.blocked[0].reasons.join('; '), /lab\/rdma.*T1.*lab-worker/);
  assert.equal(h.json(['task', 'show', 'T2']).display, 'blocked');
  assert.deepEqual(h.json(['task', 'list', '--status', 'ready']), []);
  for (const args of [
    ['claim', 'T2', '--agent', 'rival'],
    ['spawn', '--task', 'T2'],
  ]) {
    const r = h.run(args);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /lab\/rdma.*T1.*lab-worker/);
    assert.deepEqual(snapshot(h), before);
  }
  assert.ok(!fs.existsSync(path.join(h.base, 'T2.started')));
  assert.ok(!fs.existsSync(path.join(h.state, 'homes')));
  assert.ok(!fs.existsSync(path.join(h.state, 'logs')));
  h.ok(['renew', 'T1', '--agent', 'lab-worker']);
  h.ok(['claim', 'T1', '--agent', 'lab-worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'lab-worker']);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T2']);
  h.ok(['claim', 'T2', '--agent', 'rival']);
});

test('concurrent claims on tasks sharing hardware allow exactly one holder', async (t) => {
  const h = setup(t);
  const results = await Promise.all(['T1', 'T2'].map((id) => h.runAsync(['claim', id, '--agent', `worker-${id}`])));
  assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find((r) => r.code !== 0).stderr, /lab\/rdma.*T[12].*worker-T[12]/);
  assert.equal(events(h).filter((e) => e.cmd === 'claim').length, 1);
  const held = h.readState('tasks.json').tasks.find((task) => task.claim);
  h.ok(['release', held.id, '--agent', held.claim.agent, '--reason', 'lab free']);
  h.ok(['claim', held.id === 'T1' ? 'T2' : 'T1', '--agent', 'replacement']);
});

test('lock changes are refused for live holders but identical lock sets remain valid', (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'lab-worker']);
  const before = snapshot(h);
  for (const locks of [['--lock', ''], ['--lock', 'gpu/2']]) {
    const r = h.run(['task', 'update', 'T1', ...locks]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /T1.*locks.*lab-worker/);
    assert.deepEqual(snapshot(h), before);
  }
  h.ok(['task', 'update', 'T1', '--lock', 'gpu/0', '--lock', 'lab/rdma', '--environment', 'lab']);
  h.ok(['release', 'T1', '--agent', 'lab-worker', '--reason', 'lab free']);
  h.ok(['task', 'update', 'T1', '--lock', 'gpu/2']);
});

test('expired leases free hardware and cannot renew or dispatch over a new holder', (t) => {
  const h = setup(t);
  controlledHarness(h);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].claim.until = new Date(Date.now() - 1000).toISOString();
  h.writeState('tasks.json', doc);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1', 'T2', 'T3']);
  h.ok(['claim', 'T2', '--agent', 'new-holder']);
  const before = snapshot(h);
  for (const args of [
    ['renew', 'T1', '--agent', 'worker-T1-1'],
    ['claim', 'T1', '--agent', 'worker-T1-1'],
    ['spawn', '--task', 'T1'],
  ]) {
    const r = h.run(args);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /lab\/rdma.*T2.*new-holder/);
    assert.deepEqual(snapshot(h), before);
  }
  h.ok(['release', 'T2', '--agent', 'new-holder', '--reason', 'lab free']);
  h.ok(['renew', 'T1', '--agent', 'worker-T1-1']);
});

test('concurrent dispatch reserves hardware until the lease, then release frees it', async (t) => {
  const h = setup(t);
  controlledHarness(h);
  h.ok(['worktree', 'T1', 'T2']);
  const results = await Promise.all(['T1', 'T2'].map((id) => h.runAsync(['spawn', '--task', id, '--json'])));
  assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
  const winner = JSON.parse(results.find((r) => r.code === 0).stdout);
  const id = winner.agent.includes('T1') ? 'T1' : 'T2';
  const loser = id === 'T1' ? 'T2' : 'T1';
  assert.match(results.find((r) => r.code !== 0).stderr, new RegExp(`lab/rdma.*${id}.*${winner.agent}`));
  await until(() => fs.existsSync(path.join(h.base, `${id}.started`)), 'worker did not start');
  assert.ok(!fs.existsSync(path.join(h.base, `${loser}.started`)));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
  assert.ok(!h.json(['ready']).ready.some((x) => x.id === loser));
  const before = snapshot(h);
  for (const args of [
    ['claim', loser, '--agent', 'rival'],
    ['claim', id, '--agent', 'stranger'],
    ['task', 'update', id, '--lock', ''],
  ]) {
    const r = h.run(args, { hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([winner.pid]) } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`${id}.*${winner.agent}`));
    assert.deepEqual(snapshot(h), before);
  }
  fs.writeFileSync(path.join(h.base, `${id}.exit`), '');
  await until(() => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === winner.agent), 'exit was not recorded');
  assert.equal(h.run(['claim', loser, '--agent', 'rival']).code, 1, 'an exited worker keeps its lock until released');
  h.ok(['release', id, '--agent', winner.agent, '--reason', 'worker exited']);
  h.ok(['claim', loser, '--agent', 'rival']);
});

test('claim consumes its own hardware reservation and a failed launch holds no locks', async (t) => {
  const h = setup(t);
  controlledHarness(h);
  const failed = h.run(['spawn', '--task', 'T1'], { hooks: { HOOK_SPAWN_FAIL: '1' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 0);
  assert.ok(h.json(['ready']).ready.some((x) => x.id === 'T2'));
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(path.join(h.base, 'T1.started')), 'worker did not start');
  h.ok(['claim', 'T1', '--agent', spawned.agent], { hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([spawned.pid]) } });
  const blocked = h.run(['claim', 'T2', '--agent', 'rival']);
  assert.equal(blocked.code, 1, blocked.stderr);
  assert.match(blocked.stderr, /lab\/rdma.*T1.*worker-T1-1/);
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'lab free']);
  h.ok(['claim', 'T2', '--agent', 'rival']);
  fs.writeFileSync(path.join(h.base, 'T1.exit'), '');
});

test('retry backoff retains resource locks and ended or lapsed reservations cannot regain them', (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--lease-minutes', '1']);
  const now = Date.now();
  const agent = 'worker-T1-1';
  const append = (ago, cmd, detail) => fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
    at: new Date(now - ago * 1000).toISOString(), agent: 'orchestrator', cmd, task: 'T1',
    detail: { role: 'worker', attempt: 1, agent, ...detail },
  }) + '\n');
  append(90, 'spawn', { pid: 424201, reserved: true, phase: 'running', active: true });
  append(80, 'spawn phase', { pid: 424201, phase: 'retrying', retry: 1, backoff_ms: 120000, active: true });
  const hidden = { hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([424201, 424202]) } };
  assert.ok(!h.json(['ready'], hidden).ready.some((x) => x.id === 'T2'));
  const blocked = h.run(['claim', 'T2', '--agent', 'rival'], hidden);
  assert.equal(blocked.code, 1, blocked.stderr);
  assert.match(blocked.stderr, /lab\/rdma.*T1.*worker-T1-1.*reservation/);
  append(70, 'spawn phase', { pid: 424201, phase: 'exited', active: false });
  h.ok(['claim', 'T2', '--agent', 'rival'], hidden);
  append(0, 'spawn retry', { pid: 424202, active: true });
  h.ok(['release', 'T2', '--agent', 'rival', '--reason', 'lab free'], hidden);
  h.ok(['claim', 'T2', '--agent', 'replacement'], hidden);
  append(120, 'spawn', { attempt: 2, pid: 424201, reserved: true, active: true });
  append(0, 'spawn phase', { attempt: 2, pid: 424202, active: true, phase: 'running' });
  h.ok(['release', 'T2', '--agent', 'replacement', '--reason', 'lab free'], hidden);
  h.ok(['claim', 'T2', '--agent', 'replacement'], hidden);
});
