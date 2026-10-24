'use strict';

// Merges in the event reaction, post-merge conflicts, UNKNOWN heads and the gate
// executors several watchers share: limits, queue order and prioritize.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HUNG_TEST_MS, waitUntil, fileWritten, killPid } = require('./signals');
const { cachedFixture, assertNoProcessesIn } = require('./helpers');
const { gateEvidence } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { readPublished } = require('./atomic-file');
const { setup, holdSuite, ghStub } = require('./automation-helpers');
const { writeHost } = require('./host');

// The task of each CPU executor lease, in the order the leases started. A
// reaction itself holds none: one that waits for a slot runs again to take it.
function executorStarts(h) {
  const seen = new Set();
  return h.logs().filter((e) => e.cmd === 'executor' && e.detail.phase === 'running'
    && !seen.has(e.detail.lease) && seen.add(e.detail.lease)).map((e) => e.task);
}

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const spawns = () => h.logs().filter((e) => e.cmd === 'spawn').length;
  const recorded = spawns();
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(spawns(), recorded);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('wait stops post-merge conflict work on the first signal without reworking another task', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX signals' : false,
}, async (t) => {
  for (const [stage, forced] of [['view 8', false], ['view 8', true], ['view 9', false], ['trial', false], ['merge event', false]]) {
    await t.test(`${stage}${forced ? ' twice' : ''}`, async (t) => {
      const h = cachedFixture(null, 'wait-conflict-sweep', (repo) => {
        const h = setup(null, { repo, kind: 'docs' });
        h.submit();
        for (const [id, number, conflicting] of [['T2', '8', false], ['T3', '9', true]]) {
          const branch = `other-${id}`;
          h.git(['switch', '-qc', branch, 'main']);
          fs.writeFileSync(path.join(h.repo, conflicting ? 'value.js' : 'other.txt'),
            conflicting ? 'module.exports = 2;\n' : 'independent change\n');
          h.git(['add', '.']);
          h.git(['commit', '-qm', branch]);
          const sha = h.git(['rev-parse', 'HEAD']);
          h.ok(['task', 'add', '--title', id, '--acceptance', 'works', '--kind', 'docs']);
          const github = h.github();
          github.prs[number] = { ...github.prs['7'], headRefOid: sha, headRefName: branch };
          github.advanceBase = true;
          h.saveGithub(github);
          h.submit(id, sha, number);
        }
        h.reviewer('T1', 'reviewer');
        h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
        h.ok(['project', 'set', '--paused', 'manual conflict sweep']);
        return { sha: h.sha };
      });
      h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
      const cursor = JSON.parse(h.run(['wait', '--timeout', '0', '--agent', 'orchestrator']).stdout).offset;
      if (stage === 'merge event') {
        h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
        h.ok(['accept', 'T1', '--agent', 'orchestrator']);
        h.ok(['merge', 'T1', '--agent', 'orchestrator']);
      }
      const started = path.join(h.base, 'sweep-started');
      const release = path.join(h.base, 'release-sweep');
      const observed = path.join(h.base, 'signal-observed');
      const calls = path.join(h.base, 'gh-calls.jsonl');
      const wrapper = path.join(h.base, 'held-sweep-gh.js');
      const heldPr = stage === 'view 9' ? '9' : '8';
      fs.writeFileSync(wrapper, `const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (${stage !== 'trial'} && args[0] === 'pr' && args[1] === 'view' && args[2] === ${JSON.stringify(heldPr)}) {
  fs.writeFileSync(${JSON.stringify(started)}, '');
  const poll = () => fs.existsSync(${JSON.stringify(release)}) ? require(${JSON.stringify(ghStub)}) : setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
  poll();
} else require(${JSON.stringify(ghStub)});
`);
      fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(wrapper)});\n`);
      const preload = path.join(h.base, 'sweep-observer.js');
      fs.writeFileSync(preload, `const fs = require('node:fs');
process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(observed)}, 'SIGTERM\\n'));
if (${stage === 'merge event'}) require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation'))}).backlog = () => [];
if (${stage === 'trial'}) {
  const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'gates', 'common'))}), git = C.git;
  C.git = async (...args) => {
    const result = await git(...args);
    // read-published: the gh stub appends calls; nothing replaces the file.
    const log = fs.existsSync(${JSON.stringify(calls)}) ? fs.readFileSync(${JSON.stringify(calls)}, 'utf8') : '';
    if (args[2][0] === 'merge' && args[2].includes('--no-commit') && log.includes('["pr","view","9"')) {
      fs.writeFileSync(${JSON.stringify(started)}, '');
      await new Promise(resolve => {
        const poll = () => fs.existsSync(${JSON.stringify(release)}) ? resolve() : setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
        poll();
      });
    }
    return result;
  };
}
`);
      // Cleanup stops any worker this wait host dispatches, should the fixture ever unpause.
      const child = h.spawnCli(['wait', '--after', String(cursor), '--types', 'never', '--timeout', '300', '--agent', 'orchestrator'],
        { pre: ['--require', preload] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      const bound = setTimeout(() => child.kill('SIGKILL'), HUNG_TEST_MS);
      t.after(async () => {
        clearTimeout(bound);
        fs.writeFileSync(release, '');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await result;
        await h.cleanup();
        assertNoProcessesIn(t, h.base);
      });
      await waitFor(started, { what: 'the post-merge sweep starts' });
      assert.equal(h.github().prs['7'].state, 'MERGED');
      const before = h.readState('tasks.json').tasks.slice(1);
      child.kill('SIGTERM');
      await waitFor(observed, { what: 'wait observes the signal during the sweep' });
      const count = fs.readFileSync(calls, 'utf8').trim().split('\n').length;
      if (forced) child.kill('SIGTERM');
      else fs.writeFileSync(release, '');
      const exit = await result;
      assert.equal(exit.code, 0, JSON.stringify(exit));
      assert.match(exit.stdout, /stopped by SIGTERM after draining 0 gates/);
      assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, count, 'no further PR inspection starts');
      assert.deepEqual(h.readState('tasks.json').tasks.slice(1), before, 'no conflict note, rework or generated repair changes another task');
      const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.findLast((e) => e.cmd === 'automation').detail.phase, 'deferred');
      assert.equal(events.some((e) => e.cmd === 'automation' && e.task !== 'T1' && e.detail.phase === 'running'), false, 'no repair executor is claimed');
      assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    });
  }
});

test('startup reconciles a newly conflicting PR after a merge happened without a waiter', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.consume();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'other submitted change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const state = h.github();
  state.prs['8'] = { ...state.prs['7'], headRefOid: other, headRefName: 'other-change' };
  h.saveGithub(state);
  h.submit('T2', other, '8');
  h.consume();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[1].status, 'submitted');
  const ci = h.logs().findLast((e) => e.cmd === 'check ci' && e.task === 'T2');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === ci.id && e.detail.phase === 'done'));

  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const changed = h.github();
  changed.advanceBase = true;
  h.saveGithub(changed);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const conflicting = h.github();
  conflicting.prs['8'].mergeable = 'CONFLICTING';
  conflicting.prs['8'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  const before = h.git(['rev-parse', 'HEAD']);
  // Keep worker refill out of this conflict-reconciliation probe.
  h.ok(['project', 'set', '--paused', 'manual startup conflict probe']);
  // The CLI helper bounds hangs without imposing a reconciliation deadline.
  const event = JSON.parse(h.ok(['wait', '--task', 'T2', '--types', 'rework', '--agent', 'orchestrator']));
  assert.equal(event.task, 'T2');
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'worker').length, 0);
  assert.match(task.notes.at(-1).text, /value\.js/);
  assert.equal(h.git(['rev-parse', 'HEAD']), before);
});

test('a matching UNKNOWN head runs submission gates during the same wait', async (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
  state.becomeMergeableAfterView = true;
  h.saveGithub(state);
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(result.code, 2, result.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)).map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
  assert.equal(task.status, 'submitted');
  assert.equal(h.github().prs['7'].mergeable, 'MERGEABLE');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const unknown = h.github();
  unknown.prs['7'].mergeable = unknown.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(unknown);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
    'UNKNOWN still blocks acceptance even with earlier passing CI and independent review');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci').pending, true,
    'UNKNOWN replaces a passing CI receipt with a pending receipt for the timer');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a submitted PR that GitHub reports UNKNOWN, then CONFLICTING, goes to rework before any suite runs', (t) => {
  const h = setup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'main moves value']);
  h.submit();
  // Submit reads the PR's mergeability before this test turns it UNKNOWN; count only the reaction's reads.
  const submitViews = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length;
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', unknownViews: 1 });
  h.saveGithub(github);
  h.ok(['project', 'set', '--paused', 'manual conflict probe']);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.logs().filter((e) => ['check tests', 'check clean'].includes(e.cmd)).length, 0, 'no suite or clean runs');
  assert.equal(h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length - submitViews, 2, 'the UNKNOWN read is retried once');
});

test('startup retains gate evidence when main moves and the submitted head stays mergeable', (t) => {
  const h = setup(t);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0].evidence;
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  h.consume();
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.evidence, before);
  assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'pending' });
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub pending wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t);
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

// A slow stub suite records each run's start and end, so the log shows how
// many gate executors ran at once across every consumer process. With
// `release`, a run records its pid in its start file and waits for the release
// file; it also stops when its start file is gone or after SLOW_SUITE_MS, so a
// test that fails first cannot leave it polling. The start file goes with the
// fixture. A run does not watch the fixture directory itself: the run and its
// shell work in a gate worktree inside it, and Windows cannot remove a
// directory that is a live process's working directory. Teardown releases and
// stops every recorded run before the fixture is removed.
const SLOW_SUITE_MS = 240000;
function slowSuite(h, { executors, crash = false, release = null, hold = 1, pr = false, fail = false } = {}) {
  const runs = path.join(h.base, 'suite-runs.log');
  const suite = path.join(h.base, 'tools', 'slow-suite.js');
  if (release) h.teardown.push(() => stopSlowSuites(h, release));
  fs.writeFileSync(suite, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runs)}, '+\\n');
const crash = ${JSON.stringify(crash ? path.join(h.base, 'crashed') : null)};
if (crash && !fs.existsSync(crash)) {
  fs.writeFileSync(crash, '');
  const events = fs.readFileSync(${JSON.stringify(path.join(h.state, 'events.jsonl'))}, 'utf8').trim().split('\\n').map(JSON.parse);
  require(${JSON.stringify(path.join(__dirname, 'signals'))}).killPid(events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
}
const finish = () => { fs.appendFileSync(${JSON.stringify(runs)}, '-\\n'); process.exitCode = ${fail ? 1 : 0}; };
const release = ${JSON.stringify(release)};
if (release) {
  const starts = fs.readFileSync(${JSON.stringify(runs)}, 'utf8').split('\\n').filter((m) => m === '+').length;
  const started = ${JSON.stringify(path.join(h.base, 'suite-started-'))} + starts;
  fs.writeFileSync(started, String(process.pid));
  const until = Date.now() + ${SLOW_SUITE_MS}; // wait-allow: an orphaned suite stops itself; release and start-file removal are its signals
  const poll = () => {
    if (!fs.existsSync(started) || Date.now() > until) process.exit(1);
    if (starts < ${hold} || fs.existsSync(release)) finish();
    else setTimeout(poll, 50); // wait-allow: probe cadence only; the suite has no file watcher inside its fixture
  };
  poll();
} else {
  setTimeout(finish, 2500); // wait-allow: exercise overlapping gate completions with staggered commands
}
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    ...(executors ? ['--executors', String(executors)] : []), '--agent', 'orchestrator']);
  for (const id of ['T1', 'T2', 'T3']) {
    if (id !== 'T1') h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, ...(pr && id === 'T1' ? ['--pr', '7'] : []), '--agent', 'worker']);
  }
  return () => {
    let now = 0;
    let peak = 0;
    const marks = fs.existsSync(runs) ? readPublished(runs, 'utf8').trim().split('\n') : [];
    for (const mark of marks) peak = Math.max(peak, now += mark === '+' ? 1 : -1);
    return { starts: marks.filter((m) => m === '+').length, peak };
  };
}

test('wait drains on either signal without starting another gate, and a second signal stops the gate', {
  skip: process.platform === 'win32' ? 'Windows child.kill does not deliver POSIX signals' : false,
}, async (t) => {
  for (const [signal, forced, stage] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', true], ['SIGTERM', true, 'proof'], ['SIGTERM', true, 'sources'], ['SIGTERM', false, 'idle'], ['SIGINT', false, 'observe'], ['SIGTERM', false, 'follow'], ['SIGTERM', false, 'pr'], ['SIGTERM', true, 'ci'], ['SIGTERM', false, 'failure']]) {
    const proof = stage === 'proof';
    const sources = stage === 'sources';
    const idle = ['idle', 'observe', 'follow'].includes(stage);
    const json = signal === 'SIGINT' || stage === 'follow';
    const github = stage === 'pr' || stage === 'ci';
    await t.test(`${signal}${forced ? ' twice' : ''}${stage ? ` during ${stage}` : ''}`, async (t) => {
      const h = cachedFixture(null, `wait-drain-${sources ? 'research' : 'code'}`, (repo) => {
        const h = setup(null, { repo, kind: sources ? 'research' : 'code' });
        if (sources) {
          fs.mkdirSync(path.join(h.repo, 'research'));
          fs.writeFileSync(path.join(h.repo, 'research', 'T1.json'), JSON.stringify({
            sources: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, url: `https://source.example/${i}` })),
            claims: Array.from({ length: 10 }, (_, i) => ({ claim: `Claim ${i}`, quote: `Quote ${i}`, source: `s${i}` })),
          }));
          h.git(['add', 'research']);
          h.git(['commit', '-qm', 'research sources']);
          h.sha = h.git(['rev-parse', 'HEAD']);
          const github = h.github();
          github.prs['7'].headRefOid = h.sha;
          github.ci[h.sha] = 'pending';
          h.saveGithub(github);
        }
        return { sha: h.sha };
      });
      h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const release = path.join(h.base, 'release-suite');
      const heldRun = proof ? 2 : 1;
      const runs = idle ? null : slowSuite(h, { executors: 1, release, hold: heldRun, pr: github, fail: stage === 'failure' });
      if (proof) h.ok(['project', 'set', '--tests-mode', 'prove', '--agent', 'orchestrator']);
      if (github) {
        if (stage === 'ci') {
          fs.writeFileSync(release, '');
          h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
          h.ok(['check', 'clean', 'T1', '--agent', 'orchestrator']);
          fs.unlinkSync(release);
        }
        const stub = path.join(h.base, 'held-gh.js');
        fs.writeFileSync(stub, `const fs = require('node:fs');
const args = process.argv.slice(2);
const held = ${JSON.stringify(stage)} === 'pr'
  ? args[0] === 'pr' && args[1] === 'view'
  : args[0] === 'api' && args[1].includes('check-runs');
if (held) {
  // Teardown signals this pid, so it must never read the file empty.
  require(${JSON.stringify(path.join(__dirname, 'atomic-file'))}).writeAtomic(${JSON.stringify(path.join(h.base, 'github-started'))}, String(process.pid));
  const poll = () => {
    if (fs.existsSync(${JSON.stringify(release)})) require(${JSON.stringify(ghStub)});
    else setTimeout(poll, 25); // wait-allow: probe cadence only; the release file is the signal
  };
  poll();
} else require(${JSON.stringify(ghStub)});
`);
        fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(stub)});\n`);
      }
      const observed = path.join(h.base, 'signal-observed');
      const preload = path.join(h.base, 'signal-observer.js');
      // A receipt synchronizes the test with signal delivery before it releases the gate.
      fs.writeFileSync(preload, `const fs = require('node:fs');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => fs.appendFileSync(${JSON.stringify(observed)}, signal + '\\n'));
`);
      if (idle) {
        fs.appendFileSync(preload, `
const watch = fs.watch;
fs.watch = (...args) => {
  const watcher = watch(...args);
  fs.writeFileSync(${JSON.stringify(path.join(h.base, 'suite-started-1'))}, '');
  return watcher;
};
`);
      }
      if (sources) {
        fs.appendFileSync(preload, `
require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'public-http'))}).fetchPublic = (url, opts) => new Promise((resolve, reject) => {
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'suite-runs.log'))}, '+\\n');
  fs.writeFileSync(${JSON.stringify(path.join(h.base, 'suite-started-1'))}, String(process.pid));
  const pending = setInterval(() => {}, 1000);
  opts.signal.addEventListener('abort', () => {
    fs.writeFileSync(${JSON.stringify(path.join(h.base, 'fetch-aborted'))}, opts.signal.reason.name);
    clearInterval(pending);
    reject(opts.signal.reason);
  }, { once: true });
});
`);
      }
      // An idle wait host refills worker slots, and cleanup stops the worker it dispatches.
      const child = h.spawnCli(['wait', '--after', '0', '--types', 'never',
        ...(stage === 'follow' ? ['--follow'] : ['--timeout', '300']),
        ...(stage === 'observe' ? ['--observe'] : []), ...(json && stage !== 'follow' ? ['--json'] : []), '--agent', 'orchestrator'],
      { pre: ['--require', preload] });
      const started = path.join(h.base, github ? 'github-started' : `suite-started-${heldRun}`);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stderr }));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), HUNG_TEST_MS);
      t.after(async () => {
        clearTimeout(timer);
        fs.writeFileSync(release, '');
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await result;
        if (github && fs.existsSync(started)) {
          try { killPid(Number(readPublished(started, 'utf8')), 'SIGKILL'); }
          catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
        await h.cleanup();
        assertNoProcessesIn(t, h.base);
      });
      await waitFor(started, { what: idle ? 'wait is ready' : 'the gate starts' });
      child.kill(signal);
      if (github) {
        await waitFor(observed, { what: 'the held GitHub command does not block signal delivery' });
      }
      await waitFor(observed, { what: 'the wait process receives the signal' });
      if (!idle) assert.equal(child.exitCode, null, 'the running gate still holds wait open');
      if (forced) {
        child.kill(github ? 'SIGINT' : signal);
      } else {
        fs.writeFileSync(release, '');
      }
      const exit = await result;
      assert.equal(exit.code, 0, JSON.stringify(exit));
      if (!idle) {
        assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1,
          'shutdown removes the gate worktree registration before releasing the executor');
        assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
          'shutdown leaves the interrupted reaction available for gate retry');
      }
      const drained = forced || idle || stage === 'pr' ? 0 : 1;
      if (json) {
        const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
        if (stage === 'follow') assert.equal(lines[0].type, 'ready', 'the follower retains its ready record');
        assert.equal(lines.length, stage === 'follow' ? 2 : 1, 'only the stop notice follows readiness');
        assert.deepEqual(lines.at(-1), { reason: 'signal', signal, drained }, 'the stop notice distinguishes a signal from a wake or timeout');
      } else {
        assert.equal(stdout.trim(), `stopped by ${signal} after draining ${drained} gate${drained === 1 ? '' : 's'}`);
      }
      const receipts = h.logs().filter((e) => e.cmd === 'automation');
      if (github) {
        const task = h.readState('tasks.json').tasks[0];
        if (stage === 'pr') {
          assert.deepEqual(task.evidence, [], 'no gate starts after signal delivery during PR inspection');
        } else {
          assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
          const pid = Number(fs.readFileSync(started, 'utf8'));
          assert.equal(require('../lib/processes').processState({ pid }), 'exited', 'the second signal stops the GitHub query');
          assert.equal(fs.existsSync(release), false, 'the query stops without its release file');
          assert.equal(task.evidence.at(-1).confirmed_failure, undefined);
        }
        assert.equal(receipts.at(-1).detail.phase, 'deferred', 'the GitHub reaction releases its lease');
        assert.ok(h.readState('tasks.json').tasks.slice(1).every((t) => !t.evidence.length), 'queued gates stay pending');
        return;
      }
      if (idle) {
        assert.deepEqual(receipts, [], 'idle shutdown claims no automation work');
        return;
      }
      // A failing suite reruns once inside the gate that drains; that is the gate's own command, not a queued gate.
      assert.deepEqual(runs(), { starts: heldRun + (stage === 'failure' ? 1 : 0), peak: 1 }, 'no queued gate starts during shutdown');
      assert.deepEqual(receipts.filter((e) => e.detail.phase === 'running').map((e) => e.task), ['T1']);
      assert.equal(receipts.at(-1).detail.phase, 'deferred', 'the executor lease is released for a retry');
      const tasks = h.readState('tasks.json').tasks;
      assert.deepEqual(tasks[0].evidence.map((e) => [e.type, e.ok]), [[sources ? 'sources' : 'tests', !forced && stage !== 'failure']],
        'the active gate is recorded, and the next gate is left for a retry');
      assert.ok(tasks.slice(1).every((task) => !task.evidence.length), 'other tasks keep their pending gates');
      if (forced) {
        assert.equal(fs.existsSync(release), false, 'the second signal finishes without releasing the gate');
        if (sources) assert.equal(fs.readFileSync(path.join(h.base, 'fetch-aborted'), 'utf8'), 'AbortError', 'the signal cancels the fetch before its timeout');
        const gatePid = Number(fs.readFileSync(path.join(h.base, `suite-started-${heldRun}`), 'utf8'));
        assert.equal(require('../lib/processes').processState({ pid: gatePid }), 'exited', 'the gate process was stopped');
        if (!sources) assert.ok(tasks[0].evidence[0].commands.some((c) => c.signal === 'SIGKILL'), 'the command tree was killed');
        assert.equal(tasks[0].evidence[0].confirmed_failure, undefined, 'interruption is not a confirmed test failure');
      }
      if (forced && !stage) {
        // The interrupted run checked nothing: the next reaction runs it again, and its one retry
        // is still there for a crash of that run.
        assert.equal(tasks[0].evidence[0].voided, true);
        for (const id of ['T2', 'T3']) h.ok(['task', 'update', id, '--status', 'cancelled']);
        const once = path.join(h.base, 'crashed-once');
        fs.writeFileSync(path.join(h.base, 'tools', 'slow-suite.js'), `const fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(once)})) { fs.writeFileSync(${JSON.stringify(once)}, ''); process.kill(process.pid, 'SIGKILL'); }
`);
        h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
        const after = h.readState('tasks.json').tasks[0];
        assert.deepEqual([after.status, after.revision], ['submitted', tasks[0].revision]);
        assert.ok(!h.logs().some((e) => e.cmd === 'rework'), 'a void never reworks');
        assert.deepEqual(after.evidence.filter((e) => e.type === 'tests').map((e) => [e.ok, !!e.voided, !!e.runner_crash]),
          [[false, true, true], [false, false, true], [true, false, false]]);
      }
      if (forced && proof) {
        // accept reruns a void like a missing gate instead of asking for an explicit check.
        assert.equal(tasks[0].evidence[0].voided, true);
        fs.writeFileSync(release, '');
        const accepted = h.run(['accept', 'T1', '--agent', 'orchestrator']);
        assert.match(accepted.stderr, /running voided tests software gate/);
        const tests = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests');
        // The slow suite passes without the change too, so the rerun records a real proof verdict.
        assert.deepEqual(tests.map((e) => [e.ok, !!e.voided]), [[false, true], [false, false]]);
        assert.match(tests.at(-1).summary, /do not prove it/);
      }
    });
  }
});
function slowSuiteStarts(h) {
  return fs.readdirSync(h.base).filter((f) => f.startsWith('suite-started-')).map((f) => path.join(h.base, f));
}

function slowSuitePids(h) {
  return slowSuiteStarts(h).map((f) => Number(fs.readFileSync(f, 'utf8'))).filter((pid) => pid > 0);
}

function slowSuiteRunning(pid) {
  if (process.platform === 'linux') {
    try { return !/^\S+ \(.*\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
  }
  try { killPid(pid, 0); return true; } catch { return false; }
}

async function stopSlowSuites(h, release) {
  if (!fs.existsSync(h.base)) return;
  const pids = slowSuitePids(h);
  fs.writeFileSync(release, '');
  // Teardown only: released suites get a grace before survivors are killed.
  const until = Date.now() + 5000; // wait-allow: teardown grace before killing released suites
  while (pids.some(slowSuiteRunning) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50)); // wait-allow: teardown grace before killing released suites
  for (const pid of pids.filter(slowSuiteRunning)) {
    try { killPid(pid, 'SIGKILL'); } catch { /* It exited meanwhile. */ }
  }
}

test('gate executors across several watchers stay within gates.executors and queue the rest in order', async (t) => {
  const h = setup(t);
  const release = path.join(h.base, 'release-suite');
  const runs = slowSuite(h, { release });
  assert.match(h.ok(['project', 'show']), /gates\.executors: 2/);
  // Keep consumers alive until the last task's gate evidence, including contended startup.
  const watchers = [0, 1, 2].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'evidence', '--task', 'T3',
      '--timeout', '300', '--agent', 'orchestrator']));
  let results;
  let waiter;
  try {
    assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-2')), null, 'two executors start');
    // Keep both slots occupied until a watcher has queued the third suite.
    // Fresh reactions race for the slots, so any of the three can be the one waiting.
    await waitUntil(() => h.logs().some((e) => e.cmd === 'automation queued' && e.detail.executors === 2),
      { paths: [h.state], what: 'a third suite queues for an executor' });
    const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.detail.executors === 2);
    assert.equal(new Set(queued.map((e) => e.task)).size, 1, JSON.stringify(queued));
    waiter = queued[0].task;
    fs.writeFileSync(release, '');
    assert.notEqual(await fileWritten(path.join(h.base, 'suite-started-3')), null, 'the third executor starts');
  } finally {
    fs.writeFileSync(release, '');
    results = await Promise.all(watchers);
  }
  assert.ok(results.every((r) => r.code === 0 && JSON.parse(r.stdout).type === 'evidence'), JSON.stringify(results));
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
  // A successful manual observation schedules a later reaction without another tests run.
  const beforeFollowUp = h.logs().length;
  h.ok(['check', 'clean', 'T2']);
  h.consume();
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  assert.ok(h.logs().slice(beforeFollowUp).some((e) => e.cmd === 'automation'
    && e.detail.phase === 'running' && e.task === 'T2'), 'a later observation runs without restarting its suite');
  const firstStarts = executorStarts(h);
  assert.deepEqual(new Set(firstStarts), new Set(['T1', 'T2', 'T3']));
  assert.equal(firstStarts.at(-1), waiter, 'the queued suite runs after a slot frees');
});

// The orphans this guards against: a test killed with its runner's process
// group before it released its suites, so its teardown never ran, and the
// fixture then removed with the tests gate's temporary directory.
test('slow suites stop when their fixture is removed before they are released', async (t) => {
  const h = setup(t);
  const release = path.join(h.base, 'release-suite');
  slowSuite(h, { release });
  const watchers = [0, 1].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'evidence', '--task', 'T3',
      '--timeout', '300', '--agent', 'orchestrator']));
  let pids = [];
  // A failed wait below must not leave the suites polling after the test.
  t.after(() => { for (const pid of pids.filter(slowSuiteRunning)) killPid(pid, 'SIGKILL'); });
  await waitUntil(() => (pids = slowSuitePids(h)).length >= 2, { what: 'two executors start' });
  assert.equal(pids.length, 2, 'two executors start');
  for (const e of h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running')) {
    try { killPid(e.detail.pid, 'SIGKILL'); } catch { /* It exited already. */ }
  }
  await Promise.all(watchers);
  // Windows cannot remove the fixture while the suites and their shells work
  // in it, so there the removal takes what it can first: the start files.
  if (process.platform === 'win32') for (const file of slowSuiteStarts(h)) fs.rmSync(file);
  else fs.rmSync(h.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await waitUntil(() => !pids.some(slowSuiteRunning), {
    what: () => `a slow suite outlived its fixture: ${pids.filter(slowSuiteRunning).join(', ')}`,
  });
});

test('a killed executor releases its gate executor slot', async (t) => {
  const h = setup(t);
  const runs = slowSuite(h, { executors: 1, crash: true });
  const preload = path.join(h.base, 'executor-creation.js');
  fs.writeFileSync(preload, `const P = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'processes'))});
const identity = P.identity;
P.identity = (pid, options) => {
  const record = identity(pid, options);
  // Linux can exercise the receipt wiring while Windows uses its real creation time.
  return process.platform !== 'win32' && pid === process.pid && options?.created
    ? { ...record, created: 100 } : record;
};
`);
  const consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { pre: ['--require', preload] });
  const killed = consume();
  assert.notEqual(killed.code, 2, 'the suite kills the first executor');
  const retried = await h.runAsync(['wait', '--after', '0', '--types', 'evidence', '--task', 'T3',
    '--timeout', '300', '--agent', 'orchestrator'], { pre: ['--require', preload] });
  assert.equal(retried.code, 0, JSON.stringify(retried));
  assert.equal(runs().starts, 4, JSON.stringify({ killed, retried, events: h.logs() }));
  const receipts = h.logs().filter((e) => ['automation', 'executor', 'gate run'].includes(e.cmd) && e.detail.phase === 'running');
  assert.deepEqual(new Set(receipts.map((e) => e.cmd)), new Set(['automation', 'executor', 'gate run']));
  for (const receipt of receipts) {
    assert.ok(Number.isFinite(receipt.detail.created) || Number.isFinite(receipt.detail.seen), receipt.cmd);
  }
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => e.type), ['tests', 'clean'], task.id);
  }
});

test('Windows executor leases distinguish a reused PID from the recorded process', (t) => {
  const A = require('../lib/automation');
  const S = require('../lib/state');
  const os = require('node:os');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const holderCreated = S.holderCreated;
  for (const row of [
    { name: 'same process', created: 100, observed: 100, count: 1 },
    { name: 'reused PID', created: 100, observed: 200, count: 0 },
    { name: 'creation time unavailable', created: 100, observed: null, count: 1 },
    { name: 'process exits during the creation query', created: 100, observed: null, exits: true, count: 0 },
    { name: 'legacy receipt without creation time', observed: 200, count: 1 },
    { name: 'finished lease', created: 100, observed: 100, phase: 'done', count: 0 },
    { name: 'lease on another host', created: 100, observed: 200, host: 'another-host', count: 0 },
  ]) {
    let leases;
    try {
      let gone = false;
      t.mock.method(process, 'kill', (pid, signal) => {
        assert.equal(pid, process.pid);
        assert.equal(signal, 0);
        if (gone) throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
      });
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      S.holderCreated = (_pid, created) => {
        gone = !!row.exits;
        return row.observed === null ? null : row.observed === created;
      };
      leases = A.cpuLeases({ events: [{ cmd: 'executor', task: 'T1', detail: {
        lease: 'killed-lease', phase: row.phase || 'running', pid: process.pid,
        host: row.host || os.hostname(), ...(row.created === undefined ? {} : { created: row.created }),
      } }] });
    } finally {
      t.mock.restoreAll();
      Object.defineProperty(process, 'platform', platform);
      if (holderCreated === undefined) delete S.holderCreated;
      else S.holderCreated = holderCreated;
    }
    assert.equal(leases.length, row.count, row.name);
  }
});

test('older queued work takes a freed executor slot before a newer arrival', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const suite = path.join(h.base, 'tools', 'stall-suite.js');
  // The first run holds the only slot until T2 is queued behind it, then
  // dies, leaving a free slot and T2 still waiting.
  fs.writeFileSync(suite, `const fs = require('node:fs');
const flag = ${JSON.stringify(path.join(h.base, 'stalled'))};
if (fs.existsSync(flag)) process.exit(0);
fs.writeFileSync(flag, '');
const read = () => fs.readFileSync(${JSON.stringify(events)}, 'utf8').trim().split('\\n').map(JSON.parse);
const until = Date.now() + 300000;
const poll = () => {
  const log = read();
  if (log.some((e) => e.cmd === 'automation queued' && e.task === 'T2') || Date.now() > until) {
    require(${JSON.stringify(path.join(__dirname, 'signals'))}).killPid(log.findLast((e) => e.cmd === 'executor' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
    process.exit(1);
  }
  setTimeout(poll, 50); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
};
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['task', 'add', '--title', 'Change T3', '--acceptance', 'it works', '--kind', 'code']);
  for (const id of ['T1', 'T2']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(path.join(h.base, 'stalled'), { what: 'the first executor starts' });
  h.consume();
  assert.notEqual((await holder).code, 2, 'the stalled executor is killed');
  assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T2' && e.detail.executors === 1));
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(executorStarts(h), ['T1', 'T1', 'T2', 'T3'], 'queued T1 and T2 run before the newer T3');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

// A drain can pass over T1 while its reaction is alive and reach T2 after it
// died, so the dead reaction must still rank ahead of T2 for the freed slot.
test('an owed older reaction outranks a newer executor waiter only while it waits or died running', () => {
  const A = require('../lib/automation');
  const P = require('../lib/processes');
  const sha = 'a'.repeat(40);
  const tasks = ['T1', 'T2'].map((id) => ({ id, status: 'submitted', sha, revision: 1, evidence: [] }));
  const submits = tasks.map((task) => ({ id: `submit-${task.id}`, task: task.id, cmd: 'submit', detail: { sha, revision: 1 } }));
  const governor = { task: 'T1', kind: 'tests', until: Date.now() + 5000, reason: 'pressure' };
  for (const [name, receipt, outranks] of [
    ['waits for an executor', { phase: 'executor', kind: 'tests' }, true],
    ['died running', { phase: 'running', pid: 2147483647 }, true],
    ['running', { phase: 'running', pid: process.pid, ...P.identity(process.pid) }, false],
    ['running unobservably on another host', { phase: 'running', pid: process.pid, host: 'another-host' }, false],
    ['deferred by the governor', { phase: 'deferred', governor }, false],
    ['done', { phase: 'done' }, false],
    ['failed', { phase: 'error' }, false],
  ]) {
    const events = [...submits,
      ...submits.map((e) => ({ cmd: 'automation queued', task: e.task, detail: { source: e.id } })),
      { cmd: 'automation', task: 'T1', at: new Date().toISOString(), detail: { source: 'submit-T1', ...receipt } },
      { cmd: 'automation', task: 'T2', at: new Date().toISOString(), detail: { source: 'submit-T2', phase: 'executor', kind: 'tests' } }];
    const st = { project: {}, tasks: { tasks }, events };
    assert.equal(A.outranked(st, submits[1])?.task ?? null, outranks ? 'T1' : null, `T2 behind T1 ${name}`);
    assert.equal(A.outranked(st, submits[0]), null, `T1 ${name} is never behind the newer T2`);
  }
});

// The merge line runs under whichever reaction drains it, here a merged T3's
// merge reaction, so the head check's turn comes from the task it checks.
test('a head check ranks by the accepted task it checks, not by the reaction that runs the line', () => {
  const A = require('../lib/automation');
  const P = require('../lib/processes');
  const sha = 'a'.repeat(40);
  const at = new Date().toISOString();
  const merged = { type: 'merge', ok: true, sha, revision: 1, source: 'merge', commands: [{ command: 'gh', args: ['pr', 'merge'] }] };
  const task = (id, status, extra = {}) => ({ id, status, sha, revision: 1, pr: 7, evidence: [], ...extra });
  const submit = { id: 'submit-T2', task: 'T2', cmd: 'submit', detail: { sha, revision: 1 } };
  const accept = { id: 'accept-T4', task: 'T4', cmd: 'accept', detail: { sha, revision: 1 } };
  const merge = { id: 'merge-T3', task: 'T3', cmd: 'merge', agent: 'orchestrator', detail: { ...merged } };
  const later = { id: 'submit-T5', task: 'T5', cmd: 'submit', detail: { sha, revision: 1 } };
  const queued = (e) => ({ cmd: 'automation queued', task: e.task, detail: { source: e.id } });
  const receipt = (e, detail) => ({ cmd: 'automation', task: e.task, at, detail: { source: e.id, ...detail } });
  const waiter = receipt(submit, { phase: 'executor', kind: 'tests' });
  const running = receipt(merge, { phase: 'running', pid: process.pid, ...P.identity(process.pid) });
  const mergeWaiter = receipt(merge, { phase: 'executor', kind: 'head check', merge: 'T4' });
  const suiteDeferred = receipt(merge, { phase: 'deferred', error: 'T4: merge-queue suite deferred by the host governor: memory',
    governor: { task: 'T4', kind: 'suite', reason: 'memory', until: Date.now() - 1, since: at, at } });
  for (const [name, t4, events, check] of [
    ['the line running under the merged task asks for a slot', 'accepted', [running],
      (st, name) => {
        assert.equal(A.outranked(st, merge, 'T4'), null, `${name}: the head check is not behind the submitted T2`);
        assert.equal(A.outranked(st, merge)?.task, 'T2', `${name}: other work of the same reaction keeps its own turn`);
      }],
    ['the line waits for a slot under the merged task', 'accepted', [mergeWaiter],
      (st, name) => {
        assert.equal(A.outranked(st, submit)?.task, 'T3', `${name}: the submitted T2 waits behind the head check`);
        assert.equal(A.outranked(st, merge), null, `${name}: the waiting head check is behind nothing`);
        assert.equal(A.outranked(st, later)?.task, 'T3', `${name}: a newer arrival waits behind the head check`);
        assert.deepEqual(A.gateQueue(st).queued.map((q) => q.id), ['T3', 'T2'], `${name}: the drain takes the head check first`);
      }],
    ['the governor deferred the suite of the line under the merged task', 'accepted', [suiteDeferred],
      (st, name) => {
        assert.equal(A.outranked(st, submit), null, `${name}: a governor deferral holds no executor turn`);
        assert.deepEqual(A.gateQueue(st).queued.map((q) => q.id), ['T3', 'T2'], `${name}: the drain retries the head check first`);
      }],
    ['the task the line waited for went back to rework', 'rework', [mergeWaiter],
      (st, name) => assert.equal(A.outranked(st, merge)?.task, 'T2', `${name}: the waiter keeps the turn of its own event`)],
  ]) {
    const tasks = [task('T2', 'submitted', { pr: null }), task('T3', 'accepted', { evidence: [{ ...merged, agent: 'orchestrator' }] }), task('T4', t4),
      task('T5', 'submitted', { pr: null })];
    const log = [submit, accept, merge, later, queued(submit), queued(merge), waiter, ...events];
    check({ project: {}, tasks: { tasks }, events: log }, name);
  }
});

test('status names what each merge waits behind', (t) => {
  const A = require('../lib/automation');
  const T = require('../lib/tasks');
  const P = require('../lib/processes');
  const sha = 'a'.repeat(40);
  const at = (minute) => new Date(Date.UTC(2026, 9, 23, 8, minute)).toISOString();
  const self = { pid: process.pid, ...P.identity(process.pid) };
  const task = (id, status) => ({ id, status, sha, revision: 1, pr: 7, evidence: [] });
  const accept = (id, minute) => ({ id: `accept-${id}`, task: id, cmd: 'accept', at: at(minute), detail: { sha, revision: 1 } });
  const merge = { id: 'merge-T3', task: 'T3', cmd: 'merge', at: at(3), detail: { type: 'merge', ok: true, sha, revision: 1 } };
  const queued = (source, id) => ({ cmd: 'automation queued', task: id, detail: { source } });
  const receipt = (source, id, detail) => ({ cmd: 'automation', task: id, at: at(9), detail: { source, ...detail } });
  const lease = (id, kind) => ({ cmd: 'executor', task: id, at: at(9), detail: { lease: `cpu:${id}`, phase: 'running', kind, ...self } });
  const governor = { task: 'T4', kind: 'suite', reason: 'memory: the host is full', until: Date.now() + 5000, since: at(9), at: at(9) };
  // What queue() records when the pass ends at T4: a deferral or a refusal.
  const pass = (reason, deferred) => ({ cmd: 'merge queue', at: at(9),
    detail: { phase: 'error', error: reason, blocked: { task: 'T4', reason, ...(deferred ? { deferred } : {}) }, skipped: [] } });
  const executorPass = pass('T4: head check waits for a gate executor (2 of 2 in use)', { kind: 'executor' });
  const governorPass = pass('T4: merge-queue suite deferred by the host governor: memory: the host is full',
    { kind: 'governor', reason: 'memory: the host is full' });
  let failing = new Set();
  t.mock.method(T, 'gateReport', (x) => ({ ok: !failing.has(x.id), gates: [], missing: failing.has(x.id) ? ['ci failed'] : [] }));
  for (const [name, five, events, fails, want, earlier = []] of [
    ['a full executor cap', null, [lease('T1', 'tests'), lease('T2', 'clean'), queued('merge-T3', 'T3'),
      receipt('merge-T3', 'T3', { phase: 'executor', kind: 'head check', merge: 'T4' })], [],
    [['T4', 'a gate executor: 2 of 2 in use: T1 tests, T2 clean']]],
    ['the host governor', null, [queued('accept-T4', 'T4'), receipt('accept-T4', 'T4', { phase: 'deferred', governor })], [],
      [['T4', 'the host governor: memory: the host is full']]],
    ['a full executor cap the queue recorded', null, [lease('T1', 'tests'), lease('T2', 'clean'), queued('merge-T3', 'T3'),
      receipt('merge-T3', 'T3', { phase: 'executor', kind: 'head check', merge: 'T4' }), executorPass], [],
    [['T4', 'a gate executor: 2 of 2 in use: T1 tests, T2 clean']]],
    ['a governor deferral the queue recorded', null, [queued('accept-T4', 'T4'),
      receipt('accept-T4', 'T4', { phase: 'deferred', governor }), governorPass], [],
    [['T4', 'the host governor: memory: the host is full']]],
    ['an executor deferral only the queue recorded', null, [lease('T1', 'tests'), lease('T2', 'clean'), executorPass], [],
      [['T4', 'a gate executor: 2 of 2 in use: T1 tests, T2 clean']]],
    ['a governor deferral only the queue recorded', null, [governorPass], [],
      [['T4', 'the host governor: memory: the host is full']]],
    ['a head the queue refused', null, [pass('T4: PR mergeability is CONFLICTING')], [], []],
    ['a deferral recorded before the acceptance', null, [], [], [['T4', 'the next merge queue pass']], [executorPass]],
    ['an earlier acceptance', 1, [], [], [['T5', 'the next merge queue pass'], ['T4', 'T5 ahead in the merge line']]],
    ['an earlier acceptance whose merge is blocked', 1, [], ['T5'], [['T4', 'the next merge queue pass']]],
    ['a head check that runs', null, [lease('T4', 'head check')], [], []],
    ['a blocked merge', null, [], ['T4'], []],
  ]) {
    failing = new Set(fails);
    const tasks = [task('T3', 'submitted'), task('T4', 'accepted'), ...(five ? [task('T5', 'accepted')] : [])];
    const log = [...earlier, ...(five ? [accept('T5', five)] : []), accept('T4', 2), merge, ...events];
    const waits = A.mergeWaits({ project: {}, tasks: { tasks }, events: log });
    assert.deepEqual(waits.map((w) => [w.id, w.behind]), want, name);
    for (const w of waits) assert.equal(w.since, log.find((e) => e.cmd === 'accept' && e.task === w.id).at, `${name}: ${w.id} waits since its acceptance`);
  }
  assert.equal(A.describeMergeWaits([{ id: 'T4', since: at(2), behind: 'T5 ahead in the merge line' }]),
    `T4 since ${at(2)}, behind T5 ahead in the merge line`);
});

test('status lists each stacked merge wait with its own acceptance and its stack blocker', (t) => {
  const A = require('../lib/automation');
  const T = require('../lib/tasks');
  const P = require('../lib/processes');
  const sha = 'a'.repeat(40);
  const at = (minute) => new Date(Date.UTC(2026, 9, 23, 8, minute)).toISOString();
  const self = { pid: process.pid, ...P.identity(process.pid) };
  const task = (id, pr, stack, status = 'accepted') => ({ id, status, sha, revision: 1, pr, evidence: [], ...(stack ? { stack } : {}) });
  const accept = (id, minute) => ({ id: `accept-${id}`, task: id, cmd: 'accept', at: at(minute), detail: { sha, revision: 1 } });
  const lease = (id, kind) => ({ cmd: 'executor', task: id, at: at(40), detail: { lease: `cpu:${id}`, phase: 'running', kind, ...self } });
  const linked = { parent: 'T1', linked: true };
  let failing = new Set();
  t.mock.method(T, 'gateReport', (x) => ({ ok: !failing.has(x.id), gates: [], missing: failing.has(x.id) ? ['ci failed'] : [] }));
  for (const [name, tasks, events, fails, want] of [
    ['a linked stack whose bottom is blocked', [task('T1', 7), task('T2', 8, linked)], [], ['T1'],
      [['T2', 'T1 merge blocked: ci failed']]],
    ['a linked stack whose top is blocked', [task('T1', 7), task('T2', 8, linked)], [], ['T2'],
      [['T1', 'T2 merge blocked: ci failed']]],
    ['a linked stack that waits', [task('T1', 7), task('T2', 8, linked)], [], [],
      [['T1', 'the next merge queue pass'], ['T2', 'the next merge queue pass']]],
    ['a later entry behind a blocked stack', [task('T1', 7), task('T2', 8, linked), task('T5', 9)], [accept('T5', 35)], ['T1'],
      [['T2', 'T1 merge blocked: ci failed'], ['T5', 'the next merge queue pass']]],
    ['a later entry behind a waiting stack', [task('T1', 7), task('T2', 8, linked), task('T5', 9)], [accept('T5', 35)], [],
      [['T1', 'the next merge queue pass'], ['T2', 'the next merge queue pass'], ['T5', 'T2 ahead in the merge line']]],
    ['an unlinked task on an accepted task', [task('T1', 7), task('T2', 8, { parent: 'T1' })], [], [],
      [['T1', 'the next merge queue pass'], ['T2', 'T1 under it in its stack']]],
    ['a linked task on a task in review', [task('T1', 7, null, 'submitted'), task('T2', 8, linked)], [], [],
      [['T2', 'T1 under it in its stack']]],
    ['a stack whose head check runs', [task('T1', 7), task('T2', 8, linked)], [lease('T2', 'head check')], [], []],
  ]) {
    failing = new Set(fails);
    const log = [...(tasks[0].status === 'accepted' ? [accept('T1', 1)] : []), accept('T2', 30), ...events];
    const waits = A.mergeWaits({ project: {}, tasks: { tasks }, events: log });
    assert.deepEqual(waits.map((w) => [w.id, w.behind]), want, name);
    for (const w of waits) assert.equal(w.since, log.find((e) => e.cmd === 'accept' && e.task === w.id).at, `${name}: ${w.id} waits since its acceptance`);
  }
});

test('pending CI at an accepted head is a merge blocker, not a merge wait', () => {
  const A = require('../lib/automation');
  const sha = 'a'.repeat(40);
  const at = new Date(Date.UTC(2026, 9, 23, 8, 2)).toISOString();
  const review = { type: 'review', source: 'review', agent: 'owner', sha, revision: 1, ok: true };
  const gate = { type: 'ci', source: 'check ci', commands: [], sha, revision: 1 };
  for (const [name, ci, blocked] of [
    ['pending', { ok: false, pending: true, summary: 'CI not green: running' }, /^ci: latest ci at aaaaaaa pending: CI not green: running$/],
    ['stalled', { ok: false, pending: true, stalled: true, summary: 'CI stalled' }, /^ci: latest ci at aaaaaaa stalled: CI stalled$/],
  ]) {
    const entry = { ...gate, agent: 'orchestrator', ...ci };
    const task = { id: 'T4', status: 'accepted', kind: 'docs', size: 'S', tier: 'easy', sha, revision: 1, pr: 7, evidence: [review, entry] };
    const events = [{ id: 'accept-T4', task: 'T4', cmd: 'accept', at, detail: { sha, revision: 1 } },
      { task: 'T4', cmd: 'check ci', agent: 'orchestrator', at, detail: { ...gate, ...ci } }];
    const st = { project: {}, tasks: { tasks: [task] }, events };
    const blockers = A.mergeBlockers(st);
    assert.deepEqual(blockers.map((b) => b.id), ['T4'], name);
    assert.match(blockers[0].reason, blocked, name);
    assert.deepEqual(A.mergeWaits(st, blockers), [], name);
  }
});

test('accepted merges take the next executor in acceptance order before queued submitted gates', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  fs.writeFileSync(stalled, '');
  for (const id of ['T2', 'T3', 'T4', 'T5']) {
    h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  }
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'] };
  h.saveGithub(github);
  // Both pass their gates and review before T1 starts.
  for (const id of ['T4', 'T5']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, id, '--agent', 'orchestrator']);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--sha', h.sha, '--revision', h.revision(id), '--ok', '--agent', 'reviewer']);
  }
  // An independent base change requires each merge to test the merged tree.
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  fs.rmSync(stalled);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const offset = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  // Start only T1's reaction, leaving the prepared PRs for after it holds the executor.
  const holder = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let text, queue;
  try {
    await waitFor(stalled, { what: 'T1 holds the only executor' });
    const after = fs.statSync(events).size;
    for (const id of ['T2', 'T3']) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
    }
    // Attach the PRs after T1 starts, T5's first. Review and CI need no
    // executor, so both are accepted at once, T5 first; their merged-tree
    // tests wait for the slot.
    for (const [id, pr] of [['T5', '8'], ['T4', '7']]) {
      h.ok(['submit', id, '--sha', h.sha, '--pr', pr, '--agent', 'worker']);
    }
    h.run(['wait', '--after', String(after), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    assert.deepEqual(h.logs().filter((e) => e.cmd === 'accept').map((e) => e.task), ['T5', 'T4']);
    const late = h.run(['gates', 'prioritize', 'T4', '--reason', 'later merge request', '--agent', 'orchestrator']);
    assert.notEqual(late.code, 0);
    assert.match(late.stderr, /T4 is accepted; its merge already runs ahead of submitted gate work, in acceptance order/);
    h.ok(['gates', 'prioritize', 'T3', '--reason', 'submitted gate request', '--agent', 'orchestrator']);
    text = h.ok(['status']);
    queue = h.json(['status']).gate_queue;
    assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).gate_queue, queue);
    assert.deepEqual(executorStarts(h), ['T1'], 'acceptance does not preempt the running gate');
    assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  }
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T5, T4, T3 \(prioritized: submitted gate request\), T2$/m);
  assert.deepEqual(queue.queued.map((q) => q.id), ['T5', 'T4', 'T3', 'T2']);
  const log = h.logs();
  // T5's reaction checks and merges the whole line, so T4's head check moves T5's lease to T4.
  const holders = log.filter((e) => e.cmd === 'executor' && e.detail.phase === 'running').map((e) => e.task)
    .filter((id, i, all) => id !== all[i - 1]);
  assert.deepEqual(holders, ['T1', 'T5', 'T4', 'T3', 'T2']);
  assert.deepEqual(log.filter((e) => e.cmd === 'head check').map((e) => [e.task, e.detail.ok]),
    [['T5', true], ['T4', true]], 'merged-tree tests keep merge priority');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7']);
  const gates = log.findIndex((e) => e.cmd === 'executor' && e.task === 'T3' && e.detail.phase === 'running');
  assert.ok(log.findLastIndex((e) => e.cmd === 'merge' && e.detail.ok) < gates,
    'both merges finish before a queued submitted gate starts');
});

// Accepts each task at its PR once its gates and review pass, then moves main
// so every merge runs its head check. Returns holdSuite's files; without a
// `hold` already stalled, the next suite after these stalls.
function acceptAll(h, prs, hold = null) {
  const rearm = !hold;
  hold ||= holdSuite(h);
  fs.writeFileSync(hold.stalled, '');
  const github = h.github();
  for (const [id, pr] of prs) {
    if (id !== 'T1') h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
    github.prs[pr] = { ...github.prs['7'] };
  }
  h.saveGithub(github);
  for (const [id, pr] of prs) {
    h.submit(id, h.sha, pr);
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, id, '--agent', 'orchestrator']);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--sha', h.sha, '--revision', h.revision(id), '--ok', '--agent', 'reviewer']);
    h.ok(['accept', id, '--agent', 'orchestrator']);
  }
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  if (rearm) fs.rmSync(hold.stalled);
  return hold;
}

// On 2026-10-23 T483's head check ran under T475's merge reaction, ranked by
// that merged task, and waited behind T433's older gate run.
test('the next accepted head check takes the freed executor ahead of a queued gate run, and status shows the wait', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // T1's submission is older than any reaction that runs the merge line.
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const beforeT1 = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const { stalled, release } = acceptAll(h, [['T2', '8'], ['T3', '9']]);
  // T2's merge-tree suite holds the only executor and the merge line.
  const holder = h.runAsync(['wait', '--after', String(fs.statSync(events).size), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let text, waits;
  try {
    await waitFor(stalled, { what: "T2's head check holds the executor" });
    const runner = h.logs().findLast((e) => e.cmd === 'executor' && e.task === 'T2' && e.detail.kind === 'head check');
    assert.ok(runner, 'T2 holds the executor for its head check');
    // T1's gate run queues for the executor; T3, accepted while the line is busy, leaves it to T2's pass.
    h.run(['wait', '--after', String(beforeT1), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    const last = new Map(h.logs().filter((e) => e.cmd === 'automation').map((e) => [e.task, e.detail]));
    assert.equal(last.get('T1')?.phase, 'executor', 'T1 waits for an executor');
    text = h.ok(['status']);
    waits = h.json(['status']).merge_waits;
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  }
  const accepted = h.logs().findLast((e) => e.cmd === 'accept' && e.task === 'T3').at;
  assert.match(text, new RegExp(`^merge waits: T3 since ${accepted}, behind T2 ahead in the merge line$`, 'm'));
  assert.deepEqual(waits, [{ id: 'T3', since: accepted, behind: 'T2 ahead in the merge line' }]);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '9']);
  assert.deepEqual(executorStarts(h).slice(-3), ['T2', 'T3', 'T1'], "T3's head check takes the freed executor before T1's tests");
  assert.equal(h.logs().some((e) => e.cmd === 'automation' && /T3: head check waits behind T1/.test(e.detail.error || '')), false);
});

test('past the load line a waiting merge suite runs beside the gate runs that hold places, and a new gate run waits', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const hold = holdSuite(h);
  h.ok(['project', 'set', '--executors', '2', '--agent', 'orchestrator']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const offset = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  // T1's tests hold an executor and a place in the host budget.
  const holder = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let deferred;
  try {
    await waitFor(hold.stalled, { what: "T1's tests hold a place" });
    acceptAll(h, [['T2', '8']], hold);
    h.ok(['task', 'add', '--title', 'Change T3', '--acceptance', 'it works', '--kind', 'code']);
    h.ok(['claim', 'T3', '--agent', 'worker']);
    // The fake host's load passes the defer line; T1's tests keep running.
    writeHost(h.env.TOWER_CRANE_HOST_ROOT, { load: 1000 });
    const after = fs.statSync(events).size;
    h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
    h.run(['wait', '--after', String(after), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    const log = h.logs();
    assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8'], 'T2 merges on its first admission');
    assert.deepEqual(log.filter((e) => e.cmd === 'head check').map((e) => [e.task, e.detail.ok]), [['T2', true]]);
    assert.equal(log.some((e) => e.cmd === 'automation' && e.detail.governor?.kind === 'suite'), false, 'the suite was never deferred');
    deferred = log.findLast((e) => e.cmd === 'automation' && e.task === 'T3')?.detail;
    assert.equal(h.readState('tasks.json').tasks.find((x) => x.id === 'T1').evidence.length, 0, "T1's tests still run");
  } finally {
    writeHost(h.env.TOWER_CRANE_HOST_ROOT, { load: 0 });
    fs.writeFileSync(hold.release, '');
    await holder;
  }
  assert.equal(deferred?.phase, 'deferred', 'the new gate run waits');
  assert.equal(deferred.governor.kind, 'tests');
  assert.match(deferred.governor.reason, /^load: 1000 on \d+ cores is at or over \d+/);
});

// The merge queue records a deferred head as its blocked entry; that entry
// is a wait, not a refusal, so status still lists the merge.
test('a head check deferred on a full executor cap stays in status merge waits', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const hold = holdSuite(h);
  h.ok(['project', 'set', '--executors', '2', '--agent', 'orchestrator']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  const offset = fs.statSync(events).size;
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  let text, waits, record;
  try {
    await waitFor(hold.stalled, { what: "T1's tests hold an executor" });
    acceptAll(h, [['T2', '8']], hold);
    // T1's tests now fill the cap, so T2's head check defers.
    h.ok(['project', 'set', '--executors', '1', '--agent', 'orchestrator']);
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    record = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested')?.detail;
    text = h.ok(['status']);
    waits = h.json(['status']).merge_waits;
  } finally {
    fs.writeFileSync(hold.release, '');
    await holder;
  }
  assert.equal(record?.blocked?.task, 'T2', 'the queue records the deferred head');
  assert.deepEqual(record.blocked.deferred, { kind: 'executor' });
  const accepted = h.logs().findLast((e) => e.cmd === 'accept' && e.task === 'T2').at;
  assert.deepEqual(waits, [{ id: 'T2', since: accepted, behind: 'a gate executor: 1 of 1 in use: T1 tests' }]);
  assert.match(text, new RegExp(`^merge waits: T2 since ${accepted}, behind a gate executor: 1 of 1 in use: T1 tests$`, 'm'));
});

test('gates prioritize runs the last queued task first; status and inbox show the gate queue', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // The three tasks submitted after the held run queue behind it.
  const { stalled, release } = holdSuite(h);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3', 'T4']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3', 'T4']);

  const refused = h.run(['gates', 'prioritize', 'T4', '--reason', 'gate fix first', '--agent', 'worker']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /operational/);
  // T1 holds the executor, so it has no queued work to move.
  const idle = h.run(['gates', 'prioritize', 'T1', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(idle.code, 0);
  assert.match(idle.stderr, /no queued gate work/);
  assert.ok(!h.logs().some((e) => e.cmd === 'gates prioritize'), 'refused requests log nothing');

  h.ok(['gates', 'prioritize', 'T4', '--reason', 'T134 shrinks every later gate run', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T4', 'T134 shrinks every later gate run']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.running, ['T1']);
  assert.deepEqual(queue.queued.map((q) => q.id), ['T4', 'T2', 'T3']);
  assert.equal(queue.queued[0].prioritized.reason, 'T134 shrinks every later gate run');
  assert.equal(queue.queued[1].prioritized, null);
  assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).gate_queue, queue, 'inbox carries the same queue');
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T4 \(prioritized: T134 shrinks every later gate run\), T2, T3$/m);

  fs.writeFileSync(release, '');
  // A zero-timeout wait with no matching type exits 2 once its drain is done.
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  assert.deepEqual(executorStarts(h), ['T1', 'T4', 'T2', 'T3'], 'the prioritized T4 runs before T2 and T3, which keep their order');
  const changes = h.logs().filter(e => e.cmd === 'setting' && e.detail.settings['gates.priority']);
  assert.deepEqual(changes.map(e => e.detail), [{
    command: 'gates prioritize', actor: 'orchestrator', mode: 'cli',
    settings: { 'gates.priority': 'operational' },
  }], 'only the successful priority change writes a setting audit');
});

// Each gate run stalls until the test writes its `release-N` file, so the test
// can read status while run N is in progress.
function stepSuite(h, { executors = 1 } = {}) {
  const suite = path.join(h.base, 'tools', 'step-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
const path = require('node:path');
const base = ${JSON.stringify(h.base)};
const counter = path.join(base, 'runs');
// read-published: one suite run at a time writes the counter in place; nothing replaces it.
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
fs.writeFileSync(counter, String(n));
fs.writeFileSync(path.join(base, 'stalled-' + n), '');
const release = path.join(base, 'release-' + n);
const poll = () => (fs.existsSync(release) ? process.exit(0) : setTimeout(poll, 50)); // wait-allow: probe cadence only; the release signal and hung-test timeout bound this fixture
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', String(executors), '--agent', 'orchestrator']);
  return (n) => ({ stalled: path.join(h.base, `stalled-${n}`), release: path.join(h.base, `release-${n}`) });
}

for (const notification of ['review', 'CI completion']) {
  test(`later notifications share the prioritized task waiter: ${notification}`, async (t) => {
    const h = priorityFixture(t);
    const events = path.join(h.state, 'events.jsonl');
    const { stalled, release } = holdSuite(h);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
    const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    try {
      await waitFor(stalled, { what: 'the first executor starts' });
      const offset = fs.statSync(events).size;
      for (const id of ['T2', 'T3']) {
        h.ok(['claim', id, '--agent', 'worker']);
        h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
      }
      h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3']);

      if (notification === 'review') h.reviewer('T3', 'reviewer', h.sha);
      const before = fs.statSync(events).size;
      if (notification === 'review') {
        h.ok(['evidence', 'T3', '--revision', h.revision('T3'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
      } else {
        h.ok(['ci', 'completed', 'T3', '--sha', h.sha, '--agent', 'orchestrator']);
      }
      h.ok(['gates', 'prioritize', 'T3', '--reason', 'gate fix first', '--agent', 'orchestrator']);
      const request = h.logs().findLast((e) => e.cmd === 'gates prioritize');
      const submitted = h.logs().find((e) => e.cmd === 'submit' && e.task === 'T3');
      assert.deepEqual(request.detail.sources, [submitted.id], 'the request moves the queued suite only');
      h.run(['wait', '--after', String(before), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      // The later notification reaches the suite T3 already waits for, so its
      // reaction ends and that waiting reaction carries the task on.
      const notified = h.logs().findLast((e) => e.task === 'T3'
        && (notification === 'review' ? e.cmd === 'evidence' && e.detail.type === 'review' : e.cmd === 'ci completed'));
      assert.equal(h.logs().findLast((e) => e.cmd === 'automation' && e.detail.source === notified.id).detail.phase, 'done');
      assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation queued').map((e) => e.task), ['T2', 'T3'],
        'the later notification takes no second place in line');

    } finally {
      fs.writeFileSync(release, '');
      assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
    }
    assert.deepEqual(executorStarts(h), ['T1', 'T3', 'T2'], 'the prioritized task runs ahead of unprioritized work');
    assert.equal(h.readState('tasks.json').tasks.find((task) => task.id === 'T3').status,
      notification === 'review' ? 'accepted' : 'submitted', 'the later notification is acted on once its suite passes');
  });
}

function priorityFixture(t) {
  const h = cachedFixture(t, 'task-gate-priority', (repo) => {
    const h = setup(null, { repo });
    for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
    return { sha: h.sha };
  });
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

test('task gate priority lifecycle and legacy requests', () => {
  const { gateQueue } = require('../lib/automation');
  for (const row of [
    { name: 'later submission', cmd: 'submit', detail: {}, priority: true },
    { name: 'rework', cmd: 'rework', detail: {}, priority: true },
    { name: 'clear', cmd: 'gates prioritize', detail: { clear: true }, priority: false },
    { name: 'accepted then reopened', cmd: 'accept', detail: {}, priority: false },
    { name: 'cancelled then reopened', cmd: 'task update', detail: { status: 'cancelled' }, priority: false },
    { name: 'hotfix cancelled then re-recorded', cmd: 'hotfix rework', detail: {}, reopen: 'hotfix', priority: false },
    ...['rework', 'ci', 'review'].map(gate => ({
      name: `hotfix ${gate} cancellation then re-recorded`, cmd: 'hotfix rework', detail: { gate }, reopen: 'hotfix', priority: false,
    })),
    { name: 'hotfix follow-up superseded then reopened', cmd: 'hotfix supersede', detail: { status: 'cancelled' }, priority: false },
    { name: 'unrelated update', cmd: 'task update', detail: { title: 'updated' }, priority: true },
  ]) {
    const event = (id, cmd, task, detail = {}) => ({ id, cmd, task, detail, at: '2026-10-22T00:00:00Z', agent: 'orchestrator' });
    const st = {
      tasks: { tasks: ['T2', 'T3'].map(id => ({ id, status: 'submitted', revision: 2, evidence: [] })) },
      events: [
        event('legacy', 'gates prioritize', 'T3', { reason: 'repair first', sources: ['old-head'] }),
        event('transition', row.cmd, 'T3', row.detail),
        event('plain', 'submit', 'T2'),
        event('plain-queued', 'automation queued', 'T2', { source: 'plain' }),
        event('new-head', row.reopen || 'submit', 'T3'),
        event('new-queued', 'automation queued', 'T3', { source: 'new-head' }),
      ],
    };
    const queue = gateQueue(st).queued;
    assert.deepEqual(queue.map(q => q.id), row.priority ? ['T3', 'T2'] : ['T2', 'T3'], row.name);
    assert.equal(queue.find(q => q.id === 'T3').prioritized !== null, row.priority, row.name);
  }
});

for (const row of [
  { name: 'FIFO', args: [], expected: ['T3', 'T4', 'T2'] },
  { name: 'repeated request keeps its place', args: ['T3', '--reason', 'updated reason'], expected: ['T3', 'T4', 'T2'] },
  { name: 'explicit rank', args: ['T4', '--reason', 'rank first', '--rank', '0'], expected: ['T4', 'T3', 'T2'] },
  { name: 'clear', args: ['T3', '--clear'], expected: ['T4', 'T2', 'T3'] },
]) {
  test(`task gate priorities run in request order: ${row.name}`, async (t) => {
    const h = priorityFixture(t);
    const events = path.join(h.state, 'events.jsonl');
    const { stalled, release } = holdSuite(h);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
    const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    try {
      await waitFor(stalled, { what: 'the first executor holds the queue' });
      const offset = fs.statSync(events).size;
      for (const id of ['T2', 'T4', 'T3']) {
        h.ok(['claim', id, '--agent', 'worker']);
        h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
      }
      h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      h.ok(['gates', 'prioritize', 'T3', '--reason', 'first request', '--agent', 'orchestrator']);
      h.ok(['gates', 'prioritize', 'T4', '--reason', 'second request', '--agent', 'orchestrator']);
      if (row.args.length) h.ok(['gates', 'prioritize', ...row.args, '--agent', 'orchestrator']);
      const queue = h.json(['status']).gate_queue.queued;
      assert.deepEqual(queue.map(q => q.id), row.expected);
      assert.equal(queue.find(q => q.id === 'T3').prioritized === null, row.name === 'clear');
    } finally {
      fs.writeFileSync(release, '');
      assert.equal((await holder).code, 2);
    }
    assert.deepEqual(executorStarts(h), ['T1', ...row.expected]);
  });
}

test('a task priority survives rework and a new submitted head and can be cleared during rework', async (t) => {
  const h = priorityFixture(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  try {
    await waitFor(stalled, { what: 'the first executor holds the queue' });
    const offset = fs.statSync(events).size;
    for (const id of ['T2', 'T3']) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
    }
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    h.ok(['gates', 'prioritize', 'T3', '--reason', 'keep repair first', '--agent', 'orchestrator']);
    h.ok(['rework', 'T3', '--reason', 'repair the submitted change', '--agent', 'orchestrator']);
    fs.appendFileSync(path.join(h.repo, 'README.md'), 'Repair.\n');
    h.git(['add', 'README.md']);
    h.git(['commit', '-qm', 'repair']);
    const head = h.git(['rev-parse', 'HEAD']);
    h.ok(['claim', 'T3', '--agent', 'worker']);
    h.ok(['submit', 'T3', '--sha', head, '--agent', 'worker']);
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    const queue = h.json(['status']).gate_queue.queued;
    assert.deepEqual(queue.map(q => q.id), ['T3', 'T2']);
    assert.equal(queue[0].prioritized.reason, 'keep repair first');

    h.ok(['rework', 'T3', '--reason', 'check clearing an idle priority', '--agent', 'orchestrator']);
    h.ok(['gates', 'prioritize', 'T3', '--clear', '--agent', 'orchestrator']);
    h.ok(['claim', 'T3', '--agent', 'worker']);
    h.ok(['submit', 'T3', '--sha', head, '--agent', 'worker']);
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    assert.deepEqual(h.json(['status']).gate_queue.queued.map(q => [q.id, q.prioritized]), [['T2', null], ['T3', null]]);
  } finally {
    fs.writeFileSync(release, '');
    assert.equal((await holder).code, 2);
  }
  assert.deepEqual(executorStarts(h), ['T1', 'T2', 'T3'], 'clearing restores the older unprioritized task first');
});

test('a reaction that is running is not queued: status and prioritize leave it out', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const run = stepSuite(h);
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(1).stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  for (const id of ['T2', 'T3']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);

  fs.writeFileSync(run(1).release, '');
  await waitFor(run(2).stalled, { what: 'T2 takes the executor next' });
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T2$/m);
  assert.match(text, /^gate queue: T3$/m, 'T2 is running, so only T3 waits');
  const refused = h.run(['gates', 'prioritize', 'T2', '--reason', 'gate fix first', '--agent', 'orchestrator']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /no queued gate work/);

  fs.writeFileSync(run(2).release, '');
  await waitFor(run(3).stalled, { what: 'T3 runs last' });
  fs.writeFileSync(run(3).release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  assert.deepEqual(executorStarts(h), ['T1', 'T2', 'T3'], 'each task runs once, in submission order');
});

test('a follow-up queued behind a live reaction can be prioritized and runs first', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const { stalled, release } = holdSuite(h);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(stalled, { what: 'the first executor starts' });
  const offset = fs.statSync(events).size;
  // T1 has a live reaction, so T2 and then T1's CI completion queue behind it.
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate queue: T2; blocked behind their running reactions: T1$/m, 'the follow-up waits behind the running reaction');

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  const event = h.logs().findLast((e) => e.cmd === 'gates prioritize');
  assert.deepEqual([event.task, event.detail.reason], ['T1', 'CI follow-up first']);
  const text = h.ok(['status']);
  assert.match(text, /^gate running: T1$/m);
  assert.match(text, /^gate queue: T2; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual(queue.queued.map((q) => q.id), ['T2']);
  assert.deepEqual(queue.blocked.map((q) => q.id), ['T1']);

  fs.writeFileSync(release, '');
  assert.equal((await holder).code, 2, 'the held executor finishes and drains the queue');
  assert.deepEqual(executorStarts(h), ['T1', 'T2']);
  const log = h.logs();
  const followUp = log.find((e) => e.cmd === 'ci completed' && e.task === 'T1');
  const ran = log.findIndex((e) => e.cmd === 'automation' && e.detail.source === followUp.id && e.detail.phase === 'running');
  assert.ok(ran >= 0 && ran < log.findIndex((e) => e.cmd === 'executor' && e.task === 'T2'), 'the prioritized follow-up runs before T2');
});

test('status shows a blocked follow-up apart from the queue the next free executor takes', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  // Two executors hold T1 and T2, so T3 and T1's CI follow-up queue. T1's
  // follow-up waits for T1's own reaction, so T3 is the next work taken.
  const run = stepSuite(h, { executors: 2 });
  for (const id of ['T2', 'T3']) h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  const first = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(1).stalled, { what: 'T1 takes the first executor' });
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', h.sha, '--agent', 'worker']);
  const second = h.runAsync(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  await waitFor(run(2).stalled, { what: 'T2 takes the second executor' });

  const queued = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  h.run(['wait', '--after', String(queued), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.match(h.ok(['status']), /^gate running: T1, T2$/m);
  assert.match(h.ok(['status']), /^gate queue: T3; blocked behind their running reactions: T1$/m);

  h.ok(['gates', 'prioritize', 'T1', '--reason', 'CI follow-up first', '--agent', 'orchestrator']);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /^gate queue: T3; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);
  const queue = h.json(['status']).gate_queue;
  assert.deepEqual([queue.running, queue.queued.map((q) => q.id), queue.blocked.map((q) => q.id)], [['T1', 'T2'], ['T3'], ['T1']]);

  fs.writeFileSync(run(2).release, '');
  await waitFor(run(3).stalled, { what: 'T3 takes the freed executor before the blocked follow-up' });
  const followUp = h.logs().find((e) => e.cmd === 'ci completed' && e.task === 'T1');
  const ran = (log) => log.findIndex((e) => e.cmd === 'automation' && e.detail.source === followUp.id && e.detail.phase === 'running');
  assert.deepEqual(executorStarts(h), ['T1', 'T2', 'T3']);
  assert.equal(ran(h.logs()), -1, 'the blocked follow-up has not started');
  assert.match(h.ok(['status']), /^gate queue: none; blocked behind their running reactions: T1 \(prioritized: CI follow-up first\)$/m);

  fs.writeFileSync(run(1).release, '');
  fs.writeFileSync(run(3).release, '');
  assert.equal((await first).code, 2, 'the first executor drains its follow-up');
  assert.equal((await second).code, 2, 'the second executor finishes');
  const log = h.logs();
  assert.deepEqual(executorStarts(h), ['T1', 'T2', 'T3'], 'the follow-up takes no executor');
  assert.ok(ran(log) > log.findIndex((e) => e.cmd === 'executor' && e.task === 'T3'), 'the prioritized follow-up runs after its own reaction and T3');
});

for (const reason of ['unknown mergeability', 'transport error']) {
  test(`startup retries ${reason} without a new lifecycle event`, (t) => {
    const h = setup(t, { kind: 'docs' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const state = h.github();
    if (reason === 'transport error') state.failView = true;
    else state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
    h.saveGithub(state);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase,
      reason === 'transport error' ? 'error' : 'deferred');
    const recovered = h.github();
    recovered.failView = false;
    recovered.prs['7'].mergeable = 'MERGEABLE';
    recovered.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(recovered);
    h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'merge');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('startup confirms the accepted head after the executor dies between remote merge and receipt', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const crash = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { AUTOMATION_CRASH_AFTER_MERGE: '1' } });
  assert.notEqual(crash.code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'), false);
  assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase, 'running');
  h.ok(['wait', '--types', 'merged', '--timeout', '300', '--agent', 'orchestrator']);
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, h.sha);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1, 'confirmation does not repeat the remote merge');
});

test('a remotely merged different head produces failed merge evidence', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const state = h.github();
  state.prs['7'].state = 'MERGED';
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, false);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});
