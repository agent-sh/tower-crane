'use strict';

const { fileWritten, eventAppended, HUNG_TEST_MS } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { cachedFixture, BIN, HOOKS, ROOT } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function log(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function setup(t, flags = []) {
  const h = cachedFixture(null, JSON.stringify(flags), (h) => {
    h.init(flags);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  });
  h.children = [];
  h.workerPids = [];
  t.after(async () => {
    for (const pid of h.workerPids) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    for (const { p } of h.children) {
      if (p.exitCode === null && p.signalCode === null) p.kill();
    }
    await Promise.all(h.children.map((c) => c.result));
    // Windows keeps a running child's cwd open, so stop children first.
    await h.cleanup();
  });
  return h;
}

function child(t, h, args, hooks = {}) {
  const p = cp.spawn(process.execPath, ['--require', HOOKS, BIN, ...args], {
    cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, ...hooks },
  });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  // A hung child cannot hold teardown beyond the suite backstop.
  const timer = setTimeout(() => p.kill(), HUNG_TEST_MS); // wait-allow: stagger concurrent operations to exercise both race orderings
  const result = once(p, 'close').then(([code]) => {
    clearTimeout(timer);
    return { code, stdout, stderr };
  });
  const c = { p, result };
  h.children.push(c);
  return c;
}

const created = (file) => fileWritten(file);

// A waiter runs software reactions unless it observes. Each test chooses, so a
// test asserting on manual commands never races an automatic one by accident.
// The suite hung-test timeout also bounds the waiter while gates run.
async function waiting(t, h, { automation, args = [], hooks = {}, seconds = HUNG_TEST_MS / 1000 }) {
  if (typeof automation !== 'boolean') throw new Error('waiting needs automation: true or false');
  const signal = path.join(h.base, `watch-${require('node:crypto').randomUUID()}`);
  const ready = created(signal);
  const actor = args.includes('--agent') ? [] : ['--agent', 'orchestrator'];
  const observe = automation ? [] : ['--observe'];
  const c = child(t, h, ['wait', ...actor, ...observe, '--timeout', String(seconds), ...args], { ...hooks, HOOK_WATCH_READY: signal });
  // A baseline CLI that lacks wait closes immediately; never wait for a marker
  // it cannot write.
  await Promise.race([ready, c.result.then((r) => { throw new Error(`wait exited before watch setup: ${r.code} ${r.stderr}`); })]);
  return c;
}

async function event(result, type, task = 'T1') {
  const r = await (result.result || result);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const e = JSON.parse(r.stdout);
  assert.equal(e.type, type);
  assert.equal(e.task, task);
  assert.match(e.id, /^E/);
  assert.ok(e.offset > 0);
  return e;
}

function submit(h, extra = []) {
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha || 'abcdef1', ...extra]);
}

function gates(h, ci = false) {
  for (const type of ['tests', 'clean', 'review', ...(ci ? ['ci'] : [])]) {
    if (type === 'review') {
      h.reviewer('T1', 'reviewer', h.sha);
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--agent', 'reviewer', '--type', type, '--sha', h.sha, '--ok']);
    } else gateEvidence(h, type, 'reviewer');
  }
}

function commandWorker(h, argv) {
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([...argv, '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
}

test('readiness observes a CLI marker without directory watch notifications', async (t) => {
  const h = setup(t);
  const signal = path.join(h.base, 'paused');
  t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
  const ready = created(signal);
  const writer = h.runAsync(['task', 'note', 'T1', 'ready'], {
    hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: signal },
  });
  try {
    await ready;
  } finally {
    fs.writeFileSync(`${signal}.go`, '');
    assert.equal((await writer).code, 0);
  }
});

test('submitted wakes a live waiter with one event JSON line, even with --json', async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const result = await waiting(t, h, { automation: false, args: ['--types', 'submitted', '--json'] });
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', 'abcdef1']);
  const e = await event(result, 'submitted');
  assert.equal(e.detail.sha, 'abcdef1');
  assert.equal(log(h).find((x) => x.id === e.id).type, e.type);
});

test('accepted wakes after gates pass; a refused accept emits nothing', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  submit(h);
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  const result = await waiting(t, h, { automation: true, args: ['--types', 'accepted'], seconds: 300 });
  const count = log(h).length;
  assert.equal(h.run(['accept', 'T1']).code, 1);
  assert.equal(log(h).length, count);
  gates(h);
  await event(result, 'accepted');
});

test('review and software gate pass or failure wake as evidence with their verdicts', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  submit(h, ['--pr', '9']);
  for (const type of ['review', 'tests', 'clean', 'ci']) {
    for (const ok of [true, false]) {
      const result = await waiting(t, h, { automation: false, args: ['--types', 'evidence', '--task', 'T1'], seconds: 300 });
      if (type === 'review') h.ok(['evidence', 'T1', '--agent', 'reviewer', '--type', type, '--sha', h.sha, '--revision', h.revision(), ok ? '--ok' : '--fail']);
      else gateEvidence(h, type, 'gate-runner', ok);
      const e = await event(result, 'evidence');
      assert.equal(e.detail.type, type);
      assert.equal(e.detail.ok, ok);
      assert.equal(e.detail.sha, h.sha);
      assert.equal(e.agent, type === 'review' ? 'reviewer' : 'gate-runner');
      if (type !== 'review') {
        assert.equal(e.cmd, `check ${type}`);
        assert.equal(e.detail.source, `check ${type}`);
        assert.ok(e.detail.commands.length > 0);
      }
    }
  }
});

test('rework wakes and carries the reason', async (t) => {
  const h = setup(t);
  submit(h);
  const result = await waiting(t, h, { automation: false, args: ['--types', 'rework'] });
  h.ok(['rework', 'T1', '--reason', 'simplify it']);
  assert.equal((await event(result, 'rework')).detail.reason, 'simplify it');
});

test('confirmed merge gate wakes; a failed gate never produces merged', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  submit(h, ['--pr', '9']);
  gates(h, true);
  h.ok(['accept', 'T1']);
  const dir = path.join(h.base, 'cli');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'gates', 'merge.js'), 'exports.run = async () => ({ ok: false, summary: "refused merge" });\n');
  const result = await waiting(t, h, { automation: false, args: ['--types', 'merged'] });
  const r = cp.spawnSync(process.execPath, [path.join(dir, 'bin', 'tower-crane.js'), 'merge', 'T1'], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!log(h).some((e) => e.type === 'merged'));
  h.ok(['merge', 'T1']);
  assert.equal((await event(result, 'merged')).detail.ref, h.sha);
});

test('a manual merge racing the merge queue under another task\'s reaction: one merges, the other confirms', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
  h.env.FIXTURE_MERGED_PER_PR = '1';
  const rounds = 10;
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(Array.from({ length: rounds * 2 - 1 }, (_, i) => ({ title: `Change ${i + 2}`, acceptance: ['works'] }))) });
  for (let i = 1; i <= rounds; i++) {
    // The lower task's reaction drains the line, so the queue merges the
    // upper task while holding only the lower task's reaction reservation.
    const [lower, upper] = [`T${i * 2 - 1}`, `T${i * 2}`];
    for (const [n, id] of [[i * 2 - 1, lower], [i * 2, upper]]) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--agent', 'worker', '--sha', h.sha, '--pr', String(n)]);
      h.ok(['accept', id, '--agent', 'owner', '--reason', 'race fixture',
        ...['tests', 'clean', 'review', 'ci'].flatMap((type) => ['--waive', type])]);
    }
    const after = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
    // State call jitter spreads the two merges over each other's checks.
    const jitter = { HOOK_JITTER_MS: '15' };
    const automatic = child(t, h, ['wait', '--agent', 'orchestrator', '--after', after, '--task', upper, '--types', 'merged', '--timeout', '300'], jitter);
    // Start near the queue's move from the lower task to the upper one.
    await eventAppended(path.join(h.state, 'events.jsonl'), (event) => event.type === 'merged' && event.task === lower, { signal: t.signal });
    await new Promise((resolve) => setTimeout(resolve, (i % 5) * 120)); // wait-allow: stagger concurrent operations to exercise both race orderings
    const manual = await h.runAsync(['merge', upper], { hooks: jitter });
    assert.equal(manual.code, 0, `${upper}: ${manual.stderr}`);
    await event(automatic, 'merged', upper);
    const stops = log(h).filter((e) => (e.cmd === 'merge queue' && (e.detail.blocked || e.detail.error))
      || (e.cmd === 'automation' && [lower, upper].includes(e.task) && !['running', 'done'].includes(e.detail.phase)));
    assert.deepEqual(stops, [], `${upper}: the queue never stops on the manual merge`);
    const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    for (const [n, id] of [[i * 2 - 1, lower], [i * 2, upper]]) {
      assert.equal(calls.filter((a) => a[0] === 'pr' && a[1] === 'merge' && a[2] === String(n)).length, 1, `${id}: GitHub merged once`);
    }
    const merges = h.readState('tasks.json').tasks.find((x) => x.id === upper).evidence.filter((e) => e.type === 'merge');
    assert.ok(merges.length && merges.every((e) => e.ok), `${upper}: ${JSON.stringify(merges)}`);
  }
});

test('a manual merge named by a lowercase id releases the reservation it took', (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  submit(h, ['--pr', '9']);
  gates(h, true);
  h.ok(['accept', 'T1']);
  h.ok(['merge', 't1']);
  const receipts = log(h).filter((e) => e.cmd === 'automation');
  assert.deepEqual(receipts.map((e) => [e.task, e.detail.phase]), [['T1', 'running'], ['T1', 'done']]);
  assert.equal(receipts[0].detail.source, receipts[1].detail.source);
});

test('a manual merge racing an automatic merge of the same task: one merges, the other confirms, 30 of 30', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
  const winners = { automation: 0, manual: 0 };
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(Array.from({ length: 29 }, (_, i) => ({ title: `Change ${i + 2}`, acceptance: ['works'] }))) });
  for (let i = 1; i <= 30; i++) {
    const id = `T${i}`;
    h.env.FIXTURE_MERGED = path.join(h.base, `merged-${i}`);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--agent', 'worker', '--sha', h.sha, '--pr', String(i)]);
    h.ok(['accept', id, '--agent', 'owner', '--reason', 'race fixture',
      ...['tests', 'clean', 'review', 'ci'].flatMap((type) => ['--waive', type])]);
    // The waiter's startup reconciliation merges the accepted task while the
    // manual merge starts, so both reach the merge gate together. The cursor
    // keeps a manual merge that finishes before the waiter starts visible.
    // Odd rounds start together; even rounds stagger the manual merge, so
    // either side reaches GitHub first.
    const after = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
    const automatic = child(t, h, ['wait', '--agent', 'orchestrator', '--after', after, '--task', id, '--types', 'merged', '--timeout', '300']);
    await new Promise((resolve) => setTimeout(resolve, i % 2 ? 0 : (i % 10) * 20)); // wait-allow: stagger concurrent operations to exercise both race orderings
    const manual = await h.runAsync(['merge', id]);
    assert.equal(manual.code, 0, `${id}: ${manual.stderr}`);
    const woke = await event(automatic, 'merged', id);
    assert.equal(woke.detail.ref, h.sha);
    const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter((a) => a[0] === 'pr' && a[1] === 'merge' && a[2] === String(i)).length, 1, `${id}: GitHub merged once`);
    const task = h.readState('tasks.json').tasks.find((x) => x.id === id);
    const merges = task.evidence.filter((e) => e.type === 'merge');
    assert.ok(merges.length && merges.every((e) => e.ok), `${id}: ${JSON.stringify(merges)}`);
    assert.match(merges[0].summary, /^merged PR/);
    if (merges.length > 1) assert.match(merges[1].summary, /already merged/, 'the later merge confirms the head');
    winners[merges[0].via === 'automation' ? 'automation' : 'manual']++;
    const receipts = log(h).filter((e) => e.cmd === 'automation' && e.task === id && e.detail.phase !== 'running');
    assert.deepEqual(receipts.filter((e) => e.detail.phase !== 'done'), [], `${id}: no automatic failure`);
  }
  t.diagnostic(`merged first: automation ${winners.automation}, manual ${winners.manual}`);
});

test('worker messages use recipient and task filters, and can resume by id or offset', async (t) => {
  const h = setup(t);
  const result = await waiting(t, h, { automation: false, args: ['--task', 'T1', '--types', 'worker-message'] });
  h.ok(['msg', '--agent', 'worker', '--task', 'T1', '--to', 'another-agent', 'other recipient']);
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', 'other task']);
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', 'need input\nnext line'], { env: { TOWER_CRANE_TASK: 'T1' } });
  const first = await event(result, 'worker-message');
  assert.equal(first.detail.text, 'need input\nnext line');
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'during handling']);
  for (const after of [first.id, String(first.offset)]) {
    const replay = h.run(['wait', '--agent', 'orchestrator', '--after', after, '--types', 'worker-message', '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
    const e = await event(Promise.resolve(replay), 'worker-message');
    assert.equal(e.detail.text, 'during handling');
  }
  const direct = h.run(['wait', '--agent', 'orchestrator', '--after', '0', '--for', 'another-agent', '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(JSON.parse(direct.stdout).detail.text, 'other recipient');
});

test('owner task comment wakes, worker progress notes are not owner comments', async (t) => {
  const h = setup(t);
  const result = await waiting(t, h, { automation: false, args: ['--types', 'owner-comment'] });
  h.ok(['task', 'note', 'T1', 'progress', '--agent', 'worker']);
  h.ok(['task', 'note', 'T1', 'please explain this', '--agent', 'owner']);
  assert.equal((await event(result, 'owner-comment')).detail.text, 'please explain this');
});

test('owner decision comment wakes its blocked task', async (t) => {
  const h = setup(t);
  h.ok(['ask', '--question', 'which?', '--blocks', 'T1']);
  const result = await waiting(t, h, { automation: false, args: ['--task', 'T1', '--types', 'owner-comment'] });
  h.ok(['decision', 'note', 'D1', 'new context', '--agent', 'owner']);
  const e = await event(result, 'owner-comment', null);
  assert.equal(e.detail.decision, 'D1');
  assert.equal(h.readState('decisions.json').decisions[0].notes[0].text, 'new context');
});

test('decision answer wakes its blocked task with the answer', async (t) => {
  const h = setup(t);
  h.ok(['ask', '--question', 'which?', '--option', 'a', '--option', 'b', '--blocks', 'T1']);
  const result = await waiting(t, h, { automation: false, args: ['--task', 'T1', '--types', 'decision-answer'] });
  h.ok(['answer', 'D1', '--choice', 'b']);
  assert.equal((await event(result, 'decision-answer', null)).detail.choice, 'b');
});

test('owner-done wakes and clears the owner request', async (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'credentials']);
  const result = await waiting(t, h, { automation: false, args: ['--types', 'owner-done'] });
  assert.equal(h.run(['owner-done', 'T1', '--agent', 'worker']).code, 1);
  h.ok(['owner-done', 'T1', '--note', 'provided']);
  assert.equal((await event(result, 'owner-done')).detail.note, 'provided');
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
});

test('worker progress, decision requests and releases wake without a notification allowlist', async (t) => {
  const h = setup(t);
  const progress = await waiting(t, h, { automation: false });
  h.ok(['task', 'note', 'T1', 'progress', '--agent', 'worker']);
  assert.equal((await event(progress, 'task note')).agent, 'worker');
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const request = await waiting(t, h, { automation: false, args: ['--task', 'T1', '--types', 'decision-opened'] });
  h.ok(['ask', '--question', 'Need owner input', '--option', 'yes', '--option', 'no', '--blocks', 'T1', '--agent', 'worker']);
  assert.equal((await event(request, 'decision-opened', null)).detail.decision, 'D1');
  const release = await waiting(t, h, { automation: false, args: ['--task', 'T1', '--types', 'released'] });
  h.ok(['release', 'T1', '--reason', 'waiting on D1', '--agent', 'worker']);
  await event(release, 'released');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  assert.deepEqual(h.json(['ready']).ready, [], 'the unanswered decision still blocks the task');
});

test('a killed spawned claimant wakes concurrent waiters once, without release', async (t) => {
  const h = setup(t);
  const script = path.join(h.base, 'worker.js');
  const claimed = path.join(h.base, 'claimed');
  fs.writeFileSync(script, `const cp = require('node:child_process'); const fs = require('node:fs');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', process.env.TOWER_CRANE_TASK], { env: process.env });
if (r.status !== 0) process.exit(1);
console.log('worker alive'); fs.writeFileSync(${JSON.stringify(claimed)}, '');
setInterval(() => {}, 1000);\n`);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  commandWorker(h, [process.execPath, script]);
  const spawned = h.json(['spawn', '--task', 'T1']);
  h.workerPids.push(spawned.pid);
  await created(claimed);
  assert.equal(h.run(['release', 'T1', '--reason', 'recover', '--agent', 'orchestrator']).code, 1, 'another agent cannot release a live worker');
  const [a, b] = await Promise.all([waiting(t, h, { automation: false, args: ['--types', 'worker-exited'] }), waiting(t, h, { automation: false, args: ['--types', 'worker-exited'] })]);
  process.kill(spawned.pid, 'SIGKILL');
  h.workerPids.length = 0;
  const [ea, eb] = await Promise.all([event(a, 'worker-exited'), event(b, 'worker-exited')]);
  assert.equal(ea.id, eb.id);
  assert.equal(ea.detail.pid, spawned.pid);
  assert.equal(ea.detail.attempt, spawned.attempt);
  assert.equal(ea.detail.tail, undefined, 'exit events never persist harness output');
  assert.match(h.json(['status']).exited_claims[0].tail, /worker alive/);
  assert.equal(log(h).filter((e) => e.type === 'worker-exited').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'in_progress');
  assert.equal(h.run(['wait', '--agent', 'orchestrator', '--types', 'worker-exited', '--timeout', '0.1']).code, 2); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  const recovery = await waiting(t, h, { automation: false, args: ['--types', 'released', '--agent', 'observer'] });
  h.ok(['release', 'T1', '--reason', 'spawned worker exited', '--agent', 'orchestrator']);
  assert.equal((await event(recovery, 'released')).detail.exited_spawn.pid, spawned.pid);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  h.ok(['claim', 'T1', '--agent', 'replacement']);
  assert.equal(h.run(['wait', '--agent', 'orchestrator', '--types', 'worker-exited', '--timeout', '0.1']).code, 2, 'recovery does not report the old spawn against a replacement'); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
});

test('submitted spawned workers never emit worker-exited', async (t) => {
  const h = setup(t);
  const script = path.join(h.base, 'submit.js');
  fs.writeFileSync(script, `const cp = require('node:child_process');
for (const args of [['claim', 'T1'], ['submit', 'T1', '--sha', 'abcdef1']]) {
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { env: process.env }); if (r.status) process.exit(r.status);
}\n`);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  commandWorker(h, [process.execPath, script]);
  h.ok(['spawn', '--task', 'T1', '--wait']);
  const r = h.run(['wait', '--agent', 'orchestrator', '--types', 'worker-exited', '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.stdout), { type: 'timeout', offset: fs.statSync(path.join(h.state, 'events.jsonl')).size });
});

for (const command of ['wait', 'spend']) {
  test(`sandboxed worker ${command} does not report a hidden live worker exited`, async (t) => {
    const h = setup(t);
    const script = path.join(h.base, 'live-worker.js');
    const claimed = path.join(h.base, 'claimed');
    fs.writeFileSync(script, `const cp = require('node:child_process'); const fs = require('node:fs');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', process.env.TOWER_CRANE_TASK], { env: process.env });
if (r.status !== 0) process.exit(1);
fs.writeFileSync(${JSON.stringify(claimed)}, '');
setInterval(() => {}, 1000);\n`);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
    commandWorker(h, [process.execPath, script]);
    const live = h.json(['spawn', '--task', 'T1']);
    h.workerPids.push(live.pid);
    await created(claimed);
    h.ok(['task', 'add', '--title', 'Sandboxed worker', '--acceptance', 'works']);
    h.ok(['brief', 'set', 'T2', '-'], { input: 'stand-in\n' });
    commandWorker(h, [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
    const exited = h.json(['spawn', '--task', 'T2', '--wait']);
    const args = command === 'wait'
      ? ['wait', '--task', 'T1', '--after', '0', '--types', 'worker-exited', '--timeout', '0.1'] // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
      : ['spend', 'T2', '--from-spawn', exited.agent];
    const result = h.run([...args, '--agent', exited.agent], {
      env: { TOWER_CRANE_TASK: 'T2', TOWER_CRANE_AGENT: exited.agent },
      hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([live.pid, live.monitor_pid]) },
    });
    assert.equal(result.code, command === 'wait' ? 2 : 0, result.stderr || result.stdout);
    assert.equal(log(h).filter((e) => e.type === 'worker-exited' && e.task === 'T1').length, 0);
    assert.equal(h.readState('tasks.json').tasks[0].claim.agent, live.agent);
    assert.doesNotThrow(() => process.kill(live.pid, 0), 'the hidden worker is still alive');
  });
}

test('a spawned worker that exits before claiming wakes without waiting for a lease', async (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  commandWorker(h, [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const result = await waiting(t, h, { automation: false, args: ['--types', 'worker-exited'] });
  const started = h.json(['spawn', '--task', 'T1', '--wait']);
  const e = await event(result, 'worker-exited');
  assert.equal(e.detail.pid, started.pid);
  assert.equal(e.detail.agent, started.agent);
  assert.equal(e.detail.attempt, started.attempt);
  assert.equal(h.readState('tasks.json').tasks[0].claim, null);
  assert.equal(h.run(['wait', '--agent', 'orchestrator', '--types', 'worker-exited', '--timeout', '0.1']).code, 2); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
});

test('exit observers include attempts for spawns recorded without an attempt field', (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  commandWorker(h, [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  h.json(['spawn', '--task', 'T1', '--wait']);
  const cursor = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const hook = path.join(h.base, 'older-spawn.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = read.call(this, file, ...args);
  if (!String(file).endsWith('events.jsonl') || typeof value !== 'string') return value;
  return value.split('\\n').map((line) => {
    if (!line) return line;
    const event = JSON.parse(line);
    if (event.cmd === 'spawn') delete event.detail.attempt;
    return JSON.stringify(event);
  }).join('\\n');
};
`);
  const opts = { env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` } };
  const started = h.json(['spawn', '--task', 'T1', '--wait'], opts);
  const observed = h.json(['wait', '--agent', 'orchestrator', '--after', String(cursor), '--types', 'worker-exited', '--timeout', '300'], opts);
  assert.equal(observed.detail.pid, started.pid);
  assert.equal(observed.detail.attempt, 2);
  assert.equal(observed.detail.attempt, started.attempt);
});

test('a lease stale without progress emits stall only once across waiters', async (t) => {
  const h = setup(t);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--lease', '1', '--agent', 'worker'], { hooks: { HOOK_CLOCK_FILE: clock } });
  const result = await waiting(t, h, { automation: false, args: ['--types', 'stall'], hooks: { HOOK_CLOCK_FILE: clock } });
  fs.writeFileSync(clock, String(start + 60001));
  const e = await event(result, 'stall');
  assert.equal(e.detail.agent, 'worker');
  fs.writeFileSync(clock, String(start + 120002));
  const r = h.run(['wait', '--types', 'stall', '--timeout', '0.1', '--agent', 'worker'], { hooks: { HOOK_CLOCK_FILE: clock } }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2);
  assert.equal(log(h).filter((x) => x.type === 'stall').length, 1);
});

test('workers consume stall observations without detecting stale leases themselves', async (t) => {
  const h = setup(t);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  const hooks = { HOOK_CLOCK_FILE: clock };
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--lease', '1', '--agent', 'worker'], { hooks });
  fs.writeFileSync(clock, String(start + 60001));
  const args = ['wait', '--types', 'stall', '--after', '0', '--timeout', '0.1']; // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(h.run([...args, '--agent', 'worker'], { hooks }).code, 2);
  assert.equal(log(h).filter((e) => e.type === 'stall').length, 0);
  const observed = await event(Promise.resolve(h.run([...args, '--agent', 'orchestrator'], { hooks })), 'stall');
  const consumed = await event(Promise.resolve(h.run([...args, '--agent', 'worker'], { hooks })), 'stall');
  assert.equal(consumed.id, observed.id);
});

test('a spawned orchestrator observes stale leases under its generated identity', async (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
  const observer = h.json(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait']);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  const hooks = { HOOK_CLOCK_FILE: clock };
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--lease', '1', '--agent', 'worker'], { hooks });
  fs.writeFileSync(clock, String(start + 60001));
  const result = h.run(['wait', '--agent', observer.agent, '--types', 'stall', '--timeout', '0.1'], { // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
    env: { TOWER_CRANE_TASK: 'T1', TOWER_CRANE_AGENT: observer.agent }, hooks,
  });
  assert.equal((await event(Promise.resolve(result), 'stall')).agent, observer.agent);
});

test('worker progress after lease expiry postpones stall until progress is stale', async (t) => {
  const h = setup(t);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  const hooks = { HOOK_CLOCK_FILE: clock };
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--lease', '1', '--agent', 'worker'], { hooks });
  fs.writeFileSync(clock, String(start + 60001));
  h.ok(['task', 'note', 'T1', 'making progress', '--agent', 'worker'], { hooks });
  const r = h.run(['wait', '--agent', 'orchestrator', '--types', 'stall', '--timeout', '0.1'], { hooks }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2, r.stderr || r.stdout);
  fs.writeFileSync(clock, String(start + 120002));
  const e = h.run(['wait', '--agent', 'orchestrator', '--types', 'stall', '--timeout', '0.1'], { hooks }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  await event(Promise.resolve(e), 'stall');
});

test('an observer waiting for the state lock does not block its timeout', async (t) => {
  const h = setup(t, ['--lease-minutes', '1']);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  const hooks = { HOOK_CLOCK_FILE: clock };
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--agent', 'worker'], { hooks });
  const paused = path.join(h.base, 'paused');
  const ready = created(paused);
  const writer = child(t, h, ['task', 'note', 'T1', 'owner comment'], { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused });
  await ready;
  fs.writeFileSync(clock, String(start + 60001));
  const before = performance.now();
  const r = h.run(['wait', '--agent', 'orchestrator', '--types', 'stall', '--timeout', '0.1'], { hooks }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { type: 'timeout', offset: fs.statSync(path.join(h.state, 'events.jsonl')).size });
  assert.ok(performance.now() - before < 2000, 'timeout is not held by the lock retry deadline'); // wait-allow: verify the CLI timeout is independent of state-lock contention
  fs.writeFileSync(`${paused}.go`, '');
  assert.equal((await writer.result).code, 0);
});

test('startup reconciliation with an active PR does not hold a timeout behind the state lock', async (t) => {
  const h = setup(t);
  h.sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  submit(h, ['--pr', '7']);
  const paused = path.join(h.base, 'paused');
  const ready = created(paused);
  const writer = child(t, h, ['task', 'note', 'T1', 'owner comment'], { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused });
  await ready;
  try {
    const before = performance.now();
    const result = h.run(['wait', '--agent', 'orchestrator', '--types', 'never', '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).type, 'timeout');
    assert.ok(performance.now() - before < 2000, 'reconciliation waits for another notification rather than blocking'); // wait-allow: verify reconciliation does not block the CLI timeout
    assert.equal(log(h).filter((e) => e.cmd === 'automation reconcile').length, 0);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    assert.equal((await writer.result).code, 0);
  }
});

test('timeout and invalid cursors have bounded exits and default now ignores history', async (t) => {
  const h = setup(t);
  h.ok(['msg', '--to', 'orchestrator', 'already handled']);
  const r = h.run(['wait', '--agent', 'orchestrator', '--timeout', '0.05', '--json']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.stdout), { type: 'timeout', offset: fs.statSync(path.join(h.state, 'events.jsonl')).size });
  assert.equal(r.stderr, '');
  for (const args of [['--timeout', '-1'], ['--after', 'unknown'], ['--after', '1'], ['--after', '999999999'], ['--types', ','], ['--for', '']]) {
    assert.equal(h.run(['wait', ...args]).code, 2, args.join(' '));
  }
});

test('startup takes a current cursor before reading state and retains events during reconciliation', async (t) => {
  const h = setup(t);
  h.ok(['msg', '--to', 'orchestrator', 'historical message', '--agent', 'worker']);
  const snapshot = h.run(['wait', '--agent', 'orchestrator', '--timeout', '0']);
  assert.equal(snapshot.code, 2, snapshot.stderr);
  const cursor = JSON.parse(snapshot.stdout);
  assert.equal(cursor.type, 'timeout');
  assert.equal(cursor.offset, fs.statSync(path.join(h.state, 'events.jsonl')).size);
  h.json(['status']);
  h.ok(['task', 'note', 'T1', 'during state reconciliation']);
  const r = h.run(['wait', '--agent', 'orchestrator', '--after', String(cursor.offset), '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal((await event(Promise.resolve(r), 'owner-comment')).detail.text, 'during state reconciliation');
});

test('startup snapshots leave stale leases for the subsequent blocking wait to observe', async (t) => {
  const h = setup(t);
  const clock = path.join(h.base, 'clock');
  const start = Date.now();
  const hooks = { HOOK_CLOCK_FILE: clock };
  fs.writeFileSync(clock, String(start));
  h.ok(['claim', 'T1', '--lease', '1', '--agent', 'worker'], { hooks });
  fs.writeFileSync(clock, String(start + 60001));
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const snapshot = h.run(['wait', '--agent', 'orchestrator', '--timeout', '0'], { hooks });
  assert.equal(snapshot.code, 2, snapshot.stderr || snapshot.stdout);
  const cursor = JSON.parse(snapshot.stdout);
  assert.equal(cursor.type, 'timeout');
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  const r = h.run(['wait', '--agent', 'orchestrator', '--after', String(cursor.offset), '--types', 'stall', '--timeout', '0.1'], { hooks }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal((await event(Promise.resolve(r), 'stall')).agent, 'orchestrator');
});

test('wait skips its own writes and advances timeout cursors past filtered events', async (t) => {
  const h = setup(t);
  const after = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  h.ok(['task', 'note', 'T1', 'own progress', '--agent', 'orchestrator']);
  h.ok(['msg', '--to', 'orchestrator', 'own message', '--agent', 'orchestrator']);
  h.ok(['msg', '--to', 'someone-else', 'other recipient', '--agent', 'worker']);
  const r = h.run(['wait', '--agent', 'orchestrator', '--after', String(after), '--timeout', '0.05']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(r.code, 2, r.stdout || r.stderr);
  const cursor = JSON.parse(r.stdout);
  assert.equal(cursor.type, 'timeout');
  assert.equal(cursor.offset, fs.statSync(path.join(h.state, 'events.jsonl')).size);
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'worker result', '--agent', 'worker']);
  const result = h.run(['wait', '--agent', 'orchestrator', '--after', String(cursor.offset), '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal((await event(Promise.resolve(result), 'worker-message')).detail.text, 'worker result');
});

test('owner identity waits retain owner comments, answers, owner-done and messages', async (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'access']);
  h.ok(['ask', '--question', 'which?', '--option', 'a', '--option', 'b', '--blocks', 'T1']);
  const snapshot = h.run(['wait', '--agent', 'owner', '--timeout', '0']);
  assert.equal(snapshot.code, 2, snapshot.stderr);
  let after = JSON.parse(snapshot.stdout).offset;
  for (const [args, type, task] of [
    [['task', 'note', 'T1', 'owner task comment'], 'owner-comment', 'T1'],
    [['decision', 'note', 'D1', 'owner decision comment'], 'owner-comment', null],
    [['answer', 'D1', '--choice', 'b'], 'decision-answer', null],
    [['owner-done', 'T1', '--note', 'provided'], 'owner-done', 'T1'],
    [['msg', '--to', 'orchestrator', '--task', 'T1', 'owner message'], 'worker-message', 'T1'],
  ]) {
    h.ok([...args, '--agent', 'owner']);
    const r = h.run(['wait', '--agent', 'owner', '--after', String(after), '--task', 'T1', '--types', type, '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
    const e = await event(Promise.resolve(r), type, task);
    assert.equal(e.agent, 'owner');
    after = e.offset;
  }
});

for (const hook of ['HOOK_NO_WATCH', 'HOOK_SILENT_WATCH']) {
  test(`stat fallback wakes when directory notifications fail (${hook})`, async (t) => {
    const h = setup(t);
    const result = await waiting(t, h, { automation: false, args: ['--types', 'worker-message'], hooks: { [hook]: '1' } });
    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'fallback']);
    await event(result, 'worker-message');
  });
}

async function board(t, h) {
  const c = child(t, h, ['serve', '--port', '0', '--json'], { TOWER_CRANE_AGENT: h.serveAgent || 'owner' });
  const [data] = await once(c.p.stdout, 'data');
  return JSON.parse(String(data));
}

test('non-owner serve hides owner forms and refuses all owner write routes', async (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'access']);
  h.ok(['ask', '--question', 'which?', '--option', 'a', '--option', 'b', '--blocks', 'T1']);
  h.serveAgent = 'worker-evil';
  const { url } = await board(t, h);
  const page = await (await fetch(url)).text();
  const token = /<meta name="tower-crane-token" content="([0-9a-f]{48})?">/.exec(page)[1] || '';
  assert.doesNotMatch(page, /data-api="\/api\/(?:tasks|decisions)\//);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (const [route, body] of [
    ['tasks/T1/comments', { text: 'forged task comment' }],
    ['decisions/D1/comments', { text: 'forged decision comment' }],
    ['decisions/D1/answer', { choice: 'b' }],
    ['tasks/T1/owner-done', { note: 'forged owner action' }],
  ]) {
    const response = await fetch(`${url}api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tower-crane-token': token },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${route}: ${await response.text()}`);
  }
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, 'access');
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
});

for (const agent of ['orchestrator', 'owner']) {
  test(`serve posts task and decision comments, answers and owner-done to ${agent} waits through locked CLI functions`, async (t) => {
    const h = setup(t);
    h.ok(['task', 'update', 'T1', '--needs-owner', 'access']);
    h.ok(['ask', '--question', 'which?', '--option', 'a', '--option', 'b', '--blocks', 'T1']);
    const { url, open } = await board(t, h);
    const page = await (await fetch(open)).text();
    const token = /<meta name="tower-crane-token" content="([0-9a-f]{48})">/.exec(page)[1];
    assert.match(page, /data-api="\/api\/tasks\/T1\/comments"/);
    assert.match(page, /data-api="\/api\/decisions\/D1\/answer"/);
    for (const [route, body, type, task] of [
      ['tasks/T1/comments', { text: 'UI task comment <script>' }, 'owner-comment', 'T1'],
      ['decisions/D1/comments', { text: 'UI decision comment' }, 'owner-comment', null],
      ['decisions/D1/answer', { choice: 'b', note: 'UI answer' }, 'decision-answer', null],
      ['tasks/T1/owner-done', { note: 'UI done' }, 'owner-done', 'T1'],
    ]) {
      const result = await waiting(t, h, { automation: false, args: ['--agent', agent, '--task', 'T1', '--types', type] });
      const response = await fetch(`${url}api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.text());
      assert.equal((await event(result, type, task)).agent, 'owner');
    }
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null);
    assert.equal(h.readState('decisions.json').decisions[0].answer, 'b');
    const rendered = await (await fetch(url)).text();
    assert.match(rendered, /UI task comment &lt;script&gt;/);
    assert.match(rendered, /UI decision comment/);
    h.ok(['msg', '--to', 'orchestrator', 'worker news', '--agent', 'worker']);
    assert.match(await (await fetch(url)).text(), /worker news/);
    const count = log(h).length;
    for (const [route, body] of [['tasks/T99/comments', { text: 'missing' }], ['decisions/D1/answer', { choice: 'a' }], ['tasks/T1/comments', { text: '' }]]) {
      const response = await fetch(`${url}api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) });
      assert.ok(response.status >= 400);
    }
    const crossSite = await fetch(`${url}api/tasks/T1/comments`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.invalid' }, body: '{"text":"cross-site"}' });
    assert.equal(crossSite.status, 403);
    assert.equal(log(h).length, count, 'refused writes emit no event');
  });
}

test('serve preserves an owner comment fragmented inside UTF-8 bytes', async (t) => {
  const h = setup(t);
  const { url, open } = await board(t, h);
  const page = await (await fetch(open)).text();
  const token = /<meta name="tower-crane-token" content="([0-9a-f]{48})">/.exec(page)[1];
  const text = 'שלום 😀';
  const body = Buffer.from(JSON.stringify({ text }));
  const split = body.indexOf(Buffer.from('😀')) + 1;
  const result = await waiting(t, h, { automation: false, args: ['--types', 'owner-comment'] });
  const reply = await new Promise((resolve, reject) => {
    const req = http.request(`${url}api/tasks/T1/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tower-crane-token': token },
    }, (res) => {
      let raw = '';
      res.on('data', (data) => { raw += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    // Deliver the continuation as another network chunk, splitting the emoji.
    setTimeout(() => req.end(body.subarray(split)), 25); // wait-allow: stagger concurrent operations to exercise both race orderings
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.text, text);
  assert.equal((await event(result, 'owner-comment')).detail.text, text);
});
