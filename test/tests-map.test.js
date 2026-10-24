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

test('the checked-in import seed has valid paths and supplies CLI map entries', async (t) => {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/tests-map.json'), 'utf8'));
  assert.ok(seed && typeof seed === 'object' && !Array.isArray(seed));
  const rows = [
    ['checked-in seed', seed, true],
    ['array instead of map', [], false],
    ['escaping source', { ...seed, '../outside.js': [] }, false],
    ['escaping suite', { ...seed, 'bin/tower-crane.js': ['../outside.test.js'] }, false],
    ['suite glob', { ...seed, 'bin/tower-crane.js': ['test/*.test.js'] }, false],
    ['scalar suite', { ...seed, 'bin/tower-crane.js': 'test/commands.test.js' }, false],
  ];
  for (const [name, value, valid] of rows) {
    await t.test(name, () => {
      assert.equal(require('../lib/tests-map').settingError(value) === null, valid);
    });
  }
  assert.ok(Array.isArray(seed['bin/tower-crane.js']));
  // A representative entry keeps the CLI argument within Windows' command-line limit.
  const selected = { 'bin/tower-crane.js': seed['bin/tower-crane.js'] };
  const h = makeRepo(t);
  h.init(['--tests-map', JSON.stringify(selected)]);
  assert.deepEqual(h.json(['project', 'show']).tests.map, selected);
});

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

test('mapped selection overlays declarations at submitted head and keeps policy-bound evidence', (t) => {
  const h = fixture(t, { '**/*.md': [] });
  const before = h.readState('project.json');
  fs.writeFileSync(path.join(h.repo, 'tests-map.declared.json'), '{"value.js":["test/value.test.js"]}\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'declare new source']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'mapped', result.summary);
  assert.deepEqual(result.receipt.head_tests, ['test/value.test.js']);
  assert.deepEqual(h.readState('project.json'), before);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
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
