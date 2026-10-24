'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const Reviews = require('../lib/review-findings');
const { fileWritten } = require('./signals');

const claim = (location = 'PR body', kind = 'false-claim') => ({ kind, path: location, claim: 'The claimed diagnostic is not printed.' });

test('only false claims confined to PR bodies and changelog prose qualify', () => {
  for (const [findings, expected] of [
    [[claim()], true],
    [[claim('changelog.d/T1.md')], true],
    [[claim('CHANGELOG.md')], true],
    [[claim(), claim('changelog.d/T1.md')], true],
    [[claim('PR title')], true],
    [[claim('PR labels')], false],
    [[claim('PR base text')], false],
    [[claim('PR linked issues')], false],
    [[claim('PR metadata', 'defect')], false],
    [[claim('PR title', 'acceptance')], true],
    [[claim('PR title'), claim()], true],
    [[claim('PR title'), claim('lib/value.js', 'defect')], false],
    [[claim('docs/cli.md')], false],
    [[claim('docs/state.md')], false],
    [[claim('README.md')], false],
    [[claim('lib/value.js')], false],
    [[claim('changelog.d/../docs/state.md')], false],
    [[claim('changelog.d/T1.md', 'defect')], false],
    [[claim('changelog.d/T1.md', 'security')], false],
    [[claim(), claim('lib/value.js', 'defect')], false],
    [[], false],
    [undefined, false],
  ]) assert.equal(Reviews.proseOnly(findings), expected, JSON.stringify(findings));
});

function setup(t, kind = 'docs') {
  return cachedFixture(t, `prose review ${kind}`, (h) => {
    h.init(['--base', 'main']);
    if (kind === 'code') gateFixture(h);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works', '--kind', kind,
      '--tier', kind === 'code' ? 'easy..medium' : 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the change.\n' });
    h.ok(['claim', 'T1', '--agent', 'worker']);
    fs.writeFileSync(path.join(h.repo, 'value.md'), 'The implementation works.\n');
    fs.mkdirSync(path.join(h.repo, 'changelog.d'));
    fs.writeFileSync(path.join(h.repo, 'changelog.d', 'T1.md'), 'The diagnostic is printed.\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'Change']);
    const sha = h.git(['rev-parse', 'HEAD']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    for (const tier of ['easy', 'medium', 'hard', 'research', 'review']) {
      h.ok(['ladder', 'set', tier, '--harness', 'command', '--clear', 'model', '--clear', 'profile',
        '--clear', 'provider', '--clear', 'effort',
        '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
    }
    return { sha };
  });
}

function fail(h, findings) {
  h.reviewer('T1', 'first-reviewer', h.sha);
  h.ok(['evidence', 'T1', '--agent', 'first-reviewer', '--type', 'review', '--fail', '--sha', h.sha,
    '--summary', '1 blocker: the diagnostic claim is false.', '--findings', JSON.stringify(findings)]);
}

// A task-bound worker identity, as a spawned worker has; --agent alone cannot claim it.
const bound = (agent) => ({ env: { TOWER_CRANE_AGENT: agent, TOWER_CRANE_TASK: 'T1' } });

// Sends a changelog failure back through review rework and resubmits a correction
// from a verified worker on the next revision.
function correctChangelog(h, text, options = {}) {
  const back = h.json(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  assert.equal(back.status, 'rework');
  assert.equal(back.revision, 2);
  const worker = 'worker-T1-2';
  assert.notEqual(h.run(['submit', 'T1', '--agent', 'worker', '--sha', h.sha], bound('worker')).code, 0,
    'the first worker cannot resubmit a reworked task without claiming it');
  h.ok(['claim', 'T1', '--agent', worker], bound(worker));
  fs.writeFileSync(path.join(h.repo, 'changelog.d', 'T1.md'), text);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'Correct changelog claim']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', worker, '--sha', sha], { ...bound(worker), ...options });
  return { worker, sha };
}

function prompt(h) {
  const preview = h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
  return { preview, text: preview.argv.find((arg) => arg.includes('## Task')) };
}

test('prose-only failure stays submitted and the reviewer checks the edited body at the same revision', (t) => {
  const h = setup(t);
  fail(h, [claim()]);
  const before = h.json(['task', 'show', 'T1']);
  assert.equal(before.gates.ok, false, 'a false prose claim still blocks acceptance until checked');
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_failed');
  assert.equal(item.prose_only, true);
  assert.deepEqual(item.action.argv, ['accept', 'T1']);
  const refused = h.run(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /edit.*carry review/);
  assert.equal(h.json(['task', 'show', 'T1']).revision, before.revision);
  const { preview, text } = prompt(h);
  assert.equal(preview.review_rung, 'easy', 'wording corrections do not escalate the review');
  assert.match(text, /## Light claim check/);
  assert.ok(text.includes(`git show ${h.sha}:<path>`));
  assert.doesNotMatch(text, /## Diff/);
  assert.match(text, /diagnostic claim is false/);
  assert.match(text, /first-reviewer/);

  const body = path.join(h.base, 'pr-body.md');
  fs.writeFileSync(body, 'The refused claim records a reason in state.\n');
  const output = path.join(h.base, 'light-prompt.md');
  const script = `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(${JSON.stringify(output)}, process.argv[1]);
if (!fs.readFileSync(${JSON.stringify(body)}, 'utf8').includes('records a reason in state')) process.exit(2);
const r = cp.spawnSync(process.execPath, ${JSON.stringify([BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--summary', 'Corrected claim checked.'])}, {env: fakeAgentEnv(process.env)});
process.exit(r.status ?? 1);`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}'])]);
  const cursor = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).review_pending, true);
  h.json(['wait', '--after', String(cursor), '--task', 'T1', '--types', 'evidence', '--timeout', '300']);
  assert.match(fs.readFileSync(output, 'utf8'), /## Light claim check/);
  const after = h.json(['task', 'show', 'T1']);
  assert.equal(after.tier, 'easy');
  assert.deepEqual(after.escalations || [], []);
  assert.equal(after.revision, before.revision);
  assert.equal(after.sha, before.sha);
  assert.equal(after.gates.ok, true);
  if (after.status === 'submitted') assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).status, 'accepted');
  else assert.equal(after.status, 'accepted');
});

test('body-only correction keeps passing software gates and does not escalate ranged workers', (t) => {
  const h = setup(t, 'code');
  gateEvidence(h, 'tests', 'checker');
  gateEvidence(h, 'clean', 'checker');
  const before = h.json(['task', 'show', 'T1']);
  fail(h, [claim()]);
  const after = h.json(['task', 'show', 'T1']);
  assert.equal(after.tier, 'easy');
  assert.deepEqual(after.escalations || [], []);
  assert.deepEqual(after.evidence.filter((e) => ['tests', 'clean'].includes(e.type)), before.evidence);
  assert.deepEqual(after.gates.gates.filter((g) => !g.ok).map((g) => g.type), ['review']);
  assert.equal(prompt(h).preview.review_rung, 'easy');
});

test('automatic reactions do not repeat a light check before the body is corrected', (t) => {
  const h = setup(t);
  const at = new Date().toISOString();
  const file = path.join(h.state, 'events.jsonl');
  fs.appendFileSync(file, [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1',
      detail: { agent: 'worker', role: 'worker', pid: 999999, attempt: 1 } },
    { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1',
      detail: { agent: 'worker', role: 'worker', pid: 999999, attempt: 1, code: 0, sha: h.sha, revision: 1 } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  fail(h, [claim()]);
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const reactions = events.filter((e) => e.cmd === 'automation' && e.detail.phase !== 'running');
  assert.ok(reactions.length, 'the observer completed an automatic reaction');
  // Automatic rework would refuse prose-only findings; the reaction leaves the task for its correction.
  assert.deepEqual(reactions.filter((e) => e.detail.error), []);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
});

test('a changelog correction carries review; an additional implementation change needs review', (t) => {
  const h = setup(t);
  fail(h, [claim('changelog.d/T1.md')]);
  const { worker } = correctChangelog(h, 'The diagnostic reason is recorded in state.\n');
  const corrected = h.json(['task', 'show', 'T1']);
  const review = corrected.evidence.findLast((e) => e.type === 'review');
  assert.equal(review.reviewed_head, h.sha);
  assert.equal(review.receipt.reason, 'fix round');
  assert.equal(corrected.gates.ok, true);
  assert.deepEqual(h.json(['status']).waiting_on.review, []);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'Change implementation']);
  h.ok(['submit', 'T1', '--agent', worker, '--sha', h.git(['rev-parse', 'HEAD'])], bound(worker));
  const text = prompt(h).text;
  assert.doesNotMatch(text, /## Light claim check/);
  assert.match(text, /## Diff/);
});

test('a small docs correction carries review even when the whole PR has risk paths', (t) => {
  const h = setup(t);
  h.git(['checkout', '-qb', 'change']);
  h.git(['branch', '-f', 'main', 'HEAD~1']);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ risk_paths: ['value.md'] })]);
  assert.equal(prompt(h).preview.review_rung, 'hard');
  fail(h, [claim('changelog.d/T1.md')]);
  correctChangelog(h, 'The diagnostic reason is recorded in state.\n');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  assert.deepEqual(h.json(['status']).waiting_on.review, []);
});

test('a late review of an older head at the reworked revision cannot select the light path', (t) => {
  const h = setup(t);
  fail(h, [claim('changelog.d/T1.md')]);
  const commit = (text) => {
    fs.writeFileSync(path.join(h.repo, 'changelog.d', 'T1.md'), text);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'Change changelog']);
    return h.git(['rev-parse', 'HEAD']);
  };
  // The submitter replaces the head at revision 1; that head fails, and a reviewer
  // of the first head records its verdict after it.
  const second = commit('The reason is printed.\n');
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', second], bound('worker'));
  h.reviewer('T1', 'second-reviewer', second);
  h.reviewer('T1', 'late-reviewer', h.sha);
  h.ok(['evidence', 'T1', '--agent', 'second-reviewer', '--type', 'review', '--fail', '--sha', second,
    '--summary', '1 blocker: the changelog claim is false.', '--findings', JSON.stringify([claim('changelog.d/T1.md')])]);
  h.ok(['evidence', 'T1', '--agent', 'late-reviewer', '--type', 'review', '--fail', '--sha', h.sha, '--revision', '1',
    '--summary', '1 blocker: the changelog claim is false.', '--findings', JSON.stringify([claim('changelog.d/T1.md')])]);
  const back = h.json(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  assert.equal(back.revision, 2);
  h.ok(['task', 'note', 'T1', 'Limit the correction to the currently submitted changelog claim',
    '--kind', 'scope-ruling', '--agent', 'orchestrator']);
  const worker = 'worker-T1-2';
  h.ok(['claim', 'T1', '--agent', worker], bound(worker));
  h.ok(['submit', 'T1', '--agent', worker, '--sha', commit('The reason is recorded in state.\n')], bound(worker));
  // The latest revision-1 verdict reviewed the first head, not the one rework sent back.
  assert.doesNotMatch(prompt(h).text, /## Light claim check/);
});

test('changelog carryover reads its diffs outside the submit state lock', (t) => {
  const h = setup(t);
  fail(h, [claim('changelog.d/T1.md')]);
  const report = path.join(h.base, 'diff-calls.jsonl');
  correctChangelog(h, 'The reason is recorded in state.\n', { hooks: { HOOK_REVIEW_DIFF_REPORT: report } });
  const calls = fs.readFileSync(report, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, Array.from({ length: 5 }, () => ({ locked: false })));
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});

test('a newer verdict between preparation and spawn refuses the stale light packet', async (t) => {
  const h = setup(t);
  fail(h, [claim()]);
  const paused = path.join(h.base, 'worktree-ready');
  const running = h.runAsync(['spawn', '--task', 'T1', '--role', 'review', '--wait'], {
    hooks: { HOOK_STOP_WORKTREE_ADD: paused },
  });
  try {
    await fileWritten(paused);
    assert.ok(!fs.existsSync(path.join(h.state, 'lock')));
    h.ok(['evidence', 'T1', '--agent', 'first-reviewer', '--type', 'review', '--fail', '--sha', h.sha,
      '--summary', 'A second body claim also blocks.', '--findings', JSON.stringify([claim(), { ...claim(), claim: 'The retry is logged.' }])]);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  const result = await running;
  assert.equal(result.code, 1, result.stderr);
  // The review scope check or the light snapshot check refuses, whichever runs first.
  assert.match(result.stderr, /(review scope changed after diff preparation|review changed after light-check preparation); retry review dispatch/);
  assert.ok(!fs.existsSync(path.join(h.state, 'reviews', `T1-${h.sha}.md`)), 'no review packet is written');
});

test('contract claims and mixed blockers keep the ordinary rework path', (t) => {
  const h = setup(t);
  fail(h, [claim(), claim('docs/state.md')]);
  assert.doesNotMatch(prompt(h).text, /## Light claim check/);
  const rework = h.json(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  assert.equal(rework.status, 'rework');
  assert.equal(rework.revision, 2);
});

test('an explicit new revision cannot reuse the old prose-only classification', (t) => {
  const h = setup(t);
  fail(h, [claim('changelog.d/T1.md')]);
  h.ok(['rework', 'T1', '--reason', 'Acceptance needs another check', '--agent', 'orchestrator']);
  const worker = 'worker-T1-2';
  h.ok(['claim', 'T1', '--agent', worker], bound(worker));
  fs.writeFileSync(path.join(h.repo, 'changelog.d', 'T1.md'), 'The reason is recorded in state.\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'Correct claim']);
  h.ok(['submit', 'T1', '--agent', worker, '--sha', h.git(['rev-parse', 'HEAD'])], bound(worker));
  assert.doesNotMatch(prompt(h).text, /## Light claim check/);
});

test('finding metadata is validated and only failed reviews may supply it', (t) => {
  const h = setup(t);
  for (const findings of ['null', '{}', '[]', '[{"kind":"false-claim","path":"PR body"}]']) {
    assert.equal(h.run(['evidence', 'T1', '--agent', 'owner', '--revision', '1', '--type', 'review',
      '--fail', '--sha', h.sha, '--findings', findings]).code, 2, findings);
  }
  assert.equal(h.run(['evidence', 'T1', '--agent', 'owner', '--revision', '1', '--type', 'review',
    '--ok', '--sha', h.sha, '--findings', JSON.stringify([claim()])]).code, 2);
});
