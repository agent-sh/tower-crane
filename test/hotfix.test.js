'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { waitOnRepo } = require('./signals');
const { gateFixture } = require('./gate-helpers');
const Reviewer = require('../lib/reviewer');
const { shellQuote } = require('../lib/gates/common');

function fixture(t) {
  return cachedFixture(t, 'merged-hotfix', (h) => {
    h.init(['--repo', 'acme/demo']);
    const head = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Urgent value fix', '--acceptance', 'value becomes one']);
    h.ok(['brief', 'set', 'T1', '-'], { input: '# Value fix\n\nPreserve the regression test.\n' });
    h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
    h.git(['switch', 'main']);
    const base = h.git(['rev-parse', 'HEAD']);
    h.git(['merge', '--no-ff', 'fixture-change', '-m', 'urgent fix']);
    const sha = h.git(['rev-parse', 'HEAD']);
    // Current main moves past the hotfix; gates must still measure only its change.
    fs.writeFileSync(path.join(h.repo, 'later.txt'), 'another task\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'later main change']);
    const later = h.git(['rev-parse', 'HEAD']);
    const gh = path.join(h.base, 'tools', 'gh');
    fs.writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const sha = ${JSON.stringify(sha)};
const head = ${JSON.stringify(head)};
const later = ${JSON.stringify(later)};
// FIXTURE_MERGE_RUN=cancelled: a newer push replaced the merge commit's run, and the later main commit ran green.
const mergeRun = process.env.FIXTURE_MERGE_RUN;
const ok = process.env.FIXTURE_GATE_OK !== '0';
if (process.env.FIXTURE_GH_ERROR) { console.error('fixture gh observation error'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'merge') { console.error('fixture: a merged hotfix must not merge again'); process.exit(3); }
if (args[0] === 'pr') {
  console.log(JSON.stringify({state: process.env.FIXTURE_PR_STATE || 'MERGED', headRefOid: head,
    mergeCommit: {oid: process.env.FIXTURE_MERGE_SHA || sha}, baseRefName: process.env.FIXTURE_BASE || 'main',
    commits: JSON.parse(process.env.FIXTURE_PR_COMMITS || '[]')}));
} else if (args[1].includes('/issues/comments/')) {
  console.log(JSON.stringify({id: Number(args[1].split('/').pop()), user: {login: process.env.FIXTURE_REVIEW_LOGIN || 'avifenesh'},
    author_association: process.env.FIXTURE_REVIEW_ASSOC || 'OWNER',
    html_url: 'https://github.com/acme/demo/pull/42#issuecomment-' + args[1].split('/').pop(),
    issue_url: 'https://api.github.com/repos/acme/demo/issues/' + (process.env.FIXTURE_REVIEW_PR || '42'),
    body: process.env.FIXTURE_REVIEW_BODY || ''}));
} else if (args[1] === 'repos/acme/demo/commits/' + sha) {
  console.log('2026-10-13T19:59:00Z');
} else if (args[1].includes('/compare/')) {
  const [from, to] = args[1].split('/compare/')[1].split('?')[0].split('...');
  console.log(from === sha && to === later ? 'ahead' : from === later && to === 'main' ? 'identical' : 'diverged');
} else if (args[1].includes('/check-runs')) {
  const atLater = args[1].includes(later);
  console.log(JSON.stringify({id: atLater ? 2 : 1, name: 'test (linux)', app: 'github-actions', suite: atLater ? 11 : 10,
    status: 'completed', conclusion: mergeRun && !atLater ? 'skipped' : ok ? 'success' : 'failure'}));
} else if (args[1].includes('/check-suites')) {
  const atLater = args[1].includes(later);
  console.log(JSON.stringify({id: atLater ? 11 : 10, app: 'github-actions', runs: 1,
    status: 'completed', conclusion: mergeRun && !atLater ? mergeRun : ok ? 'success' : 'failure'}));
} else if (args[1].includes('/actions/runs')) {
  const run = {id: 20, name: 'CI', path: 'ci.yml', head_sha: sha, head_branch: 'main', created_at: '2026-10-13T20:00:00Z',
    event: process.env.FIXTURE_EVENT || 'push', check_suite_id: 10,
    status: process.env.FIXTURE_WORKFLOW_STATUS || 'completed', conclusion: mergeRun || (ok ? 'success' : 'failure')};
  const next = {...run, id: 21, head_sha: later, check_suite_id: 11, created_at: '2026-10-13T20:10:00Z', conclusion: ok ? 'success' : 'failure'};
  if (args[1].includes('branch=main')) console.log(JSON.stringify(run) + '\\n' + JSON.stringify(next));
  else console.log(JSON.stringify(args[1].includes(later) ? next : run));
}
`);
    h.ok(['project', 'set', '--ci-required', '["test ("]']);
    return { sha, head, base_sha: base, later };
  });
}

const record = (h, opts) => h.json(['hotfix', 'T1', '--pr', '42', '--sha', h.sha], opts);
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const task = (h, id = 'T1') => h.readState('tasks.json').tasks.find((t) => t.id === id);
const verdict = (h, ok, agent = 'independent') => {
  h.reviewer('T1', agent);
  return h.ok(['evidence', 'T1', '--type', 'review', ok ? '--ok' : '--fail', '--sha', h.sha,
    '--agent', agent, '--summary', ok ? 'no blocking findings' : 'value.js:1 - repair the value']);
};

function silentReviewer(h) {
  const command = JSON.stringify([process.execPath, '-e', '0', '{prompt}']);
  for (const rung of ['easy', 'medium', 'hard', 'research', 'review']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort', '--command', command]);
  }
}

test('record verifies merged PR, commit, base and operational authority, then preserves repeated records', (t) => {
  const h = fixture(t);
  for (const env of [{ FIXTURE_PR_STATE: 'OPEN' }, { FIXTURE_MERGE_SHA: 'a'.repeat(40) }, { FIXTURE_BASE: 'release' }]) {
    const r = h.run(['hotfix', 'T1', '--pr', '42', '--sha', h.sha], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must be merged into main/);
    assert.equal(task(h).status, 'cancelled');
  }
  const refused = h.run(['hotfix', 'T1', '--pr', '42', '--sha', h.sha, '--agent', 'worker']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /orchestrator or owner/);
  const recorded = record(h);
  assert.equal(recorded.status, 'submitted');
  assert.equal(recorded.revision, 2);
  assert.equal(recorded.sha, h.sha);
  assert.equal(recorded.hotfix.head_sha, h.head);
  assert.equal(recorded.hotfix.base_sha, h.base_sha);
  const diff = Reviewer.diffOf({ root: h.repo }, { base: 'main' }, recorded);
  assert.deepEqual(diff.files.sort(), ['test/value.test.js', 'value.js']);
  assert.match(diff.text, /module.exports = 1/);
  h.ok(['check', 'tests', 'T1']);
  assert.match(task(h).evidence.at(-1).summary, /hotfix first parent/);
  assert.deepEqual(record(h), task(h));
  assert.equal(events(h).filter((e) => e.cmd === 'hotfix').length, 1);
  assert.equal(h.run(['submit', 'T1', '--sha', h.head]).code, 1);
});

test('software gates use merge tree, passing independent review accepts hotfix and reports separate counts', (t) => {
  const h = fixture(t);
  record(h);
  for (const name of ['tests', 'clean', 'ci']) h.ok(['check', name, 'T1']);
  const stored = task(h);
  assert.ok(stored.evidence.every((e) => e.sha === h.sha && e.revision === 2));
  assert.ok(stored.evidence.find((e) => e.type === 'tests').commands.some((c) => c.args.includes(h.sha)));
  assert.match(stored.evidence.find((e) => e.type === 'clean').summary, new RegExp(h.base_sha.slice(0, 10)));
  silentReviewer(h);
  const preview = h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
  const prompt = preview.argv.find((a) => a.includes('## Task'));
  assert.match(prompt, /merged before its gates/);
  // A prompt over the argv budget names the review packet instead of carrying the diff; the next test reads that packet.
  assert.match(prompt, new RegExp(`module.exports = 1|Read .*reviews.* for the diff at ${h.sha}`));
  assert.match(prompt, new RegExp(`Record review evidence at merge commit ${h.sha}`));
  // A review by the recorder cannot stand in for an independent reviewer.
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--revision', '2']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  verdict(h, true);
  assert.match(h.ok(['accept', 'T1']), /accepted \(hotfix\)/);
  assert.equal(task(h).status, 'accepted');
  assert.match(h.ok(['task', 'show', 'T1']), /status: accepted \(hotfix\)/);
  assert.match(h.ok(['task', 'list']), /accepted \(hotfix\)/);
  assert.match(h.ok(['status']), /1 accepted \(hotfix\)/);
  assert.equal(h.json(['status']).counts.accepted_hotfix, 1);
  assert.equal(h.json(['bench', 'tokens']).accepted_hotfix, 1);
  assert.equal(h.json(['bench', 'tokens']).tasks[0].hotfix, true);
  assert.ok(events(h).some((e) => e.cmd === 'accept' && e.detail.hotfix && /merged before its gates/.test(e.detail.reason)));
  assert.equal(require('../lib/stack').merged({ events: events(h) }, task(h)), true);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /accepted \(hotfix\)/);
});

test('accept runs missing software gates and dispatches one normal reviewer at the merge commit', async (t) => {
  const h = fixture(t);
  record(h);
  silentReviewer(h);
  const r = h.json(['accept', 'T1']);
  assert.equal(r.review_pending, true);
  assert.equal(r.sha, h.sha);
  assert.deepEqual(task(h).evidence.map((e) => e.type).sort(), ['ci', 'clean', 'tests']);
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === r.reviewer), 'fixture reviewer did not exit');
  h.run(['wait', '--task', 'T1', '--timeout', '0.2']); // wait-allow: one reaction pass must not dispatch a second reviewer
  const dispatches = events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].detail.sha, h.sha);
  assert.equal(dispatches[0].detail.revision, 2);
  // The reviewer's packet carries the landed merge-tree diff whatever the prompt's length.
  const packet = fs.readFileSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`), 'utf8');
  assert.match(packet, /merged before its gates/);
  assert.match(packet, /## Diff[\s\S]*module.exports = 1/);
  assert.match(packet, new RegExp(`Base: ${h.base_sha}`));
  assert.equal(task(h).status, 'submitted');
  const cursor = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--agent', r.reviewer]);
  h.ok(['wait', '--task', 'T1', '--types', 'accepted', '--after', cursor, '--timeout', '300']);
  assert.equal(task(h).status, 'accepted');
});

test('each failed software gate opens one follow-up against main with no old PR, sha or branch', (t) => {
  for (const name of ['tests', 'clean', 'ci']) {
    const h = fixture(t);
    record(h);
    if (name === 'tests') h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"']);
    const r = h.run(['check', name, 'T1'], { env: { FIXTURE_GATE_OK: '0' } });
    assert.equal(r.code, 1);
    const original = task(h);
    const follow = task(h, original.hotfix.follow_up);
    assert.equal(original.status, 'cancelled');
    assert.equal(follow.status, 'rework');
    assert.equal(follow.hotfix_of, 'T1');
    assert.equal(follow.pr, null);
    assert.equal(follow.sha, null);
    assert.equal(follow.branch, null);
    assert.deepEqual(follow.acceptance, original.acceptance);
    assert.match(h.ok(['brief', 'get', follow.id]), /follow-up PR against main/);
    assert.match(h.ok(['brief', 'get', follow.id]), new RegExp(`${name} failed`));
    assert.match(h.ok(['brief', 'get', follow.id]), /Preserve the regression test/);
    h.run(['check', name, 'T1'], { env: { FIXTURE_GATE_OK: '0' } });
    assert.equal(h.readState('tasks.json').tasks.length, 2);
    assert.ok(h.json(['ready']).ready.some((r) => r.id === follow.id));
  }
});

test('failed independent review creates follow-up, stale or unspawned verdicts do not', (t) => {
  const h = fixture(t);
  record(h);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.sha, '--revision', '2', '--agent', 'unspawned']);
  assert.equal(task(h).status, 'submitted');
  h.reviewer('T1', 'stale', h.head);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.head, '--agent', 'stale']);
  assert.equal(task(h).status, 'submitted');
  verdict(h, false);
  assert.equal(task(h).status, 'cancelled');
  assert.match(h.ok(['brief', 'get', task(h).hotfix.follow_up]), /value.js:1 - repair the value/);
});

test('hotfix CI requires push run on main, and acceptance permits no gate waivers', (t) => {
  const h = fixture(t);
  record(h);
  const ci = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_EVENT: 'pull_request' } });
  assert.equal(ci.code, 1);
  assert.match(ci.stdout, /push workflow run was cancelled or never ran, and no successful push, scheduled or manual run/);
  assert.equal(task(h).status, 'submitted');
  const fresh = fixture(t);
  record(fresh);
  const r = fresh.run(['accept', 'T1', '--waive', 'review', '--reason', 'skip']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /hotfix acceptance requires every gate/);
});

test('a merge commit whose push run a newer push cancelled is accepted on the green run of a later main commit, recorded in evidence', (t) => {
  const h = fixture(t);
  record(h);
  // The later commit is red too: the hotfix waits, since a cancelled run judged nothing.
  const red = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_MERGE_RUN: 'cancelled', FIXTURE_GATE_OK: '0' } });
  assert.equal(red.code, 1);
  assert.equal(task(h).evidence.at(-1).pending, true);
  assert.equal(task(h).hotfix.follow_up, undefined);
  h.ok(['check', 'ci', 'T1'], { env: { FIXTURE_MERGE_RUN: 'cancelled' } });
  const ci = task(h).evidence.at(-1);
  assert.equal(ci.ok, true, ci.summary);
  assert.equal(ci.sha, h.sha);
  assert.deepEqual(ci.hotfix_ci, { merge_sha: h.sha, satisfied_by: { sha: h.later,
    runs: [{ id: 21, workflow: 'ci.yml', event: 'push', url: 'https://github.com/acme/demo/actions/runs/21' }] } });
  assert.match(ci.summary, new RegExp(`judged at ${h.later.slice(0, 10)} on main, which contains it`));
  const event = events(h).findLast((e) => e.cmd === 'check ci');
  assert.deepEqual(event.detail.hotfix_ci, ci.hotfix_ci);
  // A failed run at the merge commit itself is a verdict, whatever ran later.
  const failed = fixture(t);
  record(failed);
  const r = failed.run(['check', 'ci', 'T1'], { env: { FIXTURE_MERGE_RUN: 'failure' } });
  assert.equal(r.code, 1);
  assert.equal(task(failed).evidence.at(-1).confirmed_failure, true);
  assert.ok(task(failed).hotfix.follow_up);
});

test('a hotfix whose changed host-only test only skipped waits on tests.host_env in the inbox, without a follow-up', (t) => {
  const h = fixture(t);
  record(h);
  // The host run of the changed test reports one case, skipped for a missing opt-in.
  const skipper = path.join(h.base, 'tools', 'skip-live.js');
  fs.writeFileSync(skipper, ['TAP version 13', 'ok 1 - live probe # SKIP set FIXTURE_LIVE=1 to run the live probe', '1..1',
    '# tests 1', '# pass 0', '# fail 0', '# skipped 1'].map((l) => `console.log(${JSON.stringify(l)});`).join('\n'));
  h.ok(['project', 'set', '--tests-proof-cmd', `node ${shellQuote(skipper)} {tests}`, '--tests-host-only', '["test/value.test.js"]']);
  const r = h.run(['check', 'tests', 'T1']);
  assert.equal(r.code, 1);
  const tests = task(h).evidence.at(-1);
  assert.deepEqual(tests.config_failure, { key: 'tests_host_env' });
  assert.match(tests.summary, /test\/value\.test\.js: 0 ran, 1 skipped; skipped because: set FIXTURE_LIVE=1 to run the live probe/);
  assert.deepEqual(tests.receipt.host_only.results[0].skip_reasons, ['set FIXTURE_LIVE=1 to run the live probe']);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.setting, 'tests.host_env');
  assert.deepEqual(item.action.argv, ['project', 'set', '--tests-host-env', '<JSON>']);
  assert.equal(item.then, 'gates retry T1');
  assert.equal(task(h).status, 'submitted');
  assert.equal(task(h).hotfix.follow_up, undefined);
});

test('pending CI and observation errors keep the hotfix submitted and can be retried', (t) => {
  const h = fixture(t);
  record(h);
  for (const env of [{ FIXTURE_WORKFLOW_STATUS: 'in_progress' }, { FIXTURE_GH_ERROR: '1' }]) {
    const r = h.run(['check', 'ci', 'T1'], { env });
    assert.equal(r.code, 1);
    assert.equal(task(h).status, 'submitted');
    assert.equal(task(h).hotfix.follow_up, undefined);
    assert.equal(h.readState('tasks.json').tasks.length, 1);
  }
  assert.equal(task(h).evidence.find((e) => e.type === 'ci').pending, true);
  h.ok(['check', 'ci', 'T1']);
  assert.equal(task(h).evidence.at(-1).ok, true);
});

test('a test timeout stays retryable while insufficient proof opens follow-up rework', (t) => {
  const h = fixture(t);
  record(h);
  h.ok(['project', 'set', '--tests-cmd', 'node -e "setInterval(() => {}, 1000)"', '--tests-timeout-min', '0.001']);
  const timeout = h.run(['check', 'tests', 'T1']);
  assert.equal(timeout.code, 1);
  assert.equal(task(h).evidence.at(-1).infrastructure_failure, true);
  assert.equal(task(h).status, 'submitted');
  assert.equal(task(h).hotfix.follow_up, undefined);
  h.ok(['project', 'set', '--tests-cmd', 'node -e "0"', '--tests-timeout-min', '1']);
  const proof = h.run(['check', 'tests', 'T1']);
  assert.equal(proof.code, 1);
  assert.match(proof.stdout, /tests pass without the change/);
  assert.equal(task(h).evidence.at(-1).confirmed_failure, true);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h, task(h).hotfix.follow_up).status, 'rework');
});

const REVIEW_URL = 'https://github.com/acme/demo/pull/42#issuecomment-77';
const posted = (sha, verdict, blocking = 'None.') => `## Review (native, clean context)\n\nSHA: ${sha}\nVerdict: **${verdict}**\n\n### Acceptance\n1. holds.\n\n### Blocking findings\n${blocking}\n\n### Follow-ups (not blocking)\n- none\n`;

test('a natively merged todo task records from the PR merge commit and its posted review, then accept confirms the merge without merging again', (t) => {
  const h = fixture(t);
  h.ok(['task', 'add', '--title', 'Merged natively', '--acceptance', 'value becomes one']);
  assert.equal(task(h, 'T2').status, 'todo');
  const env = { FIXTURE_REVIEW_BODY: posted(h.head, 'pass') };
  const recorded = h.json(['hotfix', 'T2', '--pr', '42', '--review', REVIEW_URL], { env });
  assert.equal(recorded.status, 'submitted');
  assert.equal(recorded.sha, h.sha);
  const review = task(h, 'T2').evidence.find((e) => e.type === 'review');
  assert.equal(review.ok, true);
  assert.equal(review.sha, h.sha);
  assert.equal(review.ref, REVIEW_URL);
  assert.match(review.summary, /avifenesh/);
  assert.equal(review.author_association, 'OWNER');
  assert.ok(h.json(['task', 'show', 'T2']).gates.gates.find((g) => g.type === 'review').ok);
  const accepted = h.run(['accept', 'T2'], { env });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /accepted \(hotfix\) T2/);
  assert.match(accepted.stdout, /merge ok/);
  assert.equal(task(h, 'T2').status, 'accepted');
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0);
  const merge = task(h, 'T2').evidence.find((e) => e.type === 'merge');
  assert.equal(merge.ok, true);
  assert.equal(merge.sha, h.sha);
  assert.match(merge.summary, /nothing merged again/);
  assert.ok(events(h).some((e) => e.cmd === 'merge' && e.task === 'T2' && e.detail.ok === true));
  // Repeating the merge confirmation stays a confirmation.
  assert.equal(h.run(['merge', 'T2']).code, 0);
  // An accepted hotfix's merge stands; rework cannot cancel it.
  const rework = h.run(['rework', 'T2', '--reason', 'late finding']);
  assert.equal(rework.code, 1);
  assert.match(rework.stderr, /accepted hotfix/);
  assert.equal(task(h, 'T2').status, 'accepted');
  assert.equal(h.readState('tasks.json').tasks.length, 2);
});

test('a posted review with markdown bold labels records like the plain form', (t) => {
  const h = fixture(t);
  h.ok(['task', 'add', '--title', 'Merged natively', '--acceptance', 'value becomes one']);
  // Reviewers write their header lines in markdown: **SHA:** and **Verdict:** pass.
  const body = `## Review (native, clean context)\n\n**SHA:** ${h.head}\n**Verdict:** pass\n\n### Blocking findings\nNone.\n`;
  const recorded = h.json(['hotfix', 'T2', '--pr', '42', '--review', REVIEW_URL], { env: { FIXTURE_REVIEW_BODY: body } });
  assert.equal(recorded.status, 'submitted');
  const review = task(h, 'T2').evidence.find((e) => e.type === 'review');
  assert.equal(review.ok, true);
  assert.equal(review.sha, h.sha);
  const failing = body.replace('**Verdict:** pass', '**Verdict:** fail');
  h.ok(['task', 'add', '--title', 'Merged natively too', '--acceptance', 'value becomes one']);
  const r = h.run(['hotfix', 'T3', '--pr', '42', '--review', REVIEW_URL], { env: { FIXTURE_REVIEW_BODY: failing } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /follow-up T4/);
});

test('a failing posted review opens follow-up rework; a review of another head, another PR or without the review heading is refused', (t) => {
  const h = fixture(t);
  const cases = [
    [{ FIXTURE_REVIEW_BODY: posted('b'.repeat(40), 'pass') }, /reviewed b{7}.*omit --review/],
    [{ FIXTURE_REVIEW_BODY: posted(h.head, 'pass'), FIXTURE_REVIEW_PR: '43' }, /not on PR #42/],
    [{ FIXTURE_REVIEW_BODY: `Looks good\n\nSHA: ${h.head}\nVerdict: **pass**\n` }, /not a clean-context review/],
    [{ FIXTURE_REVIEW_BODY: `## Review (native, clean context)\n\nSHA: ${h.head}\n` }, /no verdict/],
    // Anyone can comment on a public repository; only the owner, members and collaborators review.
    [{ FIXTURE_REVIEW_BODY: posted(h.head, 'pass'), FIXTURE_REVIEW_LOGIN: 'drive-by', FIXTURE_REVIEW_ASSOC: 'NONE' }, /author_association NONE/],
    [{ FIXTURE_REVIEW_BODY: posted(h.head, 'pass'), FIXTURE_REVIEW_ASSOC: 'CONTRIBUTOR' }, /author_association CONTRIBUTOR/],
  ];
  for (const [env, message] of cases) {
    const r = h.run(['hotfix', 'T1', '--pr', '42', '--review', REVIEW_URL], { env });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, message);
    assert.equal(task(h).status, 'cancelled');
    assert.equal(task(h).hotfix, undefined);
  }
  // Workers and reviewers post as the same login, so the orchestrator names the exact review.
  const latest = h.run(['hotfix', 'T1', '--pr', '42', '--review', 'latest'], { env: { FIXTURE_REVIEW_BODY: posted(h.head, 'pass') } });
  assert.notEqual(latest.code, 0);
  assert.match(latest.stderr, /comment URL ending in #issuecomment-N, or the comment id/);
  assert.equal(task(h).hotfix, undefined);
  const r = h.run(['hotfix', 'T1', '--pr', '42', '--review', '77'],
    { env: { FIXTURE_REVIEW_BODY: posted(h.head, 'fail', '1. value.js:1 - the value is wrong - callers break') } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /follow-up T2/);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h).hotfix.follow_up, 'T2');
  assert.equal(task(h, 'T2').status, 'rework');
  assert.match(h.ok(['brief', 'get', 'T2']), /value.js:1 - the value is wrong/);
});

test('a multi-commit rebase merge is refused because its first parent is an earlier PR commit', (t) => {
  const h = fixture(t);
  h.git(['switch', '-c', 'rebased', h.base_sha]);
  const commits = [];
  for (const word of ['one', 'two']) {
    fs.writeFileSync(path.join(h.repo, `step-${word}.txt`), `${word}\n`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', `step ${word}`]);
    commits.push({ oid: h.git(['rev-parse', 'HEAD']), messageHeadline: `step ${word}`,
      authoredDate: new Date(Number(h.git(['log', '-1', '--format=%at'])) * 1000).toISOString() });
  }
  h.git(['switch', 'main']);
  const r = h.run(['hotfix', 'T1', '--pr', '42'], { env: { FIXTURE_MERGE_SHA: commits[1].oid, FIXTURE_PR_COMMITS: JSON.stringify(commits) } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /rebase merge/);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h).hotfix, undefined);
  // A one-commit PR lands on the base whether it was squashed or rebased.
  const single = h.json(['hotfix', 'T1', '--pr', '42'],
    { env: { FIXTURE_MERGE_SHA: commits[0].oid, FIXTURE_PR_COMMITS: JSON.stringify(commits.slice(0, 1)) } });
  assert.equal(single.status, 'submitted');
  assert.equal(single.hotfix.base_sha, h.base_sha);
});

// Main was red at the merge commit for reasons of its own: the CI gate failed the hotfix and opened a follow-up.
function falseFailure(h) {
  record(h);
  const r = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_MERGE_RUN: 'failure' } });
  assert.equal(r.code, 1);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h).hotfix.follow_up, 'T2');
  return task(h);
}

test('recording the same PR again supersedes a false-failure follow-up and lets accept take the new revision', (t) => {
  const h = fixture(t);
  const before = falseFailure(h);
  const refused = h.run(['hotfix', 'T1', '--pr', '42', '--sha', h.sha, '--agent', 'worker']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /orchestrator or owner/);
  assert.equal(task(h).status, 'cancelled');
  const r = h.run(['hotfix', 'T1', '--pr', '42', '--sha', h.sha, '--reason', 'main was red on Windows shards at the merge commit']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /re-recorded at .*follow-up T2 cancelled as superseded, revision 3/);
  const again = task(h);
  assert.equal(again.status, 'submitted');
  assert.equal(again.revision, before.revision + 1);
  assert.equal(again.sha, h.sha);
  assert.equal(again.hotfix.follow_up, undefined);
  assert.deepEqual(again.hotfix.superseded.map((s) => [s.follow_up, s.reason]), [['T2', 'main was red on Windows shards at the merge commit']]);
  const follow = task(h, 'T2');
  assert.equal(follow.status, 'cancelled');
  assert.equal(follow.superseded_by, 'T1');
  assert.match(follow.notes.at(-1).text, /Superseded by T1: main was red/);
  const recorded = events(h).filter((e) => e.cmd === 'hotfix' && e.task === 'T1');
  assert.equal(recorded.length, 2);
  assert.deepEqual([recorded[1].detail.revision, recorded[1].detail.previous_status, recorded[1].detail.superseded.follow_up], [3, 'cancelled', 'T2']);
  assert.ok(events(h).some((e) => e.cmd === 'hotfix supersede' && e.task === 'T2' && e.detail.superseded_by === 'T1'));
  // The old CI failure was at revision 2; repeating the record keeps the new revision and its receipts.
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci').ok, false);
  const repeated = record(h);
  assert.deepEqual([repeated.status, repeated.revision, repeated.hotfix], [again.status, again.revision, again.hotfix]);
  assert.equal(events(h).filter((e) => e.cmd === 'hotfix' && e.task === 'T1').length, 2);
  for (const name of ['tests', 'clean', 'ci']) h.ok(['check', name, 'T1']);
  verdict(h, true);
  assert.match(h.ok(['accept', 'T1']), /accepted \(hotfix\)/);
  assert.equal(task(h).status, 'accepted');
  assert.equal(h.readState('tasks.json').tasks.length, 2);
});

test('a re-record is refused while the follow-up is claimed or has work of its own', (t) => {
  const claimed = fixture(t);
  falseFailure(claimed);
  claimed.ok(['claim', 'T2', '--agent', 'w-1']);
  const r = claimed.run(['hotfix', 'T1', '--pr', '42', '--sha', claimed.sha]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /follow-up T2 is claimed/);
  assert.equal(task(claimed).status, 'cancelled');
  assert.equal(task(claimed, 'T2').status, 'in_progress');
  const worked = fixture(t);
  falseFailure(worked);
  const tasks = worked.readState('tasks.json');
  Object.assign(tasks.tasks.find((x) => x.id === 'T2'), { branch: 'tower-crane/T2-rework', sha: worked.head, pr: 43 });
  worked.writeState('tasks.json', tasks);
  const w = worked.run(['hotfix', 'T1', '--pr', '42', '--sha', worked.sha]);
  assert.equal(w.code, 1);
  assert.match(w.stderr, /follow-up T2 has its own work \(rework, PR #43, branch tower-crane\/T2-rework\)/);
  assert.equal(task(worked).status, 'cancelled');
  assert.equal(task(worked, 'T2').status, 'rework');
});

test('dropping a follow-up that carries an owner ask is owner-required', (t) => {
  const h = fixture(t);
  falseFailure(h);
  h.ok(['task', 'update', 'T2', '--needs-owner', 'owner decides: cancel or keep']);
  const args = ['hotfix', 'T1', '--pr', '42', '--sha', h.sha];
  const asked = h.run(args, { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.equal(asked.code, 1, asked.stdout);
  assert.match(asked.stderr, /task\.cancel_needs_owner is owner-required; opened D1/);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h, 'T2').status, 'rework');
  h.ok(args);
  assert.equal(task(h).status, 'submitted');
  assert.equal(task(h, 'T2').status, 'cancelled');
});

test('a hotfix test that also fails at the merge first parent is infrastructure; one the merge broke is its own even when main still fails', (t) => {
  const h = fixture(t);
  record(h);
  const shared = path.join(h.base, 'shared-failure.js');
  fs.writeFileSync(shared, "console.log('# Subtest: test/known.test.js');\nconsole.log('not ok 1 - known base failure');\nprocess.exit(1);\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(shared)}`, '--tests-mode', 'run-only']);
  const r = h.run(['check', 'tests', 'T1']);
  assert.equal(r.code, 1);
  const tests = task(h).evidence.at(-1);
  assert.equal(tests.infrastructure_failure, true);
  assert.equal(tests.confirmed_failure, undefined);
  assert.deepEqual(tests.main_failure, { base: h.base_sha.slice(0, 10), names: ['known base failure'] });
  assert.match(tests.summary, new RegExp(`Also fails on main at ${h.base_sha.slice(0, 10)}, the merge's first parent: known base failure. Infrastructure`));
  assert.equal(task(h).status, 'submitted');
  assert.equal(task(h).hotfix.follow_up, undefined);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_failed' && i.gate === 'tests');
  assert.equal(item.infrastructure_failure, true);
  assert.deepEqual(item.action.argv, ['check', 'tests', 'T1']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
  assert.equal(task(h).status, 'submitted');
  assert.equal(task(h).hotfix.follow_up, undefined);
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  // The merge broke this test, and main after the merge still fails it: the first parent passes, so it is the merge's.
  const broken = path.join(h.base, 'merge-broke.js');
  fs.writeFileSync(broken, "if (require(require('node:path').resolve('value.js')) === 1) { console.log('# Subtest: test/value.test.js');\nconsole.log('not ok 1 - value stays zero'); process.exit(1); }\n");
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(broken)}`]);
  const own = h.run(['check', 'tests', 'T1']);
  assert.equal(own.code, 1);
  assert.equal(task(h).status, 'cancelled');
  assert.equal(task(h, task(h).hotfix.follow_up).status, 'rework');
});
