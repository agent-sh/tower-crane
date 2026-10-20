'use strict';

// A worker owns its PR until the task is done: a failed gate or review at its
// head comes back to the same session, without a new spawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BIN } = require('./helpers');
const { waitUntil } = require('./signals');
const { shellQuote } = require('../lib/gates/common');
const { setup, configureHarness } = require('./automation-helpers');

const OWNER = path.join(__dirname, 'fixtures', 'pr-owner.js');

// One task whose first head fails its tests and whose second passes, run by
// the owner fixture as both its worker and its reviewer.
function ownerFixture(t, env = {}) {
  const h = setup(t, { ci: 'success' });
  configureHarness(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['commit', '-qam', 'fix the value']);
  h.fix = h.git(['rev-parse', 'HEAD']);
  const suite = path.join(h.base, 'tools', 'value-suite.js');
  fs.writeFileSync(suite, "if (require('node:fs').readFileSync('value.js', 'utf8').includes('1')) {\n  console.log('not ok 1 - the value is fixed');\n  process.exit(1);\n}\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(suite)}`, '--tests-mode', 'run-only', '--rework-hold-min', '0']);
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, OWNER, BIN, '{prompt}'])]);
  Object.assign(h.env, { OWNER_HEADS: JSON.stringify([h.sha, h.fix]), OWNER_LOG: path.join(h.base, 'owner.jsonl'), ...env });
  // The engine and the worker append while the test reads: only complete lines count.
  const lines = (file) => {
    let text = '';
    // read-published: appended only; the slice below drops a partial last line.
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
  };
  h.logs = () => lines(path.join(h.state, 'events.jsonl'));
  h.outcomes = () => lines(h.env.OWNER_LOG);
  h.task = () => h.readState('tasks.json').tasks[0];
  h.workers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  return h;
}

// The engine: a wait that runs every reaction and refills the worker slot,
// until the owner's worker exits; then it is stopped. A merge retires the
// task's worktree, and the supervisor stops the owner then if its wait --own
// has not ended it first.
async function runEngine(h) {
  const engine = h.spawnCli(['wait', '--types', 'never', '--timeout', '600', '--agent', 'orchestrator']);
  let output = '';
  for (const stream of [engine.stdout, engine.stderr]) stream.on('data', (d) => { output += d; });
  const closed = new Promise((resolve) => engine.on('close', resolve));
  try {
    await waitUntil(() => h.workers().length && h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === h.workers()[0].detail.agent),
      { paths: [h.base], alive: engine, what: () => `the owner exits; engine output: ${output}` });
  } finally {
    engine.kill('SIGINT');
    await closed;
  }
}

// A failed gate at the first head, each settled by rework as before: the
// tests gate on its suite, the ci gate on a check that fails after submit.
for (const row of [
  { gate: 'tests', reason: /^T1 came back to you at revision 2: tests failed at [0-9a-f]{7,}: /, evidence: /Failing tests:\n- the value is fixed/ },
  { gate: 'ci', reason: /^T1 came back to you at revision 2: ci failed at [0-9a-f]{7,}: /, evidence: /failing: test \(failure\)/ },
]) {
  test(`a failed ${row.gate} gate goes back to the worker that owns the PR, which fixes it in the same session until it merges`, async (t) => {
    const h = ownerFixture(t);
    if (row.gate === 'ci') {
      // Both heads pass their tests; the first head's CI fails once it is submitted.
      const suite = path.join(h.base, 'tools', 'value-suite.js');
      fs.writeFileSync(suite, 'setTimeout(() => {}, 1000);\n'); // wait-allow: a passing suite that takes a second, so the fixture fails CI before the ci gate reads it
      h.env.OWNER_CI_FAIL = h.sha;
    }
    await runEngine(h);
    const task = h.task();
    assert.equal(task.status, 'accepted');
    assert.equal(task.sha, h.fix);
    assert.ok(task.evidence.some((e) => e.type === 'merge' && e.ok), 'the fixed head merged');
    assert.equal(h.workers().length, 1, 'one worker spawn from submit to merge');
    const [fix, ...rest] = h.outcomes();
    assert.equal(fix.outcome, 'fix');
    assert.equal(fix.revision, 2);
    assert.match(fix.message, row.reason);
    assert.match(fix.message, row.evidence);
    // Once merged the owner is told to exit, unless the retired worktree's stop came first.
    assert.ok(rest.every((o) => o.outcome === 'wait' || o.outcome === 'exit' && o.reason === 'merged'), JSON.stringify(rest));
    const agent = h.workers()[0].detail.agent;
    const rework = h.logs().findIndex((e) => e.cmd === 'rework' && e.task === 'T1');
    const handback = h.logs().findIndex((e) => e.cmd === 'claim' && e.detail.handover);
    assert.equal(h.logs()[rework].detail.gate, row.gate);
    assert.ok(rework > 0 && handback > rework, 'the rework is recorded as for any rework, then handed back');
    assert.equal(h.logs()[handback].agent, agent);
    assert.equal(h.logs().filter((e) => e.cmd === 'submit').length, 2);
  });
}

test('a failed review reaches the owner with its findings, and the owner submits again', async (t) => {
  const h = ownerFixture(t, { OWNER_REVIEW_FAIL_ONCE: '' });
  h.env.OWNER_REVIEW_FAIL_ONCE = path.join(h.base, 'review-failed');
  h.env.OWNER_HEADS = JSON.stringify([h.fix]);
  await runEngine(h);
  assert.equal(h.task().status, 'accepted');
  assert.equal(h.workers().length, 1);
  const [fix] = h.outcomes();
  assert.equal(fix.outcome, 'fix');
  assert.match(fix.message, /review FAIL by reviewer-T1-\d+ at [0-9a-f]+:\nvalue\.js: the exported value must be 2, not 1/);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'rework').map((e) => e.detail.from_review), [true]);
});

test('a review that fails only on PR-body claims gets its body fixer while the owner waits, with no rework', async (t) => {
  const h = ownerFixture(t, { OWNER_REVIEW_BODY: '1' });
  h.env.OWNER_REVIEW_FAIL_ONCE = path.join(h.base, 'review-failed');
  h.env.OWNER_HEADS = JSON.stringify([h.fix]);
  const github = h.github();
  // The body fix checks the PR's head branch is the task's.
  Object.assign(github.prs['7'], { body: 'The body as submitted.', headRefName: 'tower-crane/T1-change' });
  h.saveGithub(github);
  await runEngine(h);
  assert.equal(h.task().status, 'accepted');
  assert.equal(h.task().revision, 1, 'a PR-body correction needs no rework');
  const spawns = h.workers();
  assert.deepEqual(spawns.map((e) => !!e.detail.body_fix), [false, true], 'the owner stays; a fresh fixer edits the body');
  assert.notEqual(spawns[1].detail.agent, spawns[0].detail.agent);
  assert.equal(h.github().prs['7'].body, 'The corrected body.');
  assert.equal(h.logs().filter((e) => e.cmd === 'rework' || e.cmd === 'claim' && e.detail.handover).length, 0);
});

test('an owner idle past its limit exits, and the next failure dispatches a new worker as before', async (t) => {
  const h = ownerFixture(t);
  // The first head's tests wait for the release, so the owner idles meanwhile.
  const release = path.join(h.base, 'release');
  const suite = path.join(h.base, 'tools', 'value-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
const end = Date.now() + 60000; // wait-allow: the test writes the release once the owner exited; the minute only ends a fixture whose test failed
const poll = () => (fs.existsSync(${JSON.stringify(release)}) || Date.now() >= end ? finish() : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release file and the minute bound it
const finish = () => {
  if (fs.readFileSync('value.js', 'utf8').includes('1')) {
    console.log('not ok 1 - the value is fixed');
    process.exit(1);
  }
};
poll();
`);
  h.ok(['project', 'set', '--owner-idle-minutes', '0.05']);
  const engine = h.spawnCli(['wait', '--types', 'never', '--timeout', '600', '--agent', 'orchestrator']);
  let output = '';
  for (const stream of [engine.stdout, engine.stderr]) stream.on('data', (d) => { output += d; });
  const closed = new Promise((resolve) => engine.on('close', resolve));
  const until = (check, what) => waitUntil(check, { paths: [h.base], alive: engine, what: () => `${what}; engine output: ${output}` });
  const exited = (n) => h.workers().length >= n && h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === h.workers()[n - 1].detail.agent);
  try {
    await until(() => exited(1), 'the idle owner exits');
    assert.deepEqual(h.outcomes().map((o) => [o.outcome, o.reason]), [['exit', 'idle']]);
    fs.writeFileSync(release, '');
    await until(() => exited(2), 'a new worker fixes the failure');
  } finally {
    engine.kill('SIGINT');
    await closed;
  }
  assert.equal(h.workers().length, 2, 'the failure after the idle exit dispatched a new worker');
  assert.equal(h.logs().filter((e) => e.cmd === 'claim' && e.detail.handover).length, 0, 'nothing went back to the exited owner');
  assert.equal(h.task().status, 'accepted');
  assert.equal(h.task().sha, h.fix);
});

// A worker spawn of the owner fixture without a PR, for checks that need no gates.
function ownerSpawn(h, id) {
  const started = h.json(['spawn', '--task', id]);
  return started.agent;
}

test('waiting owners hold no worker slot and have their own limit; a handback takes its claim past the worker limit; a crashed owner is a dead claim', async (t) => {
  const h = ownerFixture(t, { OWNER_NO_PR: '1', OWNER_CRASH_ON_FIX: '1' });
  h.ok(['project', 'set', '--workers', '1', '--owners', '1']);
  for (const id of ['T2', 'T3']) {
    h.ok(['task', 'add', '--title', id, '--acceptance', 'works', '--tier', 'easy']);
    h.ok(['brief', 'set', id, '-'], { input: `Implement ${id}.\n` });
  }
  const task = (id) => h.readState('tasks.json').tasks.find((x) => x.id === id);
  const until = (check, what) => waitUntil(check, { paths: [h.base], what });
  const first = ownerSpawn(h, 'T1');
  await until(() => h.outcomes().length === 0 && task('T1').status === 'submitted', 'T1 submitted');
  assert.equal(h.logs().findLast((e) => e.cmd === 'submit').detail.own, true);
  // The governor counts the waiting owner at its measured size.
  await until(() => h.json(['status']).governor.units.some((u) => u.agent === first && u.waiting), 'the owner unit is marked waiting');
  assert.equal(h.json(['status']).governor.budget.growth, 0, 'a waiting owner may grow no further');

  const second = ownerSpawn(h, 'T2');
  await until(() => h.outcomes().some((o) => o.agent === second), 'T2 submitted past the owner limit');
  const refused = h.outcomes().find((o) => o.agent === second);
  assert.deepEqual([refused.outcome, refused.reason], ['exit', 'owner limit reached (1 of 1 waiting: T1)']);
  assert.equal(h.logs().findLast((e) => e.cmd === 'submit' && e.task === 'T2').detail.own_refused, 'owner limit reached (1 of 1 waiting: T1)');

  h.ok(['claim', 'T3', '--agent', 'other']);
  assert.match(h.ok(['rework', 'T1', '--reason', 'value.js must be 2', '--agent', 'orchestrator']), /T1 sent back for rework; its owner worker-T1-\d+ fixes it/);
  assert.deepEqual([task('T1').status, task('T1').claim.agent], ['in_progress', first], 'the owner holds it though the worker slot is taken');
  assert.match(h.logs().findLast((e) => e.cmd === 'msg' && e.detail.to === first).detail.text, /^T1 came back to you at revision 2: value\.js must be 2\n/);
  await until(() => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === first), 'the owner crashes after the handback');
  assert.deepEqual(h.json(['status']).exited_claims.map((c) => [c.id, c.agent]), [['T1', first]], 'the crashed owner is a dead claim');
  h.ok(['release', '--dead', '--agent', 'orchestrator']);
  assert.deepEqual([task('T1').status, task('T1').claim], ['rework', null], 'the respawn path takes it over');
});

test('an interrupt stops a waiting owner and the next failure goes the respawn path', async (t) => {
  const h = ownerFixture(t, { OWNER_NO_PR: '1' });
  const task = () => h.task();
  const until = (check, what) => waitUntil(check, { paths: [h.base], what });
  const agent = ownerSpawn(h, 'T1');
  await until(() => task().status === 'submitted' && h.json(['status']).governor.units.some((u) => u.agent === agent && u.waiting), 'T1 owner waits');
  assert.match(h.ok(['interrupt', 'T1', '--agent', 'orchestrator']), new RegExp(`interrupted T1's owner ${agent}; T1 stays submitted`));
  await until(() => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent), 'the supervisor stops the owner');
  assert.equal(task().status, 'submitted');
  h.ok(['rework', 'T1', '--reason', 'value.js must be 2', '--agent', 'orchestrator']);
  assert.deepEqual([task().status, task().claim], ['rework', null]);
});

// A gate rework that gates retry --from-rework can still undo waits out
// gates.rework_hold_min unclaimed, as it does for a new worker, while its
// owner keeps waiting; a rework by hand cannot be restored and goes back at once.
for (const row of [
  {
    name: 'a gate rework restored during its hold leaves the owner waiting on the restored head',
    settle(h) {
      // The cause was outside the code: the suite passes now.
      fs.writeFileSync(path.join(h.base, 'tools', 'value-suite.js'), '');
      const restored = h.run(['gates', 'retry', 'T1', '--from-rework', '--agent', 'orchestrator']);
      assert.match(restored.stdout, /^T1: restored to submitted at revision 1; reran tests/, `${restored.stdout}${restored.stderr}`);
    },
    status: 'submitted', handed: false,
  },
  {
    name: 'a gate rework goes back to its waiting owner when the hold ends',
    settle(h) {
      h.ok(['project', 'set', '--rework-hold-min', '0']);
      h.consume();
    },
    status: 'in_progress', handed: true,
  },
  {
    name: 'an owner interrupted during the hold ends its ownership, and the task is the next worker\'s',
    async settle(h, agent) {
      h.ok(['interrupt', 'T1', '--agent', 'orchestrator']);
      await waitUntil(() => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent), { paths: [h.base], what: 'the supervisor stops the owner' });
      h.ok(['project', 'set', '--rework-hold-min', '0']);
      const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'rework_ready');
      assert.deepEqual([item.owner, item.action.argv], [undefined, ['spawn', '--ready']], 'a new worker takes it');
    },
    status: 'rework', handed: false,
  },
  { name: 'a rework by hand goes back to the owner at once though the hold is set', manual: true, status: 'in_progress', handed: true },
]) {
  test(row.name, async (t) => {
    const h = ownerFixture(t, { OWNER_NO_PR: '1', OWNER_CRASH_ON_FIX: '1' });
    h.ok(['project', 'set', '--rework-hold-min', '5']);
    const until = (check, what) => waitUntil(check, { paths: [h.base], what });
    const agent = ownerSpawn(h, 'T1');
    await until(() => h.task().status === 'submitted' && h.json(['status']).governor.units.some((u) => u.agent === agent && u.waiting), 'T1 owner waits');
    if (row.manual) h.ok(['rework', 'T1', '--reason', 'value.js must be 2', '--agent', 'orchestrator']);
    else {
      h.consume();
      const rework = h.logs().findLast((e) => e.cmd === 'rework');
      assert.deepEqual([rework.detail.gate, rework.detail.owner_held], ['tests', agent], 'the gate rework names the owner it is held for');
      assert.deepEqual([h.task().status, h.task().claim], ['rework', null], 'the hold keeps the task unclaimed');
      const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'rework_ready');
      assert.deepEqual([item?.restore, item?.owner, item?.action.argv], ['gates retry T1 --from-rework', agent, ['gates', 'retry', 'T1', '--from-rework']],
        'the restore stays possible during the hold');
      assert.ok(h.json(['status']).governor.units.some((u) => u.agent === agent && u.waiting), 'the owner waits through the hold');
      await row.settle(h, agent);
    }
    assert.equal(h.task().status, row.status);
    const handed = h.logs().filter((e) => e.cmd === 'claim' && e.detail.handover);
    assert.deepEqual(handed.map((e) => e.agent), row.handed ? [agent] : []);
    if (row.handed) {
      await until(() => h.outcomes().length, 'the owner reads the handback');
      assert.equal(h.outcomes()[0].outcome, 'fix');
      assert.match(h.outcomes()[0].message, row.manual ? /: value\.js must be 2\n/ : /: tests failed at [0-9a-f]{7,}: [\s\S]*the value is fixed/);
    } else if (!h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent)) {
      assert.deepEqual(h.outcomes(), [], 'the owner is still waiting');
      h.ok(['interrupt', 'T1', '--agent', 'orchestrator']);
    }
    await until(() => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent), 'the owner exits');
    assert.equal(h.workers().length, 1);
  });
}
