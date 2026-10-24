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
function fixture(t, settings = map, valueTest, kind = 'code') {
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
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works', '--kind', kind]);
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
  assert.deepEqual(runs.map((c) => c.command), [selected(head), selected(['test/value.test.js']), selected(['test/value.test.js'])]);
  assert.deepEqual(runs.map((c) => c.status === 0), [true, true, false], 'head and scoped proof pass; the reverted proof fails');
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
  assert.equal(today.commands.find((c) => c.command !== 'git').command, fullCommand);
  assert.equal(counts(h), true);
});

for (const baseRef of ['main', 'origin/main']) for (const signed of [false, true]) for (const showSignature of [false, true]) test(`a crucial file added on ${baseRef} after the submitted head is skipped with a receipt (signed=${signed}, log.showSignature=${showSignature})`, (t) => {
  const h = fixture(t);
  h.git(['config', 'log.showSignature', String(showSignature)]);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'test/new.test.js'), "console.log('new suite');\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'new crucial suite']);
  let added = h.git(['rev-parse', 'HEAD']);
  if (signed) {
    // A signature header makes git emit verification output without needing a signing key.
    const body = `tree ${h.git(['rev-parse', 'HEAD^{tree}'])}\nparent ${h.git(['rev-parse', 'HEAD^'])}\n`
      + 'author a <a@example.com> 1700000000 +0000\ncommitter a <a@example.com> 1700000000 +0000\n'
      + 'gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nnew signed crucial suite\n';
    added = cp.execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { cwd: h.repo, env: h.env, input: body, encoding: 'utf8' }).trim();
    h.git(['reset', '--hard', added]);
    if (showSignature) assert.match(h.git(['log', '-1', '--format=%H', added]), /signature/i);
  }
  h.git(['commit', '--allow-empty', '-qm', 'later base tip']);
  const tip = h.git(['rev-parse', 'HEAD']);
  if (baseRef === 'origin/main') {
    h.git(['update-ref', 'refs/remotes/origin/main', tip]);
    h.git(['reset', '--hard', `${added}^`]);
  }
  h.git(['switch', 'fixture-change']);
  const setting = h.run(['project', 'set', '--tests-crucial', '["test/crucial.test.js","test/new.test.js"]', '--json']);
  assert.equal(setting.code, 0, setting.stderr);
  assert.equal(JSON.parse(setting.stdout).warnings, undefined, 'a path present on base needs no warning');
  const result = check(h);
  assert.deepEqual(result.receipt.head_tests, ['test/crucial.test.js', 'test/mapped.test.js', 'test/value.test.js']);
  assert.deepEqual(result.receipt.crucial_skipped, [{
    path: 'test/new.test.js', added_on_base: added,
    note: `crucial path not at head: test/new.test.js, added on base at ${added}`,
  }]);
  assert.ok(result.commands.filter((c) => c.command !== 'git').every((c) => !c.command.includes('new.test.js')));
  assert.equal(counts(h), true);
  const { mismatch } = require('../lib/gate-commands');
  const project = h.readState('project.json');
  const task = h.json(['task', 'show', 'T1']);
  for (const skipped of [[], null, {}, [{ path: 'test/new.test.js', added_on_base: 'bad' }],
    [{ ...result.receipt.crucial_skipped[0], path: 'test/wrong.test.js' }]]) {
    const entry = { ...result, type: 'tests', receipt: { ...result.receipt, crucial_skipped: skipped } };
    assert.match(mismatch(entry, project, task), /command receipts do not match/, 'missing or malformed skip evidence does not count');
  }
});

for (const baseRef of ['main', 'origin/main']) for (const removal of ['missing on both', 'deleted at head', 'renamed at head']) test(`a crucial file ${removal} with base ${baseRef} is the orchestrator's setting to fix`, (t) => {
  const h = fixture(t);
  if (baseRef === 'origin/main') {
    h.git(['switch', 'main']);
    h.git(['commit', '--allow-empty', '-qm', 'newer remote base']);
    h.git(['update-ref', 'refs/remotes/origin/main', h.git(['rev-parse', 'HEAD'])]);
    h.git(['reset', '--hard', 'HEAD^']);
    h.git(['switch', 'fixture-change']);
  }
  const missing = removal === 'missing on both';
  const file = missing ? 'test/missing.test.js' : 'test/crucial.test.js';
  if (!missing) {
    h.git(removal === 'deleted at head' ? ['rm', '-q', file] : ['mv', file, 'test/renamed.test.js']);
    h.git(['commit', '-qm', removal]);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  }
  const paths = JSON.stringify([file]);
  const setting = h.run(['project', 'set', '--tests-crucial', paths, '--json']);
  assert.equal(setting.code, 0, setting.stderr);
  assert.deepEqual(JSON.parse(setting.stdout).warnings, missing ? [`tests.crucial path missing at base tip: ${file}`] : undefined);
  if (missing) assert.match(h.ok(['project', 'set', '--tests-crucial', paths]), /warning: tests\.crucial path missing at base tip: test\/missing\.test\.js/);
  const result = check(h, 1);
  assert.deepEqual(result.config_failure, { key: 'tests_crucial' });
  assert.ok(result.summary.includes(`tests.crucial names paths that are not test files at head: ${file}`), result.summary);
  assert.equal(result.receipt?.crucial_skipped, undefined, 'an inherited or nonexistent path is never a base addition');
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 0, 'nothing runs');
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'gate_config');
  assert.equal(item.setting, 'tests.crucial');
  assert.deepEqual(item.action.argv, ['project', 'set', '--tests-crucial', '<JSON>']);
});

for (const [keep, kind, mode] of [[true, 'code', 'run-only (test-only diff)'], [false, 'docs', 'prove']]) test(`skipping every crucial file in ${mode} does not invoke an empty selector or the full suite`, (t) => {
  const h = fixture(t, map, undefined, kind);
  h.git(['switch', 'main']);
  h.git(['switch', '-c', 'docs-change']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Documentation only.\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'documentation change']);
  const head = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'test/new.test.js'), "console.log('new suite');\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'new crucial suite']);
  h.ok(['project', 'set', '--tests-crucial', '["test/new.test.js"]', '--tests-keep', keep ? '["*.md"]' : 'null']);
  h.ok(['submit', 'T1', '--sha', head, '--agent', 'worker']);
  const result = check(h);
  assert.equal(result.receipt.mode, mode);
  assert.equal(result.receipt.head_mode, 'crucial');
  assert.deepEqual(result.receipt.head_tests, []);
  assert.equal(result.receipt.crucial_skipped[0].path, 'test/new.test.js');
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 0);
  assert.equal(require('../lib/gate-commands').mismatch({ ...result, type: 'tests' }, h.readState('project.json'),
    h.json(['task', 'show', 'T1'])), null, 'the empty-selection receipt matches the pinned policy');
});

for (const [name, settings, valueTest, ok, pattern] of [
  ['the task\'s test runs the file no entry covers', { '**/*.md': [] }, undefined, true,
    /Scoped proof at \w+ under coverage: .*: exit 0\. Coverage: the changed tests ran value\.js, which no tests\.map entry covers\./],
  ['the mapped suite is gone at head and the task\'s test runs the file', { 'value.js': ['test/gone.test.js'], '**/*.md': [] }, undefined, true,
    /Coverage: the changed tests ran value\.js/],
  ['the task\'s test does not run the file no entry covers', { '**/*.md': [] }, "console.log('value is not loaded');\n", false,
    /coverage gap: no tests\.map entry covers value\.js, and the task's changed tests \(test\/value\.test\.js\) do not run it\./],
  ['a documentation file has no entry', { 'value.js': ['test/mapped.test.js'] }, undefined, false,
    /coverage gap: no tests\.map entry covers README\.md, .*tests-map\.declared\.json/],
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

test('a task declares its new data file at submitted head without changing project settings', (t) => {
  const h = fixture(t);
  const before = h.readState('project.json');
  fs.writeFileSync(path.join(h.repo, 'payload.json'), '{"value":1}\n');
  fs.writeFileSync(path.join(h.repo, 'tests-map.declared.json'), JSON.stringify({
    'payload.json': ['test/value.test.js'],
    'value.js': ['test/value.test.js'],
  }));
  fs.appendFileSync(path.join(h.repo, 'test/value.test.js'),
    "require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('payload.json', 'utf8')).value, 1);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'declare data coverage']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  // Neither the base declaration nor an uncommitted edit is the submitted declaration.
  fs.writeFileSync(path.join(h.repo, 'tests-map.declared.json'), '{"payload.json":["test/missing.test.js"]}');
  const result = check(h);
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.receipt.coverage_gaps, undefined);
  assert.ok(!result.receipt.head_tests.includes('test/mapped.test.js'), 'the declaration overrides the measured entry');
  assert.deepEqual(h.readState('project.json'), before, 'the worker changes no project setting');
  assert.equal(counts(h), true);
  const selection = cp.spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(ROOT, 'lib/gates/tests'))}).queueSelection({}, ${JSON.stringify(h.repo)},
      ${JSON.stringify(before)}, 'main', ${JSON.stringify(sha)}, 'code').then(s => console.log(JSON.stringify(s)));
  `], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(selection.status, 0, selection.stderr);
  assert.deepEqual(JSON.parse(selection.stdout).tests, result.receipt.head_tests, 'the merge queue reads the same head declaration');
});

for (const present of [false, true]) test(`declared coverage works with a crucial test ${present ? 'at head' : 'added only on base'}`, (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'tests-map.declared.json'), '{"value.js":["test/value.test.js"]}\n');
  if (present) fs.writeFileSync(path.join(h.repo, 'test/new.test.js'), "console.log('new suite');\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'declared selection fixture']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  let added;
  if (!present) {
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'test/new.test.js'), "console.log('new suite');\n");
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'new base suite']);
    added = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', 'fixture-change']);
  }
  h.ok(['project', 'set', '--tests-crucial', '["test/crucial.test.js","test/new.test.js"]']);
  const result = check(h);
  assert.deepEqual(result.receipt.head_tests, present
    ? ['test/crucial.test.js', 'test/new.test.js', 'test/value.test.js']
    : ['test/crucial.test.js', 'test/value.test.js']);
  assert.deepEqual(result.receipt.crucial_skipped, present ? undefined : [{
    path: 'test/new.test.js', added_on_base: added,
    note: `crucial path not at head: test/new.test.js, added on base at ${added}`,
  }]);
  assert.equal(counts(h), true);
});

test('queue declarations follow the selected merge commit', async (t) => {
  const h = fixture(t);
  const file = path.join(h.repo, 'tests-map.declared.json');
  fs.writeFileSync(file, '{"value.js":["test/value.test.js"]}\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'task declaration']);
  const head = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'test/queue.test.js'), "require('node:assert/strict').equal(require('../value'), 1);\n");
  fs.writeFileSync(file, '{"value.js":["test/queue.test.js"]}\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'queue declaration']);
  const merged = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(file, '{');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'invalid queue declaration']);
  const invalid = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(file, '{"value.js":["test/missing.test.js"]}\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'missing queue suite']);
  const missing = h.git(['rev-parse', 'HEAD']);
  const rows = [
    ['default task head', null, ['test/crucial.test.js', 'test/value.test.js']],
    ['selected merge head', merged, ['test/crucial.test.js', 'test/queue.test.js', 'test/value.test.js']],
    ['invalid JSON at merge head', invalid, null],
    ['missing suite at merge head', missing, null],
  ];
  const r = cp.spawnSync(process.execPath, ['-e', `
    (async () => {
      const gate = require(${JSON.stringify(path.join(ROOT, 'lib/gates/tests'))});
      const results = [];
      for (const [, merged] of ${JSON.stringify(rows)}) results.push(await gate.queueSelection({},
        ${JSON.stringify(h.repo)}, ${JSON.stringify(h.readState('project.json'))}, 'main',
        ${JSON.stringify(head)}, 'code', merged || undefined));
      console.log(JSON.stringify(results));
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const results = JSON.parse(r.stdout);
  for (const [index, [name, , expected]] of rows.entries()) {
    await t.test(name, () => {
      if (expected) {
        assert.equal(results[index].error, undefined);
        assert.deepEqual(results[index].tests, expected);
        assert.deepEqual(results[index].gaps, []);
      } else {
        assert.match(results[index].error, /tests-map\.declared\.json/);
        assert.equal(results[index].worker_failure, true);
      }
    });
  }
});

for (const [name, text] of [
  ['invalid JSON', '{'],
  ['null', 'null'],
  ['escaping source', '{"../payload.json":["test/value.test.js"]}'],
  ['missing suite', '{"payload.json":["test/missing.test.js"]}'],
  ['support file', '{"payload.json":["test/helpers.js"]}'],
]) {
  test(`a bad declaration belongs to the task: ${name}`, (t) => {
    const h = fixture(t);
    fs.writeFileSync(path.join(h.repo, 'tests-map.declared.json'), text);
    fs.writeFileSync(path.join(h.repo, 'test/helpers.js'), 'module.exports = 1;\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'bad declaration']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
    const result = check(h, 1);
    assert.match(result.summary, /tests-map\.declared\.json/);
    assert.equal(result.worker_failure, true);
    assert.equal(result.config_failure, undefined);
    assert.equal(result.commands.filter((c) => c.command !== 'git').length, 0);
  });
}

test('the coverage gap run measures a new JSON file read by the changed test', (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'payload.json'), '{"value":1}\n');
  fs.appendFileSync(path.join(h.repo, 'test/value.test.js'),
    "require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('payload.json', 'utf8')).value, 1);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'test data read']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const result = check(h);
  assert.equal(result.ok, true, result.summary);
  assert.deepEqual(result.receipt.coverage_gaps, ['payload.json']);
  assert.match(result.summary, /Coverage: the changed tests ran payload\.json/);
});

// Shard coverage also reaches the head command; only the gate's own coverage directory should
// trigger the proof crash.
for (const [source, load, settings] of [
  ['value.js', "require('../value')", { '**/*.md': [] }],
  ['payload.json', "JSON.parse(require('node:fs').readFileSync('payload.json', 'utf8')).value", map],
]) for (const inherited of [false, true]) {
  test(`a native crash in the coverage run is rerun as the proof step (${source}, ${inherited ? 'inherited coverage' : 'no inherited coverage'})`, { skip: process.platform === 'win32' && 'POSIX signals' }, (t) => {
    const marker = path.join(fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || require('node:os').tmpdir(), 'crucial-crash-')), 'runs');
    t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));
    const inheritedCoverage = path.join(path.dirname(marker), 'inherited');
    const crashOnce = `require('node:assert/strict').equal(${load}, 1);
if (process.env.NODE_V8_COVERAGE && process.env.NODE_V8_COVERAGE !== ${JSON.stringify(inheritedCoverage)}) {
${nativeCrashTest({ marker })}}
`;
    const h = fixture(t, settings, crashOnce);
    if (source === 'payload.json') {
      fs.writeFileSync(path.join(h.repo, source), '{"value":1}\n');
      h.git(['add', '.']);
      h.git(['commit', '-qm', 'data coverage crash fixture']);
      h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
    }
    // Node copies the parent's coverage setting when the child environment omits it.
    h.env.NODE_V8_COVERAGE = inherited ? inheritedCoverage : '';
    const result = check(h);
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(result.receipt.coverage_gaps, [source]);
    assert.deepEqual(result.receipt.reruns, [{ step: 'proof', files: ['test/value.test.js'], ok: true }]);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'xx', 'only the coverage run and its rerun reach the crash');
    assert.equal(counts(h), true);
  });
}

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
  assert.deepEqual({ run: pinned.run, sha: pinned.sha, measured: pinned.measured }, { run: 4242, sha: head, measured: 2 });
  assert.equal(pinned.declared, undefined);
  assert.deepEqual(p.readState('project.json').tests.map, artifact.map, 'refresh retains only measured entries');
  const events = fs.readFileSync(path.join(p.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((e) => e.cmd === 'tests map refresh').at(-1).detail.authority, 'orchestrator');
});

test('coverage maps successful repository data reads to their test, including children and fs API variants', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  const cases = ['sync', 'callback', 'promise', 'open-sync', 'open-callback', 'open-promise', 'open-numeric', 'child', 'child-esm', '..inside'];
  for (const name of cases) fs.writeFileSync(path.join(h.repo, `${name}.json`), '{"value":1}\n');
  fs.mkdirSync(path.join(h.repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'node_modules/ignored.json'), '{}');
  const outside = path.join(h.base, 'outside.json');
  fs.writeFileSync(outside, '{}');
  if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(h.repo, 'external-link.json'));
  fs.writeFileSync(path.join(h.repo, 'test/data.test.js'), `
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
test('reads data', async () => {
  assert.equal(JSON.parse(fs.readFileSync(require('node:url').pathToFileURL(require('node:path').resolve('sync.json')), 'utf8')).value, 1);
  await new Promise((resolve, reject) => fs.readFile(Buffer.from('callback.json'), (err, data) => {
    if (err) return reject(err); assert.equal(JSON.parse(data).value, 1); resolve();
  }));
  assert.equal(JSON.parse(await fs.promises.readFile('promise.json', 'utf8')).value, 1);
  fs.closeSync(fs.openSync('open-sync.json', 'r'));
  await new Promise((resolve, reject) => fs.open('open-callback.json', 'r', (err, fd) => {
    if (err) return reject(err); fs.closeSync(fd); resolve();
  }));
  await (await fs.promises.open('open-promise.json', 'r')).close();
  fs.closeSync(fs.openSync('open-numeric.json', fs.constants.O_RDONLY));
  require('node:child_process').execFileSync(process.execPath, ['-e',
    "require('node:assert/strict').equal(JSON.parse(require('node:fs').readFileSync('child.json', 'utf8')).value, 1)"]);
  require('node:child_process').execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(JSON.parse(readFileSync('child-esm.json', 'utf8')).value, 1)"]);
  fs.readFileSync('..inside.json');
  assert.throws(() => fs.readFileSync('missing.json'));
  await assert.rejects(fs.promises.readFile('missing-promise.json'));
  fs.writeFileSync('write-only.json', '{}'); fs.closeSync(fs.openSync('write-only.json', 'w'));
  fs.closeSync(fs.openSync('numeric-write-only.json', fs.constants.O_WRONLY | fs.constants.O_CREAT));
  fs.readFileSync('node_modules/ignored.json');
  fs.readFileSync(${JSON.stringify(outside)});
  if (process.platform !== 'win32') {
    fs.readFileSync('external-link.json');
    fs.closeSync(fs.openSync('test', 'r'));
  }
});
`);
  fs.writeFileSync(path.join(h.repo, 'test/other.test.js'),
    "require('node:test')('other', () => { require('node:fs').readFileSync('sync.json'); });\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'data read fixture']);
  const dir = path.join(h.base, 'coverage');
  const built = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/tests-coverage-map.js'), 'run', '--dir', dir, '--',
    process.execPath, '--test', 'test/data.test.js', 'test/other.test.js'], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, 'tests-coverage-map.json'), 'utf8'));
  for (const name of cases) assert.deepEqual(artifact.map[`${name}.json`],
    name === 'sync' ? ['test/data.test.js', 'test/other.test.js'] : ['test/data.test.js'], name);
  for (const name of ['missing.json', 'missing-promise.json', 'write-only.json', 'numeric-write-only.json',
    'node_modules/ignored.json', '../outside.json', 'external-link.json', 'test']) {
    assert.equal(artifact.map[name], undefined, name);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'raw')).flatMap((slug) => fs.readdirSync(path.join(dir, 'raw', slug))), []);
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

test('coverage preloads follow child launch variants through both map runners', async (t) => {
  const h = makeRepo(t);
  for (const file of ['test/run.js', 'test/signals.js', 'test/atomic-file.js', 'test/tmp-root.js',
    'test/global-setup.js', 'test/repo-seed.js', 'test/host.js',
    'test/fixtures/user-config-guard.js', 'test/fixtures/report-guard.js', 'test/fixtures/no-fsync.js', 'scripts/tests-coverage-map.js',
    'lib/tests-coverage.js', 'lib/tests-coverage-scope.js', 'lib/tests-coverage-reads.js']) {
    fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(h.repo, file));
  }
  fs.mkdirSync(path.join(h.repo, 'test/gates'), { recursive: true });
  const launches = {
    'spawn-sync': "const r = cp.spawnSync(process.execPath, [file]); assert.equal(r.status, 0, String(r.stderr));",
    'exec-file-sync': "cp.execFileSync(process.execPath, [file]);",
    spawn: "await new Promise((resolve, reject) => { const child = cp.spawn(process.execPath, [file], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', (code) => { assert.equal(code, 0); resolve(); }); });",
    'exec-file': "await new Promise((resolve, reject) => cp.execFile(process.execPath, [file], (err) => err ? reject(err) : resolve()));",
    fork: "await new Promise((resolve, reject) => { const child = cp.fork(file, [], { stdio: 'inherit' }); child.on('error', reject); child.on('exit', (code) => { assert.equal(code, 0); resolve(); }); });",
    esm: "cp.execFileSync(process.execPath, [file]);",
    grandchild: "cp.execFileSync(process.execPath, ['-e', \"require('node:child_process').execFileSync(process.execPath, ['./child-grandchild.js'])\"]);",
  };
  const suites = [];
  for (const [name, launch] of Object.entries(launches)) {
    const file = `child-${name}.${name === 'esm' ? 'mjs' : 'js'}`;
    const imports = name === 'esm'
      ? "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict';"
      : "const { readFileSync } = require('node:fs'), assert = require('node:assert/strict');";
    fs.writeFileSync(path.join(h.repo, file), `${imports}
assert.ok(process.env.NODE_OPTIONS.includes('--no-warnings'));
assert.equal(JSON.parse(readFileSync('${name}.json', 'utf8')).value, 1);
`);
    fs.writeFileSync(path.join(h.repo, `${name}.json`), '{"value":1}\n');
    const suite = `test/${name}.test.js`;
    suites.push(suite);
    fs.writeFileSync(path.join(h.repo, suite), `
const cp = require('node:child_process'), assert = require('node:assert/strict');
require('node:test')('${name}', async () => { const file = './${file}'; ${launch} });
`);
  }
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'child launch fixture']);
  for (const mode of ['ci', 'script']) {
    const dir = path.join(h.base, mode);
    const args = mode === 'ci'
      ? ['test/run.js', '--test-concurrency=2', ...suites]
      : ['scripts/tests-coverage-map.js', 'run', '--dir', dir, '--', process.execPath, '--test', '--test-concurrency=2', ...suites];
    const r = cp.spawnSync(process.execPath, args, { cwd: h.repo,
      env: { ...h.env, NODE_OPTIONS: '--no-warnings', TC_TEST_COVERAGE_DIR: mode === 'ci' ? dir : '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, `${mode}: ${r.stderr}${r.stdout}`);
    const artifact = JSON.parse(fs.readFileSync(path.join(dir, 'tests-coverage-map.json'), 'utf8'));
    for (const name of Object.keys(launches)) {
      await t.test(`${mode}: ${name}`, () => {
        assert.deepEqual(artifact.map[`${name}.json`], [`test/${name}.test.js`]);
      });
    }
  }
});

test('coverage open flag variants count default reads and exclude failed or write-only opens', async (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  const rows = [
    ['sync-default', "fs.openSync(file)", true],
    ['sync-undefined', "fs.openSync(file, undefined)", true],
    ['sync-read', "fs.openSync(file, 'r')", true],
    ['sync-read-write', "fs.openSync(file, 'r+')", true],
    ['sync-numeric-read', 'fs.openSync(file, fs.constants.O_RDONLY)', true],
    ['sync-write', "fs.openSync(file, 'w')", false],
    ['sync-numeric-write', 'fs.openSync(file, fs.constants.O_WRONLY)', false],
    ['callback-default', 'await open(file)', true],
    ['callback-undefined', 'await open(file, undefined)', true],
    ['callback-read', "await open(file, 'r')", true],
    ['callback-write', "await open(file, 'w')", false],
    ['promise-default', 'await fs.promises.open(file)', true],
    ['promise-undefined', 'await fs.promises.open(file, undefined)', true],
    ['promise-read', "await fs.promises.open(file, 'r')", true],
    ['promise-write', "await fs.promises.open(file, 'w')", false],
    ['sync-missing', 'fs.openSync(file)', false, true],
    ['callback-missing', 'await open(file)', false, true],
    ['promise-missing', 'await fs.promises.open(file)', false, true],
  ];
  const code = [];
  for (const [name, call, measured, missing] of rows) {
    if (!missing) fs.writeFileSync(path.join(h.repo, `${name}.json`), '{"value":1}\n');
    const body = missing ? `await assert.rejects(async () => { ${call}; });` : `
const handle = ${call};
const fd = typeof handle === 'number' ? handle : handle.fd;
try { ${measured ? "assert.equal(JSON.parse(fs.readFileSync(fd, 'utf8')).value, 1);" : ''} }
finally { if (typeof handle === 'number') fs.closeSync(handle); else await handle.close(); }`;
    code.push(`test('${name}', async () => { const file = '${name}.json'; ${body} });`);
  }
  fs.writeFileSync(path.join(h.repo, 'test/open.test.js'), `
const test = require('node:test'), fs = require('node:fs'), assert = require('node:assert/strict');
const open = (...args) => new Promise((resolve, reject) => fs.open(...args, (err, fd) => err ? reject(err) : resolve(fd)));
${code.join('\n')}
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'open flags fixture']);
  for (const mode of ['map', 'inherited']) {
    const dir = path.join(h.base, `coverage-${mode}`);
    // The map runner redirects profiles. Direct installation also exercises the
    // recorder under the caller's coverage, as a scoped proof sees it.
    const args = mode === 'map'
      ? [path.join(ROOT, 'scripts/tests-coverage-map.js'), 'run', '--dir', dir, '--',
        process.execPath, '--test', 'test/open.test.js']
      : ['-e', `require(${JSON.stringify(path.join(ROOT, 'lib/tests-coverage-reads.js'))})
        .install(${JSON.stringify(dir)}, ${JSON.stringify(h.repo)});
        require(${JSON.stringify(path.join(h.repo, 'test/open.test.js'))});`];
    const r = cp.spawnSync(process.execPath, args, { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const artifact = mode === 'map' ? JSON.parse(fs.readFileSync(path.join(dir, 'tests-coverage-map.json'), 'utf8')) : null;
    const reads = mode === 'inherited' ? require('../lib/tests-coverage').ranIn(dir, h.repo) : null;
    for (const [name, , measured] of rows) {
      await t.test(`${mode}: ${name}`, () => {
        if (artifact) assert.deepEqual(artifact.map[`${name}.json`], measured ? ['test/open.test.js'] : undefined);
        else assert.equal(reads.has(`${name}.json`), measured);
      });
    }
  }
});
