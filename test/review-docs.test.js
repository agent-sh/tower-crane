'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, makeRepo } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

function setup(t) {
  return cachedFixture(t, 'passing-review', (h) => {
    const reviewed = gateFixture(h);
    h.init(['--base', 'main']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'value becomes one']);
    h.ok(['claim', 'T1', '--agent', 'builder']);
    h.ok(['submit', 'T1', '--sha', reviewed, '--agent', 'builder']);
    gateEvidence(h, 'tests', 'gates');
    gateEvidence(h, 'clean', 'gates');
    h.reviewer('T1', 'reviewer', reviewed);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', reviewed,
      '--revision', '1', '--agent', 'reviewer', '--summary', 'value checked']);
    return { reviewed };
  });
}

function change(h, files) {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
    fs.appendFileSync(path.join(h.repo, file), '\nChanged.\n');
  }
  h.git(['add', ...files]);
  h.git(['commit', '-q', '-m', 'change files']);
  return h.git(['rev-parse', 'HEAD']);
}

test('docs-only resubmissions keep review while code and agent instructions queue review', (t) => {
  for (const [files, carried] of [
    [['docs/state.md', 'README.md', 'changelog.d/change.txt'], true],
    [['lib/value.js'], false],
    [['docs/state.md', 'lib/value.js'], false],
    [['skills/example/SKILL.md'], false],
    [['agents/example.md'], false],
  ]) {
    const h = setup(t);
    const sha = change(h, files);
    const submitted = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
    const report = h.json(['task', 'show', 'T1']).gates.gates;
    assert.equal(report.find((g) => g.type === 'review').ok, carried, files.join(', '));
    assert.equal(report.find((g) => g.type === 'tests').ok, carried);
    assert.equal(report.find((g) => g.type === 'clean').ok, false);
    if (carried) {
      const review = submitted.evidence.at(-1);
      assert.equal(review.type, 'review');
      assert.equal(review.carried_from.sha, h.reviewed);
      assert.equal(review.carried_from.agent, 'reviewer');
      assert.equal(review.sha, sha);
      assert.match(review.summary, /docs only/);
      assert.deepEqual(review.receipt.files.sort(), [...files].sort());
    }
    if (!carried) gateEvidence(h, 'tests', 'gates');
    gateEvidence(h, 'clean', 'gates');
    if (carried) h.ok(['check', 'docs', 'T1']);
    assert.deepEqual(h.json(['status']).waiting_on.review, carried ? [] : ['T1']);
    if (carried) {
      h.ok(['accept', 'T1']);
      assert.equal(h.json(['task', 'show', 'T1']).status, 'accepted');
    }
  }
});

test('docs carryover survives rework and repeated submissions and names the original review', (t) => {
  const h = setup(t);
  h.ok(['rework', 'T1', '--reason', 'resolve documentation conflict']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  for (const file of ['docs/state.md', 'docs/cli.md']) {
    const sha = change(h, [file]);
    const task = h.json(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
    assert.equal(task.evidence.at(-1).reviewed_head, h.reviewed);
    assert.equal(task.evidence.at(-1).revision, 2);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, true);
  }
});

test('review docs paths are configurable and exclude agent instructions', (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--review-policy', '{"docs_paths":["manual/**","skills/**","agents/**"]}']);
  const sha = change(h, ['manual/guide.txt']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, true);
  const next = change(h, ['README.md']);
  h.ok(['submit', 'T1', '--sha', next, '--agent', 'builder']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false);
});

test('requirements edits and a later failed review prevent docs carryover', (t) => {
  for (const edit of ['brief', 'acceptance', 'failed-review']) {
    const h = setup(t);
    if (edit === 'brief') h.ok(['brief', 'set', 'T1', '-'], { input: 'New requirements.' });
    if (edit === 'acceptance') h.ok(['task', 'update', 'T1', '--acceptance', 'new requirements']);
    if (edit === 'failed-review') h.ok(['evidence', 'T1', '--type', 'review', '--fail',
      '--sha', h.reviewed, '--revision', '1', '--agent', 'reviewer', '--summary', 'docs/state.md:1 needs correction',
      '--findings', '[{"kind":"important","path":"docs/state.md","claim":"needs correction"}]']);
    const sha = change(h, ['docs/state.md']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false, edit);
  }
});

test('docs path matching covers nested markdown and refuses mixed and instruction changes', () => {
  const R = require('../lib/review-carry');
  for (const [files, expected] of [
    [['README.md'], true], [['lib/notes.md'], true], [['docs/image.png'], true],
    [['changelog.d/item.txt'], true], [['skills/SKILL.md'], false],
    [['skills/nested/README.md'], false], [['agents/reviewer.md'], false],
    [['prompts/review.md'], false],
    [['docs/guide.md', 'lib/code.js'], false], [[], false],
  ]) assert.equal(R.docsOnly(files, R.docsPaths({})), expected, files.join(', '));
  for (const [files, expected] of [
    [['manual/guide.txt'], true], [['README.md'], false], [['skills/SKILL.md'], false],
    [['agents/reviewer.md'], false],
  ]) assert.equal(R.docsOnly(files, ['manual/**', 'skills/**', 'agents/**']), expected, files.join(', '));
  assert.equal(R.docsOnly(['docs/guide.md'], []), false);
  assert.equal(R.docsOnly(['docs/contracts/pinned.md'], R.docsPaths({}), ['docs/contracts/**']), false);
});

test('a fresh docs-only tests gate runs only the optional cheap docs check', (t) => {
  const h = makeRepo(t);
  h.init(['--base', 'main']);
  h.git(['checkout', '-qb', 'docs-change']);
  const sha = change(h, ['docs/guide.md']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'guide reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  const sentinel = path.join(h.base, 'docs-checked');
  const command = `node -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'checked')`)}`;
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(99)"', '--docs-cmd', command]);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  h.ok(['check', 'tests', 'T1']);
  const evidence = h.json(['task', 'show', 'T1']).evidence.at(-1);
  assert.equal(evidence.ok, true);
  assert.match(evidence.summary, /docs only; no suite ran/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'checked');
  assert.ok(!evidence.commands.some((c) => c.command.includes('exit(99)')));
  h.ok(['project', 'set', '--review-policy', '{"docs_exclude":["docs/guide.md"]}']);
  const failed = h.run(['check', 'tests', 'T1']);
  assert.equal(failed.code, 1, failed.stdout);
});

function failedReview(h, findings) {
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.reviewed,
    '--revision', '1', '--agent', 'reviewer', '--summary', 'Named corrections',
    '--findings', JSON.stringify(findings)]);
}

test('a named nit fix carries review and tests; an extra code edit or important docs finding does not', (t) => {
  for (const variant of ['nit', 'extra-code', 'important-docs', 'prompts']) {
    const h = setup(t);
    const findings = variant === 'important-docs'
      ? [{ kind: 'important', path: 'docs/state.md', claim: 'Rewrite the state contract' }]
      : [{ kind: 'nit', path: 'value.js', line: 1, claim: 'Remove spaces around the assignment' }];
    failedReview(h, findings);
    let sha;
    if (variant === 'important-docs') sha = change(h, ['docs/state.md']);
    else if (variant === 'prompts') sha = change(h, ['prompts/review.md']);
    else {
      fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports=1;\n');
      if (variant === 'extra-code') fs.writeFileSync(path.join(h.repo, 'extra.js'), 'module.exports = 2;\n');
      h.git(['add', '.']);
      h.git(['commit', '-qm', 'named nit']);
      sha = h.git(['rev-parse', 'HEAD']);
    }
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
    const gates = h.json(['task', 'show', 'T1']).gates.gates;
    for (const type of ['tests', 'review']) assert.equal(gates.find((g) => g.type === type).ok,
      variant === 'nit', `${variant}: ${type}`);
  }
});

test('disputed findings stay unchanged and become informational inbox items', (t) => {
  const h = setup(t);
  failedReview(h, [{ kind: 'blocking', path: 'value.js', line: 1, claim: 'Return zero' }]);
  const disputes = '[{"finding":1,"reason":"The acceptance requires one; the code already returns one."}]';
  h.ok(['submit', 'T1', '--sha', h.reviewed, '--disputes', disputes, '--agent', 'builder']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.gates.gates.find((g) => g.type === 'review').ok, true);
  assert.equal(task.evidence.at(-1).receipt.disputes[0].finding, 1);
  const info = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_dispute');
  assert.equal(info.informational, true);
  assert.match(info.disputes[0].reason, /acceptance requires one/);
  const sha = change(h, ['value.js']);
  const refused = h.run(['submit', 'T1', '--sha', sha, '--disputes', disputes, '--agent', 'builder']);
  assert.equal(refused.code, 1);
});

test('only orchestrator or owner can attest an exact named code fix', (t) => {
  const h = setup(t);
  failedReview(h, [{ kind: 'blocking', path: 'value.js', line: 1, claim: 'Remove spaces around the assignment' }]);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports=1;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'exact named fix']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  const args = ['accept', 'T1', '--attest-fix', h.reviewed, '--reason', 'Applied only the named assignment formatting'];
  assert.equal(h.run([...args, '--agent', 'builder']).code, 1);
  h.ok([...args, '--agent', 'orchestrator']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'accepted');
  const carried = task.evidence.findLast((e) => e.type === 'review');
  assert.equal(carried.receipt.reason, 'attestation');
  assert.equal(carried.receipt.attestation.by, 'orchestrator');
  assert.match(carried.receipt.diff_sha256, /^[a-f0-9]{64}$/);
});

test('followups-only reviews and corrected title/body findings need no review round', (t) => {
  for (const mode of ['followups', 'PR title', 'PR body']) {
    const h = setup(t);
    if (mode === 'followups') h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', h.reviewed,
      '--revision', '1', '--agent', 'reviewer', '--followups-only', '--summary', 'Follow-up only']);
    else failedReview(h, [{ kind: 'title-body-fix', path: mode, claim: 'Use the accurate description' }]);
    h.ok(['accept', 'T1', ...(mode === 'followups' ? [] : ['--metadata-fixed', '--reason', 'Corrected the description'])]);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.status, 'accepted');
    assert.equal(task.evidence.findLast((e) => e.type === 'review').receipt.reason, 'title or body only');
  }
});

test('docs carryover retains local CI without running its suite again', (t) => {
  for (const [file, carried] of [['docs/state.md', true], ['lib/extra.js', false]]) {
    const h = setup(t);
    const runs = path.join(h.base, 'ci-runs');
    h.ok(['project', 'set', '--repo', 'acme/demo', '--ci-local', JSON.stringify({
      command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n')`],
      timeout: 60, rerun: false,
    })]);
    h.ok(['submit', 'T1', '--sha', h.reviewed, '--branch', 'fixture-change', '--pr', '7', '--agent', 'builder']);
    h.ok(['check', 'ci', 'T1']);
    const sha = change(h, [file]);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.gates.gates.find((g) => g.type === 'ci').ok, carried);
    if (carried) h.ok(['accept', 'T1']);
    else h.ok(['check', 'ci', 'T1']);
    assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, carried ? 1 : 2);
  }
});

test('a failed cheap docs command blocks a docs-only tests pass', (t) => {
  const h = makeRepo(t);
  h.init(['--base', 'main']);
  h.git(['checkout', '-qb', 'docs-change']);
  const sha = change(h, ['README.md']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'readme is accurate']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['project', 'set', '--docs-cmd', 'node -e "process.exit(12)"']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  assert.equal(h.run(['check', 'tests', 'T1']).code, 1);
  const evidence = h.json(['task', 'show', 'T1']).evidence.at(-1);
  assert.equal(evidence.ok, false);
  assert.ok(evidence.receipt.docs_only);
});

test('accept records a docs-only tests pass without a pinned suite command', (t) => {
  const h = makeRepo(t);
  const clean = `${shellQuote(process.execPath)} -e ${shellQuote('console.log(JSON.stringify({items:[]}))')}`;
  h.env.TOWER_CRANE_CLEAN_CMD = clean;
  h.init(['--base', 'main', '--clean-cmd', clean]);
  h.git(['checkout', '-qb', 'docs-change']);
  const sha = change(h, ['docs/guide.md']);
  h.ok(['task', 'add', '--title', 'Docs change', '--acceptance', 'guide is accurate']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '1', '--agent', 'reviewer']);
  h.ok(['accept', 'T1']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'accepted');
  assert.match(task.evidence.findLast((e) => e.type === 'tests').summary, /docs only; no suite ran/);
});

test('named nit hunks fail closed outside their ranges and for binary or mode-only code', () => {
  const R = require('../lib/review-carry');
  const rules = { docs_paths: R.docsPaths({}), docs_exclude: [] };
  const findings = [{ kind: 'nit', path: 'lib/value.js', line: 2, claim: 'Fix this return' }];
  const patch = (oldLine, oldCount = 1, newCount = 1) =>
    `--- a/lib/value.js\n+++ b/lib/value.js\n@@ -${oldLine},${oldCount} +2,${newCount} @@\n-old\n+new\n`;
  for (const [files, diff, expected] of [
    [['lib/value.js'], patch(2), true],
    [['lib/value.js'], patch(3), false],
    [['lib/value.js'], patch(2, 2), false],
    [['lib/value.js'], patch(2, 1, 2), false],
    [['lib/value.js', 'lib/other.js'], patch(2), false],
    [['lib/value.js'], 'Binary files a/lib/value.js and b/lib/value.js differ', false],
    [['lib/value.js'], 'old mode 100644\nnew mode 100755\n', false],
    [['lib/value.js'], `old mode 100644\nnew mode 100755\n${patch(2)}`, false],
    [['prompts/rules.md'], patch(2), false],
  ]) assert.equal(R.namedFixes(files, diff, findings, rules), expected, diff);
});

test('a late review of an older head cannot override important findings on a newer head', (t) => {
  const h = setup(t);
  const second = change(h, ['docs/state.md']);
  h.ok(['submit', 'T1', '--sha', second, '--agent', 'builder']);
  h.reviewer('T1', 'new-reviewer', second);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', second, '--revision', '1',
    '--agent', 'new-reviewer', '--summary', 'Important state contract correction',
    '--findings', '[{"kind":"important","path":"docs/state.md","claim":"Correct the substantive contract"}]']);
  h.reviewer('T1', 'late-reviewer', h.reviewed);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.reviewed, '--revision', '1', '--agent', 'late-reviewer']);
  const third = change(h, ['docs/state.md']);
  h.ok(['submit', 'T1', '--sha', third, '--agent', 'builder']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false);
});

test('each undisputed finding needs its own correction before gates carry', () => {
  const R = require('../lib/review-carry');
  const rules = { docs_paths: R.docsPaths({}), docs_exclude: [] };
  const nit = (line = 1, file = 'value.js') => ({ kind: 'nit', path: file, line, claim: 'Fix this line' });
  const doc = (file = 'docs/state.md') => ({ kind: 'doc-fix', path: file, claim: 'Correct this statement' });
  const meta = (file) => ({ kind: 'title-body-fix', path: file, claim: 'Correct the description' });
  const patch = (line = 1, file = 'value.js') =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${line} +${line} @@\n-old\n+new\n`;
  const dispute = (finding) => [{ finding, reason: 'The reported behavior is already correct' }];
  const cases = [
    ['reported docs-only omission', ['docs/state.md'], '', [nit()], [], false, false],
    ['second code file omitted', ['value.js'], patch(), [nit(), nit(1, 'other.js')], [], false, false],
    ['second range omitted', ['value.js'], patch(), [nit(), nit(3)], [], false, false],
    ['both ranges fixed', ['value.js'], patch() + patch(3), [nit(), nit(3)], [], false, true],
    ['overlapping finding ranges fixed', ['value.js'], patch(), [nit(), { ...nit(), end_line: 2 }], [], false, true],
    ['docs finding omitted', ['README.md'], '', [doc()], [], false, false],
    ['second docs finding omitted', ['docs/state.md'], '', [doc(), doc('docs/cli.md')], [], false, false],
    ['docs finding fixed', ['docs/state.md'], '', [doc()], [], false, true],
    ['omitted code disputed', ['docs/state.md'], '', [nit()], dispute(1), false, true],
    ['changed code cannot be disputed', ['value.js'], patch(), [nit()], dispute(1), false, false],
    ['omitted docs disputed', ['README.md'], '', [doc()], dispute(1), false, true],
    ['title unverified', ['docs/state.md'], '', [meta('PR title')], [], false, false],
    ['body unverified', [], '', [meta('PR body')], [], false, false],
    ['metadata verified', [], '', [meta('PR title'), meta('PR body')], [], true, true],
    ['metadata disputed', [], '', [meta('PR body')], dispute(1), false, true],
    ['mixed metadata unverified', ['value.js'], patch(), [nit(), meta('PR body')], [], false, false],
    ['mixed metadata verified', ['value.js'], patch(), [nit(), meta('PR body')], [], true, true],
  ];
  for (const [name, files, diff, findings, disputes, metadata, expected] of cases) {
    assert.equal(R.namedFixes(files, diff, findings, rules, disputes, false, metadata), expected, name);
  }
  for (const [name, files, diff, findings, expected] of [
    ['attestation with omitted code', ['value.js'], patch(), [nit(), nit(1, 'other.js')], false],
    ['attestation with omitted docs', ['value.js'], patch(), [nit(), doc()], false],
    ['attestation with unverified body', ['value.js'], patch(), [nit(), meta('PR body')], false],
    ['complete attested code fix', ['value.js'], patch(), [nit()], true],
  ]) assert.equal(R.namedFixes(files, diff, findings, rules, [], true), expected, name);
});

test('submit refuses to carry an omitted nit even when other docs were corrected', (t) => {
  const h = setup(t);
  failedReview(h, [
    { kind: 'nit', path: 'value.js', line: 1, claim: 'Remove assignment spaces' },
    { kind: 'doc-fix', path: 'docs/state.md', claim: 'Correct the statement' },
  ]);
  const sha = change(h, ['docs/state.md']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  const task = h.json(['task', 'show', 'T1']);
  for (const type of ['review', 'tests']) assert.equal(task.gates.gates.find((g) => g.type === type).ok, false, type);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder',
    '--disputes', '[{"finding":1,"reason":"The assignment formatting is already accepted."}]']);
  const disputed = h.json(['task', 'show', 'T1']);
  assert.equal(disputed.gates.gates.find((g) => g.type === 'review').ok, true);
  assert.ok(h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.kind === 'review_dispute'));
});

test('a mixed code and metadata fix waits for verified metadata correction', (t) => {
  const h = setup(t);
  failedReview(h, [
    { kind: 'nit', path: 'value.js', line: 1, claim: 'Remove assignment spaces' },
    { kind: 'title-body-fix', path: 'PR body', claim: 'Correct the description' },
  ]);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports=1;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'Fix the named nit']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'builder']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review').ok, false);
  h.ok(['accept', 'T1', '--metadata-fixed', '--reason', 'Corrected the body and the named code nit']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'accepted');
  assert.equal(task.evidence.findLast((e) => e.type === 'tests').source, 'gate carry');
});
