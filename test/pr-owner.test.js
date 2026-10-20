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
  h.outcomes = () => (fs.existsSync(h.env.OWNER_LOG) ? fs.readFileSync(h.env.OWNER_LOG, 'utf8').trim().split('\n').map(JSON.parse) : []);
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
    await waitUntil(() => h.workers().some((w) => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === w.detail.agent)),
      { paths: [h.base], alive: engine, what: () => `the owner exits; engine output: ${output}` });
  } finally {
    engine.kill('SIGINT');
    await closed;
  }
}

test('a failed tests gate goes back to the worker that owns the PR, which fixes it in the same session until it merges', async (t) => {
  const h = ownerFixture(t);
  await runEngine(h);
  const task = h.task();
  assert.equal(task.status, 'accepted');
  assert.equal(task.sha, h.fix);
  assert.ok(task.evidence.some((e) => e.type === 'merge' && e.ok), 'the fixed head merged');
  assert.equal(h.workers().length, 1, 'one worker spawn from submit to merge');
  const [fix, ...rest] = h.outcomes();
  assert.equal(fix.outcome, 'fix');
  assert.equal(fix.revision, 2);
  assert.match(fix.message, /^T1 came back to you at revision 2: tests failed at [0-9a-f]{7,}: /);
  assert.match(fix.message, /Failing tests:\n- the value is fixed/);
  // Once merged the owner is told to exit, unless the retired worktree's stop came first.
  assert.ok(rest.every((o) => o.outcome === 'wait' || o.outcome === 'exit' && o.reason === 'merged'), JSON.stringify(rest));
  const agent = h.workers()[0].detail.agent;
  const rework = h.logs().findIndex((e) => e.cmd === 'rework' && e.task === 'T1');
  const handback = h.logs().findIndex((e) => e.cmd === 'claim' && e.detail.handover);
  assert.ok(rework > 0 && handback > rework, 'the rework is recorded as for any rework, then handed back');
  assert.equal(h.logs()[handback].agent, agent);
  assert.equal(h.logs().filter((e) => e.cmd === 'submit').length, 2);
});

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
