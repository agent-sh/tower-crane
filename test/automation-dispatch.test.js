'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitOnRepo, waitUntil, killPid } = require('./signals');
const { BIN } = require('./helpers');
const { gateEvidence, retireRevision } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { readPublished } = require('./atomic-file');
const { setup, holdSuite, configureHarness, refillFixture, harness } = require('./automation-helpers');

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
  const run = h.runAsync(['spawn', '--ready', '--agent', 'orchestrator'], {
    env: { TOWER_CRANE_LOCK_TRACE: trace },
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
  assert.ok(holdings[0].hold_ms >= 10000, `held ${holdings[0].hold_ms} ms across the worktree lock wait`);
});

// A gone holder's marker that cannot be removed stays until a person acts.
test('the wait host reports a dispatch lock it cannot clear once, not on every pass', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'permission bits do not bind' }, async (t) => {
  const h = refillFixture(t);
  const os = require('node:os');
  const cp = require('node:child_process');
  const dir = path.join(h.state, 'dispatch', 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const gone = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const nonce = 'a1b2c3d4e5f60718';
  fs.writeFileSync(path.join(dir, nonce), JSON.stringify({ pid: Number(gone.stdout), host: os.hostname(), at: new Date().toISOString(), nonce }));
  const old = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(path.join(dir, nonce), old, old);
  fs.chmodSync(dir, 0o555);
  let result;
  try {
    result = await h.runAsync(['wait', '--types', 'spawn', '--timeout', '5', '--agent', 'orchestrator']); // wait-allow: the refill passes in this window are what the test counts
  } finally {
    // Before the fixture's cleanup, which removes the directory.
    fs.chmodSync(dir, 0o755);
  }
  assert.equal(result.code, 2, result.stderr);
  const reports = result.stderr.split('\n').filter((line) => /automation refill: .*worker dispatch is locked by pid \d+ .*which is gone, but its lock could not be removed/.test(line));
  assert.equal(reports.length, 1, result.stderr);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
});

function startupContexts(h, withRules) {
  const startups = h.logs().filter((e) => e.cmd === 'startup');
  assert.deepEqual(startups.map((e) => e.detail.role), ['worker', 'reviewer']);
  for (const { task, detail } of startups) {
    const report = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, `${detail.agent}.json`), 'utf8'));
    assert.equal(report.harness, 'command');
    assert.equal(report.args[2], report.prompt, 'the shared stub records the delivered argument');
    assert.match(report.prompt, /^## Goal\n/);
    assert.ok(report.prompt.includes(`Project goal: ${detail.goal}`));
    const target = JSON.parse(/## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt)[1]);
    assert.equal(target.id, task);
    assert.equal(target.title, detail.target.title);
    assert.equal(target.acceptance.length, detail.target.acceptance);
    assert.equal(detail.receives_prompt, true);
    assert.equal(detail.prompt_bytes, Buffer.byteLength(report.prompt));
    assert.equal(detail.prompt_tokens, Math.ceil(detail.prompt_bytes / 4));
    assert.equal(report.prompt.includes('## House rules'), detail.rules.length > 0);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      // A temp root beneath another checkout can inherit that checkout's rules.
      assert.equal(detail.rules.some((rule) => rule.path === path.join(h.base, 'AGENTS.md')), false);
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
      assert.equal(detail.rules_bytes, detail.rules.reduce((bytes, rule) => bytes + rule.bytes, 0));
      assert.equal(detail.rules_tokens, Math.ceil(detail.rules_bytes / 4));
    }
  }
}

test('a worker identity cannot authorize reactions by passing the orchestrator name', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(result.code, 2);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
});

test('a worker that names its own identity cannot complete CI or run reactions as the orchestrator', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } };
  const completed = h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker-T1-1'], worker);
  assert.equal(completed.code, 1, completed.stderr);
  assert.match(completed.stderr, /ci completed is an orchestrator or owner command/);
  const waited = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'worker-T1-1'], worker);
  assert.equal(waited.code, 2, waited.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  assert.equal(h.logs().filter((e) => e.cmd === 'ci completed').length, 0);
  h.consume();
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci'],
    'the orchestrator still runs the reactions');
});

test('supervisor reactions pin unconfigured gates and bypass the real restrictive agent shims', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test/value.test.js' } }));
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'detectable test command']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  configureHarness(h);
  h.env.AUTOMATION_POLICY_PROBE = path.join(h.base, 'policy-probe.jsonl');
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('gates and merges a supervisor runs keep the host environment, not its agent\'s home, shims, cache or identity', { skip: process.platform === 'win32' && 'the pi stub and git hook are shebang scripts' }, async (t) => {
  const h = setup(t);
  configureHarness(h);
  // Git reads ~/.gitconfig as the global file: a home's config is the user's.
  delete h.env.GIT_CONFIG_GLOBAL;
  const probe = (name) => path.join(h.base, `${name}.jsonl`);
  const read = (name) => (fs.existsSync(probe(name)) ? readPublished(probe(name), 'utf8').trim().split('\n').map(JSON.parse) : []);
  // Each agent writes a global git config in its own home, which runs a hook on checkout.
  const hooks = path.join(h.base, 'planted-hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho "$PWD" >> ${shellQuote(probe('planted-hook'))}\n`, { mode: 0o755 });
  const bin = path.join(h.base, 'agent-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
fs.writeFileSync(path.join(os.homedir(), '.gitconfig'), '[core]\\n\\thooksPath = ' + ${JSON.stringify(hooks)} + '\\n');
fs.appendFileSync(${JSON.stringify(probe('agent'))}, JSON.stringify({ HOME: os.homedir(), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }) + '\\n');
process.argv.splice(2, 0, ${JSON.stringify(BIN)}, 'auto');
require(${JSON.stringify(harness)});
`, { mode: 0o755 });
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'pi', '--model', 'stub-model',
    ...['profile', 'provider', 'effort', 'args', 'command'].flatMap((f) => ['--clear', f])]);
  const record = `const fs = require('node:fs');
const { HOME, PATH, XDG_CACHE_HOME, TMPDIR, TOWER_CRANE_AGENT, TOWER_CRANE_TASK, TOWER_CRANE_HOOK } = process.env;
fs.appendFileSync(${JSON.stringify(probe('tests-gate'))}, JSON.stringify({ HOME, PATH, XDG_CACHE_HOME, TMPDIR, TOWER_CRANE_AGENT, TOWER_CRANE_TASK, TOWER_CRANE_HOOK }) + '\\n');
require(require('node:path').resolve('test/value.test.js'));
`;
  fs.writeFileSync(path.join(h.base, 'tests-gate.js'), record);
  const tmpRoot = path.join(h.base, 'project-tmp');
  fs.mkdirSync(tmpRoot);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(path.join(h.base, 'tests-gate.js'))}`, '--tests-mode', 'run-only',
    '--tmp-root', tmpRoot]);
  h.env.AUTOMATION_ENV_PROBE = probe('gh');
  h.env.PATH = `${bin}${path.delimiter}${h.env.PATH}`;
  // The dispatcher's own gate root, which a gate the supervisor runs later must not keep.
  assert.ok(h.env.TOWER_CRANE_TMP);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok),
    () => JSON.stringify(h.logs().slice(-10)));
  // The agents ran in their own homes and caches, so the host values below are not theirs.
  const agents = read('agent');
  assert.equal(agents.length, 2);
  for (const agent of agents) {
    assert.ok(agent.HOME.startsWith(path.join(h.state, 'homes')), agent.HOME);
    assert.notEqual(agent.XDG_CACHE_HOME, h.env.XDG_CACHE_HOME);
  }
  const planted = fs.existsSync(probe('planted-hook')) ? readPublished(probe('planted-hook'), 'utf8') : '';
  assert.equal(planted, '', 'no gate git ran a hook from an agent home');
  const host = (seen) => {
    assert.equal(seen.HOME, h.env.HOME);
    assert.equal(seen.XDG_CACHE_HOME, h.env.XDG_CACHE_HOME);
    assert.ok(!seen.PATH.includes(path.join(h.state, 'homes')), seen.PATH);
    // The dispatcher's identity, or the orchestrator a reaction dispatched the reviewer as; never a spawned agent's.
    assert.ok([h.env.TOWER_CRANE_AGENT, 'orchestrator'].includes(seen.TOWER_CRANE_AGENT), seen.TOWER_CRANE_AGENT);
    assert.equal(seen.TOWER_CRANE_TASK, undefined);
  };
  const gates = read('tests-gate');
  assert.ok(gates.length >= 1);
  for (const seen of gates) {
    host(seen);
    assert.equal(seen.TOWER_CRANE_HOOK, undefined);
    assert.ok(seen.TMPDIR.startsWith(tmpRoot), seen.TMPDIR);
  }
  const merges = read('gh').filter((call) => call.args[0] === 'pr' && call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  host(merges[0]);
  assert.equal(merges[0].TOWER_CRANE_SANDBOX, undefined);
  const tests = h.readState('tasks.json').tasks[0].evidence.find((e) => e.type === 'tests');
  assert.equal(tests.tmp_root, tmpRoot);
});

test('large review dispatch hands revuto findings to the reviewer and an ok that ignores a P1 is refused', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'large.md'), 'A focused review reads this diff. '.repeat(1000) + '\n');
  h.git(['add', 'large.md']);
  h.git(['commit', '-qm', 'large review diff']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  configureHarness(h);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  const comment = (id, body, extra = {}) => ({ id, in_reply_to_id: null, path: 'src.js', line: 3, original_line: 3, body,
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: `https://github.com/acme/demo/pull/7#discussion_r${id}`, ...extra });
  state.comments = [
    comment(101, '[P1] The loop never terminates on empty input.'),
    comment(102, '[P2] Missing null check.'),
    { ...comment(103, '[resolved]\nFixed by the guard above.'), in_reply_to_id: 102, user: 'worker' },
    comment(104, 'Nit: rename this.'),
    comment(105, '[P1] Outdated finding.', { line: null }),
    comment(106, '[P1] Not from revuto.', { user: 'someone' }),
  ];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer'),
    () => JSON.stringify(h.logs().slice(-10)));
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.severity, f.reply]), [[101, 'P1', null], [102, 'P2', 103], [104, null, null]]);
  const brief = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(brief, /## Revuto findings/);
  assert.match(brief, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(brief, /### \[P2\] src\.js:3 \(comment 102, resolved in reply 103\)/);
  assert.match(brief, /### src\.js:3 \(comment 104\)/);
  assert.doesNotMatch(brief, /Outdated finding|Not from revuto/);
  const contextFile = path.join(h.env.AUTOMATION_CONTEXT_DIR, `${review.detail.agent}.json`);
  assert.ok(fs.existsSync(contextFile), fs.readFileSync(review.detail.log, 'utf8'));
  const { prompt } = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  assert.match(prompt, /Read .*reviews.* for the diff at/);
  assert.match(prompt, /## Revuto findings/);
  assert.match(prompt, /### \[P1\] src\.js:3 \(comment 101\)\n\n\[P1\] The loop never terminates on empty input\./);
  assert.match(prompt, /## Gate results/);
  assert.doesNotMatch(prompt, /diff --git a\/large.md/);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.evidence.some((e) => e.type === 'review'), false, 'the reviewer ok was refused');
  assert.equal(task.status, 'submitted');
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent]);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 101 at src\.js:3 \(https:\/\/github\.com\/acme\/demo\/pull\/7#discussion_r101\)/);
  assert.doesNotMatch(refused.stderr, /comment 10[2-6]/);
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--fail', '--agent', review.detail.agent]);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('brokered review evidence clears a revuto finding whose file changed since the comment', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const state = h.github();
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const comment = (id, commit) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1, original_line: 1, body: `[P1] finding ${id}`,
    user: 'revuto-review[bot]', original_commit_id: commit, html_url: null });
  // value.js changed between before and the head; nothing changed after the head.
  state.comments = [comment(201, before), comment(202, h.sha)];
  h.saveGithub(state);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer'),
    () => JSON.stringify(h.logs().slice(-10)));
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.changed]), [[201, true], [202, false]]);
  // The state broker runs evidence with TOWER_CRANE_VIA=broker, where tower-crane reads no repository.
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 202 at value\.js:1 has no code change/);
  assert.doesNotMatch(refused.stderr, /comment 201/);
});

test('revuto findings on bracketed paths require a change to the literal file', async (t) => {
  const h = setup(t);
  configureHarness(h);
  fs.mkdirSync(path.join(h.repo, 'routes'));
  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 1;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'add route fixtures']);
  const commented = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'routes', 'i.js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'change sibling route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  h.submit();
  // Revuto posts after the submit: one already on the PR would refuse it, as review ok does.
  const posted = h.github();
  posted.comments = [{ id: 401, in_reply_to_id: null, path: 'routes/[id].js', line: 1,
    body: '[P1] The dynamic route is still broken.', user: 'revuto-review[bot]', original_commit_id: commented }];
  h.saveGithub(posted);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(review.detail.revuto[0].changed, false);
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /review ok refused; revuto \[P1\] comment 401 at routes\/\[id\]\.js:1/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok), false);

  fs.writeFileSync(path.join(h.repo, 'routes', '[id].js'), 'module.exports = 2;\n');
  h.git(['add', 'routes']);
  h.git(['commit', '-qm', 'fix dynamic route']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const updated = h.github();
  updated.prs['7'].headRefOid = h.sha;
  updated.ci[h.sha] = 'success';
  h.saveGithub(updated);
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const fixed = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  const latest = h.logs().findLast((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(latest.detail.revuto[0].changed, true);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok && e.sha === h.sha));
});

test('revuto replies require an explicit resolution and later discussion reopens the finding', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const before = h.git(['rev-parse', `${h.sha}^`]);
  const finding = (id, commit = h.sha) => ({ id, in_reply_to_id: null, path: 'value.js', line: 1,
    body: `[P1] finding ${id}`, user: 'revuto-review[bot]', original_commit_id: commit });
  const reply = (id, thread, body) => ({ id, in_reply_to_id: thread, user: 'worker', body });
  // A tracked worker lets automatic reactions dispatch another reviewer after
  // a refused verdict; this test controls both snapshots with native submission.
  h.submit();
  // Revuto posts after the submit: open [P1] findings already on the PR would refuse it, as review ok does.
  const state = h.github();
  state.comments = [
    finding(301), reply(311, 301, 'I can still reproduce this. This is not fixed.'),
    finding(302), reply(312, 302, '[resolved]\nFixed by the guard above.'),
    finding(303, before), reply(313, 303, 'Please explain this change.'),
    finding(304), reply(314, 304, 'Not fixed yet.'), reply(324, 304, '[RESOLVED]'),
    finding(305), reply(315, 305, '[resolved]'), reply(325, 305, 'I can still reproduce this.'),
    finding(306), reply(316, 306, '> [resolved]\nThis is a quote, not a resolution.'),
  ];
  h.saveGithub(state);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const first = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  const review = h.logs().find((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const broker = { env: { ...h.env, TOWER_CRANE_VIA: 'broker' } };
  const refused = h.run(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok',
    '--agent', review.detail.agent, '--state', h.state], broker);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  for (const id of [301, 305, 306]) assert.match(refused.stderr, new RegExp(`comment ${id} at value\\.js:1`));
  assert.doesNotMatch(refused.stderr, /comment 30[234]/);
  assert.deepEqual(review.detail.revuto.map((f) => [f.id, f.reply, f.resolved, f.changed]), [
    [301, 311, false, false], [302, 312, true, false], [303, 313, false, true],
    [304, 324, true, false], [305, 325, false, false], [306, 316, false, false],
  ]);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review'), false);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);

  const updated = h.github();
  for (const id of [301, 305, 306]) updated.comments.push(reply(id + 100, id, '[resolved]\nVerified at this head.'));
  h.saveGithub(updated);
  const rerun = await h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 0);
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 2);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
});

// A poll can read the event log mid-append; that read counts as not yet.
function pollUntil(h, what, check) {
  return waitOnRepo(h, check, () => `${what}: ${JSON.stringify(h.logs().slice(-10))}`);
}

test('a reviewer that exits 1 without a verdict is replaced at the same head', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.env.AUTOMATION_REVIEW_CRASH_ONCE = path.join(h.base, 'review-crashed');
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await pollUntil(h, 'replacement review', () => reviewers().length === 2
    && h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
  const exit = h.logs().find((e) => e.cmd === 'spawn exit' && e.detail.agent === reviewers()[0].detail.agent);
  assert.equal(exit.detail.code, 1);
  assert.equal(h.logs().some((e) => e.cmd === 'review held'), false);
});

test('a reviewer whose monitor never records its exit is replaced after the receipt bound with one notice', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  const task = h.readState('tasks.json').tasks[0];
  const at = new Date().toISOString();
  // The worker exited; the reviewer's process is gone, and its monitor (this
  // test process) runs on without writing the reviewer's spawn exit.
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'worker', role: 'worker', sha: task.sha, revision: task.revision, pid: 999998, attempt: 1 } },
    { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'worker', pid: 999998, attempt: 1, code: 0 } },
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer-T1-9', role: 'reviewer', rung: 'review',
      sha: task.sha, revision: task.revision, pid: 999999, attempt: 1, monitor_pid: process.pid, revuto: [] } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const missing = () => h.logs().filter((e) => e.cmd === 'review exit missing');
  h.consume();
  assert.equal(reviewers().length, 1, 'no replacement while the monitor may still record the exit');
  assert.equal(missing().length, 0);
  // Default supervision: 10 min max backoff, 7 s group cleanup and a 1 min drain.
  const clock = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  // The clock preload joins the offline GitHub preload Windows needs rather than replacing it.
  const later = { env: { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require "${clock}"`.trim(), TOWER_CRANE_TEST_NOW: String(Date.parse(at) + 11 * 60000 + 8000) } };
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], later);
  await pollUntil(h, 'replacement reviewer', () => reviewers().length === 2);
  assert.equal(missing().length, 1);
  assert.equal(missing()[0].detail.agent, 'reviewer-T1-9');
  assert.equal(missing()[0].detail.reason, 'reviewer monitor did not record its exit');
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_exit_missing');
  assert.equal(item.task, 'T1');
  assert.deepEqual(item.action.argv.slice(0, 2), ['inbox', '--ack']);
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], later);
  assert.equal(missing().length, 1, 'one notice per reviewer');
});

test('a reviewer that exits without a verdict is not respawned at that head until a revuto thread changes', async (t) => {
  const h = setup(t);
  configureHarness(h);
  h.env.AUTOMATION_REVIEW_NOTE = '1';
  const state = h.github();
  state.comments = [{ id: 501, in_reply_to_id: null, path: 'value.js', line: 1, body: '[P1] Bounds are unchecked.',
    user: 'revuto-review[bot]', original_commit_id: h.sha, html_url: 'https://github.com/acme/demo/pull/7#discussion_r501' }];
  h.saveGithub(state);
  const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const held = () => h.logs().filter((e) => e.cmd === 'review held');
  const until = (what, check) => pollUntil(h, what, check);
  const gone = (pid) => {
    try { killPid(pid, 0); return false; } catch { return true; }
  };
  // The reaction to a reviewer's exit is where automation used to dispatch the
  // next reviewer; its monitor finishes before the orchestrator acts again.
  const settled = (agent) => {
    const spawn = reviewers().find((e) => e.detail.agent === agent);
    const exit = h.logs().find((e) => e.cmd === 'spawn exit' && e.detail.agent === agent);
    return !!exit && h.logs().some((e) => e.cmd === 'automation' && e.detail.source === exit.id && e.detail.phase !== 'running')
      && gone(spawn.detail.monitor_pid);
  };
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await until('first reviewer', () => reviewers().length > 0);
  const first = reviewers()[0].detail.agent;
  await until('first reviewer exit reaction', () => settled(first));
  assert.equal(reviewers().length, 1, 'no second reviewer at the same head');
  assert.equal(held().length, 1);
  const notice = held()[0];
  assert.equal(notice.to, 'orchestrator');
  assert.equal(notice.detail.agent, first);
  assert.equal(notice.detail.sha, h.sha);
  assert.deepEqual(notice.detail.exit, { code: 0, signal: null });
  assert.match(notice.detail.reason, /Review passed; evidence refused: .*review ok refused; revuto \[P1\] comment 501/);
  assert.match(notice.detail.reason, /\[resolved\]/, 'the refusal names how the finding gets resolved');
  assert.deepEqual(notice.detail.revuto, ['[P1] comment 501 at value.js:1 (https://github.com/acme/demo/pull/7#discussion_r501)']);
  const inbox = h.json(['inbox', '--agent', 'orchestrator']);
  const item = inbox.items.find((i) => i.kind === 'review_held');
  assert.equal(item.task, 'T1');
  assert.deepEqual(item.action.argv, ['accept', 'T1']);

  // A later reaction with nothing changed holds without a second notice.
  h.consume();
  assert.equal(reviewers().length, 1);
  assert.equal(held().length, 1);

  // Discussion on the thread is a new input: one more reviewer, held again when it stops the same way.
  const discussed = h.github();
  discussed.comments.push({ id: 511, in_reply_to_id: 501, user: 'owner', body: 'The guard is in parse.js.' });
  h.saveGithub(discussed);
  h.consume();
  await until('second reviewer', () => reviewers().length === 2);
  const second = reviewers()[1].detail.agent;
  await until('second reviewer exit reaction', () => settled(second));
  assert.equal(reviewers().length, 2);
  assert.deepEqual(held().map((e) => e.detail.agent), [first, second]);

  // The orchestrator resolves the finding: the reply re-enables dispatch and the next ok counts.
  const long = h.run(['ci', 'resolve', '501', '--task', 'T1', '--reason', 'x'.repeat(1001), '--agent', 'orchestrator']);
  assert.equal(long.code, 2, long.stderr);
  assert.match(long.stderr, /1001 characters; keep it to 1000/);
  const resolved = h.ok(['ci', 'resolve', '501', '--task', 'T1', '--reason', 'Fixed by the guard in parse.js, as @owner asked.', '--agent', 'orchestrator']);
  assert.match(resolved, /comment 501/);
  const reply = h.github().comments.at(-1);
  assert.equal(reply.in_reply_to_id, 501);
  assert.equal(reply.body, '[resolved]\nFixed by the guard in parse.js, as @\u200downer asked.\n\nby orchestrator');
  await until('third reviewer', () => reviewers().length === 3);
  assert.equal(reviewers()[2].detail.revuto[0].resolved, true);
  await until('review evidence', () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'review' && e.ok));
  assert.equal(held().length, 2);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  try {
    await waitOnRepo(h, () => fs.existsSync(hold));
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok));
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  const workerStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'worker');
  const worker = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  const reviewStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'reviewer');
  assert.ok(workerStartup >= 0 && workerStartup < worker && worker < exit);
  assert.ok(reviewStartup > exit && reviewStartup < review);
  startupContexts(h, true);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('review.tests_first must be a boolean', () => {
  const { errors } = require('../lib/reviewer');
  for (const value of [1, 'true', null]) assert.match(errors({ tests_first: value }).join('; '), /review\.tests_first must be a boolean/, String(value));
  for (const value of [true, false]) assert.deepEqual(errors({ tests_first: value }), []);
});

// The review runs before the suite by default; review.tests_first restores the old order.
for (const [order, verdict] of [['review first', 'fail'], ['review first', 'ok'], ['tests first', 'fail'], ['tests first', 'ok']]) {
  test(`${order}: a ${verdict} review ${verdict === 'fail' ? 'goes to rework' : 'is accepted'} with the suite run ${order === 'tests first' ? 'before' : verdict === 'ok' ? 'after' : 'never'}`, async (t) => {
    const h = setup(t, { testsFirst: order === 'tests first' });
    configureHarness(h);
    const runs = path.join(h.base, 'suite-runs');
    const suite = path.join(h.base, 'suite.js');
    fs.writeFileSync(suite, `require('node:fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');\n`);
    h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`, '--tests-mode', 'run-only']);
    const env = verdict === 'fail' ? { AUTOMATION_REVIEW_FAIL: 'lib/change.js:1 - the input is not checked' } : {};
    assert.equal(h.run(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'], { env }).code, 0);
    const done = verdict === 'fail'
      // The event log is written before tasks.json, so wait for both.
      ? () => h.logs().some((e) => e.cmd === 'rework' && e.detail.from_review) && h.readState('tasks.json').tasks[0].status === 'rework'
      : () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok);
    await waitOnRepo(h, done);
    const events = h.logs();
    const tests = events.filter((e) => e.cmd === 'check tests' || e.cmd === 'gate run' && e.detail.type === 'tests');
    const suiteRuns = fs.existsSync(runs) ? readPublished(runs, 'utf8').split('\n').filter(Boolean).length : 0;
    const review = events.findIndex((e) => e.cmd === 'evidence' && e.detail.type === 'review');
    const dispatch = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
    const check = events.findIndex((e) => e.cmd === 'check tests');
    assert.ok(events.some((e) => e.cmd === 'check clean' && e.detail.ok), 'cleanup runs before review either way');
    if (order === 'review first' && verdict === 'fail') {
      assert.deepEqual([tests.length, suiteRuns], [0, 0], 'no suite starts for a head its review sends back');
    } else {
      assert.equal(suiteRuns, 1);
      assert.ok(order === 'tests first' ? check < dispatch : check > review, `${order}: tests at ${check}, review at ${dispatch}/${review}`);
    }
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, verdict === 'fail' ? 'rework' : 'accepted',
      JSON.stringify(h.logs().map((e) => [e.agent, e.cmd, e.detail?.role || e.detail?.type || ''])));
    if (order === 'review first') {
      const packet = fs.readFileSync(path.join(h.state, 'reviews', `${task.id}-${h.sha}.md`), 'utf8');
      assert.match(packet, /The tests gate runs after this review passes/);
    }
  });
}

// A second PR that touches other files, and a suite command that logs each
// run with PR #7's state at that moment.
function queueFixture(t) {
  const h = setup(t);
  h.git(['switch', '-qc', 'second-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'test', 'other.test.js'), "require('node:assert/strict').equal(require('../other'), 2);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'second change']);
  h.second = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'works']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: h.second, headRefName: 'second-change' };
  github.ci[h.second] = 'success';
  h.saveGithub(github);
  h.suiteLog = path.join(h.base, 'suites.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(h.suiteLog)}, JSON.stringify({ pr7: gh.prs['7'].state }) + '\\n');
// A gate run that fails once, as gates did for tasks accepted before evidence.
const failOnce = ${JSON.stringify(path.join(h.base, 'fail-once'))};
if (fs.existsSync(failOnce)) { fs.rmSync(failOnce); process.exit(1); }
// One run moves main while it runs, as another merge landing would.
if (fs.existsSync(${JSON.stringify(path.join(h.base, 'move-main-once'))})) {
  fs.rmSync(${JSON.stringify(path.join(h.base, 'move-main-once'))});
  const git = (a) => require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(h.repo)}, ...a], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/main', git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'lands during the check'])]);
}
// Another CLI acting while the suite runs.
const during = ${JSON.stringify(path.join(h.base, 'during-check.js'))};
if (fs.existsSync(during)) {
  const script = during + '.ran';
  fs.renameSync(during, script);
  require(script);
}
for (const f of fs.readdirSync('test')) if (f.endsWith('.test.js')) require(path.resolve('test', f));
`);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  h.suites = () => (fs.existsSync(h.suiteLog)
    ? readPublished(h.suiteLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  h.moveMain = (file = 'README.md', text = 'Independent base update.\n') => {
    h.git(['switch', '-q', 'main']);
    fs.appendFileSync(path.join(h.repo, file), text);
    h.git(['add', file]);
    h.git(['commit', '-qm', 'advance main']);
  };
  h.submit();
  h.submit('T2', h.second, '8');
  h.consume();
  for (const id of ['T1', 'T2']) {
    const gates = h.json(['task', 'show', id]).gates.gates;
    assert.ok(gates.filter((g) => g.type !== 'review').every((g) => g.ok), JSON.stringify(gates));
  }
  return h;
}

const headChecks = (h) => h.logs().filter((e) => e.cmd === 'head check');
// A merge settles earlier receipts into evidence files; the CLI reads them back.
const softwareEvidence = (h, id) => h.json(['task', 'show', id]).evidence
  .filter((e) => ['tests', 'clean', 'ci'].includes(e.type));

function acceptBoth(h) {
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.reviewer('T2', 'reviewer');
  h.ok(['evidence', 'T2', '--revision', h.revision('T2'), '--type', 'review', '--sha', h.second, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);
}

test('main moves: a mergeable PR keeps its evidence and merges after one head-of-line check', (t) => {
  const h = queueFixture(t);
  const before = softwareEvidence(h, 'T1');
  h.moveMain();
  const suites = h.suites().length;
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const result = h.consume();
  assert.deepEqual(softwareEvidence(h, 'T1'), before, 'a base move reruns no gate and resets no evidence');
  assert.equal(h.github().prs['7'].state, 'MERGED', result.stderr || JSON.stringify(h.logs().slice(-4)));
  assert.equal(h.suites().length - suites, 1);
  const checks = headChecks(h);
  assert.deepEqual(checks.map((e) => [e.task, e.detail.ok, e.detail.base_sha]), [['T1', true, h.git(['rev-parse', 'main'])]]);
  assert.ok(checks[0].detail.commands.some((c) => c.args.includes('merge-tree')));
  h.consume();
  assert.equal(headChecks(h).length, 1, 'a repeated reaction does not run the suite again');
});

test('the head check runs the suite on a clean checkout of the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  // A suite that requires a clean tree, as ginza's tools/check.py does.
  const log = path.join(h.base, 'clean-check.json');
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
const git = (...a) => cp.execFileSync('git', a, { encoding: 'utf8' }).trim();
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ status: git('status', '--porcelain'),
  head: git('rev-parse', 'HEAD'), parents: git('rev-list', '--parents', '-n', '1', 'HEAD') }));
git('diff', '--quiet', 'HEAD');
git('diff', '--cached', '--quiet');
if (git('status', '--porcelain') !== '') process.exit(3);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true]], JSON.stringify(headChecks(h).map((e) => e.detail.summary)));
  assert.equal(h.github().prs['7'].state, 'MERGED');
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(seen.status, '');
  assert.equal(seen.parents, `${seen.head} ${h.git(['rev-parse', 'main'])} ${h.sha}`);
  assert.equal(h.git(['for-each-ref', '--contains', seen.head]), '', 'no ref names the merge commit');
});

test('the head of the line that turns CONFLICTING goes to rework with its files and the next PR merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const github = h.github();
  github.prs['7'].mergeable = 'CONFLICTING';
  github.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(github);
  h.ok(['project', 'set', '--paused', 'manual queue conflict probe']);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.match(t1.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(headChecks(h).map((e) => e.task), ['T2']);
});

test('two queued PRs run exactly one full suite each at their turn and none before', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const suites = h.suites().length;
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  blocked.advanceBase = true;
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.suites().length, suites, 'nothing runs while the head of the line waits');
  assert.equal(headChecks(h).length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false, 'the second PR does not jump the line');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T1');
  assert.match(stopped.detail.blocked.reason, /mergeability of PR #7 is UNKNOWN/);

  const ready = h.github();
  ready.prs['7'].mergeable = 'MERGEABLE';
  ready.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(ready);
  // The wait runs both suites in this process: 55s alone and 119s with the
  // whole file running in parallel, so a shorter timeout fails under load.
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '300', '--agent', 'orchestrator']);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['7', '8']);
  assert.deepEqual(h.suites().slice(suites), [{ pr7: 'OPEN' }, { pr7: 'MERGED' }],
    'T1 runs its suite before merging; T2 runs its suite only after T1 merged');
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true], ['T2', true]]);
  assert.equal(headChecks(h)[1].detail.base_sha, h.sha, 'T2 is checked against main after T1 landed');
});

test('a base that moves during the head check gets a new check before the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  fs.writeFileSync(path.join(h.base, 'move-main-once'), '');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const checks = headChecks(h);
  assert.equal(checks.length, 2, 'the check against the old base does not authorize the merge');
  assert.notEqual(checks[0].detail.base_sha, checks[1].detail.base_sha);
  assert.equal(checks[1].detail.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('a head replaced during its check is checked again at the new sha before the merge', (t) => {
  const h = queueFixture(t);
  h.git(['switch', '-q', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'Replacement head.\n');
  h.git(['add', 'NOTES.md']);
  h.git(['commit', '-qm', 'replacement head']);
  const replacement = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.moveMain();
  // The owner reworks and reaccepts T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env: fakeAgentEnv(env), encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'owner');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'owner');
const events = ${JSON.stringify(path.join(h.state, 'events.jsonl'))};
const revision = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h.state, 'tasks.json'))}, 'utf8')).tasks.find((x) => x.id === 'T1').revision;
const at = new Date().toISOString();
fs.appendFileSync(events, [
  { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer', role: 'reviewer', rung: 'review', sha: ${JSON.stringify(replacement)}, revision, pid: 999999, attempt: 1 } },
  { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'reviewer', pid: 999999, attempt: 1, code: 0 } },
].map((e) => JSON.stringify(e) + '\\n').join(''));
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'owner');
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the replacement ran during the check');
  assert.deepEqual(headChecks(h).map((e) => [e.detail.sha, e.detail.ok]), [[h.sha, true], [replacement, true]],
    'the check of the old head does not authorize merging the new one');
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], replacement);
  const order = h.logs().filter((e) => e.cmd === 'head check' || e.cmd === 'merge').map((e) => e.cmd);
  assert.deepEqual(order, ['head check', 'head check', 'merge']);
});

test('a head that stops the line and then goes to rework lets the PR behind it merge', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').detail.blocked.task, 'T1');
  assert.equal(h.github().prs['8'].state, 'OPEN');

  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const conflicting = h.github();
  conflicting.prs['7'].mergeable = 'CONFLICTING';
  conflicting.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
});

test('a merged-head suite timeout stops the queue without reworking an accepted task', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
console.log('# Subtest: test/slow.test.js');
setInterval(() => {}, 1000);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const check = headChecks(h).at(-1).detail;
  assert.equal(check.ok, false);
  assert.equal(check.infrastructure_failure, true);
  assert.equal(check.timeout.minutes, 0.05);
  assert.deepEqual(check.timeout.running_files, ['test/slow.test.js']);
  assert.match(check.summary, /timed out after 0\.05 min/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /timed out after 0\.05 min/);
});

test('six queued timeout reactions share one rerun, with fresh runs for changed inputs', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  // Only merged-head runs hang; the submitted head's gate still passes.
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
if (fs.readFileSync('README.md', 'utf8').includes('Independent base update.')) {
  console.log('# Subtest: test/slow.test.js');
  setInterval(() => {}, 1000);
}
`);
  const accept = () => {
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
      '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  };
  accept();
  const run = () => {
    const r = h.run(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(r.code, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /timed out/);
  };
  run();
  const first = headChecks(h).at(-1);
  assert.equal(first.detail.infrastructure_failure, true);
  const queued = Array.from({ length: 6 }, () => ({
    id: `E${require('node:crypto').randomUUID()}`, at: new Date().toISOString(),
    cmd: 'ci completed', agent: 'orchestrator', task: 'T1',
    detail: { sha: h.sha, revision: Number(h.revision('T1')) },
  }));
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), queued.map((e) => JSON.stringify(e) + '\n').join(''));
  const before = h.suites().length;
  h.consume();
  assert.equal(h.suites().length - before, 1, 'six queued reactions run the suite only once more');
  assert.equal(headChecks(h).length, 2);
  const retry = headChecks(h).at(-1);
  assert.equal(retry.detail.rerun_of, first.id);
  const shared = h.logs().filter((e) => e.cmd === 'head check shared');
  assert.ok(shared.length > 0, 'reuse has explicit evidence');
  assert.ok(shared.every((e) => e.detail.source === retry.id && e.detail.infrastructure_failure));
  for (const e of queued) {
    const receipts = h.logs().filter((x) => x.cmd === 'automation' && x.detail.source === e.id);
    assert.ok(receipts.some((x) => x.detail.phase === 'deferred'),
      `queued reaction ${e.id}: ${JSON.stringify(receipts.map((x) => x.detail))}`);
  }
  h.consume();
  run();
  assert.equal(headChecks(h).length, 2, 'later queue passes reuse the timed-out rerun');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);

  const resubmit = (changeHead) => {
    h.ok(['rework', 'T1', '--reason', 'refresh timeout inputs', '--agent', 'orchestrator']);
    if (changeHead) {
      h.git(['switch', '-q', 'fixture-change']);
      fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'New head after timeout.\n');
      h.git(['add', 'NOTES.md']);
      h.git(['commit', '-qm', 'replace timed out head']);
      h.sha = h.git(['rev-parse', 'HEAD']);
      h.git(['switch', '-q', 'main']);
      const gh = h.github();
      gh.prs['7'].headRefOid = h.sha;
      gh.ci[h.sha] = 'success';
      h.saveGithub(gh);
    }
    h.submit();
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
    accept();
  };
  const changes = [
    ['base', () => h.moveMain('README.md', 'Another base update.\n')],
    ['head', () => resubmit(true)],
    ['revision', () => resubmit(false)],
    ['budget', () => h.ok(['project', 'set', '--tests-timeout-min', '0.06', '--agent', 'orchestrator'])],
    ['command', () => {
      const cmd = h.readState('project.json').gates.tests_cmd;
      h.ok(['project', 'set', '--tests-cmd', `${cmd} changed`, '--agent', 'orchestrator']);
      h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
    }],
  ];
  for (const [name, change] of changes) {
    const previous = headChecks(h).at(-1).detail;
    change();
    const count = headChecks(h).length;
    run();
    assert.equal(headChecks(h).length, count + 1, `${name} starts a fresh check`);
    const fresh = headChecks(h).at(-1).detail;
    assert.equal(fresh.rerun_of, undefined, `${name} does not reuse the old timeout`);
    const field = { base: 'base_sha', head: 'sha', revision: 'revision', command: 'command' }[name];
    if (field) assert.notEqual(fresh[field], previous[field], name);
    else assert.notEqual(fresh.timeout.minutes, previous.timeout.minutes, name);
  }
});

for (const setting of ['command', 'mode']) {
  test(`a head check that fails after its ${setting} changed refreshes and merges under current settings`, (t) => {
    const h = queueFixture(t);
    h.moveMain();
    const cmd = h.readState('project.json').gates.tests_cmd;
    const next = setting === 'command' ? `${cmd} again` : cmd;
    const flags = setting === 'command' ? ['--tests-cmd', next] : ['--tests-mode', 'run-only'];
    // The suite fails after its inputs change, so that failure cannot rework the current task.
    fs.writeFileSync(path.join(h.base, 'during-check.js'), `
  const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
  const cp = require('node:child_process');
  cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', ...${JSON.stringify(flags)}, '--agent', 'owner'],
    { cwd: ${JSON.stringify(h.repo)}, env: fakeAgentEnv(${JSON.stringify(h.env)}), encoding: 'utf8' });
  process.exitCode = 1;
  `);
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.consume();
    assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the settings changed during the check');
    assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted', 'the stale failure sends nothing to rework');
    assert.equal(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), false);
    const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(stopped.detail.blocked, null);
    assert.deepEqual(headChecks(h).map((e) => [e.detail.command, e.detail.ok]), [[cmd, false], [next, true]]);
    const tests = softwareEvidence(h, 'T1').filter((e) => e.type === 'tests');
    assert.equal(tests.length, 2, 'the stale receipt was refreshed automatically');
    assert.equal(tests.at(-1).gate_policy.tests_cmd, next);
    assert.equal(tests.at(-1).tests_mode, setting === 'mode' ? 'run-only' : 'prove');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('an accepted PR that already merged without current evidence is confirmed and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  // T1 is a legacy task: its tests evidence no longer passes and its PR
  // landed on GitHub before tower-crane recorded merge evidence.
  fs.writeFileSync(path.join(h.base, 'fail-once'), '');
  h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].mergeCommit = { oid: 'c'.repeat(40) };
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  const receipt = t1.evidence.at(-1);
  assert.deepEqual([receipt.type, receipt.ok, receipt.sha, receipt.ref], ['merge', true, h.sha, 'c'.repeat(40)]);
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8'], 'the landed PR is not merged again');
  assert.equal(h.logs().filter((e) => e.cmd === 'queue skipped').length, 0);
});

test('a head the queue cannot advance is reported once and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(github);
  h.consume();
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[1].evidence.at(-1).type, 'merge');
  const done = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(done.detail.blocked.task, 'T1');
  assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const skips = h.logs().filter((e) => e.cmd === 'queue skipped');
  assert.deepEqual(skips.map((e) => [e.task, e.detail.sha]), [['T1', h.sha]], 'a later pass does not report the same head again');
  assert.match(skips[0].detail.reason, /merged with head f+, not the accepted/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

for (const failure of ['failView', 'invalidView']) {
  test(`an unreadable queue head (${failure}) is skipped once and the ready PR behind it merges`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.prs['7'][failure] = true;
    h.saveGithub(github);
    const offset = h.logs().length;

    h.ok(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const [t1, t2] = h.readState('tasks.json').tasks;
    assert.equal(t1.status, 'accepted');
    assert.ok(!t1.evidence.some((e) => e.type === 'merge'));
    assert.equal(t2.evidence.at(-1).type, 'merge');
    assert.equal(t2.evidence.at(-1).ok, true);
    const done = h.logs().slice(offset).findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(done.detail.blocked.task, 'T1');
    assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);

    // The confirmed merge event starts another pass while T1 is still unreadable.
    h.consume();
    const events = h.logs().slice(offset);
    assert.ok(events.filter((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').length >= 2);
    assert.ok(!events.some((e) => e.cmd === 'merge queue' && e.detail.phase === 'error'));
    const skips = events.filter((e) => e.cmd === 'queue skipped');
    assert.deepEqual(skips.map((e) => [e.task, e.detail.sha, e.detail.revision]), [['T1', h.sha, t1.revision]]);
    assert.match(skips[0].detail.reason, failure === 'failView'
      ? /Could not resolve PullRequest number 7/ : /cannot read PR #7 mergeability/);
    assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8']);
  });
}

for (const state of ['pending', 'failure']) {
  test(`accepted ${state} CI lets the next PR merge and ${state === 'pending' ? 'waits' : 'reworks'}`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.ci[h.sha] = state;
    h.saveGithub(github);
    assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
    h.consume();
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.status, state === 'pending' ? 'accepted' : 'rework');
    assert.equal(h.github().prs['7'].state, 'OPEN');
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
    assert.equal(reworks.length, state === 'pending' ? 0 : 1);
    if (state === 'failure') assert.equal(reworks[0].detail.gate, 'ci');
  });
}

test('a concurrent CI completion retries a skipped pending head in the next drain pass', async (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const pending = h.github();
  pending.ci[h.sha] = 'pending';
  h.saveGithub(pending);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  const green = h.github();
  green.ci[h.sha] = 'success';
  h.saveGithub(green);

  const paused = path.join(h.base, 'queue-paused');
  const resume = path.join(h.base, 'queue-resume');
  // Hold T2's head check after T1 is skipped, until a second command
  // records T1's passing CI and requests another queue pass.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const until = Date.now() + 300000;
const poll = () => {
  if (fs.existsSync(${JSON.stringify(resume)})) return;
  if (Date.now() > until) throw new Error('queue was not resumed');
  setTimeout(poll, 25); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  const offset = h.logs().length;
  const first = h.runAsync(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
  let result;
  try {
    await waitFor(paused, { what: 'T2 holds the queue after T1 is skipped' });
    const skipped = h.logs().slice(offset).find((e) => e.cmd === 'queue skipped');
    assert.equal(skipped?.task, 'T1');
    assert.match(skipped.detail.reason, /ci: latest ci .* pending/);
    h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
    assert.ok(h.logs().slice(offset).some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested'));
  } finally {
    fs.writeFileSync(resume, '');
    result = await first;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7'],
    'both commands finish with both PRs merged, without a later notification');
  for (const task of h.readState('tasks.json').tasks) {
    const receipt = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(receipt?.ok, true, task.id);
    assert.equal(receipt.sha, task.sha);
  }
  const events = h.logs().slice(offset);
  assert.equal(events.filter((e) => e.cmd === 'queue skipped').length, 1);
  const passes = events.filter((e) => e.cmd === 'merge queue');
  assert.equal(passes.filter((e) => e.detail.phase === 'running').length, 2);
  assert.equal(passes.at(-1).detail.phase, 'done');
  assert.equal(passes.at(-1).detail.blocked, null);
  assert.deepEqual(passes.at(-1).detail.skipped, []);
});

test('a submit the wait host reads before its files are renamed still runs the gates', async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const started = path.join(h.base, 'wait-started');
  const waiter = h.runAsync(['wait', '--types', 'worker-message', '--timeout', '300', '--agent', 'orchestrator'],
    { hooks: { HOOK_WATCH_READY: started } });
  t.after(() => waiter);
  await waitFor(started);
  // The worker's commit pauses after its events reach the log, before
  // tasks.json moves to submitted, which the host reads in that window.
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker'], { hooks: { HOOK_COMMIT_DELAY_MS: '2000' } });
  const submit = h.logs().findLast((e) => e.cmd === 'submit');
  // The host handles the submit before it wakes on a message logged after it.
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'done', '--agent', 'w-1']);
  assert.equal((await waiter).code, 0);
  const receipts = h.logs().filter((e) => e.cmd === 'automation' && e.detail.source === submit.id);
  assert.equal(receipts.at(-1)?.detail.phase, 'done', 'the host reacted to the submit');
  const tests = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests');
  assert.equal(tests.length, 1, 'and ran its gates');
});

test('the refill hold ends at the rework time plus gates.rework_hold_min and only covers a restorable gate rework', () => {
  const Hold = require('../lib/rework-hold');
  const sha = 'a'.repeat(40);
  const at = '2026-10-15T00:00:00.000Z';
  const st = { project: { gates: {} }, events: [{ at, cmd: 'rework', task: 'T1', agent: 'orchestrator', via: 'automation',
    detail: { sha, previous_revision: 1, revision: 2, gate: 'ci' } }] };
  const task = { id: 'T1', status: 'rework', revision: 2, sha, claim: null };
  const start = Date.parse(at);
  assert.equal(Hold.holdEnd(st, task, start + 60000), '2026-10-15T00:05:00.000Z');
  assert.equal(Hold.holdEnd(st, task, start + 5 * 60000), null, 'refill proceeds once the window ends');
  assert.equal(Hold.holdEnd({ ...st, project: { gates: { rework_hold_min: 0 } } }, task, start), null, 'zero disables the hold');
  assert.equal(Hold.holdEnd({ ...st, project: { gates: { rework_hold_min: 0.5 } } }, task, start + 20000), '2026-10-15T00:00:30.000Z');
  assert.equal(Hold.holdEnd(st, { ...task, revision: 3 }, start), null, 'a task that can no longer be restored is not held');
  const person = { ...st, events: [{ ...st.events[0], detail: { sha, previous_revision: 1, revision: 2 } }] };
  assert.equal(Hold.holdEnd(person, task, start), null, 'a rework without a gate is not held');
  assert.deepEqual(Hold.errors({ rework_hold_min: -1 }).length, 1);
});

test('task update and brief set skip a revision a restore retired', (t) => {
  const h = setup(t);
  h.submit();
  const revision = () => h.readState('tasks.json').tasks[0].revision;
  let current = revision();
  retireRevision(h, 'T1', current + 1);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works everywhere']);
  assert.equal(revision(), current + 2, 'task update skips the retired number');
  current = revision();
  retireRevision(h, 'T1', current + 1);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the new acceptance.\n' });
  assert.equal(revision(), current + 2, 'brief set skips the retired number');
});

test('a stack refresh and a quality climb skip a revision a restore retired', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'retired-'));
  try {
    const sha = 'a'.repeat(40);
    const task = () => ({ id: 'T1', title: 'Change', status: 'submitted', kind: 'code', size: 'M', tier: 'easy',
      tier_range: { min: 'easy', max: 'hard' }, revision: 2, sha, claim: null, notes: [], evidence: [], spend: { entries: [] }, escalations: [] });
    const st = { dir, project: {}, decisions: { decisions: [] },
      events: [{ at: '2026-10-15T00:00:00.000Z', cmd: 'restore', task: 'T1', agent: 'orchestrator', detail: { from_revision: 3, revision: 2 } }] };
    const emitted = [];
    const emit = (id, detail, cmd) => emitted.push({ id, detail, cmd });
    const refreshed = task();
    require('../lib/stack').sendBack(st, refreshed, 'stack sync moved the branch', 'orchestrator', emit);
    assert.equal(refreshed.revision, 4, 'a stack refresh skips the retired number');
    const climbed = task();
    require('../lib/escalation').recordFailure(st, emit, climbed, 'orchestrator', { trigger: 'tests', reason: 'tests failed', source: 'E1' });
    assert.equal(climbed.revision, 4, 'a quality climb skips the retired number');
    assert.deepEqual(emitted.filter((e) => e.cmd === 'rework').map((e) => e.detail.revision), [4, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
