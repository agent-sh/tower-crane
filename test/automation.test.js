'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitOnRepo, waitUntil } = require('./signals');
const { BIN, cachedFixture } = require('./helpers');
const { readPublished } = require('./atomic-file');
const { gateEvidence } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { setup, holdSuite, configureHarness } = require('./automation-helpers');

const OWNER = path.join(__dirname, 'fixtures', 'pr-owner.js');

function generatedSetup(t) {
  const h = cachedFixture(t, 'generated-conflicts', (repo) => {
    const h = setup(null, { repo });
    h.git(['switch', 'main']);
    fs.mkdirSync(path.join(h.repo, 'docs'));
    fs.writeFileSync(path.join(h.repo, 'left.txt'), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'right.txt'), 'base\n');
    fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({
      scripts: { 'docs:generate': 'node generate.js' },
      'tower-crane': { generated: {
        'docs/cli.md': { script: 'docs:generate', blocks: ['commands:Run'] },
        'generated.txt': 'docs:generate',
      } },
    }));
    fs.writeFileSync(path.join(h.repo, 'generate.js'), `const fs = require('node:fs');
const rows = fs.readFileSync('left.txt', 'utf8').trim() + ' / ' + fs.readFileSync('right.txt', 'utf8').trim();
const file = 'docs/cli.md';
const text = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, text.replace(/(<!-- commands:Run:start -->)[\\s\\S]*?(<!-- commands:Run:end -->)/, '$1\\n' + rows + '\\n$2'));
fs.writeFileSync('generated.txt', rows + '\\n');
`);
    const doc = (rows, intro = 'Hand-written intro.') => `${intro}\n\n<!-- commands:Run:start -->\n${rows}\n<!-- commands:Run:end -->\n`;
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('base / base'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'base / base\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'declare generated outputs']);
    const declared = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', declared]);
    fs.writeFileSync(path.join(h.repo, 'left.txt'), 'branch\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('branch / base'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'branch generated rows']);
    const sha = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'right.txt'), 'main\n');
    fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'), doc('base / main'));
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'base / main\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main generated rows']);
    const baseTip = h.git(['rev-parse', 'HEAD']);
    const remote = path.join(h.base, 'origin.git');
    h.git(['init', '--bare', remote]);
    h.git(['remote', 'set-url', 'origin', remote]);
    h.git(['push', 'origin', 'main', 'fixture-change']);
    h.git(['switch', 'fixture-change']);
    const state = h.github();
    state.remote = remote;
    state.ci = { [sha]: 'pending' };
    Object.assign(state.prs['7'], { headRefOid: sha, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    h.saveGithub(state);
    return { sha, baseTip, remote };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = () => {
    h.ok(['project', 'set', '--paused', 'manual generated conflict probe']);
    return h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  };
  h.submit = () => {
    h.ok(['claim', 'T1', '--agent', 'worker']);
    // A worker's submit refuses failing CI (T149) and these tests judge CI only in the gates, so the head is submitted while GitHub reads it green and mergeable; the test's state returns before any reaction runs.
    const before = h.github();
    const ciAtSubmit = before.ci[h.sha];
    const mergeAtSubmit = { mergeable: before.prs['7'].mergeable, mergeStateStatus: before.prs['7'].mergeStateStatus };
    before.ci[h.sha] = 'success';
    Object.assign(before.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    h.saveGithub(before);
    h.ok(['submit', 'T1', '--sha', h.sha, '--branch', 'fixture-change', '--pr', '7', '--agent', 'worker']);
    const after = h.github();
    after.ci[h.sha] = ciAtSubmit;
    Object.assign(after.prs['7'], mergeAtSubmit);
    h.saveGithub(after);
  };
  return h;
}

test('generated mappings recognize only declared paths, including names shared with object properties', async () => {
  const G = require('../lib/generated-conflicts');
  for (const [pkg, names] of [
    [{}, []],
    [{ scripts: { generate: 'node generate.js' }, 'tower-crane': { generated: { 'docs/cli.md': 'generate' } } }, ['docs/cli.md']],
    [{ scripts: { generate: 'node generate.js' }, 'tower-crane': { generated: { constructor: 'generate', toString: 'generate' } } }, ['constructor', 'toString']],
  ]) {
    const config = await G.configuration({ exec: () => ({ status: 0, stdout: JSON.stringify(pkg) }) }, 'repo', 'base');
    assert.deepEqual(Object.keys(config), names);
    assert.equal(config.__proto__, undefined);
    for (const name of ['constructor', 'toString']) if (!names.includes(name)) assert.equal(config[name], undefined);
  }
});

test('generated-only conflicts merge, regenerate and push without rework or a worker', (t) => {
  const h = generatedSetup(t);
  h.submit();
  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.notEqual(task.sha, h.sha, JSON.stringify(h.logs().filter((e) => e.cmd === 'automation')));
  assert.equal(h.git(['rev-parse', 'fixture-change']), task.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
  assert.equal(h.git(['rev-parse', `${task.sha}^1`]), h.sha);
  assert.equal(h.git(['rev-parse', `${task.sha}^2`]), h.baseTip);
  assert.match(fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8'), /branch \/ main/);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(h.logs().filter((e) => e.cmd === 'rework' || e.cmd === 'spawn').length, 0);
  assert.ok(task.evidence.some((e) => e.type === 'tests' && e.ok && e.sha === h.sha), 'old evidence remains historical');
  assert.ok(task.evidence.some((e) => e.type === 'tests' && e.ok && e.sha === task.sha), 'gates rerun on the repaired head');
  assert.ok(h.logs().some((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed'));
});

// A worker can write .git/config. pushInsteadOf rewrites a URL named on the
// command line but not remote.origin.pushurl, so a push to the checked URL
// would reach this repository and run its hooks outside every sandbox.
test('the generated-file repair pushes to the checked origin push URL, not a pushInsteadOf rewrite of it', (t) => {
  const h = generatedSetup(t);
  const evil = path.join(h.base, 'evil');
  const decoy = path.join(evil, path.basename(h.remote));
  h.git(['init', '-q', '--bare', decoy]);
  const marker = path.join(h.base, 'pre-receive-ran');
  fs.writeFileSync(path.join(decoy, 'hooks', 'pre-receive'), `#!/bin/sh\necho ran > ${shellQuote(marker)}\n`, { mode: 0o755 });
  h.git(['config', 'remote.origin.pushurl', h.remote]);
  h.git(['config', `url.${evil}${path.sep}.pushInsteadOf`, `${path.dirname(h.remote)}${path.sep}`]);
  h.submit();
  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(fs.existsSync(marker), false, 'the rewritten destination\'s pre-receive hook ran');
  assert.ok(h.logs().some((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed'), JSON.stringify(h.logs().filter((e) => /automation|generated/.test(e.cmd)).map((e) => e.detail)));
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
});

test('a generated-file conflict in a gate runs its checkout hooks with the gate scratch, not the caller temp root', (t) => {
  const h = generatedSetup(t);
  h.submit();
  const inherited = path.join(h.base, 'inherited-tmp');
  fs.mkdirSync(inherited);
  // Git runs post-checkout for path checkouts too. The hook writes only in a gate worktree
  // (<gate root>/tower-crane-*/wt), so the task worktree a repair creates stays out of it.
  fs.writeFileSync(path.join(h.repo, '.git', 'hooks', 'post-checkout'),
    '#!/bin/sh\ncase "$(pwd)" in */tower-crane-*/wt) mkdir -p "$TMPDIR/tower-crane-hook-$$";; esac\n', { mode: 0o755 });
  const env = { TMPDIR: inherited };
  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator'], { env });
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], { env });
  assert.ok(h.logs().some((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed'));
  // Node's own compile cache also lands in TMPDIR, so only the hook's directories count.
  assert.deepEqual(fs.readdirSync(inherited).filter((name) => name.startsWith('tower-crane-hook-')), []);
});

test('a sole docs conflict regenerates every declared output of its script', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'align other generated output']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.notEqual(task.sha, h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  const receipt = h.logs().find((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared');
  assert.deepEqual(receipt.detail.generated, ['docs/cli.md']);
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
});

for (const partial of [false, true]) {
  test(`an add/add conflict in a declared ${partial ? 'partially' : 'wholly'} generated file ${partial ? 'keeps its hand-written conflict' : 'repairs without rework'}`, (t) => {
    const h = generatedSetup(t);
    const file = partial ? 'new-doc.md' : 'new-generated.txt';
    const content = (side) => partial
      ? `${side} intro.\n<!-- commands:Run:start -->\n${side} rows\n<!-- commands:Run:end -->\n`
      : `${side} output\n`;
    h.git(['switch', 'main']);
    const manifest = path.join(h.repo, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    pkg['tower-crane'].generated[file] = partial
      ? { script: 'docs:generate', blocks: ['commands:Run'] } : 'docs:generate';
    fs.writeFileSync(manifest, JSON.stringify(pkg));
    if (!partial) {
      fs.appendFileSync(path.join(h.repo, 'generate.js'), "fs.writeFileSync('new-generated.txt', rows + '\\n');\n");
      fs.writeFileSync(path.join(h.repo, 'docs', 'cli.md'),
        fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8').replace('base / main', 'branch / base'));
      fs.writeFileSync(path.join(h.repo, 'generated.txt'), 'branch / base\n');
    }
    fs.writeFileSync(path.join(h.repo, file), content('main'));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main introduces generated output']);
    h.git(['push', 'origin', 'main']);
    h.git(['switch', 'fixture-change']);
    fs.writeFileSync(path.join(h.repo, file), content('branch'));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'branch introduces generated output']);
    h.git(['push', 'origin', 'fixture-change']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    const ancestor = h.git(['merge-base', 'main', 'fixture-change']);
    assert.equal(h.git(['ls-tree', ancestor, '--', file]), '', 'the conflict has no ancestor blob');
    const github = h.github();
    github.prs['7'].headRefOid = h.sha;
    h.saveGithub(github);
    h.submit();
    h.consume();
    const task = h.readState('tasks.json').tasks[0];
    if (partial) {
      assert.equal(task.status, 'rework');
      assert.equal(task.sha, h.sha);
      assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), file);
      const text = fs.readFileSync(path.join(h.repo, file), 'utf8');
      assert.match(text, /branch intro\./);
      assert.match(text, /main intro\./);
    } else {
      assert.equal(task.status, 'submitted');
      assert.notEqual(task.sha, h.sha);
      assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), task.sha);
      assert.equal(h.git(['rev-parse', `${task.sha}^1`]), h.sha);
      assert.equal(h.git(['rev-parse', `${task.sha}^2`]), h.git(['rev-parse', 'main']));
      assert.equal(fs.readFileSync(path.join(h.repo, file), 'utf8'), 'branch / main\n');
      assert.equal(h.git(['status', '--porcelain']), '');
      assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
      const receipt = h.logs().find((e) => e.cmd === 'generated merge' && e.detail.phase === 'pushed');
      assert.deepEqual(receipt.detail.generated, [file]);
    }
  });
}

test('an accepted generated-only conflict returns to submitted with old review kept historical', (t) => {
  const h = generatedSetup(t);
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const accepted = h.readState('tasks.json').tasks[0];
  assert.equal(accepted.status, 'accepted');
  const conflicting = h.github();
  Object.assign(conflicting.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  h.saveGithub(conflicting);
  h.consume();
  const repaired = h.readState('tasks.json').tasks[0];
  assert.equal(repaired.status, 'submitted');
  assert.notEqual(repaired.sha, h.sha);
  assert.equal(repaired.revision, accepted.revision);
  assert.equal(repaired.submitted_by, 'worker');
  assert.ok(repaired.evidence.some((e) => e.type === 'review' && e.sha === h.sha));
  assert.equal(repaired.evidence.some((e) => e.type === 'review' && e.sha === repaired.sha), false);
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

test('the queue defers real generated conflicts while GitHub still reports the accepted head clean', (t) => {
  const h = generatedSetup(t);
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.consume();
  const deferred = h.readState('tasks.json').tasks[0];
  assert.equal(deferred.status, 'accepted');
  assert.equal(deferred.sha, h.sha);
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'generated merge' || e.cmd === 'head check'), false);
  assert.equal(h.github().calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  const confirmed = h.github();
  Object.assign(confirmed.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  h.saveGithub(confirmed);
  h.consume();
  const repaired = h.readState('tasks.json').tasks[0];
  assert.equal(repaired.status, 'submitted');
  assert.notEqual(repaired.sha, h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), repaired.sha);
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

for (const mergeable of ['MERGEABLE', 'UNKNOWN']) {
  test(`a post-merge sweep defers mixed generated conflicts with ${mergeable} mergeability until GitHub confirms them`, (t) => {
    const h = generatedSetup(t);
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'main changes hand-written source']);
    h.git(['push', 'origin', 'main']);
    h.git(['switch', '-qc', 'independent-change']);
    fs.writeFileSync(path.join(h.repo, 'other.txt'), 'Independent change.\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'independent submitted change']);
    h.git(['push', 'origin', 'independent-change']);
    const other = h.git(['rev-parse', 'HEAD']);
    const github = h.github();
    Object.assign(github.prs['7'], { mergeable, mergeStateStatus: mergeable === 'UNKNOWN' ? 'UNKNOWN' : 'CLEAN' });
    github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'independent-change',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: 'https://github.com/acme/demo/pull/8' };
    github.ci[other] = 'success';
    github.advanceBase = true;
    h.saveGithub(github);
    h.submit();
    h.ok(['task', 'add', '--title', 'Independent', '--acceptance', 'works', '--kind', 'docs']);
    h.ok(['claim', 'T2', '--agent', 'other-worker']);
    h.ok(['submit', 'T2', '--sha', other, '--branch', 'independent-change', '--pr', '8', '--agent', 'other-worker']);
    for (const type of ['clean', 'ci']) h.ok(['check', type, 'T2', '--agent', 'orchestrator']);
    h.reviewer('T2', 'other-reviewer');
    h.ok(['evidence', 'T2', '--type', 'review', '--sha', other, '--ok', '--agent', 'other-reviewer']);
    h.ok(['accept', 'T2', '--agent', 'orchestrator']);
    h.consume();
    assert.equal(h.github().prs['8'].state, 'MERGED', 'the confirmed merge triggers the sweep');
    const deferred = h.readState('tasks.json').tasks[0];
    assert.equal(deferred.status, 'submitted');
    assert.equal(deferred.sha, h.sha);
    assert.equal(h.git(['rev-parse', 'fixture-change']), h.sha);
    assert.equal(h.git(['status', '--porcelain']), '');
    assert.equal(h.logs().some((e) => e.task === 'T1' && ['rework', 'generated merge'].includes(e.cmd)), false);
    const confirmed = h.github();
    Object.assign(confirmed.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    h.saveGithub(confirmed);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
    const receipt = h.logs().find((e) => e.task === 'T1' && e.cmd === 'generated merge' && e.detail.phase === 'mixed');
    assert.ok(receipt, 'confirmation prepares the mixed merge');
    assert.deepEqual(receipt.detail.remaining, ['value.js']);
    assert.equal(h.git(['diff', '--name-only', '--diff-filter=U'], receipt.detail.path), 'value.js');
    assert.equal(fs.readFileSync(path.join(receipt.detail.path, 'generated.txt'), 'utf8'), 'branch / main\n');
  });
}

test('mixed conflicts keep a prepared merge with generated files staged and only hand-written files unresolved', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'hand-written conflict']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.sha, h.sha);
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'value.js');
  assert.equal(h.git(['rev-parse', 'MERGE_HEAD']), h.git(['rev-parse', 'main']));
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js\./);
  assert.match(task.notes.at(-1).text, /generated files are pre-resolved: docs\/cli\.md, generated\.txt/);
});

// A worker that owns its PR waits on it while the engine repairs a conflict
// at its head: a generated-only repair keeps it the owner, and a mixed one
// hands the prepared merge back to it with its receipt. The owner fixture
// exits at its first handback.
for (const mixed of [false, true]) {
  test(`a ${mixed ? 'mixed' : 'generated-only'} conflict at a waiting owner's head ${mixed ? 'hands the prepared merge back to the owner' : 'is repaired while the owner keeps the PR'}`, async (t) => {
    const h = generatedSetup(t);
    if (mixed) {
      h.git(['switch', 'main']);
      fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
      h.git(['add', '.']);
      h.git(['commit', '-qm', 'hand-written conflict']);
      h.git(['push', 'origin', 'main']);
      h.git(['switch', 'fixture-change']);
    }
    configureHarness(h);
    for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, OWNER, BIN, '{prompt}'])]);
    Object.assign(h.env, { OWNER_HEADS: JSON.stringify([h.sha]), OWNER_LOG: path.join(h.base, 'owner.jsonl'), OWNER_CRASH_ON_FIX: '1' });
    // The owner appends while the test reads: only complete lines count.
    const outcomes = () => (fs.existsSync(h.env.OWNER_LOG) ? readPublished(h.env.OWNER_LOG, 'utf8') : '').split('\n').filter((l) => l.endsWith('}')).map(JSON.parse);
    const github = h.github();
    Object.assign(github.prs['7'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    h.saveGithub(github);
    const { agent } = h.json(['spawn', '--task', 'T1']);
    const task = () => h.readState('tasks.json').tasks[0];
    const until = (check, what) => waitUntil(check, { paths: [h.base], what });
    await until(() => task().status === 'submitted' && h.logs().some((e) => e.cmd === 'submit' && e.detail.own), 'the owner submits');
    const conflicting = h.github();
    // The PR's head is the branch the owner's worktree holds, pushed as a worker does.
    h.git(['push', 'origin', `${h.sha}:refs/heads/${task().branch}`]);
    Object.assign(conflicting.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefName: task().branch });
    h.saveGithub(conflicting);
    h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation' && e.detail.error).map((e) => e.detail.error), []);
    if (mixed) {
      assert.deepEqual([task().status, task().claim.agent], ['in_progress', agent]);
      const receipt = h.logs().find((e) => e.cmd === 'generated merge' && e.detail.phase === 'mixed');
      assert.ok(receipt, 'the mixed merge keeps its receipt');
      assert.deepEqual([receipt.detail.revision, receipt.detail.remaining], [2, ['value.js']]);
    } else {
      assert.equal(task().status, 'submitted');
      assert.notEqual(task().sha, h.sha);
      assert.equal(h.logs().findLast((e) => e.cmd === 'submit').detail.owner, agent);
      // The owner still holds the repaired head: the next failure comes back to it.
      assert.match(h.ok(['rework', 'T1', '--reason', 'value.js must be 2', '--agent', 'orchestrator']), new RegExp(`its owner ${agent} fixes it`));
    }
    await until(() => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent), 'the owner takes the handback');
    const [fix, ...rest] = outcomes().filter((o) => o.outcome !== 'wait');
    assert.deepEqual(rest, []);
    assert.equal(fix.outcome, 'fix', JSON.stringify(fix));
    assert.match(fix.message, mixed ? /conflicts with main: value\.js\. The merge is prepared at / : /value\.js must be 2/);
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'worker').length, 1);
  });
}

test('mixed binary outputs preserve the branch bytes when generation must wait for source resolution', (t) => {
  const h = generatedSetup(t);
  for (const [branch, bytes] of [['main', [0, 254, 67]], ['fixture-change', [0, 255, 66]]]) {
    h.git(['switch', branch]);
    fs.writeFileSync(path.join(h.repo, 'generated.txt'), Buffer.from(bytes));
    if (branch === 'main') {
      fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
      fs.writeFileSync(path.join(h.repo, 'generate.js'), 'process.exit(1);\n');
    }
    h.git(['add', '.']);
    h.git(['commit', '-qm', `binary output on ${branch}`]);
    h.git(['push', 'origin', branch]);
  }
  h.sha = h.git(['rev-parse', 'HEAD']);
  const github = h.github();
  github.prs['7'].headRefOid = h.sha;
  h.saveGithub(github);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'value.js');
  assert.equal(h.git(['rev-parse', ':generated.txt']), h.git(['rev-parse', `${h.sha}:generated.txt`]));
  assert.deepEqual(fs.readFileSync(path.join(h.repo, 'generated.txt')), Buffer.from([0, 255, 66]));
});

test('a hand-written conflict within a generated document still needs rework', (t) => {
  const h = generatedSetup(t);
  for (const [branch, intro] of [['main', 'Main intro.'], ['fixture-change', 'Branch intro.']]) {
    h.git(['switch', branch]);
    const file = path.join(h.repo, 'docs', 'cli.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Hand-written intro.', intro));
    h.git(['add', '.']);
    h.git(['commit', '-qm', `change intro on ${branch}`]);
    h.git(['push', 'origin', branch]);
  }
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
  assert.equal(h.git(['diff', '--name-only', '--diff-filter=U']), 'docs/cli.md');
  const text = fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8');
  assert.match(text, /<<<<<<< ours[\s\S]*Branch intro\.[\s\S]*Main intro\./);
  assert.match(text, /<!-- commands:Run:start -->\nbranch \/ main\n<!-- commands:Run:end -->/);
  assert.equal(fs.readFileSync(path.join(h.repo, 'generated.txt'), 'utf8'), 'branch / main\n');
});

test('dirty worktrees defer generated-file repair without losing work or requesting rework', (t) => {
  const h = generatedSetup(t);
  h.submit();
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Unsaved work.\n');
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.sha, h.sha);
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /dirty worktree/.test(e.detail.error)));
});

test('a failing generator aborts a generated-only merge and retains the submission for retry', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  const file = path.join(h.repo, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.scripts['docs:generate'] = 'node -e "process.exit(1)"';
  fs.writeFileSync(file, JSON.stringify(pkg));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator fails']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /generation failed/.test(e.detail.error)));
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

test('failed generation restores modified source files and removes new files before retry', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  const script = path.join(h.repo, 'generate.js');
  fs.writeFileSync(script, "const fs=require('node:fs'); fs.writeFileSync('README.md','changed'); fs.writeFileSync('leftover.txt','new'); process.exit(1);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator writes before failing']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  const before = fs.readFileSync(path.join(h.repo, 'README.md'), 'utf8');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(h.repo, 'README.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(h.repo, 'leftover.txt')), false);
  h.consume();
  assert.ok(h.logs().filter((e) => e.cmd === 'automation' && /generation failed/.test(e.detail.error)).length >= 2);
});

test('generation cannot commit edits to hand-written text outside declared blocks', (t) => {
  const h = generatedSetup(t);
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'generate.js'), "fs.appendFileSync('docs/cli.md', 'Unexpected hand-written text.\\n');\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'generator changes hand-written text']);
  h.git(['push', 'origin', 'main']);
  h.git(['switch', 'fixture-change']);
  h.submit();
  const before = fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
  assert.equal(fs.readFileSync(path.join(h.repo, 'docs', 'cli.md'), 'utf8'), before);
  assert.equal(h.git(['status', '--porcelain']), '');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && /outside declared blocks/.test(e.detail.error)));
});

for (const mismatch of ['fork head', 'origin repository']) {
  test(`generated-file repair defers a mismatched ${mismatch} before changing or pushing the branch`, (t) => {
    const h = generatedSetup(t);
    const state = h.github();
    if (mismatch === 'fork head') state.prs['7'].headRepository.nameWithOwner = 'someone/fork';
    else state.pushRepository = 'other/repository';
    h.saveGithub(state);
    h.submit();
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.git(['rev-parse', 'HEAD']), h.sha);
    assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
    assert.equal(h.git(['status', '--porcelain']), '');
    assert.ok(h.logs().some((e) => e.cmd === 'automation' && /repository/.test(e.detail.error)));
    assert.equal(h.logs().some((e) => e.cmd === 'generated merge' || e.cmd === 'rework'), false);
  });
}

test('a failed generated-file push retries the prepared merge without a worker or another generation', (t) => {
  const h = generatedSetup(t);
  const hook = path.join(h.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0];
  assert.equal(before.status, 'submitted');
  assert.equal(before.sha, h.sha);
  const prepared = h.logs().filter((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared');
  assert.equal(prepared.length, 1);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), h.sha);
  fs.rmSync(hook);
  h.consume();
  const after = h.readState('tasks.json').tasks[0];
  assert.equal(after.status, 'submitted');
  assert.equal(after.sha, prepared[0].detail.sha);
  assert.equal(h.git(['--git-dir', h.remote, 'rev-parse', 'fixture-change']), after.sha);
  assert.equal(h.logs().filter((e) => e.cmd === 'generated merge' && e.detail.phase === 'prepared').length, 1);
  assert.equal(h.logs().some((e) => e.cmd === 'rework' || e.cmd === 'spawn'), false);
});

test('submission runs real software gates once through the existing waiter', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'note', 'T1', 'live orchestrator', '--agent', 'orchestrator'], { env: { CLAUDE_SESSION_ID: 'holder' } });
  const holder = h.readState('tasks.json').orchestrator_lease;
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'owner'],
    { env: { CLAUDE_SESSION_ID: 'engine-waiter' } });
  h.submit();
  assert.equal(h.consume().code, 2);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, holder.session_id, 'automation inherits the holder');
  assert.deepEqual(h.readState('tasks.json').orchestrator_lease, holder, 'background gates do not extend the session idle window');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type),
    ['tests', 'clean', 'ci'], 'startup refreshes pending CI, records no unchanged result and reuses the other gates');
  assert.ok(h.github().calls.filter((a) => a[0] === 'api').length > 2, 'startup read the checks again');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

for (const waiting of ['runs', 'mergeability']) {
  test(`pending CI ${waiting} completes on the timer without a completion notification`, async (t) => {
    const h = setup(t, { ci: 'pending' });
    h.submit();
    if (waiting === 'mergeability') {
      const github = h.github();
      github.prs['7'].mergeable = github.prs['7'].mergeStateStatus = 'UNKNOWN';
      h.saveGithub(github);
    }
    const checked = h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']);
    assert.equal(checked.code, 1);
    assert.match(checked.stdout, /ci PENDING/);
    assert.doesNotMatch(checked.stdout, /ci FAIL/);
    h.consume();
    const latest = () => h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
    assert.equal(latest().pending, true);
    assert.equal(latest().infrastructure_failure, undefined);
    assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
    assert.match(h.ok(['status']), /pending ci/);
    const board = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
    assert.match(board, /class="pip pending">ci pending/);
    assert.doesNotMatch(board, /class="pip fail">ci failed/);
    const clock = path.join(h.base, 'ci-clock');
    const start = Date.now();
    fs.writeFileSync(clock, String(start));
    const reconciled = () => h.logs().filter((e) => e.cmd === 'automation reconcile').length;
    const before = reconciled();
    // The waiter's own timeout ends this engine run; the test asserts it timed out without waking.
    const waiter = h.runAsync(['wait', '--types', 'never', '--timeout', '10', '--agent', 'orchestrator'], // wait-allow: the engine run ends at its own timeout
      { hooks: { HOOK_CLOCK_FILE: clock } });
    t.after(() => waiter);
    let ended = false;
    waiter.then(() => { ended = true; });
    // Readiness is the record; a waiter that ended first fails at once.
    const until = (probe) => waitOnRepo(h, () => {
      if (probe()) return true;
      if (ended) throw new Error('the waiter ended before the CI check completed');
      return false;
    }, 'CI check completed');
    await until(() => reconciled() > before);
    const github = h.github();
    github.ci[h.sha] = 'success';
    github.prs['7'].mergeable = 'MERGEABLE';
    github.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(github);
    fs.writeFileSync(clock, String(start + 60001));
    await until(() => latest().ok);
    assert.equal((await waiter).code, 2);
    assert.equal(latest().pending, undefined);
    assert.equal(h.logs().some((e) => e.cmd === 'ci completed' || e.cmd === 'rework'), false);
    assert.equal(h.logs().filter((e) => e.cmd === 'check tests').length, 1);
    assert.equal(h.logs().filter((e) => e.cmd === 'check clean').length, 1);
  });
}

test('unchanged pending CI is rechecked each minute without new records, and CI that never starts stalls after 30 minutes', async (t) => {
  const h = setup(t, { ci: 'none' });
  h.submit();
  h.consume();
  const ci = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'ci');
  assert.equal(ci().length, 1);
  assert.equal(ci()[0].pending, true);
  assert.equal(ci()[0].not_running, true);
  const clock = path.join(h.base, 'ci-clock');
  let now = Date.now();
  fs.writeFileSync(clock, String(now));
  const reconciles = () => h.logs().filter((e) => e.cmd === 'automation reconcile');
  const rechecked = () => {
    const sources = new Set(reconciles().map((e) => e.id));
    return h.logs().filter((e) => e.cmd === 'automation' && sources.has(e.detail.source) && e.detail.phase === 'done').length;
  };
  const waiter = h.runAsync(['wait', '--types', 'worker-message', '--timeout', '300', '--agent', 'orchestrator'],
    { hooks: { HOOK_CLOCK_FILE: clock } });
  t.after(() => waiter);
  let ended = false;
  waiter.then(() => { ended = true; });
  const until = (probe, what) => waitOnRepo(h, () => {
    if (probe()) return true;
    if (ended) throw new Error(`the waiter ended first: ${what}`);
    return false;
  }, what);
  await until(() => rechecked() >= 1, 'startup rechecks pending CI');
  const checks = h.logs().filter((e) => e.cmd === 'check ci').length;
  const tasks = h.readState('tasks.json').tasks;
  for (let minute = 1; minute <= 6; minute++) {
    const before = rechecked();
    now += 60001;
    fs.writeFileSync(clock, String(now));
    await until(() => rechecked() > before, `minute ${minute} rechecks pending CI`);
  }
  assert.equal(ci().length, 1, 'an unchanged pending result adds no evidence');
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, checks, 'and no gate event');
  assert.deepEqual(h.readState('tasks.json').tasks, tasks, 'no task record changes');
  assert.match(h.ok(['status']), /pending ci/);
  now += 25 * 60000;
  fs.writeFileSync(clock, String(now));
  await until(() => ci().at(-1).stalled === true, 'CI that never started stalls after 30 minutes');
  // The stall record is written mid-run: the recheck that wrote it, and the
  // reaction its gate event queues, still render the board and read the PR.
  const stall = h.logs().findLast((e) => e.cmd === 'check ci');
  const outcome = (id) => h.logs().findLast((e) => e.cmd === 'automation' && e.detail.source === id && e.detail.phase !== 'running')?.detail.phase;
  let sources = [];
  await until(() => (sources = [stall.id, ...reconciles().map((e) => e.id)]).every(outcome), 'the engine finishes the run that recorded the stall');
  // A reaction that failed also finishes; it must not pass for one that worked.
  for (const id of sources) assert.ok(['done', 'deferred'].includes(outcome(id)), `the reaction to ${id} ended ${outcome(id)}`);
  assert.equal(ci().length, 2);
  assert.match(ci().at(-1).summary, /Stalled: no CI run has been queued or running at this head since/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'a stall is not a verdict on the change');
  assert.match(h.ok(['status']), /stalled ci/);
  assert.match(h.ok(['task', 'show', 'T1']), /ci stalled/);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'ci_stalled');
  assert.equal(item.task, 'T1');
  assert.equal(item.addressed_to, 'orchestrator');
  assert.deepEqual(item.action.argv, ['check', 'ci', 'T1']);
  const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(page, /class="pip stalled">ci stalled/);
  const settled = reconciles().length;
  const calls = h.github().calls.length;
  for (let minute = 1; minute <= 3; minute++) {
    now += 60001;
    fs.writeFileSync(clock, String(now));
    await new Promise((resolve) => setTimeout(resolve, 1500)); // wait-allow: give the engine each simulated minute to show it schedules no recheck
  }
  assert.equal(reconciles().length, settled, 'a stalled head gets no scheduled recheck');
  assert.equal(h.github().calls.length, calls, 'and no GitHub call');
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'done', '--agent', 'w-1']);
  assert.equal((await waiter).code, 0);
  assert.equal(h.logs().some((e) => e.cmd === 'rework'), false);
});

test('pending CI on a PR closed without merging stalls at the next recheck', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  const latest = () => h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
  assert.equal(latest().pending, true);
  const github = h.github();
  github.prs['7'].state = 'CLOSED';
  h.saveGithub(github);
  const closedAt = h.logs().length;
  const recheck = h.consume();
  // This failed once in a loaded tests gate and never locally; the gate keeps
  // only the output tail, so the message carries what the recheck did.
  const did = () => JSON.stringify({ code: recheck.code, stderr: recheck.stderr.slice(-1500),
    events: h.logs().slice(closedAt).map((e) => [e.cmd, e.detail.phase, e.detail.type, e.detail.ok, e.detail.error].filter((x) => x != null).join(' ')) });
  assert.equal(latest().stalled, true, did());
  assert.match(latest().summary, /closed without merging/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const checks = () => h.logs().filter((e) => e.cmd === 'check ci').length;
  const before = checks();
  h.consume();
  assert.equal(checks(), before, 'a stalled head is not checked again on its own');
  assert.equal(latest().stalled, true);
});

for (const type of ['tests', 'clean', 'ci', 'sources']) {
  test(`status and the board label the current failed ${type} gate`, (t) => {
    const h = setup(t, { kind: type === 'sources' ? 'research' : 'code', ci: type === 'ci' ? 'failure' : 'success' });
    h.submit();
    if (type === 'tests') h.ok(['project', 'set', '--tests-mode', 'run-only',
      '--tests-cmd', 'node -e "process.exit(1)"']);
    if (type === 'clean') h.env.FIXTURE_GATE_OK = '0';
    assert.equal(h.run(['check', type, 'T1', '--agent', 'orchestrator']).code, 1);
    assert.match(h.ok(['status']), new RegExp(`failed ${type}`));
    assert.match(h.ok(['task', 'show', 'T1']), new RegExp(`${type} failed`));
    const page = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
    const sheet = page.match(/<article id="T1"[\s\S]*?<\/article>/)[0];
    assert.match(sheet, new RegExp(`class="pip fail">${type} failed`));
    assert.match(sheet, new RegExp(`failed ${type}`));
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.gates.gates.find((g) => g.type === type).state, 'failed');
  });
}

test('background reactions leave vacant, released, taken-over and expired leases available for handoff', (t) => {
  const h = setup(t, { ci: 'pending' });
  const lease = () => h.readState('tasks.json').orchestrator_lease ?? null;
  const holder = { env: { CLAUDE_SESSION_ID: 'holder' } };
  const acquire = () => h.ok(['task', 'note', 'T1', 'native session', '--agent', 'orchestrator'], holder);
  const react = (opts) => h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'owner'], opts);
  h.submit();
  react();
  assert.equal(lease(), null, 'a monitor cannot become the first orchestrator');
  acquire();
  const live = lease();
  react();
  assert.deepEqual(lease(), live, 'background work cannot renew the holder');
  h.ok(['orchestrator', 'release', '--agent', 'orchestrator'], holder);
  react();
  assert.equal(lease(), null, 'background work cannot undo release');
  acquire();
  h.ok(['orchestrator', 'takeover', '--agent', 'owner']);
  react();
  assert.equal(lease(), null, 'background work cannot undo takeover');
  acquire();
  const expired = lease();
  const env = {
    TOWER_CRANE_TEST_NOW: String(Date.parse(expired.heartbeat) + h.readState('project.json').limits.lease_minutes * 60000 + 1),
    NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`.trim(),
  };
  react({ env });
  assert.deepEqual(lease(), expired, 'background work cannot revive an idle session');
  h.ok(['task', 'note', 'T1', 'replacement session', '--agent', 'orchestrator'],
    { env: { ...env, CLAUDE_SESSION_ID: 'replacement' } });
  assert.notEqual(lease().session_id, expired.session_id);
});

const IDLE_LEASE = {
  aged: 'acts after aging past its captured lease',
  takeover: 'stops after another session takes its captured lease',
  late: 'started after its holder idled out acts when that holder returns',
};
for (const [mode, title] of Object.entries(IDLE_LEASE)) {
  const takeover = mode === 'takeover';
  test(`automation ${title}`, async (t) => {
    const h = cachedFixture(t, 'automation-idle-lease', (repo) => {
      const fixture = setup(null, { repo, ci: 'pending' });
      return { sha: fixture.sha };
    });
    h.env.CLAUDE_SESSION_ID = 'holder';
    const { stalled, release } = holdSuite(h);
    const clock = path.join(h.base, 'lease-clock');
    const preload = path.join(h.base, 'lease-clock.js');
    fs.writeFileSync(preload, `const fs = require('node:fs');
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [Date.now()])); }
  static now() {
    return fs.existsSync(${JSON.stringify(clock)})
      ? Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8')) : RealDate.now(); // read-published: the test writes the clock in place.
  }
};
`);
    const env = { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`.trim() };
    let holder = h.readState('tasks.json').orchestrator_lease;
    const idle = h.readState('project.json').limits.lease_minutes * 60000;
    const expire = () => fs.writeFileSync(clock, String(Date.parse(holder.heartbeat) + idle + 1));
    // A late reaction starts under the expired record; an owner waiter cannot renew it.
    if (mode === 'late') expire();
    h.ok(['claim', 'T1', '--agent', 'worker'], { env });
    // The submit reads green CI; the gates see it pending afterwards.
    const github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
    const ci = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify({ ...github(), ci: { [h.sha]: state } }));
    ci('success');
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker'], { env });
    ci('pending');
    const waiting = mode === 'late'
      ? h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'owner'],
        { env: { ...env, CLAUDE_SESSION_ID: 'engine-waiter' } })
      : h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], { env });
    try {
      await waitFor(stalled, { what: 'automation did not start its gate' });
      if (mode === 'late') {
        assert.deepEqual(h.readState('tasks.json').orchestrator_lease, holder, 'an owner waiter keeps the holder heartbeat');
        // The holder wakes on the submit; its first read renews its own heartbeat.
        h.ok(['status', '--agent', 'orchestrator'], { env });
        const renewed = h.readState('tasks.json').orchestrator_lease;
        assert.equal(renewed.session_id, holder.session_id);
        assert.notEqual(renewed.heartbeat, holder.heartbeat, 'the returning holder renews its lease');
      } else {
        holder = h.readState('tasks.json').orchestrator_lease;
        expire();
      }
      if (takeover) {
        h.ok(['task', 'note', 'T1', 'replacement session', '--agent', 'orchestrator'],
          { env: { ...env, CLAUDE_SESSION_ID: 'replacement' } });
        assert.notEqual(h.readState('tasks.json').orchestrator_lease.session_id, holder.session_id);
      }
      const before = h.readState('tasks.json').orchestrator_lease;
      fs.writeFileSync(release, '');
      const result = await waiting;
      assert.equal(result.code, takeover ? 1 : 2, result.stderr);
      const after = h.readState('tasks.json');
      assert.deepEqual(after.orchestrator_lease, before, 'automation cannot acquire or renew a lease');
      if (takeover) {
        assert.match(result.stderr, /orchestrator lease changed during automation/);
        assert.equal(after.tasks[0].evidence.some((e) => e.type === 'tests'), false, 'the old session cannot publish its gate result');
      } else {
        assert.ok(after.tasks[0].evidence.some((e) => e.type === 'tests' && e.ok), 'automation publishes its gate result after expiry');
      }
    } finally {
      fs.writeFileSync(release, '');
      await waiting;
    }
  });
}
