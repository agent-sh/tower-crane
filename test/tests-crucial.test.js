'use strict';

// Crucial mode (tests.crucial with tests.expensive and tests.map): a task's tests gate runs the
// crucial files, its changed tests and the suites coverage maps to its changed files, never the
// full suite, and a changed file no entry covers must run under the task's own tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, cachedFixture, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');
const { gateFixture } = require('./gate-helpers');
const { nativeCrashTest } = require('./gates/helpers');

const runner = `node ${shellQuote(path.join(ROOT, 'test/run.js'))}`;
const fullCommand = `${runner} test/*.test.js`;
const crucial = ['test/crucial.test.js'];
const map = { 'value.js': ['test/mapped.test.js'], 'other.js': ['test/other.test.js'], '**/*.md': [] };
const selected = (files) => `${runner} ${files.map(shellQuote).join(' ')}`;

// main holds other.js and three suites; the task changes value.js (with test/value.test.js, which
// requires it) and README.md. valueTest, when given, replaces the task's test in a new commit.
function fixture(t, settings = map, valueTest) {
  const h = cachedFixture(t, 'tests-crucial-base', (h) => {
    delete h.env.NODE_TEST_CONTEXT;
    h.init();
    gateFixture(h);
    h.git(['switch', 'main']);
    fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
    for (const name of ['mapped', 'crucial', 'other']) fs.writeFileSync(path.join(h.repo, `test/${name}.test.js`), `console.log('${name} suite');\n`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'suites']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', 'main']);
    fs.writeFileSync(path.join(h.repo, 'README.md'), 'Changed documentation.\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'submitted change']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
  delete h.env.NODE_TEST_CONTEXT;
  let sha = h.sha;
  if (valueTest !== undefined) {
    fs.writeFileSync(path.join(h.repo, 'test/value.test.js'), valueTest);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'another test']);
    sha = h.git(['rev-parse', 'HEAD']);
  }
  // No PR and no ci.required: crucial mode needs no hosted full-suite job.
  h.ok(['project', 'set', '--tests-expensive', 'true', '--tests-map', JSON.stringify(settings), '--tests-crucial', JSON.stringify(crucial),
    '--tests-cmd', fullCommand, '--tests-proof-cmd', `${runner} {tests}`]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  return h;
}

function check(h, code = 0) {
  const result = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
  assert.equal(result.code, code, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

const counts = (h) => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok;

test('with tests.crucial and a map pinned, a change runs crucial plus the suites covering it and never the full suite', (t) => {
  const h = fixture(t);
  assert.match(h.ok(['project', 'show']), /tests\.crucial: \["test\/crucial\.test\.js"\]/);
  const result = check(h);
  const runs = result.commands.filter((c) => c.command !== 'git');
  const head = ['test/crucial.test.js', 'test/mapped.test.js', 'test/value.test.js'];
  assert.equal(result.receipt.head_mode, 'crucial');
  assert.deepEqual(result.receipt.head_tests, head);
  assert.deepEqual(result.receipt.proof_tests, ['test/value.test.js']);
  assert.equal(result.receipt.coverage_gaps, undefined);
  // The scoped proof runs beside the head and may finish first; the reverted proof runs alone, last.
  assert.deepEqual(runs.slice(0, 2).map((c) => [c.command, c.status === 0]).sort(), [[selected(head), true], [selected(['test/value.test.js']), true]].sort(),
    'head and scoped proof pass');
  assert.deepEqual([runs[2].command, runs[2].status === 0], [selected(['test/value.test.js']), false], 'the reverted proof fails');
  assert.match(result.summary, /Scoped proof at \w+: `.*test\/value\.test\.js`: exit 0, beside the head in a worktree of its own/);
  assert.ok(runs.every((c) => c.command !== fullCommand && !c.command.includes('other.test.js')));
  assert.match(result.summary, /Head suite mode crucial: tests\.crucial plus the changed tests and the tests\.map suites covering the change/);
  assert.equal(counts(h), true);
  // The map changes after every daily run; the receipt names what it ran, so it still counts.
  h.ok(['project', 'set', '--tests-map', JSON.stringify({ ...map, 'value.js': ['test/other.test.js'] })]);
  assert.equal(counts(h), true);
  // A changed crucial list does not.
  h.ok(['project', 'set', '--tests-crucial', '["test/other.test.js"]']);
  assert.equal(counts(h), false);
  // Without tests.crucial the project selects as before: a task without a PR runs the full head suite.
  h.ok(['project', 'set', '--tests-crucial', 'null', '--tests-map', JSON.stringify(map)]);
  const today = check(h);
  assert.equal(today.receipt.head_mode, 'full');
  assert.match(today.receipt.head_reason, /no PR/);
  // The scoped proof runs beside the head, so either can come first.
  assert.deepEqual(today.commands.filter((c) => c.command !== 'git' && c.command !== selected(['test/value.test.js'])).map((c) => c.command), [fullCommand]);
  assert.equal(counts(h), true);
});

// With the scoped proof beside the head, a change whose test also passes at the base still fails the gate.
test('in crucial mode a changed test that passes without the change does not prove it', (t) => {
  const h = fixture(t, map, "console.log('asserts nothing');\n");
  const result = check(h, 1);
  assert.equal(result.ok, false);
  assert.match(result.summary, /tests pass without the change; they do not prove it\./);
  assert.match(result.summary, /beside the head in a worktree of its own\n2\. `.*test\/value\.test\.js` with 2 non-test files reverted to \w+ .*: exit 0/);
  assert.deepEqual(result.commands.filter((c) => c.command !== 'git').map((c) => c.status), [0, 0, 0]);
  assert.equal(counts(h), false);
});

test('a crucial file missing at head is the orchestrator\'s setting to fix, not the task\'s', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--tests-crucial', '["test/missing.test.js"]']);
  const result = check(h, 1);
  assert.deepEqual(result.config_failure, { key: 'tests_crucial' });
  assert.match(result.summary, /tests\.crucial names paths that are not test files at head: test\/missing\.test\.js/);
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 0, 'nothing runs');
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.setting, 'tests.crucial');
  assert.deepEqual(item.action.argv, ['project', 'set', '--tests-crucial', '<JSON>']);
});

for (const [name, settings, valueTest, ok, pattern] of [
  ['the task\'s test runs the file no entry covers', { '**/*.md': [] }, undefined, true,
    /Scoped proof at \w+ under coverage: .*: exit 0\. Coverage: the changed tests ran value\.js, which no tests\.map entry covers\./],
  ['the mapped suite is gone at head and the task\'s test runs the file', { 'value.js': ['test/gone.test.js'], '**/*.md': [] }, undefined, true,
    /Coverage: the changed tests ran value\.js/],
  ['the task\'s test does not run the file no entry covers', { '**/*.md': [] }, "console.log('value is not loaded');\n", false,
    /coverage gap: no tests\.map entry covers value\.js, and the task's changed tests \(test\/value\.test\.js\) do not run it\./],
  ['a documentation file has no entry', { 'value.js': ['test/mapped.test.js'] }, undefined, false,
    /coverage gap: no tests\.map entry covers README\.md, .*needs a declared entry instead: the orchestrator adds it with tower-crane project set --tests-map\./],
]) {
  test(`a changed file without a map entry: ${name}`, (t) => {
    const h = fixture(t, settings, valueTest);
    const result = check(h, ok ? 0 : 1);
    assert.equal(result.ok, ok, result.summary);
    assert.match(result.summary, pattern);
    assert.equal(result.receipt.head_mode, 'crucial');
    assert.ok(result.commands.every((c) => c.command !== fullCommand), 'no full suite runs');
    if (ok) {
      assert.deepEqual(result.receipt.coverage_gaps, ['value.js']);
      assert.equal(counts(h), true, 'the coverage run is the pinned proof expansion');
    } else {
      assert.equal(result.worker_failure, true);
      assert.equal(result.confirmed_failure, undefined);
    }
    if (settings['value.js']?.[0] === 'test/gone.test.js') assert.deepEqual(result.receipt.mapped_missing, ['test/gone.test.js']);
  });
}

// The coverage run expands the proof template on the changed tests, so a native crash it reruns is
// recorded as the proof step, never as the head command.
test('a native crash in the coverage run is rerun as the proof step', { skip: process.platform === 'win32' && 'POSIX signals' }, (t) => {
  const marker = path.join(fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || require('node:os').tmpdir(), 'crucial-crash-')), 'runs');
  t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));
  const crashOnce = `require('node:assert/strict').equal(require('../value'), 1);
if (process.env.NODE_V8_COVERAGE) {
${nativeCrashTest({ marker })}}
`;
  const h = fixture(t, { '**/*.md': [] }, crashOnce);
  const result = check(h);
  assert.equal(result.ok, true, result.summary);
  assert.deepEqual(result.receipt.coverage_gaps, ['value.js']);
  assert.deepEqual(result.receipt.native_rerun, { step: 'proof', files: ['test/value.test.js'], ok: true });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx', 'only the coverage run and its rerun reach the crash');
  assert.equal(counts(h), true);
});

// The import-derived seed (tools/tests-map.js) missed code a test reaches only through the CLI it
// spawns or loads by name: T427's reviewer planted a bug in lib/gates/merge.js that every
// import-mapped suite passed.
test('the coverage map links a file only a spawned CLI loads, by name, to the test that spawns it; refresh pins it', (t) => {
  const h = makeRepo(t);
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
    fs.writeFileSync(path.join(h.repo, file), text);
  };
  write('lib/merge.js', "module.exports = () => 'merged';\n");
  write('lib/unused.js', 'module.exports = 0;\n');
  write('tool/runner.js', "console.log(require(require('node:path').join(__dirname, '..', 'lib', process.argv[2]))());\n");
  write('test/cli.test.js', `const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
test('merges', () => {
  assert.equal(cp.execFileSync(process.execPath, ['tool/runner.js', 'merge'], { encoding: 'utf8' }).trim(), 'merged');
});
`);
  write('test/other.test.js', "require('node:test')('other', () => {});\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'cli fixture']);
  const head = h.git(['rev-parse', 'HEAD']);
  const dir = path.join(h.base, 'coverage');
  const built = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'tests-coverage-map.js'), 'run', '--dir', dir, '--',
    process.execPath, '--test', 'test/cli.test.js', 'test/other.test.js'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const file = path.join(dir, 'tests-coverage-map.json');
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(artifact.sha, head);
  assert.deepEqual(artifact.tests, ['test/cli.test.js', 'test/other.test.js']);
  assert.deepEqual(artifact.map['lib/merge.js'], ['test/cli.test.js'], 'the spawned CLI loaded it');
  assert.deepEqual(artifact.map['tool/runner.js'], ['test/cli.test.js']);
  assert.equal(artifact.map['lib/unused.js'], undefined, 'no test ran it');
  assert.equal(artifact.map['test/cli.test.js'], undefined, 'a test file is not a source of the map');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'raw')).flatMap((slug) => fs.readdirSync(path.join(dir, 'raw', slug))), [],
    'every profile was folded and removed');

  const p = makeRepo(t);
  p.init(['--repo', 'acme/demo']);
  gateFixture(p);
  const declared = { '**/*.md': [], 'docs/cli.md': ['test/other.test.js'], 'lib/gone.js': ['test/old.test.js'] };
  p.ok(['project', 'set', '--tests-map', JSON.stringify(declared)]);
  const before = p.readState('project.json');
  const denied = p.run(['tests', 'map', 'refresh', '--file', file, '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.deepEqual(p.readState('project.json'), before, 'a worker pins nothing');
  for (const [bad, reason] of [[{ ...artifact, sha: 'abc' }, /sha must be the full commit id/], [{ ...artifact, map: { 'lib/*.js': [] } }, /map sources must be literal paths/]]) {
    fs.writeFileSync(path.join(p.base, 'bad.json'), JSON.stringify(bad));
    const r = p.run(['tests', 'map', 'refresh', '--file', path.join(p.base, 'bad.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, reason);
    assert.deepEqual(p.readState('project.json'), before);
  }
  // --from-run downloads the run's tests-coverage-map artifact with gh run download.
  const calls = path.join(p.base, 'gh-calls.jsonl');
  fs.writeFileSync(path.join(p.base, 'tools', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'run' || args[1] !== 'download') process.exit(1);
fs.copyFileSync(${JSON.stringify(file)}, path.join(args[args.indexOf('-D') + 1], 'tests-coverage-map.json'));
`);
  const pinned = p.json(['tests', 'map', 'refresh', '--from-run', '4242', '--agent', 'orchestrator']);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8').trim()).slice(0, 7), ['run', 'download', '4242', '-R', 'acme/demo', '-n', 'tests-coverage-map']);
  assert.deepEqual({ run: pinned.run, sha: pinned.sha, declared: pinned.declared }, { run: 4242, sha: head, declared: 2 });
  // Measured entries replace the pinned ones; the globs and files coverage cannot see stay as declared.
  assert.deepEqual(p.readState('project.json').tests.map, {
    '**/*.md': [], 'docs/cli.md': ['test/other.test.js'], 'lib/merge.js': ['test/cli.test.js'], 'tool/runner.js': ['test/cli.test.js'],
  });
  const events = fs.readFileSync(path.join(p.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((e) => e.cmd === 'tests map refresh').at(-1).detail.authority, 'orchestrator');
});

test('test/run.js with TC_TEST_COVERAGE_DIR writes the coverage map of the files it ran', (t) => {
  const h = makeRepo(t);
  const dir = path.join(h.base, 'coverage');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js'), '--test-concurrency=1', 'test/commands.test.js'],
    { cwd: ROOT, env: { ...h.env, TC_TEST_COVERAGE_DIR: dir, TOWER_CRANE_TEST_TMP: path.join(h.base, 'tmp') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, 'tests-coverage-map.json'), 'utf8'));
  assert.equal(require('../lib/tests-coverage').artifactError(artifact), null);
  assert.deepEqual(artifact.tests, ['test/commands.test.js']);
  assert.deepEqual(artifact.map['lib/commands.js'], ['test/commands.test.js']);
  // The CLI the test starts counts: bin/tower-crane.js only runs in those processes.
  assert.deepEqual(artifact.map['bin/tower-crane.js'], ['test/commands.test.js']);
});
