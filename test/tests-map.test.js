'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');
const { gateFixture } = require('./gate-helpers');

const runner = `node ${shellQuote(path.join(ROOT, 'test/run.js'))}`;
const fullCommand = `${runner} test/*.test.js`;

const map = { 'value.js': ['test/mapped.test.js'], '**/*.md': [] };

function fixture(t, settings = map, withPr = true) {
  const h = cachedFixture(t, 'tests-map-base', (h) => {
    delete h.env.NODE_TEST_CONTEXT;
    h.init();
    gateFixture(h);
    h.git(['switch', 'main']);
    fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 0;\n');
    fs.writeFileSync(path.join(h.repo, 'test/mapped.test.js'), 'console.log("mapped suite");\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'mapped suite']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', 'main']);
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(h.repo, 'README.md'), 'Changed documentation.\n');
    h.git(['add', '.']);
    h.git(['commit', '--allow-empty', '-qm', 'submitted change']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
  delete h.env.NODE_TEST_CONTEXT;
  const sha = h.sha;
  h.ok(['project', 'set', '--tests-expensive', 'true', '--tests-map', JSON.stringify(settings),
    '--tests-cmd', fullCommand, '--tests-proof-cmd', `${runner} {tests}`, '--ci-required', '["test ("]']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker', ...(withPr ? ['--pr', '1'] : [])]);
  return h;
}

function check(h) {
  const result = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test('mapped head suites preserve scoped proof and policy-bound evidence through the CLI', (t) => {
  const h = fixture(t);
  assert.deepEqual(h.json(['project', 'show']).tests.map, map);
  assert.match(h.ok(['project', 'show']), /tests.map:/);
  const receipt = check(h);
  const runs = receipt.commands.filter((c) => c.command !== 'git');
  assert.equal(receipt.receipt.head_mode, 'mapped');
  assert.deepEqual(receipt.receipt.head_tests, ['test/mapped.test.js', 'test/value.test.js']);
  assert.deepEqual(receipt.receipt.proof_tests, ['test/value.test.js']);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((c) => !c.command.includes('*.test.js')));
  assert.equal(runs[0].status, 0);
  assert.equal(runs[1].status, 0);
  assert.notEqual(runs[2].status, 0);
  assert.match(receipt.summary, /Head suite mode mapped/);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
  h.ok(['project', 'set', '--tests-map', '{}']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, false);
  const fallback = check(h);
  assert.equal(fallback.receipt.head_mode, 'full');
  assert.match(fallback.summary, /unmapped.*value.js/);
  assert.equal(fallback.commands.find((c) => c.command !== 'git').command, fullCommand);
  assert.deepEqual(fallback.receipt.proof_tests, receipt.receipt.proof_tests);
  h.ok(['project', 'set', '--tests-map', JSON.stringify(map)]);
  check(h);
  h.ok(['project', 'set', '--ci-required', '[]']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, false);
});

for (const [reason, settings, flags] of [
  ['missing mapped test', { 'value.js': ['test/missing.test.js'], '**/*.md': [] }, []],
  ['outside tests.paths', { 'value.js': ['value.js'], '**/*.md': [] }, []],
  ['ci.required', map, ['--ci-required', '[]']],
  ['ci.local', map, ['--ci-local', '{"command":["node","-e","process.exit(0)"],"timeout":60}']],
  ['tests.expensive', map, ['--tests-expensive', 'false']],
  ['tests.map', map, ['--tests-map', 'null']],
]) {
  test(`head selection falls back when ${reason}`, (t) => {
    const h = fixture(t, settings);
    if (flags.length) h.ok(['project', 'set', ...flags]);
    const result = check(h);
    assert.equal(result.receipt.head_mode, 'full');
    assert.match(result.receipt.head_reason, new RegExp(reason.replaceAll('.', '\\.')));
  });
}

test('tests map validates paths and is operational at init, set, clear and unchanged values', (t) => {
  const h = makeRepo(t);
  const denied = h.run(['init', '--name', 'demo', '--goal', 'work', '--tests-map', '{}', '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.equal(fs.existsSync(h.state), false);
  h.init(['--tests-map', JSON.stringify(map)]);
  const before = h.readState('project.json');
  for (const value of [JSON.stringify(map), '{}', 'null']) {
    const r = h.run(['project', 'set', '--name', 'changed', '--tests-map', value, '--agent', 'worker']);
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(h.readState('project.json'), before);
  }
  for (const value of ['[]', 'false', '{"a":"b"}', '{"../a":["test/a.js"]}', '{"a":["/test/a.js"]}', '{"a":["test/*.js"]}', '{"a":["x\\u0000y"]}']) {
    assert.equal(h.run(['project', 'set', '--tests-map', value]).code, 2, value);
    assert.deepEqual(h.readState('project.json'), before);
  }
  h.ok(['project', 'set', '--tests-map', '{"**/*.md":[]}']);
  assert.deepEqual(h.readState('project.json').tests.map, { '**/*.md': [] });
  h.ok(['project', 'set', '--tests-map', 'null']);
  assert.equal(h.readState('project.json').tests?.map, undefined);
});


test('broad test globs still map changed helpers to their covered suites', (t) => {
  const h = fixture(t, { ...map, 'test/helpers.js': ['test/mapped.test.js'] });
  fs.writeFileSync(path.join(h.repo, 'test/helpers.js'), 'module.exports = 1;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'helper change']);
  h.ok(['rework', 'T1', '--reason', 'helper coverage']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.git(['rev-parse', 'HEAD'])]);
  h.ok(['project', 'set', '--tests-paths', '["test/**"]']);
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'mapped');
  assert.ok(result.receipt.head_tests.includes('test/mapped.test.js'));
  assert.ok(!result.receipt.head_tests.includes('test/helpers.js'));
  h.ok(['project', 'set', '--tests-map', JSON.stringify(map)]);
  const fallback = check(h);
  assert.equal(fallback.receipt.head_mode, 'full');
  assert.match(fallback.receipt.head_reason, /unmapped.*test\/helpers.js/);
});


test('explicit mappings still apply when a broad test glob matches the mapped source', (t) => {
  const h = fixture(t, { ...map, 'test/runtime.js': ['test/mapped.test.js'] });
  fs.writeFileSync(path.join(h.repo, 'test/runtime.js'), 'module.exports = 1;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'runtime support change']);
  h.ok(['rework', 'T1', '--reason', 'runtime coverage']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.git(['rev-parse', 'HEAD'])]);
  h.ok(['project', 'set', '--tests-paths', '["test/**"]']);
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'mapped');
  assert.ok(result.receipt.head_tests.includes('test/mapped.test.js'));
});


test('a task without a PR runs the full head suite because hosted CI is not required', (t) => {
  const h = fixture(t, map, false);
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'full');
  assert.match(result.receipt.head_reason, /no PR/);
  assert.equal(result.commands.find((c) => c.command !== 'git').command, fullCommand);
});

test('a change only to test/browser.js runs the full head suite with run-only semantics', (t) => {
  const h = fixture(t, { ...map, 'test/browser.js': ['test/mapped.test.js'] });
  h.git(['branch', '-f', 'main', 'HEAD']);
  fs.writeFileSync(path.join(h.repo, 'test/browser.js'), 'module.exports = 1;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'browser support change']);
  h.ok(['rework', 'T1', '--reason', 'browser support coverage']);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.git(['rev-parse', 'HEAD'])]);
  h.ok(['project', 'set', '--tests-paths', '["test/**"]']);
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'full');
  assert.ok(!result.receipt.head_tests?.includes('test/mapped.test.js'));
  assert.equal(result.receipt.mode, 'run-only (test-only diff)');
  assert.deepEqual(result.receipt.changed_files, ['test/browser.js']);
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 1);
  assert.equal(result.commands.find((c) => c.command !== 'git').command, fullCommand);
});


test('mapped head timeout uses the project deadline and remains infrastructure failure', (t) => {
  const h = fixture(t);
  const script = path.join(h.base, 'slow-mapped-runner.js');
  fs.writeFileSync(script, `
const file = process.argv[2];
console.log('TAP version 13\\n# Subtest: ' + file);
process.on('SIGTERM', () => {
  console.log('not ok 1 - ' + file + "\\n  error: 'Promise resolution is still pending but the event loop has already resolved'");
  process.exit(1);
});
setTimeout(() => process.exit(0), 10000); // wait-allow: mapping diagnostics must survive a deliberately timed-out test runner
`);
  h.ok(['project', 'set', '--tests-timeout-min', '0.05',
    '--tests-proof-cmd', `node ${shellQuote(script)} {tests}`]);
  const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
  assert.equal(run.code, 1, run.stderr + run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.receipt.head_mode, 'mapped');
  assert.equal(result.infrastructure_failure, true);
  assert.equal(result.confirmed_failure, undefined);
  assert.equal(result.test_failure, undefined);
  assert.equal(result.timeout.minutes, 0.05);
  assert.deepEqual(result.timeout.running_files, ['test/mapped.test.js']);
  assert.match(result.summary, /timed out after 0\.05 min/);
  assert.doesNotMatch(result.summary, /Failing tests|Make the tests pass|Promise resolution/);
  const commands = result.commands.filter((c) => c.command !== 'git');
  assert.equal(commands.length, 1);
  const selectedTests = ['test/mapped.test.js', 'test/value.test.js'];
  assert.deepEqual(result.receipt.head_tests, selectedTests);
  assert.equal(commands[0].command, `node ${shellQuote(script)} ${selectedTests.map(shellQuote).join(' ')}`);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'submitted');
  assert.equal(task.evidence.at(-1).infrastructure_failure, true);
});

function repositoryMap(h, settings) {
  h.git(['switch', 'main']);
  fs.mkdirSync(path.join(h.repo, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'tools/tests-map.json'), JSON.stringify(settings));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'repository suite map']);
  h.git(['switch', 'fixture-change']);
  h.git(['merge', '--no-edit', 'main']);
}

function incrementalFixture(t, settings = { 'docs/**': ['test/mapped.test.js'], '**/*.md': [] }, flags = [], beforeFull = () => {}) {
  const h = fixture(t, null);
  h.ok(['project', 'set', '--ci-required', '[]', ...flags]);
  if (settings !== null) repositoryMap(h, settings);
  beforeFull(h);
  h.git(['add', '.']);
  h.git(['commit', '--allow-empty', '-qm', 'full pass head']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const full = check(h);
  assert.equal(full.receipt.head_mode, 'full');
  h.fullSha = full.sha;
  return h;
}

test('incremental reuse refuses task seed changes made before the full pass', (t) => {
  for (const [name, settings, content] of [
    ['added', null, '{"**":[]}'],
    ['edited', { 'docs/**': ['test/mapped.test.js'] }, '{"**":[]}'],
    ['deleted', { 'docs/**': ['test/mapped.test.js'] }, null],
    ['malformed', { 'docs/**': ['test/mapped.test.js'] }, '{'],
  ]) {
    const h = incrementalFixture(t, settings, [], (h) => {
      const seed = path.join(h.repo, 'tools/tests-map.json');
      fs.mkdirSync(path.dirname(seed), { recursive: true });
      if (content === null) fs.unlinkSync(seed);
      else fs.writeFileSync(seed, content);
    });
    resubmit(h, 'docs/state.md');
    const result = check(h);
    assert.equal(result.receipt.head_mode, 'full', name);
    assert.equal(result.commands.find((c) => c.command !== 'git').command, fullCommand, name);
  }
});

test('incremental fallback preserves eligible hosted mapped selection', (t) => {
  for (const [name, prepare, expected] of [
    ['policy change', (h) => h.ok(['project', 'set', '--tests-keep', '["docs/**"]']), 'mapped'],
    ['map newly pinned', (h) => h.ok(['project', 'set', '--tests-map', JSON.stringify(map)]), 'mapped'],
    ['nonancestor', (h) => h.git(['reset', '--hard', 'HEAD~1']), 'mapped'],
    ['uncovered delta', (h) => fs.unlinkSync(path.join(h.repo, 'test/obsolete.test.js')), 'mapped'],
    ['missing required job', (h) => h.ok(['project', 'set', '--ci-required', '[]']), 'full'],
    ['local CI', (h) => h.ok(['project', 'set', '--ci-local', '{"command":["node","-e","process.exit(0)"],"timeout":60}']), 'full'],
    ['no PR', (h) => h.ok(['project', 'set', '--tests-keep', '["docs/**"]']), 'full'],
  ]) {
    const h = fixture(t, name === 'map newly pinned' ? null : map, false);
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'test/obsolete.test.js'), 'console.log("obsolete suite");\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'base test suite']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', 'main']);
    // A first pass without a PR establishes the full anchor under the same policy.
    h.git(['commit', '--allow-empty', '-qm', 'full pass head']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
    assert.equal(check(h).receipt.head_mode, 'full');
    prepare(h);
    resubmit(h, 'README.md');
    if (name !== 'no PR') h.ok(['submit', 'T1', '--sha', h.env.FIXTURE_SHA, '--pr', '1', '--agent', 'worker']);
    const result = check(h);
    assert.equal(result.receipt.head_mode, expected, name);
    if (expected === 'mapped') {
      assert.deepEqual(result.receipt.head_tests, ['test/mapped.test.js', 'test/value.test.js'], name);
    }
  }
});

function resubmit(h, file, content = 'Changed prose.\n') {
  fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(h.repo, file), content);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'resubmission delta']);
  h.ok(['rework', 'T1', '--reason', 'resubmission']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.env.FIXTURE_SHA = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', h.env.FIXTURE_SHA, '--agent', 'worker']);
}

test('docs resubmission uses the repository seed and retains the full pass across rework', (t) => {
  const h = incrementalFixture(t);
  resubmit(h, 'docs/state.md');
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.equal(result.receipt.incremental_from, h.fullSha);
  assert.deepEqual(result.receipt.head_tests, ['test/mapped.test.js']);
  const runs = result.commands.filter((c) => c.command !== 'git');
  assert.equal(runs[0].command, `${runner} ${shellQuote('test/mapped.test.js')}`);
  assert.equal(runs[1].status, 0);
  assert.notEqual(runs[2].status, 0, 'the failing-before proof still runs');
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
  h.ok(['check', 'clean', 'T1', '--agent', 'worker']);
  h.ok(['project', 'set', '--repo', 'acme/widget']);
  const ci = h.run(['check', 'ci', 'T1', '--agent', 'worker', '--json']);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok',
    '--sha', result.sha, '--agent', 'owner']);
  h.ok(['accept', 'T1']);
  h.ok(['merge', 'T1']);
});

test('incremental head can select no suites without invoking a default full runner', (t) => {
  const h = incrementalFixture(t, { '**/*.md': [] });
  resubmit(h, 'docs/state.md');
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.deepEqual(result.receipt.head_tests, []);
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 2, 'only the scoped proof runs');
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('incremental proof scope preserves acceptable receipts across policy variants', (t) => {
  for (const [name, flags, kept, expected] of [
    ['non-expensive prove', ['--tests-expensive', 'false'], false, 'full'],
    ['default-expense prove', ['--tests-expensive', 'null'], false, 'full'],
    ['scoped prove', [], false, 'incremental'],
    ['non-expensive run-only', ['--tests-expensive', 'false', '--tests-mode', 'run-only'], false, 'incremental'],
    ['non-expensive kept-only', ['--tests-expensive', 'false', '--tests-keep', '["docs/**"]'], true, 'full'],
    ['scoped kept-only', ['--tests-keep', '["docs/**"]'], true, 'incremental'],
    ['non-expensive without template', ['--tests-expensive', 'false', '--tests-proof-cmd', 'null'], false, 'full'],
  ]) {
    const h = incrementalFixture(t, undefined, flags);
    if (kept) h.git(['branch', '-f', 'main', 'HEAD']);
    resubmit(h, 'docs/state.md');
    const result = check(h);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true, name);
    assert.equal(result.receipt.head_mode, expected, name);
    if (expected === 'full') assert.equal(result.commands.find((c) => c.command !== 'git').command, fullCommand, name);
    assert.equal(check(h).receipt.head_mode, expected, `${name}: rerun`);
    h.ok(['check', 'clean', 'T1', '--agent', 'worker']);
    h.ok(['project', 'set', '--repo', 'acme/widget']);
    h.ok(['check', 'ci', 'T1', '--agent', 'worker']);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok',
      '--sha', result.sha, '--agent', 'owner']);
    h.ok(['accept', 'T1']);
    h.ok(['merge', 'T1']);
  }
});

test('incremental markdown coverage includes the repository suites that read it', () => {
  const { select } = require('../lib/tests-incremental');
  const { testMatcher, isSupportFile, globToRegExp } = require('../lib/gates/tests');
  const matcher = testMatcher({ base: 'main' });
  const isTest = (p) => matcher.match(p) && !isSupportFile(p);
  const files = ['test', 'test/gates'].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => `${dir}/${entry.name}`)).filter(isTest);
  const available = new Set(files);
  const seed = require('../tools/tests-map.json');
  for (const [file, expected] of [
    ['skills/tower-crane-work/SKILL.md', ['test/host-probes.test.js', 'test/broker.test.js', 'test/shared-files.test.js']],
    ['agents/tower-crane-orchestrator.md', ['test/host-probes.test.js']],
    ['skills/tower-crane/SKILL.md', ['test/isolation.test.js']],
    ['docs/ladder.md', ['test/isolation.test.js', 'test/ci-required.test.js', 'test/shared-files.test.js']],
  ]) {
    const readers = files.filter((suite) => {
      const source = fs.readFileSync(path.join(ROOT, suite), 'utf8');
      return source.includes(file) || source.includes(path.posix.basename(file));
    });
    const result = select(seed, [{ path: file, status: 'M' }], isTest, available,
      globToRegExp, 'node test/run.js {tests}', '', readers);
    assert.equal(result.mode, 'incremental', file);
    for (const suite of expected) assert.ok(result.tests.includes(suite), `${file} must run ${suite}`);
  }
});

test('incremental reference patterns cover literal paths, basenames, deletions and both rename sides', () => {
  const { referencePatterns, select, suiteMatcher } = require('../lib/tests-incremental');
  const { globToRegExp } = require('../lib/gates/tests');
  const isTest = (p) => p.endsWith('.test.js');
  const sources = {
    'test/path.test.js': 'read("skills/work/SKILL.md")',
    'test/basename.test.js': "path.join(root, 'skills', 'other', 'SKILL.md')",
    'test/docs.test.js': 'read("docs/guide[1].md")',
    'test/mapped.test.js': 'unrelated source',
    'test/old.test.js': 'read("old/previous.md")',
    'test/new.test.js': 'read("new/replacement.md")',
  };
  const available = new Set(Object.keys(sources));
  for (const [files, map, expected] of [
    [[{ path: 'skills/work/SKILL.md', status: 'M' }], { '**/*.md': [] }, ['test/basename.test.js', 'test/path.test.js']],
    [[{ path: 'skills/work/SKILL.md', status: 'D' }], { '**/*.md': [] }, ['test/basename.test.js', 'test/path.test.js']],
    [[{ path: 'old/SKILL.md', status: 'D' }, { path: 'new/SKILL.md', status: 'A' }], { '**/*.md': [] }, ['test/basename.test.js', 'test/path.test.js']],
    [[{ path: 'old/previous.md', status: 'D' }, { path: 'new/replacement.md', status: 'A' }], { '**/*.md': [] }, ['test/new.test.js', 'test/old.test.js']],
    [[{ path: 'docs/guide[1].md', status: 'M' }], { '**/*.md': ['test/mapped.test.js'] }, ['test/docs.test.js', 'test/mapped.test.js']],
    [[{ path: 'docs/unread.md', status: 'M' }], { '**/*.md': [] }, []],
    [[{ path: 'test/path.test.js', status: 'M' }], {}, ['test/path.test.js']],
  ]) {
    const patterns = referencePatterns(files, isTest);
    const readers = Object.entries(sources).filter(([, source]) => patterns.some((p) => source.includes(p))).map(([suite]) => suite);
    const result = select(map, files, isTest, available, globToRegExp, 'node --test {tests}', '', readers);
    assert.equal(result.mode, 'incremental');
    assert.deepEqual(result.tests, expected);
  }
  const broad = suiteMatcher(() => true, 'node test/execute.js {tests}', 'node test/run.js');
  for (const file of ['package.json', 'test/helpers.js', 'test/fixtures/input.json', 'test/run.js', 'test/execute.js']) {
    assert.ok(referencePatterns([{ path: file, status: 'M' }], broad).includes(file),
      `broad tests.paths must still scan readers of ${file}`);
  }
});

test('incremental CLI runs readers hidden by an empty markdown mapping', (t) => {
  const h = fixture(t, null);
  h.git(['switch', 'main']);
  fs.mkdirSync(path.join(h.repo, 'skills/work'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'skills/work/SKILL.md'), 'Required contract.\n');
  fs.writeFileSync(path.join(h.repo, 'test/reader.test.js'), `const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.match(fs.readFileSync('skills/work/SKILL.md', 'utf8'), /Required contract/);
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'markdown reading suite']);
  h.git(['switch', 'fixture-change']);
  h.git(['merge', '--no-edit', 'main']);
  repositoryMap(h, { '**/*.md': [] });
  h.ok(['project', 'set', '--ci-required', '[]']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  assert.equal(check(h).receipt.head_mode, 'full');
  resubmit(h, 'skills/work/SKILL.md', 'Broken contract.\n');
  const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
  assert.equal(run.code, 1, run.stderr + run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.ok(result.receipt.head_tests.includes('test/reader.test.js'));
});

test('incremental reference scan failures retain full coverage', (t) => {
  for (const result of [
    { status: 128, stdout: '', stderr: 'cannot read source' },
    { status: 1, signal: 'SIGTERM', stdout: '' },
    { status: 1, timedOut: true, stdout: '' },
    { status: 0, stdout: 'invalid result\0' },
  ]) {
    const h = incrementalFixture(t);
    resubmit(h, 'docs/state.md');
    const preload = path.join(h.base, 'reference-failure.js');
    fs.writeFileSync(preload, `const common = require(${JSON.stringify(path.join(ROOT, 'lib/gates/common.js'))});
const git = common.git;
common.git = (ctx, root, args, opts) => args.includes('grep')
  ? Promise.resolve(${JSON.stringify(result)})
  : git(ctx, root, args, opts);
`);
    const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json'], {
      env: { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}` },
    });
    assert.equal(run.code, 0, run.stderr + run.stdout);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.receipt.head_mode, 'full', JSON.stringify(result));
    assert.match(receipt.receipt.head_reason, /could not read test references/);
    assert.equal(receipt.commands.find((c) => c.command !== 'git').command, fullCommand);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
  }
});

test('incremental selection falls back for uncovered deltas and changed policy', (t) => {
  const cases = [
    ['unmapped.js', 'module.exports = 1;\n', []],
    ['tools/tests-map.json', '{}', []],
    ['package.json', '{}', []],
    ['test/run.js', 'console.log("runner");\n', ['--tests-paths', '["test/**"]']],
    ['test/helpers.js', 'module.exports = 1;\n', ['--tests-paths', '["test/**"]']],
    ['test/fixtures/value.json', '{}', []],
    ['docs/state.md', 'Changed prose.\n', ['--tests-keep', '["docs/**"]']],
    ['docs/state.md', 'Changed prose.\n', ['--tests-map', '{"docs/**":[]}']],
  ];
  for (const [file, content, flags] of cases) {
    const h = incrementalFixture(t);
    if (flags.length) h.ok(['project', 'set', ...flags]);
    resubmit(h, file, content);
    const result = check(h);
    assert.equal(result.receipt.head_mode, 'full', file + JSON.stringify(flags));
    assert.equal(result.commands.find((c) => c.command !== 'git').command, fullCommand);
  }
});

test('base merges participate in the incremental delta and missing full evidence blocks reuse', (t) => {
  const h = incrementalFixture(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'unmapped.js'), 'module.exports = 0;\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base delta']);
  h.git(['switch', 'fixture-change']);
  h.git(['merge', '--no-edit', 'main']);
  resubmit(h, 'docs/state.md');
  assert.equal(check(h).receipt.head_mode, 'full');

  const mapped = incrementalFixture(t);
  resubmit(mapped, 'docs/state.md');
  assert.equal(check(mapped).receipt.head_mode, 'incremental');
  const state = mapped.readState('tasks.json');
  state.tasks[0].evidence = state.tasks[0].evidence.filter((e) => e.sha !== mapped.fullSha);
  mapped.writeState('tasks.json', state);
  const gate = mapped.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests');
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /full.*evidence/);
});

test('incremental mapping handles changed tests, support files, runners and empty coverage', () => {
  const { select } = require('../lib/tests-incremental');
  const { globToRegExp, isTestFile, isSupportFile } = require('../lib/gates/tests');
  const isTest = (p) => isTestFile(p) && !isSupportFile(p);
  const available = new Set(['test/a.test.js', 'test/b.test.js']);
  for (const [file, mapping, status, expected, tests] of [
    ['docs/state.md', { 'docs/**': [] }, 'M', 'incremental', []],
    ['test/a.test.js', {}, 'M', 'incremental', ['test/a.test.js']],
    ['test/a.test.js', {}, 'D', 'full'],
    ['test/helpers.js', {}, 'M', 'full'],
    ['test/helpers.js', { 'test/helpers.js': ['test/b.test.js'] }, 'M', 'incremental', ['test/b.test.js']],
    ['test/fixtures/input.json', {}, 'M', 'full'],
    ['test/fixtures/input.json', { 'test/fixtures/**': ['test/b.test.js'] }, 'M', 'incremental', ['test/b.test.js']],
    ['test/runner.js', {}, 'M', 'full'],
    ['package.json', {}, 'M', 'full'],
    ['package.json', { 'package.json': ['test/a.test.js', 'test/b.test.js'] }, 'M', 'incremental', ['test/a.test.js', 'test/b.test.js']],
    ['tools/tests-map.json', { '**': [] }, 'M', 'full'],
    ['value.js', { 'value.js': ['test/missing.test.js'] }, 'M', 'full'],
    ['value.js', { 'value.js': ['value.js'] }, 'M', 'full'],
    ['value.js', null, 'M', 'full'],
    ['value.js', { 'value.js': 'invalid' }, 'M', 'full'],
  ]) {
    const result = select(mapping, [{ path: file, status }], isTest, available, globToRegExp, 'node --test {tests}');
    assert.equal(result.mode, expected, file + JSON.stringify(mapping));
    if (tests) assert.deepEqual(result.tests, tests);
  }
  for (const file of ['package.json', 'Cargo.toml', 'test/run.js', 'test/execute.js', 'test/helpers.js']) {
    const result = select({}, [{ path: file, status: 'M' }], () => true,
      available, globToRegExp, 'node --test {tests}', 'node test/execute.js');
    assert.equal(result.mode, 'full', `broad tests.paths must not hide ${file}`);
  }
});

test('repository seed maps docs contract checks from docs paths', () => {
  const seed = require('../tools/tests-map.json');
  assert.deepEqual(seed['docs/**'], ['test/ci-required.test.js', 'test/shared-files.test.js']);
});

test('incremental revision lineage stops at scope changes and skips retired revisions', () => {
  const { revisions } = require('../lib/tests-incremental');
  const event = (cmd, detail) => ({ task: 'T1', cmd, detail });
  for (const [revision, events, expected] of [
    [1, [], [1]],
    [2, [event('rework', { revision: 2, previous_revision: 1 })], [2, 1]],
    [3, [event('rework', { revision: 3, previous_revision: 2 })], [3, 2]],
    [4, [event('rework', { revision: 4, previous_revision: 1 })], [4, 3]],
    [3, [event('rework', { revision: 2 }), event('restore', { from_revision: 2, revision: 1 }),
      event('rework', { revision: 3, previous_revision: 1 })], [3, 1]],
  ]) {
    assert.deepEqual([...revisions({ id: 'T1', revision }, events)], expected);
  }
});

test('run-only incremental resubmission uses the pinned map without hosted full-suite CI', (t) => {
  const h = incrementalFixture(t);
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-map', '{"docs/**":["test/value.test.js"]}']);
  const full = check(h);
  assert.equal(full.receipt.head_mode, 'full');
  resubmit(h, 'docs/state.md');
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.equal(result.receipt.incremental_from, full.sha);
  assert.deepEqual(result.receipt.head_tests, ['test/value.test.js']);
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('a kept docs-only diff can use incremental selection without a new proof', (t) => {
  const h = incrementalFixture(t, { 'docs/**': ['test/mapped.test.js'] }, ['--tests-keep', '["docs/**"]']);
  h.git(['branch', '-f', 'main', 'HEAD']);
  resubmit(h, 'docs/state.md');
  const result = check(h);
  assert.equal(result.receipt.mode, 'run-only (test-only diff)');
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.equal(result.receipt.incremental_from, h.fullSha);
  assert.deepEqual(result.receipt.changed_files, ['docs/state.md']);
  assert.deepEqual(result.receipt.head_tests, ['test/mapped.test.js']);
  assert.equal(result.commands.filter((c) => c.command !== 'git').length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('incremental evidence requires an audited full anchor, current lineage, policy and ancestry', (t) => {
  const h = incrementalFixture(t);
  resubmit(h, 'docs/state.md');
  check(h);
  const initial = require('../lib/state').loadState(h.state);
  const T = require('../lib/tasks');
  for (const [name, mutate] of [
    ['valid', () => {}],
    ['missing full', (st) => { st.tasks.tasks[0].evidence.shift(); }],
    ['missing audit', (st) => { st.events = st.events.filter((e) => e.cmd !== 'check tests' || e.detail.sha !== h.fullSha); }],
    ['wrong policy', (st) => { st.project.tests.keep = ['docs/**']; }],
    ['scope revision', (st) => { st.events = st.events.filter((e) => e.cmd !== 'rework'); }],
    ['mapped anchor', (st) => { st.tasks.tasks[0].evidence[0].receipt.head_mode = 'mapped'; }],
    ['waived anchor', (st) => { st.tasks.tasks[0].evidence[0].waived = true; }],
    ['wrong anchor', (st) => { st.tasks.tasks[0].evidence.at(-1).receipt.incremental_from = '0'.repeat(40); }],
    ['no ancestor receipt', (st) => {
      st.tasks.tasks[0].evidence.at(-1).commands = st.tasks.tasks[0].evidence.at(-1).commands
        .filter((c) => !c.args.includes('--is-ancestor'));
    }],
  ]) {
    const st = structuredClone(initial);
    mutate(st);
    const task = st.tasks.tasks[0];
    const reason = T.gatePolicyMismatch(task, task.evidence.at(-1), st);
    assert.equal(reason === null, name === 'valid', `${name}: ${reason}`);
  }
});

test('incremental selection sends mapped host-only suites to separate host commands', (t) => {
  const h = fixture(t, null);
  const host = 'test/host.test.js';
  fs.writeFileSync(path.join(h.repo, host), `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('host context', () => {
  if (process.env.TOWER_CRANE_TEST_EXCLUDE) return;
  assert.equal(process.env.TOWER_CRANE_SANDBOX, '0');
  assert.equal(process.env.HOST_OPT_IN, 'yes');
  assert.match(fs.readFileSync('docs/state.md', 'utf8'), /prose/i);
});
`);
  fs.mkdirSync(path.join(h.repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'docs/state.md'), 'Original prose.\n');
  repositoryMap(h, { 'docs/**': [] });
  h.git(['add', '.']);
  h.git(['commit', '--allow-empty', '-qm', 'host suite mapping']);
  h.ok(['project', 'set', '--tests-host-only', JSON.stringify([host]), '--tests-host-env', '{"HOST_OPT_IN":"yes"}']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const full = check(h);
  h.fullSha = full.sha;
  resubmit(h, 'docs/state.md');
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.deepEqual(result.receipt.head_tests, [host]);
  assert.deepEqual(result.receipt.host_only.run, [host]);
  assert.equal(result.receipt.host_only.results[0].ran, 1);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
});

test('docs-only host measurement compares full and incremental resubmissions', {
  skip: process.env.TOWER_CRANE_MEASURE_INCREMENTAL !== '1',
}, (t) => {
  assert.equal(process.env.TOWER_CRANE_SANDBOX, '0', 'the measurement runs on the host');
  const before = [];
  const after = [];
  for (let sample = 0; sample < 3; sample++) {
    const h = incrementalFixture(t);
    resubmit(h, 'docs/state.md');
    const preload = path.join(h.base, 'full-head.js');
    // The old gate always ran the full head command. Disable reuse to measure that same command
    // against the same docs-only head, without changing the task's policy or delta.
    fs.writeFileSync(preload, `require(${JSON.stringify(path.join(ROOT, 'lib/tests-incremental.js'))}).fullPasses = () => [];\n`);
    const measure = (env, mode) => {
      const started = performance.now();
      const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json'], { env });
      const duration = Math.round(performance.now() - started);
      assert.equal(run.code, 0, run.stderr + run.stdout);
      const result = JSON.parse(run.stdout);
      assert.equal(result.receipt.head_mode, mode);
      return { duration_ms: duration, head_mode: mode,
        head_command: result.commands.find((c) => c.command !== 'git').command,
        head_tests: result.receipt.head_tests ?? null };
    };
    before.push(measure({ NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}` }, 'full'));
    after.push(measure({}, 'incremental'));
  }
  const stats = (runs) => {
    const times = runs.map((r) => r.duration_ms).sort((a, b) => a - b);
    return { median_ms: times[1], min_ms: times[0], max_ms: times[2], runs };
  };
  console.log(`Docs-only resubmission measurement: ${JSON.stringify({
    platform: process.platform, node: process.version, fixture: 'two head suites and the unchanged failing-before proof',
    before: stats(before), after: stats(after),
  })}`);
});
