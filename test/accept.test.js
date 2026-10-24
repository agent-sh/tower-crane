'use strict';

const { waitOnRepo } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture, BIN, ROOT } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const Actions = require('../lib/actions');
const Reviewer = require('../lib/reviewer');

// A submitted task, built once per process for each submit shape and kind.
function submitted(t, extra = [], kind = 'code') {
  return cachedFixture(t, JSON.stringify([extra, kind]), (h) => {
    h.init();
    h.sha = gateFixture(h);
    h.ok(['project', 'set', '--repo', 'acme/demo']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
    h.ok(['claim', 'T1', '--agent', 'w-1']);
    h.ok(['submit', 'T1', '--sha', h.sha.slice(0, 10), '--agent', 'w-1', ...extra]);
    return { sha: h.sha };
  });
}

const ev = (h, type, agent, ok = true) => ['tests', 'clean', 'ci'].includes(type)
  ? gateEvidence(h, type, agent, ok)
  : (type === 'review' && agent !== 'w-1' && h.reviewer('T1', agent),
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', type, ok ? '--ok' : '--fail', '--sha', h.sha, '--agent', agent]));

// A reviewer that exits without recording anything, so a test sees whether
// accept dispatched one without a real harness running.
function silentReviewer(h) {
  const command = JSON.stringify([process.execPath, '-e', '0', '{prompt}']);
  for (const name of ['easy', 'medium', 'hard', 'research', 'review']) {
    h.ok(['ladder', 'set', name, '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--command', command]);
  }
}

// A detached monitor may be mid-append; its line is whole on the next read.
const events = (h) => {
  const text = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).trim().split('\n').map(JSON.parse);
};
const reviewerSpawns = (h) => events(h).filter((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.role === 'reviewer');

// The dispatched reviewer runs detached; the test must outlive it and its monitor.
async function reviewerExited(h) {
  const agents = reviewerSpawns(h).map((e) => e.detail.agent);
  await waitOnRepo(h, () => agents.every((a) => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === a)));
  // The exit receipt precedes automation, which must not consume the next verdict.
  await waitOnRepo(h, () => {
    const log = events(h);
    return agents.every((a) => {
      const exit = log.findLast((e) => e.cmd === 'spawn exit' && e.detail.agent === a);
      return log.some((e) => e.cmd === 'automation' && e.detail.source === exit.id && e.detail.phase === 'done');
    });
  });
}

// After a reviewer exits its monitor advances the task too, so either accept may win.
function acceptAfterReview(h, ...args) {
  const r = h.run(['accept', 'T1', ...args]);
  if (r.code !== 0) assert.match(r.stderr, /T1 is accepted/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
}

test('accept refuses a code task without gates, and a review by the submitter does not count', async (t) => {
  const h = submitted(t);
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  const none = h.run(['accept', 'T1']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /tests: no tests evidence/);
  assert.match(none.stderr, /clean: no clean evidence/);
  assert.match(none.stderr, /review: no review evidence/);
  assert.doesNotMatch(none.stderr, /ci:/, 'ci is required only with a PR');

  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'w-1');
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /only the submitter \(w-1\) reviewed/);
  // The submitter's own review stands in for no one, so accept dispatches the reviewer.
  silentReviewer(h);
  assert.equal(h.json(['accept', 'T1']).review_pending, true);
  assert.equal(reviewerSpawns(h).length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  await reviewerExited(h);

  ev(h, 'review', 'r-1');
  acceptAfterReview(h);
});

test('the latest evidence at the submitted sha decides, and other shas do not count', (t) => {
  const h = submitted(t, ['--pr', '7']);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  ev(h, 'ci', 'ci');
  const doc = h.readState('tasks.json');
  // Keep a genuine receipt at another sha to exercise commit matching independently of provenance.
  doc.tasks[0].evidence.at(-1).sha = 'fffffff';
  h.writeState('tasks.json', doc);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'ci', 'accept runs missing CI at the current sha');
  h.ok(['rework', 'T1', '--reason', 'check failure precedence']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'w-1']);
  const reworked = h.json(['task', 'show', 'T1']);
  assert.equal(reworked.revision, 2);
  assert.ok(reworked.evidence.every((e) => e.revision === 1));
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  ev(h, 'ci', 'ci');
  ev(h, 'tests', 'w-1', false);
  const failed = h.run(['accept', 'T1']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /latest tests at .* failed:/);
  ev(h, 'tests', 'w-1');
  h.ok(['accept', 'T1']);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'accepted');
});

test('a revision bump invalidates earlier evidence', (t) => {
  const h = submitted(t);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works', '--acceptance', 'and logs it']);
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`no tests evidence at ${h.sha.slice(0, 7)} for revision 2`));
  assert.match(h.ok(['task', 'show', 'T1']), /revision 1, does not count/);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
});

test('an accepted task keeps its acceptance, dependencies and kind until it is sent back', (t) => {
  const h = submitted(t);
  ev(h, 'tests', 'w-1');
  ev(h, 'clean', 'w-1');
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
  h.ok(['task', 'add', '--title', 'Uses the change', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'Unrelated', '--acceptance', 'c']);
  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  for (const [flags, what] of [
    [['--acceptance', 'a new unmet criterion'], 'acceptance'],
    [['--dep', 'T3'], 'dependencies'],
  ]) {
    const r = h.run(['task', 'update', 'T1', ...flags]);
    assert.equal(r.code, 1, `${flags.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`T1 is accepted, so its ${what} cannot change; send it back first with tower-crane rework T1`));
  }
  const kind = h.run(['task', 'update', 'T1', '--kind', 'docs']);
  assert.equal(kind.code, 1, kind.stderr);
  assert.match(kind.stderr, /on a submitted or accepted task is refused; rework the task first/);
  assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before, 'a refused update writes nothing');
  const t1 = h.json(['task', 'show', 'T1']);
  assert.deepEqual([t1.status, t1.revision, t1.gates.ok], ['accepted', 1, true]);

  h.ok(['task', 'update', 'T1', '--title', 'Change, renamed', '--size', 'S']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works']);
  assert.equal(h.readState('tasks.json').tasks[0].revision, 1, 'unchanged acceptance is not a change');

  h.ok(['rework', 'T1', '--reason', 'it must also log retries']);
  assert.equal(h.json(['task', 'show', 'T1']).revision, 2);
  h.ok(['task', 'update', 'T1', '--acceptance', 'it works', '--acceptance', 'it logs retries']);
  const reworked = h.readState('tasks.json').tasks[0];
  assert.deepEqual([reworked.status, reworked.revision], ['rework', 3]);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1', 'T3'], 'T2 waits for T1 again');
});

test('other kinds need only a review from another agent', async (t) => {
  const h = submitted(t, [], 'docs');
  ev(h, 'review', 'w-1');
  silentReviewer(h);
  assert.equal(h.json(['accept', 'T1']).review_pending, true);
  await reviewerExited(h);
  ev(h, 'review', 'r-1');
  acceptAfterReview(h);
});

for (const [retry, delayed] of [['unchanged', false], ['override', false], ['head', false], ['revision', false], ['unchanged', true]]) {
  test(`accept does not repeat a failed review without a new input: ${retry}${delayed ? ', delayed exit reaction' : ''}`, async (t) => {
    const h = submitted(t, [], 'docs');
    silentReviewer(h);
    const preload = path.join(h.base, 'delayed-review-exit.js');
    if (delayed) fs.writeFileSync(preload, `const path = require('node:path');
if (path.basename(process.argv[1] || '') === 'spawn-monitor.js') {
  const automation = require(path.join(path.dirname(process.argv[1]), 'automation.js'));
  const consume = automation.consume;
  automation.consume = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 500)); // wait-allow: widen the gap between the exit receipt and its reaction
    return consume(...args);
  };
}
`);
    assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator'],
      delayed ? { pre: ['--require', preload] } : {}).review_pending, true);
    await reviewerExited(h);
    const exit = events(h).findLast((e) => e.cmd === 'spawn exit' && e.detail.agent === reviewerSpawns(h)[0].detail.agent);
    assert.ok(events(h).some((e) => e.cmd === 'automation' && e.detail.source === exit.id && e.detail.phase === 'done'),
      'the reviewer exit reaction finishes before the next verdict is recorded');
    const reviewer = reviewerSpawns(h)[0].detail.agent;
    h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.sha, '--agent', reviewer,
      '--summary', '1 blocker: value.md:1 - missing behavior',
      '--findings', JSON.stringify([{ kind: 'defect', path: 'value.md', claim: 'missing behavior' }])]);
    const failed = h.run(['accept', 'T1', '--agent', 'orchestrator', '--json']);
    assert.equal(failed.code, 1, failed.stderr);
    assert.ok(failed.stdout.trim(), JSON.stringify(failed));
    const result = JSON.parse(failed.stdout);
    assert.equal(result.review_failed, true);
    assert.equal(result.status, 'submitted');
    assert.equal(result.review.agent, reviewer);
    assert.equal(result.inbox.id, 'review_failed:T1');
    assert.deepEqual(result.inbox.action.argv, ['rework', '--from-review', 'T1']);
    assert.equal(reviewerSpawns(h).length, 1, 'two accepts start one review');
    if (retry === 'unchanged') return;
    if (retry === 'head') {
      fs.writeFileSync(path.join(h.repo, 'retry.md'), 'Changed implementation.\n');
      h.git(['add', '.']);
      h.git(['commit', '-qm', 'Fix behavior']);
      h.sha = h.git(['rev-parse', 'HEAD']);
      h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'w-1']);
    } else if (retry === 'revision') {
      h.ok(['task', 'update', 'T1', '--acceptance', 'it works with retries', '--agent', 'orchestrator']);
    } else {
      const denied = h.run(['accept', 'T1', '--retry-review', '--agent', 'w-1']);
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /operational|orchestrator/);
      assert.equal(reviewerSpawns(h).length, 1);
    }
    assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator',
      ...(retry === 'override' ? ['--retry-review'] : [])]).review_pending, true);
    assert.equal(reviewerSpawns(h).length, 2);
    if (retry === 'override') assert.equal(reviewerSpawns(h).at(-1).detail.review_retry.sha, h.sha);
    await reviewerExited(h);
    if (retry === 'override') {
      h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      const task = h.json(['task', 'show', 'T1']);
      assert.equal(task.status, 'submitted', 'automation must let the explicit retry finish without replaying the old failure');
      assert.equal(reviewerSpawns(h).length, 2);
      const held = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_held');
      assert.deepEqual(held.action.argv, ['accept', 'T1', '--retry-review']);
    }
  });
}

test('an explicit retry snapshot survives governor deferral only at its failed head and revision', () => {
  const sha = 'a'.repeat(40);
  const review = { type: 'review', ok: false, sha, revision: 1, agent: 'owner', summary: 'Missing behavior' };
  const task = { id: 'T1', status: 'submitted', sha, revision: 1, evidence: [review] };
  const retry = { sha, revision: 1, review };
  for (const row of [
    { name: 'deferred explicit retry', cmd: 'review dispatch deferred', valid: true },
    { name: 'started explicit retry', cmd: 'spawn', valid: true },
    { name: 'updated explicit retry context', cmd: 'review dispatch context', valid: true },
    { name: 'new head', cmd: 'review dispatch deferred', sha: 'b'.repeat(40), valid: false },
    { name: 'new revision', cmd: 'review dispatch deferred', revision: 2, valid: false },
    { name: 'new verdict', cmd: 'review dispatch deferred', review: { ...review, summary: 'Different failure' }, valid: false },
    { name: 'ordinary deferred review', cmd: 'review dispatch deferred', ordinary: true, valid: false },
  ]) {
    const current = { ...task, sha: row.sha || sha, revision: row.revision || 1, evidence: [row.review || review] };
    const st = { tasks: { tasks: [current] }, events: [{ task: task.id, cmd: row.cmd,
      detail: { role: 'reviewer', sha, revision: 1, ...(row.ordinary ? {} : { review_retry: retry }) } }] };
    assert.equal(Actions.pendingRetry(st, current, current.evidence[0]), row.valid, row.name);
    assert.equal(Reviewer.deferredDispatches(st).length, row.cmd === 'review dispatch deferred' && row.valid ? 1 : 0, row.name);
  }
});

test('review evidence counts only from a reviewer spawned for that head and revision, or the owner', async (t) => {
  const h = submitted(t, [], 'docs');
  // I6: a name no spawn started records an ok review; it is kept but does not count.
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'made-up-reviewer']);
  const show = h.ok(['task', 'show', 'T1']);
  assert.match(show, /gates: review missing/);
  assert.match(show, /review ok at \w+ by made-up-reviewer .*\(does not count\)/);
  const reason = /review by made-up-reviewer does not count: not a reviewer spawned for T1 at \w+ revision 1, nor the owner/;
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), reason);
  // I7: the orchestrator cannot accept on it, and it does not hold back the real reviewer.
  silentReviewer(h);
  const forged = h.json(['accept', 'T1', '--agent', 'orchestrator']);
  assert.equal(forged.review_pending, true);
  assert.equal(reviewerSpawns(h).length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  await reviewerExited(h);
  // The board ledger, the owner's view of what counts, agrees with the gate.
  const sheet = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').match(/<article id="T1"[\s\S]*?<\/article>/)[0];
  assert.match(sheet, /made-up-reviewer[\s\S]*?class="nocount">\(does not count: not a spawned reviewer\)/);

  // A reviewer spawn for another head, revision or task, or as a worker, does not vouch for it.
  h.reviewer('T1', 'r-other-sha', 'fffffff');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'r-other-sha']);
  const worker = { at: new Date().toISOString(), agent: 'orchestrator', cmd: 'spawn', task: 'T1',
    detail: { agent: 'worker-T1-9', role: 'worker', sha: h.sha, revision: 1, pid: 999999, attempt: 1 } };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(worker)}\n`);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'worker-T1-9']);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /review by made-up-reviewer, r-other-sha, worker-T1-9 does not count/);

  h.reviewer('T1', 'reviewer-T1-7');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer-T1-7']);
  acceptAfterReview(h, '--agent', 'orchestrator');
});

test('the owner review counts without a reviewer spawn', (t) => {
  const h = submitted(t, [], 'docs');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'owner']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
});

test('accept runs missing CI for a non-code task with a PR', (t) => {
  const h = submitted(t, ['--pr', '7'], 'docs');
  ev(h, 'review', 'r-1');
  h.ok(['accept', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'ci');
});

for (const [review, pass] of [[true, true], [false, true], [true, false]]) {
  test(`accept reruns stale local CI with review ${review ? 'present' : 'missing'} and CI ${pass ? 'passing' : 'failing'}`, async (t) => {
    const h = submitted(t, ['--pr', '7']);
    ev(h, 'tests', 'w-1');
    ev(h, 'clean', 'w-1');
    if (review) ev(h, 'review', 'r-1');
    else silentReviewer(h);
    const reviewsBefore = reviewerSpawns(h).length;
    const runs = path.join(h.base, 'ci-runs');
    const command = [process.execPath, '-e',
      "require('node:fs').appendFileSync(process.argv[1], 'run\\n'); process.exit(process.env.FIXTURE_GATE_OK === '0' ? 1 : 0);", runs];
    h.ok(['project', 'set', '--ci-local', JSON.stringify({ command, timeout: 30 })]);
    h.ok(['check', 'ci', 'T1']);
    const before = h.readState('tasks.json').tasks[0].evidence;
    const old = before.at(-1);
    // A base that moves forward keeps the receipt on its pinned tree; a force-push that
    // drops the checked base commit makes it stale.
    h.git(['switch', '-q', 'main']);
    h.git(['reset', '-q', '--hard', 'HEAD~1']);
    fs.writeFileSync(path.join(h.repo, 'base-advance.txt'), 'new base\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'rewrite the CI base']);
    h.git(['switch', '-q', 'fixture-change']);
    assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /current merged tree/);

    const result = h.run(['accept', 'T1'], { env: { FIXTURE_GATE_OK: pass ? '1' : '0' } });
    assert.equal(result.code, pass ? 0 : 1, result.stderr);
    assert.match(result.stderr, /running stale ci software gate/);
    // A failing local CI reruns once on the same merge.
    assert.equal(fs.readFileSync(runs, 'utf8'), pass ? 'run\nrun\n' : 'run\nrun\nrun\n');
    const task = h.readState('tasks.json').tasks[0];
    const ci = task.evidence.at(-1);
    assert.equal(ci.type, 'ci');
    assert.equal(ci.ok, pass);
    assert.notEqual(ci.receipt.tree_hash, old.receipt.tree_hash);
    assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)),
      before.filter((e) => ['tests', 'clean'].includes(e.type)), 'fresh software receipts are reused');
    if (!pass) {
      assert.match(result.stderr, /ci: latest ci .* failed/);
      assert.equal(task.status, 'submitted');
      assert.equal(reviewerSpawns(h).length, reviewsBefore);
      h.run(['accept', 'T1']);
      assert.equal(fs.readFileSync(runs, 'utf8'), 'run\nrun\nrun\n', 'current failures need an explicit rerun');
    } else if (review) {
      assert.equal(task.status, 'accepted');
    } else {
      assert.match(result.stdout, /software gates passed; review pending/);
      assert.deepEqual(h.json(['task', 'show', 'T1']).gates.missing,
        [`review: no review evidence at ${h.sha.slice(0, 7)} for revision 1`]);
      assert.equal(task.status, 'submitted');
      assert.equal(reviewerSpawns(h).length, 1);
      await reviewerExited(h);
    }
  });
}

test('only the owner can waive tests or clean, the orchestrator escalates, and a refused accept records no waiver', (t) => {
  const h = submitted(t);
  ev(h, 'review', 'r-1');
  const notOwner = h.run(['accept', 'T1', '--waive', 'tests', '--reason', 'no test harness', '--agent', 'orchestrator']);
  assert.equal(notOwner.code, 1);
  assert.match(notOwner.stderr, /waive\.tests is owner-required; opened D1 for the owner/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.filter((e) => e.waived).length, 0);
  assert.equal(h.run(['accept', 'T1', '--waive', 'tests', '--agent', 'owner']).code, 2, '--reason is required');

  const partial = h.run(['accept', 'T1', '--waive', 'tests', '--reason', 'no test harness yet'], { env: { FIXTURE_GATE_OK: '0' } });
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /clean: latest clean .* failed/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.filter((e) => e.waived).length, 0);

  h.ok(['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--reason', 'generated code']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.waived).map((e) => [e.type, e.agent, e.summary]), [
    ['tests', 'owner', 'generated code'],
    ['clean', 'owner', 'generated code'],
  ]);
});

// A review spawn at the submitted head whose process exited without a verdict.
function reviewerDown(h) {
  const { revision } = h.readState('tasks.json').tasks[0];
  const at = new Date().toISOString();
  const detail = { agent: 'r-9', role: 'reviewer', rung: 'review', sha: h.sha, revision, pid: 999999, attempt: 1 };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail },
    { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'r-9', pid: 999999, attempt: 1, code: 1 } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
}

// A check ci at the submitted head that found the review app at its usage limit.
function reviewerCapped(h) {
  h.ok(['project', 'set', '--ci-capped-review', '[{"app":"reviewbot","pattern":"usage limit"}]']);
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator'], { env: { FIXTURE_CAPPED: '1' } });
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1).capped_review, ['bot-review (reviewbot)']);
}

for (const [state, makeOut] of [['capped', reviewerCapped], ['down', reviewerDown]]) {
  test(`the orchestrator waives review only for a ${state} reviewer and the waiver counts`, (t) => {
    const h = submitted(t);
    ev(h, 'tests', 'orchestrator');
    ev(h, 'clean', 'orchestrator');
    const waive = ['accept', 'T1', '--waive', 'review', '--reason', `reviewer ${state}`];
    // A reviewer that is neither capped nor down: waiving it is the owner's.
    const live = h.run([...waive, '--agent', 'orchestrator']);
    assert.equal(live.code, 1, live.stderr);
    assert.match(live.stderr, /waive\.review_live is owner-required; opened D1 for the owner/);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.filter((e) => e.waived).length, 0);
    makeOut(h);
    const worker = h.run([...waive, '--agent', 'w-2']);
    assert.equal(worker.code, 1, worker.stderr);
    assert.match(worker.stderr, /waive\.review is operational/);
    h.ok([...waive, '--agent', 'orchestrator']);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'accepted');
    assert.deepEqual(task.evidence.filter((e) => e.waived).map((e) => [e.type, e.agent]), [['review', 'orchestrator']]);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
    assert.equal(h.readState('decisions.json').decisions.length, 1);
  });
}

for (const row of [
  { name: 'capped reviewer', out: reviewerCapped },
  { name: 'earlier no-verdict exit', out: reviewerDown },
  { name: 'owner waiver of live review', agent: 'owner' },
  { name: 'false PR-body claim', out: reviewerDown, kind: 'false-claim', path: 'PR body' },
  { name: 'title follow-up alongside a body blocker', out: reviewerDown, kind: 'false-claim', path: 'PR body', title: true },
  { name: 'false changelog claim', out: reviewerDown, kind: 'false-claim', path: 'changelog.d/T1.md' },
  { name: 'mixed waivers', out: reviewerDown, agent: 'owner', extra: ['--waive', 'clean'] },
  { name: 'retry combined with waiver', out: reviewerDown, extra: ['--retry-review'] },
  { name: 'failed verdict during software gates', out: reviewerDown, late: true },
  { name: 'failed verdict during archive preparation', out: reviewerDown, archive: true },
]) {
  test(`review waivers cannot clear a failed verdict: ${row.name}`, async (t) => {
    const h = submitted(t);
    if (row.out) row.out(h);
    h.reviewer('T1', 'failing-reviewer', h.sha);
    const recordFailure = () => h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.sha,
      '--agent', 'failing-reviewer', '--summary', '1 blocking finding: incorrect behavior',
      '--findings', JSON.stringify([{ kind: row.kind || 'defect', path: row.path || 'value.js',
        claim: 'Incorrect behavior or false claim' },
      ...(row.title ? [{ kind: 'defect', path: 'PR title', claim: 'Overstated title' }] : [])])]);
    const args = ['accept', 'T1', '--waive', 'review', '--reason', 'reviewer unavailable',
      '--agent', row.agent || 'orchestrator', '--json', ...(row.extra || [])];
    let result;
    if (row.archive) {
      const hook = path.join(h.base, 'waiver-archive-hook.js');
      const findings = [{ kind: 'defect', path: 'value.js', claim: 'Incorrect behavior' }];
      fs.writeFileSync(hook, `
const cp = require('node:child_process');
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const archive = require(${JSON.stringify(path.join(ROOT, 'lib/archive.js'))});
const original = archive.onAccept;
archive.onAccept = async (...args) => {
  const r = cp.spawnSync(process.execPath, ${JSON.stringify([BIN, 'evidence', 'T1', '--type', 'review', '--fail',
    '--sha', h.sha, '--agent', 'failing-reviewer', '--summary', 'Late failure',
    '--findings', JSON.stringify(findings)])}, { env: fakeAgentEnv(process.env), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return original(...args);
};
`);
      result = h.run(args, { env: { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(hook)}` } });
    } else if (row.late) {
      const started = path.join(h.base, 'waiver-gate-started');
      const release = path.join(h.base, 'waiver-gate-release');
      const script = path.join(h.base, 'waiver-gate.js');
      fs.writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], '');
const end = Date.now() + 60000; // wait-allow: bounded fixture wait for the explicit gate release signal
while (!fs.existsSync(process.argv[3])) {
  if (Date.now() >= end) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: release signal with a 60-second deadline
}
`);
      h.ok(['project', 'set', '--tests-mode', 'run-only',
        '--tests-cmd', [process.execPath, script, started, release].map(require('../lib/gates/common').shellQuote).join(' ')]);
      const pending = h.runAsync(args);
      try {
        await waitOnRepo(h, () => fs.existsSync(started), 'accept never entered the software gate', { signal: t.signal });
        recordFailure();
      } finally {
        fs.writeFileSync(release, '');
      }
      result = await pending;
    } else {
      recordFailure();
      result = h.run(args);
    }
    assert.equal(result.code, 1, result.stderr);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.review_failed, true);
    assert.equal(refusal.review.agent, 'failing-reviewer');
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'submitted');
    assert.equal(task.revision, 1);
    assert.equal(task.sha, h.sha);
    assert.equal(task.evidence.filter((e) => e.waived).length, 0);
    assert.ok(!events(h).some((e) => e.cmd === 'accept'));
  });
}

test('a title-only follow-up does not block an authorized review waiver', (t) => {
  const h = submitted(t);
  reviewerDown(h);
  h.reviewer('T1', 'title-reviewer', h.sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.sha, '--agent', 'title-reviewer',
    '--findings', JSON.stringify([{ kind: 'defect', path: 'PR title', claim: 'Overstated title' }])]);
  h.ok(['accept', 'T1', '--waive', 'review', '--reason', 'Only a title follow-up', '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(reviewerSpawns(h).length, 2, 'no additional full review for the title');
});

test('rework sends the task back with the reason in the brief, and it can be claimed again', (t) => {
  const h = submitted(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Brief\n\nDo the change.\n' });
  assert.equal(h.run(['rework', 'T1']).code, 2);
  h.ok(['rework', 'T1', '--reason', 'handle the empty key case', '--agent', 'r-1']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  const brief = fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8');
  assert.match(brief, /^# Brief\n\nDo the change\.\n\n## Rework notes\n\n- .* r-1: handle the empty key case\n$/);
  assert.deepEqual(h.json(['ready']).ready.map((x) => [x.id, x.status]), [['T1', 'rework']]);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  h.ok(['release', 'T1', '--reason', 'not me', '--agent', 'w-2']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework', 'release returns to the prior status');
  assert.equal(h.run(['rework', 'T1', '--reason', 'again']).code, 1, 'only submitted or accepted tasks go back');
});

test('evidence needs a sha and exactly one verdict', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  const r = h.run(['evidence', 'T1', '--type', 'review', '--ok']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /review evidence needs --sha/);
  assert.equal(h.run(['evidence', 'T1', '--type', 'review', '--ok', '--fail', '--sha', 'abcdef1', '--revision', h.revision('T1')]).code, 2);
  assert.equal(h.run(['evidence', 'T1', '--type', 'vibes', '--ok', '--sha', 'abcdef1']).code, 2);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'note', '--ok', '--sha', 'abcdef1', '--ref', 'run 42']);
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].ref, 'run 42');
});
