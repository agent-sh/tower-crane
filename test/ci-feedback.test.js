'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const B = require('../lib/broker');
const { failingTests } = require('../lib/ci-feedback');

// GitHub stamps every line of a job log.
const PLAIN = [
  '##[group]Run npm test',
  'TAP version 13',
  'ok 1 - reads the config',
  'not ok 2 - writes the report',
  '  ---',
  "  error: 'ENOENT: no such file or directory'",
  '  ...',
  'not ok 3 - rejects a stale head',
  "  error: 'expected 409 to equal 422'",
  '  ...',
  '1..3',
].map((line, i) => `2026-10-11T10:00:${String(i).padStart(2, '0')}.0000000Z ${line}`).join('\n') + '\n';
// The same log as a runner colors it: a CSI color, and an OSC hyperlink around the group title.
const LOG = PLAIN
  .replace('2026-10-11T10:00:00.0000000Z', '\x1b[36m2026-10-11T10:00:00.0000000Z\x1b[0m')
  .replace('Run npm test', '\x1b]8;;https://example.test/run\x07Run npm test\x1b]8;;\x07')
  .replace('not ok 2 - writes the report', '\x1b[31mnot ok 2 - writes the report\x1b[0m');

const BRANCH = 'tower-crane/T1-change';

function fixture(t) {
  const h = cachedFixture(t, 'ci-feedback', (h) => {
    h.init(['--repo', 'acme/app']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    const sha = h.git(['rev-parse', 'HEAD']);
    // Seed the PR fields so fixture setup does not invoke submit's separate CI checks.
    const state = h.readState('tasks.json');
    Object.assign(state.tasks.find((task) => task.id === 'T1'), { sha, pr: 9, branch: BRANCH });
    h.writeState('tasks.json', state);
    return { sha };
  });
  // Spawn records the task scratch; the test sets it the same way.
  h.scratch = path.join(h.base, 'scratch');
  fs.mkdirSync(h.scratch);
  const state = h.readState('tasks.json');
  state.tasks.find((t) => t.id === 'T1').scratch = h.scratch;
  h.writeState('tasks.json', state);
  // Job 42 runs on T1's branch head, the PR head; job 43 is another branch's run on its own head.
  h.env.CI_FEEDBACK_GH = path.join(h.base, 'github.json');
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify({
    jobs: {
      42: { id: 42, name: 'test', head_branch: BRANCH, head_sha: h.sha },
      43: { id: 43, name: 'test', head_branch: 'tower-crane/T2-other', head_sha: 'b'.repeat(40) },
    },
    refs: {
      [`heads/${BRANCH}`]: { ref: `refs/heads/${BRANCH}`, object: { sha: h.sha } },
    },
    logs: { 42: LOG },
    alerts: {
      'refs/pull/9/head': [{ number: 7, rule: { id: 'js/xss', security_severity_level: 'high' },
        most_recent_instance: { location: { path: 'src/a.js', start_line: 12 }, message: { text: 'untrusted input' } } }],
    },
  }));
  // A preload sends only gh to the stub, on every platform: Windows cannot run a shebang script.
  const stub = path.join(__dirname, 'fixtures', 'ci-feedback-gh.js');
  const preload = path.join(h.base, 'gh-preload.js');
  fs.writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (command, args, opts) => command === 'gh'
  ? (() => {
    if (process.env.CI_FEEDBACK_CALLS) require('node:fs').appendFileSync(process.env.CI_FEEDBACK_CALLS, JSON.stringify({ args, cwd: opts.cwd, git_dir: opts.env.GIT_DIR || null }) + '\\n');
    return original(process.execPath, [${JSON.stringify(stub)}, ...args], opts);
  })()
  : original(command, args, opts);
`);
  h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
  return h;
}

test('failing test names come from node, go and pytest output', () => {
  const cases = [
    ['node spec', ['✖ parses the flag (2.1ms)', '  AssertionError [ERR_ASSERTION]: expected true', '✖ failing tests:', '✖ parses the flag (2.1ms)'],
      [{ name: 'parses the flag', error: 'AssertionError [ERR_ASSERTION]: expected true' }]],
    ['go test', ['--- FAIL: TestParse (0.00s)', '    parse_test.go:12: expected 2, got 3', '--- FAIL: TestLoad (0.00s)'],
      [{ name: 'TestParse', error: 'parse_test.go:12: expected 2, got 3' }, { name: 'TestLoad', error: null }]],
    ['go subtest', ['--- FAIL: TestParent (0.00s)', '    --- FAIL: TestParent/child (0.00s)', '        parse_test.go:12: want 2, got 3', 'FAIL'],
      [{ name: 'TestParent', error: null }, { name: 'TestParent/child', error: 'parse_test.go:12: want 2, got 3' }]],
    ['go diagnostic', ['--- FAIL: TestParse (0.00s)', '    parse_test.go:12: want 2, got 3', '    parse_test.go:13: another diagnostic', 'FAIL'],
      [{ name: 'TestParse', error: 'parse_test.go:12: want 2, got 3' }]],
    ['pytest', ['FAILED tests/test_ci.py::test_names - AssertionError: expected 2'],
      [{ name: 'tests/test_ci.py::test_names', error: 'AssertionError: expected 2' }]],
    ['no failures', ['ok 1 - passes', '1..1'], []],
  ];
  for (const [what, lines, expected] of cases) assert.deepEqual(failingTests(lines.join('\n')), expected, what);
});

test('ci log writes the clean log under the task scratch and names both failing tests', (t) => {
  const h = fixture(t);
  const r = h.run(['ci', 'log', '42', '--failed-tests', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  const [file, ...lines] = r.stdout.trimEnd().split('\n');
  const log = path.join(h.scratch, 'ci-job-42.log');
  assert.equal(file, log);
  assert.equal(fs.readFileSync(log, 'utf8'), PLAIN, 'the written log has no escape sequences');
  assert.deepEqual(lines, [
    'failing tests (2):',
    '  writes the report',
    "    error: 'ENOENT: no such file or directory'",
    '  rejects a stale head',
    "    error: 'expected 409 to equal 422'",
  ]);
});

test('ci log names indented Go subtests and their first diagnostics without error keywords', (t) => {
  const h = fixture(t);
  const lines = [
    '--- FAIL: TestParent (0.00s)',
    '    --- FAIL: TestParent/child (0.00s)',
    '        parse_test.go:12: want 2, got 3',
    '        parse_test.go:13: another diagnostic',
    '--- FAIL: TestParse (0.00s)',
    '    parse_test.go:20: want true, got false',
    'FAIL',
  ];
  const github = JSON.parse(fs.readFileSync(h.env.CI_FEEDBACK_GH, 'utf8'));
  github.logs[42] = lines.map((line) => `2026-10-11T10:00:00.0000000Z ${line}`).join('\n') + '\n';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(github));
  const r = h.run(['ci', 'log', '42', '--failed-tests', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    path.join(h.scratch, 'ci-job-42.log'),
    'failing tests (3):',
    '  TestParent',
    '  TestParent/child',
    '    parse_test.go:12: want 2, got 3',
    '  TestParse',
    '    parse_test.go:20: want true, got false',
  ]);
});

test('ci log refuses a job from another PR and writes nothing', (t) => {
  const h = fixture(t);
  const r = h.run(['ci', 'log', '43', '--task', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /job 43 is not in a check run on T1's PR head: it runs on tower-crane\/T2-other/);
  assert.equal(fs.existsSync(path.join(h.scratch, 'ci-job-43.log')), false);
});

test('ci log replaces a link the worker planted at its log name and writes nothing through it', { skip: process.platform === 'win32' && 'creating a link needs a privilege on Windows' }, (t) => {
  const h = fixture(t);
  const outside = path.join(h.base, 'outside');
  fs.mkdirSync(outside);
  const target = path.join(outside, 'target.txt');
  fs.writeFileSync(target, 'keep\n');
  fs.symlinkSync(target, path.join(h.scratch, 'ci-job-42.log'));
  const r = h.run(['ci', 'log', '42', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n', 'the link target is untouched');
  assert.equal(fs.lstatSync(path.join(h.scratch, 'ci-job-42.log')).isFile(), true);
});

test('ci log reads the branch head before the task is submitted, and alerts wait for its PR', (t) => {
  const h = fixture(t);
  // Before submit the task has its branch but no PR or submitted head yet.
  const state = h.readState('tasks.json');
  const task = state.tasks.find((x) => x.id === 'T1');
  delete task.pr;
  delete task.sha;
  h.writeState('tasks.json', state);
  const r = h.run(['ci', 'log', '42', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(r.stdout.trim(), 'utf8').includes('\x1b'), false);
  const alerts = h.run(['ci', 'alerts', '--task', 'T1']);
  assert.equal(alerts.code, 1);
  assert.match(alerts.stderr, /T1 has no PR yet/);
});

test('ci alerts lists the open alerts on the task PR head', (t) => {
  const h = fixture(t);
  const r = h.run(['ci', 'alerts', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '#7 js/xss high src/a.js:12 untrusted input');
});

function checkFeedback(h) {
  const project = h.readState('project.json');
  project.ci = { ignore_apps: ['cursor'], capped_review: [{ app: 'revuto-review', pattern: 'reached the \\d+-round review limit' }] };
  h.writeState('project.json', project);
  const data = JSON.parse(fs.readFileSync(h.env.CI_FEEDBACK_GH, 'utf8'));
  Object.assign(data, {
    pr: { number: 9, headRefName: BRANCH, headRefOid: h.sha },
    pull: { head: { sha: h.sha }, base: { sha: 'b'.repeat(40) }, merge_commit_sha: 'c'.repeat(40) },
    commits: { ['c'.repeat(40)]: { sha: 'c'.repeat(40), parents: [{ sha: h.sha }, { sha: 'b'.repeat(40) }] } },
    checks: { [h.sha]: [
      { id: 1, name: 'Revuto', app: 'revuto-review', status: 'completed', conclusion: 'failure',
        output: { title: 'Review capped', summary: 'reached the 2-round review limit', annotations_count: 1 } },
      { id: 2, name: 'CodeQL', app: 'github-actions', status: 'completed', conclusion: 'failure',
        output: { title: 'Security alert', summary: 'Found a file system race', annotations_count: 1 } },
      { id: 3, name: 'Cursor', app: 'cursor', status: 'completed', conclusion: 'failure',
        output: { title: 'Unavailable', summary: 'quota exhausted', annotations_count: 0 } },
      { id: 4, name: 'test', app: 'github-actions', status: 'completed', conclusion: 'success', output: {} },
      { id: 5, name: 'build', app: 'github-actions', status: 'queued', conclusion: null, output: {} },
    ] },
    annotations: {
      1: [{ path: 'lib/review.js', start_line: 8, title: 'Limit', message: 'The configured review cap was reached.' }],
      2: [{ path: 'lib/ci-feedback.js', start_line: 86, title: 'Race', message: 'File may change between checks.' }],
    },
  });
  data.alerts = {
    'refs/pull/9/head': [],
    'refs/pull/9/merge': [
      { number: 8, rule: { id: 'js/file-system-race', severity: 'warning' },
        most_recent_instance: { ref: 'refs/pull/9/merge', commit_sha: 'c'.repeat(40),
          location: { path: 'lib/ci-feedback.js', start_line: 86 }, message: { text: 'File may change between checks.' } } },
      { number: 9, rule: { id: 'stale-rule' }, most_recent_instance: { commit_sha: 'd'.repeat(40) } },
    ],
  };
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  return data;
}

test('ci checks shows capped and ignored reasons, check output, annotations and current CodeQL locations before submit', (t) => {
  const h = fixture(t);
  checkFeedback(h);
  const state = h.readState('tasks.json');
  Object.assign(state.tasks[0], { pr: null, sha: null });
  h.writeState('tasks.json', state);
  const r = h.run(['ci', 'checks', 'T1', '--agent', 'worker']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Revuto.*nonblocking.*ci\.capped_review/);
  assert.match(r.stdout, /Review capped/);
  assert.match(r.stdout, /reached the 2-round review limit/);
  assert.match(r.stdout, /lib\/review\.js:8.*Limit.*configured review cap/);
  assert.match(r.stdout, /Cursor.*nonblocking.*ci\.ignore_apps/);
  assert.match(r.stdout, /CodeQL.*failure/);
  assert.match(r.stdout, /lib\/ci-feedback\.js:86.*Race.*File may change/);
  assert.match(r.stdout, /build.*queued/);
  assert.match(r.stdout, /js\/file-system-race.*lib\/ci-feedback\.js:86.*File may change/);
  assert.doesNotMatch(r.stdout, /stale-rule|test \(github-actions\)/);
  const json = h.run(['ci', 'checks', 'T1', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.equal(rows.sha, h.sha);
  assert.equal(rows.pr, 9);
  assert.equal(rows.checks.length, 4);
  assert.equal(rows.checks[0].nonblocking, true);
  assert.match(rows.checks[0].reason, /ci\.capped_review/);
  assert.equal(rows.checks[1].nonblocking, false);
  assert.equal(rows.alerts[0].rule, 'js/file-system-race');
  assert.equal(rows.alerts[0].path, 'lib/ci-feedback.js');
  assert.equal(rows.alerts[0].line, 86);
});

test('ci checks refuses another branch and does not present a stale merge analysis as current', (t) => {
  const h = fixture(t);
  const data = checkFeedback(h);
  data.pr.headRefName = 'tower-crane/T2-other';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const other = h.run(['ci', 'checks', 'T1']);
  assert.equal(other.code, 1, other.stderr);
  assert.match(other.stderr, /PR #9.*branch/);
  data.pr.headRefName = BRANCH;
  data.commits['c'.repeat(40)].parents = [{ sha: 'd'.repeat(40) }, { sha: 'b'.repeat(40) }];
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const stale = h.run(['ci', 'checks', 'T1']);
  assert.equal(stale.code, 0, stale.stderr);
  assert.match(stale.stdout, /alerts unavailable.*merge commit.*current head and base/);
  assert.match(stale.stdout, /reached the 2-round review limit/);
  assert.doesNotMatch(stale.stdout, /js\/file-system-race/);
});

test('ci checks keeps superseded review rounds, reruns and replaced workflow failures visible as nonblocking', (t) => {
  const h = fixture(t);
  const data = checkFeedback(h);
  const runs = data.checks[h.sha];
  runs[0].started_at = '2026-10-13T02:00:00Z';
  runs.push(
    { id: 0, name: 'Revuto', app: 'revuto-review', status: 'completed', conclusion: 'failure',
      started_at: '2026-10-13T01:00:00Z', output: { title: 'Old finding', summary: 'previous review round', annotations_count: 0 } },
    { id: 6, name: 'rerun', app: 'github-actions', status: 'completed', conclusion: 'failure',
      output: { title: 'Old failure', annotations_count: 0 } },
    { id: 7, name: 'rerun', app: 'github-actions', status: 'completed', conclusion: 'success', output: {} },
    { id: 8, name: 'obsolete job', app: 'github-actions', suite: 101, status: 'completed', conclusion: 'failure',
      output: { title: 'Replaced workflow failure', annotations_count: 0 } },
  );
  data.suites = [101, 102].map((id) => ({ id, app: 'github-actions', status: 'completed', conclusion: 'success', runs: 1 }));
  data.workflows = [101, 102].map((id) => ({ id, check_suite_id: id, head_sha: h.sha, name: 'CI', path: '.github/workflows/ci.yml',
    event: 'pull_request', created_at: `2026-10-13T0${id === 101 ? 1 : 2}:00:00Z`, status: 'completed', conclusion: 'success' }));
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'checks', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout).checks;
  for (const id of [0, 6, 8]) {
    const row = rows.find((c) => c.id === id);
    assert.ok(row, `old run ${id} stays visible`);
    assert.equal(row.nonblocking, true, `old run ${id} does not block`);
    assert.match(row.reason, /superseded/);
  }
  assert.equal(rows.find((c) => c.id === 2).nonblocking, false, 'the current CodeQL failure still blocks');
});

test('ci checks runs through the worker broker without loading the worktree git config', async (t) => {
  const h = fixture(t);
  checkFeedback(h);
  const callsFile = path.join(h.base, 'gh-calls.jsonl');
  const values = { NODE_OPTIONS: h.env.NODE_OPTIONS, CI_FEEDBACK_GH: h.env.CI_FEEDBACK_GH, CI_FEEDBACK_CALLS: callsFile };
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const job = { state: h.state, task: 'T1', agent: 'worker', role: 'worker', cwd: h.repo,
    broker_harnesses: ['codex'], broker: path.join(h.base, 'broker', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const r = await B.forward(job.broker, ['ci', 'checks', 'T1', '--json'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).alerts[0].rule, 'js/file-system-race');
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.cwd, h.state);
    assert.equal(call.git_dir, path.join(h.state, 'no-repository'));
    if (call.args[1]?.includes('per_page')) assert.ok(call.args.includes('--paginate'), call.args.join(' '));
  }
});

test('a sandboxed worker reads its own PR through the broker and no other task', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  assert.deepEqual(B.authorize(job, ['ci', 'log', '42', '--failed-tests']).slice(0, 2), ['ci', 'log']);
  assert.deepEqual(B.authorize(job, ['ci', 'alerts']).slice(0, 2), ['ci', 'alerts']);
  assert.deepEqual(B.authorize(job, ['ci', 'checks', 'T1']).slice(0, 2), ['ci', 'checks']);
  assert.throws(() => B.authorize(job, ['ci', 'checks', 'T2']), /works on T1 only, not T2/);
  assert.throws(() => B.authorize(job, ['ci', 'log', '42', '--task', 'T2']), /works on T1 only, not T2/);
  assert.throws(() => B.authorize(job, ['ci', 'webhook', '-']), /sandboxed worker/);
});
