'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const FinalReview = require('../lib/final-review');

const CAPPED = { FIXTURE_CAPPED: '1' };
// A review app that reviewed this head and said so in its check run.
const REVIEWED = { FIXTURE_REVIEW_RUN: JSON.stringify({ name: 'bot-review', app: 'reviewbot', status: 'completed', conclusion: 'success', suite: 9, output: { title: 'Reviewed: no blocking findings' } }) };

// A submitted task with a PR whose review app caps at its usage limit, and a
// fake external reviewer that logs where and how it ran and exits FINAL_EXIT.
function submitted(t, finalReview = {}) {
  const h = cachedFixture(t, 'final-review', (h) => {
    h.init();
    h.sha = gateFixture(h);
    h.ok(['project', 'set', '--repo', 'acme/demo', '--ci-capped-review', '[{"app":"reviewbot","pattern":"usage limit"}]']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
    h.ok(['claim', 'T1', '--agent', 'w-1']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '9', '--agent', 'w-1']);
    const reviewer = path.join(h.base, 'tools', 'final-reviewer.js');
    fs.writeFileSync(reviewer, `const fs = require('node:fs');
const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(process.env.FINAL_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), head,
  tmpdir: process.env.TMPDIR, marker: process.env.FINAL_MARKER || null }) + '\\n');
console.log(process.env.FINAL_SAY || 'final reviewer: fine');
process.exit(Number(process.env.FINAL_EXIT || 0));
`);
    return { sha: h.sha, finalReviewer: reviewer };
  });
  h.log = path.join(h.base, 'final.jsonl');
  h.ok(['project', 'set', '--final-review', JSON.stringify({
    command: [process.execPath, h.finalReviewer, '{repo}', '{pr}', '{sha}', '--final'], capped_pattern: 'usage limit reached', ...finalReview })]);
  return h;
}

// Every other gate passes at the head: tests, clean, ci (with the review app's check as given) and review.
function gatesPass(h, env) {
  gateEvidence(h, 'tests', 'orchestrator');
  gateEvidence(h, 'clean', 'orchestrator');
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator'], { env });
  h.reviewer('T1', 'r-1');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'r-1']);
}

const runs = (h) => (fs.existsSync(h.log) ? fs.readFileSync(h.log, 'utf8').trim().split('\n').map(JSON.parse) : []);
const task = (h) => h.readState('tasks.json').tasks[0];
const finals = (h) => task(h).evidence.filter((e) => e.type === 'final-review');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const accepted = (h) => events(h).filter((e) => e.cmd === 'accept' && e.task === 'T1');

function accept(h, env) {
  return h.run(['accept', 'T1', '--agent', 'orchestrator'], { env: { FINAL_LOG: h.log, FINAL_MARKER: 'gate-env', ...env } });
}

test('a capped head runs the final review once, from a gate worktree at the head with expanded placeholders, and a pass accepts', (t) => {
  const h = submitted(t);
  gatesPass(h, CAPPED);
  const r = accept(h, { ...CAPPED, FINAL_EXIT: '0' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /accepted T1 .*final review pass/);
  assert.equal(task(h).status, 'accepted');
  const [ran, ...more] = runs(h);
  assert.equal(more.length, 0, 'the reviewer is asked once');
  assert.deepEqual(ran.argv, ['acme/demo', '9', h.sha, '--final']);
  // A fresh checkout of the head under the gate temporary root, with the gate's scratch TMPDIR and the caller's environment.
  const gateRoot = fs.realpathSync(path.join(h.base, 'gate-tmp'));
  assert.equal(ran.head, h.sha);
  assert.notEqual(fs.realpathSync.native(h.repo), ran.cwd);
  assert.ok(ran.cwd.startsWith(gateRoot + path.sep) && path.basename(ran.cwd) === 'wt', ran.cwd);
  assert.equal(path.dirname(ran.tmpdir), path.dirname(ran.cwd));
  assert.equal(ran.marker, 'gate-env');
  const [evidence] = finals(h);
  assert.equal(finals(h).length, 1);
  assert.equal(evidence.ok, true);
  assert.deepEqual([evidence.final_review.outcome, evidence.final_review.exit, evidence.final_review.capped], ['pass', 0, ['bot-review (reviewbot)']]);
  assert.match(evidence.summary, /final reviewer: fine/);
  const receipt = evidence.commands.find((c) => c.command === process.execPath);
  assert.deepEqual(receipt.args, [h.finalReviewer, 'acme/demo', '9', h.sha, '--final']);
  assert.equal(path.basename(receipt.cwd), 'wt');
  assert.equal(path.basename(path.dirname(receipt.cwd)), path.basename(path.dirname(ran.cwd)));
  assert.equal(receipt.status, 0);
  assert.equal(accepted(h).at(-1).detail.final_review.outcome, 'pass');
});

test('the concerns exit sends the task to rework with the output and the review comments at the head as findings', (t) => {
  const h = submitted(t);
  gatesPass(h, CAPPED);
  const comments = [
    { id: 71, in_reply_to_id: null, path: 'value.js', line: 1, body: '[P1] value is off by one', user: 'revuto[bot]', original_commit_id: h.sha },
    { id: 72, in_reply_to_id: null, path: 'value.js', line: 1, body: 'an older round', user: 'revuto[bot]', original_commit_id: 'f'.repeat(40) },
  ];
  const r = accept(h, { ...CAPPED, FINAL_EXIT: '2', FINAL_SAY: 'blocking: value.js returns 1', FIXTURE_PR_COMMENTS: JSON.stringify(comments) });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /final review raised concerns; T1 sent back for rework/);
  assert.equal(task(h).status, 'rework');
  assert.equal(accepted(h).length, 0);
  assert.equal(runs(h).length, 1);
  const [evidence] = finals(h);
  assert.deepEqual([evidence.ok, evidence.final_review.outcome, evidence.final_review.exit], [false, 'concerns', 2]);
  const reason = events(h).findLast((e) => e.cmd === 'rework').detail.reason;
  assert.match(reason, /^final review FAIL at [0-9a-f]{40}:/);
  assert.match(reason, /blocking: value\.js returns 1/);
  assert.match(reason, /value\.js:1 \(comment 71 by revuto\[bot\]\)\n {2}\[P1\] value is off by one/);
  assert.doesNotMatch(reason, /an older round/, 'only comments at the reviewed head are findings');
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8'), /\[P1\] value is off by one/);

  // The same head at a new revision runs the normal gates and, capped again, the final review again.
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'w-1']);
  gatesPass(h, CAPPED);
  const again = accept(h, { ...CAPPED, FINAL_EXIT: '0' });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(task(h).status, 'accepted');
  assert.equal(runs(h).length, 2);
  assert.deepEqual(finals(h).map((e) => [e.revision, e.final_review.outcome]), [[1, 'concerns'], [task(h).revision, 'pass']]);
});

test('a refusal accepts, with the refusal recorded and shown by accept, its event, status and the board', (t) => {
  const h = submitted(t);
  gatesPass(h, CAPPED);
  const r = accept(h, { ...CAPPED, FINAL_EXIT: '3', FINAL_SAY: 'refused: this head was already reviewed' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /final review refused/);
  assert.equal(task(h).status, 'accepted');
  const [evidence] = finals(h);
  assert.deepEqual([evidence.ok, evidence.final_review.outcome, evidence.final_review.exit], [true, 'refused', 3]);
  assert.match(evidence.summary, /refused: this head was already reviewed/);
  assert.equal(accepted(h).at(-1).detail.final_review.outcome, 'refused');
  const status = h.run(['status']);
  assert.match(status.stdout, /^final review: T1 refused at [0-9a-f]{7}$/m);
  assert.deepEqual(h.json(['status']).final_reviews.map((f) => [f.id, f.outcome]), [['T1', 'refused']]);
  h.ok(['render']);
  const board = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(board, /final-review refused/);
  // History: the accept event and the final review's own.
  assert.match(board, /T1<\/a> accepted at [0-9a-f]{7}, final review refused</);
  assert.match(board, /final review refused on <a [^>]*>T1<\/a> at [0-9a-f]{7}/);
});

// Stands in for wait's forced shutdown: accept's gate gets the signal wait passes to automation,
// and it aborts as the reviewer command returns, before runGate records the result.
const INTERRUPT = `const lib = ${JSON.stringify(path.join(__dirname, '..', 'lib'))};
const force = new AbortController();
const gate = require(lib + '/gates/final-review.js');
const run = gate.run;
gate.run = async (ctx) => { const r = await run(ctx); force.abort(); return r; };
const check = require(lib + '/check.js');
const runGate = check.runGate;
check.runGate = (ctx, name) => runGate({ ...ctx, gateSignal: force.signal }, name);
`;

for (const [said, then, outcome, status] of [['2', '0', 'pass', 'accepted'], ['0', '2', 'concerns', 'rework']]) {
  test(`a final review that exited ${said} but was interrupted by wait shutdown is no verdict: the task stays submitted and the next accept asks again (exit ${then})`, (t) => {
    const h = submitted(t);
    gatesPass(h, CAPPED);
    const preload = path.join(h.base, 'interrupt.js');
    fs.writeFileSync(preload, INTERRUPT);
    const r = h.run(['accept', 'T1', '--agent', 'orchestrator'], { env: { FINAL_LOG: h.log, ...CAPPED, FINAL_EXIT: said }, pre: ['--require', preload] });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /T1: not accepted; the final review at [0-9a-f]{7} gave no verdict \(final-review gate interrupted by wait shutdown; retry with gates retry\); retry accept/);
    assert.equal(task(h).status, 'submitted');
    assert.equal(events(h).filter((e) => e.cmd === 'rework').length, 0);
    assert.equal(accepted(h).length, 0);
    assert.deepEqual(finals(h).map((e) => [e.ok, e.final_review.outcome, e.final_review.interrupted]), [[false, 'not_run', true]]);
    assert.equal(h.json(['status']).final_reviews.length, 0, 'an interrupted run is not the head\'s final review');

    const again = accept(h, { ...CAPPED, FINAL_EXIT: then });
    assert.equal(again.code, status === 'accepted' ? 0 : 1, again.stderr);
    assert.equal(task(h).status, status);
    assert.equal(runs(h).length, 2);
    assert.equal(finals(h).at(-1).final_review.outcome, outcome);
  });
}

test('an uncapped head with a real external review skips the final review when "when" is "capped", and "always" runs it', (t) => {
  const h = submitted(t);
  gatesPass(h, REVIEWED);
  const r = accept(h, REVIEWED);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(task(h).status, 'accepted');
  assert.equal(runs(h).length, 0, 'the reviewer is not asked');
  const [evidence] = finals(h);
  assert.deepEqual([evidence.ok, evidence.final_review.outcome], [true, 'skipped']);
  assert.match(evidence.summary, /no check run there matches gates\.final_review\.capped_pattern/);
  assert.doesNotMatch(h.run(['status']).stdout, /final review:/);

  const always = submitted(t, { when: 'always' });
  gatesPass(always, REVIEWED);
  assert.equal(accept(always, REVIEWED).code, 0);
  assert.equal(runs(always).length, 1);
  assert.equal(finals(always)[0].final_review.outcome, 'pass');
});

test('final review settings: project set validates them, project show prints them, and evidence cannot be recorded by hand', (t) => {
  const h = submitted(t);
  assert.match(h.ok(['project', 'show']), /^gates\.final_review: \{"when":"capped","timeout":1200,"concerns_exit":2,"command":\[/m);
  const bad = h.run(['project', 'set', '--final-review', '{"command":["revuto"]}']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /capped_pattern must be a nonempty regular expression/);
  const manual = h.run(['evidence', 'T1', '--type', 'final-review', '--ok', '--sha', h.sha]);
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /only tower-crane accept records final-review evidence/);
  h.ok(['project', 'set', '--final-review', 'null']);
  assert.match(h.ok(['project', 'show']), /^gates\.final_review: off$/m);
});

test('final review placeholders and settings, in process', () => {
  const values = { repo: 'acme/demo', pr: '9', sha: 'a'.repeat(40) };
  for (const [arg, want] of [
    ['{repo}', 'acme/demo'], ['{pr}', '9'], ['{sha}', 'a'.repeat(40)], ['--pr={pr}', '--pr=9'],
    ['{repo}#{pr}@{sha}', `acme/demo#9@${'a'.repeat(40)}`], ['{other}', '{other}'], ['{{pr}}', '{9}'], ['--final', '--final'],
  ]) assert.equal(FinalReview.expand(arg, values), want, arg);
  const ok = { command: ['revuto', 'review', '{repo}', '{pr}', '--final'], capped_pattern: 'reached the \\d+-round review limit' };
  for (const [value, error] of [
    [null, null], [ok, null], [{ ...ok, when: 'always', capped_pattern: undefined }, null], [{ ...ok, timeout: 30, concerns_exit: 9 }, null],
    [[], /must be an object/], [{ ...ok, extra: 1 }, /unknown keys: extra/], [{ ...ok, command: [] }, /command must be a nonempty argv/],
    [{ ...ok, command: [' '] }, /command must be/], [{ ...ok, command: 'revuto' }, /command must be/], [{ ...ok, when: 'never' }, /when must be/],
    [{ command: ok.command }, /capped_pattern must be/], [{ ...ok, capped_pattern: '(' }, /not a valid regular expression/],
    [{ ...ok, timeout: 0 }, /timeout must be/], [{ ...ok, timeout: 3e6 }, /timeout must be/], [{ ...ok, concerns_exit: 0 }, /concerns_exit/],
    [{ ...ok, concerns_exit: 1.5 }, /concerns_exit/],
  ]) {
    const errors = FinalReview.errors({ final_review: value });
    if (error) assert.match(errors.join('\n'), error, JSON.stringify(value));
    else assert.deepEqual(errors, [], JSON.stringify(value));
  }
});
