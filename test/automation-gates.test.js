'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HUNG_TEST_MS, waitOnRepo, waitUntil, fileWritten, killPid } = require('./signals');
const { cachedFixture, assertNoProcessesIn } = require('./helpers');
const { gateEvidence } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { readPublished } = require('./atomic-file');
const { setup, holdSuite, refillFixture, ghStub } = require('./automation-helpers');

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

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const spawns = () => h.logs().filter((e) => e.cmd === 'spawn').length;
  const recorded = spawns();
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(spawns(), recorded);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('wait stops post-merge conflict work on the first signal without reworking another task', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX signals' : false,
}, async (t) => {
  for (const [stage, forced] of [['view 8', false], ['view 8', true], ['view 9', false], ['trial', false], ['merge event', false]]) {
    await t.test(`${stage}${forced ? ' twice' : ''}`, async (t) => {
      const h = cachedFixture(null, 'wait-conflict-sweep', (repo) => {
        const h = setup(null, { repo, kind: 'docs' });
        h.submit();
        for (const [id, number, conflicting] of [['T2', '8', false], ['T3', '9', true]]) {
          const branch = `other-${id}`;
          h.git(['switch', '-qc', branch, 'main']);
          fs.writeFileSync(path.join(h.repo, conflicting ? 'value.js' : 'other.txt'),
            conflicting ? 'module.exports = 2;\n' : 'independent change\n');
          h.git(['add', '.']);
          h.git(['commit', '-qm', branch]);
          const sha = h.git(['rev-parse', 'HEAD']);
          h.ok(['task', 'add', '--title', id, '--acceptance', 'works', '--kind', 'docs']);
          const github = h.github();
          github.prs[number] = { ...github.prs['7'], headRefOid: sha, headRefName: branch };
          github.advanceBase = true;
          h.saveGithub(github);
          h.submit(id, sha, number);
        }
        h.reviewer('T1', 'reviewer');
        h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
        h.ok(['project', 'set', '--paused', 'manual conflict sweep']);
        return { sha: h.sha };
      });
      h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
      const cursor = JSON.parse(h.run(['wait', '--timeout', '0', '--agent', 'orchestrator']).stdout).offset;
      if (stage === 'merge event') {
        h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
        h.ok(['accept', 'T1', '--agent', 'orchestrator']);
        h.ok(['merge', 'T1', '--agent', 'orchestrator']);
      }
      const started = path.join(h.base, 'sweep-started');
      const release = path.join(h.base, 'release-sweep');
      const observed = path.join(h.base, 'signal-observed');
      const calls = path.join(h.base, 'gh-calls.jsonl');
      const wrapper = path.join(h.base, 'held-sweep-gh.js');
      const heldPr = stage === 'view 9' ? '9' : '8';
      fs.writeFileSync(wrapper, `const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (${stage !== 'trial'} && args[0] === 'pr' && args[1] === 'view' && args[2] === ${JSON.stringify(heldPr)}) {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  const poll = () => fs.existsSync(${JSON.stringify(release)}) ? require(${JSON.stringify(ghStub)}) : setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
  poll();
} else require(${JSON.stringify(ghStub)});
`);
      fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(wrapper)});\n`);
      const preload = path.join(h.base, 'sweep-observer.js');
      fs.writeFileSync(preload, `const fs = require('node:fs');
process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(observed)}, 'SIGTERM\\n'));
if (${stage === 'merge event'}) require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation'))}).backlog = () => [];
if (${stage === 'trial'}) {
  const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'gates', 'common'))}), git = C.git;
  C.git = async (...args) => {
    const result = await git(...args);
    // read-published: the gh stub appends calls; nothing replaces the file.
    const log = fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8') : '';
    if (args[2][0] === 'merge' && args[2].includes('--no-commit') && log.includes('["pr","view","9"')) {
      fs.writeFileSync(${JSON.stringify(started)}, '');
      await new Promise(resolve => {
        const poll = () => fs.existsSync(${JSON.stringify(release)}) ? resolve() : setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
        poll();
      });
    }
    return result;
  };
}
`);
      // Cleanup stops any worker this wait host dispatches, should the fixture ever unpause.
      const child = h.spawnCli(['wait', '--after', String(cursor), '--types', 'never', '--timeout', '300', '--agent', 'orchestrator'],
        { pre: ['--require', preload] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      const bound = setTimeout(() => child.kill('SIGKILL'), HUNG_TEST_MS);
      t.after(async () => {
        clearTimeout(bound);
        fs.writeFileSync(release, '');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await result;
        await h.cleanup();
        assertNoProcessesIn(t, h.base);
      });
      await waitFor(started, { what: 'the post-merge sweep starts' });
      assert.equal(h.github().prs['7'].state, 'MERGED');
      const before = h.readState('tasks.json').tasks.slice(1);
      child.kill('SIGTERM');
      await waitFor(observed, { what: 'wait observes the signal during the sweep' });
      const count = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
      if (forced) child.kill('SIGTERM');
      else fs.writeFileSync(release, '');
      const exit = await result;
      assert.equal(exit.code, 0, JSON.stringify(exit));
      assert.match(exit.stdout, /stopped by SIGTERM after draining 0 gates/);
      assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, count, 'no further PR inspection starts');
      assert.deepEqual(h.readState('tasks.json').tasks.slice(1), before, 'no conflict note, rework or generated repair changes another task');
      const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.findLast((e) => e.cmd === 'automation').detail.phase, 'deferred');
      assert.equal(events.some((e) => e.cmd === 'automation' && e.task !== 'T1' && e.detail.phase === 'running'), false, 'no repair executor is claimed');
      assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    });
  }
});

test('startup reconciles a newly conflicting PR after a merge happened without a waiter', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.consume();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'other submitted change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const state = h.github();
  state.prs['8'] = { ...state.prs['7'], headRefOid: other, headRefName: 'other-change' };
  h.saveGithub(state);
  h.submit('T2', other, '8');
  h.consume();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[1].status, 'submitted');
  const ci = h.logs().findLast((e) => e.cmd === 'check ci' && e.task === 'T2');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === ci.id && e.detail.phase === 'done'));

  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const changed = h.github();
  changed.advanceBase = true;
  h.saveGithub(changed);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const conflicting = h.github();
  conflicting.prs['8'].mergeable = 'CONFLICTING';
  conflicting.prs['8'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  const before = h.git(['rev-parse', 'HEAD']);
  // Keep worker refill out of this conflict-reconciliation probe.
  h.ok(['project', 'set', '--paused', 'manual startup conflict probe']);
  // The CLI helper bounds hangs without imposing a reconciliation deadline.
  const event = JSON.parse(h.ok(['wait', '--task', 'T2', '--types', 'rework', '--agent', 'orchestrator']));
  assert.equal(event.task, 'T2');
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'worker').length, 0);
  assert.match(task.notes.at(-1).text, /value\.js/);
  assert.equal(h.git(['rev-parse', 'HEAD']), before);
});

test('a matching UNKNOWN head runs submission gates during the same wait', async (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
  state.becomeMergeableAfterView = true;
  h.saveGithub(state);
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(result.code, 2, result.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)).map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
  assert.equal(task.status, 'submitted');
  assert.equal(h.github().prs['7'].mergeable, 'MERGEABLE');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const unknown = h.github();
  unknown.prs['7'].mergeable = unknown.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(unknown);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
    'UNKNOWN still blocks acceptance even with earlier passing CI and independent review');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci').pending, true,
    'UNKNOWN replaces a passing CI receipt with a pending receipt for the timer');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a submitted PR that GitHub reports UNKNOWN, then CONFLICTING, goes to rework before any suite runs', (t) => {
  const h = setup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'main moves value']);
  h.submit();
  // Submit reads the PR's mergeability before this test turns it UNKNOWN; count only the reaction's reads.
  const submitViews = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length;
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', unknownViews: 1 });
  h.saveGithub(github);
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.logs().filter((e) => ['check tests', 'check clean'].includes(e.cmd)).length, 0, 'no suite or clean runs');
  assert.equal(h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length - submitViews, 2, 'the UNKNOWN read is retried once');
});

test('startup retains gate evidence when main moves and the submitted head stays mergeable', (t) => {
  const h = setup(t);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0].evidence;
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  h.consume();
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.evidence, before);
  assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'pending' });
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub pending wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t);
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

// A slow stub suite records each run's start and end, so the log shows how
// many gate executors ran at once across every consumer process. With
// `release`, a run records its pid in its start file and waits for the release
// file; it also stops when its start file is gone or after SLOW_SUITE_MS, so a
// test that fails first cannot leave it polling. The start file goes with the
// fixture. A run does not watch the fixture directory itself: the run and its
// shell work in a gate worktree inside it, and Windows cannot remove a
// directory that is a live process's working directory. Teardown releases and
// stops every recorded run before the fixture is removed.
const SLOW_SUITE_MS = 240000;
function slowSuite(h, { executors, crash = false, release = null, hold = 1, pr = false, fail = false } = {}) {
  const runs = path.join(h.base, 'suite-runs.log');
  const suite = path.join(h.base, 'tools', 'slow-suite.js');
  if (release) h.teardown.push(() => stopSlowSuites(h, release));
  fs.writeFileSync(suite, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runs)}, '+\\n');
const crash = ${JSON.stringify(crash ? path.join(h.base, 'crashed') : null)};
if (crash && !fs.existsSync(crash)) {
  fs.writeFileSync(crash, '');
  const events = fs.readFileSync(${JSON.stringify(path.join(h.state, 'events.jsonl'))}, 'utf8').trim().split('\\n').map(JSON.parse);
  require(${JSON.stringify(path.join(__dirname, 'signals'))}).killPid(events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
}
const finish = () => { fs.appendFileSync(${JSON.stringify(runs)}, '-\\n'); process.exitCode = ${fail ? 1 : 0}; };
const release = ${JSON.stringify(release)};
if (release) {
  const starts = fs.readFileSync(${JSON.stringify(runs)}, 'utf8').split('\\n').filter((m) => m === '+').length;
  const started = ${JSON.stringify(path.join(h.base, 'suite-started-'))} + starts;
  fs.writeFileSync(started, String(process.pid));
  const until = Date.now() + ${SLOW_SUITE_MS}; // wait-allow: an orphaned suite stops itself; release and start-file removal are its signals
  const poll = () => {
    if (!fs.existsSync(started) || Date.now() > until) process.exit(1);
    if (starts < ${hold} || fs.existsSync(release)) finish();
    else setTimeout(poll, 50); // wait-allow: probe cadence only; the suite has no file watcher inside its fixture
  };
  poll();
} else {
  setTimeout(finish, 2500); // wait-allow: exercise overlapping gate completions with staggered commands
}
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    ...(executors ? ['--executors', String(executors)] : []), '--agent', 'orchestrator']);
  for (const id of ['T1', 'T2', 'T3']) {
    if (id !== 'T1') h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, ...(pr && id === 'T1' ? ['--pr', '7'] : []), '--agent', 'worker']);
  }
  return () => {
    let now = 0;
    let peak = 0;
    const marks = fs.existsSync(runs) ? readPublished(runs, 'utf8').trim().split('\n') : [];
    for (const mark of marks) peak = Math.max(peak, now += mark === '+' ? 1 : -1);
    return { starts: marks.filter((m) => m === '+').length, peak };
  };
}

test('wait drains on either signal without starting another gate, and a second signal stops the gate', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX signals' : false,
}, async (t) => {
  for (const [signal, forced, stage] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', true], ['SIGTERM', true, 'proof'], ['SIGTERM', true, 'sources'], ['SIGTERM', false, 'idle'], ['SIGINT', false, 'observe'], ['SIGTERM', false, 'follow'], ['SIGTERM', false, 'pr'], ['SIGTERM', true, 'ci'], ['SIGTERM', false, 'failure']]) {
    const proof = stage === 'proof';
    const sources = stage === 'sources';
    const idle = ['idle', 'observe', 'follow'].includes(stage);
    const json = signal === 'SIGINT' || stage === 'follow';
    const github = stage === 'pr' || stage === 'ci';
    await t.test(`${signal}${forced ? ' twice' : ''}${stage ? ` during ${stage}` : ''}`, async (t) => {
      const h = cachedFixture(null, `wait-drain-${sources ? 'research' : 'code'}`, (repo) => {
        const h = setup(null, { repo, kind: sources ? 'research' : 'code' });
        if (sources) {
          fs.mkdirSync(path.join(h.repo, 'research'));
          fs.writeFileSync(path.join(h.repo, 'research', 'T1.json'), JSON.stringify({
            sources: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, url: `https://source.example/${i}` })),
            claims: Array.from({ length: 10 }, (_, i) => ({ claim: `Claim ${i}`, quote: `Quote ${i}`, source: `s${i}` })),
          }));
          h.git(['add', 'research']);
          h.git(['commit', '-qm', 'research sources']);
          h.sha = h.git(['rev-parse', 'HEAD']);
          const github = h.github();
          github.prs['7'].headRefOid = h.sha;
          github.ci[h.sha] = 'pending';
          h.saveGithub(github);
        }
        return { sha: h.sha };
      });
      h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const release = path.join(h.base, 'release-suite');
      const heldRun = proof ? 2 : 1;
      const runs = idle ? null : slowSuite(h, { executors: 1, release, hold: heldRun, pr: github, fail: stage === 'failure' });
      if (proof) h.ok(['project', 'set', '--tests-mode', 'prove', '--agent', 'orchestrator']);
      if (github) {
        if (stage === 'ci') {
          fs.writeFileSync(release, '');
          h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
          h.ok(['check', 'clean', 'T1', '--agent', 'orchestrator']);
          fs.unlinkSync(release);
        }
        const stub = path.join(h.base, 'held-gh.js');
        fs.writeFileSync(stub, `const fs = require('node:fs');
const args = process.argv.slice(2);
const held = ${JSON.stringify(stage)} === 'pr'
  ? args[0] === 'pr' && args[1] === 'view'
  : args[0] === 'api' && args[1].includes('check-runs');
if (held) {
  // Teardown signals this pid, so it must never read the file empty.
  require(${JSON.stringify(path.join(__dirname, 'atomic-file'))}).writeAtomic(${JSON.stringify(path.join(h.base, 'github-started'))}, String(process.pid));
  const poll = () => {
    if (fs.existsSync(${JSON.stringify(release)})) require(${JSON.stringify(ghStub)});
    else setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
  };
  poll();
} else require(${JSON.stringify(ghStub)});
`);
        fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(stub)});\n`);
      }
      const observed = path.join(h.base, 'signal-observed');
      const preload = path.join(h.base, 'signal-observer.js');
      // A receipt synchronizes the test with signal delivery before it releases the gate.
      fs.writeFileSync(preload, `const fs = require('node:fs');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => fs.appendFileSync(${JSON.stringify(observed)}, signal + '\\n'));
`);
      if (idle) {
        fs.appendFileSync(preload, `
const watch = fs.watch;
fs.watch = (...args) => {
  const watcher = watch(...args);
  fs.writeFileSync(${JSON.stringify(path.join(h.base, 'suite-started-1'))}, '');
  return watcher;
};
`);
      }
      if (sources) {
        fs.appendFileSync(preload, `
require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'public-http'))}).fetchPublic = (url, opts) => new Promise((resolve, reject) => {
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'suite-runs.log'))}, '+\\n');
  fs.writeFileSync(${JSON.stringify(path.join(h.base, 'suite-started-1'))}, String(process.pid));
  const pending = setInterval(() => {}, 1000);
  opts.signal.addEventListener('abort', () => {
    fs.writeFileSync(${JSON.stringify(path.join(h.base, 'fetch-aborted'))}, opts.signal.reason.name);
    clearInterval(pending);
    reject(opts.signal.reason);
  }, { once: true });
});
`);
      }
      // An idle wait host refills worker slots, and cleanup stops the worker it dispatches.
      const child = h.spawnCli(['wait', '--after', '0', '--types', 'never',
        ...(stage === 'follow' ? ['--follow'] : ['--timeout', '300']),
        ...(stage === 'observe' ? ['--observe'] : []), ...(json && stage !== 'follow' ? ['--json'] : []), '--agent', 'orchestrator'],
      { pre: ['--require', preload] });
      const started = path.join(h.base, github ? 'github-started' : `suite-started-${heldRun}`);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stderr }));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), HUNG_TEST_MS);
      t.after(async () => {
        clearTimeout(timer);
        fs.writeFileSync(release, '');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await result;
        if (github && fs.existsSync(started)) {
          try { killPid(Number(readPublished(started, 'utf8')), 'SIGKILL'); }
          catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
        await h.cleanup();
        assertNoProcessesIn(t, h.base);
      });
      await waitFor(started, { what: idle ? 'wait is ready' : 'the gate starts' });
      child.kill(signal);
      if (github) {
        await waitFor(observed, { what: 'the held GitHub command does not block signal delivery' });
      }
      await waitFor(observed, { what: 'the wait process receives the signal' });
      if (!idle) assert.equal(child.exitCode, null, 'the running gate still holds wait open');
      if (forced) {
        child.kill(github ? 'SIGINT' : signal);
      } else {
        fs.writeFileSync(release, '');
      }
      const exit = await result;
      assert.equal(exit.code, 0, JSON.stringify(exit));
      if (!idle) {
        assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1,
          'shutdown removes the gate worktree registration before releasing the executor');
        assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
          'shutdown leaves the interrupted reaction available for gate retry');
      }
      const drained = forced || idle || stage === 'pr' ? 0 : 1;
      if (json) {
        const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
        if (stage === 'follow') assert.equal(lines[0].type, 'ready', 'the follower retains its ready record');
        assert.equal(lines.length, stage === 'follow' ? 2 : 1, 'only the stop notice follows readiness');
        assert.deepEqual(lines.at(-1), { reason: 'signal', signal, drained }, 'the stop notice distinguishes a signal from a wake or timeout');
      } else {
        assert.equal(stdout.trim(), `stopped by ${signal} after draining ${drained} gate${drained === 1 ? '' : 's'}`);
      }
      const receipts = h.logs().filter((e) => e.cmd === 'automation');
      if (github) {
        const task = h.readState('tasks.json').tasks[0];
        if (stage === 'pr') {
          assert.deepEqual(task.evidence, [], 'no gate starts after signal delivery during PR inspection');
        } else {
          assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
          const pid = Number(fs.readFileSync(started, 'utf8'));
          assert.equal(require('../lib/processes').processState({ pid }), 'exited', 'the second signal stops the GitHub query');
          assert.equal(fs.existsSync(release), false, 'the query stops without its release file');
          assert.equal(task.evidence.at(-1).confirmed_failure, undefined);
        }
        assert.equal(receipts.at(-1).detail.phase, 'deferred', 'the GitHub reaction releases its lease');
        assert.ok(h.readState('tasks.json').tasks.slice(1).every((t) => !t.evidence.length), 'queued gates stay pending');
        return;
      }
      if (idle) {
        assert.deepEqual(receipts, [], 'idle shutdown claims no automation work');
        return;
      }
      assert.deepEqual(runs(), { starts: heldRun, peak: 1 }, 'no queued gate starts during shutdown');
      assert.deepEqual(receipts.filter((e) => e.detail.phase === 'running').map((e) => e.task), ['T1']);
      assert.equal(receipts.at(-1).detail.phase, 'deferred', 'the executor lease is released for a retry');
      const tasks = h.readState('tasks.json').tasks;
      assert.deepEqual(tasks[0].evidence.map((e) => [e.type, e.ok]), [[sources ? 'sources' : 'tests', !forced && stage !== 'failure']],
        'the active gate is recorded, and the next gate is left for a retry');
      assert.ok(tasks.slice(1).every((task) => !task.evidence.length), 'other tasks keep their pending gates');
      if (forced) {
        assert.equal(fs.existsSync(release), false, 'the second signal finishes without releasing the gate');
        if (sources) assert.equal(fs.readFileSync(path.join(h.base, 'fetch-aborted'), 'utf8'), 'AbortError', 'the signal cancels the fetch before its timeout');
        const gatePid = Number(fs.readFileSync(path.join(h.base, `suite-started-${heldRun}`), 'utf8'));
        assert.equal(require('../lib/processes').processState({ pid: gatePid }), 'exited', 'the gate process was stopped');
        if (!sources) assert.ok(tasks[0].evidence[0].commands.some((c) => c.signal === 'SIGKILL'), 'the command tree was killed');
        assert.equal(tasks[0].evidence[0].confirmed_failure, undefined, 'interruption is not a confirmed test failure');
      }
    });
  }
});
function slowSuiteStarts(h) {
  return fs.readdirSync(h.base).filter((f) => f.startsWith('suite-started-')).map((f) => path.join(h.base, f));
}

function slowSuitePids(h) {
  return slowSuiteStarts(h).map((f) => Number(fs.readFileSync(f, 'utf8'))).filter((pid) => pid > 0);
}

function slowSuiteRunning(pid) {
  if (process.platform === 'linux') {
    try { return !/^\S+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
  }
  try { killPid(pid, 0); return true; } catch { return false; }
}

async function stopSlowSuites(h, release) {
  if (!fs.existsSync(h.base)) return;
  const pids = slowSuitePids(h);
  fs.writeFileSync(release, '');
  // Teardown only: released suites get a grace before survivors are killed.
  const until = Date.now() + 5000; // wait-allow: teardown grace before killing released suites
  while (pids.some(slowSuiteRunning) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50)); // wait-allow: teardown grace before killing released suites
  for (const pid of pids.filter(slowSuiteRunning)) {
    try { killPid(pid, 'SIGKILL'); } catch { /* It exited meanwhile. */ }
  }
}

test('gate executors across several watchers stay within gates.executors and queue the rest in order', async (t) => {
  const h = setup(t);
  const release = path.join(h.base, 'release-suite');
  const runs = slowSuite(h, { release });
  assert.match(h.ok(['project', 'show']), /gates\.executors: 2/);
  // Keep consumers alive until the last task's gate evidence, including contended startup.
  const watchers = [0, 1, 2].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'evidence', '--task', 'T3',
      '--timeout', '300', '--agent', 'orchestrator']));
  let results;
  try {
    assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-2')), null, 'two executors start');
    // Keep both slots occupied until a watcher has queued the third submission.
    const notification = await h.runAsync(['wait', '--observe', '--after', '0', '--types', 'automation queued',
      '--task', 'T3', '--timeout', '300', '--agent', 'orchestrator']);
    assert.equal(notification.code, 0, JSON.stringify(notification));
    const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.detail.executors === 2);
    assert.ok(queued.some((e) => e.task === 'T3'), JSON.stringify(queued));
    fs.writeFileSync(release, '');
    assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-3')), null, 'the third executor starts');
  } finally {
    fs.writeFileSync(release, '');
    results = await Promise.all(watchers);
  }
  assert.ok(results.every((r) => r.code === 0 && JSON.parse(r.stdout).type === 'evidence'), JSON.stringify(results));
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
  // A successful manual observation schedules a later reaction without another tests run.
  const beforeFollowUp = h.logs().length;
  h.ok(['check', 'clean', 'T2']);
  h.consume();
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.ok(h.logs().slice(beforeFollowUp).some((e) => e.cmd === 'automation'
    && e.detail.phase === 'running' && e.task === 'T2'), 'a later observation runs without restarting its suite');
  const firstStarts = [...new Set(started)];
  assert.deepEqual(new Set(firstStarts), new Set(['T1', 'T2', 'T3']));
  assert.equal(firstStarts.at(-1), 'T3', 'the queued submission runs after a slot frees');
});

// The orphans this guards against: a test killed with its runner's process
// group before it released its suites, so its teardown never ran, and the
// fixture then removed with the tests gate's temporary directory.
test('slow suites stop when their fixture is removed before they are released', async (t) => {
  const h = setup(t);
  const release = path.join(h.base, 'release-suite');
  slowSuite(h, { release });
  const watchers = [0, 1].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'evidence', '--task', 'T3',
      '--timeout', '300', '--agent', 'orchestrator']));
  let pids = [];
  // A failed wait below must not leave the suites polling after the test.
  t.after(() => { for (const pid of pids.filter(slowSuiteRunning)) killPid(pid, 'SIGKILL'); });
  await waitUntil(() => (pids = slowSuitePids(h)).length >= 2, { what: 'two executors start' });
  assert.equal(pids.length, 2, 'two executors start');
  for (const e of h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running')) {
    try { killPid(e.detail.pid, 'SIGKILL'); } catch { /* It exited already. */ }
  }
  await Promise.all(watchers);
  // Windows cannot remove the fixture while the suites and their shells work
  // in it, so there the removal takes what it can first: the start files.
  if (process.platform === 'win32') for (const file of slowSuiteStarts(h)) fs.rmSync(file);
  else fs.rmSync(h.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await waitUntil(() => !pids.some(slowSuiteRunning), {
    what: () => `a slow suite outlived its fixture: ${pids.filter(slowSuiteRunning).join(', ')}`,
  });
});

test('a killed executor releases its gate executor slot', (t) => {
  const h = setup(t);
  const runs = slowSuite(h, { executors: 1, crash: true });
  assert.notEqual(h.consume().code, 2, 'the suite kills the first executor');
  h.consume();
  assert.equal(runs().starts, 4, 'the killed run is retried and the other two run');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => e.type), ['tests', 'clean'], task.id);
  }
});

test('older queued work takes a freed executor slot before a newer arrival', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const suite = path.join(h.base, 'tools', 'stall-suite.js');
  // The first run holds the only slot until T2 is queued behind it, then
  // dies, leaving a free slot and T2 still waiting.
  fs.writeFileSync(suite, `const fs = require('node:fs');
const flag = ${JSON.stringify(path.join(h.base, 'stalled'))};
if (fs.existsSync(flag)) process.exit(0);
fs.writeFileSync(flag, '');
const read = () => fs.readFileSync(${JSON.stringify(events)}, 'utf8').trim().split('\\n').map(JSON.parse);
const until = Date.now() + 300000;
const poll = () => {
  const log = read();
  if (log.some((e) => e.cmd === 'automation queued' && e.task === 'T2') || Date.now() > until) {
    require(${JSON.stringify(path.join(__dirname, 'signals'))}).killPid(log.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
    process.exit(1);
  }
  setTimeout(poll, 50); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['task', 'add', '--title', 'Change T3', '--acceptance', 'it works', '--kind', 'code']);
  for (const id of ['T1', 'T2']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(path.join(h.base, 'stalled'), { what: 'the first executor starts' });
  h.consume();
  assert.notEqual((await holder).code, 2, 'the stalled executor is killed');
  assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T2' && e.detail.executors === 1));
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T1', 'T2', 'T3'], 'queued T1 and T2 run before the newer T3');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

test('accepted merges take the next executor in acceptance order before queued submitted gates', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  fs.writeFileSync(stalled, '');
  for (const id of ['T2', 'T3', 'T4', 'T5']) {
    h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  }
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'] };
  h.saveGithub(github);
  // Submit T4 first, but accept T5 first. Both already passed their gates.
  for (const id of ['T4', 'T5']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, id, '--agent', 'orchestrator']);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--sha', h.sha, '--revision', h.revision(id), '--ok', '--agent', 'reviewer']);
  }
  // An independent base change requires each merge to test the merged tree.
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  fs.rmSync(stalled);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const offset = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  // Start only T1's reaction, leaving the prepared PRs for explicit acceptance.
  const holder = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let text, queue;
  try {
    await waitFor(stalled, { what: 'T1 holds the only executor' });
    const after = fs.statSync(events).size;
    for (const id of ['T2', 'T3']) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
    }
    // Attach the PRs after T1 starts, so startup reconciliation cannot advance them first.
    for (const [id, pr] of [['T4', '7'], ['T5', '8']]) {
      h.ok(['submit', id, '--sha', h.sha, '--pr', pr, '--agent', 'worker']);
    }
    h.run(['wait', '--after', String(after), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    // A request made while T4 is submitted gives way to its acceptance.
    h.ok(['gates', 'prioritize', 'T4', '--reason', 'request before acceptance', '--agent', 'orchestrator']);
    const accepted = fs.statSync(events).size;
    for (const id of ['T5', 'T4']) h.ok(['accept', id, '--agent', 'orchestrator']);
    h.run(['wait', '--after', String(accepted), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    const late = h.run(['gates', 'prioritize', 'T4', '--reason', 'later merge request', '--agent', 'orchestrator']);
    assert.notEqual(late.code, 0);
    assert.match(late.stderr, /T4 is accepted; its merge already runs ahead of submitted gate work, in acceptance order/);
    h.ok(['gates', 'prioritize', 'T3', '--reason', 'submitted gate request', '--agent', 'orchestrator']);
    text = h.ok(['status']);
    queue = h.json(['status']).gate_queue;
    assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).gate_queue, queue);
    assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task),
      ['T1'], 'acceptance does not preempt the running gate');
    assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  }
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T5, T4, T3 \(prioritized: submitted gate request\), T2$/m);
  assert.deepEqual(queue.queued.map((q) => q.id), ['T5', 'T4', 'T3', 'T2']);
  const log = h.logs();
  assert.deepEqual(log.filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task),
    ['T1', 'T5', 'T4', 'T3', 'T2']);
  assert.deepEqual(log.filter((e) => e.cmd === 'head check').map((e) => [e.task, e.detail.ok]),
    [['T5', true], ['T4', true]], 'merged-tree tests keep merge priority');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7']);
  const gates = log.findIndex((e) => e.cmd === 'automation' && e.task === 'T3' && e.detail.phase === 'running');
  assert.ok(log.findLastIndex((e) => e.cmd === 'merge' && e.detail.ok) < gates,
    'both merges finish before a queued submitted gate starts');
});

test('gates prioritize runs the last queued task first; status and inbox show the gate queue', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // The three tasks submitted after the held run queue behind it.
  const { stalled, release } = holdSuite(h);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3', 'T4']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3', 'T4']);

  const refused = h.run(['gates', 'prioritize', 'T4', '--reason', 'gate fix first', '--agent', 'worker']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /operational/);
  // T1 holds the executor, so it has no queued work to move.
  const idle = h.run(['gates', 'prioritize', 'T1', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(idle.code, 0);
  assert.match(idle.stderr, /no queued gate work/);
  assert.ok(!h.logs().some((e) => e.cmd === 'gates prioritize'), 'refused requests log nothing');

  h.ok(['gates', 'prioritize', 'T4', '--reason', 'T134 shrinks every later gate run', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T4', 'T134 shrinks every later gate run']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.running, ['T1']);
  assert.deepEqual(queue.queued.map((q) => q.id), ['T4', 'T2', 'T3']);
  assert.equal(queue.queued[0].prioritized.reason, 'T134 shrinks every later gate run');
  assert.equal(queue.queued[1].prioritized, null);
  assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).gate_queue, queue, 'inbox carries the same queue');
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);

  fs.writeFileSync(release, '');
  // A zero-timeout wait with no matching type exits 2 once its drain is done.
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T4', 'T2', 'T3'], 'the prioritized T4 runs before T2 and T3, which keep their order');
  const changes = h.logs().filter(e => e.cmd === 'setting' && e.detail.settings['gates.priority']);
  assert.deepEqual(changes.map(e => e.detail), [{
    command: 'gates prioritize', actor: 'orchestrator', mode: 'cli',
    settings: { 'gates.priority': 'operational' },
  }], 'only the successful priority change writes a setting audit');
});

// Each gate run stalls until the test writes its `release-N` file, so the test
// can read status while run N is in progress.
function stepSuite(h, { executors = 1 } = {}) {
  const suite = path.join(h.base, 'tools', 'step-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
const path = require('node:path');
const base = ${JSON.stringify(h.base)};
const counter = path.join(base, 'runs');
// read-published: one suite run at a time writes the counter in place; nothing replaces it.
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
fs.writeFileSync(path.join(base, 'stalled-' + n), '');
const release = path.join(base, 'release-' + n);
const poll = () => (fs.existsSync(release) ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', String(executors), '--agent', 'orchestrator']);
  return (n) => ({ stalled: path.join(h.base, `stalled-${n}`), release: path.join(h.base, `release-${n}`) });
}

test('a request moves only the reactions queued when it was made', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3']);

  // T3's review is recorded, but no watcher has queued it when the request is made.
  h.reviewer('T3', 'reviewer', h.sha);
  const before = fs.statSync(events).size;
  h.ok(['evidence', 'T3', '--type', 'review', '--sha', h.sha, '--revision', h.revision('T3'), '--ok', '--agent', 'reviewer']);
  h.ok(['gates', 'prioritize', 'T3', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(before), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3', 'T3'],
    'the review queues after the request');

  fs.writeFileSync(release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T3', 'T2', 'T3'],
    'the submission queued at the request runs first; the review queued after it keeps its place behind T2');
});

test('a reaction that is running is not queued: status and prioritize leave it out', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const run = stepSuite(h);
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(1).stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);

  fs.writeFileSync(run(1).release, '');
  await waitFor(run(2).stalled, { what: 'T2 takes the executor next' });
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T2$/m);
  assert.match(text, /^gate queue: T3$/m, 'T2 is running, so only T3 waits');
  const refused = h.run(['gates', 'prioritize', 'T2', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no queued gate work/);

  fs.writeFileSync(run(2).release, '');
  await waitFor(run(3).stalled, { what: 'T3 runs last' });
  fs.writeFileSync(run(3).release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T2', 'T3'], 'each task runs once, in submission order');
});

test('a follow-up queued behind a live reaction can be prioritized and runs first', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  // T1 has a live reaction, so T2 and then T1's CI completion queue behind it.
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate queue: T2; blocked behind their running reactions: T1$/m, 'the follow-up waits behind the running reaction');

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T1', 'CI follow-up first']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T2; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.queued.map((q) => q.id), ['T2']);
  assert.deepEqual(queue.blocked.map((q) => q.id), ['T1']);

  fs.writeFileSync(release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T1', 'T2'], 'the prioritized follow-up runs before T2');
});

test('status shows a blocked follow-up apart from the queue the next free executor takes', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // Two executors hold T1 and T2, so T3 and T1's CI follow-up queue. T1's
  // follow-up waits for T1's own reaction, so T3 is the next work taken.
  const run = stepSuite(h, { executors: 2 });
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const first = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(1).stalled, { what: 'T1 takes the first executor' });
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  const second = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(2).stalled, { what: 'T2 takes the second executor' });

  const queued = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(queued), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate running: T1, T2$/m);
  assert.match(h.ok(['status']), /^gate queue: T3; blocked behind their running reactions: T1$/m);

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T3; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual([queue.running, queue.queued.map((q) => q.id), queue.blocked.map((q) => q.id)], [['T1', 'T2'], ['T3'], ['T1']]);

  fs.writeFileSync(run(2).release, '');
  await waitFor(run(3).stalled, { what: 'T3 takes the freed executor before the blocked follow-up' });
  const started = () => h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started(), ['T1', 'T2', 'T3'], 'the blocked follow-up has not started');
  assert.match(h.ok(['status']), /^gate queue: none; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);

  fs.writeFileSync(run(1).release, '');
  fs.writeFileSync(run(3).release, '');
  assert.equal((await first).code, 2, 'the first executor drains its follow-up');
  assert.equal((await second).code, 2, 'the second executor finishes');
  assert.deepEqual(started(), ['T1', 'T2', 'T3', 'T1'], 'the prioritized follow-up runs after its own reaction and T3');
});

for (const reason of ['unknown mergeability', 'transport error']) {
  test(`startup retries ${reason} without a new lifecycle event`, (t) => {
    const h = setup(t, { kind: 'docs' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const state = h.github();
    if (reason === 'transport error') state.failView = true;
    else state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
    h.saveGithub(state);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase,
      reason === 'transport error' ? 'error' : 'deferred');
    const recovered = h.github();
    recovered.failView = false;
    recovered.prs['7'].mergeable = 'MERGEABLE';
    recovered.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(recovered);
    h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'merge');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('startup confirms the accepted head after the executor dies between remote merge and receipt', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const crash = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { AUTOMATION_CRASH_AFTER_MERGE: '1' } });
  assert.notEqual(crash.code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'), false);
  assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase, 'running');
  h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, h.sha);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1, 'confirmation does not repeat the remote merge');
});

test('a remotely merged different head produces failed merge evidence', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const state = h.github();
  state.prs['7'].state = 'MERGED';
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, false);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});
