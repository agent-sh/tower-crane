'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../../lib/gates/tests');
const { scratch, isolateGit, git, commit, initRepo, worktrees, quote } = require('./helpers');
const { shellQuote } = require('../../lib/gates/common');

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

const tmp = scratch('gates-tests');
isolateGit(tmp);
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

function ctx(sha, { kind = 'code', args = {}, project = {} } = {}) {
  return {
    root,
    worktree: null,
    task: { id: 'T1', kind, sha, status: 'submitted' },
    project: { repo: 'acme/app', base: 'main', gates: { tests_cmd: args.cmd ?? CMD }, ...project },
    args: { cmd: CMD, ...args },
    log() {},
  };
}

function assertCleanedUp() {
  assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP), []);
  assert.equal(worktrees(root), 1);
}

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
  assert.match(r.summary, /only test files/);
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
    assert.match(r.summary, /only test files/);
  } finally {
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
  }
});

test('a timeout stops the command and everything it started', { skip: process.platform === 'win32' }, async () => {
  const sha = task({ 'lib/add.js': FIX, 'test/add.test.js': ADD_TEST });
  const marker = path.join(tmp, 'late-write');
  // `; true` keeps the shell alive, so the writer is a grandchild, not the shell itself.
  const cmd = `${NODE} -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 3000)" ${quote(marker)}; true`;
  const started = Date.now();
  const r = await gate.run(ctx(sha, { args: { cmd, timeout: 0.01 } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /timed out/);
  assert.ok(Date.now() - started < 3000, 'the gate waited for the command instead of stopping it');
  await new Promise((resolve) => setTimeout(resolve, 4000 - (Date.now() - started)));
  assert.equal(fs.existsSync(marker), false, 'a process the command started outlived the timeout');
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
  assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP), []);
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
  assert.match(r.summary, /Tests: test\/mul2\.test\.js/);
  assert.match(r.summary, /only tests and kept build files/);
  assert.match(r.summary, /no non-test files to revert/);
  for (const file of Object.keys(MANIFESTS)) assert.ok(r.summary.includes(file), file);
  const failing = task({ 'Cargo.lock': '# fixture-task-head\n', 'test/add.test.js': ADD_TEST });
  const f = await gate.run(ctx(failing, { args: { cmd: verify(['Cargo.lock']) } }));
  assert.equal(f.ok, false);
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
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0, runs, name);
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
