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

test('crucial configuration preserves its proof and run-only policy after a full anchor', (t) => {
  for (const mode of ['prove', 'run-only']) {
    const h = incrementalFixture(t);
    h.ok(['project', 'set', '--tests-mode', mode,
      '--tests-map', JSON.stringify({ 'value.js': ['test/value.test.js'], '**/*.md': [] }),
      '--tests-crucial', '["test/mapped.test.js"]']);
    const before = check(h);
    assert.equal(before.receipt.head_mode, mode === 'prove' ? 'crucial' : 'full');
    resubmit(h, 'docs/state.md');
    const result = check(h);
    assert.equal(result.receipt.head_mode, mode === 'prove' ? 'crucial' : 'full', mode);
    assert.equal(result.receipt.incremental_from, undefined, mode);
    if (mode === 'prove') assert.ok(result.receipt.head_tests.includes('test/mapped.test.js'));
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'tests').ok, true, mode);
  }
});

test('incremental head native reruns preserve accepted receipts in prove and run-only modes', {
  skip: process.platform === 'win32' && 'POSIX native-crash fixture',
}, (t) => {
  const { nativeCrashTest } = require('./gates/helpers');
  for (const mode of ['prove', 'run-only']) {
    const h = fixture(t, null);
    const marker = path.join(h.base, 'native-once');
    fs.writeFileSync(marker, 'x');
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'test/crash.test.js'), nativeCrashTest({ marker }));
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'native recovery suite']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', 'main']);
    repositoryMap(h, { 'docs/**': ['test/crash.test.js', 'test/mapped.test.js'], '**/*.md': [] });
    h.ok(['project', 'set', '--ci-required', '[]', '--tests-mode', mode]);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
    assert.equal(check(h).receipt.head_mode, 'full');
    resubmit(h, 'docs/state.md');
    fs.rmSync(marker);
    const result = check(h);
    assert.equal(result.receipt.head_mode, 'incremental', mode);
    assert.deepEqual(result.receipt.reruns, [{ step: 'head', files: ['test/crash.test.js'], ok: true }], mode);
    assert.equal(result.native_crash.length, 1, mode);
    assert.equal(result.flaky[0].native_crash, true, mode);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'tests').ok, true, mode);
  }
});

test('incremental failing suites rerun once without repeating passing suites in prove and run-only modes', (t) => {
  for (const mode of ['prove', 'run-only']) for (const failures of [1, 2]) {
    const name = `${mode}, ${failures} failures`;
    const h = fixture(t, null);
    const marker = path.join(h.base, 'attempts');
    const counted = path.join(h.base, 'passing-runs');
    fs.writeFileSync(marker, '2');
    h.git(['switch', 'main']);
    fs.writeFileSync(path.join(h.repo, 'test/flaky.test.js'), `const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('sometimes fails', () => {
  if (require('../value.js') === 0) return;
  const file = ${JSON.stringify(marker)};
  const attempts = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0; // read-published: the gate starts each counter writer only after the previous writer exits
  fs.writeFileSync(file, String(attempts + 1));
  assert.ok(attempts >= ${failures}, 'first attempts fail');
});
`);
    fs.writeFileSync(path.join(h.repo, 'test/mapped.test.js'),
      `require('node:fs').appendFileSync(${JSON.stringify(counted)}, 'x');\n`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'rerun suites']);
    h.git(['switch', 'fixture-change']);
    h.git(['merge', '--no-edit', 'main']);
    repositoryMap(h, { 'docs/**': ['test/flaky.test.js', 'test/mapped.test.js'], '**/*.md': [] });
    h.ok(['project', 'set', '--ci-required', '[]', '--tests-mode', mode]);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
    assert.equal(check(h).receipt.head_mode, 'full', name);
    resubmit(h, 'docs/state.md');
    fs.rmSync(marker);
    fs.rmSync(counted);
    const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
    assert.equal(run.code, failures === 1 ? 0 : 1, name + run.stdout + run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.receipt.head_mode, 'incremental', name);
    assert.deepEqual(result.receipt.reruns, [{ step: 'head', files: ['test/flaky.test.js'], ok: failures === 1 }], name);
    assert.equal(fs.readFileSync(marker, 'utf8'), '2', name);
    assert.equal(fs.readFileSync(counted, 'utf8'), 'x', `${name}: passing suite runs once`);
    assert.equal(result.flaky?.length ?? 0, failures === 1 ? 1 : 0, name);
    if (failures === 1) assert.match(result.summary, /exit 1, then exit 0 on its rerun/);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'tests').ok, failures === 1, name);
  }
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
    ['skills/tower-crane/SKILL.md', ['test/isolation-broker.test.js']],
    ['docs/ladder.md', ['test/isolation-broker.test.js', 'test/ci-required.test.js', 'test/shared-files.test.js']],
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

test('incremental seed covers every packed markdown path without lexical readers', () => {
  const { select } = require('../lib/tests-incremental');
  const { globToRegExp } = require('../lib/gates/tests');
  const seed = require('../tools/tests-map.json');
  const isTest = (p) => p.endsWith('.test.js');
  const available = new Set(['test/package.test.js', 'test/ci-required.test.js', 'test/docs.test.js', 'test/shared-files.test.js']);
  for (const file of [
    'agents/tower-crane-small.md', 'agents/tower-crane-researcher.md', 'agents/tower-crane-orchestrator.md',
    'commands/tower-crane-inbox.md', 'skills/tower-crane-work/SKILL.md', 'standards/default.md',
    'docs/state.md', 'docs/state/tasks.md', 'docs/state/ci.md', 'docs/cli.md', 'docs/ladder.md', 'docs/automation.md', 'docs/design.md',
    'README.md', 'CHANGELOG.md', 'LICENSE.md', 'bin/help.md', 'lib/help.md', 'hooks/help.md', '.claude-plugin/help.md',
  ]) {
    const result = select(seed, [{ path: file, status: 'M' }], isTest, available,
      globToRegExp, 'node --test {tests}');
    if (/^(bin|lib|hooks)\//.test(file)) assert.equal(result.mode, 'full', file);
    else {
      assert.equal(result.mode, 'incremental', file);
      assert.ok(result.tests.includes('test/package.test.js'), `${file} must run the package link check`);
    }
  }
});

test('incremental CLI runs runtime-discovered package readers for a broken agent link', (t) => {
  const h = fixture(t, null);
  h.git(['switch', 'main']);
  fs.mkdirSync(path.join(h.repo, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'agents/tower-crane-small.md'), 'Valid agent.\n');
  fs.writeFileSync(path.join(h.repo, 'test/package.test.js'), `const fs = require('node:fs');
const assert = require('node:assert/strict');
for (const file of fs.readdirSync('agents')) {
  assert.doesNotMatch(fs.readFileSync('agents/' + file, 'utf8'), /research\\//);
}
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'runtime package reader']);
  h.git(['switch', 'fixture-change']);
  h.git(['merge', '--no-edit', 'main']);
  repositoryMap(h, require('../tools/tests-map.json'));
  h.ok(['project', 'set', '--ci-required', '[]']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  assert.equal(check(h).receipt.head_mode, 'full');
  resubmit(h, 'agents/tower-crane-small.md', '[x](../research/notes.md)\n');
  const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
  assert.equal(run.code, 1, run.stderr + run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.receipt.head_mode, 'incremental');
  assert.ok(result.receipt.head_tests.includes('test/package.test.js'));
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
    ['package.json', { 'package.json': ['test/a.test.js', 'test/b.test.js'] }, 'M', 'full'],
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

test('runtime modules loaded by name or through the CLI always retain full incremental coverage', () => {
  const { select } = require('../lib/tests-incremental');
  const { globToRegExp } = require('../lib/gates/tests');
  const seed = require('../tools/tests-map.json');
  const suites = ['test', 'test/gates'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .filter(name => name.endsWith('.test.js')).map(name => `${dir}/${name}`)).sort();
  const isTest = p => p.endsWith('.test.js');
  for (const file of [
    'lib/gates/merge.js', 'lib/gates/clean.js', 'lib/gates/sources.js',
    'lib/spawn-monitor.js', 'lib/settings.js', 'lib/hook-stream.js', 'lib/read-guard.js',
    'lib/new-by-name-handler.js', 'bin/tower-crane.js', 'hooks/tower-crane.mjs',
    'test/run.js', 'test/global-setup.js', 'test/custom-runner.js',
  ]) {
    const command = file === 'test/custom-runner.js' ? `node ${file}` : 'npm test';
    const result = select(seed, [{ path: file, status: 'M' }], isTest, new Set(suites),
      globToRegExp, 'node test/run.js {tests}', command);
    assert.equal(result.mode, 'full', `${file}: an import map cannot prove indirect CLI coverage`);
    if (file in seed && /^(lib|bin|hooks)\//.test(file)) {
      assert.deepEqual(seed[file], suites, `${file}: generated coverage must include every CLI suite`);
    }
  }
  assert.ok(seed['lib/gates/merge.js'].includes('test/merge-options.test.js'),
    'the reported merge.admin plant must reach its regression suite');
});

test('a resubmission touching a by-name gate runs the pinned full command', (t) => {
  const h = incrementalFixture(t, { 'lib/gates/merge.js': ['test/mapped.test.js'] });
  resubmit(h, 'lib/gates/merge.js', 'module.exports = 1;\n');
  const result = check(h);
  assert.equal(result.receipt.head_mode, 'full');
  assert.equal(result.commands.find(c => c.command !== 'git').command, fullCommand);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find(g => g.type === 'tests').ok, true);
});

test('incremental CLI contract covers anchors, seed trust and empty head receipts', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'docs/cli.md'), 'utf8');
  const state = fs.readFileSync(path.join(ROOT, 'docs/state/tasks.md'), 'utf8');
  for (const text of [cli, state]) {
    assert.ok(text.includes('incremental_from'));
    assert.match(text, /empty incremental selections/);
    assert.match(text, /merge base/);
  }
  assert.match(cli, /incremental.*earlier.*full pass/);
  assert.match(cli, /shared.*runtime.*full/i);
  const publish = fs.readFileSync(path.join(ROOT, 'docs/state/ci.md'), 'utf8');
  assert.match(publish, /full_suite.*incremental.*earlier full pass/);
  assert.ok(fs.readFileSync(path.join(ROOT, 'scripts/cli-reference.md'), 'utf8').includes('incremental_from'));
});

test('repository seed maps docs contract checks from docs and CLI source paths', () => {
  const { select } = require('../lib/tests-incremental');
  const { testMatcher, isSupportFile, globToRegExp } = require('../lib/gates/tests');
  const matcher = testMatcher({ base: 'main' });
  const isTest = file => matcher.match(file) && !isSupportFile(file);
  const available = new Set(['test', 'test/gates'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .map(file => `${dir}/${file}`)).filter(isTest));
  const seed = require('../tools/tests-map.json');
  const checks = ['test/ci-required.test.js', 'test/docs.test.js', 'test/shared-files.test.js'];
  assert.deepEqual(seed['docs/**'], checks);
  assert.deepEqual(seed['scripts/cli-reference.md'], checks);
  for (const file of ['docs/state.md', 'docs/cli.md', 'scripts/cli-reference.md',
    ...['ci', 'containment', 'decisions', 'gates', 'review', 'stacks', 'storage', 'tasks']
      .map(area => `docs/state/${area}.md`)]) for (const status of ['A', 'M', 'D']) {
    const selection = select(seed, [{ path: file, status }], isTest, available,
      globToRegExp, 'node test/run.js {tests}');
    assert.equal(selection.mode, 'incremental', `${file}: ${status}`);
    for (const suite of checks) assert.ok(selection.tests.includes(suite), `${file}: ${status} needs ${suite}`);
  }
});

test('incremental runner helpers select their consumers and unknown helpers retain full coverage', () => {
  const { select } = require('../lib/tests-incremental');
  const { globToRegExp, testMatcher } = require('../lib/gates/tests');
  const isTestFile = testMatcher({ tests: { paths: ['test/*.test.js', 'test/gates/*.test.js'] } }).match;
  const seed = require('../tools/tests-map.json');
  const available = new Set(['test', 'test/gates'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .map(file => `${dir}/${file}`)).filter(isTestFile));
  for (const [file, mode] of [
    ['test/shard-watchdog.js', 'incremental'],
    ['test/file-progress.js', 'incremental'],
    ['test/unmapped-runner-helper.js', 'full'],
    ['test/gates/unmapped-helper.js', 'full'],
    ['test/helpers/unmapped-helper.js', 'full'],
  ]) for (const status of ['A', 'M', 'D']) {
    const result = select(seed, [{ path: file, status }], isTestFile, available,
      globToRegExp, 'node test/run.js {tests}', '', ['test/shared-files.test.js', 'test/atomic-file.test.js']);
    assert.equal(result.mode, mode, `${file}: ${status}`);
    if (mode === 'incremental') assert.ok(result.tests.includes('test/shard.test.js'), `${file}: ${status}`);
  }
});

test('incremental seed selects directory readers for every delta status and nested path', () => {
  const { select } = require('../lib/tests-incremental');
  const { globToRegExp, isTestFile, isSupportFile } = require('../lib/gates/tests');
  const seed = require('../tools/tests-map.json');
  const isTest = file => isTestFile(file) && !isSupportFile(file);
  const available = new Set(['test/shared-files.test.js', 'test/package.test.js', 'test/model-config.test.js',
    'test/epipe.test.js', 'test/new.test.js', 'test/gates/new.test.js', 'test/atomic-file.test.js', 'test/shard.test.js']);
  const uncovered = [];
  for (const [changes, reader] of [
    [[['changelog.d/T427.md', 'M']], 'test/shared-files.test.js'],
    [[['changelog.d/new.md', 'A']], 'test/shared-files.test.js'],
    [[['changelog.d/old.md', 'D']], 'test/shared-files.test.js'],
    [[['changelog.d/old.md', 'D'], ['changelog.d/new.md', 'A']], 'test/shared-files.test.js'],
    [[['changelog.d/invalid.txt', 'A']], 'test/shared-files.test.js'],
    [[['test/epipe.test.js', 'M']], 'test/shared-files.test.js'],
    [[['test/new.test.js', 'A']], 'test/shared-files.test.js'],
    [[['test/old.test.js', 'D']], 'test/shared-files.test.js'],
    [[['test/old.test.js', 'D'], ['test/new.test.js', 'A']], 'test/shared-files.test.js'],
    [[['test/gates/new.test.js', 'A']], 'test/shared-files.test.js'],
    [[['test/fixtures/nested/input.js', 'M']], 'test/shared-files.test.js'],
    [[['test/fixtures/nested/input.json', 'M']], 'test/model-config.test.js'],
    [[['test/fixtures/npm-pack/string.json', 'M']], 'test/package.test.js'],
    [[['research/new.json', 'A']], 'test/model-config.test.js'],
    ...['A', 'M', 'D'].flatMap(status => [
      [[['test/fixtures/clock.js', status]], 'test/atomic-file.test.js'],
      [[['test/fixtures/nested/input.js', status]], 'test/atomic-file.test.js'],
      [[['test/new.test.js', status]], 'test/atomic-file.test.js'],
      [[['test/gates/new.test.js', status]], 'test/atomic-file.test.js'],
      [[['test/fixtures/shard/a.test.js', status]], 'test/shard.test.js'],
    ]),
  ]) {
    const suites = new Set([...available, ...Object.values(seed).flat()]);
    const result = select(seed, changes.map(([path, status]) => ({ path, status })), isTest, suites,
      globToRegExp, 'node test/run.js {tests}');
    if (result.mode !== 'incremental' || !result.tests.includes(reader)) uncovered.push({ changes, reader, result });
  }
  assert.deepEqual(uncovered, []);
});

test('incremental CLI rejects fragment, suite, fixture and runner defects through their readers', async (t) => {
  const seed = Object.fromEntries(Object.entries(require('../tools/tests-map.json'))
    .filter(([source]) => source.includes('*') || ['test/shard-watchdog.js', 'test/file-progress.js'].includes(source)));
  const atomic = fs.readFileSync(path.join(ROOT, 'test/atomic-file.test.js'), 'utf8');
  assert.ok(atomic.includes("test('fixtures publish the files they write through writeAtomic'"),
    'the CLI regression must use the repository publication reader');
  assert.ok(atomic.includes('function secondArgument('),
    'the CLI regression must use the repository write-call parser');
  const producer = atomic.match(/test\('fixtures publish the files they write through writeAtomic',[\s\S]*?\n\}\);/)[0];
  const argument = atomic.match(/function secondArgument\([\s\S]*?\n\}/)[0];
  for (const [file, content, error, reader] of [
    ['changelog.d/probe.md', '- Broken fragment ' + String.fromCodePoint(0x2014) + '.\n',
      /nonempty Markdown bullet without em dashes/, 'test/shared-files.test.js'],
    ['test/probe.test.js', [
      "require('node:test')('probe wait', async () => {",
      '  await new Promise((resolve) => setTimeout(resolve, 5));', // wait-allow: generate an unannotated timer for the mapped lint reader to reject
      '});\n',
    ].join('\n'), /timer wait needs a signal or a wait-allow reason/, 'test/shared-files.test.js'],
    ['test/fixtures/clock.js', "module.exports = () => require('node:fs').writeFileSync('unobserved', 'tick');\n",
      /use writeAtomic/, 'test/atomic-file.test.js'],
    ...['test/shard-watchdog.js', 'test/file-progress.js'].map(file =>
      [file, "process.exit(0);\nconsole.log('runner active');\n", /runner helper contracts/, 'test/shard.test.js']),
  ]) {
    await t.test(file, () => {
      const h = incrementalFixture(t, seed, [], h => {
        h.ok(['project', 'set', '--tests-paths', '["test/*.test.js","test/gates/*.test.js"]']);
        h.git(['switch', 'main']);
        fs.mkdirSync(path.join(h.repo, 'changelog.d'), { recursive: true });
        fs.writeFileSync(path.join(h.repo, 'changelog.d/probe.md'), '- Valid fragment.\n');
        fs.writeFileSync(path.join(h.repo, 'test/probe.test.js'), "require('node:test')('probe', () => {});\n");
        fs.writeFileSync(path.join(h.repo, 'test/package.test.js'), "console.log('package suite');\n");
        for (const suite of ['ci-required', 'test-tools']) {
          fs.writeFileSync(path.join(h.repo, 'test', `${suite}.test.js`), "console.log('runner consumer suite');\n");
        }
        fs.mkdirSync(path.join(h.repo, 'test/fixtures'), { recursive: true });
        fs.writeFileSync(path.join(h.repo, 'test/fixtures/clock.js'), 'module.exports = 0;\n');
        fs.writeFileSync(path.join(h.repo, 'test/atomic-file.test.js'), `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FIXTURES = path.join(__dirname, 'fixtures');
${producer}
${argument}
`);
        for (const helper of ['shard-watchdog.js', 'file-progress.js']) {
          fs.writeFileSync(path.join(h.repo, 'test', helper), "console.log('runner active');\n");
        }
        fs.writeFileSync(path.join(h.repo, 'test/shard.test.js'), `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
test('runner helper contracts', () => {
  for (const name of fs.readdirSync(__dirname).filter(name => /-(watchdog|progress)\\.js$/.test(name))) {
    const result = cp.spawnSync(process.execPath, [path.join(__dirname, name)], { encoding: 'utf8', timeout: 300000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /runner active/);
  }
});
`);
        fs.writeFileSync(path.join(h.repo, 'test/shared-files.test.js'), `const { test } = require('node:test');
const { fragments } = require(${JSON.stringify(path.join(ROOT, 'scripts/changelog.js'))});
const { checkTestWaits } = require(${JSON.stringify(path.join(ROOT, 'scripts/test-waits.js'))});
test('directory reader contracts', () => {
  fragments(process.cwd());
  checkTestWaits(process.cwd());
});
`);
        h.git(['add', '.']);
        h.git(['commit', '-qm', 'directory reader contracts']);
        h.git(['switch', 'fixture-change']);
        h.git(['merge', '--no-edit', 'main']);
      });
      resubmit(h, file, content);
      const run = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
      const result = JSON.parse(run.stdout);
      assert.equal(run.code, 1, `${file}: ${run.stderr}\n${run.stdout}`);
      assert.equal(result.receipt.head_mode, 'incremental');
      assert.equal(result.receipt.incremental_from, h.fullSha);
      assert.ok(result.receipt.head_tests.includes(reader), file);
      assert.match(result.summary, error);
    });
  }
});

test('repository seed declares suites consuming JSON data that V8 cannot measure', () => {
  const seed = require('../tools/tests-map.json');
  for (const [file, suite] of [
    ['tools/model-literals.json', 'test/model-config.test.js'],
    ['tools/tests-map.json', 'test/tests-map.test.js'],
  ]) {
    assert.deepEqual(seed[file], [suite], file);
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.ok(data && typeof data === 'object', file);
  }
});

test('repository seed matches the current generated coverage', () => {
  const generated = require('node:child_process').execFileSync(process.execPath,
    [path.join(ROOT, 'tools/tests-map.js')], { cwd: ROOT, encoding: 'utf8', maxBuffer: Infinity });
  assert.deepEqual(require('../tools/tests-map.json'), JSON.parse(generated));
});

test('incremental revision lineage stops at scope changes and skips retired revisions', () => {
  const { revisions } = require('../lib/tests-incremental');
  const event = (cmd, detail) => ({ task: 'T1', cmd, detail });
  for (const [revision, events, expected] of [
    [1, [], [1]],
    [2, [event('rework', { revision: 2, previous_revision: 1 })], [2, 1]],
    [3, [event('rework', { revision: 3, previous_revision: 2 })], [3, 2]],
    [4, [event('rework', { revision: 4, previous_revision: 1 })], [4, 1]],
    [6, [event('rework', { revision: 6, previous_revision: 2 }),
      event('rework', { revision: 2, previous_revision: 1 })], [6, 2, 1]],
    [3, [event('rework', { revision: 3, previous_revision: 3 })], [3]],
    [3, [event('rework', { revision: 3, previous_revision: null })], [3]],
    [3, [event('rework', { revision: 3, previous_revision: 4 })], [3]],
    [3, [event('rework', { revision: 2 }), event('restore', { from_revision: 2, revision: 1 }),
      event('rework', { revision: 3, previous_revision: 1 })], [3, 1]],
  ]) {
    assert.deepEqual([...revisions({ id: 'T1', revision }, events)], expected);
  }
});

test('same-head full receipts use SHA prefix matching in the fallback reason', (t) => {
  const h = incrementalFixture(t);
  const initial = h.readState('tasks.json');
  for (const sha of [h.fullSha, h.fullSha.slice(0, 12), h.fullSha.slice(0, 8)]) {
    const state = structuredClone(initial);
    state.tasks[0].evidence.at(-1).sha = sha;
    h.writeState('tasks.json', state);
    const result = check(h);
    assert.equal(result.receipt.head_mode, 'full');
    assert.doesNotMatch(result.receipt.head_reason, /no longer matches/, sha);
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
