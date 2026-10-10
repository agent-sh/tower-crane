'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { makeRepo, makeTaskRepo, BIN, HOOKS, detachedAlive } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const bedrockOutage = require('./fixtures/bedrock-outage.json');
const { errorReader, transient } = require('../lib/spawn-monitor');
const windowsConcurrency = process.platform === 'win32' ? 2 : false;
const S = require('../lib/state');

const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sketches = (h) => ['sketch.md', 'sketch.html'].map((file) => ({
  file, text: fs.readFileSync(path.join(h.state, file), 'utf8'),
}));

// The runner's per-test timeout (test/run.js) is the only deadline: a loaded
// machine can take as long as the test may run, and a wait that never comes
// true still fails with its message.
const HUNG_TEST_MS = 300000;

async function until(fn, message) {
  const deadline = Date.now() + HUNG_TEST_MS;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function controlledBackoff(h) {
  const file = path.join(h.base, 'backoff-clock');
  const hook = path.join(__dirname, 'fixtures', 'supervision-backoff-clock.js').replace(/\\/g, '/');
  fs.writeFileSync(file, '0');
  return {
    env: {
      NODE_OPTIONS: `--require "${HOOKS.replace(/\\/g, '/')}" --require "${hook}"`,
      TOWER_CRANE_TEST_BACKOFF_CLOCK: file,
    },
    advance: (ms) => fs.writeFileSync(file, String(ms)),
  };
}

function setup(t, { failures = 1, error = '75', records = null, hold = 0, waitForFinish = false, config = {}, env = {}, busy = false, claimDelay = 0, claim = true, sessionReceipt = false } = {}) {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Supervise an outage', '--tier', 'easy', '--acceptance', 'same session reruns'],
    brief: 'Finish the task.\n',
  }]);
  h.attempts = path.join(h.base, 'attempts.json');
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
const file = process.argv[2];
const attempts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
if (!attempts.length && ${claim}) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${claimDelay});
  cli(['claim', 'T1', '--lease', '1']);
}
const task = JSON.parse(cli(['task', 'show', 'T1', '--json']));
attempts.push({ agent: process.env.TOWER_CRANE_AGENT, session: process.env.TOWER_CRANE_SESSION, retry: process.env.TOWER_CRANE_RETRY,
  cwd: process.cwd(), claim: task.claim });
fs.writeFileSync(file, JSON.stringify(attempts));
${sessionReceipt ? "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'supervised-session' }));" : ''}
${busy ? "cp.spawn(process.execPath, ['-e', 'const end = Date.now() + 3500; while (Date.now() < end) {}'], { stdio: 'ignore' });" : ''}
const finish = () => {
  if (attempts.length <= ${failures}) {
    ${records ? `for (const record of ${JSON.stringify(records)}) console.log(JSON.stringify(record)); process.exit(1);`
      : ['signal', 'interrupt'].includes(error) ? `process.kill(process.pid, '${error === 'signal' ? 'SIGTERM' : 'SIGINT'}');`
      : ['claude-error', 'codex-error', 'codex-failed'].includes(error)
        ? `console.log(${JSON.stringify(JSON.stringify(error === 'claude-error' ? { type: 'result', is_error: true, api_error_status: 503 }
          : error === 'codex-error' ? { type: 'error', message: 'HTTP 502 bad gateway' }
            : { type: 'turn.failed', error: { message: 'provider outage' } }))}); process.exit(1);`
        : ['outage', 'server', 'status-json'].includes(error) ? `console.error(${JSON.stringify(error === 'server' ? '500 Internal Server Error'
          : error === 'status-json' ? '{"status_code":502}' : 'API Error: 503 service unavailable')}); process.exit(1);` : `process.exit(${error});`}
  } else process.exit(0);
};
${waitForFinish ? `if (attempts.length <= ${failures}) finish();
else { const timer = setInterval(() => {
  if (fs.existsSync(file + '.finish')) { clearInterval(timer); finish(); }
}, 25); }` : `setTimeout(finish, ${hold});`}
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, BIN, h.attempts, '{prompt}']),
    '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--supervision',
    JSON.stringify({ retries: 2, backoff_ms: 150, max_backoff_ms: 1000, stall_ms: 60000, ...config })]);
  h.spawn = (role, timeout = 15000) => h.run(['spawn', '--task', 'T1', ...(role ? ['--role', role] : []), '--wait', '--json'], { env, timeout });
  h.readAttempts = () => fs.existsSync(h.attempts) ? JSON.parse(fs.readFileSync(h.attempts, 'utf8')) : [];
  return h;
}

test('supervisor tool hook writers survive a lock held beyond 15 seconds', { timeout: 90000 }, async (t) => {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Supervised tool progress', '--tier', 'easy', '--acceptance', 'tool event survives'],
    brief: 'Record tool progress.\n',
  }]);
  const ready = path.join(h.base, 'harness-ready');
  const emit = path.join(h.base, 'emit-tool');
  const finish = path.join(h.base, 'finish');
  const writerReady = path.join(h.base, 'writer-ready');
  const script = `
const fs = require('node:fs');
require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', 'T1', '--lease', '5']);
fs.writeFileSync(${JSON.stringify(ready)}, '');
let emitted = false;
setInterval(() => {
  if (!emitted && fs.existsSync(${JSON.stringify(emit)})) {
    emitted = true;
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'supervised tool' } }));
  }
  if (fs.existsSync(${JSON.stringify(finish)})) process.exit(0);
}, 25);
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}']),
    '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 0, stall_ms: 60000 })]);
  h.ok(['msg', '--to', 'worker-T1-1', '--task', 'T1', 'startup context']);
  const fixture = path.join(__dirname, 'fixtures', 'supervisor-hook-lock.js');
  const completed = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { env: {
    NODE_OPTIONS: `--require=${JSON.stringify(fixture)}`,
    TOWER_CRANE_TEST_HOOK_LOCK: path.join(h.state, 'lock'), TOWER_CRANE_TEST_HOOK_READY: writerReady,
  } });
  let lock;
  try {
    await until(() => fs.existsSync(ready) && log(h).some((event) => event.cmd === 'hook inbox'), 'startup hook did not complete');
    lock = S.acquireLock(h.state);
    fs.writeFileSync(emit, '');
    await until(() => fs.existsSync(writerReady), 'tool writer did not encounter the lock');
    await new Promise((resolve) => setTimeout(resolve, 16000));
  } finally {
    if (lock) S.releaseLock(lock);
    fs.writeFileSync(finish, '');
  }
  const result = await completed;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(log(h).some((event) => event.cmd === 'hook progress' && event.detail.tool === 'command_execution'), result.stderr);
  assert.doesNotMatch(result.stderr, /harness event failed/);
});

// What counts as an outage is decided per output line, in process: every
// recorded and synthetic case here, and one supervised spawn per family below.
function outage(harness, stream, lines) {
  let seen = false;
  const read = errorReader(harness, stream === 'stderr', (value) => { seen = value; });
  read(Buffer.from(lines.join('\n') + '\n'));
  read(null, true);
  return seen;
}

test('outages come only from harness error envelopes and stderr, and quoted errors never count', () => {
  const json = (records) => records.map((record) => JSON.stringify(record));
  for (const attempt of bedrockOutage.attempts) {
    for (const type of ['error', 'turn.failed']) {
      assert.equal(outage('command', 'stdout', json(attempt.records.filter((r) => r.type === type))), true, `Bedrock ${attempt.attempt} ${type}`);
    }
  }
  for (const record of [
    { type: 'error', message: 'rate limit exceeded' },
    { type: 'turn.failed', error: { message: 'The service is temporarily unavailable.' } },
    { type: 'error', message: 'HTTP 429 Too Many Requests' },
    { type: 'turn.failed', error: { message: 'overloaded' } },
    { type: 'result', is_error: true, api_error_status: 429 },
    { type: 'result', is_error: true, api_error_status: 503 },
    { type: 'error', message: 'HTTP 502 bad gateway' },
    { type: 'turn.failed', error: { message: 'provider outage' } },
  ]) assert.equal(outage('command', 'stdout', json([record])), true, JSON.stringify(record));
  for (const text of ['API Error: 503 service unavailable', '500 Internal Server Error', '{"status_code":502}']) {
    assert.equal(outage('command', 'stderr', [text]), true, text);
  }
  assert.equal(outage('command', 'stdout', json([
    { type: 'error', message: 'Reconnecting... 1/5 (rate limit exceeded: The service is temporarily unavailable.)' },
    { type: 'turn.failed', error: { message: 'invalid API key' } },
  ])), false, 'a later permanent error replaces a recovered reconnect');
  const quoted = 'API Error: 503 service unavailable; provider outage; rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded';
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(outage('command', stream, json([
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: quoted } },
      { type: 'assistant', message: { content: [{ type: 'text', text: quoted }] } },
      { type: 'result', is_error: false, result: quoted },
    ])), false, `quoted on ${stream}`);
    assert.equal(outage('command', stream, ['rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded']), false, `plain capacity text on ${stream}`);
  }
  assert.deepEqual([transient(75, null, false), transient(null, 'SIGTERM', false), transient(null, 'SIGINT', false),
    transient(1, null, true), transient(1, null, false), transient(0, null, true)], [true, true, true, true, false, false]);
});

describe('independent retry cases', { concurrency: windowsConcurrency }, () => {
test('a recorded Bedrock outage reruns with the session and claim kept', (t) => {
  const [attempt] = bedrockOutage.attempts;
  const h = setup(t, { records: attempt.records.filter((record) => record.type === 'error') });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  const attempts = h.readAttempts();
  assert.equal(attempts.length, 2);
  for (const key of ['agent', 'session', 'cwd', 'claim']) assert.deepEqual(attempts[1][key], attempts[0][key]);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('a capacity error envelope reruns', (t) => {
  const h = setup(t, { records: [{ type: 'result', is_error: true, api_error_status: 429 }] });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('a recovered rate-limit reconnect does not retry a later permanent failure', (t) => {
  const h = setup(t, { records: [
    { type: 'error', message: 'Reconnecting... 1/5 (rate limit exceeded: The service is temporarily unavailable.)' },
    { type: 'turn.failed', error: { message: 'invalid API key' } },
  ] });
  const result = h.spawn();
  assert.equal(result.code, 1, result.stderr);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.run.phase, 'blocked');
  assert.equal(task.run.reason, 'exit 1');
});

test('default retry budget waits beyond the observed ten-minute outage and remains bounded', (t) => {
  const clock = path.join(__dirname, 'fixtures', 'supervision-backoff-clock.js').replace(/\\/g, '/');
  const h = setup(t, { failures: 5, env: { NODE_OPTIONS: `--require "${clock}"` } });
  h.ok(['ladder', 'set', 'easy', '--clear', 'supervision']);
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  const attempts = h.readAttempts();
  assert.equal(attempts.length, 6);
  for (const attempt of attempts) assert.deepEqual(attempt.claim, attempts[0].claim);
  const delays = log(h).filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying').map((e) => e.detail.backoff_ms);
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 480000]);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 930000);
  assert.ok(delays.every((delay) => delay <= 600000));
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

// One exit code, stderr text, harness envelope and signal; the rest of each family is in process above.
for (const error of ['75', 'outage', 'codex-error', 'signal']) {
  test(`transient ${error} reruns the same session, preserving the claim until success`, {
    skip: process.platform === 'win32' && ['signal', 'interrupt'].includes(error) && 'POSIX signal observations',
  }, (t) => {
    const h = setup(t, { error });
    const result = h.spawn();
    assert.equal(result.code, 0, result.stderr);
    const attempts = h.readAttempts();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].agent, 'worker-T1-1');
    for (const key of ['agent', 'session', 'cwd', 'claim']) assert.deepEqual(attempts[1][key], attempts[0][key]);
    assert.equal(attempts[1].retry, '1');
    assert.equal(log(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
    assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
    assert.match(h.ok(['task', 'show', 'T1']), /phase: waiting/);
    assert.match(h.ok(['status']), /T1.*waiting/);
    assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /waiting/);
  });
}

test('repeated transient exits render the blocked phase before foreground spend', async (t) => {
  const h = setup(t, { failures: 9 });
  const paused = path.join(h.base, 'spawn-spend-paused');
  const release = path.join(h.base, 'spawn-spend-release');
  const hook = path.join(__dirname, 'fixtures', 'supervision-followups.js').replace(/\\/g, '/');
  const completed = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: {
      NODE_OPTIONS: `--require "${hook}"`,
      TOWER_CRANE_TEST_HOLD_SPAWN_SPEND: paused,
      TOWER_CRANE_TEST_RELEASE_SPAWN_SPEND: release,
    },
  });
  let result;
  try {
    await until(() => fs.existsSync(paused), 'foreground spend did not pause after the monitor exit');
    const events = log(h);
    assert.ok(events.some((e) => e.cmd === 'spawn exit'), 'the monitor recorded its exit before spend paused');
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.run.phase, 'blocked');
    assert.match(task.run.reason, /after 2 retries/);
    for (const { file, text } of sketches(h)) {
      assert.match(text, /blocked: transient exit after 2 retries/, `${file} shows the final blocked phase before spend`);
    }
  } finally {
    fs.writeFileSync(release, 'release');
    result = await completed;
  }
  assert.equal(result.code, 75, result.stderr);
  assert.equal(h.readAttempts().length, 3);
  const retries = log(h).filter((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying');
  assert.deepEqual(retries.map((e) => e.detail.backoff_ms), [150, 300]);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.run.phase, 'blocked');
  assert.match(task.run.reason, /after 2 retries/);
  assert.equal(task.claim.agent, 'worker-T1-1');
  assert.equal(task.status, 'in_progress');
  assert.match(h.ok(['status']), /blocked: transient exit after 2 retries/);
  assert.equal(log(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  assert.equal(h.json(['status']).exited_claims.length, 1);
  h.ok(['release', 'T1', '--agent', 'recovery-worker', '--reason', 'retry budget exhausted']);
  assert.equal(h.json(['task', 'show', 'T1']).claim, null);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'todo');
});
});

test('detached supervision renews a short lease during backoff and does not allow premature recovery', async (t) => {
  const h = setup(t, { config: { backoff_ms: 1400, max_backoff_ms: 1400 } });
  const backoff = controlledBackoff(h);
  const clockFile = path.join(h.base, 'clock');
  const now = Date.now();
  fs.writeFileSync(clockFile, String(now));
  const spawned = h.json(['spawn', '--task', 'T1'], {
    env: { ...backoff.env, HOOK_CLOCK_FILE: clockFile },
  });
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not recorded');
  await until(() => sketches(h).every(({ text }) => /retrying 1/.test(text)), 'saved sketches did not render the retry phase');
  for (const { file, text } of sketches(h)) assert.match(text, /retrying 1/, `${file} shows the retry phase`);
  fs.writeFileSync(clockFile, String(now + 40000));
  await until(() => log(h).some((e) => e.cmd === 'renew'), 'supervisor did not renew the short lease');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.claim.agent, spawned.agent);
  assert.ok(Date.parse(task.claim.until) > now + 60000);
  assert.equal(task.run.phase, 'retrying');
  assert.equal(h.readAttempts().length, 1);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.equal(h.run(['release', 'T1', '--agent', 'other', '--reason', 'premature']).code, 1);
  backoff.advance(1400);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'retry did not finish');
  assert.equal(h.readAttempts().length, 2);
  assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
});

test('later spawns preserve retrying homes through backoff, retries and queued hook writes', async (t) => {
  const h = makeTaskRepo(t, ['T1', 'T2', 'T3'].map((id) => ({
    id,
    args: ['--title', `Task ${id}`, '--tier', 'easy', '--acceptance', 'finish the supervised run'],
    brief: 'Finish the task.\n',
  })));
  const retryReady = path.join(h.base, 'retry-ready');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
const task = process.env.TOWER_CRANE_TASK;
const agent = process.env.TOWER_CRANE_AGENT;
const retry = Number(process.env.TOWER_CRANE_RETRY || 0);
const delay = new Int32Array(new SharedArrayBuffer(4));
const current = JSON.parse(cli(['task', 'show', task, '--json']));
if (current.claim?.agent !== agent) cli(['claim', task, '--lease', '1']);
if (task === 'T1' && retry === 0) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'first attempt' } }));
  process.exitCode = 75;
} else {
  if (task === 'T1' && retry === 1) {
    fs.writeFileSync(${JSON.stringify(retryReady)}, '');
    while (!fs.existsSync(${JSON.stringify(`${retryReady}.go`)})) Atomics.wait(delay, 0, 0, 10);
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'last report from ' + agent } }));
}
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, BIN, '{prompt}']),
    '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify({ retries: 1, backoff_ms: 3500, max_backoff_ms: 3500 })]);

  const backoff = controlledBackoff(h);
  const started = h.json(['spawn', '--task', 'T1'], { env: backoff.env });
  const home = path.join(h.state, 'homes', started.agent);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'first attempt did not enter backoff');

  const duringBackoff = h.json(['spawn', '--task', 'T2', '--wait']);
  assert.equal(duringBackoff.code, 0);
  assert.ok(fs.existsSync(path.join(home, 'hook.json')), 'a later spawn keeps the home while the supervisor waits to retry');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'retrying');

  backoff.advance(3500);
  await until(() => fs.existsSync(retryReady), 'retry attempt did not start');
  assert.ok(log(h).some((e) => e.cmd === 'spawn retry' && e.task === 'T1'), 'retry event was recorded');
  const duringRetry = h.json(['spawn', '--task', 'T3', '--wait']);
  assert.equal(duringRetry.code, 0);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'git')), 'a later spawn keeps the home while the retry is running');

  fs.writeFileSync(`${retryReady}.go`, '');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'retry attempt did not finish');
  await until(() => !detachedAlive({ pid: started.monitor_pid }), 'supervisor did not finish queued hook writes');
  const audit = log(h).filter((e) => e.task === 'T1' && e.agent === started.agent);
  assert.ok(audit.some((e) => e.cmd === 'hook progress'), 'tool activity reached state');
  assert.equal(audit.findLast((e) => e.cmd === 'hook report')?.detail.report, `last report from ${started.agent}`);
  assert.equal(audit.findLast((e) => e.cmd === 'hook stop')?.detail.report, `last report from ${started.agent}`);
  assert.match(audit.find((e) => e.cmd === 'msg' && e.detail.to === 'orchestrator')?.detail.text || '', /without submit/);
});

test('a running process keeps its lease without claimant writes', async (t) => {
  const h = setup(t, { failures: 0, waitForFinish: true });
  const clockFile = path.join(h.base, 'clock');
  const now = Date.now();
  fs.writeFileSync(clockFile, String(now));
  const spawned = h.json(['spawn', '--task', 'T1'], {
    env: { NODE_OPTIONS: `--require "${HOOKS.replace(/\\/g, '/')}"`, HOOK_CLOCK_FILE: clockFile },
  });
  try {
    await until(() => h.readAttempts().length === 1, 'worker did not claim');
    fs.writeFileSync(clockFile, String(now + 40000));
    await until(() => log(h).some((e) => e.cmd === 'renew'), 'live worker lease was not renewed');
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.claim.since, h.readAttempts()[0].claim.since);
    assert.equal(task.claim.agent, spawned.agent);
    assert.ok(Date.parse(task.claim.until) > now + 60000);
    assert.equal(task.run.phase, 'running');
  } finally {
    fs.writeFileSync(`${h.attempts}.finish`, '');
  }
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'worker did not finish');
});

test('release during backoff fences the old supervisor from a replacement claim', async (t) => {
  const h = setup(t, { failures: 9, config: { backoff_ms: 1400, max_backoff_ms: 1400 } });
  const backoff = controlledBackoff(h);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: backoff.env });
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not recorded');
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'replace this run']);
  h.ok(['claim', 'T1', '--agent', 'replacement']);
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'released supervisor did not stop');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.claim.agent, 'replacement');
  assert.equal(task.run, null);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
});

describe('other supervision cases', { concurrency: windowsConcurrency }, () => {
test('an expired previous claim does not stop supervision before a slow replacement claims', (t) => {
  const h = setup(t, { claimDelay: 350 });
  h.ok(['claim', 'T1', '--agent', 'previous-worker', '--lease', '1']);
  const previous = h.json(['task', 'show', 'T1']).claim;
  const clock = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], {
    env: { NODE_OPTIONS: `--require "${clock}"`, TOWER_CRANE_TEST_NOW: String(Date.parse(previous.until) + 1) },
    timeout: 15000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, 'worker-T1-1');
});

test('a permanent exit is blocked without retrying and submit clears its phase', (t) => {
  const h = setup(t, { failures: 9, error: '2' });
  assert.equal(h.spawn().code, 2);
  assert.equal(h.readAttempts().length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'exit 2');
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', 'abcdef1']);
  assert.equal(h.json(['task', 'show', 'T1']).run, null);
});

test('progress paths and CPU detect a stalled process without dropping its live claim', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t, { failures: 0, waitForFinish: true, config: { stall_ms: 250, progress_paths: ['progress.txt'] } });
  const spawned = h.json(['spawn', '--task', 'T1'], { hooks: { HOOK_RENDER_DELAY_MS: '500' } });
  try {
    await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'blocked', 'idle process did not stall');
    assert.match(h.ok(['task', 'show', 'T1']), /blocked: no progress paths or CPU activity/);
    await until(() => sketches(h).every(({ text }) => text.includes('blocked: no progress paths or CPU activity')),
      'saved sketches did not show stall');
    for (const { file, text } of sketches(h)) {
      assert.match(text, /blocked: no progress paths or CPU activity/, `${file} shows the stalled phase`);
    }
    fs.writeFileSync(path.join(spawned.cwd, 'progress.txt'), 'progress\n');
    await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'running', 'path progress did not clear stall');
    await until(() => sketches(h).every(({ text }) => !text.includes('blocked: no progress paths or CPU activity')),
      'saved sketches did not clear stall');
    for (const { file, text } of sketches(h)) {
      assert.doesNotMatch(text, /blocked: no progress paths or CPU activity/, `${file} clears the stalled phase`);
    }
    assert.equal(h.json(['task', 'show', 'T1']).claim.agent, spawned.agent);
    assert.deepEqual(h.json(['status']).exited_claims, []);
  } finally {
    // Keep the worker alive until both board transitions have been observed.
    fs.writeFileSync(`${h.attempts}.finish`, '');
  }
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'supervisor did not finish');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('submitted-task reviewers resume transient exits and show their phase', (t) => {
  const h = setup(t, { claim: false });
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, 'test/value.test.js'], timeout: 30 })]);
  const rung = h.json(['ladder', 'show']).ladder.easy;
  h.ok(['ladder', 'set', 'review', '--harness', 'command', '--command', JSON.stringify(rung.command),
    '--supervision', JSON.stringify(rung.supervision), '--clear', 'model', '--clear', 'profile', '--clear', 'effort']);
  h.ok(['claim', 'T1', '--agent', 'original-worker']);
  h.ok(['submit', 'T1', '--agent', 'original-worker', '--sha', sha]);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'fixture-gates');
  const result = h.spawn('review');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
  assert.equal(h.readAttempts()[0].agent, 'reviewer-T1-1');
  assert.equal(h.readAttempts()[1].agent, 'reviewer-T1-1');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'submitted');
  assert.equal(task.claim, null);
  assert.equal(task.run.phase, 'waiting');
  assert.match(h.ok(['status']), /T1 waiting/);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /reviewer-T1-1/);
});
});

test('a state-lock timeout preserves the pending retry without spending another attempt', async (t) => {
  const h = setup(t, { config: { retries: 1, backoff_ms: 5000, max_backoff_ms: 5000 } });
  h.json(['spawn', '--task', 'T1']);
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'retrying', 'retry was not scheduled');
  const paused = path.join(h.base, 'holder');
  const holder = h.runAsync(['task', 'note', 'T1', 'hold state lock'], { hooks: { HOOK_PAUSE_ON: 'tasks.json', HOOK_PAUSED: paused } });
  try {
    await until(() => fs.existsSync(paused), 'holder did not acquire the lock');
    await new Promise((resolve) => setTimeout(resolve, 17000));
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    assert.equal((await holder).code, 0);
  }
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'pending retry was lost after lock timeout');
  assert.equal(h.readAttempts().length, 2);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
  assert.equal(h.readAttempts()[1].retry, '1');
});

describe('remaining supervision settings', { concurrency: windowsConcurrency }, () => {
test('rung supervision settings validate and clear through the CLI', (t) => {
  const h = setup(t);
  for (const config of [{ retries: -1 }, { backoff_ms: 0 }, { max_backoff_ms: 1 }, { progress_paths: ['../escape'] }, { typo: 1 }]) {
    assert.equal(h.run(['ladder', 'set', 'easy', '--supervision', JSON.stringify(config)]).code, 2);
  }
  h.ok(['ladder', 'set', 'easy', '--clear', 'supervision']);
  assert.equal(h.json(['ladder', 'show']).ladder.easy.supervision, undefined);
});

test('descendant CPU activity postpones stall while paths remain quiet', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t, { failures: 0, hold: 3800, busy: true, config: { stall_ms: 300 } });
  h.json(['spawn', '--task', 'T1']);
  await until(() => h.readAttempts().length === 1, 'CPU stub did not start');
  // The supervisor samples once a second; two and a half seconds of busy
  // child cover at least two samples even on a loaded machine.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(log(h).filter((e) => e.cmd === 'stall').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'running');
  await until(() => h.json(['task', 'show', 'T1']).run?.phase === 'waiting', 'CPU stub did not finish');
});

test('serve shows the recorded run phase on the board', async (t) => {
  const h = setup(t, { failures: 0 });
  assert.equal(h.spawn().code, 0);
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: h.repo, env: h.env });
  const closed = once(server, 'close');
  const output = createInterface({ input: server.stdout });
  let stderr = '';
  server.stderr.on('data', (data) => { stderr += data; });
  try {
    const [line] = await Promise.race([
      once(output, 'line', { signal: t.signal }),
      closed.then(([code]) => { throw new Error(`serve exited before readiness (${code}): ${stderr}`); }),
    ]);
    const { url } = JSON.parse(line);
    assert.ok(url);
    const body = await new Promise((resolve, reject) => {
      const request = http.get(url, { signal: t.signal }, (response) => {
        let html = '';
        response.on('data', (data) => { html += data; });
        response.on('end', () => resolve(html));
      });
      request.on('error', reject);
    });
    assert.match(body, /Phase/);
    assert.match(body, /waiting/);
  } finally {
    output.close();
    server.kill();
    await closed;
  }
});

for (const harness of ['claude', 'codex']) {
  test(`${harness} transient reruns follow the shared session policy and preserve route arguments`, (t) => {
    const h = setup(t);
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    h.ok(['ladder', 'set', 'easy', '--harness', harness, '--clear', 'command',
      ...(harness === 'codex' ? ['--clear', 'model', '--profile', 'chosen-profile'] : ['--model', 'chosen-model'])]);
    const stub = path.join(__dirname, 'fixtures', 'supervision-harness.js').replace(/\\/g, '/');
    const attemptsFile = path.join(h.base, 'harness-attempts.json');
    const result = h.run(['spawn', '--task', 'T1', '--wait'], {
      env: {
        PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
        NODE_OPTIONS: `--require "${stub}"`, TOWER_CRANE_TEST_SUPERVISION_FILE: attemptsFile,
      },
      timeout: 15000,
    });
    assert.equal(result.code, 0, result.stderr);
    const [first, second] = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    assert.equal(first.agent, second.agent);
    if (harness === 'claude') {
      for (const flag of ['--permission-mode', '--tools', '--allowedTools', '--mcp-config']) {
        assert.ok(first.args.includes(flag));
        assert.equal(second.args[second.args.indexOf(flag) + 1], first.args[first.args.indexOf(flag) + 1], flag);
      }
      const id = first.args[first.args.indexOf('--session-id') + 1];
      assert.match(id, /^[a-f0-9-]{36}$/);
      assert.equal(second.args.includes('--resume'), false);
      const nextId = second.args[second.args.indexOf('--session-id') + 1];
      assert.match(nextId, /^[a-f0-9-]{36}$/);
      assert.notEqual(nextId, id);
      const prompt = second.args[second.args.indexOf('-p') + 1];
      assert.match(prompt, /Finish the task/);
      assert.match(prompt, /Previous attempt exited with (SIGTERM|exit 75); continue/);
      assert.equal(second.args[second.args.indexOf('--model') + 1], 'chosen-model');
      assert.equal(second.args.includes('--fork-session'), false);
    } else {
      for (const setting of ['default_permissions="tower-crane"', 'approval_policy="never"', 'web_search="disabled"']) {
        assert.ok(first.args.includes(setting));
        assert.ok(second.args.includes(setting), setting);
      }
      assert.ok(second.args.includes('resume'));
      assert.ok(second.args.includes('01a11297-1067-7831-a3bc-2c04eac9aaef'));
      assert.equal(second.args[second.args.indexOf('-p') + 1], 'chosen-profile');
      assert.ok(second.args.includes('Previous attempt exited with exit 75; continue.'));
      assert.equal(second.args.some((arg) => arg.includes('Finish the task')), false);
    }
    assert.equal(log(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(log(h).filter((e) => e.cmd === 'claim').length, 1);
  });
}

for (const stream of ['stdout']) {
  test(`provider errors quoted in agent JSON on ${stream} do not trigger a rerun`, (t) => {
    const h = setup(t, { failures: 0 });
    const script = `
const cp = require('node:child_process');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
const text = 'API Error: 503 service unavailable; provider outage; rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded';
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: text } }));
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));
console.${stream === 'stdout' ? 'log' : 'error'}(JSON.stringify({ type: 'result', is_error: false, result: text }));
process.exit(1);
`;
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, '{prompt}'])]);
    const result = h.spawn();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
    assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'exit 1');
  });
}

for (const stream of ['stderr']) {
  test(`plain capacity text on ${stream} cannot substitute for a harness error envelope`, (t) => {
    const h = setup(t, { failures: 0 });
    const script = `
const cp = require('node:child_process');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
console.${stream === 'stdout' ? 'log' : 'error'}('rate limit exceeded: The service is temporarily unavailable.; HTTP 429 Too Many Requests; overloaded');
process.exit(1);
`;
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, '{prompt}'])]);
    const result = h.spawn();
    assert.equal(result.code, 1, result.stderr);
    assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  });
}
});

test('quiet supervision samples state and progress paths on a seconds-scale interval', async (t) => {
  const h = setup(t, { failures: 0, waitForFinish: true, config: { progress_paths: ['progress.txt'] } });
  const audit = path.join(h.base, 'samples.jsonl');
  const hook = path.join(__dirname, 'fixtures', 'supervision-samples.js').replace(/\\/g, '/');
  h.json(['spawn', '--task', 'T1'], { env: {
    NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_SAMPLES: audit,
  } });
  const read = () => fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').split('\n').slice(0, -1).map(JSON.parse) : [];
  try {
    await until(() => fs.existsSync(h.attempts), 'quiet worker did not finish claiming');
    await until(() => read().filter((sample) => sample.kind === 'path').length >= 2, 'quiet sampling did not start');
    const before = read().filter((sample) => sample.kind === 'state').length;
    h.ok(['task', 'note', 'T1', 'wake the state observer']);
    await until(() => read().filter((sample) => sample.kind === 'state').length > before, 'the state observer did not see the note');
    // Startup writes may still arrive. Once they settle, several path samples
    // must reuse the state; polling it every tick never reaches this interval.
    await until(() => {
      const samples = read();
      const lastRead = samples.findLast((sample) => sample.kind === 'state');
      return samples.filter((sample) => sample.kind === 'path' && sample.at > lastRead.at).length >= 3;
    }, 'quiet monitor repeatedly reloads state');
    const samples = read();
    const walks = samples.filter((sample) => sample.kind === 'path');
    for (let i = 1; i < walks.length; i++) assert.ok(walks[i].at - walks[i - 1].at >= 900, JSON.stringify(walks));
  } finally {
    fs.writeFileSync(h.attempts + '.finish', '');
    await until(() => log(h).some((e) => e.cmd === 'spawn phase' && e.detail.phase === 'waiting'), 'quiet worker did not finish');
  }
});

describe('supervision completion cases', { concurrency: windowsConcurrency }, () => {
test('Windows natural exits do not send taskkill to an exited or reused pid', (t) => {
  const h = setup(t, { failures: 0 });
  const audit = path.join(h.base, 'taskkill.jsonl');
  const hook = path.join(__dirname, 'fixtures', 'windows-supervision.js').replace(/\\/g, '/');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { env: {
    NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_TASKKILL: audit,
  } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(audit), false, 'taskkill can target a new process after the harness pid is released');
});

test('stopping the monitor terminates the process group and kills children that ignore SIGTERM', {
  skip: process.platform === 'win32' && 'POSIX process groups',
}, async (t) => {
  const h = setup(t, { failures: 0 });
  const pids = path.join(h.base, 'group.json');
  const terminated = path.join(h.base, 'terminated');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
process.on('SIGTERM', () => fs.writeFileSync(process.argv[3] + '.parent', 'parent'));
const descendant = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], 'child')); console.log('ready'); setInterval(() => {}, 1000);", process.argv[3] + '.child'], { stdio: ['ignore', 'pipe', 'inherit'] });
descendant.stdout.once('data', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, descendant.pid])));
setInterval(() => {}, 1000);
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, pids, terminated, '{prompt}'])]);
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(() => fs.existsSync(pids), 'process group did not start');
  const group = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => {
    try { process.kill(-group[0], 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  process.kill(spawned.monitor_pid, 'SIGTERM');
  await until(() => fs.existsSync(terminated + '.parent') && fs.existsSync(terminated + '.child'), 'stop did not send SIGTERM before SIGKILL');
  await until(() => group.every((pid) => !detachedAlive({ pid })), 'stop left a process group member alive');
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'stopped monitor survived');
  assert.equal(fs.readFileSync(terminated + '.parent', 'utf8'), 'parent');
  assert.equal(fs.readFileSync(terminated + '.child', 'utf8'), 'child');
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).run.reason, 'supervisor stopped by SIGTERM');
});

test('a rerun waits for previous descendants even when they close their output pipes', {
  skip: process.platform !== 'linux' && 'Linux process state',
}, (t) => {
  const h = setup(t, { failures: 0 });
  const groupFile = path.join(h.base, 'previous-group.json');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
const file = process.argv[2];
if (!fs.existsSync(file)) {
  cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']);
  const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => {
    child.stdout.destroy();
    fs.writeFileSync(file, JSON.stringify({ parent: process.pid, child: child.pid }));
    process.exit(75);
  });
} else {
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const stat = fs.readFileSync('/proc/' + prior.child + '/stat', 'utf8');
    if (!['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])) process.exit(2);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  process.exit(0);
}
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, BIN, groupFile, '{prompt}'])]);
  let group;
  t.after(() => {
    if (!group) return;
    try { process.kill(-group.parent, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  // The rerun waits out the previous child's SIGTERM grace, so allow for a loaded machine.
  const result = h.spawn(undefined, 60000);
  group = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(log(h).filter((e) => e.cmd === 'spawn retry').length, 1);
});

test('foreground output is durable while the dispatch CLI is blocked rendering', async (t) => {
  const h = setup(t, { error: 'outage', claim: false });
  const paused = path.join(h.base, 'render-paused');
  const completed = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { hooks: { HOOK_STOP_RENDER: paused } });
  let result;
  try {
    await until(() => fs.existsSync(paused), 'dispatch did not pause after committing its spawn');
    await until(() => h.readAttempts().length === 1, 'harness did not emit its result');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const spawned = log(h).find((e) => e.cmd === 'spawn').detail;
    assert.match(fs.readFileSync(spawned.log, 'utf8'), /503 service unavailable/);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    result = await completed;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.readAttempts().length, 2);
});

test('foreground exit waits until the retained stdout pipe has been captured', async (t) => {
  const h = setup(t, { failures: 0 });
  const writerReady = path.join(h.base, 'foreground-writer-ready');
  const writerRelease = path.join(h.base, 'foreground-writer-release');
  const writerPidFile = path.join(h.base, 'foreground-writer-pid');
  const hook = path.join(__dirname, 'fixtures', 'supervision-followups.js').replace(/\\/g, '/');
  const fixture = path.join(__dirname, 'fixtures', 'foreground-held-output.js');
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([
    process.execPath, fixture, BIN, writerReady, writerRelease, writerPidFile, '{prompt}',
  ])]);
  const completed = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: {
      NODE_OPTIONS: `--require "${hook}"`,
    },
  });
  let result;
  let writerPid;
  let spawned;
  try {
    await until(() => log(h).some((e) => e.cmd === 'spawn'), 'spawn was not recorded');
    spawned = log(h).find((e) => e.cmd === 'spawn').detail;
    await until(() => fs.existsSync(writerPidFile) && fs.existsSync(writerReady),
      'detached writer did not open the foreground stdout pipe');
    writerPid = Number(fs.readFileSync(writerPidFile, 'utf8'));
    assert.ok(Number.isInteger(writerPid));
    await until(() => !detachedAlive({ pid: spawned.pid }), 'foreground harness did not exit');
    await until(() => detachedAlive({ pid: writerPid }), 'detached writer did not keep the stdout pipe open');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(log(h).some((e) => e.cmd === 'spawn exit'), false);
    assert.doesNotMatch(fs.readFileSync(spawned.log, 'utf8'), /final foreground output/,
      'the retained pipe has not delivered its final output');
  } finally {
    fs.writeFileSync(writerRelease, 'release');
    result = await completed;
  }
  assert.equal(result.code, 2, result.stderr);
  const events = log(h);
  const exited = events.find((e) => e.cmd === 'spawn exit');
  const logText = fs.readFileSync(spawned.log, 'utf8');
  assert.match(logText, /final foreground output/);
  assert.ok(exited);
});

test('a 45 KiB brief launches through the monitor job file, not monitor argv', (t) => {
  const size = 45 * 1024;
  const h = setup(t);
  const monitorArgvFile = path.join(h.base, 'monitor-argv.json');
  const workerResult = path.join(h.base, 'brief-result.json');
  const hook = path.join(__dirname, 'fixtures', 'supervision-followups.js').replace(/\\/g, '/');
  const script = `
const cp = require('node:child_process');
const fs = require('node:fs');
cp.execFileSync(process.execPath, [process.argv[1], 'claim', 'T1', '--lease', '1']);
const text = fs.readFileSync(process.argv[3], 'utf8');
fs.writeFileSync(process.argv[2], JSON.stringify({
  bytes: Buffer.byteLength(text),
  containsBrief: text.includes('x'.repeat(${size})),
}));
`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([
    process.execPath, '-e', script, BIN, workerResult, '{brief}',
  ])]);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'x'.repeat(size) });
  const result = h.run(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: {
      NODE_OPTIONS: `--require "${hook}"`,
      TOWER_CRANE_TEST_MONITOR_ARGV: monitorArgvFile,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const readBrief = JSON.parse(fs.readFileSync(workerResult, 'utf8'));
  assert.ok(readBrief.bytes >= size);
  assert.equal(readBrief.containsBrief, true);
  const captured = JSON.parse(fs.readFileSync(monitorArgvFile, 'utf8'));
  const monitorIndex = captured.args.findIndex((arg) => path.basename(arg) === 'spawn-monitor.js');
  assert.notEqual(monitorIndex, -1, 'the captured command launches the monitor');
  assert.equal(captured.args.length - monitorIndex, 2, 'the monitor gets only one argument after its script');
  assert.equal(path.basename(captured.args[monitorIndex + 1]), 'job.json');
  assert.ok(!captured.args.some((arg) => arg.includes('x'.repeat(1024))), 'the prompt is not in monitor argv');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('rework cannot resume a session while its transient rerun is still alive', async (t) => {
  const h = setup(t, { waitForFinish: true, sessionReceipt: true });
  const spawned = h.json(['spawn', '--task', 'T1']);
  try {
    await until(() => h.readAttempts().length === 2, 'transient rerun did not start');
    h.ok(['submit', 'T1', '--agent', spawned.agent, '--sha', 'abcdef1']);
    h.ok(['rework', 'T1', '--reason', 'review correction']);
    const result = h.run(['spawn', '--task', 'T1']);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /previous worker.*still running/);
  } finally {
    fs.writeFileSync(`${h.attempts}.finish`, '');
  }
  await until(() => !detachedAlive({ pid: spawned.monitor_pid }), 'previous supervisor did not finish');
});
});
