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
  return { id, in_reply_to_id: null, path: 'lib/x.js', line: 12, body: 'finding', user: 'revuto-review[bot]', original_commit_id: null, ...extra };
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

// Runs the CLI while the stubbed GitHub reports `data` for the head.
function withGithub(h, data, args, env = {}) {
  const file = path.join(h.base, 'github.json');
  fs.writeFileSync(file, JSON.stringify({ sha: h.sha, ...data }));
  return cp.spawnSync(process.execPath, ['--require', github, BIN, ...args], {
    cwd: h.repo, env: { ...h.env, ...env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 300000,
  });
}

// Submits T1 with PR 7 while the stubbed GitHub reports `data` for the head.
function submitPr(h, data, extra = []) {
  return withGithub(h, data, ['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--pr', '7', ...extra]);
}

// The orchestrator's `check ci T1` while the stubbed GitHub reports `data`.
function checkCi(h, data, env) {
  return withGithub(h, data, ['check', 'ci', 'T1', '--agent', 'orchestrator'], env);
}

function ciEvidence(h) {
  return h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'ci');
}

const PENDING = {
  runs: [checkRun('build'), checkRun('test (ubuntu-latest)', { status: 'in_progress', conclusion: null })],
  suites: [suite(1, { status: 'in_progress', conclusion: null })],
};
const WINDOWS_LOG = [
  'test (windows-latest)\tRun tests\t2026-10-09T10:00:00.1234567Z ok 1 - runs fine',
  'test (windows-latest)\tRun tests\t2026-10-09T10:00:01.0000000Z \x1b[31mnot ok 4 - quoted paths keep their backslashes\x1b[0m',
  'test (windows-latest)\tRun tests\t2026-10-09T10:00:01.1000000Z   \x1b]8;;https://example.test\x07AssertionError\x1b]8;;\x1b\\: expected C:\\repo\\lib\x00\x07\x1b',
].join('\n');

function status(h) {
  return h.readState('tasks.json').tasks[0].status;
}

test('a pending required check does not refuse: submit records the head and check ci later records the result', (t) => {
  const h = fixture(t);
  const r = submitPr(h, PENDING);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /submitted T1 at \w{7}/);
  assert.match(r.stdout, /CI still running at \w+ in acme\/app: test \(ubuntu-latest\) \(in_progress\), github-actions suite \(in_progress\)\. The head is submitted and tower-crane check ci waits for these checks on the host; a failure comes back as rework with the failing jobs and their first failing lines\. Do not wait for CI\./);
  assert.equal(status(h), 'submitted');
  assert.ok(h.readState('tasks.json').tasks[0].notes.some((n) => n.text === 'submitted with CI pending: test (ubuntu-latest) (in_progress), github-actions suite (in_progress)'));

  const waiting = checkCi(h, PENDING);
  assert.equal(waiting.status, 1, waiting.stderr);
  assert.deepEqual(ciEvidence(h).map((e) => [e.ok, e.pending === true]), [[false, true]]);
  assert.equal(status(h), 'submitted');

  const green = checkCi(h, { runs: [checkRun('build'), checkRun('test (ubuntu-latest)')], suites: [suite(1)] });
  assert.equal(green.status, 0, green.stderr);
  assert.deepEqual(ciEvidence(h).map((e) => [e.ok, e.pending === true]), [[false, true], [true, false]]);
  assert.match(ciEvidence(h).at(-1).summary, /^CI green at \w+ in acme\/app/);
});

test('after a pending submit, a failing job reaches the ci gate summary with the first failing lines of its log', (t) => {
  const h = fixture(t);
  assert.equal(submitPr(h, PENDING).status, 0);
  const r = checkCi(h, {
    runs: [checkRun('build'), checkRun('test (windows-latest)', { conclusion: 'failure', url: JOB_LOG })],
    suites: [suite(1, { conclusion: 'failure' })],
    logs: { 456: WINDOWS_LOG },
  });
  assert.equal(r.status, 1, r.stderr);
  const failed = ciEvidence(h).at(-1);
  assert.equal(failed.ok, false);
  assert.equal(failed.pending, undefined);
  assert.equal(failed.confirmed_failure, true);
  assert.match(failed.summary, /failing: test \(windows-latest\) \(failure\)\ntest \(windows-latest\) log:\n {2}not ok 4 - quoted paths keep their backslashes\n {4}AssertionError: expected C:\\repo\\lib/);
  assert.doesNotMatch(failed.summary, /ok 1 - runs fine|2026-10-09T10/);
});

test('a failing check refuses with its job and the first failing lines of the log, even while other checks are running', (t) => {
  const h = fixture(t);
  const data = {
    runs: [checkRun('test (windows-latest)', { conclusion: 'failure', url: JOB_LOG }), checkRun('test (ubuntu-latest)', { status: 'in_progress', conclusion: null })],
    suites: [suite(1, { conclusion: 'failure' })],
    logs: { 456: WINDOWS_LOG },
  };
  const r = submitPr(h, data);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /CI failed at \w+ in acme\/app: fix the failing checks, push, and submit again\./);
  assert.match(r.stderr, /failing: test \(windows-latest\) \(failure\)/);
  assert.match(r.stderr, /tower-crane ci checks T1/);
  assert.match(r.stderr, /test \(windows-latest\) log:\n {2}not ok 4 - quoted paths keep their backslashes\n {4}AssertionError: expected C:\\repo\\lib/);
  assert.doesNotMatch(r.stderr, /ok 1 - runs fine|2026-10-09T10/);
  assert.doesNotMatch(r.stderr, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
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
      comment(11, { line: 12, body: '**[P3]** Quoted paths break on Windows.' }),
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
  assert.match(r.stdout, /revuto left 3 open inline findings on PR #7 \(listed for you; a \[P1\]\/\[P2\] one blocks the submit until its path changes after the comment or it has a \[resolved\] reply\):\n {2}lib\/x\.js:12 \(comment 11\)\n {4}\*\*\[P3\]\*\* Quoted paths break on Windows\.\n {2}lib\/x\.js:40 \(comment 14\)\n {4}Question finding\n {2}lib\/x\.js:50 \(comment 16\)\n {4}Reopened finding/);
  assert.doesNotMatch(r.stdout, /Answered finding|a human comment/);
  assert.equal(status(h), 'submitted');
});

test('--json carries the CI report as ci_report, findings included', (t) => {
  const h = fixture(t);
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)')],
    suites: [suite(1)],
    comments: [comment(11, { line: 12, body: '**[P3]** Quoted paths break on Windows.' })],
  }, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.status, 'submitted');
  assert.match(data.ci_report, /revuto left 1 open inline finding on PR #7/);
  assert.match(data.ci_report, /lib\/x\.js:12 \(comment 11\)\n {4}\*\*\[P3\]\*\* Quoted paths break on Windows\./);
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

test('a [P1]/[P2] revuto finding with no change at its path and no [resolved] reply refuses the submit, as review ok would', (t) => {
  const h = fixture(t);
  // The findings were left on the fixture head; the submitted head changes lib/x.js after them.
  fs.mkdirSync(path.join(h.repo, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'lib', 'x.js'), 'module.exports = 1;\n');
  h.git(['add', 'lib/x.js']);
  h.git(['commit', '-q', '-m', 'fix x']);
  const head = h.git(['rev-parse', 'HEAD']);
  const findings = [
    comment(11, { path: 'lib/x.js', body: '**[P1]** Quoted paths break.', original_commit_id: h.sha }),
    comment(12, { path: 'lib/y.js', line: 7, body: '**[P2]** Missing check.', original_commit_id: h.sha }),
    comment(13, { path: 'lib/y.js', line: 9, body: 'A nit.', original_commit_id: h.sha }),
    // Review ok matches revuto's login exactly; a login that only contains the name is not revuto.
    comment(15, { path: 'lib/y.js', line: 3, body: '**[P1]** Not revuto.', user: 'my-revuto-fan', original_commit_id: h.sha }),
  ];
  // Checks are still running: the refusal does not wait for them or for more findings.
  const data = { sha: head, ...PENDING, comments: findings };
  const submit = (d) => withGithub(h, d, ['submit', 'T1', '--agent', 'worker', '--sha', head, '--pr', '7']);
  const r = submit(data);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /revuto's finding \[P2\] lib\/y\.js:7 \(comment 12\) on PR #7 has no code change at its path since the comment and no \[resolved\] reply/);
  assert.match(r.stderr, /tower-crane ci resolve <comment id>/);
  assert.doesNotMatch(r.stderr.split('\n')[0], /\(comment 11\)|\(comment 13\)|\(comment 15\)/);
  assert.doesNotMatch(r.stderr, /\(comment 15\)|Not revuto/);
  assert.equal(status(h), 'in_progress');

  const resolved = submit({ ...data, comments: [...findings, comment(14, { in_reply_to_id: 12, user: 'worker-T1', body: '[resolved]\nnot reachable here' })] });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(status(h), 'submitted');
});

test('a [P1] finding left on a commit git cannot read refuses with the fetch or ci resolve hint', (t) => {
  const h = fixture(t);
  const r = submitPr(h, { ...PENDING, comments: [comment(21, { body: '**[P1]** Broken.', original_commit_id: 'f'.repeat(40) })] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /revuto's finding \[P1\] lib\/x\.js:12 \(comment 21\)/);
  assert.match(r.stderr, /git could not read the commit that finding was left on \(comment 21 at ffffffffff\), so its path counts as unchanged\. Fetch the PR's earlier heads with git fetch origin, or close the finding with tower-crane ci resolve\./);
  assert.equal(status(h), 'in_progress');
});

test('revuto submit refusal lists both open bodies with ids, paths and per-finding caps', (t) => {
  const h = fixture(t);
  const longBody = '[P2] Long finding: ' + 'x'.repeat(4000) + ' omitted tail';
  const r = submitPr(h, { ...PENDING, comments: [
    comment(31, { path: 'lib/a.js', line: 7, body: '<!-- hidden submit\nmetadata -->\n[P1] Guard the input\nReject the unsafe value.\nUse the `<!--` opener check here.\nSecond paragraph with the actual fix.\n```suggestion\n<!-- commands:Gates:start -->\n| a | b |\n```', original_commit_id: h.sha }),
    comment(32, { path: 'lib/b.js', line: 40, body: longBody, original_commit_id: h.sha }),
    comment(33, { path: 'lib/outdated.js', line: null, body: '[P1] Outdated finding.', original_commit_id: h.sha }),
    comment(34, { path: 'lib/closed.js', body: '[P1] Resolved finding.', original_commit_id: h.sha }),
    comment(35, { in_reply_to_id: 34, user: 'worker-T1', body: '[resolved]\nFixed.' }),
  ] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /revuto left 2 open inline findings/);
  assert.match(r.stderr, /lib\/a\.js:7 \(comment 31\)\n {4}\[P1\] Guard the input\n {4}Reject the unsafe value\./);
  assert.match(r.stderr, /Use the `<!--` opener check here\.\n {4}Second paragraph with the actual fix\./);
  assert.match(r.stderr, /```suggestion\n {4}<!-- commands:Gates:start -->\n {4}\| a \| b \|\n {4}```/);
  assert.match(r.stderr, /\[31 characters of HTML comment removed\]/);
  assert.ok(r.stderr.includes(`lib/b.js:40 (comment 32)\n    ${longBody.slice(0, 4000)}\n    [body truncated after 4000 characters]`));
  assert.doesNotMatch(r.stderr, /hidden submit|metadata|omitted tail|lib\/(?:outdated|closed)\.js|comment (?:33|34)/);
  assert.equal(status(h), 'in_progress');
});

test('the ci gate redacts secrets in the log excerpt and prints no log for a skipped required check', (t) => {
  const h = fixture(t);
  assert.equal(submitPr(h, PENDING).status, 0);
  const secret = 'abcd1234efgh5678ijkl9012';
  const token = `ghp_${'A1'.repeat(18)}`;
  const r = checkCi(h, {
    runs: [checkRun('test (windows-latest)', { conclusion: 'failure', url: JOB_LOG }),
      checkRun('test (ubuntu-latest)', { conclusion: 'skipped', url: 'https://github.com/acme/app/actions/runs/9/job/457' })],
    suites: [suite(1, { conclusion: 'failure' })],
    logs: { 456: `test (windows-latest)\tRun tests\t2026-10-09T10:00:01.0Z not ok 4 - login with ${token} and ${secret}` },
  }, { DEPLOY_API_KEY: secret });
  assert.equal(r.status, 1, r.stderr);
  const failed = ciEvidence(h).at(-1);
  assert.match(failed.summary, /test \(windows-latest\) log:\n {2}not ok 4 - login with \[redacted:GITHUB_TOKEN\] and \[redacted:DEPLOY_API_KEY\]/);
  assert.doesNotMatch(JSON.stringify(h.readState('tasks.json')), new RegExp(`${secret}|${token}`));
  assert.doesNotMatch(failed.summary, /test \(ubuntu-latest\) log|log unavailable/);
});

test('a failing revuto check refuses the submit while CI is still running', (t) => {
  const h = fixture(t);
  const revuto = checkRun('Revuto', {
    app: 'revuto-review', conclusion: 'failure', suite: 2,
    output: { title: 'Revuto requested changes', summary: '2 findings' },
  });
  const r = submitPr(h, {
    runs: [checkRun('test (ubuntu-latest)', { status: 'in_progress', conclusion: null }), revuto],
    suites: [suite(1, { status: 'in_progress', conclusion: null }), suite(2, { app: 'revuto-review', conclusion: 'failure', runs: 1 })],
    comments: [comment(11, { line: 12, body: '**[P1]** Quoted paths break on Windows.' })],
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /CI failed at \w+ in acme\/app: fix the failing checks, push, and submit again\./);
  assert.match(r.stderr, /failing: Revuto \(failure\)/);
  assert.match(r.stderr, /not completed: test \(ubuntu-latest\) \(in_progress\)/);
  assert.match(r.stderr, /revuto left 1 open inline finding on PR #7/);
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
