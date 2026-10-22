'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { setup, resubmit } = require('./stack-fixture');
const { BIN, fakeAgentEnv } = require('./helpers');
const { waitFor } = require('./canary');
const { waitUntil, HUNG_TEST_MS } = require('./signals');

function fixture(t) {
  const f = setup(null);
  f.h.logs = () => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  t.after(async () => {
    const ids = f.h.readState('tasks.json').tasks.map((task) => task.id);
    for (const id of ids) fs.writeFileSync(path.join(f.h.base, `${id}.go`), '');
    for (const id of ids) {
      if (fs.existsSync(path.join(f.h.base, id))) {
        await waitUntil(() => fs.existsSync(path.join(f.h.base, `${id}.exited`)), {
          paths: [f.h.base], what: `${id} worker exits`,
        });
      }
    }
    await f.h.cleanup();
  });
  return f;
}

function refusedStack(t) {
  const f = fixture(t);
  const wt = f.h.json(['worktree', 'T2']);
  const oldParent = f.h.json(['task', 'show', 'T2']).stack.parent_sha;
  fs.writeFileSync(path.join(wt.path, 'T2.txt'), 'own work\n');
  f.h.git(['add', 'T2.txt'], wt.path);
  f.h.git(['commit', '-qm', 'upper work'], wt.path);
  // A rewritten parent requires restacking even when a clean child can merge a descendant.
  const sha = resubmit(f, true);
  f.h.ok(['task', 'update', 'T2', '--priority', 'urgent']);
  return { ...f, wt, sha, oldParent };
}

function probe(f, body) {
  const script = path.join(f.h.base, 'refill-probe.js');
  fs.writeFileSync(script, `
const assert = require('node:assert/strict');
const S = require(${JSON.stringify(path.resolve(__dirname, '../lib/state'))});
const A = require(${JSON.stringify(path.resolve(__dirname, '../lib/automation'))});
const Actions = require(${JSON.stringify(path.resolve(__dirname, '../lib/actions'))});
const Spawn = require(${JSON.stringify(path.resolve(__dirname, '../lib/spawn'))});
const ctx = { stateDir: ${JSON.stringify(f.h.state)}, cwd: ${JSON.stringify(f.h.repo)},
  env: process.env, agent: 'orchestrator', agentExplicit: true, flags: {}, pos: [] };
(async () => { ${body} })().catch(e => { console.error(e); process.exitCode = 1; });
`);
  const result = cp.spawnSync(process.execPath, [script], { cwd: f.h.repo, env: fakeAgentEnv(f.h.env),
    encoding: 'utf8', timeout: HUNG_TEST_MS });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

function holdingWorkers(f) {
  const script = path.join(f.h.base, 'hold-worker.js');
  fs.writeFileSync(script, `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const task = process.env.TOWER_CRANE_TASK;
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', task], { env: fakeAgentEnv(process.env) });
const marker = path.join(${JSON.stringify(f.h.base)}, task);
fs.writeFileSync(marker, '');
const poll = () => fs.existsSync(marker + '.go') ? fs.writeFileSync(marker + '.exited', '') : setTimeout(poll, 25); // wait-allow: the finish file releases the worker
poll();
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: f.h.env.NODE_OPTIONS })),
    '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
}

for (const dispatch of ['refill', 'spawn --ready']) {
  test(`${dispatch} skips a refused stack child and fills two slots in one pass`, async (t) => {
    const f = refusedStack(t);
    f.add('independent one');
    f.add('independent two');
    f.h.ok(['project', 'set', '--workers', '2']);
    holdingWorkers(f);
    const result = dispatch === 'refill'
      ? probe(f, 'await A.refillWorkers(ctx, {});')
      : f.h.run(['spawn', '--ready', '--agent', 'orchestrator']);
    assert.match(result.stdout + result.stderr, /T2.*(?:holds its own changes|child has its own commits)/);
    await waitFor(path.join(f.h.base, 'T3'), { what: 'second ready task claims a slot' });
    await waitFor(path.join(f.h.base, 'T4'), { what: 'third ready task claims a slot' });
    const workers = f.h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
    assert.deepEqual(workers.map((e) => e.task), ['T3', 'T4']);
    const status = f.h.json(['status']);
    assert.match(status.not_dispatched.find((b) => b.id === 'T2').reason, /holds its own changes|child has its own commits/);
    assert.match(f.h.ok(['status']), /not dispatched: T2 .*(?:holds its own changes|child has its own commits)/);
  });
}

test('lasting stack refusals survive later passes and clear after a local branch repair', async (t) => {
  const f = refusedStack(t);
  holdingWorkers(f);
  probe(f, `
const spawn = Spawn.spawn;
let calls = 0;
Spawn.spawn = (...args) => { calls++; return spawn(...args); };
const attempt = {};
await A.refillWorkers(ctx, attempt);
await A.refillWorkers(ctx, attempt);
const now = Date.now();
Date.now = () => now + 60001;
await A.refillWorkers(ctx, attempt);
assert.equal(calls, 1, 'unchanged refusal does not dispatch each minute');
`);
  assert.equal(f.h.logs().filter((e) => e.cmd === 'spawn refused').length, 1);
  const detachedState = path.join(f.h.base, 'state-without-repo');
  fs.cpSync(f.h.state, detachedState, { recursive: true });
  const detachedStatus = f.h.json(['status', '--state', detachedState], { cwd: f.h.base });
  assert.match(detachedStatus.not_dispatched.find((b) => b.id === 'T2').reason,
    /holds its own changes|child has its own commits/);
  probe(f, `
let calls = 0;
Spawn.spawn = async () => { calls++; throw new Error('cached task was attempted'); };
await A.refillWorkers(ctx, {});
const result = await Actions.spawn({ ...ctx, flags: { ready: true } });
assert.equal(calls, 0, 'another host and an explicit ready batch also skip the refusal');
assert.equal(result.data.results[0].skipped, true);
const st = S.loadState(ctx.stateDir);
const task = st.tasks.tasks.find(t => t.id === 'T2');
const key = Spawn.readyRefusalKey(ctx, st, task);
const repo = S.findRepo;
S.findRepo = () => null;
assert.match(Spawn.readyRefusal(ctx, st, task), /holds its own changes|child has its own commits/, 'status can read a lasting receipt without a repository');
assert.equal(Spawn.readyRefusal(ctx, st, task, true), null, 'dispatch still needs a repository');
S.findRepo = repo;
for (const [name, changes, same] of [
  ['task notes', s => s.tasks.tasks[1].notes.push({ text: 'progress' }), true],
  ['task spend', s => s.tasks.tasks[1].spend.minutes++, true],
  ['parent notes', s => s.tasks.tasks[0].notes.push({ text: 'progress' }), true],
  ['parent spend', s => s.tasks.tasks[0].spend.minutes++, true],
  ['task tier', s => s.tasks.tasks[1].tier = 'hard', false],
  ['task revision', s => s.tasks.tasks[1].revision++, false],
  ['parent head', s => s.tasks.tasks[0].sha = 'f'.repeat(40), false],
  ['parent status', s => s.tasks.tasks[0].status = 'accepted', false],
  ['project base', s => s.project.base = 'other', false],
  ['routing receipt', s => s.events.push({ cmd: 'ladder set', detail: { rung: 'medium' } }), false],
  ['brief receipt', s => s.events.push({ cmd: 'brief set', task: 'T2', detail: {} }), false],
]) {
  const changed = structuredClone(st);
  changes(changed);
  assert.equal(Spawn.readyRefusalKey(ctx, changed, changed.tasks.tasks[1]) === key, same, name);
}
`);
  f.h.git(['rebase', '--onto', f.sha, f.oldParent], f.wt.path);
  assert.equal(f.h.json(['status']).not_dispatched.some((b) => b.id === 'T2'), false);
  probe(f, 'await A.refillWorkers(ctx, {});');
  await waitFor(path.join(f.h.base, 'T2'), { what: 'repaired child claims its slot' });
});

test('governor deferral holds the ready batch and retries when admission lifts', async (t) => {
  const f = fixture(t);
  f.add('independent');
  f.h.ok(['project', 'set', '--workers', '2']);
  holdingWorkers(f);
  probe(f, `
const G = require(${JSON.stringify(path.resolve(__dirname, '../lib/governor'))});
const spawn = Spawn.spawn;
let calls = 0;
Spawn.spawn = (...args) => { calls++; return spawn(...args); };
const check = G.check;
G.check = () => { const e = new Error('fixture governor deferral'); e.governorDeferred = true; throw e; };
const batch = await Actions.spawn({ ...ctx, flags: { ready: true } });
assert.equal(batch.data.results.length, 1);
assert.equal(batch.data.results[0].governor_deferred, true);
const attempt = {};
await A.refillWorkers(ctx, attempt);
assert.equal(calls, 1, 'refill governor check stops before dispatch');
assert.equal(S.loadState(ctx.stateDir).events.some(e => e.cmd === 'spawn refused'), false);
G.check = check;
await A.refillWorkers(ctx, attempt);
`);
  await waitFor(path.join(f.h.base, 'T2'), { what: 'child starts after governor admission' });
  await waitFor(path.join(f.h.base, 'T3'), { what: 'independent task starts after governor admission' });
});

test('missing briefs are skipped without dispatch until a brief is supplied', (t) => {
  const f = fixture(t);
  f.h.ok(['task', 'add', '--title', 'no brief', '--kind', 'docs', '--acceptance', 'works']);
  f.h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
  probe(f, `
let calls = 0;
Spawn.spawn = async () => { calls++; return { text: 'started' }; };
for (let i = 0; i < 2; i++) {
  const result = await Actions.spawn({ ...ctx, flags: { ready: true } });
  assert.match(result.data.results[0].error, /T3 has no brief/);
}
assert.equal(calls, 0);
`);
  assert.deepEqual(f.h.json(['status']).not_dispatched, [{ id: 'T3', reason: 'no brief' }]);
  f.h.ok(['brief', 'set', 'T3', '-'], { input: 'Build it.\n' });
  probe(f, `
let calls = 0;
Spawn.spawn = async () => { calls++; return { text: 'started' }; };
await Actions.spawn({ ...ctx, flags: { ready: true } });
assert.equal(calls, 1);
`);
});

test('a lasting worker refusal leaves deferred reviewers runnable with free or full worker slots', (t) => {
  const f = refusedStack(t);
  holdingWorkers(f);
  probe(f, 'await A.refillWorkers(ctx, {});');
  probe(f, `
const R = require(${JSON.stringify(path.resolve(__dirname, '../lib/reviewer'))});
const T = require(${JSON.stringify(path.resolve(__dirname, '../lib/tasks'))});
const st = S.loadState(ctx.stateDir);
assert.match(Spawn.readyRefusal(ctx, st, T.getTask(st, 'T2')), /holds its own changes|child has its own commits/);
assert.ok(require(${JSON.stringify(path.resolve(__dirname, '../lib/inbox'))}).dispatchable(st, true).some(t => t.id === 'T2'));
R.deferredDispatches = () => [{ id: 'T1' }];
R.softwareReport = () => ({ ok: true });
const holders = T.workerHolders;
const calls = [];
Spawn.spawn = async dispatch => {
  calls.push([dispatch.flags.task, dispatch.flags.role]);
  assert.equal(dispatch.flags.role, 'review', 'cached workers never reach dispatch');
  return { text: 'reviewer started' };
};
for (const full of [false, true]) {
  T.workerHolders = (st, now) => full
    ? Array.from({ length: st.project.limits.workers }, () => ({ task: 'occupied' }))
    : holders(st, now);
  await A.refillWorkers(ctx, {});
  assert.equal(calls.length, full ? 2 : 1, 'reviewer debt remains runnable');
}
assert.deepEqual(calls, [['T1', 'review'], ['T1', 'review']]);
`);
});

for (const dispatch of ['refill', 'spawn --ready']) {
  test(`${dispatch} preserves an ordinary ENOTDIR refusal in status after filling both slots`, async (t) => {
    const f = fixture(t);
    f.h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
    f.add('blocked by a file');
    f.add('healthy one');
    f.add('healthy two');
    f.h.ok(['task', 'update', 'T3', '--priority', 'urgent']);
    f.h.ok(['project', 'set', '--workers', '2']);
    holdingWorkers(f);
    const W = require('../lib/worktree');
    const target = W.pathFor({ root: f.h.repo }, W.branchFor(f.h.json(['task', 'show', 'T3'])));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not a directory\n');
    const result = dispatch === 'refill'
      ? probe(f, 'await A.refillWorkers(ctx, {});')
      : f.h.run(['spawn', '--ready', '--agent', 'orchestrator']);
    assert.match(result.stdout + result.stderr, /T3:.*ENOTDIR/);
    for (const id of ['T4', 'T5']) {
      await waitFor(path.join(f.h.base, id), { what: `${id} starts past the refused task` });
    }
    assert.match(f.h.json(['status']).not_dispatched.find((b) => b.id === 'T3').reason, /ENOTDIR/);
    assert.match(f.h.ok(['status']), /not dispatched: T3 .*ENOTDIR/);
    f.add('next ready task');
    probe(f, `
const T = require(${JSON.stringify(path.resolve(__dirname, '../lib/tasks'))});
const st = S.loadState(ctx.stateDir);
const receipt = st.events.findLast(e => e.cmd === 'spawn refused' && e.task === 'T3');
assert.ok(Number.isFinite(receipt.detail.until), 'ordinary refusals expire');
const clock = Date.now;
Date.now = () => receipt.detail.until - 1;
T.workerHolders = () => [{ task: 'occupied' }];
const reasons = A.refillBlockers(ctx, st);
assert.match(reasons.find(b => b.id === 'T3').reason, /ENOTDIR/);
assert.equal(reasons.some(b => b.id === 'T6'), false, 'a refused task does not consume the one free slot');
Date.now = () => receipt.detail.until + 1;
assert.equal(Spawn.readyRefusal(ctx, st, T.getTask(st, 'T3')), null, 'expiry clears the old refusal');
Date.now = clock;
`);
  });
}

test('status receipts cover ordinary refusal classes, caller paths and lifecycle changes', (t) => {
  const f = fixture(t);
  f.h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
  f.add('ordinary refusals');
  probe(f, `
const T = require(${JSON.stringify(path.resolve(__dirname, '../lib/tasks'))});
for (const caller of ['batch', 'refill']) {
  for (const mode of ['thrown', 'returned']) {
    for (const reason of [
      'route unavailable', 'harness startup failed', 'GitHub read failed',
      'worktree retirement incomplete', 'dependency PR moved or closed',
      'T3: branch was prepared on T1 at old, which is not its current accepted head new',
    ]) {
      Spawn.spawn = async () => {
        if (mode === 'thrown') throw new Error(reason);
        return { code: 1, text: reason };
      };
      if (caller === 'batch') await Actions.spawn({ ...ctx, flags: { ready: true } });
      else await A.refillWorkers(ctx, {});
      const st = S.loadState(ctx.stateDir);
      const task = T.getTask(st, 'T3');
      assert.equal(A.refillBlockers(ctx, st).find(b => b.id === 'T3')?.reason, reason, caller + ': ' + mode + ': ' + reason);
      const receipt = st.events.findLast(e => e.cmd === 'spawn refused' && e.task === 'T3');
      assert.ok(receipt.detail.until > Date.now(), 'external availability always retains its minute retry');
      for (const [name, change] of [
        ['task changed', s => T.getTask(s, 'T3').tier = 'hard'],
        ['dispatch succeeded', s => s.events.push({ cmd: 'spawn', task: 'T3', detail: { role: 'worker' } })],
      ]) {
        const changed = structuredClone(st);
        change(changed);
        assert.equal(Spawn.readyRefusal(ctx, changed, T.getTask(changed, 'T3')), null, name);
      }
      const find = S.findRepo;
      S.findRepo = () => null;
      assert.equal(A.refillBlockers({ ...ctx, cwd: null }, st).find(b => b.id === 'T3')?.reason, reason, 'status tolerates no repository');
      S.findRepo = find;
    }
  }
}
`);
});

test('refusal receipts stay out of default waits and harness pushes but remain auditable', () => {
  const E = require('../lib/events');
  for (const kind of ['ordinary', 'lasting']) {
    for (const [agent, via, waiter] of [
      ['orchestrator', 'automation', 'orchestrator'],
      ['orchestrator', undefined, 'another-orchestrator'],
      ['worker', undefined, 'orchestrator'],
      ['owner', undefined, 'orchestrator'],
    ]) {
      const event = { cmd: 'spawn refused', type: 'spawn refused', task: 'T3', to: 'orchestrator',
        agent, via, detail: { reason: 'cannot dispatch', ...(kind === 'ordinary' ? { until: Date.now() + 60000 } : {}) } };
      const filter = { recipient: 'orchestrator', agent: waiter, task: 'T3' };
      assert.equal(E.wakes(event, filter), false, `${kind}: ${agent}: default wake`);
      for (const types of [new Set(['all']), new Set(['spawn refused'])]) {
        assert.equal(E.wakes(event, { ...filter, types }), true, `${kind}: ${agent}: explicit audit`);
      }
    }
  }
});

test('a non-follow wait does not wake on its own automatic refusal receipt', (t) => {
  const f = fixture(t);
  f.h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
  f.add('blocked by a file');
  holdingWorkers(f);
  const W = require('../lib/worktree');
  const target = W.pathFor({ root: f.h.repo }, W.branchFor(f.h.json(['task', 'show', 'T3'])));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'not a directory\n');
  const preload = path.join(f.h.base, 'only-refill.js');
  fs.writeFileSync(preload, `
const A = require(${JSON.stringify(path.resolve(__dirname, '../lib/automation'))});
// Gate reactions have separate coverage; this probe drives the real refill.
A.backlog = () => [];
A.consume = async () => [];
`);
  const after = String(fs.statSync(path.join(f.h.state, 'events.jsonl')).size);
  for (let pass = 0; pass < 2; pass++) {
    const result = f.h.run(['wait', '--after', after, '--task', 'T3', '--timeout', '0.1', '--agent', 'orchestrator'], // wait-allow: the probe must reach its deadline instead of waking on its own refusal
      { pre: ['--require', preload] });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).type, 'timeout');
    assert.match(f.h.json(['status']).not_dispatched.find(b => b.id === 'T3').reason, /ENOTDIR/);
  }
  probe(f, `
const E = require(${JSON.stringify(path.resolve(__dirname, '../lib/events'))});
const after = ${JSON.stringify(after)};
assert.equal(E.pending(ctx.stateDir, after, { recipient: 'orchestrator', agent: 'orchestrator', task: 'T3' }).rows.length, 0,
  'harness pending uses the same quiet wake filter');
const audit = E.pending(ctx.stateDir, after, { recipient: 'orchestrator', agent: 'orchestrator', task: 'T3',
  types: new Set(['spawn refused']) }).rows;
assert.ok(audit.length > 0);
assert.ok(audit.every(e => e.type === 'spawn refused'));
`);
});
