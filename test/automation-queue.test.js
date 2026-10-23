'use strict';

// The merge queue: head-of-line checks of the merge, moving bases and heads,
// suite timeouts and the PRs behind a stopped head.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BIN, cachedFixture } = require('./helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');
const { readPublished } = require('./atomic-file');
const { setup, attach } = require('./automation-helpers');
const { waitUntil } = require('./signals');
const { identity } = require('../lib/processes');
const { randomUUID } = require('node:crypto');

// A second PR that touches other files, and a suite command that logs each
// run with PR #7's state at that moment. Both PRs are submitted and through
// their gates; the file builds that once and each test gets a copy.
function queueFixture(t) {
  const h = cachedFixture(t, 'queue', (repo) => buildQueue(setup(null, { repo })));
  attach(h);
  h.suites = () => (fs.existsSync(h.suiteLog)
    ? readPublished(h.suiteLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  h.moveMain = (file = 'README.md', text = 'Independent base update.\n') => {
    h.git(['switch', '-q', 'main']);
    fs.appendFileSync(path.join(h.repo, file), text);
    h.git(['add', file]);
    h.git(['commit', '-qm', 'advance main']);
  };
  return h;
}

function buildQueue(h) {
  h.git(['switch', '-qc', 'second-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'test', 'other.test.js'), "require('node:assert/strict').equal(require('../other'), 2);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'second change']);
  h.second = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'works']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: h.second, headRefName: 'second-change' };
  github.ci[h.second] = 'success';
  h.saveGithub(github);
  h.suiteLog = path.join(h.base, 'suites.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(h.suiteLog)}, JSON.stringify({ pr7: gh.prs['7'].state }) + '\\n');
// Gate runs that fail, as gates did for tasks accepted before evidence; the file holds how many.
const failRuns = ${JSON.stringify(path.join(h.base, 'fail-runs'))};
if (fs.existsSync(failRuns)) {
  // read-published: only this script rewrites the count, one gate run at a time.
  const left = Number(fs.readFileSync(failRuns, 'utf8')) - 1;
  if (left > 0) fs.writeFileSync(failRuns, String(left));
  else fs.rmSync(failRuns);
  process.exit(1);
}
// One run moves main while it runs, as another merge landing would.
if (fs.existsSync(${JSON.stringify(path.join(h.base, 'move-main-once'))})) {
  fs.rmSync(${JSON.stringify(path.join(h.base, 'move-main-once'))});
  const git = (a) => require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(h.repo)}, ...a], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/main', git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'lands during the check'])]);
}
// Another CLI acting while the suite runs.
const during = ${JSON.stringify(path.join(h.base, 'during-check.js'))};
if (fs.existsSync(during)) {
  const script = during + '.ran';
  fs.renameSync(during, script);
  require(script);
}
for (const f of fs.readdirSync('test')) if (f.endsWith('.test.js')) require(path.resolve('test', f));
`);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  h.submit();
  h.submit('T2', h.second, '8');
  h.consume();
  for (const id of ['T1', 'T2']) {
    const gates = h.json(['task', 'show', id]).gates.gates;
    assert.ok(gates.filter((g) => g.type !== 'review').every((g) => g.ok), JSON.stringify(gates));
  }
  return { sha: h.sha, second: h.second, suiteLog: h.suiteLog };
}

const headChecks = (h) => h.logs().filter((e) => e.cmd === 'head check');
// A merge settles earlier receipts into evidence files; the CLI reads them back.
const softwareEvidence = (h, id) => h.json(['task', 'show', id]).evidence
  .filter((e) => ['tests', 'clean', 'ci'].includes(e.type));

function acceptBoth(h) {
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.reviewer('T2', 'reviewer');
  h.ok(['evidence', 'T2', '--revision', h.revision('T2'), '--type', 'review', '--sha', h.second, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);
}

test('main moves: a mergeable PR keeps its evidence and merges after one head-of-line check', (t) => {
  const h = queueFixture(t);
  const before = softwareEvidence(h, 'T1');
  h.moveMain();
  const suites = h.suites().length;
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const result = h.consume();
  assert.deepEqual(softwareEvidence(h, 'T1'), before, 'a base move reruns no gate and resets no evidence');
  assert.equal(h.github().prs['7'].state, 'MERGED', result.stderr || JSON.stringify(h.logs().slice(-4)));
  assert.equal(h.suites().length - suites, 1);
  const checks = headChecks(h);
  assert.deepEqual(checks.map((e) => [e.task, e.detail.ok, e.detail.base_sha]), [['T1', true, h.git(['rev-parse', 'main'])]]);
  assert.ok(checks[0].detail.commands.some((c) => c.args.includes('merge-tree')));
  h.consume();
  assert.equal(headChecks(h).length, 1, 'a repeated reaction does not run the suite again');
});

// Crucial mode (tests.crucial, tests.expensive and tests.map): the head of the line runs what the
// tests gate selects for the change it brings onto main, never the full suite. A run-only task's
// tests gate selects nothing, so its head check runs the full command as before.
for (const [mode, crucial] of [['prove', true], ['run-only', false]]) test(`in crucial mode with tests.mode ${mode} the head check runs ${crucial ? 'the crucial and mapped suites of the change' : 'the full command'}`, (t) => {
  const h = setup(t);
  const log = path.join(h.base, 'suite-argv.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const given = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(given) + '\\n');
const files = given.length ? given : fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).map((f) => 'test/' + f);
for (const f of files) require(path.resolve(f));
`);
  const node = `${shellQuote(process.execPath)} ${shellQuote(suite)}`;
  h.ok(['project', 'set', '--tests-cmd', node, '--tests-proof-cmd', `${node} {tests}`, '--tests-expensive', 'true',
    '--tests-map', JSON.stringify({ 'value.js': ['test/value.test.js'], '**/*.md': [] }), '--tests-crucial', '["test/value.test.js"]',
    '--tests-mode', mode]);
  h.submit();
  h.consume();
  assert.ok(h.json(['task', 'show', 'T1']).gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
  h.git(['switch', '-q', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const result = h.consume();
  assert.equal(h.github().prs['7'].state, 'MERGED', result.stderr || JSON.stringify(h.logs().slice(-4)));
  const [check] = headChecks(h);
  assert.equal(check.detail.ok, true, check.detail.summary);
  if (!crucial) {
    assert.equal(check.detail.head_mode, undefined);
    assert.equal(check.detail.command, node);
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').slice(runs).map(JSON.parse), [[]], 'the full command names no suites');
    return;
  }
  assert.equal(check.detail.head_mode, 'crucial');
  assert.deepEqual(check.detail.head_tests, ['test/value.test.js']);
  assert.equal(check.detail.command, `${node} ${shellQuote('test/value.test.js')}`);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').slice(runs).map(JSON.parse), [['test/value.test.js']],
    'the head check named its suites; a full run names none');
});

test('the head check runs the suite on a clean checkout of the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  // A suite that requires a clean tree, as ginza's tools/check.py does.
  const log = path.join(h.base, 'clean-check.json');
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
const git = (...a) => cp.execFileSync('git', a, { encoding: 'utf8' }).trim();
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ status: git('status', '--porcelain'),
  head: git('rev-parse', 'HEAD'), parents: git('rev-list', '--parents', '-n', '1', 'HEAD') }));
git('diff', '--quiet', 'HEAD');
git('diff', '--cached', '--quiet');
if (git('status', '--porcelain') !== '') process.exit(3);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true]], JSON.stringify(headChecks(h).map((e) => e.detail.summary)));
  assert.equal(h.github().prs['7'].state, 'MERGED');
  const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(seen.status, '');
  assert.equal(seen.parents, `${seen.head} ${h.git(['rev-parse', 'main'])} ${h.sha}`);
  assert.equal(h.git(['for-each-ref', '--contains', seen.head]), '', 'no ref names the merge commit');
});

test('the head of the line that turns CONFLICTING goes to rework with its files and the next PR merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const github = h.github();
  github.prs['7'].mergeable = 'CONFLICTING';
  github.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(github);
  h.ok(['project', 'set', '--paused', 'manual queue conflict probe']);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.match(t1.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(headChecks(h).map((e) => e.task), ['T2']);
});

test('two queued PRs run exactly one full suite each at their turn and none before', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const suites = h.suites().length;
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  blocked.advanceBase = true;
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.suites().length, suites, 'nothing runs while the head of the line waits');
  assert.equal(headChecks(h).length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false, 'the second PR does not jump the line');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T1');
  assert.match(stopped.detail.blocked.reason, /mergeability of PR #7 is UNKNOWN/);

  const ready = h.github();
  ready.prs['7'].mergeable = 'MERGEABLE';
  ready.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(ready);
  // The wait runs both suites in this process: 55s alone and 119s with the
  // whole file running in parallel, so a shorter timeout fails under load.
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '300', '--agent', 'orchestrator']);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['7', '8']);
  assert.deepEqual(h.suites().slice(suites), [{ pr7: 'OPEN' }, { pr7: 'MERGED' }],
    'T1 runs its suite before merging; T2 runs its suite only after T1 merged');
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true], ['T2', true]]);
  assert.equal(headChecks(h)[1].detail.base_sha, h.sha, 'T2 is checked against main after T1 landed');
});

test('a base that moves during the head check gets a new check before the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  fs.writeFileSync(path.join(h.base, 'move-main-once'), '');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const checks = headChecks(h);
  assert.equal(checks.length, 2, 'the check against the old base does not authorize the merge');
  assert.notEqual(checks[0].detail.base_sha, checks[1].detail.base_sha);
  assert.equal(checks[1].detail.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('a head replaced during its check is checked again at the new sha before the merge', (t) => {
  const h = queueFixture(t);
  h.git(['switch', '-q', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'Replacement head.\n');
  h.git(['add', 'NOTES.md']);
  h.git(['commit', '-qm', 'replacement head']);
  const replacement = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.moveMain();
  // The owner reworks and reaccepts T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env: fakeAgentEnv(env), encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'owner');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'owner');
const events = ${JSON.stringify(path.join(h.state, 'events.jsonl'))};
const revision = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h.state, 'tasks.json'))}, 'utf8')).tasks.find((x) => x.id === 'T1').revision;
const at = new Date().toISOString();
fs.appendFileSync(events, [
  { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer', role: 'reviewer', rung: 'review', sha: ${JSON.stringify(replacement)}, revision, pid: 999999, attempt: 1 } },
  { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'reviewer', pid: 999999, attempt: 1, code: 0 } },
].map((e) => JSON.stringify(e) + '\\n').join(''));
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'owner');
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the replacement ran during the check');
  assert.deepEqual(headChecks(h).map((e) => [e.detail.sha, e.detail.ok]), [[h.sha, true], [replacement, true]],
    'the check of the old head does not authorize merging the new one');
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], replacement);
  const order = h.logs().filter((e) => e.cmd === 'head check' || e.cmd === 'merge').map((e) => e.cmd);
  assert.deepEqual(order, ['head check', 'head check', 'merge']);
});

test('a head that stops the line and then goes to rework lets the PR behind it merge', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').detail.blocked.task, 'T1');
  assert.equal(h.github().prs['8'].state, 'OPEN');

  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const conflicting = h.github();
  conflicting.prs['7'].mergeable = 'CONFLICTING';
  conflicting.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
});

test('a merged-head suite timeout stops the queue without reworking an accepted task', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
console.log('# Subtest: test/slow.test.js');
setInterval(() => {}, 1000);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const check = headChecks(h).at(-1).detail;
  assert.equal(check.ok, false);
  assert.equal(check.infrastructure_failure, true);
  assert.equal(check.timeout.minutes, 0.05);
  assert.deepEqual(check.timeout.running_files, ['test/slow.test.js']);
  assert.match(check.summary, /timed out after 0\.05 min/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /timed out after 0\.05 min/);
});

test('six queued timeout reactions share one rerun, with fresh runs for changed inputs', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  // Only merged-head runs hang; the submitted head's gate still passes.
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
if (fs.readFileSync('README.md', 'utf8').includes('Independent base update.')) {
  console.log('# Subtest: test/slow.test.js');
  setInterval(() => {}, 1000);
}
`);
  const accept = () => {
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
      '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  };
  accept();
  const run = () => {
    const r = h.run(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(r.code, 1, r.stderr || r.stdout);
    assert.match(r.stdout, /timed out/);
  };
  run();
  const first = headChecks(h).at(-1);
  assert.equal(first.detail.infrastructure_failure, true);
  const queued = Array.from({ length: 6 }, () => ({
    id: `E${require('node:crypto').randomUUID()}`, at: new Date().toISOString(),
    cmd: 'ci completed', agent: 'orchestrator', task: 'T1',
    detail: { sha: h.sha, revision: Number(h.revision('T1')) },
  }));
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), queued.map((e) => JSON.stringify(e) + '\n').join(''));
  const before = h.suites().length;
  h.consume();
  assert.equal(h.suites().length - before, 1, 'six queued reactions run the suite only once more');
  assert.equal(headChecks(h).length, 2);
  const retry = headChecks(h).at(-1);
  assert.equal(retry.detail.rerun_of, first.id);
  const shared = h.logs().filter((e) => e.cmd === 'head check shared');
  assert.ok(shared.length > 0, 'reuse has explicit evidence');
  assert.ok(shared.every((e) => e.detail.source === retry.id && e.detail.infrastructure_failure));
  for (const e of queued) {
    const receipts = h.logs().filter((x) => x.cmd === 'automation' && x.detail.source === e.id);
    assert.ok(receipts.some((x) => x.detail.phase === 'deferred'),
      `queued reaction ${e.id}: ${JSON.stringify(receipts.map((x) => x.detail))}`);
  }
  h.consume();
  run();
  assert.equal(headChecks(h).length, 2, 'later queue passes reuse the timed-out rerun');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);

  const resubmit = (changeHead) => {
    h.ok(['rework', 'T1', '--reason', 'refresh timeout inputs', '--agent', 'orchestrator']);
    if (changeHead) {
      h.git(['switch', '-q', 'fixture-change']);
      fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'New head after timeout.\n');
      h.git(['add', 'NOTES.md']);
      h.git(['commit', '-qm', 'replace timed out head']);
      h.sha = h.git(['rev-parse', 'HEAD']);
      h.git(['switch', '-q', 'main']);
      const gh = h.github();
      gh.prs['7'].headRefOid = h.sha;
      gh.ci[h.sha] = 'success';
      h.saveGithub(gh);
    }
    h.submit();
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
    accept();
  };
  const changes = [
    ['base', () => h.moveMain('README.md', 'Another base update.\n')],
    ['head', () => resubmit(true)],
    ['revision', () => resubmit(false)],
    ['budget', () => h.ok(['project', 'set', '--tests-timeout-min', '0.06', '--agent', 'orchestrator'])],
    ['command', () => {
      const cmd = h.readState('project.json').gates.tests_cmd;
      h.ok(['project', 'set', '--tests-cmd', `${cmd} changed`, '--agent', 'orchestrator']);
      h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
    }],
  ];
  for (const [name, change] of changes) {
    const previous = headChecks(h).at(-1).detail;
    change();
    const count = headChecks(h).length;
    run();
    assert.equal(headChecks(h).length, count + 1, `${name} starts a fresh check`);
    const fresh = headChecks(h).at(-1).detail;
    assert.equal(fresh.rerun_of, undefined, `${name} does not reuse the old timeout`);
    const field = { base: 'base_sha', head: 'sha', revision: 'revision', command: 'command' }[name];
    if (field) assert.notEqual(fresh[field], previous[field], name);
    else assert.notEqual(fresh.timeout.minutes, previous.timeout.minutes, name);
  }
});

for (const setting of ['command', 'mode']) {
  test(`a head check that fails after its ${setting} changed refreshes and merges under current settings`, (t) => {
    const h = queueFixture(t);
    h.moveMain();
    const cmd = h.readState('project.json').gates.tests_cmd;
    const next = setting === 'command' ? `${cmd} again` : cmd;
    const flags = setting === 'command' ? ['--tests-cmd', next] : ['--tests-mode', 'run-only'];
    // The suite fails after its inputs change, so that failure cannot rework the current task.
    fs.writeFileSync(path.join(h.base, 'during-check.js'), `
  const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
  const cp = require('node:child_process');
  cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', ...${JSON.stringify(flags)}, '--agent', 'owner'],
    { cwd: ${JSON.stringify(h.repo)}, env: fakeAgentEnv(${JSON.stringify(h.env)}), encoding: 'utf8' });
  process.exitCode = 1;
  `);
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.consume();
    assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the settings changed during the check');
    assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted', 'the stale failure sends nothing to rework');
    assert.equal(h.logs().some((e) => e.cmd === 'rework' && e.task === 'T1'), false);
    const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(stopped.detail.blocked, null);
    assert.deepEqual(headChecks(h).map((e) => [e.detail.command, e.detail.ok]), [[cmd, false], [next, true]]);
    const tests = softwareEvidence(h, 'T1').filter((e) => e.type === 'tests');
    assert.equal(tests.length, 2, 'the stale receipt was refreshed automatically');
    assert.equal(tests.at(-1).gate_policy.tests_cmd, next);
    assert.equal(tests.at(-1).tests_mode, setting === 'mode' ? 'run-only' : 'prove');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('an accepted PR that already merged without current evidence is confirmed and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  // T1 is a legacy task: its tests evidence no longer passes and its PR
  // landed on GitHub before tower-crane recorded merge evidence.
  // The run and its one rerun both fail, so the evidence does not pass.
  fs.writeFileSync(path.join(h.base, 'fail-runs'), '2');
  h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].mergeCommit = { oid: 'c'.repeat(40) };
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  const receipt = t1.evidence.at(-1);
  assert.deepEqual([receipt.type, receipt.ok, receipt.sha, receipt.ref], ['merge', true, h.sha, 'c'.repeat(40)]);
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8'], 'the landed PR is not merged again');
  assert.equal(h.logs().filter((e) => e.cmd === 'queue skipped').length, 0);
});

test('a head the queue cannot advance is reported once and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(github);
  h.consume();
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[1].evidence.at(-1).type, 'merge');
  const done = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(done.detail.blocked.task, 'T1');
  assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const skips = h.logs().filter((e) => e.cmd === 'queue skipped');
  assert.deepEqual(skips.map((e) => [e.task, e.detail.sha]), [['T1', h.sha]], 'a later pass does not report the same head again');
  assert.match(skips[0].detail.reason, /merged with head f+, not the accepted/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

// T1's supervisor reaches T2's head either after passing T1 over, with nothing
// merged to wake the wait host, or after merging T1.
for (const [name, t1] of [['T1 is passed over', 'OPEN'], ['T1 merges', 'MERGED']]) {
  test(`a supervisor stopping at another task's head hands it to the wait host: ${name}`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.prs['7'].refuseMerge = t1 === 'OPEN';
    h.saveGithub(github);
    // T2's accept reaction already ran while T1's supervisor held the queue and
    // ended deferred, so no receipt or marker of its own keeps it owed.
    const accept = h.logs().findLast((e) => e.cmd === 'accept' && e.task === 'T2');
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), agent: 'orchestrator',
      cmd: 'automation', task: 'T2', detail: { source: accept.id, phase: 'deferred', error: null } })}\n`);
    const script = path.join(h.base, 'supervisor.js');
    fs.writeFileSync(script, `const lib = ${JSON.stringify(path.join(path.dirname(BIN), '..', 'lib'))};
const stateDir = ${JSON.stringify(h.state)};
const events = require(lib + '/state').readEvents(stateDir).filter((e) => e.cmd === 'accept' && e.task === 'T1');
require(lib + '/automation').consume({ stateDir, cwd: ${JSON.stringify(h.repo)}, env: process.env, agent: 'orchestrator',
  flags: {}, pos: [], reactionTask: 'T1' }, events, true).then(() => {}, (e) => { console.error(e); process.exit(1); });
`);
    const run = require('node:child_process').spawnSync(process.execPath, [script], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(h.github().prs['7'].state, t1);
    assert.equal(h.github().prs['8'].state, 'OPEN', 'the supervisor merged nothing of T2');
    const done = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested');
    assert.equal(done.detail.phase, 'done');
    assert.equal(done.detail.blocked.task, 'T2', 'the release names the head it stopped at');
    const handoffs = h.logs().filter((e) => e.cmd === 'automation reconcile' && e.detail.handoff);
    assert.deepEqual(handoffs.map((e) => [e.task, e.detail.handoff, e.detail.sha]), [['T2', 'T1', h.second]]);
    assert.deepEqual(h.json(['status']).gate_queue.queued.map((q) => q.id), ['T2'], 'the handoff is owed in the queue');
    h.consume();
    assert.equal(h.github().prs['8'].state, 'MERGED');
    assert.deepEqual(h.json(['status']).gate_queue.queued, [], 'the merge settled the handoff');
  });
}

for (const failure of ['failView', 'invalidView']) {
  test(`an unreadable queue head (${failure}) is skipped once and the ready PR behind it merges`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.prs['7'][failure] = true;
    h.saveGithub(github);
    const offset = h.logs().length;

    h.ok(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const [t1, t2] = h.readState('tasks.json').tasks;
    assert.equal(t1.status, 'accepted');
    assert.ok(!t1.evidence.some((e) => e.type === 'merge'));
    assert.equal(t2.evidence.at(-1).type, 'merge');
    assert.equal(t2.evidence.at(-1).ok, true);
    const done = h.logs().slice(offset).findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(done.detail.blocked.task, 'T1');
    assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);

    // The confirmed merge event starts another pass while T1 is still unreadable.
    h.consume();
    const events = h.logs().slice(offset);
    assert.ok(events.filter((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').length >= 2);
    assert.ok(!events.some((e) => e.cmd === 'merge queue' && e.detail.phase === 'error'));
    const skips = events.filter((e) => e.cmd === 'queue skipped');
    assert.deepEqual(skips.map((e) => [e.task, e.detail.sha, e.detail.revision]), [['T1', h.sha, t1.revision]]);
    assert.match(skips[0].detail.reason, failure === 'failView'
      ? /Could not resolve PullRequest number 7/ : /cannot read PR #7 mergeability/);
    assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8']);
  });
}

for (const state of ['pending', 'failure']) {
  test(`accepted ${state} CI lets the next PR merge and ${state === 'pending' ? 'waits' : 'reworks'}`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.ci[h.sha] = state;
    h.saveGithub(github);
    assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
    h.consume();
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.status, state === 'pending' ? 'accepted' : 'rework');
    assert.equal(h.github().prs['7'].state, 'OPEN');
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
    assert.equal(reworks.length, state === 'pending' ? 0 : 1);
    if (state === 'failure') assert.equal(reworks[0].detail.gate, 'ci');
  });
}

test('a concurrent CI completion retries a skipped pending head in the next drain pass', async (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const pending = h.github();
  pending.ci[h.sha] = 'pending';
  h.saveGithub(pending);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  const green = h.github();
  green.ci[h.sha] = 'success';
  h.saveGithub(green);

  const paused = path.join(h.base, 'queue-paused');
  const resume = path.join(h.base, 'queue-resume');
  // Hold T2's head check after T1 is skipped, until a second command
  // records T1's passing CI and requests another queue pass.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const until = Date.now() + 300000;
const poll = () => {
  if (fs.existsSync(${JSON.stringify(resume)})) return;
  if (Date.now() > until) throw new Error('queue was not resumed');
  setTimeout(poll, 25); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  const offset = h.logs().length;
  const first = h.runAsync(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
  let result;
  try {
    await waitFor(paused, { what: 'T2 holds the queue after T1 is skipped' });
    const skipped = h.logs().slice(offset).find((e) => e.cmd === 'queue skipped');
    assert.equal(skipped?.task, 'T1');
    assert.match(skipped.detail.reason, /ci: latest ci .* pending/);
    h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
    assert.ok(h.logs().slice(offset).some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested'));
  } finally {
    fs.writeFileSync(resume, '');
    result = await first;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7'],
    'both commands finish with both PRs merged, without a later notification');
  for (const task of h.readState('tasks.json').tasks) {
    const receipt = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(receipt?.ok, true, task.id);
    assert.equal(receipt.sha, task.sha);
  }
  const events = h.logs().slice(offset);
  assert.equal(events.filter((e) => e.cmd === 'queue skipped').length, 1);
  const passes = events.filter((e) => e.cmd === 'merge queue');
  assert.equal(passes.filter((e) => e.detail.phase === 'running').length, 2);
  assert.equal(passes.at(-1).detail.phase, 'done');
  assert.equal(passes.at(-1).detail.blocked, null);
  assert.deepEqual(passes.at(-1).detail.skipped, []);
});

test('merge --accepted waits for a free gate executor before its head check', async (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--executors', '1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  // Another process's suite holds the only executor; this live pid stands in for it.
  const events = path.join(h.state, 'events.jsonl');
  const lease = (detail) => fs.appendFileSync(events, `${JSON.stringify({ id: `E${randomUUID()}`, at: new Date().toISOString(),
    agent: 'orchestrator', cmd: 'executor', task: 'T2', detail: { lease: 'cpu:held', ...detail } })}\n`);
  lease({ phase: 'running', kind: 'tests', pid: process.pid, ...identity(process.pid) });
  const suites = h.suites().length;
  const start = h.logs().length;
  let stderr = '';
  let child;
  const merging = h.runAsync(['merge', '--accepted', '--agent', 'orchestrator'],
    { onSpawn: (c) => { child = c; c.stderr.on('data', (d) => { stderr += d; }); } });
  try {
    await waitUntil(() => /\[head check\] T1 waits for a free gate executor \(1 of 1 in use\)/.test(stderr),
      { alive: child, what: () => `merge --accepted waits for the executor: ${stderr}` });
    assert.equal(h.suites().length, suites, 'no head check runs while the slot is held');
    assert.equal(headChecks(h).length, 0);
  } finally {
    lease({ phase: 'done' });
  }
  const r = await merging;
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true]]);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.deepEqual(h.logs().slice(start).filter((e) => e.cmd === 'executor' && e.detail.phase === 'running')
    .map((e) => [e.task, e.detail.kind]), [['T1', 'head check']]);
});
