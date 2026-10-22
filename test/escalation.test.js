'use strict';

// Escalation up a tier range: preload paths, completion waits, ranges, the
// triggers that climb and those that stay, refused and pending climbs, lost
// supervisors and worker cleanup before a review climb. escalation-gates.test.js
// has gate failures, reviewers and the range ceiling.

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { killPid, waitUntil } = require('./signals');
const { events, preloadOption, until, setup } = require('./escalation-helpers');

test('preload paths preserve spaces and Windows backslashes in NODE_OPTIONS', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(require('./helpers').TMP_ROOT, 'escalation-preload-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [
    path.join(dir, 'process signal.cjs'),
    path.join(dir, process.platform === 'win32' ? 'process-signal.cjs' : 'D:\\a temp\\tower-crane-tests\\process-signal.cjs'),
  ];
  for (const file of files) {
    fs.writeFileSync(file, 'process.env.ESCALATION_PRELOAD_PATH = __filename;\n');
    const result = cp.spawnSync(process.execPath, ['-p', 'process.env.ESCALATION_PRELOAD_PATH'], {
      env: { ...process.env, NODE_OPTIONS: preloadOption(file) }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), file);
  }
});

test('escalation completion follows file notifications even after the old deadline', async (t) => {
  const dir = fs.mkdtempSync(path.join(require('./helpers').TMP_ROOT, 'escalation-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'complete');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let probes = 0;
  const completed = until(t, [dir], () => {
    probes++;
    return fs.existsSync(file);
  });
  assert.equal(probes, 1);
  t.mock.timers.tick(60000);
  await Promise.resolve();
  fs.writeFileSync(file, '');
  await completed;
  await until(t, [dir], () => fs.existsSync(file));
});

function attemptError(h, code) {
  const hook = path.join(__dirname, 'fixtures', 'escalation-attempt-error.js');
  h.env.NODE_OPTIONS += ` ${preloadOption(hook)}`;
  h.env.HOOK_ESCALATION_ATTEMPTS = h.attempts;
  h.env.HOOK_ESCALATION_ATTEMPT_ERROR = code;
}

test('a replacement worker retries Windows sharing errors when recording its attempt', async (t) => {
  const h = await setup(t, 'exit', 'easy..medium', (repo) => attemptError(repo, 'EPERM'));
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.deepEqual(h.readAttempts().map((attempt) => attempt.rung), ['easy', 'medium']);
  assert.equal(fs.readFileSync(h.attempts + '.errors', 'utf8'), 'EPERM\nEACCES\nEBUSY\n');
  assert.equal(h.openDecisions().length, 0);
});

test('a worker exiting before its attempt record fails the submission wait at the ceiling with its log', async (t) => {
  const h = await setup(t, 'exit', 'easy..medium', (repo) => attemptError(repo, 'ENOENT'));
  h.ok(['spawn', '--task', 'T1']);
  await assert.rejects(h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted'),
    /Unexpected escalation ceiling:[\s\S]*worker exit without submit \(code 1\)[\s\S]*ENOENT: attempt publication/);
  assert.deepEqual(h.readAttempts().map((attempt) => attempt.rung), ['easy']);
  assert.ok(events(h).some((event) => event.cmd === 'claim' && event.agent === 'worker-T1-2'));
});

test('an expected ceiling published between wait reads completes without a false failure', async (t) => {
  const h = await setup(t, 'top', 'easy..medium');
  h.ok(['spawn', '--task', 'T1']);
  await until(t, [h.state, h.base], () => h.openDecisions().length === 1);
  const readDecisions = h.openDecisions;
  let reads = 0;
  // Reproduce a reader just before publication followed by one after publication.
  t.mock.method(h, 'openDecisions', () => ++reads === 1 ? [] : readDecisions());
  await h.until(() => h.openDecisions().length === 1);
  assert.equal(reads, 2);
  assert.deepEqual(h.readAttempts().map((attempt) => attempt.rung), ['easy', 'medium']);
});

test('tier ranges start low; invalid and reversed ranges are refused without state writes', async (t) => {
  const h = await setup(t);
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(preview.rung, 'easy');
  assert.equal(preview.resumed, false);
  assert.deepEqual(h.json(['task', 'show', 'T1']).tier_range, { min: 'easy', max: 'medium' });
  const before = events(h).length;
  for (const tier of ['hard..easy', 'easy..unknown', 'easy..medium..hard']) {
    assert.notEqual(h.run(['task', 'update', 'T1', '--tier', tier]).code, 0);
  }
  assert.equal(events(h).length, before);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  assert.equal(h.json(['task', 'show', 'T1']).tier_range, undefined);
  const plan = [{ title: 'Imported range', tier: 'medium..research', acceptance: ['starts medium'] }];
  h.ok(['plan', 'import', '-'], { input: JSON.stringify(plan) });
  assert.equal(h.json(['task', 'show', 'T2']).tier, 'medium');
});

test('manual range changes use tier authority even when clearing the range at its current rung', async (t) => {
  const h = await setup(t);
  const before = events(h).length;
  for (const tier of ['easy', 'easy..hard']) {
    const result = h.run(['task', 'update', 'T1', '--tier', tier, '--agent', 'worker-bounds']);
    assert.equal(result.code, 1, 'workers must not change a planned range');
    assert.match(result.stderr, /task.tier.*operational/);
  }
  assert.equal(events(h).length, before);
  assert.deepEqual(h.json(['task', 'show', 'T1']).tier_range, { min: 'easy', max: 'medium' });
  h.ok(['task', 'update', 'T1', '--tier', 'easy', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).tier_range, undefined);
});

for (const trigger of ['exit', 'preclaim', 'stall', 'review']) {
  test(`${trigger} climbs one rung automatically with a fresh session and unknown adapter spend`, {
    skip: trigger === 'stall' && process.platform !== 'linux' && 'CPU stall observation needs Linux',
  }, async (t) => {
    const h = await setup(t, trigger);
    h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: {
      'fixture-light': { input: 1, cache_write: 1, cache_read: 1, output: 1 },
    } })]);
    h.ok(['spawn', '--task', 'T1']);
    if (trigger === 'review') {
      await h.until(() => h.task().status === 'submitted');
      h.reviewer('T1', 'reviewer');
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer']);
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
        '--agent', 'worker-T1-1']);
      assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
      h.ok(['evidence', 'T1', '--type', 'review', '--revision', h.revision(), '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
        '--agent', 'reviewer', '--summary', 'incorrect boundary']);
      const cursor = String(StateFiles.logEnd(h.state));
      const host = await h.runAsync(['wait', '--after', cursor, '--types', 'submitted', '--task', 'T1',
        '--timeout', '300', '--agent', 'orchestrator']);
      assert.equal(host.code, 0, host.stderr || host.stdout);
    }
    await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
    const attempts = h.readAttempts();
    assert.deepEqual(attempts.map((a) => a.rung), ['easy', 'medium']);
    assert.equal(attempts[1].previous, '');
    assert.notEqual(attempts[1].agent, attempts[0].agent);
    assert.notEqual(attempts[1].session, attempts[0].session);
    assert.equal(attempts[1].cwd, attempts[0].cwd);
    const climb = events(h).find((e) => e.cmd === 'escalate');
    assert.equal(climb.detail.trigger, trigger === 'preclaim' ? 'exit' : trigger);
    assert.equal(climb.detail.from, 'easy');
    assert.equal(climb.detail.to, 'medium');
    const task = h.json(['task', 'show', 'T1']);
    assert.deepEqual(task.spend_by_rung.easy, { tokens: null, cost_usd: null });
    assert.ok(task.escalations[0].reason);
    h.ok(['recover', 'T1']);
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
  });
}

for (const trigger of ['outage', 'refusal']) {
  test(`${trigger} exhaustion stays at the same rung, including after exit observation`, async (t) => {
    const h = await setup(t, trigger);
    h.ok(['spawn', '--task', 'T1']);
    await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
    const observed = await h.runAsync(['wait', '--observe', '--after', '0', '--types', 'worker-exited', '--agent', 'orchestrator']);
    assert.equal(observed.code, 0, observed.stderr || observed.stdout);
    h.ok(['recover', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
    assert.equal(h.readAttempts().length, 1);
  });
}

test('a refused climb stays pending and concurrent recovery dispatches only one replacement', async (t) => {
  const h = await setup(t);
  const command = h.readState('project.json').ladder.medium.command;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify([path.join(h.base, 'missing-worker')])]);
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => h.task().escalation_pending === true);
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify(command)]);
  const results = await Promise.all([
    h.runAsync(['recover', 'T1', '--agent', 'recovery-a']),
    h.runAsync(['recover', 'T1', '--agent', 'recovery-b']),
  ]);
  assert.ok(results.every((r) => r.code === 0), results.map((r) => r.stderr).join('\n'));
  await h.until(() => h.task().status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

// The wait host's recovery dispatches a pending climb with one try at the
// dispatch lock: another dispatch holding it must not stall the host's events
// or its signal drain, and the next pass dispatches the climb once it is free.
test('a pending climb at a held dispatch lock stalls neither the wait host nor its signal drain', async (t) => {
  const h = await setup(t);
  const S = require('../lib/state');
  const command = h.readState('project.json').ladder.medium.command;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify([path.join(h.base, 'missing-worker')])]);
  const first = h.json(['spawn', '--task', 'T1']);
  const { exited } = await h.exitSignal({ pid: first.monitor_pid });
  await h.until(() => h.task().escalation_pending === true);
  // The first worker's monitor tries the climb itself. Restored before it
  // exits, the ladder would let that monitor climb outside the wait below.
  await exited;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify(command)]);
  const dir = path.join(h.state, 'dispatch', 'lock');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const held = S.tryMarkedLock(dir, { keepLive: true });
  assert.ok(held, 'the dispatch lock is free');
  let free = false;
  const release = () => { if (!free) { free = true; S.releaseMarkedLock(held); } };
  t.after(release);
  const looked = path.join(h.base, 'dispatch-looked');
  let child;
  let closed = false;
  let out = '';
  const host = h.runAsync(['wait', '--follow', '--types', 'worker-message', '--agent', 'orchestrator'], {
    hooks: { HOOK_DISPATCH_WAITING: looked },
    onSpawn: (c) => {
      child = c;
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => { closed = true; });
    },
  });
  t.after(() => { if (!closed) child.kill('SIGKILL'); });
  const rows = () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  await waitUntil(() => fs.existsSync(looked), { paths: [h.base], alive: () => !closed, what: 'the host looks at the held dispatch lock' });
  const sent = Date.now();
  h.ok(['msg', '--to', 'orchestrator', 'still there?']);
  await waitUntil(() => rows().some((row) => row.type === 'worker-message'), { paths: [h.base], alive: () => !closed, what: 'the host reports the message' });
  assert.ok(Date.now() - sent < 30000, `the message waited ${Date.now() - sent} ms behind the dispatch lock`); // wait-allow: a host blocked on the lock answers only after its 140 s wait, the failure this bound looks for
  assert.equal(h.task().escalation_pending, true, 'the climb stays pending while the lock is held');
  assert.equal(h.readAttempts().length, 1);
  if (process.platform !== 'win32') {
    const signalled = Date.now();
    child.kill('SIGTERM');
    const result = await host;
    assert.ok(Date.now() - signalled < 30000, `the drain took ${Date.now() - signalled} ms`); // wait-allow: the same bound for the signal drain
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(rows().at(-1), { reason: 'signal', signal: 'SIGTERM', drained: 0 });
  } else {
    child.kill();
    await host;
  }
  release();
  const submitted = await h.runAsync(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator']);
  assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
});

// A drain can arrive while wait's recovery awaits one task, before it reaches
// the next climb's dispatch. That spawn refuses, so the climb stays pending
// and wait still exits with its signal report rather than an error.
test('a drain during wait\'s recovery leaves the climb pending and wait reports the signal', {
  skip: process.platform === 'win32' ? 'Windows process.kill does not deliver POSIX signals' : false,
}, async (t) => {
  const h = await setup(t);
  const command = h.readState('project.json').ladder.medium.command;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify([path.join(h.base, 'missing-worker')])]);
  const first = h.json(['spawn', '--task', 'T1']);
  const { exited } = await h.exitSignal({ pid: first.monitor_pid });
  await h.until(() => h.task().escalation_pending === true);
  // The first worker's monitor tries the climb itself. Restored before it
  // exits, the ladder would let that monitor climb outside the wait below.
  await exited;
  h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify(command)]);
  const attempts = h.readAttempts().length;
  const preload = path.join(h.base, 'drain-during-recovery.js');
  // The first recovery call signals wait, then awaits the drain as an earlier
  // recovery's agent startup would, so the climb's dispatch runs drained.
  // Refill runs beside recovery and would dispatch the pending climb itself,
  // so it waits for the same drain: only recovery's dispatch is under test.
  fs.writeFileSync(preload, `const E = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'escalation.js'))});
const A = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation.js'))});
const drained = (drain) => (drain.aborted ? null : new Promise((resolve) => drain.addEventListener('abort', resolve, { once: true })));
const recover = E.recover;
let first = true;
E.recover = async (ctx) => {
  if (first) {
    first = false;
    process.kill(process.pid, 'SIGTERM');
    await drained(ctx.automationSignal);
  }
  return recover(ctx);
};
const refill = A.refillWorkers;
A.refillWorkers = async (ctx, attempt) => {
  await drained(ctx.automationSignal);
  return refill(ctx, attempt);
};
`);
  const r = await h.runAsync(['wait', '--follow', '--types', 'worker-message', '--agent', 'orchestrator'], { pre: ['--require', preload] });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { reason: 'signal', signal: 'SIGTERM', drained: 0 });
  assert.doesNotMatch(r.stderr, /Error: wait interrupted/);
  assert.equal(h.task().escalation_pending, true, 'the climb waits for the next wait');
  assert.equal(h.readAttempts().length, attempts, 'no agent starts during the drain');
});

test('wait recovers a verified worker exit after its supervisor is lost', {
  skip: process.platform !== 'linux' && 'independent POSIX worker and monitor termination',
}, async (t) => {
  const h = await setup(t, 'hold');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => h.readAttempts().length === 1);
  const signals = await Promise.all([spawn.monitor_pid, spawn.pid].map((pid) => h.exitSignal({ pid })));
  killPid(spawn.monitor_pid, 'SIGKILL');
  killPid(spawn.pid, 'SIGKILL');
  await Promise.all(signals.map(({ exited }) => exited));
  const observed = await h.runAsync(['wait', '--after', '0', '--types', 'worker-exited', '--agent', 'orchestrator']);
  assert.equal(observed.code, 0, observed.stderr || observed.stdout);
  await h.until(() => h.task().status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
});

test('lost-supervisor recovery waits for redirected orphan descendants to stop', {
  skip: process.platform !== 'linux' && 'Linux process group observation',
}, async (t) => {
  const h = await setup(t, 'orphan');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => fs.existsSync(h.attempts + '.ready'));
  const P = require('../lib/processes');
  const pid = Number(fs.readFileSync(h.attempts + '.ready', 'utf8'));
  const child = { pid, ...P.identity(pid) };
  try {
    const signals = await Promise.all([spawn.monitor_pid, spawn.pid].map((pid) => h.exitSignal({ pid })));
    killPid(spawn.monitor_pid, 'SIGKILL');
    killPid(spawn.pid, 'SIGKILL');
    await Promise.all(signals.map(({ exited }) => exited));
    h.ok(['spend', 'T1', '--from-spawn', spawn.agent]);
    assert.equal(P.processState(child), 'running');
    const result = h.run(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '2']); // wait-allow: observe that recovery stays blocked while the orphan is deliberately held alive
    assert.equal(result.code, 2, 'a parent exit must not dispatch while its orphan descendant is alive');
    const waiting = h.json(['recover', 'T1', '--agent', 'orchestrator']);
    assert.match(waiting.waiting, /process group.*still running/i);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn exit' && e.detail.agent === spawn.agent).length, 0);
    assert.ok(events(h).some((e) => e.cmd === 'recover waiting' && /process group/.test(e.detail.reason)));
    const { exited } = await h.exitSignal(child);
    killPid(child.pid, 'SIGKILL');
    await exited;
    const submitted = await h.runAsync(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator']);
    assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
    assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  } finally {
    if (P.processState(child) !== 'exited') killPid(child.pid, 'SIGKILL');
  }
});

test('a failed review waits for the monitor to finish cleaning submitted worker descendants', {
  skip: process.platform !== 'linux' && 'Linux process group cleanup',
}, async (t) => {
  const h = await setup(t, 'cleanup');
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => fs.existsSync(h.attempts + '.ready') && h.task().status === 'submitted');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  fs.writeFileSync(h.attempts + '.exit', '');
  await h.until(() => fs.existsSync(h.attempts + '.term'));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn exit' && e.detail.agent === 'worker-T1-1').length, 0);
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy', 'the parent exit cannot release a live process group');
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  const log = events(h);
  assert.ok(log.findIndex((e) => e.cmd === 'spawn exit' && e.detail.agent === 'worker-T1-1')
    < log.findIndex((e) => e.cmd === 'escalate'));
});

test('rework records the review climb before pending worker cleanup finishes', {
  skip: process.platform !== 'linux' && 'Linux process group cleanup',
}, async (t) => {
  const h = await setup(t, 'cleanup');
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => fs.existsSync(h.attempts + '.ready') && h.task().status === 'submitted');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  h.ok(['rework', 'T1', '--reason', 'correct the reviewed result', '--agent', 'orchestrator']);
  const pending = h.json(['task', 'show', 'T1']);
  assert.equal(pending.tier, 'medium', 'rework must preserve the failed attempt before cleanup');
  assert.equal(pending.revision, 2);
  assert.deepEqual(events(h).filter((e) => e.cmd === 'rework')
    .map((e) => [e.detail.previous_revision, e.detail.revision]), [[1, 2]]);
  assert.equal(pending.escalation_pending, true);
  assert.equal(pending.escalations[0].trigger, 'review');
  assert.equal(h.readAttempts().length, 1);
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.readAttempts().length, 1, 'recording the climb does not release the worktree');
  fs.writeFileSync(h.attempts + '.exit', '');
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});
