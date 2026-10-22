'use strict';

// Automatic dispatch: failed-review recovery, dispatch refusals, refill order,
// dispatch locks, rework holds and wait deadlines. automation-identity.test.js has the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitOnRepo, waitUntil, killPid } = require('./signals');
const { waitFor } = require('./canary');
const { setup, holdSuite, configureHarness, refillFixture } = require('./automation-helpers');

test('automation command harness temp files stay inside its fixture', (t) => {
  const h = setup(t);
  configureHarness(h);
  const script = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-child-'));
fs.writeFileSync(path.join(process.env.AUTOMATION_CONTEXT_DIR, 'tmp.json'),
  JSON.stringify({ tmp, winTmp: process.env.TMP, temp: process.env.TEMP }));
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}'])]);
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  const seen = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, 'tmp.json'), 'utf8'));
  // Remove the probe's temp directory even when containment fails.
  fs.rmSync(seen.tmp, { recursive: true, force: true });
  for (const dir of [seen.tmp, seen.winTmp, seen.temp]) {
    assert.ok(dir && path.relative(h.base, dir).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(h.base, dir)), dir);
  }
});

for (const tier of ['medium', 'easy..medium']) {
test(`automation reworks a current ${tier} failed review once with its full findings, even before software passes`, (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'update', 'T1', '--tier', tier]);
  h.submit();
  h.ok(['project', 'set', '--paused', 'inspect review findings']);
  h.reviewer('T1', 'reviewer');
  const github = h.github();
  const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
  const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:12 - handle the missing input`;
  github.comments = [{ id: 123, body, html_url: ref }];
  h.saveGithub(github);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, 2);
  const reason = h.logs().find((e) => e.cmd === 'rework').detail.reason;
  assert.ok(reason.includes(body));
  assert.ok(reason.includes(ref));
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1, 'replay never reworks the review twice');
});
}

for (const stale of ['head', 'revision', 'superseded verdict']) {
  test(`automation ignores a failed review with a stale ${stale}`, (t) => {
    const h = setup(t, { ci: 'pending' });
    h.submit();
    h.reviewer('T1', 'reviewer', stale === 'head' ? 'aaaaaaa' : h.sha);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
      '--sha', stale === 'head' ? 'aaaaaaa' : h.sha, '--fail', '--summary', 'old finding', '--agent', 'reviewer']);
    if (stale === 'revision') {
      h.ok(['rework', 'T1', '--reason', 'new revision', '--agent', 'orchestrator']);
      h.submit();
    } else if (stale === 'superseded verdict') {
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--ok', '--agent', 'reviewer']);
    }
    const before = h.logs().filter((e) => e.cmd === 'rework').length;
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, before);
  });
}

for (const tier of ['medium', 'easy..medium']) {
  for (const comment of ['missing', 'mismatched']) {
    test(`a ${tier} ${comment} linked review comment keeps the wait host running`, (t) => {
      const h = setup(t, { ci: 'pending' });
      h.ok(['task', 'update', 'T1', '--tier', tier]);
      h.submit();
      h.ok(['project', 'set', '--paused', 'inspect review refusal']);
      h.reviewer('T1', 'reviewer');
      const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
      if (comment === 'mismatched') {
        const github = h.github();
        github.comments = [{ id: 123, html_url: ref,
          body: `Review (Tower Crane) at ${'f'.repeat(40)}\nVerdict: FAIL\nwrong head` }];
        h.saveGithub(github);
      }
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
      const brief = h.ok(['brief', 'get', 'T1']);
      const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0.1', // wait-allow: verify that a refused review recovery leaves the host observing without a matching event
        '--agent', 'orchestrator']);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /linked review comment does not identify/);
      const task = h.readState('tasks.json').tasks[0];
      assert.equal(task.status, 'submitted');
      assert.equal(task.revision, 1);
      assert.equal(h.ok(['brief', 'get', 'T1']), brief);
    });
  }
}

test('observation-only waits retain ranged full-findings recovery', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  h.submit();
  h.ok(['project', 'set', '--paused', 'inspect observed recovery']);
  h.reviewer('T1', 'reviewer');
  const ref = 'https://github.com/acme/demo/pull/7#issuecomment-123';
  const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:12 - handle the missing input`;
  const github = h.github();
  github.comments = [{ id: 123, body, html_url: ref }];
  h.saveGithub(github);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
  const spawns = h.logs().filter((e) => e.cmd === 'spawn').length;
  const result = h.run(['wait', '--observe', '--after', '0', '--types', 'never', '--timeout', '0.1', // wait-allow: verify recovery during the CLI observation timeout contract
    '--agent', 'orchestrator']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.readState('tasks.json').tasks[0].revision, 2);
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
  assert.ok(h.ok(['brief', 'get', 'T1']).includes(ref));
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, spawns);
});

for (const command of ['accept', 'spawn review']) {
  test(`${command} sends a current failed review to full-findings rework instead of repeating review`, (t) => {
    const h = setup(t, { ci: 'pending' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    const ref = 'https://github.com/acme/demo/pull/7#issuecomment-456';
    const body = `Review (Tower Crane) at ${h.sha}\nVerdict: FAIL\nlib/change.js:22 - reject the empty request`;
    const github = h.github();
    github.comments = [{ id: 456, body, html_url: ref }];
    h.saveGithub(github);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
      '--fail', '--summary', 'one blocking finding', '--ref', ref, '--agent', 'reviewer']);
    const before = h.logs().filter((e) => e.cmd === 'spawn').length;
    const args = command === 'accept' ? ['accept', 'T1'] : ['spawn', '--task', 'T1', '--role', 'review'];
    const result = h.run([...args, '--agent', 'orchestrator']);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'rework');
    assert.equal(task.revision, 2);
    assert.ok(h.ok(['brief', 'get', 'T1']).includes(body));
    assert.ok(h.ok(['brief', 'get', 'T1']).includes(ref));
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, before);
    assert.equal(h.logs().filter((e) => e.cmd.startsWith('check ')).length, 0);
  });
}

test('a ranged review recovery refusal does not stop unrelated gates or worker refill', async (t) => {
  const h = refillFixture(t);
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'one blocking finding',
    '--ref', 'https://github.com/acme/demo/pull/7#issuecomment-123', '--agent', 'reviewer']);
  h.submit('T2', 'worker-2');
  const result = h.run(['wait', '--after', '0', '--types', 'spawn', '--task', 'T3',
    '--timeout', '300', '--agent', 'orchestrator']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T3');
  assert.match(result.stderr, /linked review comment does not identify/);
  await waitFor(h.marker('T3'));
  assert.ok(h.logs().some((e) => e.task === 'T2' && e.cmd === 'check tests'),
    'the unrelated submission still runs its software gates');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.revision, 1);
});

test('automation retains an exited worker claim until its lost monitor process group is empty', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const h = refillFixture(t);
  const spawn = h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator'], { env: { REFILL_ORPHAN: '1' } });
  await waitFor(`${h.marker('T1')}.orphan`, { nonempty: true });
  const orphan = Number(fs.readFileSync(`${h.marker('T1')}.orphan`, 'utf8'));
  const cursor = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn', '--timeout', '300', '--agent', 'orchestrator']);
  try {
    killPid(spawn.monitor_pid, 'SIGKILL');
    killPid(spawn.pid, 'SIGKILL');
    fs.writeFileSync(`${h.marker('T1')}.exited`, '');
    await new Promise((resolve) => setTimeout(resolve, 2200)); // wait-allow: observe slot retention across reconciliation polls while the orphan remains alive
    assert.equal(h.readState('tasks.json').tasks[0].claim?.agent, spawn.agent, 'the orphan keeps its worker slot');
    assert.equal(fs.existsSync(h.marker('T3')), false);
  } finally {
    try { killPid(orphan, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  const result = await waiting;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T3');
  await waitFor(h.marker('T3'));
});

test('automation reports unchanged dispatch refusals once and retries after the brief changes', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.ok(['task', 'add', '--title', 'Missing brief', '--acceptance', 'works', '--tier', 'easy']);
  const started = path.join(h.base, 'wait-started');
  const waiter = h.runAsync(['wait', '--types', 'spawn', '--timeout', '300', '--agent', 'orchestrator'],
    { hooks: { HOOK_WATCH_READY: started } });
  await waitFor(started);
  for (let i = 0; i < 3; i++) {
    h.ok(['task', 'note', 'T5', `unrelated progress ${i}`]);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // wait-allow: observe refusal deduplication across polling turns before changing the brief
  }
  h.ok(['brief', 'set', 'T5', '-'], { input: 'Implement the acceptance.\n' });
  const result = await waiter;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T5');
  assert.equal(result.stderr.match(/has no brief/g)?.length, 1, result.stderr);
  await waitFor(h.marker('T5'), { what: 'the changed brief retries dispatch' });
});

test('automation dispatches rework-ready work with the failed review findings', async (t) => {
  const h = refillFixture(t);
  h.ok(['task', 'update', 'T4', '--dep', 'T1']);
  // Refill does not wait for the review reaction, so other ready work would take the only slot first.
  for (const id of ['T2', 'T3']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'lib/change.js:12 - handle the missing input', '--agent', 'reviewer']);
  h.consume();
  await waitFor(h.marker('T1'), { what: 'rework is dispatched without a manual command' });
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claim.from, 'rework');
  assert.equal(task.revision, 2);
  assert.match(fs.readFileSync(`${h.marker('T1')}.prompt`, 'utf8'), /lib\/change.js:12 - handle the missing input/);
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 1);
});

for (const dispatch of ['spawn --ready', 'automation refill']) {
  test(`${dispatch} takes urgent work before tasks unblocking more work`, async (t) => {
    const h = refillFixture(t);
    h.ok(['task', 'update', 'T2', '--priority', 'urgent', '--agent', 'orchestrator']);
    if (dispatch === 'spawn --ready') {
      const result = h.json(['spawn', '--ready', '--agent', 'orchestrator']);
      assert.deepEqual(result.results.map((r) => [r.task, r.ok]), [['T2', true]]);
    } else {
      h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator']);
      await waitFor(h.marker('T1'), { what: 'first worker claims the slot' });
      fs.writeFileSync(`${h.marker('T1')}.go`, '');
      await waitFor(`${h.marker('T1')}.exited`, { what: 'first worker frees the slot' });
      const result = await h.runAsync(['wait', '--after', '0', '--task', 'T2', '--types', 'spawn', '--timeout', '300', '--agent', 'orchestrator']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).task, 'T2');
    }
    await waitFor(h.marker('T2'), { what: 'urgent worker claims the slot' });
    assert.deepEqual(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').map((e) => e.task),
      dispatch === 'spawn --ready' ? ['T2'] : ['T1', 'T2']);
  });
}

for (const trigger of ['exit', 'release --dead', 'merge']) {
  test(`automation refills after ${trigger} in unblocking-first order and concurrent watchers respect the worker limit`, async (t) => {
    const h = refillFixture(t);
    if (trigger === 'merge') {
      h.submit();
      h.reviewer('T1', 'reviewer');
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--ok', '--agent', 'reviewer']);
      const github = h.github();
      github.ci[h.sha] = 'success';
      h.saveGithub(github);
    } else {
      h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator']);
      await waitFor(h.marker('T1'), { what: 'first worker claims the slot' });
      fs.writeFileSync(`${h.marker('T1')}.go`, '');
      await waitFor(`${h.marker('T1')}.exited`);
      if (trigger === 'release --dead') {
        // Foreground observation records the exit before the explicit batch release.
        h.run(['wait', '--after', '0', '--observe', '--types', 'worker-exited', '--timeout', '300', '--agent', 'orchestrator']);
        h.ok(['release', '--dead', '--agent', 'orchestrator']);
      }
    }
    const cursor = trigger === 'release --dead' ? String(fs.statSync(path.join(h.state, 'events.jsonl')).size) : '0';
    const watchers = [h.runAsync(['wait', '--after', cursor, '--task', 'T3', '--types', 'spawn', '--timeout', '300', '--agent', 'orchestrator']),
      h.runAsync(['wait', '--after', cursor, '--task', 'T3', '--types', 'spawn', '--timeout', '300', '--agent', 'orchestrator'])];
    const results = await Promise.all(watchers);
    assert.ok(results.every((r) => r.code === 0 && JSON.parse(r.stdout).task === 'T3'), JSON.stringify(results));
    await waitFor(h.marker('T3'), { what: `the task unblocking T4 takes the free slot: ${JSON.stringify(results)}` });
    const spawns = h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
    assert.deepEqual(spawns.map((e) => e.task), trigger === 'merge' ? ['T3'] : ['T1', 'T3'],
      JSON.stringify(h.logs().filter((e) => ['spawn', 'claim', 'release', 'spawn exit'].includes(e.cmd)).map((e) => [e.cmd, e.task, e.detail.agent || e.agent])));
    const st = require('../lib/state').loadState(h.state);
    assert.equal(require('../lib/tasks').workerHolders(st, Date.now()).length, 1);
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, spawns.length);
  });
}

test('a dispatch waits for another that is still preparing the first ready task instead of taking its slot', async (t) => {
  const h = refillFixture(t);
  h.json(['spawn', '--task', 'T1', '--agent', 'orchestrator']);
  await waitFor(h.marker('T1'), { what: 'first worker claims the slot' });
  fs.writeFileSync(`${h.marker('T1')}.go`, '');
  await waitFor(`${h.marker('T1')}.exited`);
  h.run(['wait', '--after', '0', '--observe', '--types', 'worker-exited', '--timeout', '300', '--agent', 'orchestrator']);
  h.ok(['release', '--dead', '--agent', 'orchestrator']);
  // The first dispatch stops while T3's new worktree is still registered as
  // initializing, which refuses T3 to any other dispatch.
  const preparing = path.join(h.base, 'preparing-T3');
  const first = h.runAsync(['spawn', '--ready', '--agent', 'orchestrator'], { hooks: { HOOK_STOP_INITIALIZING: preparing } });
  await waitFor(preparing, { what: 'the first dispatch prepares T3' });
  const waiting = path.join(h.base, 'second-waiting');
  let secondDone = false;
  const second = h.runAsync(['spawn', '--ready', '--agent', 'orchestrator'], { hooks: { HOOK_DISPATCH_WAITING: waiting } });
  second.then(() => { secondDone = true; });
  await waitUntil(() => fs.existsSync(waiting) || secondDone, { paths: [h.base], what: 'the second dispatch neither waited nor finished' });
  fs.writeFileSync(`${preparing}.go`, '');
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.code, 0, firstResult.stderr + firstResult.stdout);
  await waitFor(h.marker('T3'), { what: 'T3 takes the free slot' });
  const spawns = h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  assert.deepEqual(spawns.map((e) => e.task), ['T1', 'T3'], secondResult.stdout + secondResult.stderr);
  assert.match(secondResult.stdout, /^T1: the workers limit is reached .*holders: T3 /m);
});

// The test process holds the dispatch lock, as a dispatch that outlasts every wait would.
function holdDispatchLock(t, h) {
  const S = require('../lib/state');
  const dir = path.join(h.state, 'dispatch', 'lock');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = S.tryMarkedLock(dir, { keepLive: true });
  assert.ok(lock, 'the dispatch lock is free');
  let held = true;
  const release = () => { if (held) { held = false; S.releaseMarkedLock(lock); } };
  t.after(release);
  return release;
}

test('a batch stops at a dispatch lock that outlasts its wait instead of dispatching lower-ranked tasks', (t) => {
  const h = refillFixture(t);
  holdDispatchLock(t, h);
  const result = h.run(['spawn', '--ready', '--agent', 'orchestrator'], { hooks: { HOOK_DISPATCH_EXPIRE: '1' } });
  assert.equal(result.code, 1, result.stderr);
  // T3 unblocks T4, so it is first; T1 and T2 are not tried.
  assert.deepEqual(result.stdout.trim().split('\n').map((line) => line.split(':')[0]), ['T3'], result.stdout);
  assert.match(result.stdout, /^T3: worker dispatch is locked by pid \d+/, result.stdout);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
});

// macOS and Windows record no start time, and a dispatch can hold the lock
// past 60 s: a live holder on this host keeps it whatever its marker's age.
test('a live dispatch lock holder without a start time keeps the lock past 60 s', (t) => {
  const h = refillFixture(t);
  const os = require('node:os');
  const S = require('../lib/state');
  const dir = path.join(h.state, 'dispatch', 'lock');
  fs.mkdirSync(dir, { recursive: true });
  let pidns = null;
  let boot = null;
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux */ }
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* not Linux */ }
  const nonce = 'a1b2c3d4e5f60718';
  const file = path.join(dir, nonce);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), boot_id: boot, pidns, at: new Date().toISOString(), nonce }));
  const old = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(file, old, old);
  t.after(() => S.releaseMarkedLock({ dir, nonce, file }));
  const result = h.run(['spawn', '--ready', '--agent', 'orchestrator'], { hooks: { HOOK_DISPATCH_EXPIRE: '1' } });
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.match(result.stdout, new RegExp(`^T3: worker dispatch is locked by pid ${process.pid} `), result.stdout);
  assert.ok(fs.existsSync(file), 'the live holder keeps its marker');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
});

test('a refill at a held dispatch lock retries on the next pass without waiting for other inputs to change', async (t) => {
  const h = refillFixture(t);
  const release = holdDispatchLock(t, h);
  const looked = path.join(h.base, 'dispatch-looked');
  const watcher = h.runAsync(['wait', '--after', '0', '--task', 'T3', '--types', 'spawn', '--timeout', '60', '--agent', 'orchestrator'], { // wait-allow: a refill that never retries ends by this timeout, the failure the test looks for
    hooks: { HOOK_DISPATCH_WAITING: looked },
  });
  await waitFor(looked, { what: 'the refill looks at the held dispatch lock' });
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'nothing is dispatched while the lock is held');
  assert.match(h.json(['status']).not_dispatched.find((b) => b.id === 'T3').reason, new RegExp(`^dispatch lock held by pid ${process.pid} since `));
  // Nothing in the state changes from here; only the lock goes away.
  release();
  const result = await watcher;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task, 'T3');
  await waitFor(h.marker('T3'), { what: 'T3 takes the free slot' });
});

// The wait host runs its reactions and signal handlers on one event loop, so
// a refill that waited for another dispatch would hold both until it gave up.
test('the wait host serves events and drains a signal while another dispatch holds the dispatch lock', async (t) => {
  const h = refillFixture(t);
  holdDispatchLock(t, h);
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
  await waitFor(looked, { what: 'the refill looks at the held dispatch lock' });
  const sent = Date.now();
  h.ok(['msg', '--to', 'orchestrator', 'still there?']);
  await waitUntil(() => rows().some((row) => row.type === 'worker-message'), { paths: [h.base], alive: () => !closed, what: 'the host reports the message' });
  assert.ok(Date.now() - sent < 30000, `the message waited ${Date.now() - sent} ms behind the dispatch lock`); // wait-allow: a host blocked on the lock answers only after its 140 s wait, the failure this bound looks for
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'nothing is dispatched while the lock is held');
  // Windows ends a process at any signal, with no drain to observe.
  if (process.platform === 'win32') return;
  const signalled = Date.now();
  child.kill('SIGTERM');
  const result = await host;
  assert.ok(Date.now() - signalled < 30000, `the drain took ${Date.now() - signalled} ms`); // wait-allow: the same bound for the signal drain
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(rows().at(-1), { reason: 'signal', signal: 'SIGTERM', drained: 0 });
});

// A full suite holds its gate reaction for most of an hour on a real project.
// The suite here gives up on its own, so a refill that waits behind the
// reaction dispatches only after the gate's evidence, which the order shows.
test('the wait host dispatches a ready task while a gate reaction is still running', async (t) => {
  const h = refillFixture(t);
  const { stalled, release } = holdSuite(h, { giveUpMs: 60000 });
  h.submit();
  let child;
  const host = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '300', '--agent', 'orchestrator'], { // wait-allow: the gate's release ends the test first; this bounds a host that never settles
    onSpawn: (c) => { child = c; },
  });
  try {
    await waitFor(stalled, { what: 'the tests gate holds the reaction' });
    await waitFor(h.marker('T3'), { alive: child, what: 'T3 takes the free slot' });
    const log = h.logs();
    const dispatched = log.findIndex((e) => e.cmd === 'spawn' && e.task === 'T3');
    const gated = log.findIndex((e) => e.cmd === 'check tests' && e.task === 'T1');
    assert.ok(gated === -1 || dispatched < gated, 'T3 is dispatched before the tests gate on T1 ends');
    assert.equal(log.findLast((e) => e.cmd === 'automation' && e.task === 'T1').detail.phase, 'running', 'the reaction still runs');
    const status = h.json(['status']);
    assert.deepEqual(status.not_dispatched, [{ id: 'T2', reason: 'worker limit reached (1 of 1: T3)' }]);
    assert.match(h.ok(['status']), /^not dispatched: T2 worker limit reached \(1 of 1: T3\)$/m);
  } finally {
    fs.writeFileSync(release, '');
  }
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'check tests' && e.task === 'T1'), 'the held gate finishes');
  child.kill('SIGTERM');
  await host;
  const task = h.readState('tasks.json').tasks.find((x) => x.id === 'T1');
  assert.equal(task.status, 'submitted', 'the refill left the gated task alone');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.role === 'worker').length, 0);
  assert.equal(h.logs().findLast((e) => e.cmd === 'check tests' && e.task === 'T1').detail.ok, true);
});

// The wait host's pass is held inside T1's gate, so only the supervisor could
// take T3's submission at once, and its gate holds too. A supervisor that ran
// its own reactions stayed alive, with its parsed history, for that gate.
test('a supervisor whose agent exited hands its reactions to the live wait host and exits', async (t) => {
  const h = refillFixture(t);
  const suite = path.join(h.base, 'tools', 'hold-every-suite.js');
  const release = path.join(h.base, 'release');
  fs.writeFileSync(suite, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(h.base, 'suites'))}, 'run\\n');
const end = Date.now() + 120000; // wait-allow: a gate the test never releases ends after two minutes and fails the run
const poll = () => (fs.existsSync(${JSON.stringify(release)}) || Date.now() >= end ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal and its two minutes bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only', '--executors', '2', '--agent', 'orchestrator']);
  const worker = path.join(h.base, 'submit-worker.js');
  fs.writeFileSync(worker, `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const task = process.env.TOWER_CRANE_TASK;
const run = (args) => cp.execFileSync(process.execPath, [${JSON.stringify(require('./helpers').BIN)}, ...args], { env: fakeAgentEnv(process.env), stdio: 'pipe' });
run(['claim', task]);
const file = path.join(process.env.AUTOMATION_CONTEXT_DIR, task);
fs.writeFileSync(file, '');
const poll = () => {
  if (!fs.existsSync(file + '.go')) return setTimeout(poll, 25); // wait-allow: probe cadence only; the go file releases the worker
  run(['submit', task, '--sha', ${JSON.stringify(h.sha)}, '--pr', '8']);
  fs.writeFileSync(file + '.exited', '');
};
poll();
`);
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, worker, '{prompt}'])]);
  const github = h.github();
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  // read-published: the gate fixture only appends to this file.
  const suites = () => (fs.existsSync(path.join(h.base, 'suites')) ? fs.readFileSync(path.join(h.base, 'suites'), 'utf8').split('\n').length - 1 : 0);
  let child;
  const host = h.runAsync(['wait', '--follow', '--types', 'never', '--agent', 'orchestrator'], { onSpawn: (c) => { child = c; } });
  try {
    await waitOnRepo(h, () => suites() === 1, 'the wait host holds its pass in the T1 tests gate');
    await waitFor(h.marker('T3'), { alive: child, what: 'refill dispatches T3 beside the held gate' });
    const spawn = h.logs().findLast((e) => e.cmd === 'spawn' && e.task === 'T3').detail;
    const state = h.github();
    state.prs['8'] = { ...state.prs['7'], headRefName: h.readState('tasks.json').tasks.find((x) => x.id === 'T3').branch,
      url: 'https://github.com/acme/demo/pull/8' };
    h.saveGithub(state);
    fs.writeFileSync(`${h.marker('T3')}.go`, '');
    await waitFor(`${h.marker('T3')}.exited`, { alive: child, what: 'the T3 worker submits and exits' });
    const BOUND_MS = 30000;
    const gone = await Promise.race([
      waitUntil(() => !require('./helpers').detachedAlive({ pid: spawn.monitor_pid }), { what: 'the T3 supervisor exits' }).then(() => true),
      new Promise((resolve) => { setTimeout(resolve, BOUND_MS, false); }), // wait-allow: the exit bound under test
    ]);
    assert.ok(gone, `the T3 supervisor still runs ${BOUND_MS / 1000} s after its agent exited`);
    assert.equal(suites(), 1, 'the supervisor ran no gate of its own');
    const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.task === 'T3');
    assert.ok(queued.some((e) => e.detail.handed_to === child.pid), JSON.stringify(queued));
  } finally {
    fs.writeFileSync(release, '');
  }
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'check tests' && e.task === 'T3'), 'the wait host runs the handed-off gate');
  const runs = h.logs().filter((e) => e.cmd === 'automation' && e.task === 'T3' && e.detail.phase === 'running');
  assert.ok(runs.length && runs.every((e) => e.detail.pid === child.pid), JSON.stringify(runs.map((e) => e.detail.pid)));
  child.kill('SIGTERM');
  await host;
});

// With the fallback tick off and the watch silent, nothing but the host's own
// timer wakes it once the hold ends.
test('an ending rework hold dispatches on the wait host\'s own timer, with no other event', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const broken = path.join(h.base, 'environment-broken');
  fs.writeFileSync(broken, '');
  const script = path.join(h.base, 'local-environment.js');
  fs.writeFileSync(script, `process.exit(require('node:fs').existsSync(${JSON.stringify(broken)}) ? 1 : 0);\n`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 30 }), '--rework-hold-min', '0.2']);
  h.submit();
  h.consume();
  const rework = h.logs().findLast((e) => e.cmd === 'rework');
  assert.equal(rework?.detail.gate, 'ci', 'an automatic gate rework');
  const end = Date.parse(rework.at) + 12000;
  const ready = path.join(h.base, 'host-ready');
  let child;
  const host = h.runAsync(['wait', '--types', 'never', '--timeout', '60', '--agent', 'orchestrator'], { // wait-allow: a host with no hold timer is never woken again; this deadline ends it, the failure the test looks for
    hooks: { HOOK_SILENT_WATCH: '1', HOOK_NO_FALLBACK: '1', HOOK_WATCH_READY: ready },
    onSpawn: (c) => { child = c; },
  });
  await waitFor(ready, { what: 'the host starts' });
  assert.ok(Date.now() < end, 'the host starts while the hold still runs');
  const held = h.json(['status']).not_dispatched;
  assert.deepEqual(held, [{ id: 'T1', reason: `rework hold until ${new Date(end).toISOString().replace('T', ' ').slice(0, 16)}Z`, until: new Date(end).toISOString() }]);
  await waitFor(h.marker('T1'), { alive: child, what: 'the hold timer dispatches T1' });
  const spawn = h.logs().find((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.role === 'worker');
  assert.ok(Date.parse(spawn.at) >= end, 'dispatched once the hold ended');
  child.kill('SIGTERM');
  await host;
});

// A refill that runs past the deadline must not let the fallback tick start
// more passes or refills: on a real project such a pass can run a gate for
// most of an hour, so the timeout would come that much later or never.
test('a refill running past the wait deadline ends the wait without another pass or refill', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T1', 'T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const calls = path.join(h.base, 'calls');
  const preload = path.join(h.base, 'slow-refill.js');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const A = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation.js'))});
const consume = A.consume;
A.consume = (...args) => { fs.appendFileSync(${JSON.stringify(calls)}, 'pass\\n'); return consume(...args); };
const refill = A.refillWorkers;
let first = true;
A.refillWorkers = async (ctx, attempt) => {
  fs.appendFileSync(${JSON.stringify(calls)}, 'refill\\n');
  if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 6000)); } // wait-allow: the held refill outlasts the 1 s deadline by several fallback ticks
  return refill(ctx, attempt);
};
`);
  const r = await h.runAsync(['wait', '--types', 'never', '--timeout', '1', '--agent', 'orchestrator'], { pre: ['--require', preload] }); // wait-allow: the deadline is what the test drives; the held refill ends it within seconds
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).type, 'timeout');
  const seen = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(seen.filter((c) => c === 'refill').length, 1, 'no refill starts after the deadline');
  // The first pass, a fallback tick that can land just before the deadline, and the deadline's own pass.
  assert.ok(seen.filter((c) => c === 'pass').length <= 3, `no tick starts a pass after the deadline: ${seen.join(', ')}`);
});

// A holder in another pid namespace counts as gone 60 s after its marker last
// changed, and a dispatch can wait that long for the worktree lock under the
// dispatch lock, synchronously, which holds every timer.
test('a dispatch keeps its dispatch lock marker fresh while it waits for the worktree lock, and traces the holding', async (t) => {
  const h = refillFixture(t);
  const S = require('../lib/state');
  const dir = path.join(h.state, 'dispatch', 'lock');
  const trace = path.join(h.base, 'lock-trace.jsonl');
  const worktreeLock = path.join(fs.realpathSync.native(h.state), 'worktree', 'lock');
  fs.mkdirSync(path.dirname(worktreeLock), { recursive: true });
  const held = S.tryMarkedLock(worktreeLock, { keepLive: true });
  assert.ok(held, 'the worktree lock is free');
  let worktreeHeld = true;
  const releaseWorktree = () => { if (worktreeHeld) { worktreeHeld = false; S.releaseMarkedLock(held); } };
  t.after(releaseWorktree);
  let closed = false;
  // A one-second refresh (lib/intervals.js) instead of the production ten.
  const refresh = 1000;
  const run = h.runAsync(['spawn', '--ready', '--agent', 'orchestrator'], {
    env: { TOWER_CRANE_LOCK_TRACE: trace, TOWER_CRANE_INTERVALS: JSON.stringify({ lock_refresh: refresh }) },
    onSpawn: (c) => c.on('close', () => { closed = true; }),
  });
  const marker = () => { try { return fs.readdirSync(dir).map((name) => path.join(dir, name))[0] || null; } catch { return null; } };
  await waitUntil(() => marker(), { paths: [h.state], alive: () => !closed, what: 'the dispatch takes its lock' });
  const file = marker();
  const old = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(file, old, old);
  const fresh = () => { try { return Date.now() - fs.statSync(file).mtimeMs < 60000; } catch { return false; } };
  await waitUntil(fresh, { paths: [h.state], alive: () => !closed, what: 'the waiting dispatch touches its marker' });
  releaseWorktree();
  const result = await run;
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const holdings = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.label === 'dispatch');
  assert.equal(holdings.length, 1, 'one dispatch holding is traced');
  assert.ok(holdings[0].hold_ms >= refresh, `held ${holdings[0].hold_ms} ms across the worktree lock wait`);
});
