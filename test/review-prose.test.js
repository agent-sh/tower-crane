'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const Reviews = require('../lib/review-findings');

const claim = (location = 'PR body', kind = 'false-claim') => ({ kind, path: location, claim: 'The claimed diagnostic is not printed.' });

test('only false claims confined to PR bodies and changelog prose qualify', () => {
  for (const [findings, expected] of [
    [[claim()], true],
    [[claim('changelog.d/T1.md')], true],
    [[claim('CHANGELOG.md')], true],
    [[claim(), claim('changelog.d/T1.md')], true],
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
  assert.match(refused.stderr, /edit.*light check/);
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
  const script = `const fs = require('node:fs'); const cp = require('node:child_process');
fs.writeFileSync(${JSON.stringify(output)}, process.argv[1]);
if (!fs.readFileSync(${JSON.stringify(body)}, 'utf8').includes('records a reason in state')) process.exit(2);
const r = cp.spawnSync(process.execPath, ${JSON.stringify([BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--summary', 'Corrected claim checked.'])}, {env: process.env});
process.exit(r.status ?? 1);`;
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}'])]);
  const cursor = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).review_pending, true);
  h.json(['wait', '--after', String(cursor), '--task', 'T1', '--types', 'evidence', '--timeout', '30']);
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
  assert.ok(events.some((e) => e.cmd === 'automation' && e.detail.phase !== 'running'),
    'the observer completed an automatic reaction');
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
});

test('a changelog correction gets a light check but an implementation change gets the full diff', (t) => {
  const h = setup(t);
  fail(h, [claim('changelog.d/T1.md')]);
  fs.writeFileSync(path.join(h.repo, 'changelog.d', 'T1.md'), 'The diagnostic reason is recorded in state.\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'Correct changelog claim']);
  let sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha]);
  let review = prompt(h).text;
  assert.match(review, /## Light claim check/);
  assert.match(review, /## Claim correction diff/);
  assert.match(review, /diagnostic reason is recorded/);
  assert.doesNotMatch(review, /## Diff/);
  assert.equal(h.json(['task', 'show', 'T1']).revision, 1);
  fs.writeFileSync(path.join(h.repo, 'value.md'), 'A new implementation.\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'Change implementation']);
  sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha]);
  review = prompt(h).text;
  assert.doesNotMatch(review, /## Light claim check/);
  assert.match(review, /## Diff/);
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
  fail(h, [claim()]);
  h.ok(['rework', 'T1', '--reason', 'Acceptance needs another check', '--agent', 'orchestrator']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha]);
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
