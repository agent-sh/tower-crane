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

function github({ runs = [], suites = [], workflows = [], head = SHA, apiError = null, view = {} } = {}) {
  return fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify({ headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...view }));
    if (args[0] !== 'api') return null;
    assert.ok(args.includes('--paginate'), 'every page must be read');
    if (apiError) return result('', 1, apiError);
    if (args[1] === `repos/${REPO}/commits/${SHA}/check-runs?per_page=100`) return result(lines(runs));
    if (args[1] === `repos/${REPO}/commits/${SHA}/check-suites?per_page=100`) return result(lines(suites));
    if (args[1] === `repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`) return result(lines(workflows));
    return null;
  });
}

function ctx(gh, task = {}, project = {}) {
  return { root: '/repo', worktree: null, task: { id: 'T3', kind: 'code', sha: SHA, pr: null, ...task }, project: { repo: REPO, base: 'main', ...project }, args: {}, exec: gh.exec, log() {} };
}

const GREEN_RUNS = [run('build'), run('lint'), run('docs', 'skipped'), run('bench', 'neutral')];
const GREEN_SUITES = [suite('github-actions'), suite('github-actions', 'neutral')];

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
