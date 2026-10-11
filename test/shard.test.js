'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT } = require('./helpers');
const { testFiles, shardFiles } = require('./run');

const FIXTURES = ['a', 'b', 'c', 'd'].map((name) => path.join('test', 'fixtures', 'shard', `${name}.test.js`));

test('shardFiles takes every total-th file of the sorted list', () => {
  const list = ['e', 'c', 'a', 'd', 'b'];
  assert.deepEqual(shardFiles(list, 1, 1), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(shardFiles(list, 1, 2), ['a', 'c', 'e']);
  assert.deepEqual(shardFiles(list, 2, 2), ['b', 'd']);
  assert.deepEqual(shardFiles(list, 3, 3), ['c']);
  assert.deepEqual(shardFiles(list, 6, 6), []);
  assert.deepEqual(list, ['e', 'c', 'a', 'd', 'b'], 'the input is not reordered');
});

test('every shard count covers the real suite with each file in exactly one shard', () => {
  const files = testFiles();
  for (const total of [1, 2, 3, 4]) {
    const shards = Array.from({ length: total }, (_, i) => shardFiles(files, i + 1, total));
    assert.deepEqual(shards.flat().sort(), files, `${total} shards run every file once`);
    for (const shard of shards) assert.ok(shard.length > 0, `${total} shards leave none empty`);
  }
});

test('TC_TEST_SHARD makes the runner run only the files of the shard it names', () => {
  const run = (shard) => cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js'), '--test-reporter=tap', ...FIXTURES], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, TC_TEST_SHARD: shard },
  });
  const subtests = (stdout) => [...stdout.matchAll(/^# Subtest: (.+)$/gm)].map(([, name]) => name);

  const second = run('2/3');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(subtests(second.stdout), ['shard b'], 'shard 2 of 3 takes the second sorted file');

  const past = run('5/5');
  assert.equal(past.status, 0, past.stderr);
  assert.deepEqual(subtests(past.stdout), []);
  assert.match(past.stdout, /TC_TEST_SHARD 5\/5 has no test files/);

  const invalid = run('4/3');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /TC_TEST_SHARD requires INDEX\/TOTAL/);
});
