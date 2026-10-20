'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, makeRepo } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const { testFiles, shardFiles, fileDurations } = require('./run');
const { declarations, fileTimes, mergeTable } = require('../scripts/test-durations');

const FIXTURES = ['a', 'b', 'c', 'd'].map((name) => path.join('test', 'fixtures', 'shard', `${name}.test.js`));

test('shardFiles splits files of equal or unknown time like every total-th file of the sorted list', () => {
  const list = ['e', 'c', 'a', 'd', 'b'];
  assert.deepEqual(shardFiles(list, 1, 1), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(shardFiles(list, 1, 2), ['a', 'c', 'e']);
  assert.deepEqual(shardFiles(list, 2, 2), ['b', 'd']);
  assert.deepEqual(shardFiles(list, 3, 3), ['c']);
  assert.deepEqual(shardFiles(list, 6, 6), []);
  assert.deepEqual(list, ['e', 'c', 'a', 'd', 'b'], 'the input is not reordered');
});

test('shardFiles gives each shard an equal share of the measured time', () => {
  const durations = { a: 10, b: 1, c: 1, d: 1, e: 7 };
  const files = ['e', 'd', 'c', 'b', 'a'];
  // Every other file would put a, c and e (18 s) against b and d (2 s).
  assert.deepEqual(shardFiles(files, 1, 2, durations), ['a']);
  assert.deepEqual(shardFiles(files, 2, 2, durations), ['b', 'c', 'd', 'e']);
  // A file the table does not list counts as its median file, 2 s here.
  const known = { a: 9, b: 1, c: 2 };
  assert.deepEqual(shardFiles(['a', 'b', 'c', 'new'], 1, 2, known), ['a']);
  assert.deepEqual(shardFiles(['a', 'b', 'c', 'new'], 2, 2, known), ['b', 'c', 'new']);
  assert.deepEqual(shardFiles(['x', 'y'], 1, 2, {}), ['x'], 'an empty table splits like equal times');
});

test('every shard count covers the real suite with each file in exactly one shard', () => {
  const files = testFiles();
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const total of [1, 2, 3, 4]) {
      const shards = Array.from({ length: total }, (_, i) => shardFiles(files, i + 1, total, fileDurations(platform)));
      assert.deepEqual(shards.flat().sort(), files, `${platform}: ${total} shards run every file once`);
      for (const shard of shards) assert.ok(shard.length > 0, `${platform}: ${total} shards leave none empty`);
    }
  }
});

test('the checked-in durations split each CI platform into three shards within a tenth of each other', () => {
  const files = testFiles();
  for (const platform of ['linux', 'win32']) {
    const durations = fileDurations(platform);
    assert.ok(Object.keys(durations).length > files.length / 2, `${platform} has measured times`);
    const known = Object.values(durations).sort((a, b) => a - b);
    const cost = (file) => durations[file] ?? known[Math.floor(known.length / 2)];
    const loads = [1, 2, 3].map((i) => shardFiles(files, i, 3, durations).reduce((sum, file) => sum + cost(file), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / 3;
    assert.ok(Math.max(...loads) <= mean * 1.1, `${platform} shard seconds ${loads.map(Math.round).join(', ')}`);
  }
});

test('the durations refresh maps each logged title to the file that declares it', () => {
  const declared = [
    ...declarations('test/a.test.js', "test('plain title', () => {});\nfor (const n of [1, 2]) test(`case ${n} of a`, () => {});\n"
      + "describe('suite of a', () => { test('inner', () => {}); });\n"),
    ...declarations('test/b.test.js', "test(failing ? 'b fails' : `b passes on ${platform}`, { skip: false }, () => {});\n"
      + "test(`case ${n} of ${'a'}`, () => {});\n"),
  ];
  const log = [
    '2026-10-15T09:41:54.3802186Z ##[group]Run npm run check:shared',
    '2026-10-15T09:41:54.4802186Z ✔ plain title (9000ms)',
    '2026-10-15T09:41:54.5802186Z ##[group]Run npm test',
    '2026-10-15T09:41:55.0000000Z ✔ plain title (1000ms)',
    '2026-10-15T09:41:55.0000000Z ✔ case 1 of a (2000ms)',
    '2026-10-15T09:41:55.0000000Z ✖ case 2 of a (3000ms)',
    '2026-10-15T09:41:55.0000000Z   ✔ inner (500ms)',
    '2026-10-15T09:41:55.0000000Z ✔ suite of a (4000ms)',
    '2026-10-15T09:41:55.0000000Z ✔ b passes on win32 (5000ms)',
    '2026-10-15T09:41:55.0000000Z ﹣ b fails (1ms) # SKIP',
    '2026-10-15T09:41:55.0000000Z ✔ a title no file declares (7000ms)',
    '2026-10-15T09:41:56.0000000Z ✖ failing tests:',
    '2026-10-15T09:41:56.0000000Z ✖ case 2 of a (3000ms)',
    '2026-10-15T09:41:57.0000000Z ##[group]Run foreach ($attempt in 1..10) {',
    '2026-10-15T09:41:57.0000000Z ✔ plain title (9000ms)',
  ].join('\r\n');
  const { times, unmatched } = fileTimes(log, declared);
  // `case ${n} of a` in a.test.js has more literal text than b.test.js's `case ${n} of ${'a'}`.
  assert.deepEqual(times, { 'test/a.test.js': 10, 'test/b.test.js': 5.001 });
  assert.equal(unmatched, 7);
});

test('TC_TEST_SHARD makes the runner run only the files of the shard it names', () => {
  const run = (shard) => cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js'), '--test-reporter=tap', ...FIXTURES], {
    cwd: ROOT, encoding: 'utf8', timeout: HUNG_TEST_MS, env: { ...process.env, TC_TEST_SHARD: shard },
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

test('a shard logs each file as it starts and ends, and past its deadline prints what still runs, stops it and fails', (t) => {
  // The deadline stops the nested run before its global teardown, so its seed lives in this test's fixture.
  const h = makeRepo(t);
  const run = (files, extra) => cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.js'), ...files], {
    cwd: ROOT, encoding: 'utf8', timeout: HUNG_TEST_MS,
    env: { ...process.env, TOWER_CRANE_TEST_TMP: h.base, TC_TEST_SHARD: '1/1', ...extra },
  });
  const done = run([FIXTURES[0]], {});
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^file started: .*a\.test\.js$/m);
  assert.match(done.stdout, /^file ended: .*a\.test\.js$/m);
  assert.match(done.stdout, /✔ shard a/, 'the spec reporter still prints each test');

  const hang = path.join('test', 'fixtures', 'shard', 'hang.test.js');
  const late = run([FIXTURES[0], hang], { TC_TEST_SHARD_DEADLINE_MIN: '0.1' });
  assert.equal(late.status, 1, late.stdout + late.stderr);
  assert.match(late.stdout, /^file started: .*hang\.test\.js$/m);
  assert.doesNotMatch(late.stdout, /^file ended: .*hang\.test\.js$/m);
  assert.match(late.stderr, /shard deadline of 0\.1 min reached; processes still running/);
  assert.match(late.stderr, /^ {2}\d+ \d+ .*hang\.test\.js/m, 'the dump names the hung file\'s process');
});

test('a durations refresh from a run with a failed shard keeps the old times of the files it did not measure', () => {
  const before = { linux: { 'test/a.test.js': 10, 'test/b.test.js': 20, 'test/gone.test.js': 5 }, win32: { 'test/a.test.js': 30 } };
  // Only the shard with a.test.js and the new c.test.js succeeded, on Linux only.
  const samples = { linux: { 'test/a.test.js': [12, 14], 'test/c.test.js': [3] } };
  const { table, changes } = mergeTable(before, samples, ['test/a.test.js', 'test/b.test.js', 'test/c.test.js']);
  assert.deepEqual(table, {
    linux: { 'test/a.test.js': 13, 'test/b.test.js': 20, 'test/c.test.js': 3 },
    win32: { 'test/a.test.js': 30 },
  });
  assert.deepEqual(changes.linux, { measured: ['test/a.test.js', 'test/c.test.js'], kept: ['test/b.test.js'],
    added: ['test/c.test.js'], dropped: ['test/gone.test.js'] });
  assert.deepEqual(changes.win32, { measured: [], kept: ['test/a.test.js'], added: [], dropped: [] });
});
