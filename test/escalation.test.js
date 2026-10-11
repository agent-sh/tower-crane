'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { cachedFixture, pinRung, detachedAlive, BIN } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const events = (h) => require('../lib/state').readEvents(h.state);
const preloadOption = (file) => `--require ${JSON.stringify(file)}`;

function until(t, dir, fn) {
  return new Promise((resolve, reject) => {
    const watchers = dir.map((entry) => fs.watch(entry, check));
    const abort = () => finish(t.signal.reason);
    function finish(error) {
      for (const watcher of watchers) watcher.close();
      t.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      try { if (fn()) finish(); }
      catch (error) { finish(error); }
    }
    for (const watcher of watchers) watcher.once('error', finish);
    t.signal.addEventListener('abort', abort, { once: true });
    if (t.signal.aborted) abort();
    else check();
  });
}

function configure(h, trigger) {
  h.attempts = path.join(h.base, 'attempts.json');
  for (const [index, rung] of ['easy', 'medium', 'hard'].entries()) {
    const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
${index === 0 && trigger === 'preclaim' ? '' : "cli(['claim', 'T1']);"}
const attempts = fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2])) : [];
attempts.push({ rung: '${rung}', agent: process.env.TOWER_CRANE_AGENT, session: process.env.TOWER_CRANE_SESSION,
  previous: process.argv[3], cwd: process.cwd() });
// Readers and fs.watch can briefly prevent replacing an existing file on Windows.
require(require('node:path').join(require('node:path').dirname(process.argv[1]), '../lib/state'))
  .writeAtomic(process.argv[2], JSON.stringify(attempts));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '${rung}-thread' }));
console.log(JSON.stringify({ type: 'result', modelUsage: { 'fixture-light': {} },
  usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 } }));
${index === 0 && ['cleanup', 'orphan'].includes(trigger) ? `
cp.spawn(process.execPath, ['-e', \`
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.argv[1] + '.term', 'stopping'));
fs.writeFileSync(process.argv[1] + '.ready.tmp', String(process.pid));
fs.renameSync(process.argv[1] + '.ready.tmp', process.argv[1] + '.ready');
setInterval(() => {}, 1000);
\`, process.argv[2]], { stdio: 'ignore' });
` : ''}
${index === 0 && ['stall', 'hold', 'orphan'].includes(trigger) ? 'setInterval(() => {}, 1000);'
    : index === 0 && trigger === 'outage' ? "console.error('HTTP 503 service unavailable'); process.exit(1);"
      : index === 0 && trigger === 'refusal' ? "console.log(JSON.stringify({ type: 'refusal' })); process.exit(1);"
        : trigger === 'top' || index === 0 && ['exit', 'preclaim'].includes(trigger) ? 'process.exit(0);'
      : "cli(['submit', 'T1', '--sha', fs.readFileSync(process.argv[2] + '.sha', 'utf8')]);"}
${index === 0 && trigger === 'cleanup' ? `
const stop = () => { if (fs.existsSync(process.argv[2] + '.exit')) process.exit(0); };
fs.watch(require('node:path').dirname(process.argv[2]), stop);
stop();
` : ''}
`;
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', script, BIN, h.attempts, '{session}', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--supervision',
      JSON.stringify({ retries: 0, ...(index === 0 && trigger === 'stall' ? { stall_ms: 100 } : {}), backoff_ms: 10, max_backoff_ms: 10 })]);
  }
}

async function setup(t, trigger = 'exit', range = 'easy..medium', prepare = null) {
  const h = cachedFixture(null, `escalation:${range}:${trigger}`, (repo) => {
    repo.init();
    repo.ok(['task', 'add', '--title', 'Start low', '--tier', range, '--acceptance', 'climbs on quality failure']);
    repo.ok(['brief', 'set', 'T1', '-'], { input: 'Finish the task.\n' });
    configure(repo, trigger);
  });
  h.attempts = path.join(h.base, 'attempts.json');
  const exits = new Map();
  const sockets = new Set();
  const signal = path.join(h.base, 'process-signal.cjs');
  // Socket closure observes detached exits even when SIGKILL prevents a receipt.
  fs.writeFileSync(signal, `
const path = require('node:path');
if (process.execArgv.includes('-e') && process.env.TOWER_CRANE_SESSION
  || ['spawn-monitor.js', 'usage-harness.js'].includes(path.basename(process.argv[1] || ''))) {
  const socket = require('node:net').connect(Number(process.env.HOOK_ESCALATION_SIGNAL_PORT), '127.0.0.1', () => {
    socket.write(String(process.pid) + '\\n');
    socket.unref();
  });
  socket.on('error', () => socket.destroy());
}
`);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let text = '';
    const exited = new Promise((resolve) => socket.once('close', () => {
      sockets.delete(socket);
      resolve();
    }));
    socket.on('data', (data) => {
      text += data;
      if (text.includes('\n')) {
        exits.set(Number(text.trim()), exited);
        fs.writeFileSync(path.join(h.base, 'process-connected'), text);
      }
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  h.env.HOOK_ESCALATION_SIGNAL_PORT = String(server.address().port);
  h.env.NODE_OPTIONS = preloadOption(signal);
  h.task = () => h.readState('tasks.json').tasks.find((task) => task.id === 'T1');
  h.openDecisions = () => h.readState('decisions.json').decisions.filter((decision) => decision.status === 'open');
  h.until = (fn, dirs = [h.state, h.base]) => until(t, dirs, () => {
    // The predicate must see a ceiling the guard saw before rejecting that ceiling.
    const ceiling = h.openDecisions().find((decision) => decision.blocks.includes('T1'));
    if (fn()) return true;
    if (ceiling) {
      const exit = events(h).findLast((event) => event.cmd === 'spawn exit' && event.task === 'T1');
      const log = exit?.detail.log;
      throw new Error(`Unexpected escalation ceiling: ${ceiling.question}\n`
        + `Worker ${exit?.agent}: exit ${exit?.detail.code}, signal ${exit?.detail.signal}, log ${log}\n`
        + (log && fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No worker log'));
    }
    return false;
  });
  h.exitSignal = async (child) => {
    // Teardown must still observe exits after an expected ceiling decision.
    await until(t, [h.base], () => exits.has(child.pid) || !detachedAlive(child));
    return { exited: exits.get(child.pid) || Promise.resolve() };
  };
  t.after(async () => {
    try {
      if (t.signal.aborted) {
        t.diagnostic(JSON.stringify({ task: h.task(), attempts: h.readAttempts?.(), events: events(h).slice(-12) }));
      }
      // Stop background usage and gate retries before removing fixture state.
      for (const child of h.detached()) {
        if (child.kind !== 'monitor' || !detachedAlive(child)) continue;
        const { exited } = await h.exitSignal(child);
        if (process.platform === 'win32') {
          cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await exited;
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await h.cleanup();
    }
  });
  if (prepare) prepare(h);
  // Gate preparation can change HEAD after the cached ladder was built.
  fs.writeFileSync(h.attempts + '.sha', h.git(['rev-parse', 'HEAD']));
  h.readAttempts = () => fs.existsSync(h.attempts) ? JSON.parse(fs.readFileSync(h.attempts)) : [];
  return h;
}

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
    const observed = await h.runAsync(['wait', '--after', '0', '--types', 'worker-exited', '--agent', 'orchestrator']);
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

test('wait recovers a verified worker exit after its supervisor is lost', {
  skip: process.platform !== 'linux' && 'independent POSIX worker and monitor termination',
}, async (t) => {
  const h = await setup(t, 'hold');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => h.readAttempts().length === 1);
  const signals = await Promise.all([spawn.monitor_pid, spawn.pid].map((pid) => h.exitSignal({ pid })));
  process.kill(spawn.monitor_pid, 'SIGKILL');
  process.kill(spawn.pid, 'SIGKILL');
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
    process.kill(spawn.monitor_pid, 'SIGKILL');
    process.kill(spawn.pid, 'SIGKILL');
    await Promise.all(signals.map(({ exited }) => exited));
    h.ok(['spend', 'T1', '--from-spawn', spawn.agent]);
    assert.equal(P.processState(child), 'running');
    const result = h.run(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator', '--timeout', '2']);
    assert.equal(result.code, 2, 'a parent exit must not dispatch while its orphan descendant is alive');
    const waiting = h.json(['recover', 'T1', '--agent', 'orchestrator']);
    assert.match(waiting.waiting, /process group.*still running/i);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn exit' && e.detail.agent === spawn.agent).length, 0);
    assert.ok(events(h).some((e) => e.cmd === 'recover waiting' && /process group/.test(e.detail.reason)));
    const { exited } = await h.exitSignal(child);
    process.kill(child.pid, 'SIGKILL');
    await exited;
    const submitted = await h.runAsync(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator']);
    assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
    assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  } finally {
    if (P.processState(child) !== 'exited') process.kill(child.pid, 'SIGKILL');
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

for (const { route, required } of [
  { route: 'tests' }, { route: 'clean' }, { route: 'ci' }, { route: 'local-ci' },
  { route: 'ci', required: 'missing' }, { route: 'ci', required: 'pending' },
]) {
  const type = route === 'local-ci' ? 'ci' : route;
  test(`a confirmed ${route} gate failure${required ? ` while a required check is ${required}` : ''} climbs and reaches the owner at the range ceiling`, async (t) => {
    const h = await setup(t, 'review', 'easy..medium', (repo) => {
      gateFixture(repo);
      // Recovery inherits the check's environment; only the selected gate fails.
      const exit = "process.exit(process.env.FIXTURE_GATE_OK === '0' ? 1 : 0)";
      repo.ok(['project', 'set', '--repo', 'acme/demo', '--tests-mode', 'run-only',
        '--tests-cmd', `node -e "${route === 'tests' ? exit : 'process.exit(0)'}"`]);
      if (route !== 'clean') fs.writeFileSync(path.join(repo.base, 'tools', 'scanner.js'),
        'console.log(JSON.stringify({ items: [] }));\n');
      if (type !== 'ci') {
        const gh = path.join(repo.base, 'tools', 'gh');
        fs.writeFileSync(gh, fs.readFileSync(gh, 'utf8')
          .replace("const ok = process.env.FIXTURE_GATE_OK !== '0';", 'const ok = true;'));
      }
      if (route === 'local-ci') repo.ok(['project', 'set', '--ci-local', JSON.stringify({
        command: process.platform === 'win32'
          ? [process.env.ComSpec || 'cmd.exe', '/d', '/c', 'if "%FIXTURE_GATE_OK%"=="0" (exit /b 1) else (exit /b 0)']
          : ['/bin/sh', '-c', 'test "$FIXTURE_GATE_OK" != 0'],
        timeout: 5,
      })]);
      if (required) repo.ok(['project', 'set', '--ci-required', '["required-build"]']);
      if (required === 'pending') {
        const gh = path.join(repo.base, 'tools', 'gh');
        fs.appendFileSync(gh, `
if (args.some((arg) => arg.includes('/check-runs'))) {
  console.log(JSON.stringify({name: 'required-build', app: 'fixture', status: 'in_progress', conclusion: null}));
}
`);
      }
    });
    // A submit or reviewer reaction can finish before this worker's monitor
    // drains its own exit reactions. Its socket closure observes completion.
    const settled = async (agent) => {
      const worker = events(h).findLast((e) => e.cmd === 'spawn' && e.detail.agent === agent);
      assert.ok(worker, `no dispatch for ${agent}`);
      const { exited } = await h.exitSignal({ pid: worker.detail.monitor_pid });
      await exited;
    };
    h.ok(['spawn', '--task', 'T1']);
    await settled('worker-T1-1');
    for (const rung of ['medium', null]) {
      if (h.openDecisions().length === 1) break;
      const result = h.run(['check', type, 'T1', '--json'], { env: { FIXTURE_GATE_OK: '0' } });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).confirmed_failure, true, result.stdout);
      if (rung) {
        await h.until(() => h.readAttempts().length === 2
          && (h.task().status === 'submitted' || h.openDecisions().length === 1));
        assert.equal(h.json(['task', 'show', 'T1']).tier, rung);
        await settled('worker-T1-2');
      } else {
        await h.until(() => h.openDecisions().length === 1);
      }
    }
    const task = h.json(['task', 'show', 'T1']);
    assert.deepEqual(task.escalations.map((e) => e.trigger), [type, type]);
    assert.deepEqual(task.escalations.map((e) => e.to), ['medium', null]);
    assert.ok(task.evidence.filter((e) => e.type === type && !e.ok).every((e) => e.confirmed_failure === true));
    const log = events(h);
    for (const [index, climb] of task.escalations.entries()) {
      const failure = log.find((e) => e.id === climb.source);
      assert.equal(failure.cmd, `check ${type}`);
      assert.equal(failure.detail.ok, false);
      assert.equal(failure.detail.confirmed_failure, true);
      assert.equal(failure.detail.revision, index + 1, 'each climb belongs to its failed revision');
    }
    assert.equal(h.readAttempts().length, 2);
  });
}

for (const type of ['tests', 'clean', 'ci']) {
  test(`unconfirmed ${type} observation failures do not climb`, async (t) => {
    const h = await setup(t, 'review', 'easy..medium', (repo) => {
      gateFixture(repo);
      repo.ok(['project', 'set', '--repo', 'acme/demo']);
      if (type === 'tests') {
        repo.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', 'tower-crane-missing-test-program']);
      } else if (type === 'clean') {
        fs.writeFileSync(path.join(repo.base, 'tools', 'scanner.js'),
          'console.log(JSON.stringify({items:[{severity:"HIGH"}],errors:["scan incomplete"]}));');
      } else {
        const file = path.join(repo.base, 'tools', 'gh');
        const script = fs.readFileSync(file, 'utf8').replace("status: 'completed', conclusion: ok ? 'success' : 'failure'",
          "status: 'in_progress', conclusion: null");
        fs.writeFileSync(file, script);
      }
    });
    h.ok(['spawn', '--task', 'T1']);
    await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
    assert.equal(h.run(['check', type, 'T1']).code, 1);
    h.ok(['recover', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
  });
}

for (const { status, failingTest } of [{ status: 1 }, { status: 9009 }, { status: 1, failingTest: true }]) {
  test(failingTest ? 'a failing test reporting a missing-command diagnostic still climbs'
    : `Windows command-not-found exit ${status} does not climb`, async (t) => {
    const h = await setup(t, 'review', 'easy..medium', (repo) => {
      gateFixture(repo);
      repo.ok(['project', 'set', '--repo', 'acme/demo', '--tests-mode', 'run-only',
        '--tests-cmd', 'tower-crane-missing-test-program']);
      const hook = path.join(__dirname, 'fixtures', 'windows-missing-command.js').replace(/\\/g, '/');
      repo.env.NODE_OPTIONS += ` ${preloadOption(hook)}`;
      repo.env.TOWER_CRANE_TEST_MISSING_STATUS = String(status);
      if (failingTest) repo.env.TOWER_CRANE_TEST_DIAGNOSTIC_IN_TEST = '1';
    });
    h.ok(['spawn', '--task', 'T1']);
    await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
    const checked = h.run(['check', 'tests', 'T1', '--json']);
    assert.equal(checked.code, 1, checked.stderr);
    const result = JSON.parse(checked.stdout);
    assert.ok(result.commands.some((command) => command.command === 'tower-crane-missing-test-program'
      && command.status === status), 'the CLI records the Windows shell status');
    assert.equal(result.confirmed_failure, failingTest ? true : undefined);
    h.ok(['recover', 'T1']);
    assert.equal(h.json(['task', 'show', 'T1']).tier, failingTest ? 'medium' : 'easy');
    const climbs = events(h).filter((e) => e.cmd === 'escalate');
    if (failingTest) assert.ok(climbs.length > 0 && climbs.every((e) => e.detail.trigger === 'tests'));
    else assert.equal(climbs.length, 0);
  });
}

test('a later eligible passing review supersedes a failure before worker exit', async (t) => {
  const h = await setup(t, 'hold');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => h.readAttempts().length === 1);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', spawn.agent]);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', sha, '--agent', 'reviewer', '--summary', 'first verdict']);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer', '--summary', 'corrected verdict']);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer']);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', sha, '--agent', spawn.agent]);
  process.kill(spawn.pid, 'SIGKILL');
  await h.until(() => events(h).some((e) => e.cmd === 'spend' && e.detail.source === `spawn:${spawn.agent}`));
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
});

for (const prior of ['spent', 'lock-timeout']) {
  test(`wait retries an unhandled exit after its notification was recorded (${prior})`, {
    skip: process.platform !== 'linux' && 'independent POSIX worker and monitor termination',
  }, async (t) => {
    const h = await setup(t, 'hold');
    h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
    const spawn = h.json(['spawn', '--task', 'T1']);
    await h.until(() => h.readAttempts().length === 1);
    const signals = await Promise.all([spawn.monitor_pid, spawn.pid].map((pid) => h.exitSignal({ pid })));
    process.kill(spawn.monitor_pid, 'SIGKILL');
    process.kill(spawn.pid, 'SIGKILL');
    await Promise.all(signals.map(({ exited }) => exited));
    const opts = {};
    if (prior === 'spent') {
      h.ok(['spend', 'T1', '--from-spawn', spawn.agent]);
      assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
    } else {
      const hook = path.join(__dirname, 'fixtures', 'escalation-lock-timeout.js').replace(/\\/g, '/');
      opts.env = { NODE_OPTIONS: `${h.env.NODE_OPTIONS} ${preloadOption(hook)}`, TOWER_CRANE_TEST_RECOVERY_LOCK: path.join(h.base, 'lock-timeout') };
    }
    const result = await h.runAsync(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator'], opts);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    if (prior === 'lock-timeout') assert.ok(fs.existsSync(opts.env.TOWER_CRANE_TEST_RECOVERY_LOCK));
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
    assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
  });
}

test('a sandboxed reviewer waits for a hidden live worker to exit before climbing', async (t) => {
  const h = await setup(t, 'hold');
  h.ok(['ladder', 'set', 'easy', '--supervision', '{"stall_ms":60000}']);
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => h.readAttempts().length === 1);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', spawn.agent]);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', sha, '--agent', 'reviewer',
    '--summary', 'wrong result'], {
    hooks: { HOOK_HIDDEN_PIDS: JSON.stringify([spawn.pid, spawn.monitor_pid]) },
  });
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
  process.kill(spawn.pid, 'SIGKILL');
  await h.until(() => {
    const task = h.task();
    return task.status === 'submitted' && task.tier === 'medium' && h.readAttempts().length === 2;
  });
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium']);
});

test('a reviewer without permission to create a worker home leaves the climb for a host observer', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const h = await setup(t, 'review');
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  h.reviewer('T1', 'reviewer');
  const homes = path.join(h.state, 'homes');
  fs.chmodSync(homes, 0o500);
  try {
    h.ok(['evidence', 'T1', '--type', 'review', '--revision', h.revision(), '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
      '--agent', 'reviewer', '--summary', 'needs rework']);
    assert.equal(h.json(['task', 'show', 'T1']).escalation_pending, true);
  } finally {
    fs.chmodSync(homes, 0o700);
  }
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('a brokered failed review records the climb and leaves dispatch to its host', async (t) => {
  const h = await setup(t, 'review');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  h.reviewer('T1', 'reviewer-T1-1');
  const B = require('../lib/broker');
  const binding = path.join(h.base, 'review-broker', B.FILE);
  const broker = await B.start({
    state: h.state, task: 'T1', agent: 'reviewer-T1-1', role: 'reviewer', cwd: spawn.cwd, broker: binding,
  });
  try {
    const result = await B.forward(binding, ['evidence', 'T1', '--type', 'review', '--revision', h.revision(), '--fail',
      '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'wrong result'], h.state);
    assert.equal(result.code, 0, result.stderr);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.tier, 'medium');
    assert.equal(task.escalation_pending, true);
    assert.equal(task.revision, 2, 'automatic rework must invalidate the rejected revision');
    assert.equal(task.evidence.findLast((e) => e.type === 'review').revision, 1);
    const rework = events(h).findLast((e) => e.cmd === 'rework');
    assert.equal(rework.detail.previous_revision, 1);
    assert.equal(rework.detail.revision, 2);
    assert.equal(h.readAttempts().length, 1);
    assert.match(h.json(['spawn', '--task', 'T1', '--dry-run']).argv.join('\n'),
      /Failed review by reviewer-T1-1 at [0-9a-f]+: wrong result/);
    h.ok(['recover', 'T1', '--agent', 'orchestrator']);
    await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
    const sha = h.git(['rev-parse', 'HEAD']);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha,
      '--revision', '1', '--agent', 'owner']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha,
      '--revision', '2', '--agent', 'owner']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, true);
    assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
  } finally {
    broker.close();
  }
});

test('a resource lock delays dispatch while retaining the recorded climb for wait to retry', async (t) => {
  const h = await setup(t, 'review');
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  h.ok(['task', 'update', 'T1', '--lock', 'lab']);
  h.ok(['task', 'add', '--title', 'Hold the lab', '--lock', 'lab', '--acceptance', 'exclusive use']);
  h.ok(['claim', 'T2', '--agent', 'lab-holder']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
    '--agent', 'reviewer', '--summary', 'wrong result']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.tier, 'medium');
  assert.equal(task.escalation_pending, true);
  assert.equal(h.readAttempts().length, 1);
  h.ok(['release', 'T2', '--agent', 'lab-holder', '--reason', 'lab free']);
  const submitted = await h.runAsync(['wait', '--types', 'submitted', '--task', 'T1', '--agent', 'orchestrator']);
  assert.equal(submitted.code, 0, submitted.stderr || submitted.stdout);
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('failure at the range top opens one owner decision and blocks further dispatch', async (t) => {
  const h = await setup(t, 'top', 'easy..hard');
  h.ok(['spawn', '--task', 'T1']);
  await h.until(() => h.openDecisions().length === 1);
  assert.deepEqual(h.readAttempts().map((a) => a.rung), ['easy', 'medium', 'hard']);
  assert.equal(h.json(['task', 'show', 'T1']).revision, 4);
  assert.deepEqual(events(h).filter((e) => e.cmd === 'rework')
    .map((e) => [e.detail.previous_revision, e.detail.revision]), [[1, 2], [1, 3], [1, 4]]);
  const decision = h.json(['decisions', '--open'])[0];
  assert.deepEqual(decision.blocks, ['T1']);
  assert.match(decision.question, /hard.*exit/i);
  assert.deepEqual(decision.answerers, []);
  assert.equal(decision.technical, false);
  assert.equal(decision.answer_rule, null);
  const beforeAnswers = events(h);
  for (const agent of ['worker-T1-3', 'orchestrator']) {
    const denied = h.run(['answer', decision.id, '--choice', 'retry', '--agent', agent]);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /only the owner/);
  }
  assert.deepEqual(events(h), beforeAnswers, 'an unauthorized answer leaves the ceiling blocked');
  h.ok(['recover', 'T1']);
  assert.equal(h.json(['decisions', '--open']).length, 1);
  assert.notEqual(h.run(['spawn', '--task', 'T1']).code, 0);
  assert.equal(h.readAttempts().length, 3);
  h.ok(['answer', decision.id, '--choice', 'revise the plan']);
  const answered = h.json(['decisions'])[0];
  assert.equal(answered.answer_rule, 'owner');
  assert.equal(answered.status, 'answered');
  assert.equal(h.readAttempts().length, 3, 'an owner answer does not dispatch a worker');
});

test('a native harness climb records captured tokens and configured cost for the failed rung', async (t) => {
  const h = await setup(t);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: {
    'fixture-light': { input: 1, cache_write: 1, cache_read: 1, output: 1 },
  } })]);
  pinRung(h, 'easy', { harness: 'claude', model: 'fixture-light', effort: 'high' });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '', { mode: 0o755 });
  const usage = path.join(h.base, 'usage.json');
  fs.writeFileSync(usage, JSON.stringify({ type: 'result', modelUsage: { 'fixture-light': {} },
    usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 } }));
  h.ok(['spawn', '--task', 'T1'], {
    env: { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1', USAGE_EXIT: '1' },
    hooks: { HOOK_USAGE_HARNESS: 'claude', HOOK_USAGE_FILE: usage },
  });
  await h.until(() => h.task().status === 'submitted');
  const task = h.json(['task', 'show', 'T1']);
  assert.deepEqual(task.spend_by_rung.easy, { tokens: 120, cost_usd: 0.00012 });
  assert.deepEqual(task.escalations[0].spend_by_rung.easy, task.spend_by_rung.easy);
});
