'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');

test('the test runner emits one capped concurrency value, including repeated and split options', (t) => {
  const h = makeRepo(t);
  const runner = path.join(ROOT, 'test/run.js');
  for (const [cores, options, expected] of [
    [32, ['--test-concurrency=4', 'test/claim.test.js', '--test-concurrency=999'], 4],
    [3, ['--test-concurrency=999', 'test/claim.test.js', '--test-concurrency', '999'], 2],
    [32, ['--test-concurrency=4', '--test-concurrency', '2', 'test/claim.test.js'], 2],
    [1, ['test/claim.test.js'], 1],
  ]) {
    const probe = `
      require('node:os').availableParallelism = () => ${cores};
      require('node:child_process').spawnSync = (command, args) => {
        console.log(JSON.stringify(args));
        return { status: 0 };
      };
    `;
    const preload = path.join(h.base, 'runner-probe.js');
    fs.writeFileSync(preload, probe);
    const r = cp.spawnSync(process.execPath, ['--require', preload, runner, ...options], { env: h.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const args = JSON.parse(r.stdout);
    assert.deepEqual(args.filter((arg) => arg.startsWith('--test-concurrency')), [`--test-concurrency=${expected}`]);
    assert.deepEqual(args.filter((arg) => !arg.startsWith('--')), ['test/claim.test.js']);
  }
});

test('mutation fallback requires a green baseline in a copy containing all test inputs', (t) => {
  const h = makeRepo(t);
  const write = (file, text) => {
    const target = path.join(h.repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const file of ['test/run.js', 'test/global-setup.js', 'test/repo-seed.js']) {
    write(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  write('test/gates/.keep', '');
  write('lib/gates/merge.js', `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  write('test/stack-merge.test.js', `require('node:test')('scoped survivor', () => {});\n`);
  const inputs = ['.github/workflows/ci.yml', 'AGENTS.md', 'hooks/hook.js'];
  for (const file of inputs) write(file, 'copied input\n');
  const baseline = `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('fallback inputs', () => {
      for (const file of ${JSON.stringify(inputs)}) assert.equal(require('node:fs').readFileSync(file, 'utf8'), 'copied input\\n');
    });
  `;
  const run = () => cp.spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/mutants.js'), '--root', h.repo, '--jobs', '1', '--only', 'stack-merge-unaccepted-lower',
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, encoding: 'utf8', timeout: 60000 });

  write('test/fallback.test.js', baseline + `
    test('unaccepted lower', () => {
      assert.equal(require('../lib/gates/merge')({ id: 'T1', status: 'submitted' }, { mergedIds: ['T1'] }), false);
    });
  `);
  const caught = run();
  assert.equal(caught.status, 0, caught.stdout + caught.stderr);
  assert.match(caught.stdout, /caught.*stack-merge-unaccepted-lower \(full suite\)/);

  write('test/fallback.test.js', baseline);
  const survivor = run();
  assert.equal(survivor.status, 1, survivor.stderr);
  assert.match(survivor.stdout, /MISSED.*stack-merge-unaccepted-lower/);

  write('test/fallback.test.js', baseline + `test('broken baseline', () => assert.fail('fixture baseline fails'));\n`);
  const broken = run();
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /the unmutated full suite fails/);
  assert.doesNotMatch(broken.stdout, /caught.*stack-merge-unaccepted-lower/);
});
