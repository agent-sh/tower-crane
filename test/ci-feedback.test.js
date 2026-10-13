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
  ? original(process.execPath, [${JSON.stringify(stub)}, ...args], opts)
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

test('a sandboxed worker reads its own PR through the broker and no other task', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  assert.deepEqual(B.authorize(job, ['ci', 'log', '42', '--failed-tests']).slice(0, 2), ['ci', 'log']);
  assert.deepEqual(B.authorize(job, ['ci', 'alerts']).slice(0, 2), ['ci', 'alerts']);
  assert.throws(() => B.authorize(job, ['ci', 'log', '42', '--task', 'T2']), /works on T1 only, not T2/);
  assert.throws(() => B.authorize(job, ['ci', 'webhook', '-']), /sandboxed worker/);
});
