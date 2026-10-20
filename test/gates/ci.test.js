'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../../lib/gates/ci');
const { result, fakeExec } = require('./helpers');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = 'acme/app';

const run = (name, conclusion = 'success', status = 'completed', app = 'github-actions') => ({ name, status, conclusion, app });
const suite = (app, conclusion = 'success', status = 'completed', runs = 1) => ({ app, status, conclusion, runs });
// gh --jq prints one JSON value per line, across all pages.
const lines = (items) => items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');

// `later` maps other commits on the base to their checks (`allRuns`: every check run, where the
// default list keeps the latest of each name), `branch` lists the base's workflow runs since the
// merge commit, `compare` maps "from...to" to the compare status GitHub reports and `files` maps a
// workflow path to its text at any commit. `history` lists the commits the merge commit contains,
// newest first, `earlier` the base's runs of its workflow before it, `runJobs` maps a run id to its
// jobs, `logs` a job id to its log text (null when it cannot be read) and `patches` are the hunks of
// the merge commit's diff.
function github({ runs = [], suites = [], workflows = [], head = SHA, apiError = null, view = {}, pr,
  later = {}, branch = [], compare = {}, date = '2026-10-13T20:00:00Z', files = {},
  history = [], earlier = [], runJobs = {}, logs = {}, patches = [] } = {}) {
  const commits = { ...later, [SHA]: { runs, suites, workflows } };
  return fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr || { headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...view }));
    if (args[0] !== 'api') return null;
    if (apiError) return result('', 1, apiError);
    const compared = args[1].match(new RegExp(`^repos/${REPO}/compare/(\\w+)\\.\\.\\.(\\w+)\\?per_page=1$`));
    if (compared) return result(`${compare[`${compared[1]}...${compared[2]}`] ?? 'diverged'}\n`);
    if (args[1] === `repos/${REPO}/commits/${SHA}`) return result(`${date}\n`);
    const content = args[1].match(new RegExp(`^repos/${REPO}/contents/(.+)\\?ref=\\w+$`));
    if (content) return files[content[1]] == null ? result('', 1, 'HTTP 404') : result(`${Buffer.from(files[content[1]]).toString('base64')}\n`);
    if (args[1] === `repos/${REPO}/commits?sha=${SHA}&per_page=100`) return result(lines([SHA, ...history]));
    if (args[1].startsWith(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&created=`)) return result(lines(earlier));
    const jobsOf = args[1].match(new RegExp(`^repos/${REPO}/actions/runs/(\\d+)/jobs\\?filter=latest&per_page=100$`));
    if (jobsOf) return result(lines(runJobs[jobsOf[1]] || []));
    const log = args[1].match(new RegExp(`^repos/${REPO}/actions/jobs/(\\w+)/logs$`));
    if (log) return logs[log[1]] === null ? result('', 1, 'HTTP 410: logs expired') : result(logs[log[1]] || '');
    if (args[1] === `repos/${REPO}/commits/${SHA}?per_page=100`) return result(lines(patches.map((patch, i) => ({ filename: `f${i}.js`, patch }))));
    assert.ok(args.includes('--paginate'), 'every page must be read');
    if (args[1] === `repos/${REPO}/actions/runs?branch=main&created=${encodeURIComponent(`>=${branchSince(workflows, date)}`)}&per_page=100`) return result(lines(branch));
    for (const [sha, at] of Object.entries(commits)) {
      if (args[1] === `repos/${REPO}/commits/${sha}/check-runs?per_page=100`) return result(lines(at.runs || []));
      if (args[1] === `repos/${REPO}/commits/${sha}/check-runs?filter=all&per_page=100`) return result(lines(at.allRuns || at.runs || []));
      if (args[1] === `repos/${REPO}/commits/${sha}/check-suites?per_page=100`) return result(lines(at.suites || []));
      if (args[1] === `repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`) return result(lines(at.workflows || []));
    }
    return null;
  });
}

// The base listing starts at the merge commit's earliest push run, else at its commit date.
function branchSince(workflows, date) {
  return workflows.filter((w) => w.event === 'push' && w.head_branch === 'main' && w.head_sha === SHA)
    .map((w) => w.created_at).filter(Boolean).sort()[0] || date;
}

function ctx(gh, task = {}, project = {}) {
  return { root: '/repo', worktree: null, task: { id: 'T3', kind: 'code', sha: SHA, pr: null, ...task }, project: { repo: REPO, base: 'main', ...project }, args: {}, exec: gh.exec, log() {} };
}

const GREEN_RUNS = [run('build'), run('lint'), run('docs', 'skipped'), run('bench', 'neutral')];
const GREEN_SUITES = [suite('github-actions'), suite('github-actions', 'neutral')];

test('hotfix checks only push workflows on the recorded base and merge SHA, including with local CI configured', async () => {
  const task = { pr: 42, hotfix: { merge_sha: SHA, base: 'main' } };
  const pr = { state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: SHA }, baseRefName: 'main' };
  const push = { id: 20, path: 'ci.yml', event: 'push', head_sha: SHA, head_branch: 'main',
    check_suite_id: 10, status: 'completed', conclusion: 'success' };
  const runs = [{ ...run('test'), suite: 10 }, { ...run('PR only', 'failure'), suite: 11 }];
  const suites = [{ ...suite('github-actions'), id: 10 }, { ...suite('github-actions', 'failure'), id: 11 }];
  const r = await gate.run(ctx(github({ runs, suites, workflows: [push], pr }), task,
    { ci: { required: ['test'], local: { default: { command: ['missing'] } } } }));
  assert.equal(r.ok, true, r.summary);
  for (const override of [{ event: 'pull_request' }, { head_branch: 'feature' }, { head_sha: OTHER },
    { status: 'queued', conclusion: null }, { conclusion: 'failure' }, { check_suite_id: null }]) {
    const r = await gate.run(ctx(github({ runs, suites, workflows: [{ ...push, ...override }], pr }), task));
    assert.equal(r.ok, false, JSON.stringify(override));
    assert.match(r.summary, /hotfix needs successful push CI/);
  }
  const failedJob = await gate.run(ctx(github({
    runs: [{ ...runs[0], conclusion: 'failure' }], suites: [suites[0]], workflows: [push], pr,
  }), task));
  assert.equal(failedJob.ok, false);
  assert.equal(failedJob.confirmed_failure, true);
  const wrongMerge = await gate.run(ctx(github({ pr: { ...pr, mergeCommit: { oid: OTHER } } }), task));
  assert.equal(wrongMerge.ok, false);
  assert.match(wrongMerge.summary, /no longer matches/);
});

// A busy main: the merge commit's push run was cancelled when a newer push replaced it in the
// ci-main-push concurrency group, and later commits on main ran the full workflow.
const LATER = 'c'.repeat(40);
const LATEST = 'd'.repeat(40);
const MERGED_PR = { state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: SHA }, baseRefName: 'main' };
const HOTFIX = { pr: 42, hotfix: { merge_sha: SHA, base: 'main' } };
const workflow = (id, sha, conclusion, extra = {}) => ({ id, name: 'CI', path: '.github/workflows/ci.yml', event: 'push',
  head_sha: sha, head_branch: 'main', check_suite_id: id + 1000, created_at: `2026-10-13T2${id % 10}:00:00Z`,
  status: conclusion ? 'completed' : 'in_progress', conclusion, ...extra });
const jobs = (w, conclusion = 'success') => ({
  runs: [{ ...run('test (ubuntu-latest)', conclusion), suite: w.check_suite_id }, { ...run('checks (shared files)', 'skipped'), suite: w.check_suite_id }],
  suites: [{ ...suite('github-actions', w.conclusion === 'success' ? 'success' : w.conclusion, 'completed', 2), id: w.check_suite_id }],
  workflows: [w],
});
// The repository's workflow: the shared-files check runs on pull requests only, the tests on every event.
const CI_YML = `name: CI
on: [push, pull_request, schedule, workflow_dispatch]
jobs:
  checks:
    name: checks (shared files)
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
  test:
    name: test (\${{ matrix.os }})
    runs-on: \${{ matrix.os }}
`;
// A run that a newer push replaced before it started has no jobs.
function busyMain({ merge = workflow(1, SHA, 'cancelled'), at = [], compare, extra = {}, files = { '.github/workflows/ci.yml': CI_YML } } = {}) {
  const commits = { [SHA]: !merge ? { runs: [], suites: [], workflows: [] }
    : merge.conclusion === 'cancelled' ? { ...jobs(merge), runs: [] } : jobs(merge, merge.conclusion === 'success' ? 'success' : 'skipped') };
  for (const w of at) {
    const add = jobs(w);
    const had = commits[w.head_sha] || { runs: [], suites: [], workflows: [] };
    commits[w.head_sha] = { runs: [...had.runs, ...add.runs], suites: [...had.suites, ...add.suites], workflows: [...had.workflows, w] };
  }
  const { [SHA]: mergeChecks, ...later } = commits;
  return github({ ...mergeChecks, pr: MERGED_PR, later, files, branch: [...(merge ? [merge] : []), ...at],
    compare: compare ?? { [`${SHA}...${LATER}`]: 'ahead', [`${SHA}...${LATEST}`]: 'ahead', [`${LATER}...main`]: 'ahead', [`${LATEST}...main`]: 'identical' }, ...extra });
}
const hotfixCI = (gh, project = {}) => gate.run(ctx(gh, HOTFIX, { ci: { required: ['checks (shared files)', 'test ('] }, ...project }));

test('a hotfix whose merge commit push run was cancelled is judged by the first green full run at a later main commit that contains it', async () => {
  const red = workflow(2, LATER, 'failure');
  const green = workflow(3, LATEST, 'success');
  const r = await hotfixCI(busyMain({ at: [red, green] }));
  assert.equal(r.ok, true, r.summary);
  // The evidence stays at the merge commit and names the commit and run that stood for it.
  assert.equal(r.sha, SHA);
  assert.deepEqual(r.hotfix_ci, { merge_sha: SHA, satisfied_by: { sha: LATEST, runs: [{ id: 3, workflow: '.github/workflows/ci.yml', event: 'push', url: `https://github.com/${REPO}/actions/runs/3` }] } });
  assert.match(r.summary, new RegExp(`CI green at ${LATEST.slice(0, 10)}`));
  assert.match(r.summary, new RegExp(`merge commit ${SHA.slice(0, 10)} was cancelled or never ran; judged at ${LATEST.slice(0, 10)} on main, which contains it`));
  assert.match(r.summary, /ci\.required skipped in the base run and not applied: checks \(shared files\) \(its job condition is false for push runs\)/);
  // The earliest green commit wins; a daily or manual run counts like a push.
  for (const event of ['schedule', 'workflow_dispatch']) {
    const first = await hotfixCI(busyMain({ at: [workflow(2, LATER, 'success', { event }), green] }));
    assert.equal(first.ok, true, first.summary);
    assert.equal(first.hotfix_ci.satisfied_by.sha, LATER);
    assert.equal(first.hotfix_ci.satisfied_by.runs[0].event, event);
  }
  // A scheduled run at the merge commit itself stands for its cancelled push run, without a compare.
  const same = await hotfixCI(busyMain({ at: [workflow(2, SHA, 'success', { event: 'schedule' })], compare: {} }));
  assert.equal(same.ok, true, same.summary);
  assert.equal(same.hotfix_ci.satisfied_by.sha, SHA);
  assert.match(same.summary, /never ran; judged by \.github\/workflows\/ci\.yml schedule run 2/);
  // A merge commit with no push run at all (several commits in one push) is judged the same way, from its commit date.
  const never = await hotfixCI(busyMain({ merge: null, at: [green] }));
  assert.equal(never.ok, true, never.summary);
  assert.equal(never.hotfix_ci.satisfied_by.sha, LATEST);
});

test('a later green run cannot stand for a red merge commit, an unrelated commit or another workflow', async () => {
  const green = workflow(3, LATEST, 'success');
  const cases = [
    ['failed push run at the merge commit', { merge: workflow(1, SHA, 'failure'), at: [green] }, { confirmed_failure: true }, /push workflow not successful/],
    ['failed job before the cancel', { merge: workflow(1, SHA, 'cancelled'), at: [green], failedJob: true }, { confirmed_failure: true }, /a full workflow run at the merge commit failed/],
    ['failed scheduled run at the merge commit', { at: [workflow(2, SHA, 'failure', { event: 'schedule' }), green] }, { confirmed_failure: true }, /a full workflow run at the merge commit failed/],
    ['still running at the merge commit', { merge: workflow(1, SHA, null), at: [green] }, { pending: true }, /push workflow still running/],
    ['timed out at the merge commit', { merge: workflow(1, SHA, 'timed_out'), at: [green] }, {}, /push workflow not successful/],
    ['green commit does not contain the merge', { at: [green], compare: { [`${SHA}...${LATEST}`]: 'diverged', [`${LATEST}...main`]: 'identical' } }, { pending: true, not_running: true }, /no successful push, scheduled or manual run/],
    ['green commit left main', { at: [green], compare: { [`${SHA}...${LATEST}`]: 'ahead', [`${LATEST}...main`]: 'diverged' } }, { pending: true, not_running: true }, /nothing is running on the base/],
    ['another workflow is green', { at: [{ ...green, path: '.github/workflows/docs.yml', name: 'Docs' }] }, { pending: true, not_running: true }, /\.github\/workflows\/ci\.yml/],
    ['pull request run on main', { at: [{ ...green, event: 'pull_request' }] }, { pending: true, not_running: true }, /no successful/],
    ['later runs red or running', { at: [workflow(2, LATER, 'failure'), workflow(3, LATEST, null)] }, { pending: true }, /has finished yet/],
  ];
  for (const [label, opts, flags, message] of cases) {
    const gh = busyMain(opts);
    if (opts.failedJob) {
      const base = gh.exec;
      gh.exec = (cmd, args) => (args[1] === `repos/${REPO}/commits/${SHA}/check-runs?per_page=100`
        ? result(lines([{ ...run('test (ubuntu-latest)', 'failure'), suite: 1001 }])) : base(cmd, args));
    }
    const r = await hotfixCI(gh);
    assert.equal(r.ok, false, label);
    assert.equal(r.hotfix_ci?.satisfied_by, undefined, label);
    assert.match(r.summary, message, `${label}: ${r.summary}`);
    for (const key of ['confirmed_failure', 'pending', 'not_running']) assert.equal(r[key], flags[key], `${label} ${key}: ${r.summary}`);
  }
  // A required job that ran in the base workflow must still succeed there.
  const gh = busyMain({ at: [green] });
  const base = gh.exec;
  gh.exec = (cmd, args) => (args[1] === `repos/${REPO}/commits/${LATEST}/check-runs?filter=all&per_page=100`
    ? result(lines([{ ...run('test (ubuntu-latest)', 'failure'), suite: 1003 }])) : base(cmd, args));
  const failedAtLater = await hotfixCI(gh);
  assert.equal(failedAtLater.ok, false);
  assert.equal(failedAtLater.pending, true, failedAtLater.summary);
});

test('a required job a path filter skipped at a later commit stays required; one skipped at the merge commit or by its event condition does not', async () => {
  // The tests run only when a changes job saw code; the later commit changed docs only.
  const filtered = CI_YML.replace("    name: test (\${{ matrix.os }})\n", "    name: test (\${{ matrix.os }})\n    if: needs.changes.outputs.code == 'true'\n");
  const docsOnly = workflow(3, LATEST, 'success');
  const skippedTests = (gh, sha) => {
    const base = gh.exec;
    gh.exec = (cmd, args) => (args[1] === `repos/${REPO}/commits/${sha}/check-runs?${sha === SHA ? '' : 'filter=all&'}per_page=100`
      ? result(lines([{ ...run('test (ubuntu-latest)', 'skipped'), suite: 1003 }, { ...run('changes'), suite: 1003 },
        { ...run('checks (shared files)', 'skipped'), suite: 1003 },
        ...(sha === SHA ? [{ ...run('test (ubuntu-latest)', 'skipped'), suite: 1001 }] : [])]))
      : base(cmd, args));
    return gh;
  };
  const untested = await hotfixCI(skippedTests(busyMain({ at: [docsOnly], files: { '.github/workflows/ci.yml': filtered } }), LATEST));
  assert.equal(untested.ok, false, untested.summary);
  assert.equal(untested.pending, true, untested.summary);
  assert.equal(untested.hotfix_ci.satisfied_by, undefined);
  assert.deepEqual(untested.hotfix_ci.rejected.map((x) => x.reason), ['not green']);
  // The same skip at the merge commit says its change did not touch the tested code either.
  const mergeSkipped = skippedTests(skippedTests(busyMain({ at: [docsOnly], files: { '.github/workflows/ci.yml': filtered } }), LATEST), SHA);
  const both = await hotfixCI(mergeSkipped);
  assert.equal(both.ok, true, both.summary);
  assert.match(both.summary, /test \( \(skipped at the merge commit too\)/);
  // A pull-request-only job is told by its condition; without a readable workflow file it stays required.
  const unread = await hotfixCI(busyMain({ at: [docsOnly], files: {} }));
  assert.equal(unread.ok, false, unread.summary);
  assert.equal(unread.pending, true);
});

test('at a later commit every check run is read, so a newer cancelled run cannot hide an older green suite', async () => {
  const green = workflow(3, LATEST, 'success');
  const cancelled = workflow(4, LATEST, 'cancelled', { event: 'workflow_dispatch' });
  const gh = busyMain({ at: [green] });
  const base = gh.exec;
  const newer = [{ ...run('test (ubuntu-latest)', 'cancelled'), suite: 1004 }, { ...run('checks (shared files)', 'cancelled'), suite: 1004 }];
  gh.exec = (cmd, args) => {
    // The default list keeps only the latest run of each name: the cancelled ones.
    if (args[1] === `repos/${REPO}/commits/${LATEST}/check-runs?per_page=100`) return result(lines(newer));
    if (args[1] === `repos/${REPO}/commits/${LATEST}/check-runs?filter=all&per_page=100`) {
      return result(lines([...newer, { ...run('test (ubuntu-latest)'), suite: 1003 }, { ...run('checks (shared files)', 'skipped'), suite: 1003 }]));
    }
    if (args[1] === `repos/${REPO}/actions/runs?head_sha=${LATEST}&per_page=100`) return result(lines([green, cancelled]));
    return base(cmd, args);
  };
  const r = await hotfixCI(gh);
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.hotfix_ci.satisfied_by.runs[0].id, 3);
});

test('the later-commit scan looks at five commits per check and carries its rejections to the next check', async () => {
  const shas = ['1', '2', '3', '4', '5', '6', '7'].map((c) => c.repeat(40));
  const at = shas.map((sha, i) => workflow(10 + i, sha, 'success', { created_at: `2026-10-13T21:0${i}:00Z` }));
  const compares = (gh) => gh.calls.filter((c) => c[2]?.includes('/compare/')).length;
  // None of them contains the merge commit (compare reports diverged).
  const first = busyMain({ at, compare: {} });
  const r1 = await hotfixCI(first);
  assert.equal(r1.ok, false);
  assert.equal(r1.pending, true);
  assert.equal(r1.not_running, undefined, r1.summary);
  assert.equal(compares(first), 5);
  assert.match(r1.summary, /2 more commits with a green run on main wait for the next check/);
  assert.deepEqual(r1.hotfix_ci.rejected.map((x) => [x.sha, x.reason]), shas.slice(0, 5).map((sha) => [sha, 'does not contain the merge commit']));
  const evidence = [{ type: 'ci', sha: SHA, revision: 1, hotfix_ci: r1.hotfix_ci }];
  const second = busyMain({ at, compare: {} });
  const r2 = await gate.run(ctx(second, { ...HOTFIX, evidence }, { ci: { required: [] } }));
  assert.equal(compares(second), 2);
  assert.equal(r2.hotfix_ci.rejected.length, 7);
  assert.equal(r2.not_running, true, r2.summary);
  assert.match(r2.summary, /7 later commits with a green run cannot stand for it/);
  const third = busyMain({ at, compare: {} });
  await gate.run(ctx(third, { ...HOTFIX, evidence: [...evidence, { type: 'ci', sha: SHA, revision: 1, hotfix_ci: r2.hotfix_ci }] }));
  assert.equal(compares(third), 0);
  // A commit rejected as not green is looked at again once it has a new green run.
  const redLater = { sha: LATEST, runs: [2], reason: 'not green' };
  const rerun = busyMain({ at: [workflow(3, LATEST, 'success')] });
  const r4 = await gate.run(ctx(rerun, { ...HOTFIX, evidence: [{ type: 'ci', sha: SHA, hotfix_ci: { merge_sha: SHA, rejected: [redLater] } }] }, { ci: { required: [] } }));
  assert.equal(r4.ok, true, r4.summary);
});

const PARENT = 'e'.repeat(40);
const OLDER = 'f'.repeat(40);
const ELSEWHERE = '9'.repeat(40);
// A job log as the runner prints it: node:test failures, each with its error line, then the step's
// error. `tests` are [name, error] pairs; `error` is the line a log without tests fails on.
// Like a real job log it has every step: the checkout's git output and a later upload step's echoed
// inputs, which carry error words that say nothing about the failure.
const jobLog = (tests = [], error = null) => [
  '##[group]Run actions/checkout@v7', '##[endgroup]', ' * [new branch]      tower-crane/T177-a-failed-gate -> origin/tower-crane/T177-a-failed-gate',
  '##[group]Run npm test', 'npm test', 'shell: /usr/bin/bash -e {0}', '##[endgroup]',
  ...tests.flatMap(([name, err], i) => [`not ok ${i + 1} - ${name}`, `  ${err}`]),
  ...(error ? [error] : []),
  '##[error]Process completed with exit code 1.',
  '##[group]Run actions/upload-artifact@v4', 'with:', '  if-no-files-found: error', '##[endgroup]',
].map((line, i) => `2026-10-13T20:00:${String(i).padStart(2, '0')}.1234567Z ${line}`).join('\n');
const proofLog = (name) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'fixtures', 'proof-logs', name), 'utf8');
// A merge commit whose push run failed. `failing` are its jobs that did not pass as {id, name, tests,
// error, conclusion}, `earlier` the base's runs of the workflow before it as [run, [{id, name, tests,
// error}...]], newest first, and `history` the commits the merge commit contains.
function redMerge({ failing, earlier = [], history = [PARENT, OLDER], at = [], evidence, patches = [] } = {}) {
  const merge = workflow(1, SHA, 'failure');
  const logs = {};
  const runJobs = {};
  for (const j of failing) logs[j.id] = j.log === null ? null : j.log ?? jobLog(j.tests, j.error);
  for (const [w, jobsOf] of earlier) {
    runJobs[w.id] = jobsOf.map(({ id, name }) => ({ id, name, conclusion: 'failure' }));
    for (const j of jobsOf) logs[j.id] = j.log ?? jobLog(j.tests, j.error);
  }
  const gh = busyMain({ merge, at, extra: { history, earlier: earlier.map(([w]) => w), runJobs, logs, patches } });
  const base = gh.exec;
  gh.exec = (cmd, args) => (args[1] === `repos/${REPO}/commits/${SHA}/check-runs?per_page=100`
    ? result(lines(failing.map((j) => ({ id: j.id, ...run(j.name, j.conclusion || 'failure'), suite: 1001 })))) : base(cmd, args));
  return gate.run(ctx(gh, { ...HOTFIX, ...(evidence ? { evidence } : {}) }, { ci: { required: ['checks (shared files)', 'test ('] } })).then((r) => ({ r, gh }));
}
const earlierRun = (id, sha, conclusion, hour) => workflow(id, sha, conclusion, { created_at: `2026-10-13T${hour}:00:00Z` });
const reads = (gh, part) => gh.calls.filter((c) => c[2]?.includes(part)).length;
const GREEN_LATER = workflow(3, LATEST, 'success');
const WIN3 = 'test (windows-latest, shard 3/3)';

test('a failure the base already had before the merge commit is main_red: CI waits for a later green run as for a cancelled one', async () => {
  // The parent's run failed the same test with the same error in another shard of the same job;
  // tests move between shards as files are added. Scratch paths and times differ per run.
  const parentRun = earlierRun(5, PARENT, 'failure', 19);
  const earlier = [[parentRun, [{ id: 601, name: 'test (windows-latest, shard 2/3)', tests: [['locks hold', 'Error: lock held at C:\\a\\_temp\\tc-Ab12\\lock after 5000ms'], ['other test', 'Error: other']] }]]];
  const failing = [{ id: 501, name: WIN3, tests: [['locks hold', 'Error: lock held at C:\\a\\_temp\\tc-Zz98\\lock after 7000ms']] }];
  const { r: waiting } = await redMerge({ failing, earlier });
  assert.equal(waiting.ok, false);
  assert.equal(waiting.confirmed_failure, undefined, waiting.summary);
  assert.equal(waiting.pending, true, waiting.summary);
  assert.equal(waiting.not_running, true);
  const failure = waiting.hotfix_ci.failure;
  assert.equal(failure.classification, 'main_red');
  assert.deepEqual(failure.runs[0].parent_run, { id: 5, sha: PARENT, event: 'push', conclusion: 'failure', url: `https://github.com/${REPO}/actions/runs/5` });
  assert.deepEqual(failure.runs[0].jobs, [{ name: WIN3, id: 501, conclusion: 'failure', explained: true, tests: [{
    name: 'locks hold', error: 'Error: lock held at C:\\a\\_temp\\tc-Zz98\\lock after 7000ms', touched: false,
    failed_before: { run: 5, sha: PARENT, url: `https://github.com/${REPO}/actions/runs/5`, job: 'test (windows-latest, shard 2/3)', job_id: 601, error: 'Error: lock held at C:\\a\\_temp\\tc-Ab12\\lock after 5000ms' },
  }] }]);
  assert.match(waiting.summary, /failed only where main was already red \(main_red\)/);
  assert.match(waiting.summary, /failed only as main already failed \(parent run 5 at eeeeeeeeee failure\): test \(windows-latest, shard 3\/3\) \[locks hold\] in run 5/);
  // A later green run on main that contains the merge commit stands for it, and the evidence keeps the classification.
  const { r: green } = await redMerge({ failing, earlier, at: [GREEN_LATER] });
  assert.equal(green.ok, true, green.summary);
  assert.equal(green.hotfix_ci.satisfied_by.sha, LATEST);
  assert.equal(green.hotfix_ci.failure.classification, 'main_red');
  assert.match(green.summary, /merge commit aaaaaaaaaa failed only where main was already red \(main_red\); judged at dddddddddd/);
  // A test the change touched counts at the parent run.
  const { r: touched } = await redMerge({ failing, earlier, at: [GREEN_LATER], patches: ["@@ -1 +1 @@\n-test('locks hold', () => {})\n+test('locks hold', () => { lock() })"] });
  assert.equal(touched.ok, true, touched.summary);
  assert.equal(touched.hotfix_ci.failure.runs[0].jobs[0].tests[0].touched, true);
  // The next check of the same failed run reuses the recorded classification without reading logs again.
  const { r: again, gh } = await redMerge({ failing, earlier, evidence: [{ type: 'ci', sha: SHA, revision: 1, hotfix_ci: waiting.hotfix_ci }] });
  assert.equal(again.hotfix_ci.failure.classification, 'main_red');
  assert.equal(reads(gh, '/logs'), 0);
  assert.equal(reads(gh, '/actions/workflows/'), 0);
});

test('a known flaky failure in an older base run is main_red only in the same job with the same error; a cancelled or uncontained run counts for nothing', async () => {
  // The parent's run was cancelled by a newer push and the grandparent's was green. An older run
  // failed the same test the same way in the same job.
  const flaky = { id: 701, name: 'test (ubuntu-latest, shard 1/3)', tests: [['racy test', 'AssertionError [ERR_ASSERTION]: 2 !== 0']] };
  const proof = { id: 602, name: 'complete gate scratch cleanup proof', tests: [], error: 'Error: gate scratch left 3 directories' };
  const window = (older) => [
    [earlierRun(16, PARENT, 'cancelled', 19), []],
    [earlierRun(15, OLDER, 'success', 18), []],
    [earlierRun(14, ELSEWHERE, 'failure', 17), [{ ...flaky, id: 801 }]],
    [earlierRun(13, OLDER, 'failure', 16), older],
  ];
  const merge = { id: 503, name: 'test (ubuntu-latest, shard 2/3)', tests: flaky.tests };
  const { r, gh } = await redMerge({ failing: [merge], earlier: window([flaky]), at: [GREEN_LATER] });
  assert.equal(r.ok, true, r.summary);
  const [record] = r.hotfix_ci.failure.runs;
  assert.equal(record.parent_run.id, 15, 'the nearest run that judged a contained commit');
  assert.equal(record.earlier_runs, 2);
  // The window reaches back seven days before the failed run.
  assert.ok(gh.calls.some((c) => c[2].includes(`created=${encodeURIComponent('2026-10-06T21:00:00Z..2026-10-13T21:00:00Z')}&`)));
  assert.equal(record.jobs[0].tests[0].failed_before.run, 13);
  assert.equal(reads(gh, '/actions/runs/15/jobs'), 0, 'a green run has no failed job to read');
  assert.equal(reads(gh, '/actions/runs/14/jobs'), 0, 'a run at a commit the merge commit does not contain is not read');
  // A proof job, which names no test, needs the parent run to have failed the job of that name with
  // the same error line from its failing step; an older run's failure does not count.
  const atParent = (older) => [[earlierRun(15, PARENT, 'failure', 18), older]];
  const { r: proofRed } = await redMerge({ failing: [{ ...proof, id: 502 }], earlier: atParent([proof]), at: [GREEN_LATER] });
  assert.equal(proofRed.ok, true, proofRed.summary);
  assert.deepEqual(proofRed.hotfix_ci.failure.runs[0].jobs[0].failed_before, { run: 15, sha: PARENT, url: `https://github.com/${REPO}/actions/runs/15`, job: proof.name, job_id: 602, error: proof.error });
  // A test failing with a generic error (a timeout, a wait for a path, a dump) also counts only at the parent run.
  const hung = { ...flaky, tests: [['racy test', 'Error: test timed out after 300000ms']] };
  const { r: hungParent } = await redMerge({ failing: [{ ...merge, tests: [['racy test', 'Error: test timed out after 120000ms']] }], earlier: atParent([hung]), at: [GREEN_LATER] });
  assert.equal(hungParent.ok, true, hungParent.summary);
  const confirmed = [
    ['the proof job failed the same way only in an older run', [proof], { ...proof, id: 502 }],
    ['a generic error only in an older run', [hung], { ...merge, tests: [['racy test', 'Error: test timed out after 120000ms']] }],
    // The same test failed only in a proof job that runs the whole suite, or on another runner.
    ['the same test in another job', [{ ...flaky, name: 'complete model swap proof' }], merge],
    ['the same test on another runner', [{ ...flaky, name: 'test (windows-latest, shard 1/3)' }], merge],
    ['the same test with another error', [{ ...flaky, tests: [['racy test', "AssertionError [ERR_ASSERTION]: '../..' !== '..\\\\..'"]] }], merge],
    ['the proof job with another error', [{ ...proof, error: 'Error: probe timed out' }], { ...proof, id: 502 }],
  ];
  for (const [label, older, failing] of confirmed) {
    const { r: c } = await redMerge({ failing: [failing], earlier: window(older), at: [GREEN_LATER] });
    assert.equal(c.ok, false, label);
    assert.equal(c.confirmed_failure, true, `${label}: ${c.summary}`);
    assert.equal(c.hotfix_ci.failure.classification, 'confirmed', label);
  }
  // A test the change touched counts only at the parent run, not in an older one.
  const { r: touched } = await redMerge({ failing: [merge], earlier: window([flaky]), at: [GREEN_LATER], patches: ["+test('racy test', async () => {"] });
  assert.equal(touched.confirmed_failure, true, touched.summary);
  assert.equal(touched.hotfix_ci.failure.runs[0].jobs[0].tests[0].touched, true);
});

test('a proof job compares the error line of its failing step in real runner logs, never step boilerplate', async () => {
  const name = 'complete gate scratch cleanup proof';
  // A cleanup leak prints its receipt with no error line; the upload step after it echoes
  // `if-no-files-found: error`. Two such failures, even at the parent run, prove nothing.
  const leak = proofLog('gate-scratch-leak.log');
  const parentLeak = [[earlierRun(15, PARENT, 'failure', 18), [{ id: 602, name, tests: [], log: leak }]]];
  const { r: leaked } = await redMerge({ failing: [{ id: 502, name, tests: [], log: leak }], earlier: parentLeak, at: [GREEN_LATER] });
  assert.equal(leaked.confirmed_failure, true, leaked.summary);
  assert.equal(leaked.hotfix_ci.failure.runs[0].jobs[0].error, null);
  // A probe that timed out prints node's source and caret lines above the error; the error itself
  // decides, and as a timeout it counts only at the parent run.
  const timeout = proofLog('gate-scratch-etimedout.log');
  const { r: parentTimeout } = await redMerge({ failing: [{ id: 502, name, tests: [], log: timeout }],
    earlier: [[earlierRun(15, PARENT, 'failure', 18), [{ id: 602, name, tests: [], log: timeout }]]], at: [GREEN_LATER] });
  assert.equal(parentTimeout.ok, true, parentTimeout.summary);
  assert.equal(parentTimeout.hotfix_ci.failure.runs[0].jobs[0].error, 'Error: spawnSync /opt/hostedtoolcache/node/26.11.1/x64/bin/node ETIMEDOUT');
  const { r: olderTimeout } = await redMerge({ failing: [{ id: 502, name, tests: [], log: timeout }],
    earlier: [[earlierRun(15, PARENT, 'success', 18), []], [earlierRun(13, OLDER, 'failure', 16), [{ id: 602, name, tests: [], log: timeout }]]], at: [GREEN_LATER] });
  assert.equal(olderTimeout.confirmed_failure, true, olderTimeout.summary);
  // Read in process: the model swap proof's failing step waits for a fixture file, a generic error,
  // and the checkout's `[new branch] ...-failed-...` line is not taken.
  const MainRed = require('../../lib/gates/main-red');
  const swap = MainRed.firstError(proofLog('model-swap-timeout.log'));
  assert.match(swap, /^error: 'waiting for \/home\/runner\/work\/_temp\/.*\/T3-second-ready'$/);
  assert.equal(MainRed.generic(swap), true);
  assert.equal(MainRed.normalize(swap), "error: 'waiting for <path>/T3-second-ready'");
  assert.notEqual(MainRed.normalize(swap), MainRed.normalize("error: 'waiting for /tmp/t/T3-first-ready'"));
  assert.equal(MainRed.firstError(leak), null);
  assert.equal(MainRed.generic('AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 8416 !== 123457'), true);
  assert.equal(MainRed.generic('AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 0'), false);
  assert.equal(MainRed.generic('AssertionError [ERR_ASSERTION]: no harness starts before its lease'), false);
});

test('a failure new at the merge commit stays a confirmed failure, with the parent run in its evidence', async () => {
  const parentRun = earlierRun(5, PARENT, 'success', 19);
  const olderRun = earlierRun(4, OLDER, 'failure', 18);
  const cases = [
    ['parent green, the test never failed before', [[parentRun, []], [olderRun, [{ id: 601, name: WIN3, tests: [['another test', 'Error: x']] }]]]],
    ['the same job failed before with other tests', [[earlierRun(5, PARENT, 'failure', 19), [{ id: 601, name: WIN3, tests: [['another test', 'Error: x']] }]]]],
    ['no earlier run on the base', []],
  ];
  for (const [label, earlier] of cases) {
    const { r } = await redMerge({ failing: [{ id: 501, name: WIN3, tests: [['new test', 'Error: new']] }], earlier, at: [GREEN_LATER] });
    assert.equal(r.ok, false, label);
    assert.equal(r.confirmed_failure, true, `${label}: ${r.summary}`);
    assert.equal(r.pending, undefined, label);
    assert.equal(r.hotfix_ci.satisfied_by, undefined, label);
    const failure = r.hotfix_ci.failure;
    assert.equal(failure.classification, 'confirmed', label);
    assert.equal(failure.runs[0].jobs[0].tests[0].failed_before, null, label);
    assert.equal(failure.runs[0].parent_run?.id, earlier.length ? 5 : undefined, label);
    assert.match(r.summary, /push workflow not successful\n.*has failures new at the merge commit, not failed the same way in the \d earlier main runs? read \((parent run 5 at eeeeeeeeee (success|failure)|no earlier main run read)\): test \(windows-latest, shard 3\/3\) \[new test\]/, label);
  }
  const old = { id: 601, name: WIN3, tests: [['old test', 'Error: old']] };
  const earlier = [[earlierRun(5, PARENT, 'failure', 19), [old, { id: 602, name: 'test (ubuntu-latest, shard 1/3)', tests: [], error: 'npm ERR! code E1' }]]];
  const oldAtMerge = { id: 501, name: WIN3, tests: old.tests };
  // One new failure among old ones still confirms; so does a timed out or cancelled job beside an old failure.
  const { r: mixed } = await redMerge({ failing: [oldAtMerge, { id: 502, name: 'test (ubuntu-latest, shard 1/3)', tests: [['new test', 'Error: new']] }], earlier });
  assert.equal(mixed.confirmed_failure, true, mixed.summary);
  assert.deepEqual(mixed.hotfix_ci.failure.runs[0].jobs.map((j) => j.explained), [true, false]);
  for (const conclusion of ['timed_out', 'cancelled']) {
    const { r: hung } = await redMerge({ failing: [oldAtMerge, { id: 503, name: 'test (ubuntu-latest, shard 2/3)', conclusion }], earlier, at: [GREEN_LATER] });
    assert.equal(hung.confirmed_failure, true, `${conclusion}: ${hung.summary}`);
    assert.match(hung.summary, new RegExp(`test \\(ubuntu-latest, shard 2/3\\) \\(${conclusion}\\)`));
  }
  // A test job whose log names no failing test proves nothing, even when the same job failed before the same way.
  const { r: unnamed } = await redMerge({ failing: [{ id: 504, name: 'test (ubuntu-latest, shard 1/3)', tests: [], error: 'npm ERR! code E1' }], earlier, at: [GREEN_LATER] });
  assert.equal(unnamed.confirmed_failure, true, unnamed.summary);
  assert.match(unnamed.summary, /test \(ubuntu-latest, shard 1\/3\) \(names no failing test\)/);
  // A confirmed classification is reused on the next check of the same run attempt.
  const { r: again, gh } = await redMerge({ failing: [oldAtMerge, { id: 502, name: 'test (ubuntu-latest, shard 1/3)', tests: [['new test', 'Error: new']] }], earlier,
    evidence: [{ type: 'ci', sha: SHA, revision: 1, hotfix_ci: mixed.hotfix_ci }] });
  assert.equal(again.confirmed_failure, true);
  assert.equal(reads(gh, '/logs'), 0);
  // A merge commit job log that cannot be read is an observation error, retried, not a verdict.
  const { r: unread } = await redMerge({ failing: [{ ...oldAtMerge, log: null }], earlier, at: [GREEN_LATER] });
  assert.equal(unread.ok, false);
  assert.equal(unread.infrastructure_failure, true, unread.summary);
  assert.equal(unread.confirmed_failure, undefined);
});

test('failing tests and their first error lines are read from runner logs, gate receipts printed as JSON included', () => {
  const MainRed = require('../../lib/gates/main-red');
  const stamp = (lines) => lines.map((l, i) => `2026-10-14T00:31:32.60${String(i).padStart(5, '0')}Z ${l}`).join('\n');
  // The spec reporter prints a failure twice; on Windows the in-place copy can have no error, and the
  // summary's generic assertion header has the values on the next line.
  const spec = MainRed.parseLog(stamp([
    '✖ two preparations overlap (6108.3279ms)',
    '✔ another test (1.2ms)',
    '✖ failing tests:',
    'test at test\\stack.test.js:10:1',
    '✖ detached spawn links the PR (12ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '  ',
    '  false !== true',
    'test at test\\worktree-metadata.test.js:91:1',
    '✖ two preparations overlap (6108.3279ms)',
    '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    "  '../..' !== '..\\\\..'",
  ]));
  assert.deepEqual(spec, [
    { name: 'two preparations overlap', error: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: '../..' !== '..\\\\..'", file: 'test/worktree-metadata.test.js' },
    { name: 'detached spawn links the PR', error: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true', file: 'test/stack.test.js' },
  ]);
  // The gate scratch proof prints the tests gate's receipt: its failing test names and output tail.
  const tail = ['✔ ok test (1ms)', '✖ failing tests:', '', 'test at test/automation.test.js:2930:1', '✖ automation dispatches rework (2872.4ms)',
    "  Error: ENOENT: no such file or directory, open '/home/runner/.cache/gate-proof-V3qL5l/context/T1.prompt'"].join('\n');
  const receipt = MainRed.parseLog(stamp(['{', '    "test_failure": {', '      "names": [', '        "automation dispatches rework",', '        "listed only"', '      ],',
    `      "output_tail": ${JSON.stringify(tail)}`, '    }', '}']));
  assert.deepEqual(receipt, [
    { name: 'automation dispatches rework', error: "Error: ENOENT: no such file or directory, open '/home/runner/.cache/gate-proof-V3qL5l/context/T1.prompt'", file: 'test/automation.test.js' },
    { name: 'listed only', error: null },
  ]);
  // Scratch paths, times, dates and long numbers do not tell two failures apart; the values do.
  assert.equal(MainRed.normalize("Error: ENOENT: open '/home/runner/.cache/gate-proof-V3qL5l/x' at 2026-10-14T02:43:42.069Z after 12ms pid 6256"),
    MainRed.normalize("Error: ENOENT: open '/home/runner/.cache/gate-proof-Qq81zz/x' at 2026-10-15T01:00:00.000Z after 7ms pid 10104"));
  assert.notEqual(MainRed.normalize("Expected values to be strictly equal: '../..' !== '..\\\\..'"), MainRed.normalize('Expected values to be strictly equal: false !== true'));
  assert.equal(MainRed.normalize('Error: replacement reviewer: [{"at":"2026-10-14T02:43:42.069Z","source":"E3c8"}]'), MainRed.normalize('Error: replacement reviewer: [{"at":"2026-10-14T05:07:06.158Z","source":"Ed3e"}]'));
  // A TAP YAML block and a diff keep their values.
  const tap = MainRed.parseLog(stamp(['not ok 3 - detached spawn links the PR', '  ---', '  error: |-', '    Expected values to be strictly equal:', '    + actual - expected', '', "    + 'exit 1'", "    - 'no progress'", '  ...']));
  assert.deepEqual(tap, [{ name: 'detached spawn links the PR', error: "error: |- Expected values to be strictly equal: + actual - expected + 'exit 1' - 'no progress'" }]);
  assert.equal(MainRed.slot('test (windows-latest, node 26, shard 3/3)'), 'test (windows-latest, node 26)');
});

test('every run and suite completed, none failed: ok', async () => {
  const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.sha, SHA);
  assert.equal(r.ref, `https://github.com/${REPO}/commit/${SHA}/checks`);
  assert.match(r.summary, /4 check runs \(2 success, 1 skipped, 1 neutral\)/);
});

test('a cancelled run: not ok, naming it', async () => {
  const gh = github({ runs: [...GREEN_RUNS, run('e2e', 'cancelled')], suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /failing: e2e \(cancelled\)/);
});

test('every failing conclusion fails the gate', async () => {
  for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    const r = await gate.run(ctx(github({ runs: [run('build'), run('test', c)], suites: GREEN_SUITES })));
    assert.equal(r.ok, false, c);
    assert.match(r.summary, new RegExp(`test \\(${c}\\)`));
  }
});

test('a run still in progress: not ok', async () => {
  const gh = github({ runs: [...GREEN_RUNS, run('e2e', null, 'in_progress')], suites: GREEN_SUITES });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.match(r.summary, /not completed: e2e \(in_progress\)/);
});

test('a suite that is queued or failed: not ok even when the listed runs are green', async () => {
  // A second workflow of the same CI app has its suite but no runs yet.
  const queued = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('github-actions', null, 'queued', 0)] })));
  assert.equal(queued.ok, false);
  assert.equal(queued.pending, true);
  assert.match(queued.summary, /check suites not green: github-actions \(queued, 0 runs\)/);
  const failed = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('github-actions', 'failure')] })));
  assert.equal(failed.ok, false);
  assert.equal(failed.pending, undefined);
  assert.match(failed.summary, /github-actions \(failure, 1 runs\)/);
});

test('required queued and running jobs are pending, while completed failures take precedence', async () => {
  for (const status of ['queued', 'in_progress']) {
    const r = await gate.run(ctx(github({ runs: [run('test (linux)', null, status)] }),
      {}, { ci: { required: ['test ('] } }));
    assert.equal(r.ok, false);
    assert.equal(r.pending, true, r.summary);
    assert.equal(r.confirmed_failure, undefined);
  }
  const rerun = await gate.run(ctx(github({
    runs: [{ ...run('test (linux)', 'failure'), id: 1, suite: 1, started_at: '2026-10-12T10:00:00Z' },
      { ...run('test (linux)', null, 'queued'), id: 2, suite: 2 }],
    suites: [{ ...suite('github-actions', 'failure'), id: 1 },
      { ...suite('github-actions', null, 'queued'), id: 2 }],
  }), {}, { ci: { required: ['test ('] } }));
  assert.equal(rerun.pending, true, 'an old failed suite does not turn its queued replacement into FAIL');
  const r = await gate.run(ctx(github({ runs: [run('test (linux)', null, 'queued'), run('test (windows)', 'failure')] }),
    {}, { ci: { required: ['test ('] } }));
  assert.equal(r.pending, undefined);
  assert.equal(r.confirmed_failure, true);
});

test('UNKNOWN mergeability is pending without consuming an infrastructure retry', async () => {
  const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES, view: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } });
  const r = await gate.run(ctx(gh, { pr: 9 }));
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.equal(r.infrastructure_failure, undefined);
  assert.match(r.summary, /mergeability is unknown/);
});

test('UNKNOWN mergeability reads the checks first, so a completed failure is not pending', async () => {
  const checks = (runs) => github({ runs, suites: GREEN_SUITES, view: { state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } });
  const failed = await gate.run(ctx(checks([run('test (linux)', 'failure')]), { pr: 9 }, { ci: { required: ['test ('] } }));
  assert.equal(failed.pending, undefined, failed.summary);
  assert.equal(failed.confirmed_failure, true);
  const green = await gate.run(ctx(checks(GREEN_RUNS), { pr: 9 }));
  assert.equal(green.ok, false);
  assert.equal(green.pending, true);
  assert.equal(green.not_running, true);
  assert.match(green.summary, /mergeability is unknown/);
  const running = await gate.run(ctx(checks([...GREEN_RUNS, run('e2e', null, 'in_progress')]), { pr: 9 }));
  assert.equal(running.pending, true);
  assert.equal(running.not_running, undefined);
});

test('a PR closed without merging stalls its CI at once', async () => {
  const gh = fakeExec((args) => args[0] === 'pr' && args[1] === 'view'
    ? result(JSON.stringify({ state: 'CLOSED', headRefOid: SHA, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })) : null);
  const r = await gate.run(ctx(gh, { pr: 9 }));
  assert.equal(r.ok, false);
  assert.equal(r.pending, true);
  assert.equal(r.stalled, true);
  assert.match(r.summary, /closed without merging/);
});

test('CI with nothing queued or running for 30 minutes at the head stalls', async () => {
  const idle = (minutes, extra = {}) => ({ type: 'ci', ok: false, pending: true, not_running: true, sha: SHA, revision: 1,
    at: new Date(Date.now() - minutes * 60000).toISOString(), ...extra });
  const none = () => github({ runs: [], suites: [] });
  const first = await gate.run(ctx(none(), { revision: 1, evidence: [] }));
  assert.equal(first.pending, true);
  assert.equal(first.not_running, true);
  assert.equal(first.stalled, undefined);
  const young = await gate.run(ctx(none(), { revision: 1, evidence: [idle(29), idle(1)] }));
  assert.equal(young.stalled, undefined);
  const old = await gate.run(ctx(none(), { revision: 1, evidence: [idle(31), idle(1)] }));
  assert.equal(old.stalled, true);
  assert.match(old.summary, /Stalled: no CI run has been queued or running at this head since/);
  // A run that started in between, another revision, or a recorded stall restarts the window.
  for (const evidence of [[idle(31), idle(10, { not_running: undefined }), idle(1)], [idle(31, { revision: 0 }), idle(1)],
    [idle(31), idle(20, { stalled: true })]]) {
    assert.equal((await gate.run(ctx(none(), { revision: 1, evidence }))).stalled, undefined);
  }
  const running = await gate.run(ctx(github({ runs: [run('e2e', null, 'queued')] }), { revision: 1, evidence: [idle(31)] }));
  assert.equal(running.pending, true);
  assert.equal(running.stalled, undefined);
});

test('a queued check stalls only past the 24-hour queue limit, a started one past the 6-hour job limit', async () => {
  const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  const checks = (extra, workflows = []) => github({ runs: [...GREEN_RUNS, { ...run('test (windows)', null, extra.status), ...extra }], suites: GREEN_SUITES, workflows });
  const queued = () => checks({ status: 'queued' });
  const first = await gate.run(ctx(queued(), { revision: 1, evidence: [] }));
  assert.equal(first.pending, true);
  assert.equal(first.not_running, undefined);
  assert.equal(first.stalled, undefined);
  const seen = (minutes, extra = {}) => ({ type: 'ci', ok: false, pending: true, sha: SHA, revision: 1, summary: first.summary,
    at: ago(minutes), ...extra });
  // Jobs wait behind other PRs on busy or self-hosted runners; that is not a stall.
  assert.equal((await gate.run(ctx(queued(), { revision: 1, evidence: [seen(31)] }))).stalled, undefined);
  assert.equal((await gate.run(ctx(queued(), { revision: 1, evidence: [seen(24 * 60)] }))).stalled, undefined);
  const old = await gate.run(ctx(queued(), { revision: 1, evidence: [seen(24 * 60 + 31)] }));
  assert.equal(old.stalled, true);
  assert.equal(old.pending, true);
  assert.match(old.summary, /Stalled: the checks above have been queued without starting at this head since .*past GitHub's 24-hour queue limit/);
  assert.match(old.summary, /the stall only flags the inbox/);
  // A change in what is waiting, another head or revision, or a recorded stall restarts the window.
  for (const e of [seen(24 * 60 + 31, { summary: 'CI not green: not completed: e2e (queued)' }), seen(24 * 60 + 31, { revision: 0 }),
    seen(24 * 60 + 31, { sha: 'b'.repeat(40) }), seen(24 * 60 + 31, { stalled: true }), seen(24 * 60 + 31, { not_running: true })]) {
    assert.equal((await gate.run(ctx(queued(), { revision: 1, evidence: [e] }))).stalled, undefined);
  }
  // An Actions job's workflow run gives its creation time, with no earlier evidence needed.
  const workflow = (minutes, extra = {}) => [{ id: 5, name: 'ci', path: '.github/workflows/ci.yml', workflow_id: 1, event: 'pull_request', head_sha: SHA,
    head_branch: 'change', check_suite_id: 77, status: 'queued', conclusion: null, run_attempt: 1, created_at: ago(minutes), ...extra }];
  const actions = (minutes, extra) => checks({ status: 'queued', suite: 77 }, workflow(minutes, extra));
  assert.equal((await gate.run(ctx(actions(23 * 60), { revision: 1, evidence: [] }))).stalled, undefined);
  assert.equal((await gate.run(ctx(actions(24 * 60 + 31), { revision: 1, evidence: [] }))).stalled, true);
  // A re-run keeps the run's created_at; its attempt's run_started_at is when the job queued again.
  const rerun = actions(3 * 24 * 60, { run_attempt: 2, run_started_at: ago(10) });
  assert.equal((await gate.run(ctx(rerun, { revision: 1, evidence: [] }))).stalled, undefined, 'a job re-run on an old head is not stalled');
  assert.equal((await gate.run(ctx(actions(3 * 24 * 60, { run_attempt: 2, run_started_at: ago(24 * 60 + 31) }), { revision: 1, evidence: [] }))).stalled, true);

  // This repository's own jobs run 20 to 45 minutes in progress with no status change.
  const running = (minutes) => checks({ status: 'in_progress', started_at: ago(minutes) });
  const long = await gate.run(ctx(running(45), { revision: 1, evidence: [seen(45, { summary: (await gate.run(ctx(running(45), { revision: 1, evidence: [] }))).summary })] }));
  assert.equal(long.pending, true);
  assert.equal(long.stalled, undefined, 'a healthy long job is not stalled');
  assert.equal((await gate.run(ctx(running(6 * 60), { revision: 1, evidence: [] }))).stalled, undefined);
  const dead = await gate.run(ctx(running(6 * 60 + 31), { revision: 1, evidence: [] }));
  assert.equal(dead.stalled, true);
  assert.match(dead.summary, /Stalled: a check has been in progress at this head since .*past GitHub's 6-hour job limit/);
  assert.match(dead.summary, /A self-hosted job allowed to run longer also shows here/);
});

test('a completed failed suite takes precedence over required queued jobs', async () => {
  const r = await gate.run(ctx(github({
    runs: [run('test (linux)', null, 'queued')],
    suites: [suite('external-ci', 'failure')],
  }), {}, { ci: { required: ['test ('] } }));
  assert.equal(r.ok, false);
  assert.equal(r.pending, undefined);
  assert.equal(r.worker_failure, true);
  assert.match(r.summary, /failed check suites: external-ci \(failure\)/);
});

test('a suite with no runs from another app is never inferred away', async () => {
  // Green Actions runs next to another provider whose suite has no runs yet: CI is still going.
  for (const status of ['queued', 'in_progress']) {
    const r = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: [...GREEN_SUITES, suite('external-ci', null, status, 0)] })));
    assert.equal(r.ok, false, status);
    assert.match(r.summary, new RegExp(`external-ci \\(${status}, 0 runs\\)`));
    assert.match(r.summary, /ci\.ignore_apps/);
    assert.match(r.summary, /tower-crane project set --ci-ignore-apps/);
  }
});

test('apps listed in project.json ci.ignore_apps are skipped, and only those', async () => {
  const project = { ci: { ignore_apps: ['claude', 'cursor'] } };
  const suites = [...GREEN_SUITES, suite('claude', null, 'queued', 0), suite('cursor', null, 'in_progress', 1)];
  const runs = [...GREEN_RUNS, run('cursor review', 'failure', 'completed', 'cursor')];
  const r = await gate.run(ctx(github({ runs, suites }), {}, project));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /4 check runs/);
  assert.match(r.summary, /Ignored as listed in project\.json ci\.ignore_apps: claude \(1 suite, 0 runs\), cursor \(1 suite, 1 run\)/);
  const other = await gate.run(ctx(github({ runs, suites: [...suites, suite('external-ci', null, 'queued', 0)] }), {}, project));
  assert.equal(other.ok, false);
  assert.match(other.summary, /external-ci \(queued, 0 runs\)/);
  // Runs only from ignored apps are no CI at all.
  const none = await gate.run(ctx(github({ runs: [run('cursor review', 'success', 'completed', 'cursor')], suites }), {}, project));
  assert.equal(none.ok, false);
  assert.match(none.summary, /no check runs/);
});

test('a malformed ci.ignore_apps: not ok, naming the field', async () => {
  for (const ci of [{ ignore_apps: 'claude' }, { ignore_apps: [''] }, 'claude', [1]]) {
    const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES });
    const r = await gate.run(ctx(gh, {}, { ci }));
    assert.equal(r.ok, false, JSON.stringify(ci));
    assert.match(r.summary, /ci\.ignore_apps must be an array/);
    assert.match(r.summary, /tower-crane project set --ci-ignore-apps/);
    assert.match(r.summary, /--ci-ignore-apps null/);
    assert.equal(gh.calls.length, 0);
  }
});

test('no check runs at all: not ok', async () => {
  const r = await gate.run(ctx(github({ runs: [], suites: [] })));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no check runs on aaaaaaaaaa/);
});

test('the PR head moved off the submitted sha: not ok', async () => {
  const gh = github({ runs: GREEN_RUNS, suites: GREEN_SUITES, head: OTHER });
  const r = await gate.run(ctx(gh, { pr: 42 }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR head moved: PR #42 head is bbbbbbbbbb/);
  assert.deepEqual(gh.calls[0], ['gh', 'pr', 'view', '42', '-R', REPO, '--json', 'state,headRefOid,mergeable,mergeStateStatus']);
});

test('the PR head is the submitted sha: CI decides', async () => {
  const r = await gate.run(ctx(github({ runs: GREEN_RUNS, suites: GREEN_SUITES }), { pr: 42 }));
  assert.equal(r.ok, true, r.summary);
});

test('gh failing: not ok with its message', async () => {
  const r = await gate.run(ctx(github({ apiError: 'gh: Not Found (HTTP 404)' })));
  assert.equal(r.ok, false);
  assert.match(r.summary, /HTTP 404/);
});

test('gh failures retain child startup errors, exit status and signals', async () => {
  const cases = [
    [{ status: null, error: { code: 'EAGAIN', message: 'spawnSync gh EAGAIN' } }, ['status=null', 'EAGAIN', 'spawnSync gh EAGAIN']],
    [{ status: null, error: { code: 'ETXTBSY', message: 'spawnSync gh ETXTBSY' } }, ['status=null', 'ETXTBSY']],
    [{ status: null, signal: 'SIGTERM' }, ['status=null', 'signal=SIGTERM']],
    [{ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT', message: 'spawnSync gh ETIMEDOUT' } }, ['ETIMEDOUT', 'signal=SIGKILL']],
    [{ status: 7 }, ['status=7', 'no output']],
    [{ status: 1, stderr: 'gh: Not Found (HTTP 404)' }, ['status=1', 'HTTP 404']],
    [{ status: null, error: { code: 'ENOENT', message: 'spawnSync gh ENOENT' } }, ['ENOENT', 'gh not found on PATH', 'gh auth login']],
  ];
  for (const [failure, expected] of cases) {
    const gh = fakeExec(() => failure);
    const r = await gate.run(ctx(gh));
    assert.equal(r.ok, false);
    for (const text of expected) assert.ok(r.summary.includes(text), `${text}: ${r.summary}`);
    assert.equal(gh.calls.length, 1, 'a failure is reported without retrying');
  }
});

test('GitHub observation errors are infrastructure failures', async () => {
  const cases = [
    ['PR transport', 'view', result('', 1, 'HTTP 502: Bad Gateway'), /HTTP 502/],
    ['PR output', 'view', result('{'), /could not read gh pr view/],
    ['check runs', 'check-runs', result('', 1, 'HTTP 502: Bad Gateway'), /HTTP 502/],
    ['check suites', 'check-suites', result('', 1, 'HTTP 502: Bad Gateway'), /HTTP 502/],
    ['Actions API', 'actions/runs', result('', 1, 'HTTP 502: Bad Gateway'), /HTTP 502/],
    ['check output', 'check-runs', result('{'), /could not read gh api/],
  ];
  for (const [label, target, failure, message] of cases) {
    const gh = fakeExec((args) => {
      if (args[0] === 'pr') return target === 'view' ? failure
        : result(JSON.stringify({ headRefOid: SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }));
      if (args[1].includes(target)) return failure;
      return result(lines(args[1].includes('check-runs') ? GREEN_RUNS
        : args[1].includes('check-suites') ? GREEN_SUITES : []));
    });
    const r = await gate.run(ctx(gh, { pr: 42 }));
    assert.equal(r.ok, false, label);
    assert.equal(r.infrastructure_failure, true, label);
    assert.notEqual(r.confirmed_failure, true, label);
    assert.match(r.summary, message, label);
  }
});

test('workflow supersession orders by creation time and id, with name fallback and a known replacement suite', async () => {
  const old = { id: 100, head_sha: SHA, check_suite_id: 1, path: 'ci.yml', name: 'CI', event: 'pull_request', created_at: '2026-10-11T10:00:00Z', status: 'completed', conclusion: 'failure' };
  const current = { ...old, id: 200, check_suite_id: 2, created_at: '2026-10-11T11:00:00Z', conclusion: 'success' };
  const cases = [
    ['time before id', { ...old, id: 300 }, current, true],
    ['id breaks time tie', old, { ...current, created_at: old.created_at }, true],
    ['missing time uses id', { ...old, created_at: null }, { ...current, created_at: null }, true],
    ['missing latest timestamp uses id', old, { ...current, created_at: null }, true],
    ['name fallback', { ...old, path: null }, { ...current, path: null }, true],
    ['same path after rename', old, { ...current, name: 'Renamed CI' }, true],
    ['different path with same name', old, { ...current, path: 'other.yml' }, false],
    ['different event', old, { ...current, event: 'push' }, false],
    ['different head', old, { ...current, head_sha: OTHER }, false],
    ['missing event', old, { ...current, event: null }, false],
    ['missing workflow identity', old, { ...current, path: null, name: null }, false],
    ['missing suite mapping', old, { ...current, check_suite_id: null }, false],
    ['unread replacement suite', old, { ...current, check_suite_id: 3 }, false],
    ['same suite on rerun', old, { ...current, check_suite_id: 1 }, false],
  ];
  for (const [label, earlier, later, ok] of cases) {
    const r = await gate.run(ctx(github({
      runs: [{ ...run('build'), suite: 2 }],
      suites: [{ ...suite('github-actions', 'failure'), id: 1 }, { ...suite('github-actions'), id: 2 }],
      workflows: [later, earlier],
    })));
    assert.equal(r.ok, ok, `${label}: ${r.summary}`);
    if (ok) assert.match(r.summary, /Superseded workflow runs/);
    else assert.match(r.summary, /check suites not green/);
  }
});

test('only superseded Actions suites and their jobs are excluded; the latest pending suite still blocks', async () => {
  const workflows = [
    { id: 100, check_suite_id: 1, name: 'CI', event: 'pull_request', head_sha: SHA },
    { id: 200, check_suite_id: 2, name: 'CI', event: 'pull_request', head_sha: SHA },
  ];
  const suites = [{ ...suite('github-actions', 'failure'), id: 1 }, { ...suite('github-actions'), id: 2 }];
  const runs = [{ ...run('old job', 'failure'), suite: 1 }, { ...run('build'), suite: 2 }];
  const green = await gate.run(ctx(github({ runs, suites, workflows })));
  assert.equal(green.ok, true, green.summary);
  assert.doesNotMatch(green.summary, /failing: old job/);
  const pending = await gate.run(ctx(github({
    runs, workflows, suites: [suites[0], { ...suites[1], status: 'queued', conclusion: null, runs: 0 }],
  })));
  assert.equal(pending.ok, false);
  assert.match(pending.summary, /check suites not green.*queued/);
  assert.match(pending.summary, /Superseded workflow runs/);
});

test('an Actions API failure fails closed, but ignored Actions do not need its API', async () => {
  const fake = github({ runs: GREEN_RUNS, suites: GREEN_SUITES });
  const gh = fakeExec((args) => args[1]?.includes('/actions/runs?')
    ? result('', 1, 'HTTP 403')
    : fake.exec('gh', args));
  const failed = await gate.run(ctx(gh));
  assert.equal(failed.ok, false);
  assert.match(failed.summary, /HTTP 403/);
  const ignored = await gate.run(ctx(github({
    runs: [run('external build', 'success', 'completed', 'external-ci')],
    suites: [...GREEN_SUITES, suite('external-ci')],
  }), {}, { ci: { ignore_apps: ['github-actions'] } }));
  assert.equal(ignored.ok, true, ignored.summary);
});

test('same-named jobs from another workflow cannot supersede a current failed suite', async () => {
  const r = await gate.run(ctx(github({
    runs: [
      { ...run('build', 'failure'), id: 100, started_at: '2026-10-11T10:00:00Z', suite: 1 },
      { ...run('build'), id: 200, started_at: '2026-10-11T11:00:00Z', suite: 2 },
    ],
    suites: [{ ...suite('github-actions', 'failure'), id: 1 }, { ...suite('github-actions'), id: 2 }],
    workflows: [
      { id: 100, check_suite_id: 1, path: 'ci.yml', event: 'pull_request', head_sha: SHA },
      { id: 200, check_suite_id: 2, path: 'other.yml', event: 'pull_request', head_sha: SHA },
    ],
  })));
  assert.equal(r.ok, false, r.summary);
  assert.match(r.summary, /check suites not green.*failure/);
});

test('workflow supersession cannot exclude a suite from another app', async () => {
  const r = await gate.run(ctx(github({
    runs: [{ ...run('build'), suite: 2 }],
    suites: [{ ...suite('external-ci', 'failure'), id: 1 }, { ...suite('github-actions'), id: 2 }],
    workflows: [
      { id: 100, check_suite_id: 1, name: 'CI', event: 'pull_request', head_sha: SHA },
      { id: 200, check_suite_id: 2, name: 'CI', event: 'pull_request', head_sha: SHA },
    ],
  })));
  assert.equal(r.ok, false, r.summary);
  assert.match(r.summary, /check suites not green: external-ci \(failure/);
});

test('a dispatched run at the PR head never counts for or against the PR checks', async () => {
  const required = { ci: { required: ['checks (shared files)'] } };
  const pull = { id: 100, check_suite_id: 1, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: SHA, created_at: '2026-10-11T10:00:00Z' };
  const manual = { ...pull, id: 200, check_suite_id: 2, event: 'workflow_dispatch', created_at: '2026-10-11T11:00:00Z' };
  // The dispatched run's PR-only job skips, after the PR's run of it; its full matrix fails and runs.
  const dispatched = [
    { ...run('checks (shared files)', 'skipped'), id: 21, started_at: '2026-10-11T11:00:00Z', suite: 2 },
    { ...run('test (ubuntu-latest, node 26, shard 1/3)', 'failure'), id: 22, suite: 2 },
    { ...run('repeat (windows-latest, node 26)', null, 'in_progress'), id: 23, suite: 2 },
  ];
  const cases = [
    ['green PR run', [{ ...run('checks (shared files)'), id: 11, started_at: '2026-10-11T10:00:00Z', suite: 1 }], 'success', true, /CI green/],
    ['failing PR run', [{ ...run('checks (shared files)', 'failure'), id: 11, started_at: '2026-10-11T10:00:00Z', suite: 1 }], 'failure', false, /required check runs not successful: checks \(shared files\) \(failure\)/],
    ['PR run not started', [], null, false, /missing required check runs \(ci\.required\): checks \(shared files\)/],
  ];
  for (const [label, prRuns, prSuite, ok, summary] of cases) {
    const suites = [...(prSuite ? [{ ...suite('github-actions', prSuite), id: 1 }] : []), { ...suite('github-actions', null, 'in_progress', 3), id: 2 }];
    const gh = github({ runs: [...prRuns, ...dispatched], suites, workflows: prSuite ? [pull, manual] : [manual] });
    const r = await gate.run(ctx(gh, { pr: 42 }, required));
    assert.equal(r.ok, ok, `${label}: ${r.summary}`);
    assert.match(r.summary, summary, label);
    assert.match(r.summary, /Not PR checks, set aside: \.github\/workflows\/ci\.yml \(workflow_dispatch, run 200\)/, label);
    assert.doesNotMatch(r.summary, /shard 1\/3|repeat/, `${label}: the dispatched jobs are not judged`);
    const exec = (cmd, args) => (args[1] === `repos/${REPO}/pulls/42/comments?per_page=100` ? result('') : gh.exec(cmd, args));
    const report = await gate.submitReport({ ...ctx(gh), exec }, { repo: REPO, ...required }, { sha: SHA, pr: 42, taskId: 'T3' });
    assert.equal(!!report.refusal, label === 'failing PR run', `${label}: ${report.refusal}`);
    assert.equal(report.pending?.length ?? 0, label === 'PR run not started' ? 1 : 0, `${label}: ${report.report}`);
    assert.match(report.report + (report.refusal || ''), /set aside|failing: checks \(shared files\)/, label);
  }
});
