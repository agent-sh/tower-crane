'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../../lib/gates/tests');
const { scratch, isolateGit, isolateUserFile, git, commit, initRepo, worktrees, quote, nativeCrashTest } = require('./helpers');
const { detachedAlive } = require('../helpers');
const { shellQuote, treeExec, withWorktree, createRedactor, redactJoined } = require('../../lib/gates/common');
const { waitUntil, killPid } = require('../signals');

const NODE = quote(process.execPath);
const CMD = `${NODE} run-tests.js`;

// A tiny project whose runner requires every test/*.test.js and exits 1 if any throws.
const BASE = {
  'run-tests.js': `const fs = require('fs');
const path = require('path');
let failed = 0;
for (const f of fs.readdirSync(path.join(__dirname, 'test')).sort()) {
  if (!f.endsWith('.test.js')) continue;
  try { require(path.join(__dirname, 'test', f)); console.log('ok ' + f); }
  catch (e) { failed++; console.log('not ok ' + f + ': ' + e.message); }
}
process.exit(failed ? 1 : 0);
`,
  'lib/add.js': 'module.exports = (a, b) => a - b;\n',
  'lib/mul.js': 'module.exports = (a, b) => a * b;\n',
  'package.json': '{"name":"fixture-base","private":true}\n',
  'package-lock.json': '{"name":"fixture-base","lockfileVersion":3}\n',
  'Cargo.lock': '# fixture-base\nversion = 3\n',
  'test/mul.test.js': "require('assert').strictEqual(require('../lib/mul')(2, 3), 6);\n",
  // Fails with exit 2 when a build file named in argv lost its head content, else runs the suite.
  'verify-build.js': `const fs = require('fs');
const path = require('path');
for (const file of process.argv.slice(2)) {
  const p = path.join(__dirname, file);
  // read-published: a build file in the gate's checkout; no process replaces it during the run.
  if (!fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes('fixture-task-head')) {
    console.error('stale build file: ' + file);
    process.exit(2);
  }
}
process.argv.length = 2;
require('./run-tests.js');
`,
  'count-runs.js': "require('fs').appendFileSync(process.argv[2], 'run\\n');\nprocess.argv.length = 2;\nrequire('./run-tests.js');\n",
  'proof.js': "require('assert').deepEqual(process.argv.slice(2), ['test/add.test.js', 'test/new value.test.js']);\nfor (const file of process.argv.slice(2)) require('./' + file);\n",
};
const FIX = 'module.exports = (a, b) => a + b;\n';
const ADD_TEST = "require('assert').strictEqual(require('../lib/add')(1, 2), 3);\n";
const MUL_TEST = "require('assert').strictEqual(require('../lib/mul')(3, 3), 9);\n";
const { readPublished } = require('../atomic-file');

const tmp = scratch('gates-tests');
isolateGit(tmp);
isolateUserFile(tmp);
process.env.TOWER_CRANE_TMP = path.join(tmp, 'tower-crane-tmp');
fs.mkdirSync(process.env.TOWER_CRANE_TMP);
const root = path.join(tmp, 'repo');
initRepo(root, BASE);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let branches = 0;
function task(files, from = 'main') {
  git(root, 'checkout', '-q', '-b', `task-${++branches}`, from);
  const sha = commit(root, files);
  git(root, 'checkout', '-q', 'main');
  return sha;
}

function ctx(sha, { kind = 'code', args = {}, project = {}, hotfix = null } = {}) {
  return {
    root,
    worktree: null,
    task: { id: 'T1', kind, sha, status: 'submitted', ...(hotfix ? { hotfix } : {}) },
    project: { repo: 'acme/app', base: 'main', gates: { tests_cmd: args.cmd ?? CMD }, ...project },
    args: { cmd: CMD, ...args },
    log() {},
  };
}

function assertCleanedUp() {
  assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP).filter((file) => file !== 'tests-base-cache'), []);
  assert.equal(worktrees(root), 1);
}

test('host_env opts host-only tests in without reaching the ordinary suite, and records skips', async () => {
  const marker = path.join(tmp, 'host-env-marker');
  const sha = task({
    'test/host.test.js': `const test = require('node:test');
test('live host case', { skip: process.env.TC_HOST_OPT_IN !== '1' }, () => {
  require('node:assert/strict').equal(process.env.TC_HOST_OPT_IN, '1');
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
});
test('unavailable host case', { skip: 'unavailable' }, () => {
  require('node:assert/strict').fail('unavailable case must remain skipped');
});
`,
    'test/plain.test.js': "require('node:assert/strict').equal(process.env.TC_HOST_OPT_IN, undefined);\n",
  });
  // This runner follows the gate exclusion contract without depending on the repository runner.
  const runner = path.join(tmp, 'host-env-runner.cjs');
  fs.writeFileSync(runner, `const cp = require('node:child_process');
const excluded = JSON.parse(process.env.TOWER_CRANE_TEST_EXCLUDE || '[]');
const files = process.argv.slice(2).filter(f => !excluded.includes(f));
process.exit(files.length ? cp.spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status : 0);
`);
  const suite = `${NODE} ${quote(runner)} test/host.test.js test/plain.test.js`;
  const project = {
    tests: { mode: 'run-only', host_only: ['test/host.test.js'] },
    gates: { tests_cmd: suite, tests_proof_cmd: `${NODE} --test {tests}` },
  };
  const skipped = await gate.run(ctx(sha, { args: { cmd: suite }, project }));
  assert.equal(skipped.ok, true, skipped.summary);
  assert.equal(fs.existsSync(marker), false);
  project.tests.host_env = { TC_HOST_OPT_IN: '1' };
  const ran = await gate.run(ctx(sha, { args: { cmd: suite }, project }));
  assert.equal(ran.ok, true, ran.summary);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
  assert.deepEqual(skipped.receipt.host_only.run, []);
  assert.deepEqual(skipped.receipt.host_only.skipped, ['test/host.test.js']);
  assert.equal(skipped.receipt.host_only.results[0].skipped, 2);
  assert.deepEqual(ran.receipt.host_only.run, ['test/host.test.js']);
  assert.deepEqual(ran.receipt.host_only.skipped, ['test/host.test.js']);
  assert.equal(ran.receipt.host_only.results[0].ran, 1);
  assert.equal(ran.receipt.host_only.results[0].skipped, 1);
  assertCleanedUp();
});

// Claude Code's sandbox bridge socket, measured on 2.1.296: <TMPDIR>/claude-socks-<16 hex>.sock, at most 108 bytes.
const HARNESS_SOCKET = 'claude-socks-0123456789abcdef.sock';
const socketFits = (dir) => Buffer.byteLength(path.join(dir, HARNESS_SOCKET)) <= 108;

// A host-only file whose run records the TMPDIR it got, as a live harness started there would see it.
function harnessStub(name, log) {
  return task({
    [`test/${name}.test.js`]: `const test = require('node:test');
test('stub harness records its temp directory', () => {
  const os = require('node:os');
  require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir()]) + '\\n');
});
`,
  });
}

test('a deep gate temp root gives host-only commands a short TMPDIR that fits the harness socket, removed afterwards', { skip: process.platform !== 'linux' && 'the harness socket bound is Linux-only' }, async () => {
  const log = path.join(tmp, 'harness-tmp.jsonl');
  const ordinaryLog = path.join(tmp, 'ordinary-tmp.jsonl');
  const sha = harnessStub('harness', log);
  const saved = process.env.TOWER_CRANE_TMP;
  // Deep enough that <root>/tower-crane-XXXXXX/tmp cannot hold the socket, as in the 2026-10-13 gate failure.
  process.env.TOWER_CRANE_TMP = path.join(tmp, 'deep-gate-root-'.padEnd(90, 'x'));
  fs.mkdirSync(process.env.TOWER_CRANE_TMP);
  const recorder = path.join(tmp, 'ordinary-tmp.js');
  fs.writeFileSync(recorder, `require('fs').appendFileSync(${JSON.stringify(ordinaryLog)}, process.env.TMPDIR + '\\n');\n`);
  const ordinary = `${NODE} ${quote(recorder)}`;
  const messages = [];
  try {
    const c = ctx(sha, { args: { cmd: ordinary }, project: {
      tests: { mode: 'run-only', host_only: ['test/harness.test.js'], host_env: { TC_HOST_OPT_IN: '1' } },
      gates: { tests_cmd: ordinary, tests_proof_cmd: `${NODE} --test {tests}` },
    } });
    c.log = (m) => messages.push(m);
    const r = await gate.run(c);
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.receipt.host_only.run, ['test/harness.test.js']);
    const [seen] = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const dir of seen) {
      assert.ok(socketFits(dir), `the harness TMPDIR ${dir} (${Buffer.byteLength(dir)} bytes) leaves no room for ${HARNESS_SOCKET}`);
      assert.equal(dir, seen[0]);
    }
    assert.equal(fs.existsSync(seen[0]), false, 'the short TMPDIR is removed after the run');
    assert.ok(messages.some((m) => m.includes(`host-only TMPDIR ${seen[0]}`)), messages.join('\n'));
    // The ordinary suite keeps the gate scratch under the configured root.
    const ordinaryTmp = fs.readFileSync(ordinaryLog, 'utf8').trim();
    assert.ok(ordinaryTmp.startsWith(process.env.TOWER_CRANE_TMP + path.sep), ordinaryTmp);
    assertCleanedUp();
  } finally {
    fs.rmSync(process.env.TOWER_CRANE_TMP, { recursive: true, force: true });
    process.env.TOWER_CRANE_TMP = saved;
  }
});

test('a deep gate temp root with no short directory refuses before running, naming the temp root setting', { skip: process.platform !== 'linux' && 'the harness socket bound is Linux-only' }, async () => {
  const log = path.join(tmp, 'harness-refused.jsonl');
  const sha = harnessStub('harness-refused', log);
  const os = require('node:os');
  const saved = { root: process.env.TOWER_CRANE_TMP, runtime: process.env.XDG_RUNTIME_DIR, userInfo: os.userInfo };
  const deep = path.join(tmp, 'deep-'.padEnd(90, 'y'));
  process.env.TOWER_CRANE_TMP = deep;
  fs.mkdirSync(deep);
  // Both short bases are too deep: the password-database home and XDG_RUNTIME_DIR.
  os.userInfo = () => ({ ...saved.userInfo(), homedir: deep });
  process.env.XDG_RUNTIME_DIR = deep;
  try {
    const project = {
      tests: { mode: 'run-only', host_only: ['test/harness-refused.test.js'], host_env: { TC_HOST_OPT_IN: '1' } },
      gates: { tests_cmd: CMD, tests_proof_cmd: `${NODE} --test {tests}` },
    };
    const r = await gate.run(ctx(sha, { project }));
    assert.equal(r.ok, false);
    assert.match(r.summary, /TMPDIR of at most 73 bytes/);
    assert.match(r.summary, /TOWER_CRANE_TMP/);
    assert.match(r.summary, /gates\.tmp_root/);
    assert.deepEqual(r.config_failure, { key: 'tmp_root' });
    assert.equal(fs.existsSync(log), false, 'nothing ran');
    // A TMPDIR named in tests.host_env is the operator's choice and is used as given.
    project.tests.host_env.TMPDIR = path.join(tmp, 'host-env-tmp');
    fs.mkdirSync(project.tests.host_env.TMPDIR);
    const given = await gate.run(ctx(sha, { project }));
    assert.equal(given.ok, true, given.summary);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').trim())[0], project.tests.host_env.TMPDIR);
  } finally {
    os.userInfo = saved.userInfo;
    if (saved.runtime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved.runtime;
    fs.rmSync(deep, { recursive: true, force: true });
    process.env.TOWER_CRANE_TMP = saved.root;
  }
});

test('a host-only failure on the base keeps its opt-in and command, and is infrastructure for any task', async () => {
  task({
    'test/host-known.test.js': `require('node:test')('known host failure', { skip: process.env.TC_HOST_OPT_IN !== '1' }, () => {
  require('node:assert/strict').fail('existing host failure');
});
`,
  });
  const base = `task-${branches}`;
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST }, base);
  const ordinary = `${NODE} --test test/mul.test.js`;
  const host = `${NODE} --test ${shellQuote('test/host-known.test.js')}`;
  for (const mode of ['run-only', 'prove']) {
    const r = await gate.run(ctx(sha, {
      args: { cmd: ordinary },
      project: {
        base,
        tests: { mode, host_only: ['test/host-known.test.js'], host_env: { TC_HOST_OPT_IN: '1' } },
        gates: { tests_cmd: ordinary, tests_proof_cmd: `${NODE} --test {tests}` },
      },
    }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.test_failure.names, ['known host failure']);
    assert.deepEqual(r.main_failure?.names, ['known host failure']);
    assert.equal(r.confirmed_failure, undefined, 'a matching base failure is retried without a quality climb');
    // The host fails it without the change, so it waits for main or the host instead of reworking the task.
    assert.equal(r.infrastructure_failure, true, r.summary);
    assert.ok(r.summary.includes(`\`${host}\``), r.summary);
    assert.match(r.summary, /Also fails on task-\d+ at [0-9a-f]+: known host failure\. Infrastructure: .*the task stays submitted and is not reworked\./);
    assert.doesNotMatch(r.summary, /Make the tests pass/);
    assert.deepEqual(r.receipt.host_only.run, ['test/host-known.test.js']);
    assertCleanedUp();
  }
});

// A host-only failure is infrastructure only when the base fails each shared name with the same
// normalized first error line; a file the task changed needs a specific line, not a generic one.
test('a host-only failure is infrastructure only when the base fails it with the same error', async () => {
  const hostTest = (body, comment = '') => `${comment}require('node:test')('known host failure', { skip: process.env.TC_HOST_OPT_IN !== '1' }, () => {
  ${body};
});
`;
  const denied = "require('node:assert/strict').fail('the shared config stays read-only')";
  const timeout = "require('node:assert/strict').fail('timed out waiting for the probe')";
  const cases = [
    { name: 'a new failure under the same name', base: denied, head: "require('node:assert/strict').equal('worker wrote the shared config', 'denied')", infra: false },
    { name: 'the same specific failure in a file the task changed', base: denied, head: denied, comment: '// edited by the task\n', infra: true },
    { name: 'the same generic failure in a file the task changed', base: timeout, head: timeout, comment: '// edited by the task\n', infra: false },
    { name: 'the same generic failure in a file the task left alone', base: timeout, head: timeout, infra: true },
  ];
  const ordinary = `${NODE} --test test/mul.test.js`;
  for (const c of cases) {
    task({ 'test/host-known.test.js': hostTest(c.base) });
    const base = `task-${branches}`;
    const files = { 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST };
    if (c.head !== c.base || c.comment) files['test/host-known.test.js'] = hostTest(c.head, c.comment);
    const sha = task(files, base);
    const r = await gate.run(ctx(sha, {
      args: { cmd: ordinary },
      project: { base, tests: { mode: 'run-only', host_only: ['test/host-known.test.js'], host_env: { TC_HOST_OPT_IN: '1' } },
        gates: { tests_cmd: ordinary, tests_proof_cmd: `${NODE} --test {tests}` } },
    }));
    assert.equal(r.ok, false, c.name);
    assert.deepEqual(r.main_failure?.names, ['known host failure'], c.name);
    assert.equal(r.infrastructure_failure, c.infra || undefined, `${c.name}: ${r.summary}`);
    if (c.infra) assert.doesNotMatch(r.summary, /Make the tests pass/, c.name);
    else assert.match(r.summary, /Link the existing failure rather than fixing unrelated code\.\nMake the tests pass/, c.name);
    assertCleanedUp();
  }
});

test('joined redaction keeps a split token redacted across streams, a piece keeps its line ending, and ranges stay apart', () => {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  // A CR then an escape before the LF, as a progress line clears itself, is a line ending too.
  for (const eol of ['\n', '\r\n', '\r\x1b[K\n', '\r\x1b[2K\n', '\r\x1b[0m\r\n']) {
    const runs = [
      { stream: 'out', text: `split ${token.slice(0, 14)}${eol}` },
      { stream: 'err', text: `not ok 3 - flaky${eol}` },
      { stream: 'out', text: `${token.slice(14)} tail${eol}` },
    ];
    const out = redactJoined({ output: runs.map((r) => r.text).join(''), runs }, createRedactor([]));
    assert.equal(out, 'split [redacted:GITHUB_TOKEN]\nnot ok 3 - flaky\n[redacted:GITHUB_TOKEN] tail\n', JSON.stringify(eol));
  }
  // A token split between the streams on adjacent lines of the joined output stays one redacted
  // secret, as the joined text alone redacts it.
  const env = `ghp_${'a1'.repeat(18)}`;
  const cross = [
    { stream: 'out', text: `cross ${env.slice(0, 20)}\n` },
    { stream: 'err', text: `${env.slice(20)} (stderr)\n` },
    { stream: 'out', text: '-- after the split\n' },
  ];
  assert.equal(redactJoined({ output: cross.map((r) => r.text).join(''), runs: cross }, createRedactor([['CI_FIXTURE_TOKEN', env]])),
    'cross [redacted:CI_FIXTURE_TOKEN] (stderr)\n-- after the split\n');
  // A header running to the end of the text holds the environment value as its last piece.
  const value = 'Z0000ABCDEFGHJKLMNPQRSTUV7';
  const ranges = createRedactor([['S_TOKEN', value]]).ranges(`x Authorization: Bearer ${value}`);
  assert.ok(ranges.length > 0);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1].b <= ranges[i].a, JSON.stringify(ranges));
  // Input that holds the redactor's own marker characters is text like any other: ranges and
  // redact agree on it, and neither turns it into a placeholder.
  const redact = createRedactor([['S_TOKEN', value]]);
  for (const text of [
    `a \uF000\uE000\uE000\uF000 b ${value} c`,
    `[redacted:OLD] \uF001\uE000\uE000\uF001 d`,
    `\uF001\uE000\uE000${value} e`,
    `${value}\uE000\uF000 [redacted:OLD]\uF001`,
  ]) {
    let applied = '';
    let from = 0;
    for (const { a, b, label } of redact.ranges(text)) {
      applied += `${text.slice(from, a)}[redacted:${label}]`;
      from = b;
    }
    applied += text.slice(from);
    assert.equal(applied, redact(text), JSON.stringify(text));
    assert.equal(redact(text).match(/\[redacted:/g).length, text.split(value).length - 1 + text.split('[redacted:').length - 1, JSON.stringify(text));
  }
});

test('a host-only failure redacts a token its stdout wrapped around a stderr line', async () => {
  const token = `ghp_${'c3'.repeat(18)}`;
  // In process, so the file's own stdout and stderr reach the gate as two streams; the pauses let
  // the gate read each write on its own.
  const sha = task({
    'test/host-split.test.js': `const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // wait-allow: the gate sends the fixture no signal when it has read a write
console.log('split ' + process.env.TC_SPLIT_TOKEN.slice(0, 10));
pause(100);
console.error('between the halves');
pause(100);
console.log(process.env.TC_SPLIT_TOKEN.slice(10) + ' tail');
require('node:test')('host split failure', () => require('node:assert/strict').fail('host failure'));
`,
  });
  const ordinary = `${NODE} --test test/mul.test.js`;
  const r = await gate.run(ctx(sha, {
    args: { cmd: ordinary },
    project: {
      tests: { mode: 'run-only', host_only: ['test/host-split.test.js'], host_env: { TC_SPLIT_TOKEN: token } },
      gates: { tests_cmd: ordinary, tests_proof_cmd: `${NODE} --test --test-isolation=none {tests}` },
    },
  }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.test_failure.names, ['host split failure']);
  const tail = r.test_failure.output_tail;
  assert.ok(!/(?:c3){4}/.test(tail), tail);
  assert.match(tail.replace(/^between the halves\n/m, ''), /^split \[redacted:TC_SPLIT_TOKEN\](?:\n\[redacted:TC_SPLIT_TOKEN\])? tail$/m);
  assertCleanedUp();
});

test('missing host-only command pins report the proof command configuration', async () => {
  const sha = task({ 'test/host-pin.test.js': "require('node:test')('host pin', () => {});\n" });
  const ordinary = `${NODE} --test test/mul.test.js`;
  const absent = 'tower-crane-no-such-host-runner {tests}';
  for (const [proof, windowsDiagnostic] of [[null, false], [absent, false], [absent, true]]) {
    const check = ctx(sha, {
      args: { cmd: ordinary },
      project: {
        tests: { mode: 'run-only', host_only: ['test/host-pin.test.js'] },
        gates: { tests_cmd: ordinary, tests_proof_cmd: proof },
      },
    });
    if (windowsDiagnostic) {
      const host = proof.replace('{tests}', shellQuote('test/host-pin.test.js'));
      check.exec = (command, args, opts) => command === host
        ? { status: 1, stdout: '', stderr: "'tower-crane-no-such-host-runner' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n" }
        : treeExec(command, args, opts);
    }
    const r = await gate.run(check);
    assert.equal(r.ok, false);
    assert.deepEqual(r.config_failure, { key: 'tests_proof_cmd' });
    assert.equal(r.confirmed_failure, undefined);
    assertCleanedUp();
  }
});

test('host case counts distinguish TAP, spec, all skips and unreported output', () => {
  for (const [output, expected] of [
    ['# tests 2\n# pass 1\n# fail 0\n# skipped 1\n', { ran: 1, skipped: 1 }],
    ['ℹ tests 2\nℹ pass 0\nℹ fail 0\nℹ skipped 2\n', { ran: 0, skipped: 2 }],
    ['# tests 1\n# pass 0\n# fail 0\n# skipped 0\n# todo 1\n', { ran: 0, skipped: 1 }],
    ['ok host.test.js\n', { ran: null, skipped: null }],
    ['# tests 2\n# pass 1\n# fail 0\n# skipped 0\n', { ran: null, skipped: null }],
    // A reporter that links or titles its summary lines still gives its counts.
    ['\x1b]8;;file:///x\x07ℹ tests 2\x1b]8;;\x07\nℹ pass 1\nℹ fail 0\n\x9d0;t\x9cℹ skipped 1\n', { ran: 1, skipped: 1 }],
  ]) assert.deepEqual(gate.hostCounts({ output }), expected, output);
});

test('host skip reasons lose terminal escapes before they are redacted and cut', () => {
  const { createRedactor } = require('../../lib/gates/common');
  const token = `ghp_${'b2'.repeat(18)}`;
  const redact = createRedactor([['HOST_TOKEN', token]]);
  const output = [
    'ok 1 - live # SKIP \x1b]8;;https://example.test\x07set TC_HOST_OPT_IN=1\x1b]8;;\x07',
    `ok 2 - token # SKIP token ${token.slice(0, 6)}\x1b]0;t\x07${token.slice(6, 12)}\x1b\x7f${token.slice(12)}`,
  ].join('\n');
  assert.deepEqual(gate.skipReasons({ output }, redact), ['set TC_HOST_OPT_IN=1', 'token [redacted:HOST_TOKEN]']);
});

test('default host test formats exclude data; explicit paths support other formats', () => {
  const defaults = gate.hostTestMatcher({});
  for (const [file, expected] of [
    ['test/lab/live.test.js', true],
    ['tests/test_session.py', true],
    ['Tests/SessionTest.java', true],
    ['test/session.sh', true],
    ['test/session.feature', true],
    ['test/README.md', false],
    ['test/test_config.json', false],
    ['test/session.csv', false],
    ['test/fixtures/value.test.js', false],
    ['test/helpers/value.test.js', false],
    ['test/session.case', false],
    ['test/session', false],
  ]) assert.equal(defaults.match(file), expected, file);
  const explicit = gate.hostTestMatcher({ tests: { paths: ['test/**'] } });
  assert.equal(explicit.match('test/session.case'), true);
  assert.equal(explicit.match('test/session'), true);
  assert.equal(explicit.match('test/fixtures/session.case'), false);
});

test('a broad host-only glob selects tests, excluding fixtures and non-test files', async () => {
  const sha = task({
    'lib/add.js': FIX,
    'test/lab/live.test.js': `require('node:test')('host selection', () => {
  require('node:assert/strict').equal(process.env.TC_HOST_OPT_IN, '1');
  require('node:assert/strict').equal(require('../../lib/add')(1, 2), 3);
});
`,
    'test/lab/fixtures/input.test.js': "throw new Error('a fixture must not run');\n",
    'test/lab/helpers/util.test.js': "throw new Error('a helper must not run');\n",
    'test/lab/README.md': 'This is documentation, not a test.\n',
    'test/lab/session.json': '{"description":"test data"}\n',
  });
  const runner = `${NODE} ${quote(path.resolve(__dirname, '../run.js'))}`;
  const suite = `${runner} test/mul.test.js`;
  for (const paths of [null, ['test/**/*.test.js']]) {
    const r = await gate.run(ctx(sha, {
      args: { cmd: suite },
      project: {
        tests: { expensive: true, paths, host_only: ['test/lab/**'], host_env: { TC_HOST_OPT_IN: '1' } },
        gates: { tests_cmd: suite, tests_proof_cmd: `${runner} {tests}` },
      },
    }));
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /tests pass with the change and fail without it/);
    assert.deepEqual(r.receipt.host_only.run, ['test/lab/live.test.js']);
    assert.equal(r.receipt.host_only.results.length, 1);
  }
  assertCleanedUp();
});

test('a skipped changed host-only test cannot prove code, and host_env reaches its revert run', async () => {
  const sha = task({
    'lib/add.js': FIX,
    'test/host-proof.test.js': `require('node:test')('live proof', { skip: process.env.TC_HOST_OPT_IN !== '1' && 'set TC_HOST_OPT_IN=1 to run the live proof'
  + (process.env.TC_HOST_TOKEN ? ' ' + 'p'.repeat(150) + process.env.TC_HOST_TOKEN : '') }, () => {
  require('node:assert/strict').equal(require('../lib/add')(1, 2), 3);
});
`,
  });
  const suite = `${NODE} --test test/mul.test.js`;
  const project = {
    tests: { host_only: ['test/host-proof.test.js'], expensive: true },
    gates: { tests_cmd: suite, tests_proof_cmd: `${NODE} --test {tests}` },
  };
  const skipped = await gate.run(ctx(sha, { args: { cmd: suite }, project }));
  assert.equal(skipped.ok, false, skipped.summary);
  assert.match(skipped.summary, /changed host-only tests skipped.*do not prove/);
  // The refusal says how many cases ran and why the rest skipped, so the orchestrator can tell a missing opt-in.
  assert.match(skipped.summary, /^test\/host-proof\.test\.js: 0 ran, 1 skipped; skipped because: set TC_HOST_OPT_IN=1 to run the live proof$/m);
  assert.match(skipped.summary, /tests\.host_env gives host-only commands no variables\. Set the opt-ins .* --tests-host-env JSON, then run tower-crane gates retry T1\./);
  assert.deepEqual(skipped.receipt.host_only.run, []);
  assert.deepEqual(skipped.receipt.host_only.skipped, ['test/host-proof.test.js']);
  assert.deepEqual(skipped.receipt.host_only.results, [{ file: 'test/host-proof.test.js', ran: 0, skipped: 1,
    skip_reasons: ['set TC_HOST_OPT_IN=1 to run the live proof'] }]);
  // A worker's task goes back to the worker; a merged hotfix has none, so it waits on tests.host_env.
  assert.equal(skipped.config_failure, undefined);
  const hotfix = { merge_sha: sha, base_sha: git(root, 'rev-parse', `${sha}^1`), base: 'main' };
  const merged = await gate.run(ctx(sha, { args: { cmd: suite }, project, hotfix }));
  assert.equal(merged.ok, false, merged.summary);
  assert.deepEqual(merged.config_failure, { key: 'tests_host_env' });
  assert.equal(merged.confirmed_failure, undefined);
  // A secret in a skip reason is redacted before the 200-character cut, so no piece of it reaches the receipt.
  const secret = 'abcd1234efgh5678ijkl9012mnop';
  const leaky = await gate.run(ctx(sha, { args: { cmd: suite }, project: { ...project, tests: { ...project.tests, host_env: { TC_HOST_TOKEN: secret } } }, hotfix }));
  const [reason] = leaky.receipt.host_only.results[0].skip_reasons;
  assert.equal(reason.length, 200);
  assert.ok(reason.startsWith(`set TC_HOST_OPT_IN=1 to run the live proof ${'p'.repeat(150)}[redac`), reason);
  assert.doesNotMatch(reason, /abcd/);
  assert.doesNotMatch(leaky.summary, /abcd/);
  project.tests.host_env = { TC_HOST_OPT_IN: '1' };
  const ran = await gate.run(ctx(sha, { args: { cmd: suite }, project }));
  assert.equal(ran.ok, true, ran.summary);
  assert.match(ran.summary, /tests pass with the change and fail without it/);
  assert.deepEqual(ran.receipt.host_only.run, ['test/host-proof.test.js']);
  assertCleanedUp();
});

test('a test that fails without the change and passes with it: ok', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.sha, sha);
  assert.match(r.summary, /run-tests\.js` at [0-9a-f]+: exit 0/);
  assert.match(r.summary, /1 non-test file reverted .*lib\/add\.js.*: exit 1/);
  assertCleanedUp();
});

test('a test that passes without the change: not ok', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/mul2.test.js': MUL_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /tests pass without the change; they do not prove it/);
  assertCleanedUp();
});

test('a file the task added is removed for the run without the change', async () => {
  const sha = task({
    'lib/sub.js': 'module.exports = (a, b) => a - b;\n',
    'test/sub.test.js': "require('assert').strictEqual(require('../lib/sub')(3, 1), 2);\n",
  });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assertCleanedUp();
});

test('a native child crash reruns only the failing file once: a one-off passes with a native_crash note and its core read, a repeat or one beside an ordinary failure fails', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const dir = path.join(tmp, 'coredump');
  const keep = path.join(tmp, 'native-cores');
  fs.mkdirSync(dir);
  const uid = process.getuid();
  const boot = 'ea9acc2f-d3d5-4667-91e9-317bd68c61d5';
  // A core from before the run is another crash's and stays as it is.
  const stale = path.join(dir, `core._old_bin_node.${uid}.${boot}.1.1`);
  fs.writeFileSync(stale, 'old core');
  fs.utimesSync(stale, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  const gdbArgs = path.join(tmp, 'gdb-args');
  const readable = path.join(tmp, 'gdb-ok');
  fs.writeFileSync(readable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(gdbArgs)}\nprintf '%s\\n' 'Program terminated with signal SIGSEGV, Segmentation fault.' '#0  0x0000000001 in v8::internal::Heap::Scavenge() ()' '#1  0x0000000002 in node::Start(int, char**) ()'\n`, { mode: 0o755 });
  const unreadable = path.join(tmp, 'gdb-bad');
  fs.writeFileSync(unreadable, "#!/bin/sh\necho 'not a core dump: file format not recognized' >&2\nexit 1\n", { mode: 0o755 });
  const spec = `${NODE} --test --test-reporter=spec`;
  const project = { gates: { tests_cmd: `${spec} test/counted.test.js test/crash.test.js`, tests_proof_cmd: `${spec} {tests}` } };
  const rerun = (ok) => [{ step: 'head', files: ['test/crash.test.js'], ok }];
  const flaky = ['test/crash.test.js > child crashes natively'];
  for (const [name, options, want] of [
    ['one-off', { times: 1, exe: process.execPath, gdb: readable }, { ok: true, crashes: 1, runs: 2, rerun: rerun(true), stack: true, flaky, note: /Rerun: reran test\/crash\.test\.js once in the same checkout: exit 0; flaky: test\/crash\.test\.js > child crashes natively\./ }],
    ['one-off in a describe', { times: 1, nest: 'describe', gdb: readable }, { ok: true, crashes: 1, runs: 2, rerun: rerun(true), stack: true, flaky, note: /exit 0; flaky: test\/crash\.test\.js > child crashes natively\./ }],
    ['one-off in a subtest', { times: 1, nest: 'subtest', gdb: readable }, { ok: true, crashes: 1, runs: 2, rerun: rerun(true), stack: true, flaky, note: /exit 0; flaky: test\/crash\.test\.js > child crashes natively\./ }],
    ['every time', { times: Infinity, gdb: unreadable }, { ok: false, crashes: 2, runs: 2, rerun: rerun(false), stack: false, flaky: undefined, note: /Rerun: reran test\/crash\.test\.js once in the same checkout: exit 1, native crash again: .*the failure stands/ }],
    ['beside an ordinary failure', { times: 1, ordinary: true, gdb: readable }, { ok: false, crashes: 1, runs: 2, rerun: rerun(false), stack: true, flaky: undefined, note: /Native crash: child crashes natively \(SIGSEGV, pid \d+\)[^\n]*\. Rerun: reran test\/crash\.test\.js once in the same checkout: exit 1; the failure stands/ }],
  ]) {
    fs.rmSync(gdbArgs, { force: true });
    const marker = path.join(tmp, `crash-${branches}`);
    const counted = path.join(tmp, `counted-${branches}`);
    const exe = options.exe ? options.exe.replace(/[/.]/g, '_') : '_fixture_bin_node';
    const core = path.join(dir, `core.${exe}.${uid}.${boot}.PID.${branches}`);
    // A core of another process in the run's window has no crash to pair with and is emptied.
    const other = path.join(dir, `core._fixture_bin_other.${uid}.${boot}.999999.${branches}`);
    const sha = task({
      'test/crash.test.js': nativeCrashTest({ marker, core, ...options }),
      'test/counted.test.js': `require('fs').appendFileSync(${JSON.stringify(counted)}, 'x');\nrequire('fs').writeFileSync(${JSON.stringify(other)}, 'other core');\n`,
    });
    const r = await gate.run({ ...ctx(sha, { args: { cmd: project.gates.tests_cmd }, project }), cores: { dir, keep, gdb: options.gdb } });
    assert.equal(r.ok, want.ok, `${name}: ${r.summary}`);
    assert.match(r.summary, want.note, name);
    assert.equal(r.native_crash.length, want.crashes, name);
    assert.deepEqual(r.receipt?.reruns, want.rerun, name);
    assert.deepEqual(r.flaky?.map((f) => f.test), want.flaky, name);
    if (want.flaky) assert.equal(r.flaky[0].native_crash, true, name);
    for (const crash of r.native_crash) {
      assert.equal(crash.test, 'child crashes natively', name);
      assert.equal(crash.signal, 'SIGSEGV', name);
      assert.ok(Number.isInteger(crash.pid), name);
      const original = core.replace('PID', String(crash.pid));
      assert.equal(fs.statSync(original).size, 0, `${name}: the shared core is emptied`);
      assert.equal(crash.core_file, path.join(keep, path.basename(original)), name);
      assert.equal(fs.statSync(keep).mode & 0o777, 0o700, name);
      if (want.stack) {
        assert.deepEqual(crash.stack, ['#0  0x0000000001 in v8::internal::Heap::Scavenge() ()', '#1  0x0000000002 in node::Start(int, char**) ()'], name);
        assert.equal(fs.existsSync(crash.core_file), false, `${name}: the read core is deleted`);
        const args = readPublished(gdbArgs, 'utf8').trim().split('\n');
        assert.deepEqual(args.slice(-2), ['-c', crash.core_file], name);
        assert.equal(args.includes(process.execPath), !!options.exe, `${name}: the executable gdb reads`);
      } else {
        assert.equal(crash.core_error, 'not a core dump: file format not recognized', name);
        assert.equal(fs.statSync(crash.core_file).mode & 0o777, 0o600, `${name}: an unread core stays private`);
        assert.equal(readPublished(crash.core_file, 'utf8'), `core of ${crash.pid}`, name);
      }
    }
    assert.equal(fs.statSync(other).size, 0, `${name}: an unpaired core is emptied`);
    assert.equal(readPublished(stale, 'utf8'), 'old core', name);
    assert.equal(readPublished(marker, 'utf8').length, want.runs, `${name}: crash test runs`);
    assert.equal(readPublished(counted, 'utf8').length, 1, `${name}: the passing file is not rerun`);
    assert.equal(!!r.confirmed_failure, !want.ok, name);
    assertCleanedUp();
  }
});

test('a failing test reruns once: one that then passes is flaky with both runs, one that fails twice keeps the failure, and a reverted failure is not rerun', async () => {
  const spec = `${NODE} --test --test-reporter=spec --test-concurrency=1`;
  const suite = `${spec} test/*.test.js`;
  for (const [name, { times, mode = 'run-only', selector = true }, want] of [
    ['fails once', { times: 1 }, { ok: true, flaky: true, runs: 2, counted: 1, rerun: ['test/flaky.test.js'], note: /Rerun: reran test\/flaky\.test\.js once in the same checkout: exit 0; flaky: test\/flaky\.test\.js > sometimes fails\./ }],
    ['fails twice', { times: 2 }, { ok: false, flaky: false, runs: 2, counted: 1, rerun: ['test/flaky.test.js'], note: /Rerun: reran test\/flaky\.test\.js once in the same checkout: exit 1; the failure stands\./ }],
    ['fails once with no file selector', { times: 1, selector: false }, { ok: true, flaky: true, runs: 2, counted: 2, rerun: [], note: /reran the whole command \(the pinned runner has no file selector \(gates\.tests_proof_cmd with \{tests\}\)\) once in the same checkout: exit 0/ }],
    // The reverted run fails test/add.test.js as the proof wants, and that failure is not rerun.
    ['fails once in prove mode', { times: 1, mode: 'prove' }, { ok: true, flaky: true, runs: 3, counted: 2, rerun: ['test/flaky.test.js'], note: /flaky: test\/flaky\.test\.js > sometimes fails\./ }],
  ]) {
    const marker = path.join(tmp, `flaky-${branches}`);
    const counted = path.join(tmp, `flaky-counted-${branches}`);
    const sha = task({
      'lib/add.js': FIX,
      'test/add.test.js': ADD_TEST,
      'test/counted.test.js': `require('fs').appendFileSync(${JSON.stringify(counted)}, 'x');\n`,
      'test/flaky.test.js': `const { test } = require('node:test');
const fs = require('node:fs');
test('sometimes fails', () => {
  // read-published: only this test writes the marker, and runs are sequential.
  const runs = fs.existsSync(${JSON.stringify(marker)}) ? fs.readFileSync(${JSON.stringify(marker)}, 'utf8').length : 0;
  fs.appendFileSync(${JSON.stringify(marker)}, 'x');
  if (runs < ${times}) throw new Error('flaked on run ' + runs);
});
`,
    });
    const project = { tests: { mode }, gates: { tests_cmd: suite, ...(selector ? { tests_proof_cmd: `${spec} {tests}` } : {}) } };
    const r = await gate.run(ctx(sha, { args: { cmd: suite }, project }));
    assert.equal(r.ok, want.ok, `${name}: ${r.summary}`);
    assert.match(r.summary, want.note, name);
    assert.deepEqual(r.receipt.reruns, [{ step: 'head', files: want.rerun, ok: want.ok }], name);
    assert.equal(!!r.confirmed_failure, !want.ok, name);
    assert.equal(readPublished(marker, 'utf8').length, want.runs, `${name}: flaky test runs`);
    assert.equal(readPublished(counted, 'utf8').length, want.counted, `${name}: passing file runs`);
    if (!want.flaky) {
      assert.equal(r.flaky, undefined, name);
      continue;
    }
    assert.equal(r.flaky.length, 1, name);
    const [flaky] = r.flaky;
    assert.equal(flaky.test, 'test/flaky.test.js > sometimes fails', name);
    assert.equal(flaky.step, 'head', name);
    assert.deepEqual(flaky.files, ['test/flaky.test.js'], name);
    assert.equal(flaky.first_failure.command, suite, name);
    assert.equal(flaky.first_failure.status, 1, name);
    assert.match(flaky.first_failure.error, /flaked on run 0/, name);
    assert.match(flaky.first_failure.excerpt, /^✖ sometimes fails[^\n]*\n[\s\S]*flaked on run 0/, name);
    assert.equal(flaky.rerun.command, selector ? `${spec} ${shellQuote('test/flaky.test.js')}` : suite, name);
    assert.equal(flaky.rerun.status, 0, name);
    assert.ok(flaky.rerun.duration_ms >= 0 && flaky.first_failure.duration_ms >= 0, name);
    assertCleanedUp();
  }
});

test('a code task that changes no test: not ok', async () => {
  const sha = task({ 'lib/add.js': FIX });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no test covers this change/);
  assert.match(r.summary, /tower-crane project set --tests-paths/);
  assertCleanedUp();
});

test('deleting a test is not a test for the change', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/mul.test.js': null });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /no test covers this change/);
});

test('a docs task that changes no test: ok once the command passes', async () => {
  const sha = task({ 'README.md': '# app\n' });
  const r = await gate.run(ctx(sha, { kind: 'docs' }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /exit 0/);
  const broken = task({ 'README.md': '# app\n', 'lib/mul.js': 'module.exports = () => 0;\n' });
  assert.equal((await gate.run(ctx(broken, { kind: 'docs' }))).ok, false);
  assertCleanedUp();
});

test('a command that fails at the submitted commit: not ok, with the output tail', async () => {
  const sha = task({ 'lib/add.js': 'module.exports = (a, b) => a * b;\n', 'test/add.test.js': ADD_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false);
  assert.match(r.summary, /run-tests\.js` at [0-9a-f]+: exit 1/);
  assert.match(r.summary, /not ok add\.test\.js/);
  assertCleanedUp();
});

test('a task that changes only tests: ok with a note', async () => {
  const sha = task({ 'test/mul2.test.js': MUL_TEST });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /run-only \(test-only diff\)/);
  assert.equal(r.receipt.mode, 'run-only (test-only diff)');
  assert.deepEqual(r.receipt.changed_files, ['test/mul2.test.js']);
  assertCleanedUp();
});

test('commits the task inherited from origin/<base> are not its change', async () => {
  // origin/main moved ahead of the local main; the task branched from origin/main and adds a test.
  const ahead = task({ 'lib/extra.js': 'module.exports = 1;\n' });
  git(root, 'update-ref', 'refs/remotes/origin/main', ahead);
  try {
    const sha = task({ 'test/mul2.test.js': MUL_TEST }, ahead);
    const r = await gate.run(ctx(sha));
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /run-only \(test-only diff\)/);
    assert.deepEqual(r.receipt.changed_files, ['test/mul2.test.js']);
  } finally {
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
  }
});

// A zombie counts as gone; Linux and macOS reap orphans promptly.
const running = (pid) => detachedAlive({ pid });

test('a timeout stops the command and everything it started', { skip: process.platform === 'win32' }, async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const marker = path.join(tmp, 'late-write');
  const pidFile = path.join(tmp, 'late-writer.pid');
  // `; true` keeps the shell alive, so the writer is a grandchild, not the shell itself.
  // The writer would finish long after the gate's own setup, which under host load can take seconds.
  // It publishes its pid first, so the test can see it gone instead of waiting out its timer.
  const writer = `const fs = require('fs'); fs.writeFileSync(process.argv[2] + '.new', String(process.pid)); fs.renameSync(process.argv[2] + '.new', process.argv[2]);
setTimeout(() => fs.writeFileSync(process.argv[1], 'x'), 10000);`; // wait-allow: verify timed-out commands cannot write a delayed marker
  const cmd = `${NODE} -e ${quote(writer)} ${quote(marker)} ${quote(pidFile)}; true`;
  const started = Date.now();
  const r = await gate.run(ctx(sha, { args: { cmd, timeout: 0.01 } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /timed out/);
  assert.ok(Date.now() - started < 8000, 'the gate waited for the command instead of stopping it'); // wait-allow: verify the gate terminates the command before its delayed marker write
  if (fs.existsSync(pidFile)) {
    // A writer that is gone cannot write; one that survived writes before it exits.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !running(pid), { what: 'the late writer to exit' });
  } else {
    // Under load the writer may not have published its pid; wait out its timer instead.
    await new Promise((resolve) => setTimeout(resolve, 11000 - (Date.now() - started))); // wait-allow: verify timed-out commands cannot write a delayed marker
  }
  assert.equal(fs.existsSync(marker), false, 'a process the command started outlived the timeout');
  assertCleanedUp();
});

// A test command whose own fixtures start detached processes moves them into new sessions, out
// of the gate's process group. One here outlives its parent; the other keeps its parent but
// runs with a cleared environment.
test('a command\'s processes in their own sessions stop with it, orphaned or not', { skip: process.platform !== 'linux' }, async (t) => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const pids = path.join(tmp, 'session-pids');
  fs.writeFileSync(pids, '');
  const poller = `require('fs').appendFileSync(process.argv[1], process.pid + '\\n'); setInterval(() => {}, 1000);`;
  // The starter returns once the detached process has recorded its pid; `held` keeps it running.
  const starter = (env, held) => `const fs = require('fs');
const count = () => fs.readFileSync(process.argv[2], 'utf8').split('\\n').length;
const before = count();
require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(poller)}, process.argv[2]],
  { detached: true, stdio: 'ignore'${env} }).unref();
const tick = () => (count() > before ? ${held ? 'setInterval(() => {}, 1000)' : 'process.exit(0)'} : setTimeout(tick, 20)); // wait-allow: probe cadence only; the recorded pid is the signal
tick();
`;
  for (const [name, script, timeout] of [['exited', starter('', false), undefined], ['timed out', starter(', env: {}', true), 0.05]]) {
    const file = path.join(tmp, 'session-starter.js');
    fs.writeFileSync(file, script);
    const cmd = `${NODE} ${quote(file)} ${quote(pids)} && ${CMD}`;
    const recorded = () => fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
    const before = recorded().length;
    await gate.run(ctx(sha, { args: { cmd, ...(timeout ? { timeout } : {}) } }));
    const started = recorded().slice(before);
    assert.ok(started.length > 0, 'the detached process started');
    t.after(() => { for (const pid of started.filter(running)) killPid(pid, 'SIGKILL'); });
    await waitUntil(() => !started.some(running), {
      what: () => `a detached process outlived a command that ${name}: ${started.filter(running).join(', ')}`,
    });
    assertCleanedUp();
  }
});

test('gate commands run with gc.autoDetach=false after the caller\'s own GIT_CONFIG entries', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'towercrane.probe', GIT_CONFIG_VALUE_0: 'kept' });
  try {
    const seen = await withWorktree(ctx(sha), root, sha, async (dir, env) => ({
      env: Object.fromEntries(Object.entries(env).filter(([k]) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k))),
      git: ['towercrane.probe', 'gc.autoDetach'].map((key) =>
        require('child_process').execFileSync('git', ['-C', dir, 'config', '--get', key], { env, encoding: 'utf8' }).trim()),
    }));
    assert.deepEqual(seen.env, {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'towercrane.probe', GIT_CONFIG_VALUE_0: 'kept',
      GIT_CONFIG_KEY_1: 'gc.autoDetach', GIT_CONFIG_VALUE_1: 'false',
    });
    assert.deepEqual(seen.git, ['kept', 'false']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assertCleanedUp();
});

test('timeouts at head, scoped proof and reversion are infrastructure failures, never proof', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  for (const stage of [1, 2, 3]) {
    const context = ctx(sha, { project: {
      tests: { expensive: true },
      gates: { tests_cmd: CMD, tests_proof_cmd: `${CMD} {tests}`, tests_timeout_min: 0.05 },
    } });
    let calls = 0;
    context.exec = (command, args, opts) => {
      if (!opts.shell) return require('node:child_process').spawnSync(command, args, opts);
      assert.equal(opts.timeout, 3000);
      if (++calls !== stage) return { status: 0, stdout: '', stderr: '' };
      return { status: 1, error: Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }),
        stdout: 'not ok 1 - cut off', stderr: '', timeoutOutput: '# Subtest: test/slow.test.js\n' };
    };
    const r = await gate.run(context);
    assert.equal(r.ok, false, `stage ${stage}: ${r.summary}`);
    assert.equal(r.infrastructure_failure, true);
    assert.equal(r.confirmed_failure, undefined);
    assert.equal(r.test_failure, undefined);
    assert.match(r.summary, /timed out after 0\.05 min/);
    assert.deepEqual(r.timeout.running_files, ['test/slow.test.js']);
    assert.equal(calls, stage);
    assertCleanedUp();
  }
});

test('a worktree add that fails after registering leaves no registration behind', async () => {
  // git registers the worktree, checks it out, then runs post-checkout; a failing hook makes
  // the add exit non-zero with the registration already written.
  const hooked = path.join(tmp, 'hooked');
  initRepo(hooked, BASE);
  git(hooked, 'checkout', '-q', '-b', 'task');
  const sha = commit(hooked, { 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  git(hooked, 'checkout', '-q', 'main');
  const hooks = path.join(tmp, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // The gate's git runs only hooks from the user's own config.
  git(hooked, 'config', '--global', 'core.hooksPath', hooks);
  let r;
  try { r = await gate.run({ ...ctx(sha), root: hooked }); }
  finally { git(hooked, 'config', '--global', '--unset', 'core.hooksPath'); }
  assert.equal(r.ok, false);
  assert.match(r.summary, /could not create a worktree/);
  assert.equal(worktrees(hooked), 1);
  assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP).filter((file) => file !== 'tests-base-cache'), []);
});

test('a commit that is not in the repository: not ok', async () => {
  const r = await gate.run(ctx('0123456789abcdef0123456789abcdef01234567'));
  assert.equal(r.ok, false);
  assert.match(r.summary, /is not in/);
});

test('a capitalized Tests/ directory holds tests: the gate runs them', async () => {
  const sha = task({ 'lib/add.js': FIX, 'Tests/AddTests.js': ADD_TEST });
  const r = await gate.run(ctx(sha, { args: { cmd: `${NODE} Tests/AddTests.js` } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Tests: Tests\/AddTests\.js/);
  assertCleanedUp();
});

test('a helper or fixture edited under test/ is not a test for the change', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/helpers.js': 'module.exports = {};\n', 'test/fixtures/hooks.js': 'module.exports = [];\n' });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, false, r.summary);
  assert.match(r.summary, /no test covers this change: .*adds or changes no test file/);
  assert.equal(r.worker_failure, true, 'the worker fixes it, so the gate says so');
  assertCleanedUp();
});

// One layout per language convention the default patterns must know.
for (const [layout, p] of [
  ['SwiftPM', 'Tests/AppTests/FooTests.swift'],
  ['.NET', 'MyApp.Tests/FooTests.cs'],
  ['Java outside src/test', 'src/FooTest.java'],
  ['Kotlin in Test/', 'Test/FooTest.kt'],
  ['JavaScript in Tests/', 'Tests/ValueTests.js'],
  ['Maven integration tests', 'src/it/OrderIT.java'],
  ['Android instrumented tests', 'app/src/androidTest/java/MainTest.java'],
  ['Flutter integration_test', 'integration_test/app_test.dart'],
  ['RSpec', 'lib/foo_spec.rb'],
]) {
  test(`${layout} test files are tests: ${p}`, () => {
    assert.equal(gate.isTestFile(p), true);
  });
}

test('test file patterns', () => {
  for (const p of ['test/a.js', 'src/tests/b.py', 'a/__tests__/c.ts', 'spec/d.rb', 'pkg/e_test.go', 'f.test.js', 'g.spec.ts', 'py/test_h.py', 'test_i.py', 'TestFoo.java', 'MyApp.UnitTests/A.cs', 'test/helpers.test.js']) {
    assert.equal(gate.isTestFile(p), true, p);
  }
  // Fixtures and helpers load the tests; they are support code, not tests, even under test/.
  for (const p of ['test/helpers.js', 'test/gate-helpers.js', 'test/stack-fixture.js', 'test/fixtures/hooks.js', 'test/helpers/run.js', 'spec/spec_helper.rb', 'tests/conftest.py']) {
    assert.equal(gate.isTestFile(p), false, p);
  }
  // A code file taken for a test would never be reverted, so near misses stay code.
  for (const p of ['lib/a.js', 'contest/b.js', 'latest/c.js', 'testdata/d.json', 'respec/h.js', 'src/latest.js', 'contest.py', 'attest.go', 'docs/testing.md', 'src/Testimony.js', 'AUDIT.md']) {
    assert.equal(gate.isTestFile(p), false, p);
  }
});

test('project.json tests.paths replaces the default layouts', async () => {
  const project = { tests: { paths: ['checks/**/*.chk.js'] } };
  const chk = task({ 'lib/add.js': FIX, 'checks/add.chk.js': ADD_TEST });
  const r = await gate.run(ctx(chk, { project, args: { cmd: `${NODE} checks/add.chk.js` } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Tests: checks\/add\.chk\.js/);
  // With the override set, a default-layout test no longer counts.
  const dflt = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const d = await gate.run(ctx(dflt, { project }));
  assert.equal(d.ok, false);
  assert.match(d.summary, /no test covers this change: .*by project\.json tests\.paths/);
  assertCleanedUp();
});

test('globs in tests.paths', () => {
  const { match } = gate.testMatcher({ tests: { paths: ['src/test/**', '**/*Test.java', '{unit,e2e}/case?.js', 'qa/'] } });
  for (const p of ['src/test/a/B.java', 'FooTest.java', 'm/n/FooTest.java', 'unit/case1.js', 'e2e/case2.js', 'qa/x/y.txt']) assert.equal(match(p), true, p);
  for (const p of ['src/main/A.java', 'test/a.test.js', 'FooTest.kt', 'int/case1.js', 'unit/case10.js', 'qaz/x']) assert.equal(match(p), false, p);
});

test('a malformed tests.paths: not ok, naming the field', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  for (const tests of [{ paths: [] }, { paths: 'test/**' }, { paths: [''] }, ['test/**'], 'test/**']) {
    const r = await gate.run(ctx(sha, { project: { tests } }));
    assert.equal(r.ok, false, JSON.stringify(tests));
    assert.match(r.summary, /tests\.paths must be a non-empty array of globs/);
    assert.match(r.summary, /tower-crane project set --tests-paths/);
    assert.match(r.summary, /--tests-paths null/);
  }
});

test('a malformed tests.keep fails before the command runs', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  for (const keep of ['Makefile', [null], [''], ['   ']]) {
    const r = await gate.run(ctx(sha, { project: { tests: { keep } } }));
    assert.equal(r.ok, false, JSON.stringify(keep));
    assert.match(r.summary, /tests\.keep must be an array of globs/);
    assert.match(r.summary, /--tests-keep/);
  }
  assertCleanedUp();
});

// Build files a change needs are kept at the head while the code reverts.
const MANIFESTS = {
  'package.json': '{"name":"fixture-task-head","private":true}\n',
  'package-lock.json': '{"name":"fixture-task-head","lockfileVersion":3}\n',
  'Cargo.toml': '[package]\nname = "fixture-task-head"\n',
  'Cargo.lock': '# fixture-task-head\nversion = 3\n',
  'go.mod': 'module example.com/fixture-task-head\n',
  'go.sum': 'example.com/fixture-task-head v0.1.0/go.mod h1:a=\n',
  'pyproject.toml': '[project]\nname = "fixture-task-head"\n',
  'requirements-dev.txt': '# fixture-task-head\n',
  'uv.lock': '# fixture-task-head\n',
  Makefile: '# fixture-task-head\n',
  'tools/build.gradle': '// fixture-task-head\n',
};
const KEEP = { tests: { keep: ['Makefile', 'tools/**/*.gradle'] } };
const verify = (files) => `${NODE} verify-build.js ${files.map(shellQuote).join(' ')}`;

test('prove keeps modified npm manifests and Cargo.lock, added manifests and tests.keep globs at the head', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST, ...MANIFESTS });
  const cmd = verify(Object.keys(MANIFESTS));
  const r = await gate.run(ctx(sha, { args: { cmd }, project: KEEP }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /with 1 non-test file reverted .*lib\/add\.js.*Build files kept at submitted sha .*: exit 1/);
  assert.doesNotMatch(r.summary, /stale build file/);
  for (const file of Object.keys(MANIFESTS)) assert.ok(r.summary.includes(file), `summary omitted kept build file ${file}`);
  assertCleanedUp();
});

test('a change of only tests and kept build files passes without a revert run, unless the head fails', async () => {
  const sha = task({ 'test/mul2.test.js': MUL_TEST, ...MANIFESTS });
  const cmd = verify(Object.keys(MANIFESTS));
  const r = await gate.run(ctx(sha, { args: { cmd }, project: KEEP }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /run-only \(test-only diff\)/);
  assert.match(r.summary, /no revert run/);
  assert.deepEqual(r.receipt.changed_files, [...Object.keys(MANIFESTS), 'test/mul2.test.js'].sort());
  for (const file of Object.keys(MANIFESTS)) assert.ok(r.summary.includes(file), file);
  const failing = task({ 'Cargo.lock': '# fixture-task-head\n', 'test/add.test.js': ADD_TEST });
  const f = await gate.run(ctx(failing, { args: { cmd: verify(['Cargo.lock']) } }));
  assert.equal(f.ok, false);
  assert.equal(f.receipt.mode, 'run-only (test-only diff)');
  assert.match(f.summary, /at [a-f0-9]+: exit 1/);
  assertCleanedUp();
});

test('code-like build files are reverted by default, and manifest-like test paths stay tests', async () => {
  const files = ['Makefile', 'setup.py', 'build.bzl', 'build.gradle', 'vite.config.js', 'flake.nix', 'app.csproj', 'value.lock'];
  const sha = task({
    ...Object.fromEntries(files.map((f) => [f, 'fixture-task-head build code\n'])),
    'test/build.test.js': `for (const f of ${JSON.stringify(files)}) require('assert').match(require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8'), /fixture-task-head/);\n`,
  });
  const r = await gate.run(ctx(sha));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /8 non-test files reverted .*: exit 1/);
  for (const file of files) assert.ok(r.summary.includes(file), file);
  assert.doesNotMatch(r.summary, /Build files kept/);

  const manifest = '{"name":"fixture-task-head","private":true}\n';
  const tested = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST, 'package.json': manifest, 'test/package.json': manifest });
  const t = await gate.run(ctx(tested, { args: { cmd: verify(['package.json', 'test/package.json']) }, project: { tests: { keep: ['test/**'] } } }));
  assert.equal(t.ok, true, t.summary);
  assert.match(t.summary, /Tests: test\/add\.test\.js, test\/package\.json/);
  const kept = [...t.summary.matchAll(/Build files kept at submitted sha [a-f0-9]+: ([^\n)]+)/g)];
  assert.ok(kept.length, t.summary);
  for (const [, list] of kept) assert.ok(list.includes('package.json') && !list.includes('test/package.json'), list);
  assertCleanedUp();
});

test('the tests policy decides how many times the suite runs', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const marker = path.join(tmp, 'suite-runs');
  const cmd = `${NODE} count-runs.js ${quote(marker)}`;
  const scoped = `${NODE} {tests}`;
  for (const [name, tests, runs] of [
    ['default prove', {}, 2],
    ['project run-only', { mode: 'run-only' }, 1],
    ['kind run-only overrides project none', { mode: 'none', by_kind: { code: 'run-only' } }, 1],
    ['kind prove overrides project run-only', { mode: 'run-only', by_kind: { code: 'prove' } }, 2],
    ['expensive prove', { expensive: true }, 1],
    ['non-expensive prove', { expensive: false }, 2],
    ['expensive kind prove', { mode: 'none', by_kind: { code: 'prove' }, expensive: true }, 1],
    ['project none', { mode: 'none' }, 0],
    ['kind none overrides project prove', { by_kind: { code: 'none' }, expensive: true }, 0],
  ]) {
    fs.rmSync(marker, { force: true });
    const r = await gate.run(ctx(sha, { args: { cmd }, project: { tests, gates: { tests_cmd: cmd, tests_proof_cmd: scoped } } }));
    assert.equal(r.ok, true, `${name}: ${r.summary}`);
    assert.equal(fs.existsSync(marker) ? readPublished(marker, 'utf8').trim().split('\n').length : 0, runs, name);
    if (runs === 0) assert.match(r.summary, /mode none/);
    if (tests.expensive && runs === 1) {
      assert.match(r.summary, /scoped proof/);
      assert.deepEqual(r.receipt.proof_tests, ['test/add.test.js']);
      assert.equal(r.receipt.head_mode, 'full');
    }
    assertCleanedUp();
  }
});

test('run-only accepts Rust inline tests in source files, and still fails a failing head', async () => {
  const inline = task({
    'src/lib.rs': 'pub fn value() -> i32 { 1 }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn returns_one() { assert_eq!(super::value(), 1); }\n}\n',
    'check-inline.js': "require('assert').match(require('fs').readFileSync('src/lib.rs', 'utf8'), /value\\(\\) -> i32 \\{ 1 \\}/);\n",
  });
  const cmd = `${NODE} check-inline.js`;
  const prove = await gate.run(ctx(inline, { args: { cmd } }));
  assert.equal(prove.ok, false);
  assert.match(prove.summary, /no test covers this change/);
  const r = await gate.run(ctx(inline, { args: { cmd }, project: { tests: { mode: 'run-only' } } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /mode run-only/);
  const failing = task({ 'lib/add.js': FIX, 'test/add.test.js': "require('assert').strictEqual(require('../lib/add')(1, 2), 4);\n" });
  const f = await gate.run(ctx(failing, { project: { tests: { mode: 'run-only' } } }));
  assert.equal(f.ok, false);
  assert.match(f.summary, /at [a-f0-9]+: exit 1/);
  assertCleanedUp();
});

test('none mode needs no command but still verifies the submitted sha; prove and run-only need one; malformed policy fails first', async () => {
  const sha = task({ 'README.md': '# none\n' });
  const byKind = { tests: { by_kind: { docs: 'none', ops: 'none' } }, gates: {} };
  for (const kind of ['docs', 'ops']) {
    const r = await gate.run(ctx(sha, { kind, args: { cmd: undefined }, project: byKind }));
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, new RegExp(`mode none.*tests.by_kind.${kind}`));
  }
  const missing = await gate.run(ctx('0123456789abcdef0123456789abcdef01234567', { kind: 'docs', args: { cmd: undefined }, project: byKind }));
  assert.match(missing.summary, /is not in/);
  for (const mode of ['prove', 'run-only']) {
    const r = await gate.run(ctx(sha, { args: { cmd: undefined }, project: { tests: { mode }, gates: {} } }));
    assert.equal(r.ok, false);
    assert.match(r.summary, /no test command pinned/);
    assert.deepEqual(r.config_failure, { key: 'tests_cmd' });
  }
  for (const [key, value] of [['mode', 'skip'], ['by_kind', { docs: null }], ['by_kind', { tooling: 'none' }], ['expensive', 'true']]) {
    const r = await gate.run(ctx(sha, { project: { tests: { mode: 'none', [key]: value } } }));
    assert.equal(r.ok, false);
    assert.ok(r.summary.includes(`project.json tests.${key}`), r.summary);
  }
  assertCleanedUp();
});

test('expensive prove needs a pinned scoped command that passes at head, fails after reverting and gets quoted test paths', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST, 'test/new value.test.js': ADD_TEST });
  const expensive = (proof) => ({ tests: { expensive: true }, gates: { tests_cmd: CMD, tests_proof_cmd: proof } });
  for (const proof of [null, `${NODE} test/add.test.js`]) {
    const r = await gate.run(ctx(sha, { project: expensive(proof) }));
    assert.equal(r.ok, false);
    assert.match(r.summary, /tests_proof_cmd.*\{tests\}/);
  }
  for (const [proof, message] of [
    [`${NODE} -e "process.exit(1)" {tests}`, /scoped proof.*at.*exit 1/],
    [`${NODE} -e "process.exit(0)" {tests}`, /tests pass without the change/],
  ]) {
    const r = await gate.run(ctx(sha, { project: expensive(proof) }));
    assert.equal(r.ok, false);
    assert.match(r.summary, message);
  }
  const r = await gate.run(ctx(sha, { project: expensive(`${NODE} proof.js {tests}`) }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /kept a scoped proof/);
  assertCleanedUp();
});

test('the gate command runs with TMPDIR under the gate temp root, and that directory is removed when the gate ends', async () => {
  // Records the temp directories it sees, then leaves a directory behind as a test helper might.
  const log = path.join(tmp, 'probe.log');
  const probe = path.join(tmp, 'probe.js');
  fs.writeFileSync(probe, `const fs = require('fs');
const os = require('os');
const path = require('path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir(), process.env.NODE_COMPILE_CACHE]) + '\\n');
fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-leftover-'));
`);
  // The test process's own temp directory is elsewhere, so a command that inherits it is caught.
  const inherited = path.join(tmp, 'inherited');
  fs.mkdirSync(inherited);
  const saved = process.env.TMPDIR;
  const savedCache = process.env.NODE_COMPILE_CACHE;
  process.env.TMPDIR = inherited;
  // A compile cache named by an absolute path is not moved by TMPDIR, so the gate must redirect it too.
  process.env.NODE_COMPILE_CACHE = path.join(inherited, 'compile-cache');
  try {
    const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
    const r = await gate.run(ctx(sha, { args: { cmd: `${NODE} ${quote(probe)}` }, project: { tests: { mode: 'run-only' } } }));
    assert.equal(r.ok, true, r.summary);
    const [seen] = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    for (const dir of seen) assert.ok(dir.startsWith(process.env.TOWER_CRANE_TMP + path.sep), dir);
    assert.equal(fs.existsSync(seen[0]), false, 'the gate removed its temp directory');
    assertCleanedUp();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    if (savedCache === undefined) delete process.env.NODE_COMPILE_CACHE;
    else process.env.NODE_COMPILE_CACHE = savedCache;
  }
});

test('a post-checkout hook makes no scratch in the caller temp root when the gate adds its worktree and restores files', async () => {
  // Git runs this hook for the gate's worktree add and its checkout, so it writes wherever their TMPDIR points.
  const inherited = path.join(tmp, 'inherited-hook');
  fs.mkdirSync(inherited);
  const hook = path.join(root, '.git', 'hooks', 'post-checkout');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = inherited;
  try {
    const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
    // Written after task(), whose own checkouts would otherwise fill the caller temp root.
    fs.writeFileSync(hook, `#!/bin/sh\n${NODE} -e "require('fs').mkdtempSync(require('path').join(process.env.TMPDIR || require('os').tmpdir(), 'tower-crane-hook-'))"\n`, { mode: 0o755 });
    const r = await gate.run(ctx(sha));
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(fs.readdirSync(inherited), []);
    assertCleanedUp();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(hook, { force: true });
  }
});

test('a gate whose scratch directory cannot be made removes the temp parent it already created', async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  // Fails the scratch directory inside the gate's parent, as a full disk would, after the parent exists.
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = function (dir, ...rest) {
    if (path.basename(dir) === 'tmp' && path.basename(path.dirname(dir)).startsWith('tower-crane-')) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return mkdirSync.call(this, dir, ...rest);
  };
  let r;
  try {
    r = await gate.run(ctx(sha));
  } finally {
    fs.mkdirSync = mkdirSync;
  }
  assert.equal(r.ok, false);
  assert.match(r.summary, /cannot create a temporary directory/);
  assertCleanedUp();
});
