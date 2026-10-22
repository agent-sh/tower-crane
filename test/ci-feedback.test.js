'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture } = require('./helpers');
const { writeAtomic, readPublished } = require('./atomic-file');
const { waitOnRepo } = require('./signals');
const B = require('../lib/broker');
const { failingTests } = require('../lib/ci-feedback');
const { stripEscapes } = require('../lib/ci-log-text');
const { ghDenied } = require('../lib/shim');
const { findingBody, revutoLines } = require('../lib/gates/ci');
const { readEvents } = require('../lib/state');

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
// Runner colors, OSC hyperlinks with both terminators, and stray terminal controls.
const LOG = PLAIN
  .replace('2026-10-11T10:00:00.0000000Z', '\x1b[36m2026-10-11T10:00:00.0000000Z\x1b[0m')
  .replace('Run npm test', '\x1b]8;;https://example.test/run\x07Run npm test\x1b]8;;\x1b\\')
  .replace('not ok 2 - writes the report', '\x1b[31mnot ok 2 - writes the report\x1b[0m\x1b')
  .replace("  error: 'ENOENT: no such file or directory'", "  \x00\x07\x08\x0b\x0c\x0e\x1f\x7ferror: 'ENOENT: no such file or directory'\r");

const BRANCH = 'tower-crane/T1-change';
const POLICY_DENIED = "gh api is not allowed by this agent's agent file";

test('CI log cleanup preserves text, tabs and newlines while removing terminal controls', () => {
  const cases = [
    ['CSI', '\x1b[31mred\x1b[0m \x1b[2Kline', 'red line'],
    ['OSC BEL', '\x1b]0;title\x07text', 'text'],
    ['OSC ST', '\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['C1 CSI', '\x9b31mred\x9b0m', 'red'],
    ['bare ESC', 'text\x1b\n', 'text\n'],
    ['C0, DEL and C1', 'a\x00\x07\x08\x0b\x0c\x0e\x1f\x7f\x80b\r\n', 'ab\n'],
    ['layout and Unicode', '\t✖ тест\n', '\t✖ тест\n'],
  ];
  for (const [name, input, expected] of cases) assert.equal(stripEscapes(input), expected, name);
});

test('inline finding text strips metadata and caps each body with an explicit note', () => {
  const cases = [
    ['plain Markdown', '**[P2]** Guard `input`.', ['**[P2]** Guard `input`.']],
    ['multiline comments', '<!-- hidden\nmetadata -->\nFirst<!-- more --> line.\r\nSecond line.',
      ['First<!-- more --> line.', 'Second line.', '[24 characters of HTML comment removed]']],
    ['comment before cap', `<!-- ${'x'.repeat(5000)} -->Visible`, ['Visible', '[5009 characters of HTML comment removed]']],
    ['unfinished inline comment', 'Visible<!-- hidden', ['Visible<!-- hidden']],
    ['terminal controls', '\x1b[31mVisible\x1b[0m\x07', ['Visible']],
    ['empty body', '', ['']],
    ['at cap', 'x'.repeat(4000), ['x'.repeat(4000)]],
    ['past cap', 'x'.repeat(4001), ['x'.repeat(4000), '[body truncated after 4000 characters]']],
    ['Unicode at cap', '😀'.repeat(4000), ['😀'.repeat(4000)]],
    ['Unicode past cap', '😀'.repeat(4001), ['😀'.repeat(4000), '[body truncated after 4000 characters]']],
  ];
  for (const [name, body, expected] of cases) {
    assert.deepEqual(revutoLines([{ id: 501, path: 'lib/a.js', line: 12, ...findingBody(body) }]),
      ['  lib/a.js:12 (comment 501)', ...expected.map((line) => `    ${line}`)], name);
  }
});

test('finding body preserves Markdown code and strips only line-start HTML comment blocks', () => {
  const cases = [
    ['reported inline opener', 'Use the `<!--` opener check here.\nSecond paragraph with the actual fix.'],
    ['reported suggestion', '```suggestion\n<!-- commands:Gates:start -->\n| a | b |\n```'],
    ['closed inline span', 'Use `<!-- marker -->` here.'],
    ['long inline delimiter', 'Use `` `<!--` `` here.\nKeep this fix.'],
    ['multiline span', 'Use `the marker\n<!-- visible -->\ninside code` here.'],
    ['unmatched span', '`unmatched\n<!-- hidden -->\nVisible', '`unmatched\n\nVisible', 15],
    ['escaped backtick', '\\`not a span\n<!-- hidden -->\nVisible', '\\`not a span\n\nVisible', 15],
    ['unclosed inline prose', 'Use the <!-- opener here.\nKeep this fix.'],
    ['closed inline prose', 'Use <!-- marker --> in this example.'],
    ['escaped opener', '\\<!-- visible -->\nKeep this fix.'],
    ['indented code', '    <!-- visible -->\nKeep this fix.'],
    ['tab-indented code', '\t<!-- visible -->\nKeep this fix.'],
    ['tilde fence', '~~~suggestion\n<!-- visible -->\n~~~'],
    ['indented fence', '   ```suggestion\n<!-- visible -->\n   ```'],
    ['list fence', '- ```suggestion\n  <!-- visible -->\n  ```'],
    ['blockquote fence', '> ```suggestion\n> <!-- visible -->\n> ```'],
    ['long fence', '````suggestion\n```\n<!-- visible -->\n````'],
    ['wrong closing fence', '~~~\n```\n<!-- visible -->\n~~~'],
    ['list-like fence content', '```\n- ```\n<!-- visible -->\n```'],
    ['quote-like fence content', '```\n> ```\n<!-- visible -->\n```'],
    ['unclosed fence', '```suggestion\n<!-- visible -->\nKeep this fix.'],
    ['closed fence then comment', '```\n<!-- visible -->\n```\n<!-- hidden -->\nVisible',
      '```\n<!-- visible -->\n```\n\nVisible', 15],
    ['indented block', '   <!-- hidden -->\nVisible', 'Visible', 15],
    ['unclosed block', '<!-- hidden\nmetadata', '', 20],
    ['Unicode removal count', '<!-- 😀 -->\nVisible', 'Visible', 10],
    ['multiple blocks', '<!-- a -->\n<!-- b -->\nVisible', 'Visible', 20],
    ['reported multiple blocks around prose', '<!-- a -->\nX\n<!-- bb -->\nY', 'X\n\nY', 21],
    ['escaped backtick in span', '`code \\`\n<!-- hidden -->\nVisible', '`code \\`\n\nVisible', 15],
    ['no second stripping', '<!<!-- a -->-- b -->Visible'],
  ];
  for (const [name, input, expected = input, removed = 0] of cases) {
    const result = findingBody(input);
    assert.equal(result.body, expected, name);
    assert.equal(result.html_comment_chars_removed || 0, removed, name);
    assert.deepEqual(revutoLines([{ id: 1, path: 'a.md', line: 3, ...result }]),
      ['  a.md:3 (comment 1)', ...expected.split('\n').map((line) => `    ${line}`),
        ...(removed ? [`    [${removed} characters of HTML comment removed]`] : [])], name);
  }
});

test('gh log flag preserves the existing shim policy', () => {
  const args = ['api', 'repos/acme/app/actions/jobs/42/logs', '--allow-escape-sequences'];
  assert.equal(ghDenied(args, { gh: ['api'] }), null);
  assert.match(ghDenied(args, { gh: ['pr view', 'run view'] }), /^gh api /);
});

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

test('ci log fetches escape sequences, writes a clean log and prints clean failing tests', (t) => {
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

test('ci alerts lists clean open alerts on the task PR head', (t) => {
  const h = fixture(t);
  const data = JSON.parse(fs.readFileSync(h.env.CI_FEEDBACK_GH, 'utf8'));
  data.alerts['refs/pull/9/head'][0].most_recent_instance.message.text = '\x1b[31muntrusted input\x1b[0m\x07';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'alerts', '--task', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '#7 js/xss high src/a.js:12 untrusted input');
  const json = h.run(['ci', 'alerts', '--task', 'T1', '--json']);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).alerts[0].message, 'untrusted input');
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

function reviewComments() {
  const finding = (id, path, line, body = '[P2] Guard the input') => ({
    id, path, line, body, user: 'revuto-review[bot]', in_reply_to_id: null,
  });
  const reply = (id, parent, body) => ({ id, in_reply_to_id: parent, user: 'worker', body });
  return [
    finding(501, 'lib/a.js', 12),
    finding(502, 'lib/b.js', 40, 'Question remains open'),
    reply(503, 502, 'Which input fails?'),
    finding(504, 'lib/c.js', 50, 'Reopened finding'),
    reply(505, 504, '[resolved]\nFixed'),
    reply(506, 504, 'Still broken'),
    finding(507, 'lib/closed.js', 60),
    reply(508, 507, '[resolved]\nFixed'),
    finding(509, 'lib/outdated.js', null),
    { ...finding(510, 'lib/human.js', 70), user: 'a-person' },
  ];
}

function sendToRework(h) {
  const brief = path.join(h.base, 'brief.md');
  fs.writeFileSync(brief, 'Fix the review findings.');
  h.ok(['brief', 'set', 'T1', '--file', brief]);
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, '-e', 'console.log(process.argv[1])', '{prompt}'])]);
  const state = h.readState('tasks.json');
  Object.assign(state.tasks[0], { status: 'submitted', claim: null });
  h.writeState('tasks.json', state);
  h.ok(['rework', 'T1', '--reason', 'Address the inline findings']);
}

test('ci resolve help names where workers find inline comment ids', (t) => {
  const h = fixture(t);
  const help = h.ok(['ci', 'resolve', '--help']);
  assert.match(help, /find COMMENT_ID beside path:line in ci checks, rework prompts or submit reports/);
});

test('rework prompts and worker ci reads expose inline ids that ci resolve accepts', async (t) => {
  const h = fixture(t);
  const data = checkFeedback(h);
  data.comments = reviewComments();
  data.comments[0].body = '<!-- hidden rework metadata -->\n[P2] Guard the input\nKeep the failure visible.\nUse the `<!--` opener check here.\nSecond paragraph with the actual fix.\n```suggestion\n<!-- commands:Gates:start -->\n| a | b |\n```';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  sendToRework(h);
  const expected = [[501, 'lib/a.js', 12], [502, 'lib/b.js', 40], [504, 'lib/c.js', 50]];
  const assertFindings = (text) => {
    for (const [id, file, line] of expected) assert.ok(text.includes(`${file}:${line} (comment ${id})`), text);
    assert.doesNotMatch(text, /lib\/(?:closed|outdated|human)\.js/);
    assert.match(text, /\[P2\] Guard the input\n {4}Keep the failure visible\./);
    assert.doesNotMatch(text, /hidden rework metadata/);
    assert.match(text, /Use the `<!--` opener check here\.\n {4}Second paragraph with the actual fix\./);
    assert.match(text, /```suggestion\n {4}<!-- commands:Gates:start -->\n {4}\| a \| b \|\n {4}```/);
    assert.match(text, /\[31 characters of HTML comment removed\]/);
  };
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
  assertFindings(dry.argv.join('\n'));
  const started = h.json(['spawn', '--task', 'T1', '--wait']);
  assertFindings(fs.readFileSync(started.log, 'utf8'));

  const values = { NODE_OPTIONS: h.env.NODE_OPTIONS, CI_FEEDBACK_GH: h.env.CI_FEEDBACK_GH };
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
  const read = await B.forward(job.broker, ['ci', 'checks', 'T1'], h.state);
  assert.equal(read.code, 0, read.stderr);
  assertFindings(read.stdout);
  const json = await B.forward(job.broker, ['ci', 'checks', 'T1', '--json'], h.state);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).findings.map((f) => [f.id, f.path, f.line]), expected);
  const displayed = [...read.stdout.matchAll(/\(comment (\d+)\)/g)].map((m) => m[1]);
  assert.deepEqual(displayed, expected.map(([id]) => String(id)));
  for (const id of displayed) {
    const resolved = await B.forward(job.broker, ['ci', 'resolve', id, '--reason', 'Fixed the guard at the reported path'], h.state);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.match(resolved.stdout, new RegExp(`comment ${id}.*\\[resolved\\]`));
  }
  const after = await B.forward(job.broker, ['ci', 'checks', 'T1', '--json'], h.state);
  assert.equal(after.code, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout).findings, []);
});

test('first and chained fallback routes keep inline ids in rework prompts', (t) => {
  const fail = [process.execPath, '-e',
    'console.log(JSON.stringify({type:"turn.failed",error:{message:"HTTP 503 service unavailable"}}));process.exit(1)', '{prompt}'];
  const print = [process.execPath, '-e', 'console.log(process.argv[1])', '{prompt}'];
  for (const [count, denied] of [[1, false], [2, false], [1, true], [2, true]]) {
    const h = fixture(t);
    const data = checkFeedback(h);
    data.comments = reviewComments();
    if (denied) data.commentsError = POLICY_DENIED;
    fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    sendToRework(h);
    const routes = Array.from({ length: count }, (_, index) => ({
      harness: 'command', command: index === count - 1 ? print : fail,
    }));
    h.ok(['ladder', 'set', 'medium', '--command', JSON.stringify(fail),
      '--supervision', '{"retries":0,"backoff_ms":1,"max_backoff_ms":1}']);
    h.ok(['ladder', 'set', 'medium', '--fallbacks', JSON.stringify(routes)]);
    const result = h.run(['spawn', '--task', 'T1', '--wait', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const started = JSON.parse(result.stdout);
    const log = fs.readFileSync(started.log, 'utf8');
    if (denied) assert.match(log, /Revuto inline findings unavailable:.*is not allowed by this agent's agent file/);
    else for (const [id, file, line] of [[501, 'lib/a.js', 12], [502, 'lib/b.js', 40], [504, 'lib/c.js', 50]]) {
      assert.ok(log.includes(`${file}:${line} (comment ${id})`), `fallback ${count}: ${log}`);
    }
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.filter((e) => e.cmd === 'spawn fallback').map((e) => e.detail.route_index),
      Array.from({ length: count }, (_, index) => index + 1));
  }
});

test('fixture replies preserve single, concurrent distinct and repeated updates', async (t) => {
  for (const parents of [[501], [501, 502, 504], [501, 501]]) {
    const h = fixture(t);
    const data = checkFeedback(h);
    data.comments = reviewComments();
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const barrier = path.join(h.base, 'release');
    const preload = path.join(h.base, 'reply-barrier.js');
    fs.writeFileSync(preload, `
const fs = require('node:fs');
const { writeAtomic } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const original = fs.readFileSync;
let held = false;
fs.readFileSync = (file, ...args) => {
  const value = original(file, ...args);
  if (!held && file === process.env.CI_FEEDBACK_GH) {
    held = true;
    writeAtomic(process.env.REPLY_READY, 'ready');
    const deadline = Date.now() + 30000; // wait-allow: bounds the fixture read barrier
    while (!fs.existsSync(process.env.REPLY_RELEASE)) {
      if (Date.now() > deadline) throw new Error('reply read barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // wait-allow: fixture waits for its explicit release
    }
  }
  return value;
};
`);
    const children = parents.map((parent, index) => {
      const ready = path.join(h.base, `ready-${index}`);
      const child = cp.spawn(process.execPath, [path.join(__dirname, 'fixtures', 'ci-feedback-gh.js'),
        'api', '--method', 'POST', `repos/acme/app/pulls/9/comments/${parent}/replies`, '-f', `body=[resolved]\nwriter ${index}`],
      { env: { ...h.env, NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require=${JSON.stringify(preload)}`,
        REPLY_READY: ready, REPLY_RELEASE: barrier }, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      const done = new Promise((resolve, reject) => {
        let error = '';
        child.stderr.on('data', (chunk) => { error += chunk; });
        child.stdout.resume();
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error || `reply exited ${code}`)));
      });
      return { ready, done };
    });
    await waitOnRepo(h, () => children.every(({ ready }) => fs.existsSync(ready)), 'reply writers did not reach the read barrier');
    writeAtomic(barrier, 'release');
    await Promise.all(children.map(({ done }) => done));
    const replies = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).comments.slice(data.comments.length);
    assert.deepEqual(replies.map((r) => r.in_reply_to_id).sort(), [...parents].sort());
    assert.equal(new Set(replies.map((r) => r.id)).size, parents.length);
  }
});

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

test('ci checks strips terminal controls from check output and annotations in text and JSON', (t) => {
  const h = fixture(t);
  const data = checkFeedback(h);
  data.checks[h.sha][0].output.title = '\x1b[31mReview capped\x1b[0m\x1b';
  data.checks[h.sha][0].output.summary = '\x1b]0;hidden title\x07reached the 2-round review limit\x00\r';
  data.annotations[1][0].message = '\x1b]8;;https://example.test\x1b\\configured review cap\x1b]8;;\x1b\\\x07';
  data.alerts['refs/pull/9/merge'][0].most_recent_instance.message.text = '\x1b[31mFile may change between checks.\x1b[0m\x1b';
  data.comments = reviewComments();
  data.comments[0].body = '\x1b[31mGuard the input\x1b[0m\x07';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'checks', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /title: Review capped\n/);
  assert.match(r.stdout, /summary: reached the 2-round review limit\n/);
  assert.match(r.stdout, /Limit configured review cap\n/);
  assert.doesNotMatch(r.stdout, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const json = h.run(['ci', 'checks', 'T1', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  const row = result.checks[0];
  assert.equal(row.output.title, 'Review capped');
  assert.equal(row.output.summary, 'reached the 2-round review limit');
  assert.equal(row.annotations[0].message, 'configured review cap');
  assert.equal(result.alerts[0].message, 'File may change between checks.');
  assert.equal(result.findings[0].body, 'Guard the input');
  assert.equal(result.findings[0].id, 501);
});

test('inline read errors stay explicit and only shim policy denials permit rework dispatch', (t) => {
  for (const error of [POLICY_DENIED, 'gh: review comments unavailable (HTTP 503)', 'gh: Bad credentials (HTTP 401)']) {
    for (const claimed of [false, true]) {
      const h = fixture(t);
      const data = checkFeedback(h);
      data.commentsError = error;
      writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
      const r = h.run(['ci', 'checks', 'T1']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('revuto findings unavailable:') && r.stdout.includes(error), r.stdout);
      assert.match(r.stdout, /CodeQL.*failure/);
      assert.doesNotMatch(r.stdout, /no open revuto/);
      const json = h.json(['ci', 'checks', 'T1']);
      assert.equal(json.findings, null);
      assert.ok(json.findings_error.includes(error), json.findings_error);
      sendToRework(h);
      if (claimed) h.ok(['claim', 'T1', '--agent', 'worker']);
      const spawn = h.run(['spawn', '--task', 'T1', '--dry-run', '--json']);
      assert.equal(spawn.code, error === POLICY_DENIED ? 0 : 1, spawn.stderr);
      const notice = spawn.code === 0 ? JSON.parse(spawn.stdout).argv.join('\n') : spawn.stdout + spawn.stderr;
      assert.ok(notice.includes(error), notice);
    }
  }
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
  const data = checkFeedback(h);
  data.comments = reviewComments().filter((c) => [501, 502, 503, 507, 508, 509].includes(c.id));
  data.comments[0].body = '<!-- hidden worker\nmetadata -->\n[P2] Guard the input\nReject the unsafe value.\nUse the `<!--` opener check here.\nSecond paragraph with the actual fix.\n```suggestion\n<!-- commands:Gates:start -->\n| a | b |\n```';
  data.comments[1].body = 'Long finding: ' + 'x'.repeat(4000) + ' omitted tail';
  fs.writeFileSync(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
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
  const text = await B.forward(job.broker, ['ci', 'checks', 'T1'], h.state);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /lib\/a\.js:12 \(comment 501\)\n {4}\[P2\] Guard the input\n {4}Reject the unsafe value\./);
  assert.match(text.stdout, /Use the `<!--` opener check here\.\n {4}Second paragraph with the actual fix\./);
  assert.match(text.stdout, /```suggestion\n {4}<!-- commands:Gates:start -->\n {4}\| a \| b \|\n {4}```/);
  assert.match(text.stdout, /\[31 characters of HTML comment removed\]/);
  assert.ok(text.stdout.includes(`lib/b.js:40 (comment 502)\n    ${data.comments[1].body.slice(0, 4000)}\n    [body truncated after 4000 characters]`));
  assert.doesNotMatch(text.stdout, /hidden worker|metadata|omitted tail|lib\/(?:closed|outdated)\.js|comment (?:507|509)/);
  const r = await B.forward(job.broker, ['ci', 'checks', 'T1', '--json'], h.state);
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.alerts[0].rule, 'js/file-system-race');
  assert.deepEqual(result.findings.map((f) => [f.id, f.path, f.line]),
    [[501, 'lib/a.js', 12], [502, 'lib/b.js', 40]]);
  assert.equal(result.findings[0].body, data.comments[0].body.slice(32));
  assert.equal(result.findings[0].html_comment_chars_removed, 31);
  assert.equal(result.findings[1].body, data.comments[1].body);
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

function dispatchable(h, dispatch = { workflow: 'ci.yml' }) {
  const project = h.readState('project.json');
  project.ci = { ...project.ci, dispatch };
  h.writeState('project.json', project);
  return JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
}

const dispatches = (h) => h.readState('tasks.json').tasks.find((t) => t.id === 'T1').ci_dispatches || [];

test('ci dispatch runs the workflow on its own branch head, records the run and refuses a second while it runs', (t) => {
  const h = fixture(t);
  dispatchable(h);
  const r = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /T1: dispatched ci\.yml run 500 on tower-crane\/T1-change at \w+ https:\/\/github\.com\/acme\/app\/actions\/runs\/500/);
  let data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
  assert.deepEqual(data.dispatched, [{ workflow: 'ci.yml', ref: BRANCH, details: true }]);
  const [entry] = dispatches(h);
  assert.equal(entry.run, 500);
  assert.equal(entry.sha, h.sha);
  assert.equal(entry.branch, BRANCH);
  assert.equal(entry.agent, 'worker');
  const events = readEvents(h.state).filter((e) => e.task === 'T1' && e.cmd.startsWith('ci dispatch'));
  assert.deepEqual(events.map((e) => e.cmd), ['ci dispatch', 'ci dispatch run']);

  const again = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /T1 already has dispatched run 500 at \w+, queued/);
  assert.equal(dispatches(h).length, 1, 'the refused dispatch records nothing');

  // Once the run completes, the same head can run again, up to ci.dispatch.per_hour.
  data.runs[500].status = 'completed';
  data.runs[500].conclusion = 'failure';
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const second = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(dispatches(h).map((d) => d.run), [500, 501]);
  dispatchable(h, { workflow: 'ci.yml', per_hour: 2 });
  data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
  data.runs[501].status = 'completed';
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const limited = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(limited.code, 1);
  assert.match(limited.stderr, /T1 dispatched 2 CI runs in the last hour, the ci\.dispatch\.per_hour limit of 2; the next can start at /);
  assert.equal(dispatches(h).length, 2);
});

test('the next ci dispatch at a head records the run id an entry is missing, whether it goes ahead or refuses', (t) => {
  const rows = [
    { status: 'queued', code: 1, error: /T1 already has dispatched run 400 at \w+, queued/, runs: [400] },
    { status: 'in_progress', code: 1, error: /T1 already has dispatched run 400 at \w+, in_progress/, runs: [400] },
    { status: 'completed', code: 0, runs: [400, 501] },
    // A refusal after the lookup, here from choosing the workflow, still keeps the id it found.
    { status: 'completed', dispatch: {}, code: 1, error: /no pull_request workflow run on /, runs: [400] },
    // The rate limit refuses before GitHub is read, so nothing is looked up.
    { status: 'queued', per_hour: 1, code: 1, error: /ci\.dispatch\.per_hour limit of 1/, runs: [null] },
  ];
  for (const row of rows) {
    const h = fixture(t);
    const data = dispatchable(h, row.dispatch ?? { workflow: 'ci.yml', ...(row.per_hour ? { per_hour: row.per_hour } : {}) });
    const at = new Date().toISOString();
    const state = h.readState('tasks.json');
    state.tasks[0].ci_dispatches = [{ sha: h.sha, branch: BRANCH, workflow: 'ci.yml', at, agent: 'worker', run: null }];
    h.writeState('tasks.json', state);
    data.runs = { 400: { id: 400, event: 'workflow_dispatch', head_sha: h.sha, head_branch: BRANCH, status: row.status,
      conclusion: row.status === 'completed' ? 'failure' : null, created_at: at } };
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const r = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
    assert.equal(r.code, row.code, `${row.status}: ${r.stderr}`);
    if (row.error) assert.match(r.stderr, row.error);
    assert.deepEqual(dispatches(h).map((d) => d.run), row.runs, row.status);
    const recorded = readEvents(h.state).filter((e) => e.cmd === 'ci dispatch run' && e.detail?.runs).map((e) => e.detail.runs);
    assert.deepEqual(recorded, row.runs[0] ? [[400]] : [], row.status);
  }
});

test('ci dispatch is refused for a task the agent does not hold, and the broker keeps a worker to its own task', (t) => {
  const h = fixture(t);
  dispatchable(h);
  const other = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker-T2-1']);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /worker-T2-1 dispatches CI only on a task it claimed or submitted, and T1 is claimed by worker/);
  assert.equal(JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).dispatched, undefined, 'nothing was dispatched');
  assert.deepEqual(dispatches(h), []);
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  assert.deepEqual(B.authorize(job, ['ci', 'dispatch']).slice(0, 2), ['ci', 'dispatch']);
  assert.deepEqual(B.authorize(job, ['ci', 'dispatch', 'T1']).slice(0, 2), ['ci', 'dispatch']);
  assert.throws(() => B.authorize(job, ['ci', 'dispatch', 'T2']), /works on T1 only, not T2/);
  assert.throws(() => B.authorize(job, ['ci', 'dispatch', '--task', 'T2']), /works on T1 only, not T2/);
});

test('ci dispatch finds the run without run details, and a failed dispatch leaves no record', (t) => {
  const h = fixture(t);
  const data = dispatchable(h, {});
  // No ci.dispatch.workflow: the one workflow of the PR's pull_request runs.
  data.workflows = [{ id: 90, workflow_id: 77, path: '.github/workflows/ci.yml', event: 'pull_request', head_sha: h.sha }];
  data.runDetails = 'refused';
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'dispatch', '--task', 'T1', '--agent', 'worker', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).run, 500);
  assert.deepEqual(JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).dispatched, [{ workflow: '77', ref: BRANCH, details: false }]);
  assert.deepEqual(dispatches(h).map((d) => [d.run, d.workflow]), [[500, '77']]);

  const failing = fixture(t);
  const broken = dispatchable(failing);
  broken.dispatchError = 'gh: Workflow does not have \'workflow_dispatch\' trigger (HTTP 422)';
  writeAtomic(failing.env.CI_FEEDBACK_GH, JSON.stringify(broken));
  const refused = failing.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /workflow_dispatch' trigger/);
  assert.deepEqual(dispatches(failing), []);
  assert.deepEqual(readEvents(failing.state).filter((e) => e.cmd.startsWith('ci dispatch')).map((e) => e.cmd), ['ci dispatch', 'ci dispatch failed']);
});

test('ci checks shows the dispatched run, its failing jobs and tests, and keeps its jobs out of the PR checks', (t) => {
  const h = fixture(t);
  const data = checkFeedback(h);
  const state = h.readState('tasks.json');
  state.tasks[0].ci_dispatches = [{ sha: h.sha, branch: BRANCH, workflow: 'ci.yml', at: new Date().toISOString(), agent: 'worker', run: 600 }];
  h.writeState('tasks.json', state);
  data.runs = { 600: { id: 600, event: 'workflow_dispatch', head_sha: h.sha, head_branch: BRANCH, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/app/actions/runs/600' } };
  data.runJobs = { 600: [
    { id: 61, name: 'checks (shared files)', status: 'completed', conclusion: 'skipped' },
    { id: 62, name: 'test (ubuntu-latest, node 26, shard 1/3)', status: 'completed', conclusion: 'failure' },
    { id: 63, name: 'test (ubuntu-latest, node 24, shard 1/3)', status: 'completed', conclusion: 'success' },
  ] };
  data.logs[62] = LOG;
  // The dispatched run's jobs share the PR head; the gate's own workflow listing names their suite.
  data.checks[h.sha].push({ id: 62, name: 'test (ubuntu-latest, node 26, shard 1/3)', app: 'github-actions', suite: 6, status: 'completed', conclusion: 'failure', output: { annotations_count: 0 } });
  data.suites = [{ id: 6, app: 'github-actions', status: 'completed', conclusion: 'failure', runs: 3 }];
  data.workflows = [{ id: 600, check_suite_id: 6, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', head_sha: h.sha, created_at: '2026-10-13T02:00:00Z' }];
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'checks', 'T1', '--agent', 'worker']);
  assert.equal(r.code, 0, r.stderr);
  const text = r.stdout.slice(r.stdout.indexOf('dispatched run'));
  assert.deepEqual(text.trimEnd().split('\n'), [
    `dispatched run 600 (ci.yml) at ${h.sha.slice(0, 10)}: failure https://github.com/acme/app/actions/runs/600`,
    '  checks (shared files): skipped',
    '  test (ubuntu-latest, node 26, shard 1/3): failure (job 62)',
    '    failing tests (2):',
    '      writes the report',
    "        error: 'ENOENT: no such file or directory'",
    '      rejects a stale head',
    "        error: 'expected 409 to equal 422'",
    '  test (ubuntu-latest, node 24, shard 1/3): success',
  ]);
  assert.doesNotMatch(r.stdout.slice(0, r.stdout.indexOf('dispatched run')), /shard/, 'the dispatched job is not listed among the PR checks');
  const json = h.json(['ci', 'checks', 'T1']);
  assert.equal(json.dispatch.run, 600);
  assert.equal(json.dispatch.current, true);
  assert.deepEqual(json.dispatch.jobs[1].failed_tests.map((x) => x.name), ['writes the report', 'rejects a stale head']);
  assert.equal(json.checks.some((c) => c.id === 62), false);
});

test('a worker dispatches CI and reads it through its broker', async (t) => {
  const h = fixture(t);
  checkFeedback(h);
  dispatchable(h);
  const values = { NODE_OPTIONS: h.env.NODE_OPTIONS, CI_FEEDBACK_GH: h.env.CI_FEEDBACK_GH };
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
  const r = await B.forward(job.broker, ['ci', 'dispatch'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /dispatched ci\.yml run 500/);
  assert.equal(dispatches(h)[0].run, 500);
  const checks = await B.forward(job.broker, ['ci', 'checks', '--json'], h.state);
  assert.equal(checks.code, 0, checks.stderr);
  assert.equal(JSON.parse(checks.stdout).dispatch.status, 'queued');
});


test('repository dispatch capacity queues the third task, replaces its head and starts it on completion', (t) => {
  for (const replacement of ['request', 'branch moved']) {
    const h = fixture(t);
    dispatchable(h);
    for (const id of ['T2', 'T3']) {
      h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
      h.ok(['claim', id, '--agent', 'worker']);
    }
    const state = h.readState('tasks.json');
    for (const task of state.tasks) task.branch = task.id === 'T1' ? BRANCH : `tower-crane/${task.id}-change`;
    h.writeState('tasks.json', state);
    let data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    for (const task of state.tasks) data.refs[`heads/${task.branch}`] = { object: { sha: h.sha } };
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    for (const id of ['T1', 'T2']) h.ok(['ci', 'dispatch', id, '--agent', 'worker']);
    const third = h.json(['ci', 'dispatch', 'T3', '--agent', 'worker']);
    assert.equal(third.queued, true, replacement);
    data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    assert.equal(data.dispatched.length, 2, 'the queued request sends no POST');
    const queue = () => h.readState('tasks.json').tasks.find((t) => t.id === 'T3').ci_dispatch_queue;
    const at = queue().at;
    assert.equal(queue().sha, h.sha);
    assert.match(h.run(['status']).stdout, /CI dispatches: 2 in flight, 1 queued/);
    const status = h.json(['status']);
    assert.equal(status.ci_dispatch.in_flight.length, 2);
    assert.equal(status.ci_dispatch.queued[0].task, 'T3');

    const newer = 'b'.repeat(40);
    data.refs['heads/tower-crane/T3-change'].object.sha = newer;
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    if (replacement === 'request') {
      const updated = h.json(['ci', 'dispatch', 'T3', '--agent', 'worker']);
      assert.equal(updated.queued, true);
      assert.equal(queue().sha, newer);
      assert.equal(queue().at, at, 'replacement preserves queue order');
    }
    data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    data.runs[500].status = 'completed';
    data.runs[500].conclusion = 'success';
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const payload = path.join(h.base, 'completed.json');
    fs.writeFileSync(payload, JSON.stringify({ action: 'completed', repository: { full_name: 'acme/app' }, workflow_run: data.runs[500] }));
    if (replacement === 'request') h.ok(['ci', 'webhook', payload]);
    else {
      const events = readEvents(h.state);
      for (const event of events) if (event.cmd === 'ci capacity') event.at = new Date(Date.now() - 61000).toISOString();
      fs.writeFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
      const waited = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0']);
      assert.equal(waited.code, 2, waited.stderr);
    }
    assert.equal(queue(), undefined);
    data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    assert.equal(data.dispatched.length, 3);
    assert.equal(data.dispatched[2].ref, 'tower-crane/T3-change');
    const runs = h.readState('tasks.json').tasks.find((t) => t.id === 'T3').ci_dispatches;
    assert.deepEqual(runs.map((r) => [r.run, r.sha]), [[502, newer]]);
    assert.equal(h.json(['status']).ci_dispatch.in_flight.length, 2);
  }
});

test('dispatch capacity includes unrecorded GitHub runs and failed queued starts retain the request', (t) => {
  const h = fixture(t);
  const data = dispatchable(h);
  data.runs = Object.fromEntries(['queued', 'in_progress'].map((status, i) => [100 + i, {
    id: 100 + i, event: 'workflow_dispatch', status, head_sha: 'a'.repeat(40), head_branch: `external-${i}`,
  }]));
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const r = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /queued ci.yml/);
  assert.deepEqual(dispatches(h), []);
  assert.equal(h.json(['status']).ci_dispatch.in_flight.length, 2);
  data.runs[100].status = 'completed';
  data.dispatchError = 'GitHub refused dispatch';
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const payload = path.join(h.base, 'completed.json');
  fs.writeFileSync(payload, JSON.stringify({ action: 'completed', repository: { full_name: 'acme/app' }, workflow_run: data.runs[100] }));
  const failed = h.run(['ci', 'webhook', payload]);
  assert.equal(failed.code, 0);
  assert.match(failed.stderr, /GitHub refused dispatch/);
  assert.deepEqual(dispatches(h), []);
  assert.equal(h.readState('tasks.json').tasks[0].ci_dispatch_queue.sha, h.sha);
});

test('ci.max_dispatches is an operational project setting with default 2', (t) => {
  const { settings } = require('../lib/ci-dispatch');
  for (const [value, good] of [[undefined, true], [1, true], [3, true], [0, false], [-1, false], [1.5, false], ['2', false]]) {
    const result = settings({ ci: { max_dispatches: value } });
    assert.equal(!result.error, good, String(value));
    if (good) assert.equal(result.policy.max_dispatches, value ?? 2);
  }
  const h = fixture(t);
  h.ok(['project', 'set', '--ci-max-dispatches', '3']);
  assert.equal(h.readState('project.json').ci.max_dispatches, 3);
  assert.match(h.run(['project', 'show']).stdout, /ci.max_dispatches: 3/);
  h.ok(['project', 'set', '--ci-max-dispatches', 'null']);
  assert.match(h.run(['project', 'show']).stdout, /ci.max_dispatches: 2/);
  const bad = h.run(['project', 'set', '--ci-max-dispatches', '0']);
  assert.equal(bad.code, 2);
});

test('CI workflow dispatch concurrency replaces runs on the branch and preserves main and schedule groups', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
  const group = yaml.match(/^  group: (.+)$/m)[1];
  const cancel = yaml.match(/^  cancel-in-progress: (.+)$/m)[1];
  assert.match(group, /github.event_name == 'workflow_dispatch' && format\('ci-dispatch-\{0\}', github.ref\)/);
  assert.match(group, /github.event_name == 'push' && 'ci-main-push'/);
  assert.match(group, /format\('ci-run-\{0\}', github.run_id\)/);
  assert.match(cancel, /github.event_name == 'pull_request' \|\| github.event_name == 'workflow_dispatch'/);
});


test('concurrent task dispatches reserve repository capacity under the state lock', async (t) => {
  const h = fixture(t);
  dispatchable(h);
  h.ok(['project', 'set', '--ci-max-dispatches', '1']);
  for (const id of ['T2', 'T3']) {
    h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
    h.ok(['claim', id, '--agent', 'worker']);
  }
  const state = h.readState('tasks.json');
  const data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
  for (const task of state.tasks) {
    task.branch = task.id === 'T1' ? BRANCH : `tower-crane/${task.id}-change`;
    data.refs[`heads/${task.branch}`] = { object: { sha: h.sha } };
  }
  h.writeState('tasks.json', state);
  writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
  const results = await Promise.all(['T1', 'T2', 'T3'].map((id) => h.runAsync(['ci', 'dispatch', id, '--agent', 'worker', '--json'])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(results.filter((r) => JSON.parse(r.stdout).queued).length, 2);
  assert.equal(JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).dispatched.length, 1);
  const status = h.json(['status']);
  assert.equal(status.ci_dispatch.in_flight.length, 1);
  assert.equal(status.ci_dispatch.queued.length, 2);
});


test('a queued branch returning to an active head waits for that run even when capacity increases', (t) => {
  for (const phase of ['original', 'rerun']) {
    const h = fixture(t);
    dispatchable(h);
    h.ok(['project', 'set', '--ci-max-dispatches', '1']);
    h.ok(['ci', 'dispatch', 'T1', '--agent', 'worker']);
    let data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    data.refs[`heads/${BRANCH}`].object.sha = 'b'.repeat(40);
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    assert.equal(h.json(['ci', 'dispatch', 'T1', '--agent', 'worker']).queued, true);
    if (phase === 'rerun') {
      const state = h.readState('tasks.json');
      state.tasks[0].ci_dispatches[0].status = 'completed';
      h.writeState('tasks.json', state);
    }
    h.ok(['project', 'set', '--ci-max-dispatches', '2']);
    data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    data.refs[`heads/${BRANCH}`].object.sha = h.sha;
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const payload = path.join(h.base, 'completed.json');
    fs.writeFileSync(payload, JSON.stringify({ action: 'completed', repository: { full_name: 'acme/app' },
      workflow_run: { head_sha: 'c'.repeat(40), status: 'completed' } }));
    h.ok(['ci', 'webhook', payload]);
    assert.equal(dispatches(h).length, 1, 'the same active head cannot start twice');
    assert.equal(h.readState('tasks.json').tasks[0].ci_dispatch_queue.sha, h.sha);
    data.runs[500].status = 'completed';
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    h.ok(['ci', 'webhook', payload]);
    assert.equal(dispatches(h).length, 2);
    assert.equal(h.readState('tasks.json').tasks[0].ci_dispatch_queue, undefined);
  }
});


test('deleted dispatch history releases capacity across heads and task lifecycles; transient errors keep it reserved', (t) => {
  const rows = [
    { name: 'current head', task: 'T1', sha: 'current' },
    { name: 'older head', task: 'T1', sha: 'older' },
    { name: 'other task', task: 'T2', sha: 'older' },
    { name: 'finished task', task: 'T2', sha: 'older', status: 'cancelled' },
    { name: 'accepted task', task: 'T2', sha: 'older', status: 'accepted' },
    { name: 'previous repository', task: 'T2', sha: 'older', branch: 'previous-repo-branch', repo: 'acme/new' },
    { name: 'transient failure', task: 'T2', sha: 'older', error: 'gh: service unavailable (HTTP 503)' },
    { name: 'authorization failure', task: 'T2', sha: 'older', error: 'gh: forbidden (HTTP 403)' },
  ];
  for (const row of rows) {
    const h = fixture(t);
    const data = dispatchable(h);
    if (row.repo) h.ok(['project', 'set', '--repo', row.repo]);
    h.ok(['task', 'add', '--title', 'Historical', '--acceptance', 'works']);
    const state = h.readState('tasks.json');
    const historical = state.tasks.find((t) => t.id === row.task);
    if (row.status) historical.status = row.status;
    historical.ci_dispatches = [{ sha: row.sha === 'current' ? h.sha : 'b'.repeat(40), branch: row.branch || BRANCH,
      workflow: 'ci.yml', at: new Date().toISOString(), agent: 'worker', run: 400 }];
    h.writeState('tasks.json', state);
    if (row.error) data.runErrors = { 400: row.error };
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const result = h.run(['ci', 'dispatch', 'T1', '--agent', 'worker']);
    assert.equal(result.code, row.error ? 1 : 0, `${row.name}: ${result.stderr}`);
    const entry = h.readState('tasks.json').tasks.find((t) => t.id === row.task).ci_dispatches[0];
    if (row.error) {
      assert.equal(entry.status, undefined, row.name);
      assert.equal(JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).dispatched, undefined);
    } else {
      assert.equal(entry.status, 'completed', row.name);
      assert.equal(entry.conclusion, 'not_found', row.name);
      assert.equal(JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8')).dispatched.length, 1);
    }
  }
});

test('queue errors do not suppress CI completion webhooks for a submitted PR head', (t) => {
  for (const failure of ['capacity read', 'dispatch POST', 'deleted branch']) {
    const h = fixture(t);
    let data = dispatchable(h);
    h.ok(['task', 'add', '--title', 'Queued', '--acceptance', 'works']);
    h.ok(['claim', 'T2', '--agent', 'worker']);
    const state = h.readState('tasks.json');
    state.tasks.find((t) => t.id === 'T2').branch = 'tower-crane/T2-change';
    h.writeState('tasks.json', state);
    data.refs['heads/tower-crane/T2-change'] = { object: { sha: 'b'.repeat(40) } };
    data.runs = Object.fromEntries([100, 101].map((id) => [id, { id, event: 'workflow_dispatch', status: 'queued', head_sha: 'c'.repeat(40), head_branch: `external-${id}` }]));
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    assert.equal(h.json(['ci', 'dispatch', 'T2', '--agent', 'worker']).queued, true);
    const submitted = h.readState('tasks.json');
    Object.assign(submitted.tasks[0], { status: 'submitted', submitted_by: 'worker', claim: null });
    h.writeState('tasks.json', submitted);
    data = JSON.parse(readPublished(h.env.CI_FEEDBACK_GH, 'utf8'));
    data.runs[100].status = 'completed';
    data.pr = { state: 'CLOSED', headRefOid: h.sha };
    if (failure === 'capacity read') data.capacityError = 'gh: service unavailable (HTTP 503)';
    if (failure === 'dispatch POST') data.dispatchError = 'GitHub refused dispatch';
    if (failure === 'deleted branch') delete data.refs['heads/tower-crane/T2-change'];
    writeAtomic(h.env.CI_FEEDBACK_GH, JSON.stringify(data));
    const payload = path.join(h.base, 'completed.json');
    fs.writeFileSync(payload, JSON.stringify({ action: 'completed', repository: { full_name: 'acme/app' },
      workflow_run: { head_sha: h.sha, status: 'completed' } }));
    const result = h.run(['ci', 'webhook', payload]);
    assert.equal(result.code, 0, `${failure}: ${result.stderr}`);
    assert.match(result.stderr, /queued CI dispatch:/, failure);
    assert.match(result.stdout, /CI completion handled for T1/, failure);
    assert.ok(readEvents(h.state).some((e) => e.cmd === 'ci completed' && e.task === 'T1'), failure);
    assert.ok(h.readState('tasks.json').tasks.find((t) => t.id === 'T2').ci_dispatch_queue, failure);
  }
});
