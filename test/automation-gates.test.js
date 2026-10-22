'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HUNG_TEST_MS, waitOnRepo } = require('./signals');
const { cachedFixture, ROOT } = require('./helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { readPublished } = require('./atomic-file');
const { setup, refillFixture } = require('./automation-helpers');

function assertReworked(h, task) {
  // Refill can claim the task immediately; the event and note persist across that claim.
  const events = h.logs().filter((e) => e.cmd === 'rework' && e.task === task.id && e.detail.revision === task.revision);
  assert.equal(events.length, 1, 'this revision was sent to rework once');
  assert.equal(events[0].detail.sha, task.sha);
  assert.ok(task.notes.some((note) => note.text === `rework: ${events[0].detail.reason}`),
    'the worker keeps the failing gate reason after refill');
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`an interrupted host probe retries once before rework: ${signal}`, { skip: process.platform === 'win32' }, (t) => {
    const h = setup(t, { ci: 'pending' });
    h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"', '--tests-mode', 'run-only']);
    h.submit();
    const command = `node -e "process.kill(process.pid, '${signal}')"`;
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker', '--host-probe', command]);
    h.consume();
    const task = h.readState('tasks.json').tasks[0];
    const runs = task.evidence.filter((e) => e.type === 'tests');
    assert.equal(runs.length, 2, 'an interrupted probe retries once, not immediately reworked');
    assertReworked(h, task);
    for (const evidence of runs) {
      assert.equal(evidence.runner_crash, true);
      assert.equal(evidence.worker_failure, undefined);
      assert.equal(evidence.receipt.host_probes[0].timed_out, false);
    }
  });
}

test('CI completion refreshes a pending receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'pending';
  h.saveGithub(bad);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const good = h.github();
  good.ci[h.sha] = 'success';
  h.saveGithub(good);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.ok), [false, true]);
  assert.equal(task.evidence.at(-1).type, 'merge');
  const calls = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--match-head-commit') + 1], h.sha);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', 'fffffff', '--agent', 'orchestrator']).code, 1);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker']).code, 1);
});

test('a passing gate reruns in the next reaction after its pinned command changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new command');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.gate_policy.tests_cmd, 'node -e "process.exit(0)"');
});

test('a passing gate reruns in the next reaction after its tests mode changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"', '--tests-mode', 'run-only']);
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new mode');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.tests_mode, 'none');
});

function reconciledFixture(t) {
  const h = cachedFixture(t, 'reconciled-submission', (repo) => {
    const h = setup(null, { repo });
    h.submit();
    h.consume();
    return { sha: h.sha };
  });
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.reconcile = () => h.run(['wait', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator']); // wait-allow: end the idle observation after startup reconciliation; assertions read state after the CLI exits
  return h;
}

for (const reaction of ['submit', 'reconcile']) {
  test(`${reaction} reworks a resubmitted revision whose tests fail, before its missing gates run`, (t) => {
    const h = reconciledFixture(t);
    h.ok(['brief', 'set', 'T1', '-', '--agent', 'orchestrator'],
      { input: '# Change\n\nVerify the revised acceptance.\n' });
    h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.revision, 2);
    assert.ok(task.evidence.every((e) => e.revision === 1), 'only historical evidence survives resubmission');
    const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
    const count = checks().length;
    if (reaction === 'reconcile') {
      // T155's submit reaction recorded a revision-2 tests failure, then
      // finished before clean and CI. Startup must settle that failure into rework.
      assert.equal(h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']).code, 1);
      const source = h.logs().findLast((e) => e.cmd === 'submit').id;
      fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
        at: new Date().toISOString(), agent: 'orchestrator', cmd: 'automation', task: 'T1',
        detail: { source, phase: 'done' },
      }) + '\n');
      assert.equal(h.reconcile().code, 2);
    } else {
      assert.equal(h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0',
        '--agent', 'orchestrator']).code, 2);
    }
    assert.deepEqual(checks().slice(count).map((e) => [e.cmd, e.detail.ok, e.detail.revision]),
      [['check tests', false, 2]]);
    const after = h.json(['task', 'show', 'T1']);
    assertReworked(h, after);
    assert.equal(after.gates.gates.find((g) => g.type === 'tests').ok, false);
    h.reconcile();
    assert.equal(checks().length, count + 1, 'a reworked task runs no more gates');
  });
}

for (const obsolete of ['revision', 'sha']) {
  for (const reaction of ['submit', 'reconcile']) {
    test(`${reaction} runs software gates with only earlier ${obsolete} evidence`, (t) => {
      const h = reconciledFixture(t);
      // Keep an audited failure too: only a failure at the current revision
      // and head can wait for an explicit retry.
      h.env.FIXTURE_GATE_OK = '0';
      assert.equal(h.run(['check', 'clean', 'T1']).code, 1);
      delete h.env.FIXTURE_GATE_OK;
      const previous = h.json(['task', 'show', 'T1']);
      const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
      const count = checks().length;
      let sha = h.sha;
      if (obsolete === 'revision') {
        h.ok(['brief', 'set', 'T1', '-', '--agent', 'orchestrator'],
          { input: '# Change\n\nVerify the revised acceptance.\n' });
      } else {
        fs.appendFileSync(path.join(h.repo, 'README.md'), 'Resubmitted change.\n');
        h.git(['add', 'README.md']);
        h.git(['commit', '-qm', 'resubmitted head']);
        sha = h.git(['rev-parse', 'HEAD']);
        const github = JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
        github.prs[7].headRefOid = sha;
        github.ci[sha] = 'success';
        fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(github));
      }
      h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
      const submitted = h.json(['task', 'show', 'T1']);
      assert.equal(submitted.revision, obsolete === 'revision' ? 2 : previous.revision);
      assert.deepEqual(submitted.evidence, previous.evidence, 'resubmission keeps historical receipts');
      assert.ok(submitted.gates.gates.filter((g) => g.type !== 'review').every((g) => !g.ok));
      if (reaction === 'reconcile') {
        // A completed submit reaction must not suppress startup reconciliation.
        const events = h.logs();
        const source = events.findLast((e) => e.cmd === 'submit').id;
        fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
          at: new Date().toISOString(), agent: 'orchestrator', cmd: 'automation', task: 'T1',
          detail: { source, phase: 'done' },
        }) + '\n');
        assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [], deferred: [] });
        assert.equal(h.reconcile().code, 2);
      } else {
        assert.equal(h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0',
          '--agent', 'orchestrator']).code, 2);
      }
      assert.deepEqual(checks().slice(count).map((e) => [e.cmd, e.detail.ok, e.detail.sha, e.detail.revision]),
        ['tests', 'clean', 'ci'].map((type) => [`check ${type}`, true, sha, submitted.revision]));
      const after = h.json(['task', 'show', 'T1']);
      assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
      assert.equal(after.status, 'submitted', 'software evidence does not replace independent review');
      h.reconcile();
      assert.equal(checks().length, count + 3, 'current receipts prevent duplicate runs');
    });
  }
}

for (const entries of ['absent', 'unaudited pass', 'unaudited failure']) {
  test(`startup reconciles missing software evidence with ${entries} entries and an empty queue`, (t) => {
    const h = reconciledFixture(t);
    const tasks = h.readState('tasks.json');
    const task = tasks.tasks[0];
    if (entries === 'absent') task.evidence = [];
    else for (const entry of task.evidence) entry.ok = entries === 'unaudited pass';
    fs.writeFileSync(path.join(h.state, 'tasks.json'), JSON.stringify(tasks));
    const events = h.logs().filter((e) => !['check tests', 'check clean', 'check ci'].includes(e.cmd));
    fs.writeFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
    const before = h.json(['task', 'show', 'T1']);
    assert.ok(before.gates.gates.filter((g) => g.type !== 'review').every((g) => !g.ok));
    assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [], deferred: [] });
    assert.ok(events.some((e) => e.cmd === 'automation' && e.detail.phase === 'done'));

    assert.equal(h.reconcile().code, 2);
    const checks = h.logs().filter((e) => e.cmd.startsWith('check '));
    assert.deepEqual(checks.map((e) => [e.cmd, e.detail.ok, e.detail.sha, e.detail.revision]),
      ['tests', 'clean', 'ci'].map((type) => [`check ${type}`, true, h.sha, task.revision]));
    const after = h.json(['task', 'show', 'T1']);
    assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
    assert.equal(after.status, 'submitted', 'software evidence does not replace independent review');
    h.reconcile();
    assert.equal(h.logs().filter((e) => e.cmd.startsWith('check ')).length, 3, 'valid receipts prevent duplicate runs');
  });
}

test('startup reconciles tests evidence staled by a tests keep setting change after a completed reaction', (t) => {
  const h = reconciledFixture(t);
  const checks = () => h.logs().filter((e) => e.cmd.startsWith('check '));
  const before = checks();
  assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [], deferred: [] });
  h.ok(['project', 'set', '--tests-keep', '["test/**","docs/**"]']);
  const stale = h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests');
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /tests evidence no longer matches/);
  assert.equal(h.reconcile().code, 2);
  const added = checks().slice(before.length);
  assert.deepEqual(added.map((e) => [e.cmd, e.detail.ok]), [['check tests', true]]);
  assert.deepEqual(added[0].detail.gate_policy.keep, ['test/**', 'docs/**']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('a deterministic test failure reworks with its failing test names and output tail', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'failing-tests.js');
  // Fails only at the submitted head: the base holds value.js at 0, so the same test passes there.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) process.exit(0);\nconsole.log('# Subtest: test/sum.test.js');\nconsole.log('not ok 1 - sums two numbers');\nconsole.log('  expected 3 got 4');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const runs = h.logs().filter((e) => e.cmd === 'check tests');
  assert.equal(runs.length, 1, 'a failure that is not infrastructure is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  const latest = task.evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.ok, false);
  assert.deepEqual(latest.test_failure.names, ['sums two numbers']);
  const reason = h.logs().findLast((e) => e.cmd === 'rework').detail.reason;
  assert.match(reason, /^tests failed at [0-9a-f]{7,}: /);
  assert.match(reason, /Failing tests:\n- sums two numbers/);
  assert.match(reason, /expected 3 got 4/);
  assert.equal(latest.main_failure, undefined, 'a failure that passes on main is the change\'s');
});

test('rework retains every first error outside the tail and gate log reads it through each task broker', async (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'error-blocks.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
if (!fs.readFileSync('value.js', 'utf8').includes('1')) { console.log('base passed'); process.exit(0); }
console.log('✖ early failure (1ms)');
console.log('✖ late failure (2ms)');
console.log('ℹ tests 2');
console.log('✖ failing tests:');
console.log('test at test/early.test.js:1:1');
console.log('✖ early failure (1ms)');
console.log('  AssertionError: early own error');
console.log('    at early (test/early.test.js:2:1)');
console.log('test at test/late.test.js:1:1');
console.log('✖ late failure (2ms)');
console.log('  Error: late own error');
for (let i = 0; i < 80; i++) console.log('    at frame' + i + ' (test/late.test.js:3:1)');
process.exit(1);
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const task = require('../lib/state').loadState(h.state).tasks.tasks[0];
  assertReworked(h, task);
  const latest = task.evidence.filter((e) => e.type === 'tests').at(-1);
  assert.doesNotMatch(latest.test_failure.output_tail, /early own error/);
  const reason = h.logs().findLast((e) => e.cmd === 'rework').detail.reason;
  assert.match(reason, /AssertionError: early own error/);
  assert.match(reason, /Error: late own error/);
  assert.match(reason, /error block truncated.*logs\/tests-T1-/);
  const logs = latest.receipt.test_logs;
  assert.deepEqual(logs.map((r) => r.phase), ['head', 'base']);
  const head = fs.readFileSync(path.join(h.state, logs[0].log), 'utf8');
  assert.match(head, /at frame79/);
  assert.equal(h.ok(['gate', 'log', 'T1']), head.trim());
  assert.equal(h.ok(['gate', 'log', 'T1', '--run', 'base']), 'base passed');
  assert.match(h.run(['gate', 'log', 'T1', '--test', 'missing']).stderr, /no failing test named/);
  assert.match(h.run(['gate', 'log', 'T1', '--type', 'clean']).stderr, /supports --type tests/);
  assert.match(h.run(['gate', 'log', 'T1', '--run', 'other']).stderr, /must be head, base/);

  const B = require('../lib/broker');
  for (const role of ['worker', 'reviewer']) {
    const agent = `${role}-T1-log`;
    const broker = await B.start({ state: h.state, task: 'T1', agent, role, harness: 'codex',
      cwd: h.repo, broker: path.join(h.base, 'brokers', agent, B.FILE) });
    try {
      const env = { ...broker.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_TASK: 'T1' };
      const read = await h.runAsync(['gate', 'log', 'T1', '--type', 'tests', '--test', 'early failure'], { env });
      assert.equal(read.code, 0, read.stderr);
      assert.match(read.stdout, /AssertionError: early own error\n\s+at early/);
      assert.doesNotMatch(read.stdout, /late own error|frame79/);
      const denied = await h.runAsync(['gate', 'log', 'T2'], { env });
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /works on T1 only/);
    } finally {
      broker.close();
    }
  }
  fs.rmSync(path.join(h.state, logs[0].log));
  assert.match(h.run(['gate', 'log', 'T1']).stderr, /missing or was pruned/);
});

test('many failing tests bound rework diagnostics and keep omitted blocks readable through the broker', async (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'many-errors.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
if (!fs.readFileSync('value.js', 'utf8').includes('1')) process.exit(0);
for (let i = 0; i < 300; i++) {
  console.log('✖ noisy ' + i + ' (1ms)');
  console.log('  Error: own error ' + i);
  for (let frame = 0; frame < 8; frame++) console.log('    at ' + 'x'.repeat(250) + ' (test/noisy.test.js:2:1)');
}
for (let i = 0; i < 100; i++) console.log('runner finished');
process.exitCode = 1;
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const task = require('../lib/state').loadState(h.state).tasks.tasks[0];
  assertReworked(h, task);
  const failure = task.evidence.findLast((e) => e.type === 'tests').test_failure;
  assert.ok(Buffer.byteLength(JSON.stringify(failure.blocks)) <= 32 * 1024);
  assert.equal(failure.names.length, 300);
  assert.ok(failure.blocks_omitted > 0);
  assert.equal(failure.blocks.length + failure.blocks_omitted, failure.names.length);
  const event = h.logs().findLast((e) => e.cmd === 'check tests');
  assert.deepEqual(event.detail.test_failure.blocks, failure.blocks);
  const reason = h.logs().findLast((e) => e.cmd === 'rework').detail.reason;
  assert.match(reason, new RegExp(`${failure.blocks_omitted} more failing tests; see logs/tests-T1-`));
  assert.match(reason, /- noisy 299/);
  assert.doesNotMatch(reason, /Error: own error 299/);
  const B = require('../lib/broker');
  const agent = 'worker-T1-many';
  const broker = await B.start({ state: h.state, task: 'T1', agent, role: 'worker', harness: 'codex',
    cwd: h.repo, broker: path.join(h.base, 'brokers', agent, B.FILE) });
  try {
    const read = await h.runAsync(['gate', 'log', 'T1', '--test', 'noisy 299'], {
      env: { ...broker.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_TASK: 'T1' },
    });
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /Error: own error 299/);
  } finally {
    broker.close();
  }
});

test('a timed-out test run retries once at its head and the passing retry keeps the task submitted', (t) => {
  const h = setup(t, { ci: 'pending' });
  const marker = path.join(h.base, 'timed-out-once');
  const script = path.join(h.base, 'slow-once.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);\nfs.writeFileSync(${JSON.stringify(marker)}, '');\nsetTimeout(() => {}, 10000);\n`); // wait-allow: hold the first fixture run alive until the gate timeout; its retry exits on the marker
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only', '--tests-timeout-min', '0.05']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the timeout runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [true, false]]);
  assert.equal(task.status, 'submitted');
});

test('a timeout that repeats at its head reworks after the retry', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'hang.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 10000);\n'); // wait-allow: hold the fixture alive to verify the configured gate timeout and its retry
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only', '--tests-timeout-min', '0.05']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2);
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /timed out after 0\.05 min/);
});

test('a test run killed by a signal retries once and reworks when the retry is also killed', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'killed.js');
  fs.writeFileSync(script, 'process.kill(process.pid, \'SIGKILL\');\n');
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.runner_crash === true), [true, true]);
  assertReworked(h, task);
});

test('a test command that is not installed stays submitted, and the inbox asks the orchestrator to pin one', (t) => {
  const h = setup(t, { ci: 'success' });
  h.ok(['project', 'set', '--tests-cmd', 'tower-crane-no-such-tool', '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a missing command is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.evidence.filter((e) => e.type === 'tests').at(-1).ok, false);
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', false], ['clean', true], ['ci', true]]);
  const items = h.json(['inbox', '--agent', 'orchestrator']).items.filter((i) => i.kind === 'gate_config');
  assert.deepEqual(items.map((i) => [i.task, i.gate, i.setting, i.addressed_to]), [['T1', 'tests', 'gates.tests_cmd', 'orchestrator']]);
  assert.deepEqual(items[0].action.argv.slice(0, 3), ['project', 'set', '--tests-cmd']);
  assert.equal(h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.kind === 'gate_failed'), false, 'no failed-gate item for configuration');
});

for (const [configuration, failure] of [['tests', 'ci'], ['tests', 'clean'], ['clean', 'ci']]) {
  test(`a ${configuration} configuration failure does not hide an audited ${failure} failure`, (t) => {
    const h = setup(t, { ci: failure === 'ci' ? 'failure' : 'pending' });
    delete h.env.TOWER_CRANE_CLEAN_CMD;
    h.ok(['project', 'set', `--${configuration}-cmd`,
      configuration === 'tests' ? 'null' : 'tower-crane-no-such-cleaner']);
    if (failure === 'clean') {
      const script = path.join(h.base, 'incomplete-clean.js');
      fs.writeFileSync(script, "console.log(JSON.stringify({items: [], failedChecks: ['cannot scan changed source']}));\n");
      h.ok(['project', 'set', '--clean-cmd', `node ${shellQuote(script)}`]);
    }
    h.submit();
    h.ok(['project', 'set', '--paused', 'inspect gate settlement']);
    assert.equal(h.run(['check', failure, 'T1', '--agent', 'orchestrator']).code, 1);
    h.consume();
    const task = h.readState('tasks.json').tasks[0];
    assertReworked(h, task);
    assert.deepEqual(task.evidence.filter((e) => e.type === configuration).at(-1).config_failure,
      { key: `${configuration}_cmd` });
    const receipts = task.evidence.filter((e) => e.type === failure);
    assert.equal(receipts.length, failure === 'clean' ? 2 : 1, 'cleanup retries once; the audited CI verdict reworks without rerunning');
    assert.ok(receipts.every((e) => !e.ok));
    if (failure === 'clean') assert.ok(receipts.every((e) => e.infrastructure_failure));
    else assert.equal(receipts[0].confirmed_failure, true);
    const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
    assert.equal(reworks.length, 1);
    assert.match(reworks[0].detail.reason, new RegExp(`^${failure} failed at [0-9a-f]+: `));
    assert.match(reworks[0].detail.reason, failure === 'clean' ? /cannot scan changed source/ : /failing: test \(failure\)/);
    assert.deepEqual(h.json(['status']).gate_queue, { running: [], queued: [], blocked: [], deferred: [] });
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === `check ${failure}`).length, receipts.length, 'settlement starts no extra gate runs');
  });
}

test('a missing pinned test command stays submitted with a gate_config item for the orchestrator, not a rework', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').at(-1).config_failure, { key: 'tests_cmd' });
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.then, 'gates retry T1');
  assert.match(item.summary, /no test command pinned in project\.json gates\.tests_cmd/);
});

test('a proof run killed after the change is reverted retries once and reworks when the retry is also killed', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'proof-killed.js');
  // Passes at the submitted head, where value.js is 1, and is killed once the change is reverted to 0.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (fs.readFileSync('value.js', 'utf8').includes('0')) process.kill(process.pid, 'SIGKILL');\n");
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--tests-mode', 'prove', '--tests-expensive', 'true',
    '--tests-proof-cmd', `node ${shellQuote(script)} {tests}`]);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the killed proof runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.ok, e.runner_crash === true]), [[false, true], [false, true]]);
  assertReworked(h, task);
});

test('a missing pinned proof command stays submitted with a gate_config item for the orchestrator, not a rework', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--tests-mode', 'prove', '--tests-expensive', 'true', '--tests-proof-cmd', 'null']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').at(-1).config_failure, { key: 'tests_proof_cmd' });
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.setting, 'gates.tests_proof_cmd');
  assert.equal(item.then, 'gates retry T1');
});

test('a change that adds no test reworks with the reason, and the worker adds a test', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.git(['switch', '-qc', 'no-test-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['commit', '-qam', 'change without a test']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const github = h.github();
  Object.assign(github.prs['7'], { headRefOid: sha, headRefName: 'no-test-change' });
  h.saveGithub(github);
  h.submit('T1', sha);
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a change with no test is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  assert.equal(task.evidence.filter((e) => e.type === 'tests').at(-1).worker_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]{7,}: no test covers this change: .*adds or changes no test file/);
});

test('a GitHub API observation failure retries once and keeps the submission when GitHub recovers', (t) => {
  const h = setup(t);
  h.submit();
  const github = h.github();
  github.apiFailures = 1;
  h.saveGithub(github);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [true, false]]);
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2);
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  assert.equal(task.status, 'submitted');
});

test('a GitHub API observation failure that repeats retries once and reworks with the transport error', (t) => {
  const h = setup(t);
  h.submit();
  const github = h.github();
  github.apiFailures = 2;
  h.saveGithub(github);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [false, true]]);
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2);
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /ci failed at .*HTTP 502: Bad Gateway/s);
});

test('a stale GitHub PR observation failure retries after recovery instead of reworking green CI', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.ok(['project', 'set', '--paused', 'manual CI observation probe']);
  const outage = h.github();
  outage.failView = true;
  h.saveGithub(outage);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  const recovered = h.github();
  recovered.failView = false;
  recovered.ci[h.sha] = 'success';
  h.saveGithub(recovered);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) =>
    [e.ok, e.pending === true, e.infrastructure_failure === true]),
  [[false, true, false], [false, false, true], [true, false, false]]);
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 3);
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0);
  assert.equal(task.status, 'submitted');
});

test('a CI run that was cancelled retries once and reworks when it is cancelled again', (t) => {
  const h = setup(t, { ci: 'cancelled' });
  h.submit();
  const before = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  const checks = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs'));
  assert.equal(checks.length - before, 2, 'a cancelled run is read once more and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [false, true]]);
  assertReworked(h, task);
});

test('a CI run that needs action sends a submitted task to rework at once, with its conclusion', (t) => {
  const h = setup(t, { ci: 'action_required' });
  h.submit();
  const before = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length - before, 1, 'a verdict on the change is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  assert.equal(task.evidence.filter((e) => e.type === 'ci').at(-1).worker_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: .*action_required/s);
});

test('a CI run that times out retries once and reworks when it times out again', (t) => {
  const h = setup(t, { ci: 'timed_out' });
  h.submit();
  const before = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  const checks = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs'));
  assert.equal(checks.length - before, 2, 'the CI gate reads GitHub once more and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, true], [false, true]]);
  assertReworked(h, task);
});

test('a failed CI run sends a submitted task to rework with the failing run', (t) => {
  const h = setup(t, { ci: 'failure' });
  h.submit();
  const before = h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length - before, 1, 'a code failure is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  assert.equal(task.evidence.filter((e) => e.type === 'ci').at(-1).confirmed_failure, true);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: .*failing: test \(failure\)/s);
});

test('a CI timeout after a pending check retries once: the pending receipt is not a failure', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  const checkRuns = () => h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  const before = checkRuns();
  const timedOut = h.github();
  timedOut.ci[h.sha] = 'timed_out';
  h.saveGithub(timedOut);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(checkRuns() - before, 2, 'the first timeout reads CI once more before it reworks');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => [e.ok, e.infrastructure_failure === true]),
    [[false, false], [false, true], [false, true]]);
  assertReworked(h, task);
});

test('a local CI command killed by a signal retries once and reworks when the retry is killed too', { skip: process.platform === 'win32' }, async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  const script = path.join(h.base, 'local-killed.js');
  fs.writeFileSync(script, 'process.kill(process.pid, \'SIGKILL\');\n');
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 5 })]);
  h.submit();
  h.consume();
  await waitFor(h.marker('T1'), { what: 'the refill claims the reworked task before it is inspected' });
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2, 'the killed run runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.runner_crash === true), [true, true]);
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: local CI killed by SIGKILL/);
});

test('a local CI command that times out retries once and reworks when the retry times out too', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'local-hang.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 10000);\n'); // wait-allow: hold local CI alive to verify timeout classification and its retry
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 0.05 })]);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, 2, 'the timeout runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.infrastructure_failure === true), [true, true]);
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^ci failed at [0-9a-f]+: local CI timed out/);
});

// ginza's T26: main moved during each 2 h local CI run, every run was voided as "merged tree
// moved", and each void reworked the task and cleared its other gates.
test('main moving during local CI leaves a pinned pass, the revision and the other gates as they were', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.git(['switch', '-q', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Base moves during the check.\n');
  h.git(['commit', '-qam', 'base advances while local CI runs']);
  const later = h.git(['rev-parse', 'HEAD']);
  h.git(['reset', '-q', '--hard', 'HEAD~1']);
  const base = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'fixture-change']);
  const script = path.join(h.base, 'local-moves-base.js');
  fs.writeFileSync(script, `require('node:child_process').execFileSync('git', ['update-ref', 'refs/heads/main', ${JSON.stringify(later)}]);\n`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 30 })]);
  h.submit();
  const revision = h.readState('tasks.json').tasks[0].revision;
  h.consume();
  assert.equal(h.git(['rev-parse', 'main']), later, 'main moved during the run');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.revision, revision);
  assert.ok(!h.logs().some((e) => e.cmd === 'rework'), 'no rework');
  const ci = task.evidence.filter((e) => e.type === 'ci');
  assert.deepEqual(ci.map((e) => [e.ok, e.receipt.base_sha]), [[true, base]], 'one run, on the base it read at the start');
  const report = h.json(['task', 'show', 'T1', '--agent', 'orchestrator']).gates.gates;
  assert.deepEqual(report.filter((g) => g.type !== 'review').map((g) => [g.type, g.ok]), [['tests', true], ['clean', true], ['ci', true]]);
});

test('a test that also fails on main retries once, then reworks with the main failure to link', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'known-failure.js');
  fs.writeFileSync(script, "console.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on main runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.main_failure?.names), [['known base failure'], ['known base failure']]);
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]+: .*Also fails on main at [0-9a-f]+: known base failure/s);
});

test('a host-only test main fails with the same error retries once, stays submitted with the inbox naming it, and reruns when main moves', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'known-host-failure.js');
  fs.writeFileSync(script, ["console.log('# Subtest: test/value.test.js');", "console.log('not ok 1 - known host failure');",
    "console.log('  error: \\'the shared config stays read-only\\'');", 'process.exit(1);'].join('\n'));
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"', '--tests-mode', 'run-only',
    '--tests-proof-cmd', `node ${shellQuote(script)} {tests}`, '--tests-host-only', '["test/value.test.js"]']);
  h.submit();
  h.consume();
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  assert.equal(runs(), 2, 'a flaky host test gets its one retry, and no third run');
  let task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 0, 'the task is not reworked for main\'s failure');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.main_failure?.names, e.infrastructure_failure, e.confirmed_failure]),
    [[['known host failure'], true, undefined], [['known host failure'], true, undefined]]);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_failed' && i.gate === 'tests');
  assert.ok(item, 'the inbox shows the failed tests gate');
  assert.deepEqual(item.main_failure.names, ['known host failure']);
  assert.equal(item.infrastructure_failure, true);
  assert.deepEqual(item.action.argv, ['check', 'tests', 'T1']);
  assert.match(item.summary, /Also fails on main at [0-9a-f]+: known host failure\. Infrastructure:/);
  h.consume();
  assert.equal(runs(), 2, 'nothing reruns while main stays where it failed');
  // main moves: the base's verdict can change, so the gate runs again, once.
  const moved = h.git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'main moves']);
  h.git(['update-ref', 'refs/heads/main', moved]);
  h.consume();
  assert.equal(runs(), 3, 'the gate reruns once main moves past the recorded base');
  task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.evidence.filter((e) => e.type === 'tests').at(-1).main_failure.base, moved.slice(0, 10));
  h.consume();
  assert.equal(runs(), 3, 'the rerun recorded the new base, so it does not repeat');
});

test('a test failure whose base rerun is killed is not confirmed, retries once and reports the unchecked base', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'base-killed.js');
  // Fails by name at the submitted head, where value.js is 1, and is killed on the base, where it is 0.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) process.kill(process.pid, 'SIGKILL');\nconsole.log('# Subtest: test/sum.test.js');\nconsole.log('not ok 1 - sums two numbers');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'a killed base rerun runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  const runs = task.evidence.filter((e) => e.type === 'tests');
  assert.deepEqual(runs.map((e) => [e.confirmed_failure, e.main_failure]), [[undefined, undefined], [undefined, undefined]],
    'the base never said which names fail there, so the failure is not confirmed');
  for (const run of runs) {
    assert.match(run.base_rerun_killed.base, /^[0-9a-f]+$/);
    assert.ok(run.base_rerun_killed.signal === 'SIGKILL' || run.base_rerun_killed.status === 137, JSON.stringify(run.base_rerun_killed));
  }
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'check tests').map((e) => e.detail.base_rerun_killed), runs.map((e) => e.base_rerun_killed),
    'the audit event carries the same flag as the evidence');
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason,
    /Base rerun at [0-9a-f]+ was killed \((?:SIGKILL|exit 137)\); shared failures were not checked\./);
});

test('a test failure whose base rerun times out is not confirmed, retries once and reports the unchecked base', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'base-hangs.js');
  // Fails by name at the submitted head, where value.js is 1, and outlives the gate deadline on the base, where it is 0.
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) setTimeout(() => {}, 60000);\n" // wait-allow: outlive the gate deadline on the base
    + "else {\n  console.log('# Subtest: test/sum.test.js');\n  console.log('not ok 1 - sums two numbers');\n  process.exit(1);\n}\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only', '--tests-timeout-min', '0.05']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'a timed-out base rerun runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  const runs = task.evidence.filter((e) => e.type === 'tests');
  assert.deepEqual(runs.map((e) => [e.confirmed_failure, e.main_failure, e.infrastructure_failure]), [[undefined, undefined, undefined], [undefined, undefined, undefined]],
    'the base never said which names fail there, so the failure is not confirmed');
  for (const run of runs) {
    assert.match(run.base_rerun_timed_out.base, /^[0-9a-f]+$/);
    assert.equal(run.base_rerun_timed_out.minutes, 0.05);
  }
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'check tests').map((e) => e.detail.base_rerun_timed_out), runs.map((e) => e.base_rerun_timed_out),
    'the audit event carries the same flag as the evidence');
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason,
    /Base rerun at [0-9a-f]+ timed out after 0\.05 min; shared failures were not checked\./);
});

test('a second wait signal during the base rerun records base_rerun_killed, and the next wait retries once', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX signals' : false,
}, async (t) => {
  const h = setup(t, { ci: 'pending' });
  const started = path.join(h.base, 'base-started');
  const release = path.join(h.base, 'base-release');
  const script = path.join(h.base, 'base-held.js');
  // Fails by name at the submitted head, where value.js is 1, and holds the base rerun, where it is 0, until released.
  // The script finds its files next to itself, so no test value is spliced into its code.
  fs.writeFileSync(script, `const fs = require('node:fs');
const path = require('node:path');
if (!fs.readFileSync('value.js', 'utf8').includes('1')) {
  // The test reads this pid after the rerun is killed, so it is renamed into place, never read empty.
  const started = path.join(__dirname, 'base-started');
  fs.writeFileSync(started + '.tmp', String(process.pid));
  fs.renameSync(started + '.tmp', started);
  const until = Date.now() + ${HUNG_TEST_MS}; // wait-allow: an orphaned rerun stops itself; the release file is its signal
  const poll = () => fs.existsSync(path.join(__dirname, 'base-release')) || Date.now() > until ? process.exit(0) : setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
  poll();
} else {
  console.log('# Subtest: test/sum.test.js');
  console.log('not ok 1 - sums two numbers');
  process.exit(1);
}
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  const observed = path.join(h.base, 'signal-observed');
  const preload = path.join(h.base, 'signal-observer.js');
  // A receipt synchronizes the test with the first signal before it sends the second.
  fs.writeFileSync(preload, "process.on('SIGTERM', () => require('node:fs').appendFileSync(require('node:path').join(__dirname, 'signal-observed'), 'SIGTERM\\n'));\n");
  const child = h.spawnCli(['wait', '--after', '0', '--types', 'never', '--timeout', '300', '--agent', 'orchestrator'],
    { pre: ['--require', preload] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), HUNG_TEST_MS);
  // Fixture cleanup runs these first, while the fixture still exists.
  h.teardown.push(async () => {
    clearTimeout(timer);
    fs.writeFileSync(release, '');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await result;
  });
  await waitFor(started, { nonempty: true, what: 'the base rerun starts' });
  child.kill('SIGTERM');
  await waitFor(observed, { what: 'wait receives the first signal' });
  assert.equal(child.exitCode, null, 'the base rerun still holds wait open');
  child.kill('SIGTERM');
  const exit = await result;
  assert.equal(exit.code, 0, JSON.stringify(exit));
  assert.match(exit.stdout, /stopped by SIGTERM after draining 0 gates/);
  const pid = Number(readPublished(started, 'utf8'));
  assert.equal(require('../lib/processes').processState({ pid }), 'exited', 'the second signal kills the base rerun');
  const first = h.readState('tasks.json').tasks[0];
  assert.equal(first.status, 'submitted', 'shutdown leaves the interrupted gate for the next wait');
  const killed = first.evidence.filter((e) => e.type === 'tests');
  assert.equal(killed.length, 1);
  assert.equal(killed[0].confirmed_failure, undefined, 'the base never said which names fail there');
  assert.match(killed[0].base_rerun_killed.base, /^[0-9a-f]+$/);
  assert.equal(killed[0].base_rerun_killed.signal, 'SIGKILL');
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'check tests').map((e) => e.detail.base_rerun_killed), [killed[0].base_rerun_killed],
    'the audit event carries the same flag as the evidence');

  // The retry's base rerun finishes and passes, so the head's failure is confirmed and reworks.
  fs.writeFileSync(release, '');
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the killed base rerun runs once more, and no third time');
  const task = h.readState('tasks.json').tasks[0];
  const runs = task.evidence.filter((e) => e.type === 'tests');
  assert.equal(runs[1].sha, runs[0].sha, 'the retry runs at the same head');
  assert.equal(runs[1].base_rerun_killed, undefined);
  assert.ok(runs[1].confirmed_failure, 'the base passed, so the failure is the head\'s own');
  assertReworked(h, task);
});

test('a test gate that fails by hand while the watcher runs reworks, not left submitted', async (t) => {
  const h = setup(t, { ci: 'pending' });
  const flag = path.join(h.base, 'broken');
  const script = path.join(h.base, 'breaks-when-flagged.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(flag)})) process.exit(1);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const finished = () => h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'done').length;
  const before = finished();
  const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const watcher = h.runAsync(['wait', '--after', String(offset), '--types', 'rework', '--timeout', '300', '--agent', 'orchestrator']);
  // The watcher's startup reconcile settles the submission first; the failure comes after it.
  await waitOnRepo(h, () => finished() > before, 'the watcher reconciles the submission');
  assert.ok(finished() > before, 'the watcher reconciled the submitted task');
  fs.writeFileSync(flag, '');
  assert.equal(h.run(['check', 'tests', 'T1']).code, 1);
  assert.equal((await watcher).code, 0, 'the watcher observes the rework signal');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /^tests failed at [0-9a-f]+: /);
});

test('a test that also fails on main reworks without a quality climb on a task with a tier range', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  const script = path.join(h.base, 'known-failure.js');
  fs.writeFileSync(script, "console.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on main runs once more');
  await waitFor(h.marker('T1'), { what: 'the refill claims the reworked task' });
  const task = h.readState('tasks.json').tasks[0];
  // The worker holds its claim so the test checks settlement after refill, without racing it.
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claim.from, 'rework');
  assert.equal(task.revision, 2);
  const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
  assert.equal(reworks.length, 1);
  assert.match(reworks[0].detail.reason, /^tests failed at [0-9a-f]+: .*Also fails on main at [0-9a-f]+: known base failure/s);
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => [e.main_failure?.names, e.confirmed_failure]),
    [[['known base failure'], undefined], [['known base failure'], undefined]]);
  assert.equal(task.tier, 'easy', 'a failure that also fails on main is not the change\'s, so it does not climb');
  assert.deepEqual(task.escalations ?? [], []);
});

test('a run with a failing name that does not fail on main keeps its verdict and reworks at once', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'partly-known.js');
  fs.writeFileSync(script, "const fs = require('node:fs');\nconsole.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nif (fs.readFileSync('value.js', 'utf8').includes('1')) console.log('not ok 2 - change breaks a test');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1, 'a failure with a name the change added is not retried');
  const task = h.readState('tasks.json').tasks[0];
  assertReworked(h, task);
  const latest = task.evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.confirmed_failure, true);
  assert.equal(latest.main_failure, undefined, 'only a run whose every failing name also fails on main is not the change\'s');
  assert.match(h.logs().findLast((e) => e.cmd === 'rework').detail.reason, /change breaks a test/);
});

test('a test that fails on a newer origin main retries once though the local base is behind', (t) => {
  const h = setup(t, { ci: 'pending' });
  const script = path.join(h.base, 'fails-with-value.js');
  fs.writeFileSync(script, "const fs = require('node:fs');\nif (!fs.readFileSync('value.js', 'utf8').includes('1')) process.exit(0);\nconsole.log('# Subtest: test/sum.test.js');\nconsole.log('not ok 1 - sums two numbers');\nprocess.exit(1);\n");
  // origin/main moved past local main with the change's value, so the failure exists only on the newer base.
  const moved = h.git(['commit-tree', h.git(['rev-parse', 'fixture-change^{tree}']), '-p', 'main', '-m', 'main moved']);
  h.git(['update-ref', 'refs/remotes/origin/main', moved]);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 2, 'the failure that also fails on origin main runs once more');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => e.type === 'tests').map((e) => e.main_failure?.names), [['sums two numbers'], ['sums two numbers']]);
  assertReworked(h, task);
});

test('gates retry exits nonzero while a retried gate still fails', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
  h.submit();
  h.run(['check', 'tests', 'T1']);
  const latest = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest().ok, false);
  const retry = h.run(['gates', 'retry', 'T1', '--agent', 'orchestrator']);
  assert.equal(retry.code, 1, `a retry that still fails must exit nonzero: ${retry.stdout}${retry.stderr}`);
  assert.match(retry.stdout, /tests/);
  assert.equal(latest().ok, false, 'the retry ran at the same inputs and still fails');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
});

// Local CI that fails while a marker file stands for a broken environment,
// such as a gate temporary root on a full /tmp: it exits 1, a confirmed failure.
function brokenEnvironment(t) {
  const h = setup(t, { ci: 'pending' });
  h.broken = path.join(h.base, 'environment-broken');
  fs.writeFileSync(h.broken, '');
  const script = path.join(h.base, 'local-environment.js');
  fs.writeFileSync(script, `process.exit(require('node:fs').existsSync(${JSON.stringify(h.broken)}) ? 1 : 0);\n`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 30 })]);
  h.submit();
  // The wait pass that reworks also refills free worker slots; the hold keeps this task back.
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework', 'the environment failure reads as a code failure and reworks, and refill holds it');
  assert.equal(task.claim, null);
  assert.equal(h.logs().findLast((e) => e.cmd === 'rework').detail.gate, 'ci', 'the automatic rework names its gate');
  return h;
}

test('gates retry --from-rework restores an automatic gate rework at its submitted revision once the cause is fixed', (t) => {
  const h = brokenEnvironment(t);
  const submitted = h.logs().findLast((e) => e.cmd === 'rework').detail.previous_revision;
  const rework = h.logs().findLast((e) => e.cmd === 'rework');
  h.run(['wait', '--inbox', '--observe', '--after', 'now', '--timeout', '0.01', '--agent', 'orchestrator']); // wait-allow: populate the host follower cache before checking the restoration hint
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'rework_ready');
  assert.equal(item.restore, 'gates retry T1 --from-rework');
  assert.equal(item.hold_until, new Date(Date.parse(rework.at) + 5 * 60000).toISOString(), 'refill waits the default five minutes');
  assert.ok(!h.logs().some((e) => e.cmd === 'spawn' && e.detail.role === 'worker'), 'no worker round started');
  const runs = (type) => h.logs().filter((e) => e.cmd === `check ${type}`).length;
  const before = { tests: runs('tests'), clean: runs('clean'), ci: runs('ci') };
  fs.rmSync(h.broken);
  const restored = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
  assert.equal(restored.code, 0, `${restored.stdout}${restored.stderr}`);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.revision, submitted, 'the task is back at the revision it was submitted at');
  assert.deepEqual({ tests: runs('tests'), clean: runs('clean'), ci: runs('ci') }, { ...before, ci: before.ci + 1 },
    'only the failed gate runs again; tests and clean evidence at that revision still counts');
  const report = h.json(['task', 'show', 'T1', '--agent', 'orchestrator']);
  assert.deepEqual(report.gates.gates.filter((g) => g.type !== 'review').map((g) => [g.type, g.ok]), [['tests', true], ['clean', true], ['ci', true]]);
  const restore = h.logs().findLast((e) => e.cmd === 'restore');
  assert.deepEqual([restore.detail.from_revision, restore.detail.revision, restore.detail.gate], [submitted + 1, submitted, 'ci']);
  h.ok(['rework', 'T1', '--reason', 'owner wants more', '--agent', 'owner']);
  assert.equal(h.readState('tasks.json').tasks[0].revision, submitted + 2, 'the retired revision is never reused');
});

test('gates retry --from-rework sends a gate that still fails back to rework at a new revision, and refuses a claimed task', (t) => {
  const h = brokenEnvironment(t);
  const retired = h.readState('tasks.json').tasks[0].revision;
  const again = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
  assert.equal(again.code, 1, `${again.stdout}${again.stderr}`);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, retired + 1, 'the new rework skips the retired revision');
  assert.equal(h.logs().findLast((e) => e.cmd === 'rework').detail.gate, 'ci');
  h.consume();
  assert.ok(!h.logs().some((e) => e.cmd === 'spawn' && e.detail.role === 'worker'), 'refill holds the new gate rework too');
  // With the hold off, refill dispatches at once, and the restore leaves that round to the worker.
  h.ok(['project', 'set', '--rework-hold-min', '0']);
  h.consume();
  const worker = h.logs().findLast((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  assert.ok(worker, 'refill dispatches once the hold is off');
  const claimed = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
  assert.notEqual(claimed.code, 0);
  assert.match(claimed.stderr, new RegExp(`claimed by ${worker.detail.agent}|taken by`));
});

// A copy of the engine without the local CI gate module, so its CI rerun stops on missing
// engine code before it records a verdict, as a governor stop does.
function engineWithoutLocalCI(h) {
  const root = path.join(h.base, 'engine');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  fs.rmSync(path.join(root, 'lib', 'gates', 'local-ci.js'));
  const preload = path.join(h.base, 'engine-cli.js');
  fs.writeFileSync(preload, `const M = require('node:module'), resolve = M._resolveFilename;
M._resolveFilename = function(request, parent, main, options) {
  if (main) request = ${JSON.stringify(path.join(root, 'bin', 'tower-crane.js'))};
  return resolve.call(this, request, parent, main, options);
};`);
  return ['--require', preload];
}

test('a restore whose rerun stops before a verdict keeps the restored gates, and the next reaction reruns only the failed one', (t) => {
  const h = brokenEnvironment(t);
  const submitted = h.logs().findLast((e) => e.cmd === 'rework').detail.previous_revision;
  const runs = (type) => h.logs().filter((e) => e.cmd === `check ${type}`).length;
  const before = { tests: runs('tests'), clean: runs('clean'), ci: runs('ci') };
  const gates = () => h.json(['task', 'show', 'T1', '--agent', 'orchestrator']).gates.gates
    .filter((g) => g.type !== 'review').map((g) => [g.type, g.ok]);
  fs.rmSync(h.broken);
  const stopped = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator'], { pre: engineWithoutLocalCI(h) });
  assert.notEqual(stopped.code, 0, stopped.stdout);
  assert.match(stopped.stderr, /Cannot find module/);
  let task = h.readState('tasks.json').tasks[0];
  assert.deepEqual([task.status, task.revision], ['submitted', submitted], 'the restore holds');
  assert.deepEqual(gates(), [['tests', true], ['clean', true], ['ci', false]]);
  assert.deepEqual(h.logs().findLast((e) => e.cmd === 'restore').detail.rerun.map((r) => r.type), ['ci']);

  h.consume();
  task = h.readState('tasks.json').tasks[0];
  assert.deepEqual([task.status, task.revision], ['submitted', submitted], 'the failure the restore ruled out does not rework');
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1);
  assert.deepEqual({ tests: runs('tests'), clean: runs('clean'), ci: runs('ci') }, { ...before, ci: before.ci + 1 });
  assert.deepEqual(gates(), [['tests', true], ['clean', true], ['ci', true]]);
});

test('gates retry --from-rework refuses a moved head, a changed acceptance and a rework a person sent', (t) => {
  const h = brokenEnvironment(t);
  fs.rmSync(h.broken);
  const refused = (pattern) => {
    const r = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
    assert.notEqual(r.code, 0, r.stdout);
    assert.match(r.stderr, pattern);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  };
  const github = h.github();
  github.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(github);
  refused(/PR #7 head moved to fffffff/);
  h.run(['wait', '--inbox', '--observe', '--after', 'now', '--timeout', '0.01', '--agent', 'orchestrator']); // wait-allow: refresh the moved PR head before reading the cached inbox hint
  const hint = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'rework_ready');
  assert.equal(hint.restore, undefined, 'no restore command the restore would refuse');
  assert.match(hint.restore_blocked, /PR #7 head moved/);
  github.prs['7'].headRefOid = h.sha;
  h.saveGithub(github);
  // The fixture submits with a PR only, so the PR's head branch is the local branch that must not move.
  const branch = h.readState('tasks.json').tasks[0].branch || github.prs['7'].headRefName;
  h.git(['update-ref', `refs/heads/${branch}`, h.git(['rev-parse', `${h.sha}~1`])]);
  refused(new RegExp(`branch ${branch} moved to`));
  h.git(['update-ref', `refs/heads/${branch}`, h.sha]);
  h.ok(['task', 'update', 'T1', '--kind', 'docs', '--agent', 'owner']);
  refused(/kind was changed to docs after its rework/);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works everywhere']);
  refused(/revision \d+ to \d+ after its rework/);
  const other = setup(t);
  other.submit();
  other.ok(['rework', 'T1', '--reason', 'not what I asked', '--agent', 'owner']);
  const r = other.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /sent back by owner: not what I asked, not by an automatic gate failure/);
});
