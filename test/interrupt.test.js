'use strict';

const { waitOnRepo } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN, detachedAlive } = require('./helpers');

// Pollers can read while a writer is appending the final record.
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);



function setup(t, retry = false, stubborn = false) {
  const h = makeRepo(t);
  h.init(['--workers', '1']);
  h.ok(['task', 'add', '--title', 'Keep unfinished work', '--acceptance', 'original requirement']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Finish the work.\n' });
  const seen = path.join(h.base, 'seen.json');
  const finish = path.join(h.base, 'finish');
  const script = path.join(h.base, 'harness.js');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const cp = require('node:child_process');
const [bin, seen, session, prompt] = process.argv.slice(2);
const cli = (...args) => cp.execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
${stubborn ? `
process.on('SIGTERM', () => {});
if (!session) {
  const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  fs.writeFileSync(seen + '.child', String(child.pid));
}
` : ''}
const task = JSON.parse(cli('task', 'show', 'T1', '--json'));
if (!task.claim) cli('claim', 'T1');
const previous = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen)) : [];
previous.push({ agent: process.env.TOWER_CRANE_AGENT, session, prompt, cwd: process.cwd() });
fs.writeFileSync(seen, JSON.stringify(previous));
fs.writeFileSync('README.md', '# unfinished tracked work\\n');
fs.writeFileSync('unfinished.txt', 'keep this untracked work\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: session || 'interrupted-session' }));
if (${retry}) process.exit(75);
if (!session) {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(finish)})) clearInterval(timer);
  }, 25);
}
`);
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, BIN, seen, '{session}', '{prompt}']),
    '--supervision', JSON.stringify({ retries: 1, backoff_ms: 30000, max_backoff_ms: 30000 })]);
  h.seen = () => fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen)) : [];
  h.finish = () => fs.writeFileSync(finish, '');
  return h;
}

function pauseExit(h, point) {
  const paused = path.join(h.base, `${point}.paused`);
  const go = `${paused}.go`;
  const preload = path.join(h.base, `${point}.js`);
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const paused = ${JSON.stringify(paused)};
const pause = () => {
  if (fs.existsSync(paused)) return;
  fs.writeFileSync(paused, '');
  const deadline = Date.now() + 300000;
  while (!fs.existsSync(paused + '.go')) {
    if (Date.now() >= deadline) throw new Error('exit pause timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
if (${JSON.stringify(point)} === 'hook' && process.argv[2] === 'hook' && process.argv[3] === 'stop') pause();
if (${JSON.stringify(point)} === 'collect' && path.basename(process.argv[1]) === 'spawn-monitor.js') {
  const original = cp.spawnSync;
  cp.spawnSync = function(command, args, options) {
    if (args[1] === 'spend') pause();
    return original.call(this, command, args, options);
  };
}
`);
  return { paused, release: () => fs.writeFileSync(go, ''), opts: { env: { NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"` } } };
}

test('interrupt during detached usage collection releases directly without fencing the next claim', async (t) => {
  const h = setup(t);
  const pause = pauseExit(h, 'collect');
  const first = h.json(['spawn', '--task', 'T1'], pause.opts);
  try {
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
    h.finish();
    await waitOnRepo(h, () => fs.existsSync(pause.paused), 'usage collection did not pause');
    assert.equal(detachedAlive({ pid: first.monitor_pid }), true);
    assert.equal(h.json(['task', 'show', 'T1']).run.active, false);
    h.ok(['interrupt', 'T1']);
    const interrupted = h.json(['task', 'show', 'T1']);
    assert.equal(interrupted.run.phase, 'stopped');
    assert.equal(interrupted.run.active, false);
    h.ok(['claim', 'T1', '--agent', first.agent]);
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.resumed, true);
    assert.equal(next.agent, first.agent);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'stopping').length, 0);
  } catch (error) {
    if (detachedAlive({ pid: first.monitor_pid })) process.kill(first.monitor_pid, 'SIGTERM');
    throw error;
  } finally {
    pause.release();
  }
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'usage collector did not finish');
});

test('an interrupt committed while exit hooks are pending is finalized under the state lock', async (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Next worker', '--acceptance', 'slot becomes available']);
  const pause = pauseExit(h, 'hook');
  const first = h.json(['spawn', '--task', 'T1'], pause.opts);
  try {
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
    h.finish();
    await waitOnRepo(h, () => fs.existsSync(pause.paused), 'exit hook did not pause');
    h.ok(['interrupt', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'stopping');
    pause.release();
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit'), 'exit finalization did not record its receipt');
    assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'stopped');
    assert.equal(h.json(['task', 'show', 'T1']).run.active, false);
    await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'exit finalization did not finish');
    assert.equal(events(h).filter((e) => e.cmd === 'spawn exit').length, 1);
    h.ok(['claim', 'T2', '--agent', 'next-worker']);
    h.ok(['release', 'T2', '--agent', 'next-worker', '--reason', 'slot verified']);
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.resumed, true);
  } catch (error) {
    if (detachedAlive({ pid: first.monitor_pid })) process.kill(first.monitor_pid, 'SIGTERM');
    throw error;
  } finally {
    pause.release();
  }
});

for (const fresh of [false, true]) {
  test(`submission and rework end an earlier interrupt for ${fresh ? 'fresh' : 'resumed'} dispatch`, async (t) => {
    const h = setup(t);
    const first = h.json(['spawn', '--task', 'T1']);
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
    h.ok(['interrupt', 'T1']);
    await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'interrupted monitor did not finish');
    h.ok(['claim', 'T1', '--agent', first.agent]);
    const claim = h.json(['task', 'show', 'T1']).claim;
    h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', first.agent]);
    h.reviewer('T1', 'reviewer-T1-1');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer-T1-1',
      '--summary', 'Add the missing regression', '--ref', 'current-review']);
    h.ok(['rework', 'T1', '--reason', 'Fix the current review feedback']);
    if (fresh) h.ok(['ladder', 'set', 'medium', '--args', '["new-route"]']);
    h.finish();
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(dry.resumed, !fresh);
    assert.match(dry.argv.join('\n'), /Rework T1/);
    assert.match(dry.argv.join('\n'), /Fix the current review feedback/);
    assert.match(dry.argv.join('\n'), /Add the missing regression/);
    assert.match(dry.argv.join('\n'), /current-review/);
    assert.doesNotMatch(dry.argv.join('\n'), /Interrupt T1/);
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.resumed, !fresh);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.claim.from, 'rework');
    if (!fresh) assert.equal(task.claim.since, claim.since);
  });
}

test('interrupting a rework run keeps its failed review feedback for the next dispatch, resumed or fresh', async (t) => {
  const h = setup(t);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
  h.ok(['interrupt', 'T1']);
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'interrupted monitor did not finish');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', first.agent]);
  h.reviewer('T1', 'reviewer-T1-1');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer-T1-1',
    '--summary', 'Add the missing regression', '--ref', 'current-review']);
  h.ok(['rework', 'T1', '--reason', 'Fix the current review feedback']);
  // A new route starts the rework run fresh, so it stays alive until it is interrupted.
  h.ok(['ladder', 'set', 'medium', '--args', '["new-route"]']);
  const rework = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session' && e.detail.agent === rework.agent), 'rework run did not record its session');
  h.ok(['interrupt', 'T1']);
  await waitOnRepo(h, () => !detachedAlive({ pid: rework.monitor_pid }), 'interrupted rework monitor did not finish');
  const feedback = (dry) => {
    const prompt = dry.argv.join('\n');
    for (const text of [/Interrupt T1/, /Rework T1/, /Fix the current review feedback/, /Add the missing regression/, /current-review/]) {
      assert.match(prompt, text);
    }
  };
  const resumed = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(resumed.resumed, true);
  feedback(resumed);
  h.ok(['ladder', 'set', 'medium', '--args', '["newer-route"]']);
  const fresh = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assert.equal(fresh.resumed, false);
  feedback(fresh);
  h.finish();
  h.json(['spawn', '--task', 'T1', '--wait']);
  assert.match(h.seen()[2].prompt, /Add the missing regression/);
  assert.equal(h.json(['task', 'show', 'T1']).claim.from, 'rework');
});

test('interrupt stops supervision, preserves dirty work and resumes the original worker without rework', async (t) => {
  const h = setup(t);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
  const workerTracked = () => h.detached().some((child) => child.kind === 'worker' && child.pid === first.pid);
  assert.equal(workerTracked(), true);
  const before = h.json(['task', 'show', 'T1']);
  const claim = before.claim;
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['task', 'note', 'T1', 'keep the current approach']);
  const stopped = h.json(['interrupt', 'T1', '--agent', 'orchestrator']);
  assert.equal(stopped.status, 'todo');
  assert.equal(stopped.claim, null);
  assert.equal(stopped.revision, 1);
  assert.equal(stopped.branch, before.branch);
  // Windows can reuse a reaped PID before this assertion; the parent tracks
  // the original child's exit and removes only that child's record.
  await waitOnRepo(h, () => h.detached().some((child) => child.kind === 'monitor'
    && child.pid === first.monitor_pid && child.exited), 'supervisor did not stop');
  assert.equal(workerTracked(), false);
  assert.equal(fs.readFileSync(path.join(first.cwd, 'README.md'), 'utf8'), '# unfinished tracked work\n');
  assert.equal(fs.readFileSync(path.join(first.cwd, 'unfinished.txt'), 'utf8'), 'keep this untracked work\n');
  assert.equal(events(h).filter((e) => e.cmd === 'spawn exit').length, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.equal(events(h).filter((e) => e.cmd === 'rework').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).run?.active ?? false, false);
  const second = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(second.resumed, true);
  assert.equal(second.agent, first.agent);
  assert.equal(second.cwd, first.cwd);
  assert.notEqual(second.log, first.log);
  assert.equal(h.seen()[1].session, 'interrupted-session');
  assert.match(h.seen()[1].prompt, /Interrupt T1/);
  assert.equal(h.json(['task', 'show', 'T1']).claim.from, 'todo');
  assert.equal(h.json(['task', 'show', 'T1']).claim.since, claim.since);
});

test('live requirements need an authorized interrupt; metadata and unchanged requirements keep running', async (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Another task', '--acceptance', 'later']);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not start');
  for (const fields of [['--acceptance', 'new requirement'], ['--dep', 'T2'], ['--kind', 'docs'],
    ['--needs', '["browser"]'], ['--ci-local', '{"command":["node","check.js"]}']]) {
    const refused = h.run(['task', 'update', 'T1', ...fields]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /live claim.*--interrupt/);
  }
  for (const agent of [first.agent, 'reviewer-T1-1', 'small-T1-1']) {
    for (const args of [['interrupt', 'T1'], ['task', 'update', 'T1', '--acceptance', 'new requirement', '--interrupt']]) {
      const refused = h.run([...args, '--agent', agent]);
      assert.equal(refused.code, 1, refused.stderr);
      assert.match(refused.stderr, /only.*owner.*orchestrator/);
    }
  }
  h.ok(['task', 'note', 'T1', 'a note from the worker', '--agent', first.agent]);
  h.ok(['task', 'update', 'T1', '--title', 'Renamed', '--size', 'S', '--tier', 'easy', '--interrupt']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'original requirement']);
  h.ok(['task', 'update', 'T1', '--needs', '[]', '--interrupt']);
  assert.equal(detachedAlive({ pid: first.pid }), true);
  assert.equal(h.json(['task', 'show', 'T1']).revision, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'interrupt').length, 0);
  h.ok(['task', 'update', 'T1', '--tier', 'medium']);
  h.ok(['task', 'update', 'T2', '--dep', 'T1']);
  const invalid = h.run(['task', 'update', 'T1', '--dep', 'T2', '--interrupt']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /cycle/);
  assert.equal(events(h).filter((e) => e.cmd === 'interrupt').length, 0);
  const updated = h.json(['task', 'update', 'T1', '--acceptance', 'new requirement', '--interrupt', '--agent', 'orchestrator']);
  assert.equal(updated.revision, 2);
  assert.equal(updated.claim, null);
  assert.equal(events(h).findLast((e) => e.cmd === 'interrupt').detail.revision, 2);
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'requirements interrupt did not stop');
  h.json(['spawn', '--task', 'T1', '--wait']);
  assert.match(h.seen()[1].prompt, /new requirement/);
});

test('live capability changes require interrupt, unchanged needs keep the claim and resume reads current needs', async (t) => {
  const h = setup(t);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not record its session');
  assert.match(h.seen()[0].prompt, /"needs":\s*\[\]/);
  const before = h.json(['task', 'show', 'T1']);
  const refused = h.run(['task', 'update', 'T1', '--needs', '["browser"]']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /live claim.*needs.*--interrupt/);
  const unauthorized = h.run(['task', 'update', 'T1', '--needs', '["browser"]', '--interrupt', '--agent', first.agent]);
  assert.equal(unauthorized.code, 1, unauthorized.stderr);
  assert.match(unauthorized.stderr, /only.*owner.*orchestrator/);
  const invalid = h.run(['task', 'update', 'T1', '--needs', '["unknown"]', '--interrupt']);
  assert.equal(invalid.code, 2, invalid.stderr);
  assert.deepEqual(h.json(['task', 'show', 'T1']).claim, before.claim);
  assert.equal(events(h).filter((e) => e.cmd === 'interrupt').length, 0);
  const changed = h.json(['task', 'update', 'T1', '--needs', '["browser"]', '--interrupt', '--agent', 'orchestrator']);
  assert.deepEqual(changed.needs, ['browser']);
  assert.equal(changed.revision, 2);
  assert.equal(changed.claim, null);
  assert.equal(changed.branch, before.branch);
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'capability interrupt did not stop the worker');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  const claim = h.json(['task', 'show', 'T1']).claim;
  const unchanged = h.json(['task', 'update', 'T1', '--needs', '["browser","browser"]', '--interrupt']);
  assert.equal(unchanged.revision, 2);
  assert.deepEqual(unchanged.claim, claim);
  assert.equal(events(h).filter((e) => e.cmd === 'interrupt').length, 1);
  const refusedClear = h.run(['task', 'update', 'T1', '--needs', '[]']);
  assert.equal(refusedClear.code, 1, refusedClear.stderr);
  assert.match(refusedClear.stderr, /live claim.*needs.*--interrupt/);
  const cleared = h.json(['task', 'update', 'T1', '--needs', '[]', '--interrupt']);
  assert.deepEqual(cleared.needs, []);
  assert.equal(cleared.revision, 3);
  assert.equal(cleared.claim, null);
  const next = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(next.resumed, true);
  assert.match(h.seen()[1].prompt, /"needs":\s*\[\]/);
  assert.equal(fs.readFileSync(path.join(first.cwd, 'unfinished.txt'), 'utf8'), 'keep this untracked work\n');
});

test('interrupt during backoff cancels the retry and releases the claim', async (t) => {
  const h = setup(t, true);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'worker did not enter backoff');
  h.ok(['interrupt', 'T1']);
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'backoff supervisor did not stop');
  assert.equal(h.seen().length, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  h.ok(['claim', 'T1', '--agent', 'replacement']);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, 'replacement');
});

test('manual claims can be interrupted only by the owner or an orchestrator', (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'manual-worker']);
  const before = h.json(['task', 'show', 'T1']);
  assert.equal(h.run(['interrupt', 'T1', '--agent', 'manual-worker']).code, 1);
  const stopped = h.json(['interrupt', 'T1', '--agent', 'orchestrator']);
  assert.equal(stopped.revision, before.revision);
  assert.equal(stopped.claim, null);
  assert.equal(stopped.status, 'todo');
  assert.equal(h.run(['interrupt', 'T1']).code, 1);
  h.ok(['claim', 'T1', '--agent', 'manual-worker']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'manual-worker']);
  h.ok(['rework', 'T1', '--reason', 'finish it']);
  h.ok(['claim', 'T1', '--agent', 'manual-worker']);
  assert.equal(h.json(['interrupt', 'T1']).status, 'rework');
});

test('an interrupted supervisor holds its worker slot until the process group stops', { skip: process.platform === 'win32' }, async (t) => {
  const h = setup(t, false, true);
  h.ok(['task', 'add', '--title', 'Next worker', '--acceptance', 'gets a slot']);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not start');
  const child = Number(fs.readFileSync(path.join(h.base, 'seen.json.child'), 'utf8'));
  h.ok(['interrupt', 'T1']);
  const refused = h.run(['claim', 'T2', '--agent', 'replacement']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /workers limit/);
  const hidden = { hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([first.pid, first.monitor_pid]) } };
  assert.equal(h.run(['claim', 'T2', '--agent', 'replacement'], hidden).code, 1);
  assert.equal(h.run(['claim', 'T1', '--agent', first.agent], hidden).code, 1);
  for (const flags of [[], ['--dry-run']]) {
    const refusedSpawn = h.run(['spawn', '--task', 'T1', ...flags], hidden);
    assert.equal(refusedSpawn.code, 1, refusedSpawn.stderr);
    assert.match(refusedSpawn.stderr, /still stopping/);
  }
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'supervisor did not stop the stubborn group');
  assert.equal(detachedAlive({ pid: first.pid }), false);
  assert.equal(detachedAlive({ pid: child }), false);
  h.ok(['claim', 'T2', '--agent', 'replacement']);
});

test('a supervisor killed after an interrupt does not wedge the claim or the next dispatch', { skip: process.platform === 'win32' }, async (t) => {
  const h = setup(t, false, true);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not start');
  const child = Number(fs.readFileSync(path.join(h.base, 'seen.json.child'), 'utf8'));
  h.ok(['interrupt', 'T1']);
  const stop = events(h).findLast((e) => e.cmd === 'interrupt');
  assert.equal(stop.detail.phase, 'stopping');
  assert.equal(stop.detail.active, true);
  const kill = (pid) => { if (detachedAlive({ pid })) process.kill(pid, 'SIGKILL'); };
  kill(first.monitor_pid);
  kill(first.pid);
  kill(child);
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }) && !detachedAlive({ pid: first.pid }), 'killed supervisor did not stop');
  // No record can follow the SIGKILL, so the reservation holds for one lease.
  const held = h.run(['claim', 'T1', '--agent', first.agent]);
  assert.equal(held.code, 1, held.stderr);
  assert.match(held.stderr, /still stopping/);
  // Age the killed monitor's records past the default 60-minute lease.
  const log = path.join(h.state, 'events.jsonl');
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => {
    const e = JSON.parse(line);
    if (e.task === 'T1' && e.detail?.agent === first.agent && ['interrupt', 'spawn phase'].includes(e.cmd)) {
      e.at = new Date(Date.parse(e.at) - 61 * 60000).toISOString();
    }
    return JSON.stringify(e);
  }).join('\n') + '\n');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  const second = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(second.resumed, true);
  assert.equal(second.agent, first.agent);
  assert.match(h.seen()[1].prompt, /Interrupt T1/);
});

test('cancelling a live claim in the same edit that changes its requirements keeps it cancelled', async (t) => {
  const h = setup(t);
  const first = h.json(['spawn', '--task', 'T1']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'), 'worker did not start');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled', '--acceptance', 'cancelled requirement', '--interrupt']);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'cancelled');
  await waitOnRepo(h, () => !detachedAlive({ pid: first.monitor_pid }), 'supervisor did not stop');
});

test('a generated orchestrator identity may interrupt; an expired lease needs no requirements interrupt', (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Coordinate', '--acceptance', 'coordinates']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'Coordinate the worker.\n' });
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command', '--clear', 'profile', '--clear', 'effort', '--clear', 'model',
    '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
  const orchestrator = h.json(['spawn', '--task', 'T2', '--role', 'orchestrator', '--wait']);
  h.ok(['claim', 'T1', '--agent', 'manual-worker']);
  h.ok(['interrupt', 'T1', '--agent', orchestrator.agent]);
  h.ok(['claim', 'T1', '--agent', 'manual-worker']);
  const claim = h.json(['task', 'show', 'T1']).claim;
  const clock = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  const updated = h.json(['task', 'update', 'T1', '--acceptance', 'after expiry'], {
    env: { NODE_OPTIONS: `--require "${clock}"`, TOWER_CRANE_TEST_NOW: String(Date.parse(claim.until) + 1) },
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.claim, claim);
});
