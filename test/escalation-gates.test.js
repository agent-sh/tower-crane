'use strict';

// Escalation on gate and review failures: confirmed failures climb to the
// range ceiling, unconfirmed ones do not, retried exits, sandboxed and
// brokered reviewers, resource locks and native harness spend.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pinRung } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { killPid } = require('./signals');
const { events, preloadOption, setup } = require('./escalation-helpers');

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
  const { exited } = await h.exitSignal({ pid: spawn.monitor_pid });
  killPid(spawn.pid, 'SIGKILL');
  await h.until(() => events(h).some((e) => e.cmd === 'spend' && e.detail.source === `spawn:${spawn.agent}`));
  // The monitor's reactions can still run after the spend, and a climb would come from them.
  await exited;
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
    killPid(spawn.monitor_pid, 'SIGKILL');
    killPid(spawn.pid, 'SIGKILL');
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
  killPid(spawn.pid, 'SIGKILL');
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
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  // Finish host recovery before applying the reviewer's home permission boundary.
  const { exited } = await h.exitSignal({ pid: spawn.monitor_pid });
  await exited;
  h.reviewer('T1', 'reviewer');
  const homes = path.join(h.state, 'homes');
  fs.chmodSync(homes, 0o500);
  try {
    h.ok(['evidence', 'T1', '--type', 'review', '--revision', h.revision(), '--fail', '--sha', h.git(['rev-parse', 'HEAD']),
      '--agent', 'reviewer', '--summary', 'needs rework']);
    h.ok(['recover', 'T1', '--agent', 'orchestrator']);
    await h.until(() => events(h).some((e) => e.cmd === 'rework' && e.task === 'T1'));
    assert.equal(h.json(['task', 'show', 'T1']).status, 'rework');
    assert.match(h.ok(['brief', 'get', 'T1']), /review FAIL by reviewer[\s\S]*needs rework/);
    assert.equal(h.readAttempts().length, 1);
    assert.equal(h.json(['task', 'show', 'T1']).escalation_pending, true);
  } finally {
    fs.chmodSync(homes, 0o700);
  }
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
  await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 1);
});

test('a brokered failed review leaves full-findings rework and the climb to its host', async (t) => {
  const h = await setup(t, 'review');
  const spawn = h.json(['spawn', '--task', 'T1']);
  await h.until(() => events(h).some((e) => e.cmd === 'spawn exit'));
  // The exit receipt precedes host recovery; finish that host before isolating the broker.
  const { exited } = await h.exitSignal({ pid: spawn.monitor_pid });
  await exited;
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
    assert.equal(h.readAttempts().length, 1);
    h.ok(['recover', 'T1', '--agent', 'orchestrator']);
    await h.until(() => events(h).some((e) => e.cmd === 'rework' && e.task === 'T1'));
    const rework = events(h).findLast((e) => e.cmd === 'rework' && e.task === 'T1');
    assert.equal(rework.detail.previous_revision, 1);
    assert.equal(rework.detail.revision, 2);
    assert.match(rework.detail.reason, /review FAIL by reviewer-T1-1[\s\S]*wrong result/);
    assert.match(h.ok(['brief', 'get', 'T1']), /review FAIL by reviewer-T1-1[\s\S]*wrong result/);
    await h.until(() => h.readAttempts().length === 2 && h.task().status === 'submitted');
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.tier, 'medium');
    assert.equal(task.revision, 2, 'full-findings rework invalidates the rejected revision');
    assert.equal(task.evidence.findLast((e) => e.type === 'review').revision, 1);
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
  h.ok(['recover', 'T1', '--agent', 'orchestrator']);
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
