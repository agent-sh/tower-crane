'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { BIN, cachedFixture } = require('./helpers');

const github = path.join(__dirname, 'fixtures', 'github-submit.js');
const JOB_LOG = 'https://github.com/acme/app/actions/runs/9/job/456';

function checkRun(name, extra = {}) {
  return { name, app: 'github-actions', status: 'completed', conclusion: 'success', suite: 1, url: null, output: null, ...extra };
}

function suite(id, extra = {}) {
  return { id, app: 'github-actions', status: 'completed', conclusion: 'success', runs: 2, ...extra };
}

function comment(id, extra = {}) {
  return { id, in_reply_to_id: null, path: 'lib/x.js', line: 12, body: 'finding', user: 'revuto-review[bot]', ...extra };
}

function fixture(t) {
  return cachedFixture(t, 'submit-ci', (h) => {
    h.init(['--repo', 'acme/app']);
    const project = h.readState('project.json');
    project.ci = {
      required: ['test ('],
      capped_review: [{ app: 'revuto-review', pattern: 'Revuto could not complete this review' }],
    };
    h.writeState('project.json', project);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
}

// Submits T1 with PR 7 while the stubbed GitHub reports `data` for the head.
function submitPr(h, data, extra = []) {
  const file = path.join(h.base, 'github.json');
  fs.writeFileSync(file, JSON.stringify({ sha: h.sha, ...data }));
  return cp.spawnSync(process.execPath, ['--require', github, BIN, 'submit', 'T1', '--agent', 'worker',
    '--sha', h.sha, '--pr', '7', ...extra], {
    cwd: h.repo, env: { ...h.env, TEST_GITHUB: file, TEST_OWNER_KEY: h.env.TOWER_CRANE_OWNER_KEY }, encoding: 'utf8', timeout: 60000,
  });
}

function status(h) {
  return h.readState('tasks.json').tasks[0].status;
}

function allowPending(h) {
  const brief = path.join(h.base, 'brief.md');
  fs.writeFileSync(brief, '# T1\n\n## Shared\n\nforce-ci-pending: allowed\n');
  h.ok(['brief', 'set', 'T1', '--file', brief]);
}

test('a pending required check refuses the submit and names the jobs still running', (t) => {
  const h = fixture(t);
  const r = submitPr(h, {
    runs: [checkRun('build'), checkRun('test (ubuntu-latest)', { status: 'in_progress', conclusion: null })],
    suites: [suite(1, { status: 'in_progress', conclusion: null })],
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /CI is still running at \w+ in acme\/app: wait for CI to finish, then submit again\./);
  assert.match(r.stderr, /pending: test \(ubuntu-latest\) \(in_progress\)/);
  assert.equal(status(h), 'in_progress');
});

test('a failing check refuses with its job and the first failing lines of the log, even when pending is forced', (t) => {
  const h = fixture(t);
  allowPending(h);
  const log = [
    'test (windows-latest)\tRun tests\t2026-10-09T10:00:00.1234567Z ok 1 - runs fine',
    'test (windows-latest)\tRun tests\t2026-10-09T10:00:01.0000000Z not ok 4 - quoted paths keep their backslashes',
    'test (windows-latest)\tRun tests\t2026-10-09T10:00:01.1000000Z   AssertionError: expected C:\\repo\\lib',
  ].join('\n');
  const data = {
    runs: [checkRun('test (windows-latest)', { conclusion: 'failure', url: JOB_LOG }), checkRun('test (ubuntu-latest)', { status: 'in_progress', conclusion: null })],
    suites: [suite(1, { conclusion: 'failure' })],
    logs: { 456: log },
  };
  const r = submitPr(h, data, ['--force-ci-pending']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /CI failed at \w+ in acme\/app: fix the failing checks, push, and submit again\./);
  assert.match(r.stderr, /failing: test \(windows-latest\) \(failure\)/);
  assert.match(r.stderr, /test \(windows-latest\) log:\n {2}not ok 4 - quoted paths keep their backslashes\n {4}AssertionError: expected C:\\repo\\lib/);
  assert.doesNotMatch(r.stderr, /ok 1 - runs fine|2026-10-09T10/);
  assert.equal(status(h), 'in_progress');
});

test('capped or crashed revuto does not block a green submit', (t) => {
  const h = fixture(t);
  const revuto = checkRun('Revuto', {
    app: 'revuto-review', conclusion: 'failure', suite: 2,
    output: { title: 'Revuto did not review this pull request', summary: 'Revuto could not complete this review' },
  });
  const r = submitPr(h, {
    runs: [checkRun('build'), checkRun('test (ubuntu-latest)'), checkRun('test (windows-latest)'), revuto],
    suites: [suite(1), suite(2, { app: 'revuto-review', conclusion: 'failure', runs: 1 })],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /submitted T1 at \w{7}/);
  assert.match(r.stdout, /Nonblocking capped reviews as listed in project.json ci.capped_review: Revuto \(revuto-review\)/);
  assert.equal(status(h), 'submitted');
});

test('revuto findings print with file, line and body; only a latest [resolved] reply closes one', (t) => {
  const h = fixture(t);
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)'), checkRun('test (windows-latest)')],
    suites: [suite(1)],
    comments: [
      comment(11, { line: 12, body: '**[P1]** Quoted paths break on Windows.' }),
      comment(12, { line: 30, body: 'Answered finding' }),
      comment(13, { in_reply_to_id: 12, user: 'worker-T1', body: '[resolved]\nfixed in the next commit' }),
      comment(14, { line: 40, body: 'Question finding' }),
      comment(15, { in_reply_to_id: 14, user: 'worker-T1', body: 'Can you explain what input breaks?' }),
      comment(16, { line: 50, body: 'Reopened finding' }),
      comment(17, { in_reply_to_id: 16, user: 'worker-T1', body: '[resolved]' }),
      comment(18, { in_reply_to_id: 16, user: 'a-person', body: 'Still broken on Windows.' }),
      comment(19, { user: 'a-person', body: 'a human comment' }),
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revuto left 3 open inline findings on PR #7 \(listed for you; they do not block the submit\):\n {2}lib\/x\.js:12\n {4}\*\*\[P1\]\*\* Quoted paths break on Windows\.\n {2}lib\/x\.js:40\n {4}Question finding\n {2}lib\/x\.js:50\n {4}Reopened finding/);
  assert.doesNotMatch(r.stdout, /Answered finding|a human comment/);
  assert.equal(status(h), 'submitted');
});

test('--json carries the CI report as ci_report, findings included', (t) => {
  const h = fixture(t);
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)')],
    suites: [suite(1)],
    comments: [comment(11, { line: 12, body: '**[P1]** Quoted paths break on Windows.' })],
  }, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.status, 'submitted');
  assert.match(data.ci_report, /revuto left 1 open inline finding on PR #7/);
  assert.match(data.ci_report, /lib\/x\.js:12\n {4}\*\*\[P1\]\*\* Quoted paths break on Windows\./);
});

test('a PR that conflicts with its base refuses the submit, even with a failing required check', (t) => {
  const h = fixture(t);
  const r = submitPr(h, {
    pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    runs: [checkRun('test (windows-latest)', { conclusion: 'failure', url: JOB_LOG })],
    suites: [suite(1, { conclusion: 'failure' })],
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /PR #7 is CONFLICTING \(DIRTY\): resolve merge conflicts with the base branch and submit the new head\./);
  assert.doesNotMatch(r.stderr, /wait for CI/);
  assert.equal(status(h), 'in_progress');
});

test('a shimmed agent whose gh policy refuses gh api submits with a notice that the head was not checked', (t) => {
  const h = fixture(t);
  const r = submitPr(h, { refuseApi: true, runs: [], suites: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CI at \w+ in acme\/app was not checked: this agent's gh policy refuses gh api/);
  assert.equal(status(h), 'submitted');
});

test('--force-ci-pending submits past pending checks only when the brief allows it', (t) => {
  const h = fixture(t);
  const data = {
    runs: [checkRun('test (ubuntu-latest)', { status: 'queued', conclusion: null })],
    suites: [suite(1, { status: 'queued', conclusion: null, runs: 1 })],
  };
  const refused = submitPr(h, data, ['--force-ci-pending']);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /T1's brief does not allow --force-ci-pending/);
  assert.equal(status(h), 'in_progress');

  allowPending(h);
  const forced = submitPr(h, data, ['--force-ci-pending']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /CI still pending at \w+, submitted with --force-ci-pending \(the brief allows it\): test \(ubuntu-latest\) \(queued\)/);
  assert.equal(status(h), 'submitted');
});

test('--force-ci-pending is refused when the brief revokes the allowance while the checks are read', (t) => {
  const h = fixture(t);
  allowPending(h);
  const revoked = path.join(h.base, 'revoked.md');
  fs.writeFileSync(revoked, '# T1\n\n## Shared\n\nWait for CI to finish before submitting.\n');
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)', { status: 'queued', conclusion: null })],
    suites: [suite(1, { status: 'queued', conclusion: null, runs: 1 })],
    briefSet: revoked,
  }, ['--force-ci-pending']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /T1's brief does not allow --force-ci-pending/);
  assert.equal(status(h), 'in_progress');
});

test('a quoted force-ci-pending line in a fenced block does not allow the override', (t) => {
  const h = fixture(t);
  const brief = path.join(h.base, 'brief.md');
  fs.writeFileSync(brief, [
    '# T1', '', '## Shared', '',
    'Do not use --force-ci-pending for this task. The block below is only an example of the setting, not approval.', '',
    '```text', 'force-ci-pending: allowed', '```', '',
  ].join('\n'));
  h.ok(['brief', 'set', 'T1', '--file', brief]);
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)', { status: 'queued', conclusion: null })],
    suites: [suite(1, { status: 'queued', conclusion: null, runs: 1 })],
  }, ['--force-ci-pending']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /T1's brief does not allow --force-ci-pending/);
  assert.equal(status(h), 'in_progress');
});

test('a quoted force-ci-pending line in an HTML comment does not allow the override', (t) => {
  const h = fixture(t);
  const brief = path.join(h.base, 'brief.md');
  fs.writeFileSync(brief, [
    '# T1', '', '## Shared', '',
    'Do not use --force-ci-pending. Wait for CI to finish.', '',
    '<!-- Hidden example only, not approval:', 'force-ci-pending: allowed', '-->', '',
  ].join('\n'));
  h.ok(['brief', 'set', 'T1', '--file', brief]);
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)', { status: 'queued', conclusion: null })],
    suites: [suite(1, { status: 'queued', conclusion: null, runs: 1 })],
  }, ['--force-ci-pending']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /T1's brief does not allow --force-ci-pending/);
  assert.equal(status(h), 'in_progress');
});

test('a failing refusal prints the logs of the first three failing jobs and the command for the rest', (t) => {
  const h = fixture(t);
  const job = (id, name) => checkRun(name, { conclusion: 'failure', url: `https://github.com/acme/app/actions/runs/9/job/${id}` });
  const data = {
    runs: [job(456, 'test (a)'), job(457, 'test (b)'), job(458, 'test (c)'), job(459, 'test (d)')],
    suites: [suite(1, { conclusion: 'failure' })],
    logs: {
      456: 'test (a)\tRun\t2026-10-09T10:00:00.1Z not ok 1 - a fails',
      457: 'test (b)\tRun\t2026-10-09T10:00:00.1Z not ok 1 - b fails',
      458: 'test (c)\tRun\t2026-10-09T10:00:00.1Z not ok 1 - c fails',
      459: 'test (d)\tRun\t2026-10-09T10:00:00.1Z not ok 1 - d fails',
    },
  };
  const r = submitPr(h, data);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /test \(c\) log:\n {2}not ok 1 - c fails/);
  assert.doesNotMatch(r.stderr, /test \(d\) log:|d fails/);
  assert.match(r.stderr, /test \(d\) log not shown; read it with gh run view --job 459 --log-failed -R acme\/app/);
  assert.equal(status(h), 'in_progress');
});
