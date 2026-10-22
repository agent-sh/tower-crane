'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, makeRepo } = require('./helpers');
const { HUNG_TEST_MS, killPid } = require('./signals');
const { testFiles, shardFiles, longestFirst, startOrder, fileDurations } = require('./run');
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

test('longestFirst starts the longest measured files first and keeps sorted order among equal times', () => {
  const durations = { a: 1, b: 9, c: 1, d: 5 };
  const files = ['d', 'c', 'b', 'a', 'new'];
  // The new file counts as the median, 5 s here, and ties keep the sorted order.
  assert.deepEqual(longestFirst(files, durations), ['b', 'd', 'new', 'a', 'c']);
  assert.deepEqual(files, ['d', 'c', 'b', 'a', 'new'], 'the input is not reordered');
  assert.deepEqual(longestFirst(['y', 'x'], {}), ['x', 'y'], 'an empty table keeps the sorted order');
  assert.deepEqual(startOrder(['b', 'a'], 1, durations), ['b', 'a'], 'two files for one worker both start at once');
});

test('startOrder spells the longest files so that node --test sorts them first, one band per worker', () => {
  const durations = { a: 1, b: 9, c: 1, d: 5, e: 3, f: 2 };
  const files = ['f', 'e', 'd', 'c', 'b', 'a', 'new'];
  const named = (cwd, order) => order.map((f) => path.relative(cwd, path.resolve(cwd, f)));
  // Each `../` step up from the working directory is a band, then absolute paths, then plain ones.
  // The file the table does not list takes the first band, whatever its median cost.
  for (const [depth, workers, sorted] of [
    [3, 1, ['new', 'b', 'd', 'e', 'a', 'c', 'f']],
    [2, 1, ['new', 'b', 'd', 'a', 'c', 'e', 'f']],
    [1, 1, ['new', 'b', 'a', 'c', 'd', 'e', 'f']],
    [2, 2, ['b', 'new', 'd', 'e', 'a', 'f', 'c']],
    [1, 3, ['b', 'd', 'new', 'a', 'e', 'f', 'c']],
  ]) {
    const cwd = path.resolve('/', ...Array.from({ length: depth }, (_, i) => `dir${i}`));
    const order = startOrder(files, workers, durations, cwd);
    assert.deepEqual(named(cwd, order), files, `depth ${depth}, ${workers} workers: each file keeps its place`);
    assert.deepEqual(named(cwd, [...order].sort()), sorted, `depth ${depth}, ${workers} workers`);
  }
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

test('the checked-in durations split Linux into three CI shards and Windows into four within a tenth of each other', () => {
  const files = testFiles();
  for (const [platform, total] of [['linux', 3], ['win32', 4]]) {
    const durations = fileDurations(platform);
    assert.ok(Object.keys(durations).length > files.length / 2, `${platform} has measured times`);
    const known = Object.values(durations).sort((a, b) => a - b);
    const cost = (file) => durations[file] ?? known[Math.floor(known.length / 2)];
    const loads = Array.from({ length: total }, (_, i) => shardFiles(files, i + 1, total, durations).reduce((sum, file) => sum + cost(file), 0));
    const mean = loads.reduce((a, b) => a + b, 0) / total;
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

test('a shard logs each file as it starts and ends, and past its deadline its watchdog prints what still runs, stops it and fails', (t) => {
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
  // TC_TEST_SHARD_HANG blocks the runner's own event loop, so only a process of its own can stop the shard.
  for (const blocked of [false, true]) {
    const logDir = path.join(h.base, `shard-log-${blocked}`);
    const late = run([FIXTURES[0], hang], { TC_TEST_SHARD_DEADLINE_MIN: '0.1', TC_TEST_SHARD_LOG_DIR: logDir, TC_TEST_SHARD_HANG: blocked ? '1' : '' });
    const what = `blocked runner ${blocked}`;
    assert.equal(late.error, undefined, `${what}: the watchdog, not this test's timeout, stops the run`);
    assert.ok(late.status !== 0, `${what}: the shard fails\n${late.stdout}${late.stderr}`);
    assert.match(late.stdout, /^file started: .*hang\.test\.js$/m, what);
    assert.doesNotMatch(late.stdout, /^file ended: .*hang\.test\.js$/m, what);
    assert.match(late.stderr, /shard deadline of 0\.1 min reached; free memory/, what);
    // The files CI uploads keep the same record when the job log is lost.
    const progress = fs.readFileSync(path.join(logDir, 'progress.log'), 'utf8');
    assert.match(progress, /^file started: .*hang\.test\.js$/m, what);
    assert.match(progress, /^file ended: .*a\.test\.js$/m, what);
    assert.doesNotMatch(progress, /^file ended: .*hang\.test\.js$/m, what);
    const watchdog = fs.readFileSync(path.join(logDir, 'watchdog.log'), 'utf8');
    assert.match(watchdog, /shard deadline of 0\.1 min reached[\s\S]*processes still running/, what);
    assert.match(watchdog, /^\S+ {3}\d+ \d+ .*hang\.test\.js/m, `${what}: the dump names the hung file's process`);
    assert.match(watchdog, /stopped the shard$/m, what);
  }
});

// scripts/shard-guard.ps1 as CI runs it: PROGRAM and ARGS become the command it runs in its job object.
function guard(h, args, env) {
  const child = cp.spawn('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'scripts', 'shard-guard.ps1'), ...args], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env, TOWER_CRANE_TEST_TMP: h.base, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, ...env },
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the guard still ran after 3 minutes:\n${stdout}`)); }, 180000); // wait-allow: bounds a guard whose own deadline is 30 seconds
    child.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
  });
}

test('the Windows shard guard posts progress from outside node, and at its deadline dumps the job and stops it, orphans included', { skip: process.platform !== 'win32' && 'the guard runs the tests in a Windows job object' }, async (t) => {
  const h = makeRepo(t);
  const posts = [];
  const server = require('node:http').createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      posts.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/check-runs/7`, html_url: 'https://github.invalid/checks/7' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const logDir = path.join(h.base, 'shard-log');
  const orphanFile = path.join(h.base, 'orphan.json');
  // The runner's event loop is blocked and its own watchdog waits past the guard's deadline, as when node is stuck.
  const hung = await guard(h, ['node', path.join('test', 'run.js'), FIXTURES[0], path.join('test', 'fixtures', 'shard', 'orphan.test.js')], {
    TC_TEST_SHARD: '1/1', TC_TEST_SHARD_HANG: '1', TC_TEST_SHARD_DEADLINE_MIN: '10', TC_TEST_SHARD_LOG_DIR: logDir,
    TC_SHARD_GUARD_DEADLINE_MIN: '0.5', TC_ORPHAN_FILE: orphanFile,
    TC_SHARD_PROGRESS_CHECK: 'shard progress (test)', TC_SHARD_PROGRESS_SHA: 'a'.repeat(40), TC_SHARD_PROGRESS_TOKEN: 'guard-token',
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
  });
  assert.equal(hung.status, 1, hung.stdout);
  const log = fs.readFileSync(path.join(logDir, 'guard.log'), 'utf8');
  assert.match(log, /deadline of 0\.5 min reached; free memory \d+ MiB/);
  assert.match(log, /^\S+ guard: files still running: test\/fixtures\/shard\/orphan\.test\.js$/m, 'the guard names the hung file');
  assert.match(hung.stdout, /guard: files still running: test\/fixtures\/shard\/orphan\.test\.js\r?$/m, 'the job log has it too');
  assert.match(log, /^\S+ guard: {3}\d+ node handles \d+ threads \d+ committed \d+ MiB ws \d+ MiB started /m, 'the dump has handle and memory counts');
  assert.match(log, /^\S+ guard: {3}\d+ \d+ .*orphan\.test\.js/m, "the dump names the hung file's process");
  assert.match(log, /taskkill: SUCCESS/);
  assert.match(log, /every job process stopped[\s\S]*stopped the shard$/m);
  const orphan = JSON.parse(fs.readFileSync(orphanFile, 'utf8'));
  assert.equal(orphan.token, null, 'the tests never see the progress token');
  assert.throws(() => killPid(orphan.pid, 0), { code: 'ESRCH' }, 'the job stopped the process whose parent had exited');
  // The progress left the process while it ran: a completed neutral check run, then updates to it.
  assert.deepEqual(posts[0].body, { name: 'shard progress (test)', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'neutral', output: posts[0].body.output });
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].url, '/repos/owner/repo/check-runs');
  assert.equal(posts[0].auth, 'Bearer guard-token');
  assert.ok(posts.slice(1).length && posts.slice(1).every((post) => post.method === 'PATCH' && post.url === '/check-runs/7'), JSON.stringify(posts));
  const last = posts.at(-1).body.output;
  assert.match(last.title, /^stopped at the deadline at [\d.]+ min: 1\/2 files ended; running: test\/fixtures\/shard\/orphan\.test\.js$/);
  assert.match(last.summary, /- job \d+ processes, .* handles, .*MiB committed; peaks \d+ processes/);
  assert.match(last.summary, /file started: .*orphan\.test\.js/);

  // A command that ends on its own keeps its exit status, and the job's limits refuse what is past them.
  const script = (name, text) => { const file = path.join(h.base, name); fs.writeFileSync(file, text); return file; };
  const spawns = script('spawns.js', `const cp = require('node:child_process'); let refused = 0;
for (let i = 0; i < 10; i++) {
  try { cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }).on('error', () => refused++); } catch { refused++; } // wait-allow: held until the guard stops the job
}
setTimeout(() => { console.log('refused ' + refused); process.exit(3); }, 2000); // wait-allow: lets every refused spawn report`);
  const counted = await guard(h, ['node', spawns], { TC_SHARD_GUARD_MAX_PROCESSES: '4', TC_TEST_SHARD_LOG_DIR: path.join(h.base, 'spawns-log') });
  assert.equal(counted.status, 3, counted.stdout);
  assert.match(counted.stdout, /limits 4 processes/);
  assert.ok(Number(/^refused (\d+)$/m.exec(counted.stdout)?.[1]) >= 6, `the process limit refuses spawns past it\n${counted.stdout}`);
  assert.match(fs.readFileSync(path.join(h.base, 'spawns-log', 'guard.log'), 'utf8'), /exited 3 at [\d.]+ min/);
  const allocates = script('allocates.js', `try { Buffer.alloc(400 * 2 ** 20, 1); console.log('allocated'); } catch (error) { console.log('refused ' + error.message); }`);
  const bounded = await guard(h, ['node', allocates], { TC_SHARD_GUARD_MAX_MEMORY_MB: '200' });
  assert.equal(bounded.status, 0, bounded.stdout);
  assert.match(bounded.stdout, /^refused /m, 'the memory limit refuses a commit past it');
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
