'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, real, HOOKS } = require('./helpers');
const { waitFor } = require('./canary');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

// The gate variants run in process in test/gates/tests.test.js; these tests
// cover what the CLI adds: audited evidence, policy at accept and merge, and
// gate loading. Gate internals live in lib/gates/ and ship separately, so
// some tests run a copy of the CLI whose lib/gates/ holds only what each test
// puts there.
function cliCopy(h) {
  const dir = path.join(h.base, 'cli');
  const gatesDir = path.join(ROOT, 'lib', 'gates');
  fs.cpSync(path.join(ROOT, 'bin'), path.join(dir, 'bin'), { recursive: true });
  // The board view reads the package bin name from package.json when it renders the sketch.
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), {
    recursive: true,
    filter: (src) => src !== gatesDir && !src.startsWith(gatesDir + path.sep),
  });
  fs.mkdirSync(path.join(dir, 'lib', 'gates'));
  fs.copyFileSync(path.join(gatesDir, 'common.js'), path.join(dir, 'lib', 'gates', 'common.js'));
  const bin = path.join(dir, 'bin', 'tower-crane.js');
  return {
    gates: path.join(dir, 'lib', 'gates'),
    run: (args, env = {}) => {
      const r = cp.spawnSync(process.execPath, [bin, ...args], { cwd: h.repo, env: { ...h.env, ...env }, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    // Starts without waiting, so a test can pause the command with a hook.
    start: (args, env = {}) => {
      const p = cp.spawn(process.execPath, ['--require', HOOKS, bin, ...args], {
        cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      return { result: new Promise((resolve) => p.on('close', (code) => resolve({ code, stderr }))) };
    },
  };
}

const FAKE_GATE = `'use strict';
const fs = require('node:fs');
module.exports = {
  async run(ctx) {
    fs.writeFileSync(process.env.GATE_OUT, JSON.stringify({ root: ctx.root, worktree: ctx.worktree, task: ctx.task.id, sha: ctx.task.sha, args: ctx.args, base: ctx.project.base }));
    ctx.log('fake gate ran');
    return { ok: process.env.GATE_OK === '1', summary: 'fake gate', ref: 'run-1', sha: process.env.GATE_SHA || undefined };
  },
};
`;

function submittedTask(h) {
  h.init();
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'w-1']);
}

const VERIFY_BUILD = `const fs = require('node:fs');
const path = require('node:path');
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(path.join(__dirname, file))) {
    console.error('missing build file: ' + file);
    process.exit(2);
  }
  if (!fs.readFileSync(path.join(__dirname, file), 'utf8').includes('fixture-task-head')) {
    console.error('stale build file: ' + file);
    process.exit(2);
  }
}
try {
  require('./test/value.test.js');
  console.log('ok value.test.js');
} catch (error) {
  console.error('not ok value.test.js: ' + error.message);
  process.exitCode = 1;
}
`;

function writeFiles(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

function manifestTask(h, { base = {}, submitted, codeChange = true }) {
  writeFiles(h.repo, {
    'value.js': 'module.exports = 0;\n',
    'verify-build.js': VERIFY_BUILD,
    'test/value.test.js': "require('node:assert/strict').equal(require('../value'), 0);\n",
    ...base,
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'fixture base']);
  h.git(['switch', '-qc', 'fixture-change']);
  writeFiles(h.repo, {
    ...(codeChange ? { 'value.js': 'module.exports = 1;\n' } : {}),
    'test/value.test.js': `require('node:assert/strict').equal(require('../value'), ${codeChange ? 1 : 0}, 'fixture regression');\n`,
    ...submitted,
  });
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'fixture change and build files']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  return sha;
}

function submitTestsFixture(h, sha, keep, settings = []) {
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-cmd', `${shellQuote(process.execPath)} verify-build.js`, ...settings]);
  if (keep) h.ok(['project', 'set', '--tests-keep', JSON.stringify(keep)]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'test the behavior']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--agent', 'w-1']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
}

test('failed tests evidence records TAP and spec names with a bounded output tail', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {
    'test/failure.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
test('named regression failure', () => {
  console.log('${'noise line '.repeat(1500)} tail marker');
  assert.equal('actual', 'expected');
});
`,
  } });
  submitTestsFixture(h, sha);
  for (const key of Object.keys(h.env)) {
    if (key.startsWith('NODE_TEST_')) delete h.env[key];
  }

  for (const reporter of ['tap', 'spec']) {
    const cmd = `${shellQuote(process.execPath)} --test --test-reporter=${reporter} test/failure.test.js`;
    h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
    const result = h.run(['check', 'tests', 'T1', '--agent', 'checker']);
    assert.equal(result.code, 1, result.stdout + result.stderr);

    const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(evidence.ok, false);
    assert.ok(evidence.test_failure.names.some((name) => name.includes('named regression failure')));
    assert.ok(evidence.test_failure.output_tail.includes('tail marker'));
    assert.ok(evidence.test_failure.output_tail.length <= 8192);
    assert.ok(evidence.test_failure.output_tail.length > 8000);
    assert.match(evidence.summary, /Failing tests:/);
    assert.match(evidence.summary, /Output tail \(last 40 lines, max 8192 characters\):/);
    assert.match(result.stdout, /named regression failure/);
    assert.match(result.stdout, /tail marker/);

    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.at(-1).detail.test_failure, evidence.test_failure);
  }
});

test('failed tests evidence names the failing tests when the spec reporter is colored', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {
    'test/failure.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
test('colored regression failure', () => {
  assert.equal('actual', 'expected');
});
`,
  } });
  submitTestsFixture(h, sha);
  for (const key of Object.keys(h.env)) {
    if (key.startsWith('NODE_TEST_')) delete h.env[key];
  }
  const cmd = `${shellQuote(process.execPath)} --test --test-reporter=spec test/failure.test.js`;
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
  const result = h.run(['check', 'tests', 'T1', '--agent', 'checker'], { env: { FORCE_COLOR: '1' } });
  assert.equal(result.code, 1, result.stdout + result.stderr);

  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(evidence.test_failure.names.length, 1);
  assert.match(evidence.test_failure.names[0], /^colored regression failure \(/);
  assert.match(evidence.summary, /Failing tests:\n- colored regression failure \(/);
  assert.equal(evidence.test_failure.output_tail.includes('\u001b'), false);
  assert.match(result.stdout, /colored regression failure/);
});

test('failed test diagnostics redact process, project, rung and env_file secrets everywhere', (t) => {
  const h = makeRepo(t);
  const token = (...parts) => parts.join('');
  const chars = (...codes) => String.fromCharCode(...codes);
  const canaries = {
    process: token(chars(103, 104, 112, 95), 'T83ProcessCanary0123456789abcdef123456'),
    project: token(chars(115, 107, 45, 112, 114, 111, 106, 45), 'T83ProjectCanary0123456789abcdef123456'),
    projectFile: token(chars(120, 111, 120, 98, 45), 'T83ProjectFileCanary-0123456789abcdef'),
    rung: token(chars(65, 75, 73, 65), '1234567890ABCDEF'),
    rungFile: '0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const commonTokens = [
    token(chars(103, 104, 111, 95), 'T83GenericCanary0123456789abcdef'),
    token(chars(115, 107, 45), 'T83GenericSecret0123456789abcdef'),
    token(chars(65, 75, 73, 65), 'ABCDEFGHIJKLMNOP'),
    token(chars(120, 111, 120, 112, 45), 'T83GenericSlack-0123456789abcdef'),
    token('Authorization: Bearer ', 'T83GenericAuth0123456789abcdef'),
  ];
  const projectEnvFile = path.join(h.base, 'project.env');
  const rungEnvFile = path.join(h.base, 'rung.env');
  fs.writeFileSync(projectEnvFile, `T83_PROJECT_FILE_CANARY=${canaries.projectFile}\n`);
  fs.writeFileSync(rungEnvFile, `T83_RUNG_FILE_TOKEN=${canaries.rungFile}\n`);
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  const defaultEasy = require('../lib/ladder').resolve({}, h.env).ladder.easy.own;
  fs.writeFileSync(h.userConfig, JSON.stringify({
    ladder: { easy: {
      ...defaultEasy,
      env: { T83_RUNG_CANARY: canaries.rung },
      env_file: rungEnvFile,
    } },
  }));

  const literals = [canaries.project, canaries.projectFile, canaries.rung, canaries.rungFile, ...commonTokens];
  const testFile = `const test = require('node:test');
const assert = require('node:assert/strict');
const report = [process.env.T83_PROCESS_TOKEN, ${literals.map((value) => JSON.stringify(value)).join(', ')}].join(' ');
test('failure ' + process.env.T83_PROCESS_TOKEN, () => {
  console.log(report);
  assert.fail('fixture failure');
});
`;
  const sha = manifestTask(h, { submitted: { 'test/failure.test.js': testFile } });
  submitTestsFixture(h, sha, null, [
    '--env', JSON.stringify({ T83_PROJECT_CANARY: canaries.project }),
    '--env_file', projectEnvFile,
  ]);
  for (const key of Object.keys(h.env)) {
    if (key.startsWith('NODE_TEST_')) delete h.env[key];
  }

  const cmd = `${shellQuote(process.execPath)} --test --test-reporter=tap test/failure.test.js`;
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
  const result = h.run(['check', 'tests', 'T1', '--agent', 'checker', '--json'], {
    env: { T83_PROCESS_TOKEN: canaries.process },
  });
  assert.equal(result.code, 1, result.stderr + result.stdout);

  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.ok(evidence.test_failure.names.some((name) => name.includes('[redacted:T83_PROCESS_TOKEN]')));
  assert.ok(evidence.test_failure.output_tail.includes('[redacted:T83_PROCESS_TOKEN]'));
  assert.ok(evidence.summary.includes('[redacted:T83_PROCESS_TOKEN]'));
  assert.match(evidence.test_failure.output_tail, /\[redacted:T83_PROJECT_CANARY\]/);
  assert.match(evidence.test_failure.output_tail, /\[redacted:T83_PROJECT_FILE_CANARY\]/);
  assert.match(evidence.test_failure.output_tail, /\[redacted:T83_RUNG_CANARY\]/);
  assert.match(evidence.test_failure.output_tail, /\[redacted:T83_RUNG_FILE_TOKEN\]/);
  for (const label of ['GITHUB_TOKEN', 'API_KEY', 'AWS_ACCESS_KEY_ID', 'SLACK_TOKEN', 'AUTHORIZATION']) {
    assert.ok(evidence.test_failure.output_tail.includes(`[redacted:${label}]`), label);
  }

  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const taskText = h.ok(['task', 'show', 'T1']);
  const taskJson = JSON.stringify(h.json(['task', 'show', 'T1']));
  const output = [result.stdout, result.stderr, JSON.stringify(evidence), events, taskText, taskJson].join('\n');
  for (const secret of [...Object.values(canaries), ...commonTokens]) {
    assert.equal(output.includes(secret), false, `raw canary leaked: ${secret}`);
  }
});

test('paths, long file names, commit SHAs and ordinary env values survive a failed test run', (t) => {
  const h = makeRepo(t);
  const file = 'test/T83-long-file-name-kept-intact-for-diagnostics.test.js';
  const fullSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const worktree = '/home/builder/worktrees/T83-gate-command-errors-name-the-real-cause/checkout';
  const literals = [file, fullSha, worktree].map((value) => JSON.stringify(value)).join(', ');
  const testFile = `const test = require('node:test');
const assert = require('node:assert/strict');
test('NODE_ENV is ' + process.env.NODE_ENV, () => {
  console.log([${literals}, process.env.NODE_ENV, process.env.CI, process.env.LOG_LEVEL].join(' '));
  assert.fail('fixture failure');
});
`;
  const sha = manifestTask(h, { submitted: { [file]: testFile } });
  submitTestsFixture(h, sha, null, ['--env', JSON.stringify({ NODE_ENV: 'test' })]);
  for (const key of Object.keys(h.env)) {
    if (key.startsWith('NODE_TEST_')) delete h.env[key];
  }

  const cmd = `${shellQuote(process.execPath)} --test --test-reporter=tap ${shellQuote(file)}`;
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
  const result = h.run(['check', 'tests', 'T1', '--agent', 'checker'], {
    env: { NODE_ENV: 'test', CI: 'true', LOG_LEVEL: 'debug' },
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);

  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(evidence.test_failure.names.length, 1);
  assert.match(evidence.test_failure.names[0], /^NODE_ENV is test\b/);
  const output = evidence.test_failure.output_tail;
  assert.ok(output.includes(file), 'the test file name stays whole');
  assert.ok(output.includes(fullSha), 'the commit SHA stays whole');
  assert.ok(output.includes(worktree), 'the worktree path stays whole');
  assert.match(output, / test true debug/);
  assert.equal(output.includes('[redacted:'), false, output);
});

test('credential-named variables with numeric, boolean or short values leave the output intact', (t) => {
  const h = makeRepo(t);
  const testFile = `const test = require('node:test');
const assert = require('node:assert/strict');
test('budget ' + process.env.MAX_THINKING_TOKENS, () => {
  console.log(['test/a.test.js:12:3', 'ok: true', process.env.MAX_THINKING_TOKENS, process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, process.env.X_COOKIE_ENABLED].join(' '));
  assert.fail('fixture failure');
});
`;
  const sha = manifestTask(h, { submitted: { 'test/a.test.js': testFile } });
  submitTestsFixture(h, sha);
  for (const key of Object.keys(h.env)) {
    if (key.startsWith('NODE_TEST_')) delete h.env[key];
  }

  const cmd = `${shellQuote(process.execPath)} --test --test-reporter=tap test/a.test.js`;
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', cmd]);
  const result = h.run(['check', 'tests', 'T1', '--agent', 'checker'], {
    env: { MAX_THINKING_TOKENS: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', X_COOKIE_ENABLED: 'true' },
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);

  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.deepEqual(evidence.test_failure.names, ['budget 1']);
  assert.match(evidence.test_failure.output_tail, /not ok 1 - budget 1/);
  assert.match(evidence.test_failure.output_tail, /test\/a\.test\.js:12:3 ok: true 1 32000 true/);
  assert.equal(evidence.test_failure.output_tail.includes('[redacted:'), false, evidence.test_failure.output_tail);
  assert.match(result.stdout, /budget 1/);
  assert.equal(result.stdout.includes('[redacted:'), false, result.stdout);
});

test('a token that straddles the output tail cut is redacted, not kept as a fragment', (t) => {
  const h = makeRepo(t);
  const body = 'T83BoundaryBody0123456789';
  // After the marker the tail keeps 8167 characters of this one line, so the cut falls right after
  // the "sk-" prefix. Spaces keep the body out of any longer run.
  const line = `${' '.repeat(100)}sk-${body}${' '.repeat(8166 - body.length)}!`;
  const sha = manifestTask(h, { submitted: {
    'print-leak.js': `process.stdout.write(${JSON.stringify(line)});\nprocess.exit(1);\n`,
  } });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', `${shellQuote(process.execPath)} print-leak.js`]);
  const result = h.run(['check', 'tests', 'T1', '--agent', 'checker']);
  assert.equal(result.code, 1, result.stdout + result.stderr);

  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.match(evidence.test_failure.output_tail, /\[redacted:API_KEY\]/);
  assert.ok(evidence.test_failure.output_tail.length <= 8192);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const output = [result.stdout, result.stderr, JSON.stringify(evidence), events, h.ok(['task', 'show', 'T1'])].join('\n');
  assert.equal(output.includes(body), false, 'the token body leaked past the output tail cut');
});

test('tests evidence stores its mode in the audit event and stops counting when the policy changes', (t) => {
  const h = makeRepo(t);
  const sha = manifestTask(h, { submitted: {} });
  submitTestsFixture(h, sha);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  const skipped = h.json(['check', 'tests', 'T1']);
  assert.equal(skipped.tests_mode, 'none');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).detail.tests_mode, 'none');
  const testsGate = () => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests');
  assert.equal(testsGate().ok, true);
  h.ok(['project', 'set', '--tests-by-kind', '{"code":"prove"}']);
  assert.equal(testsGate().ok, false);
  assert.match(testsGate().reason, /mode.*none.*prove/);
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /tests:.*mode none.*prove/);
  const proof = h.json(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  assert.equal(proof.tests_mode, 'prove');
  assert.equal(testsGate().ok, true);
  h.ok(['project', 'set', '--tests-by-kind', '{"code":"run-only"}']);
  assert.equal(testsGate().ok, false);
  const run = h.json(['check', 'tests', 'T1', '--cmd', `${shellQuote(process.execPath)} verify-build.js`]);
  assert.equal(run.tests_mode, 'run-only');
  assert.equal(testsGate().ok, true);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].evidence.at(-1).tests_mode = 'none';
  h.writeState('tasks.json', tasks);
  assert.equal(testsGate().ok, false, 'a mode edited without its matching audit event is untrusted');
  delete tasks.tasks[0].evidence.at(-1).tests_mode;
  h.writeState('tasks.json', tasks);
  const audit = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  delete audit.findLast((e) => e.cmd === 'check tests').detail.tests_mode;
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), audit.map(JSON.stringify).join('\n') + '\n');
  assert.equal(testsGate().ok, false);
  assert.match(testsGate().reason, /mode unrecorded/);
});

test('acceptance and merge refuse a mode change after an audited tests pass', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.ok(['check', 'tests', 'T1', '--agent', 'checker']);
  gateEvidence(h, 'clean', 'checker');
  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const accept = h.run(['accept', 'T1']);
  assert.equal(accept.code, 1);
  assert.match(accept.stderr, /tests:.*mode none.*prove/);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.ok(['accept', 'T1']);
  h.ok(['project', 'set', '--tests-mode', 'prove']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');
  const merge = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /its gates no longer pass: tests:.*mode none.*prove/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
});

test('gate commands exit 1 when the gate module is not installed', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const cli = cliCopy(h);
  for (const args of [['check', 'tests', 'T1', '--cmd', 'npm test'], ['check', 'clean', 'T1'], ['check', 'ci', 'T1'], ['merge', 'T1']]) {
    const r = cli.run(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /gate not installed/);
  }
  assert.equal(cli.run(['check', 'tests', 'T1']).code, 1, 'missing modules fail before policy checks');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
});

test('a gate gets its context and its result is recorded as evidence', (t) => {
  const h = makeRepo(t);
  submittedTask(h);
  const wt = h.json(['worktree', 'T1']).path;
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  for (const g of ['tests', 'ci', 'merge']) fs.writeFileSync(path.join(cli.gates, `${g}.js`), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  const pass = cli.run(['check', 'tests', 'T1', '--cmd', 'npm test', '--agent', 'checker', '--json'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(pass.code, 0, pass.stderr);
  assert.match(pass.stderr, /\[tests\] fake gate ran/);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(real(seen.root), real(h.repo));
  assert.equal(real(seen.worktree), real(wt));
  assert.deepEqual([seen.task, seen.sha, seen.args.cmd, seen.base], ['T1', 'abcdef1', 'npm test', 'main']);
  const recorded = JSON.parse(pass.stdout);
  assert.deepEqual([recorded.type, recorded.ok, recorded.agent, recorded.sha, recorded.ref, recorded.revision], ['tests', true, 'checker', 'abcdef1', 'run-1', 1]);

  const fail = cli.run(['check', 'ci', 'T1', '--agent', 'checker'], { GATE_OUT: out, GATE_OK: '0', GATE_SHA: 'ABCDEF1234567' });
  assert.equal(fail.code, 1);
  assert.match(fail.stdout, /ci FAIL at abcdef1: fake gate/);
  const ev = h.readState('tasks.json').tasks[0].evidence;
  assert.deepEqual(ev.map((e) => [e.type, e.ok, e.sha]), [['tests', true, 'abcdef1'], ['ci', false, 'abcdef1234567']]);

  const merge = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /T1 is submitted; merge needs an accepted task/);
});

test('merge refuses a task of any kind whose PR has no passing ci at the submitted sha', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.init();
  h.ok(['project', 'set', '--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '9', '--agent', 'w-1']);
  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  gateEvidence(h, 'ci', 'ci');
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // A later failed run must stop a merge even after acceptance.
  gateEvidence(h, 'ci', 'ci', false);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /its gates no longer pass: ci: latest ci at .* failed:/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
});

test('merge checks the gates as they stand, not only the accepted status', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);
  const out = path.join(h.base, 'gate.json');

  // A later failed run must stop a merge even after acceptance.
  gateEvidence(h, 'tests', 'checker', false);
  const refused = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /T1 is accepted, but its gates no longer pass: tests: latest tests at .* failed:/);
  assert.ok(!fs.existsSync(out), 'the merge gate did not run');
  assert.ok(!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'));

  gateEvidence(h, 'tests', 'checker');
  const merged = cli.run(['merge', 'T1'], { GATE_OUT: out, GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(out), 'with the gates passing again, the merge gate runs');
});

function readEvents(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

// An accepted task whose worktree the CLI made; merge is the only step left.
function acceptedWithWorktree(h) {
  const sha = gateFixture(h);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const wt = h.json(['worktree', 'T1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  return wt;
}

test('merge removes the merged task worktree and records it', (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(!fs.existsSync(wt.path), 'the worktree directory is gone');
  assert.ok(!h.registers(wt.path), 'git no longer registers it');
  const removed = readEvents(h).find((e) => e.cmd === 'worktree removed');
  assert.equal(removed.task, 'T1');
  assert.equal(removed.detail.removed, true);
});

test('merge keeps a worktree with uncommitted changes and says why', (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'unfinished\n');
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.equal(fs.readFileSync(path.join(wt.path, 'notes.txt'), 'utf8'), 'unfinished\n');
  assert.ok(h.registers(wt.path), 'git still registers it');
  const kept = readEvents(h).find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'uncommitted changes');
});

test('merge keeps the worktree while merge.keep_branch is set', (t) => {
  const h = makeRepo(t);
  h.init(['--merge-keep-branch', 'true']);
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  const merged = cli.run(['merge', 'T1'], { GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1' });
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(wt.path), 'the worktree stays for its branch');
  const kept = readEvents(h).find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.detail.reason, 'merge.keep_branch is set');
});

test('a task sent back and claimed after merge looked at its worktree keeps the worktree', async (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  // Merge pauses after its first look at the worktree and before it removes anything.
  const paused = path.join(h.base, 'paused');
  const merge = cli.start(['merge', 'T1'], {
    GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1', HOOK_STOP_WORKTREE_STATUS: paused,
  });
  assert.ok(await waitFor(paused), 'merge reached its first look at the worktree');
  const sent = await h.runAsync(['rework', 'T1', '--reason', 'racing the merge']);
  const claimed = await h.runAsync(['claim', 'T1', '--agent', 'w-2']);
  fs.writeFileSync(`${paused}.go`, '');
  const merged = await merge.result;

  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(claimed.code, 0, claimed.stderr);
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(fs.existsSync(wt.path), 'the worktree of the claimed task stays');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'in_progress');
  const kept = readEvents(h).find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'the task changed before its worktree was removed');
});

test('a merge of an older head keeps the worktree of a newer accepted head', async (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  const merged = h.readState('tasks.json').tasks[0].sha;
  // The worktree starts from the submitted head, so a commit on top of it passes the same gates.
  h.git(['merge', '--ff-only', '-q', merged], wt.path);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  // The merge of the first head pauses before its first look at the worktree.
  const paused = path.join(h.base, 'paused');
  const merge = cli.start(['merge', 'T1'], {
    GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1', HOOK_STOP_WORKTREE_STATUS: paused,
  });
  assert.ok(await waitFor(paused), 'merge reached its first look at the worktree');
  h.ok(['rework', 'T1', '--reason', 'newer head']);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  h.git(['commit', '-q', '--allow-empty', '-m', 'newer head'], wt.path);
  const newer = h.git(['rev-parse', 'HEAD'], wt.path);
  h.ok(['submit', 'T1', '--sha', newer, '--agent', 'w-2']);
  for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  h.reviewer('T1', 'r-1', newer);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', newer, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  fs.writeFileSync(`${paused}.go`, '');
  const result = await merge.result;

  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(wt.path), 'the worktree of the newer head stays');
  assert.ok(h.registers(wt.path), 'git still registers it');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.equal(task.sha, newer);
  assert.equal(task.retiring, undefined, 'the marker is cleared once the merge ends');
  const events = readEvents(h);
  assert.ok(!events.some((e) => e.cmd === 'worktree removed'), 'nothing was removed');
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'the task changed before its worktree was removed');
});

test('merge refuses rework and claim while it removes the task worktree', async (t) => {
  const h = makeRepo(t);
  h.init();
  const wt = acceptedWithWorktree(h);
  const cli = cliCopy(h);
  fs.mkdirSync(cli.gates, { recursive: true });
  fs.writeFileSync(path.join(cli.gates, 'merge.js'), FAKE_GATE);

  // Merge pauses after its locked check of the worktree, with the lock released and before git removes it.
  const paused = path.join(h.base, 'paused');
  const merge = cli.start(['merge', 'T1'], {
    GATE_OUT: path.join(h.base, 'gate.json'), GATE_OK: '1', HOOK_STOP_WORKTREE_REMOVE: paused,
  });
  assert.ok(await waitFor(paused), 'merge reached git worktree remove');
  const sent = await h.runAsync(['rework', 'T1', '--reason', 'racing the removal']);
  const claimed = await h.runAsync(['claim', 'T1', '--agent', 'w-2']);
  fs.writeFileSync(`${paused}.go`, '');
  const merged = await merge.result;

  assert.equal(sent.code, 1, 'rework refuses a worktree being removed');
  assert.match(sent.stderr, /being removed/);
  assert.equal(claimed.code, 1, 'claim refuses it too');
  assert.match(claimed.stderr, /being removed/);
  assert.equal(merged.code, 0, merged.stderr);
  assert.ok(!fs.existsSync(wt.path), 'the removal finishes for the accepted task');
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.equal(task.retiring, undefined, 'the marker is cleared once the removal ends');
  assert.equal(readEvents(h).find((e) => e.cmd === 'worktree removed').task, 'T1');

  // A marker whose process has exited is what a crash leaves; it holds nothing.
  const state = h.readState('tasks.json');
  state.tasks[0].retiring = { since: new Date().toISOString(), pid: 999999, host: os.hostname() };
  h.writeState('tasks.json', state);
  h.ok(['rework', 'T1', '--reason', 'after a crash']);
});
