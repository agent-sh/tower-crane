'use strict';

// gates.executors counts CPU work on this host only: a reaction waiting on
// GitHub checks or on a reviewer holds no executor and never waits for one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitFor } = require('./canary');
const { setup, holdSuite, holdExecutor, ghStub } = require('./automation-helpers');
const Automation = require('../lib/automation');

// Each executor lease once, at its start; a lease that moves from tests to clean records its new kind.
const leases = (h) => h.logs().filter((e, i, all) => e.cmd === 'executor' && e.detail.phase === 'running'
  && all.findIndex((x) => x.cmd === 'executor' && x.detail.lease === e.detail.lease) === i);

test('with one executor, a tests run holds it while CI waits and a review progress; the next CPU gate waits for the slot', async (t) => {
  const h = setup(t);
  const { stalled, release } = holdSuite(h);
  // T2 and T3 wait on CI, T4 on its reviewer, and T5's tests wait for the slot T1 holds.
  for (const id of ['T2', 'T3', 'T4', 'T5']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'] };
  github.prs['9'] = { ...github.prs['7'] };
  github.ci[h.sha] = 'pending';
  h.saveGithub(github);
  // Their suites pass at once while the stall marker exists.
  fs.writeFileSync(stalled, '');
  for (const [id, pr] of [['T2', '8'], ['T3', '9']]) h.submit(id, h.sha, pr);
  h.ok(['claim', 'T4', '--agent', 'worker']);
  h.ok(['submit', 'T4', '--sha', h.sha, '--agent', 'worker']);
  for (const id of ['T2', 'T3', 'T4']) for (const gate of ['tests', 'clean']) h.ok(['check', gate, id, '--agent', 'orchestrator']);
  fs.rmSync(stalled);
  const events = path.join(h.state, 'events.jsonl');
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const offset = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let status;
  try {
    await waitFor(stalled, { what: 'T1 takes the only executor' });
    h.ok(['claim', 'T5', '--agent', 'worker']);
    h.ok(['submit', 'T5', '--sha', h.sha, '--agent', 'worker']);
    h.consume();
    const tasks = () => Object.fromEntries(h.readState('tasks.json').tasks.map((task) => [task.id, task]));
    for (const id of ['T2', 'T3']) {
      assert.equal(tasks()[id].evidence.findLast((e) => e.type === 'ci')?.pending, true, `${id} read its pending CI`);
    }
    assert.equal(tasks().T5.evidence.some((e) => e.type === 'tests'), false, 'T5 runs no suite while T1 holds the slot');
    assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T5' && e.detail.executors === 1));
    status = h.ok(['status']);
    const json = h.json(['status']);
    assert.deepEqual(json.gate_executors, { cap: 1, in_use: [{ task: 'T1', kind: 'tests' }] });
    assert.deepEqual(json.waiting_on, { github: ['T2', 'T3'], review: ['T4'] });

    // The review verdict and the CI completions react at once.
    h.reviewer('T4', 'reviewer');
    h.ok(['evidence', 'T4', '--revision', h.revision('T4'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const green = h.github();
    green.ci[h.sha] = 'success';
    h.saveGithub(green);
    for (const id of ['T2', 'T3']) h.ok(['ci', 'completed', id, '--sha', h.sha, '--agent', 'orchestrator']);
    h.consume();
    assert.equal(tasks().T4.status, 'accepted', 'the review verdict is acted on while T1 holds the slot');
    for (const id of ['T2', 'T3']) assert.equal(tasks()[id].evidence.findLast((e) => e.type === 'ci')?.ok, true, `${id} CI passes`);
    assert.equal(fs.existsSync(release), false, 'T1 still holds the executor');
    assert.deepEqual(leases(h).map((e) => [e.task, e.detail.kind]), [['T1', 'tests']], 'only the tests run took an executor');
    assert.equal(tasks().T5.evidence.some((e) => e.type === 'tests'), false);
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await holder).code, 2, 'the holder finishes and drains the waiting suite');
  }
  assert.match(status, /^gate executors: 1 of 1 in use: T1 tests$/m);
  assert.match(status, /^gate queue: T5$/m);
  assert.match(status, /^waiting on GitHub checks: T2, T3$/m);
  assert.match(status, /^waiting on review: T4$/m);
  const after = h.json(['status']);
  assert.deepEqual(after.gate_executors, { cap: 1, in_use: [] });
  assert.deepEqual(after.waiting_on, { github: [], review: ['T1', 'T2', 'T3', 'T5'] }, 'each passes its software gates and waits for its reviewer');
  assert.deepEqual(leases(h).map((e) => e.task), ['T1', 'T5'], 'T5 takes the slot T1 freed');
  assert.deepEqual(h.readState('tasks.json').tasks.find((task) => task.id === 'T5').evidence.map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
});

test('a CI read holds no executor, so another task\'s suite runs while the read waits on GitHub', {
  skip: process.platform === 'win32' ? 'the held gh stub is a POSIX script' : false,
}, async (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--executors', '1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.submit();
  for (const gate of ['tests', 'clean']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
  const started = path.join(h.base, 'checks-read');
  const release = path.join(h.base, 'release-checks');
  const stub = path.join(h.base, 'held-gh.js');
  fs.writeFileSync(stub, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1].includes('check-runs')) {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  const poll = () => (fs.existsSync(${JSON.stringify(release)}) ? require(${JSON.stringify(ghStub)}) : setTimeout(poll, 25)); // wait-allow: probe cadence only; the release file is the signal
  poll();
} else require(${JSON.stringify(ghStub)});
`);
  fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(stub)});\n`);
  const reader = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  try {
    await waitFor(started, { what: 'T1 reads its checks' });
    const events = path.join(h.state, 'events.jsonl');
    h.ok(['claim', 'T2', '--agent', 'worker']);
    const offset = fs.statSync(events).size;
    h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    const t2 = h.readState('tasks.json').tasks[1];
    assert.deepEqual(t2.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], 'T2 ran its suite during the read');
    assert.equal(fs.existsSync(release), false, 'T1 is still reading its checks');
    assert.deepEqual(leases(h).map((e) => e.task), ['T2'], 'the CI read took no executor');
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await reader).code, 2);
  }
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci').ok, true);
  assert.equal(leases(h).some((e) => e.task === 'T1'), false);
});

test('rechecks of pending CI read GitHub at most once a minute per task; a completion reads at once', (t) => {
  const h = setup(t, { ci: 'pending' });
  delete h.env.HOOK_CI_POLL_MS;
  h.submit();
  for (const gate of ['tests', 'clean']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
  const reads = () => h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  const first = reads();
  assert.ok(first > 0, 'the first reaction reads the checks');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci').pending, true);
  // Each wait's startup reconcile is a recheck; the second inside the minute reads nothing.
  h.consume();
  assert.equal(reads(), first, 'the recheck inside the minute spends no read');
  const green = h.github();
  green.ci[h.sha] = 'success';
  h.saveGithub(green);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.ok(reads() > first, 'a completion notification reads at once');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci').ok, true);
});

test('a recheck scheduled a minute after the last read reads, however late that read was written', (t) => {
  const h = setup(t, { ci: 'pending' });
  delete h.env.HOOK_CI_POLL_MS;
  h.submit();
  for (const gate of ['tests', 'clean']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
  const reads = () => h.github().calls.filter((a) => a[0] === 'api' && a[1].includes('check-runs')).length;
  h.consume();
  const first = reads();
  assert.ok(first > 0, 'the first reaction reads the checks');
  // The last read was scheduled a minute ago and its reaction reached the ci
  // gate only now, as one held behind other reactions or a suite does.
  const file = path.join(h.state, 'events.jsonl');
  const events = h.logs();
  const poll = events.findLast((e) => e.cmd === 'ci poll');
  poll.detail.scheduled = new Date(Date.now() - 60000).toISOString();
  poll.at = new Date().toISOString();
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  h.consume();
  assert.ok(reads() > first, 'the next minute\'s recheck reads');
});

test('only gates that run commands on this host take an executor', () => {
  const st = (tests = {}, ci = {}) => ({ project: { tests, ci } });
  const code = { id: 'T1', kind: 'code' };
  const rows = [
    ['tests in prove mode', st(), code, 'tests', true],
    ['tests in mode none', st({ mode: 'none' }), code, 'tests', false],
    ['tests in mode none with host probes', st({ mode: 'none' }), { ...code, host_probes: ['node probe.js'] }, 'tests', true],
    ['tests in mode none with an empty probe list', st({ mode: 'none' }), { ...code, host_probes: [] }, 'tests', false],
    ['tests in a kind override of none with host probes', st({ by_kind: { code: 'none' } }), { ...code, host_probes: ['node probe.js'] }, 'tests', true],
    ['clean', st(), code, 'clean', true],
    ['local CI', st({}, { local: { command: 'node ci.js' } }), code, 'ci', true],
    ['local CI of a hotfix, which reads hosted CI', st({}, { local: { command: 'node ci.js' } }), { ...code, hotfix: {} }, 'ci', false],
    ['hosted CI', st(), code, 'ci', false],
    ['the final review', st(), code, 'final-review', false],
    ['sources', st(), code, 'sources', false],
  ];
  for (const [name, state, task, type, expected] of rows) assert.equal(Automation.cpuGate(state, task, type), expected, name);
});

test('a tests gate in mode none runs its host probes under the executor cap', async (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--executors', '1', '--tests-mode', 'none', '--agent', 'orchestrator']);
  const marker = path.join(h.base, 'probe-ran');
  const probe = path.join(h.base, 'probe.js');
  fs.writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');\n`);
  const free = holdExecutor(h);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker', '--host-probe', `node ${JSON.stringify(probe)}`]);
  h.consume();
  const tests = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests');
  assert.equal(fs.existsSync(marker), false, 'the probe waits while another task holds the only executor');
  assert.deepEqual(tests(), []);
  assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T1' && e.detail.executors === 1));
  free();
  h.consume();
  assert.equal(fs.existsSync(marker), true, 'the freed slot runs the probe');
  assert.equal(tests().at(-1).receipt.host_probes.length, 1);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'executor' && e.task === 'T1' && e.detail.phase === 'running')
    .map((e) => e.detail.kind), ['tests', 'clean'], 'the probes ran under the lease T1 took');
});
