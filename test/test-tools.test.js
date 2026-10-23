'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, detachedAlive, pinLiveRung } = require('./helpers');
const { tempRoot, liveRoot } = require('./tmp-root');
const { HUNG_TEST_MS, killGroup } = require('./signals');
const { socketDir } = require('./socket-dir');

test('test temp roots prefer explicit overrides and otherwise use the user cache on each platform', () => {
  const home = path.join(ROOT, 'fixture-home');
  const cache = path.join(home, 'custom-cache');
  const testTmp = path.join(home, 'test-tmp');
  const tmp = path.join(home, 'tmp');
  for (const [platform, env, expected] of [
    ['linux', { HOME: home }, path.join(home, '.cache', 'tower-crane', 'test-tmp')],
    ['darwin', { HOME: home }, path.join(home, '.cache', 'tower-crane', 'test-tmp')],
    ['linux', { HOME: home, XDG_CACHE_HOME: cache }, path.join(cache, 'tower-crane', 'test-tmp')],
    ['win32', { USERPROFILE: home, LOCALAPPDATA: cache }, path.join(cache, 'tower-crane', 'test-tmp')],
    ['win32', { USERPROFILE: home }, path.join(home, 'AppData', 'Local', 'tower-crane', 'test-tmp')],
    ['linux', { HOME: home, TOWER_CRANE_TMP: tmp }, tmp],
    ['win32', { USERPROFILE: home, TOWER_CRANE_TMP: tmp, TOWER_CRANE_TEST_TMP: testTmp }, testTmp],
  ]) assert.equal(tempRoot(env, platform), expected);
});

test('live probes keep their fixtures in a cache directory of their own, beside the churning test temp root', () => {
  const home = path.join(ROOT, 'fixture-home');
  const cache = path.join(home, 'custom-cache');
  const testTmp = path.join(home, 'test-tmp');
  for (const [platform, env, expected] of [
    ['linux', { HOME: home }, path.join(home, '.cache', 'tower-crane-live')],
    ['linux', { HOME: home, XDG_CACHE_HOME: cache }, path.join(cache, 'tower-crane-live')],
    ['linux', { HOME: home, TOWER_CRANE_TEST_TMP: testTmp }, path.join(home, '.cache', 'tower-crane-live')],
    ['win32', { USERPROFILE: home, LOCALAPPDATA: cache }, path.join(cache, 'tower-crane-live')],
    ['win32', { USERPROFILE: home }, path.join(home, 'AppData', 'Local', 'tower-crane-live')],
  ]) assert.equal(liveRoot(env, platform), expected);
});

test('repository seeds, test helpers and gate scratch share the cache default and overrides', (t) => {
  const h = makeRepo(t);
  const probe = `
    const fs = require('node:fs');
    const { TMP_ROOT } = require('./test/helpers');
    if (!fs.existsSync(TMP_ROOT)) throw new Error('the helper root must exist without global setup');
    const { createRepoSeed, cleanupRepoSeed } = require('./test/repo-seed');
    const { scratch } = require('./test/gates/helpers');
    const seed = createRepoSeed();
    const gate = scratch('root-probe');
    try { console.log(JSON.stringify([TMP_ROOT, require('node:path').dirname(seed.base), require('node:path').dirname(gate)])); }
    finally { cleanupRepoSeed(seed); fs.rmSync(gate, { recursive: true, force: true }); }
  `;
  const cache = process.platform === 'win32'
    ? path.join(h.env.HOME, 'AppData', 'Local')
    : path.join(h.env.HOME, '.cache');
  for (const [overrides, expected] of [
    [{}, path.join(cache, 'tower-crane', 'test-tmp')],
    [{ TOWER_CRANE_TMP: path.join(h.base, 'tmp') }, path.join(h.base, 'tmp')],
    [{ TOWER_CRANE_TMP: path.join(h.base, 'tmp'), TOWER_CRANE_TEST_TMP: path.join(h.base, 'test-tmp') }, path.join(h.base, 'test-tmp')],
  ]) {
    const env = { ...h.env, USERPROFILE: h.env.HOME, XDG_CACHE_HOME: '', LOCALAPPDATA: '',
      TOWER_CRANE_TMP: '', TOWER_CRANE_TEST_TMP: '', ...overrides };
    const result = cp.spawnSync(process.execPath, ['-e', probe], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [expected, expected, expected]);
  }
});

for (const [fileTest, finish, status] of [
  [true, '', 0],
  [false, '', 0],
  // These exits skip beforeExit, so only the exit listener can remove the fixture.
  [false, 'process.exit(3);', 3],
  [false, "throw new Error('script failed');", 1],
]) test(`fixtures created without a test context are removed after completion (test=${fileTest}${finish && `, ${finish}`})`, (t) => {
  const h = makeRepo(t);
  const output = path.join(h.base, 'fixture.json');
  const file = path.join(h.base, 'fixture-lifetime.test.js');
  const body = `
const test = require('node:test');
const fs = require('node:fs');
const { makeRepo } = require(${JSON.stringify(path.join(ROOT, 'test/helpers.js'))});
const create = () => {
  const fixture = makeRepo();
  fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ base: fixture.base }));
};
${fileTest ? "test('file fixture', create);" : 'create();'}
${finish}
`;
  fs.writeFileSync(file, body);
  const result = cp.spawnSync(process.execPath, [...(fileTest ? ['--test'] : []), file], {
    env: { ...h.env, NODE_TEST_CONTEXT: undefined, TOWER_CRANE_TEST_TMP: path.join(h.base, 'scratch') },
    encoding: 'utf8', timeout: 300000,
  });
  assert.equal(result.status, status, result.stderr + result.stdout);
  const { base } = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(fs.existsSync(base), false, 'completion owns fixtures without a per-test context');
  assert.deepEqual(fs.readdirSync(path.join(h.base, 'scratch')), []);
});

test('fixture teardown stops a detached process recorded while it stops an earlier one', {
  skip: process.platform !== 'linux' && 'reads process state from /proc',
}, async (t) => {
  const observer = makeRepo(t);
  const out = path.join(observer.base, 'next-monitor-pid');
  t.after(() => {
    try { killGroup(Number(fs.readFileSync(out, 'utf8')), 'SIGKILL'); } catch { /* already stopped */ }
  });
  const h = makeRepo();
  const records = path.join(h.base, 'detached');
  fs.mkdirSync(records);
  const record = (kind, args) => {
    const child = cp.spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(path.join(records, `${child.pid}.json`), JSON.stringify({ pid: child.pid, kind }));
    return child;
  };
  const worker = record('worker', ['-e', 'setInterval(() => {}, 1000)']);
  // Like a monitor redispatching after its worker ends, this one starts and records the next
  // monitor only once teardown has stopped the worker.
  record('monitor', ['-e', `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [worker, records, out] = process.argv.slice(1);
const alive = () => {
  try { return !/^[ZX]/.test(fs.readFileSync('/proc/' + worker + '/stat', 'utf8').split(') ').at(-1)); }
  catch { return false; }
};
const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  const next = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(records, next.pid + '.json'), JSON.stringify({ pid: next.pid, kind: 'monitor' }));
  // The test signals this pid, so it publishes the file whole.
  fs.writeFileSync(out + '.tmp', String(next.pid));
  fs.renameSync(out + '.tmp', out);
  process.exit(0);
}, 20);
`, String(worker.pid), records, out]);
  await h.cleanup();
  assert.equal(fs.existsSync(h.base), false);
  const next = { pid: Number(fs.readFileSync(out, 'utf8')), kind: 'monitor' };
  // Teardown returns only after the processes it saw start have exited.
  assert.equal(detachedAlive(next), false, 'the monitor recorded during teardown outlived it');
});

test('the CLI helper retains launch errors alongside the exit status and signal', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = cp.spawnSync;
  const error = Object.assign(new Error('launch temporarily unavailable'), { code: 'EAGAIN' });
  cp.spawnSync = (command, args, options) => {
    if (command === process.execPath && args.includes('--ci-local')) {
      return { status: null, signal: null, stdout: '', stderr: '', error };
    }
    return original(command, args, options);
  };
  try {
    const result = h.run(['project', 'set', '--ci-local', '{}']);
    assert.equal(result.code, null);
    assert.equal(result.signal, null);
    assert.deepEqual(result.error, { code: 'EAGAIN', message: 'launch temporarily unavailable' });
  } finally {
    cp.spawnSync = original;
  }
});

test('the test runner emits one capped concurrency value, including repeated and split options', (t) => {
  const h = makeRepo(t);
  const runner = path.join(ROOT, 'test/run.js');
  for (const [cores, options, expected] of [
    [32, ['--test-concurrency=4', 'test/claim.test.js', '--test-concurrency=999'], 31],
    [24, ['--test-concurrency=8', 'test/claim.test.js'], 8],
    [24, ['test/claim.test.js'], 4],
    [3, ['--test-concurrency=999', 'test/claim.test.js', '--test-concurrency', '999'], 2],
    [32, ['--test-concurrency=4', '--test-concurrency', '2', 'test/claim.test.js'], 2],
    [1, ['test/claim.test.js'], 1],
  ]) {
    const probe = `
      require('node:os').availableParallelism = () => ${cores};
      require('node:child_process').spawn = (command, args) => {
        console.log(JSON.stringify(args));
        const child = new (require('node:events').EventEmitter)();
        process.nextTick(() => child.emit('exit', 0, null));
        return child;
      };
    `;
    const preload = path.join(h.base, 'runner-probe.js');
    fs.writeFileSync(preload, probe);
    const r = cp.spawnSync(process.execPath, ['--require', preload, runner, ...options], { env: h.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const args = JSON.parse(r.stdout);
    assert.deepEqual(args.filter((arg) => arg.startsWith('--test-concurrency')), [`--test-concurrency=${expected}`]);
    assert.ok(args.includes('--test-timeout=300000'), 'runner and signal waits share the hung-test backstop');
    assert.ok(args.includes(`--require=${path.join(ROOT, 'test', 'fixtures', 'report-guard.js')}`), 'every test file loads the report guard');
    assert.deepEqual(args.filter((arg) => !arg.startsWith('--')), ['test/claim.test.js']);
  }
  // With one worker each file takes a band of its own, longest first, so
  // node --test's sort of the paths starts them longest first.
  const preload = path.join(h.base, 'runner-order.js');
  fs.writeFileSync(preload, `
    require('node:os').availableParallelism = () => 2;
    require('node:child_process').spawn = (command, args) => {
      console.log(JSON.stringify(args));
      const child = new (require('node:events').EventEmitter)();
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    };
  `);
  const files = ['test/accept.test.js', 'test/claim.test.js', 'test/isolation.test.js', 'test/events.test.js'];
  const r = cp.spawnSync(process.execPath, ['--require', preload, runner, ...files], { cwd: ROOT, env: h.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Each platform's own table decides: isolation is long on Linux, short on Windows.
  const longest = require('./run').longestFirst(files);
  assert.notDeepEqual(longest, [...files].sort(), 'the measured order differs from the sorted one');
  const passed = JSON.parse(r.stdout).filter((arg) => !arg.startsWith('--'));
  const named = (list) => list.map((arg) => path.relative(ROOT, path.resolve(ROOT, arg)).split(path.sep).join('/'));
  assert.deepEqual(named(passed), files, 'each file keeps its place');
  assert.deepEqual(named([...passed].sort()), longest);
});

test('each test run gets a private runtime directory for its sockets and removes it, so no test broker sweeps the real one', { skip: process.platform === 'win32' && 'Windows brokers use named pipes' }, (t) => {
  const h = makeRepo(t);
  const runner = path.join(ROOT, 'test/run.js');
  const real = fs.realpathSync(socketDir(t));
  const leaf = fs.realpathSync(socketDir(t));
  // What a live agent's broker keeps in the real runtime directory.
  const live = path.join(real, 'tower-crane-abcdef');
  fs.mkdirSync(live, { mode: 0o700 });
  fs.writeFileSync(path.join(live, 'owner.json'), '{}');
  const probe = path.join(h.base, 'runtime-probe.js');
  fs.writeFileSync(probe, `
    require('node:child_process').spawn = (command, args, options) => {
      const dir = options.env.XDG_RUNTIME_DIR;
      console.log(JSON.stringify({ dir, mode: require('node:fs').statSync(dir).mode & 0o777, host: options.env.TOWER_CRANE_HOST_RUNTIME_DIR }));
      const child = new (require('node:events').EventEmitter)();
      process.nextTick(() => child.emit('exit', 0, null));
      return child;
    };
  `);
  // Runs that died without cleaning up: only one whose runner provably exited
  // in this pid namespace goes. Inside a sandbox a live host run's pid is missing.
  const gone = cp.spawnSync(process.execPath, ['-e', '']).pid;
  const ns = { pidns: (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return null; } })() };
  const runs = {
    'tct-exited': { pid: gone, host: os.hostname(), ...ns },
    'tct-otherN': { pid: gone, host: os.hostname(), pidns: 'pid:[1]' },
    'tct-living': { pid: process.pid, host: os.hostname(), ...ns },
    'tct-norec0': null,
  };
  for (const [name, record] of Object.entries(runs)) {
    fs.mkdirSync(path.join(real, name), { mode: 0o700 });
    fs.mkdirSync(path.join(real, name, 'tower-crane-abcdef'));
    if (record) fs.writeFileSync(path.join(real, name, 'runner.json'), JSON.stringify(record));
  }
  // A record at a link is not the run's own, even when its target names an exited runner.
  fs.mkdirSync(path.join(real, 'tct-linked'), { mode: 0o700 });
  fs.writeFileSync(path.join(h.base, 'exited-runner.json'), JSON.stringify(runs['tct-exited']));
  fs.symlinkSync(path.join(h.base, 'exited-runner.json'), path.join(real, 'tct-linked', 'runner.json'));
  // A FIFO at the record's name is no record, and opening it never blocks the run.
  fs.mkdirSync(path.join(real, 'tct-fifo00'), { mode: 0o700 });
  assert.equal(cp.spawnSync('mkfifo', [path.join(real, 'tct-fifo00', 'runner.json')]).status, 0);
  const env = { ...h.env };
  delete env.TOWER_CRANE_SOCKET_DIR;
  delete env.TOWER_CRANE_HOST_RUNTIME_DIR;
  for (const [label, vars, base] of [
    ['a runtime directory', { XDG_RUNTIME_DIR: real }, real],
    ['a sandbox that grants only its socket leaf', { XDG_RUNTIME_DIR: path.join(real, 'missing'), TOWER_CRANE_SOCKET_DIR: leaf }, leaf],
  ]) {
    const seen = [];
    for (let run = 0; run < 2; run++) {
      const r = cp.spawnSync(process.execPath, ['--require', probe, runner, 'test/claim.test.js'], { env: { ...env, ...vars }, encoding: 'utf8', timeout: HUNG_TEST_MS });
      assert.equal(r.status, 0, r.stderr);
      const { dir, mode, host } = JSON.parse(r.stdout);
      assert.equal(path.dirname(dir), base, label);
      assert.equal(mode, 0o700, label);
      assert.equal(host, vars.XDG_RUNTIME_DIR, `${label}: host probes still find the real runtime directory`);
      assert.doesNotMatch(path.basename(dir), /^(?:tower-crane-[A-Za-z0-9]{6}|tc-[0-9a-f]{12})$/, `${label}: a name the broker sweep never takes`);
      assert.equal(fs.existsSync(dir), false, `${label}: the run removes it`);
      seen.push(dir);
    }
    assert.notEqual(seen[0], seen[1], `${label}: each run has its own`);
  }
  assert.deepEqual(fs.readdirSync(live), ['owner.json'], 'the real runtime directory\'s entries are untouched');
  assert.deepEqual(fs.readdirSync(real).filter((name) => name.startsWith('tct-')).sort(), ['tct-fifo00', 'tct-linked', 'tct-living', 'tct-norec0', 'tct-otherN'],
    'a later run removes only the directory of a runner that exited in this pid namespace');
});

test('a test run stopped by a signal stops its tests and still removes its private runtime directory', { skip: process.platform === 'win32' && 'Windows brokers use named pipes' }, async (t) => {
  const h = makeRepo(t);
  const real = fs.realpathSync(socketDir(t));
  const probe = path.join(h.base, 'runtime-probe.js');
  fs.writeFileSync(probe, `
    require('node:child_process').spawn = (command, args, options) => {
      const child = new (require('node:events').EventEmitter)();
      // The runner waits on its tests until they end, as on a real child.
      const running = setInterval(() => {}, 1000);
      child.kill = (signal) => process.nextTick(() => { clearInterval(running); child.emit('exit', null, signal); });
      // Printed once the runner's start-up code, its signal handlers included, has run.
      process.nextTick(() => console.log(JSON.stringify({ dir: options.env.XDG_RUNTIME_DIR })));
      return child;
    };
  `);
  const env = { ...h.env, XDG_RUNTIME_DIR: real };
  delete env.TOWER_CRANE_SOCKET_DIR;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const runner = cp.spawn(process.execPath, ['--require', probe, path.join(ROOT, 'test/run.js'), 'test/claim.test.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    runner.stderr.on('data', (chunk) => { err += chunk; });
    const dir = await new Promise((resolve, reject) => {
      runner.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) resolve(JSON.parse(out).dir);
      });
      runner.once('exit', () => reject(new Error(`the runner exited before it started its tests: ${err}`)));
    });
    assert.equal(fs.existsSync(dir), true, signal);
    const [code, by] = await new Promise((resolve) => {
      runner.removeAllListeners('exit');
      runner.once('exit', (...end) => resolve(end));
      runner.kill(signal);
    });
    assert.deepEqual([code, by], [128 + os.constants.signals[signal], null], `${signal}: the runner exits with the tests' signal status: ${err}`);
    assert.equal(fs.existsSync(dir), false, `${signal}: the run removes its runtime directory`);
  }
});

test('mutation fallback requires a green baseline in a copy containing all test inputs', (t) => {
  const h = makeRepo(t);
  const write = (file, text) => {
    const target = path.join(h.repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const file of ['test/run.js', 'test/signals.js', 'test/atomic-file.js', 'test/global-setup.js', 'test/host.js', 'test/repo-seed.js', 'test/tmp-root.js', 'test/fixtures/user-config-guard.js', 'test/fixtures/report-guard.js', 'test/fixtures/no-fsync.js']) {
    write(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  write('test/gates/.keep', '');
  write('lib/gates/merge.js', `module.exports = (t, ctx) => {
    if (t.status !== 'accepted' || (!ctx.mergedIds?.includes(t.id))) return false;
    return true;
  };\n`);
  write('test/stack-merge.test.js', `require('node:test')('scoped survivor', () => {});\n`);
  write('test/mutants.test.js', `
    require('node:test')('pristine mutation anchors', () => {
      require('node:assert/strict').match(
        require('node:fs').readFileSync('lib/gates/merge.js', 'utf8'),
        /t.status !== 'accepted'/);
    });
  `);
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
  ], { env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, encoding: 'utf8', timeout: 300000 });

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


test('live Claude probes use the requested provider and environment file without changing Codex profiles', (t) => {
  const h = makeRepo(t);
  h.init();
  const envFile = path.join(h.base, 'provider.env');
  fs.writeFileSync(envFile, 'AWS_REGION=us-east-1\n');
  const values = { TOWER_CRANE_LIVE_MODEL: 'fixture-model', TOWER_CRANE_LIVE_PROFILE: 'fixture-main',
    TOWER_CRANE_LIVE_CLAUDE_PROVIDER: 'bedrock', TOWER_CRANE_LIVE_CLAUDE_ENV_FILE: envFile };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  Object.assign(process.env, values);
  pinLiveRung(h, 'claude');
  pinLiveRung(h, 'codex', 'review');
  const project = JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'));
  assert.equal(project.ladder.small.provider, 'bedrock');
  assert.equal(project.ladder.small.env_file, envFile);
  assert.equal(project.ladder.small.model, 'fixture-model');
  assert.equal(project.ladder.review.profile, 'fixture-main');
  assert.equal(project.ladder.review.provider, undefined);
  assert.equal(project.ladder.review.env_file, undefined);
});

test('the suite profile sums leaf tests per file and marks tests that ran beside each other', () => {
  const { summarize, report } = require('../scripts/suite-profile');
  const root = path.join(ROOT, 'profile-root');
  const file = (name) => path.join(root, 'test', name);
  const records = [
    { name: 'sleeps', nesting: 0, file: file('a.test.js'), pid: 1, leaf: true, start_ms: 0, wall_ms: 1000, cpu_ms: 100 },
    { name: 'works', nesting: 0, file: file('a.test.js'), pid: 1, leaf: true, start_ms: 1000, wall_ms: 500, cpu_ms: 500 },
    { name: 'group', nesting: 0, file: file('b.test.js'), pid: 2, leaf: false, start_ms: 0, wall_ms: 900, cpu_ms: 800 },
    { name: 'x', nesting: 1, file: file('b.test.js'), pid: 2, leaf: true, start_ms: 0, wall_ms: 600, cpu_ms: 400 },
    { name: 'y|z\\', nesting: 1, file: file('b.test.js'), pid: 2, leaf: true, start_ms: 100, wall_ms: 800, cpu_ms: 400 },
    { file: file('a.test.js'), process: true, wall_ms: 1600, cpu_ms: 650 },
    { file: file('b.test.js'), process: true, wall_ms: 1000, cpu_ms: 850 },
  ];
  const s = summarize(records, root);
  assert.equal(s.test_count, 4, 'the describe holds its tests and is not one');
  assert.deepEqual(s.tests.map((t) => [t.name, t.file, t.cpu_ms]),
    [['sleeps', 'test/a.test.js', 100], ['y|z\\', 'test/b.test.js', null], ['x', 'test/b.test.js', null], ['works', 'test/a.test.js', 500]]);
  assert.deepEqual([s.test_wall_ms, s.serial_wall_ms, s.serial_cpu_ms, s.file_wall_ms, s.file_cpu_ms], [2900, 1500, 600, 2600, 1500]);
  assert.deepEqual(s.files.map((f) => [f.file, f.tests, f.wall_ms, f.cpu_ms]), [['test/a.test.js', 2, 1600, 650], ['test/b.test.js', 2, 1000, 850]]);
  assert.deepEqual(s.longest_file, { file: 'test/a.test.js', wall_ms: 1600 });
  const text = report(s, { wall_ms: 1700, concurrency: 2, top: 30 });
  assert.match(text, /^suite wall 1\.7 s at 2 file workers; 4 tests, 2\.9 s summed test time$/m);
  assert.match(text, /^longest file: `test\/a\.test\.js` 1\.6 s$/m);
  assert.match(text, /^serial tests: 1\.5 s, 0\.6 s CPU: 60% waiting$/m);
  assert.match(text, /^\| 1 \| sleeps \| `test\/a\.test\.js` \| 1\.0 \| 0\.1 \| 90% \|$/m);
  assert.match(text, /^\| 2 \| y\\\|z\\\\ \| `test\/b\.test\.js` \| 0\.8 \| - \| overlapped \|$/m, 'cells escape the separator and the escape');
  assert.match(text.split('\n').pop(), /^serial tests: /, 'the summary ends the report, where a log tail keeps it');
  s.tests[0].name = 'n'.repeat(150);
  const host = { cores: 24, cgroup: '/gate.scope', load_start: 2.04, load_peak: 13.96, load_end: 9.5, memory_start: 100 * 1048576, memory_peak: 2616 * 1048576,
    cpu_ms: 4321000, pressure: { some_ms: 850, full_ms: 170, some_avg10_peak: 61.25, full_avg10_peak: 12 } };
  const hosted = report(s, { wall_ms: 1700, concurrency: 2, top: 30, host });
  assert.match(hosted, new RegExp(`^\\| 1 \\| ${'n'.repeat(97)}\\.\\.\\. \\|`, 'm'), 'a long name is cut to 100 characters');
  assert.match(hosted, /^host: 24 cores; 1-minute load 2\.0 at start, peak 14\.0, 9\.5 at end$/m);
  assert.match(hosted, /^CPU: 4321\.0 s in cgroup \/gate\.scope, detached processes included$/m);
  assert.match(hosted, /^CPU pressure: some 0\.8 s \(50% of wall\), full 0\.2 s \(10%\); avg10 peak some 61\.3%, full 12\.0%$/m);
  assert.match(hosted.split('\n').pop(), /^memory: peak 2516 MiB above the start in cgroup \/gate\.scope$/);
  assert.doesNotMatch(hosted, /limit/, 'the profile sets no wall limit');
  const bare = report(s, { wall_ms: 1700, concurrency: 2, top: 30, host: { ...host, memory_peak: null, cpu_ms: null, pressure: null } });
  assert.match(bare, /^memory: no cgroup memory\.current to read$/m);
  assert.match(bare, /^CPU pressure: no cgroup cpu\.pressure to read$/m);
  assert.doesNotMatch(bare, /^CPU: /m);
});

test('the suite profile compares the medians of interleaved baseline and head runs', () => {
  const { compare } = require('../scripts/suite-profile');
  const run = (tree, cpu, longest, extra = {}) => ({ tree, status: 0, wall_ms: 600000, file_cpu_ms: cpu - 1000,
    longest_file: { file: 'test/a.test.js', wall_ms: longest }, host: { load_start: 1, load_peak: 2, load_end: 3, cpu_ms: cpu, pressure: { some_ms: 5000 } }, ...extra });
  const lower = compare([run('baseline', 5000e3, 400e3), run('head', 4000e3, 300e3), run('baseline', 9000e3, 900e3), run('head', 4500e3, 250e3), run('baseline', 5200e3, 380e3), run('head', 6000e3, 500e3)]);
  assert.equal(lower.ok, true, lower.text);
  assert.match(lower.text, /^median of 3: CPU seconds \(cgroup\) head 4500\.0 vs baseline 5200\.0 \(-13\.5%\): lower$/m);
  assert.match(lower.text, /^median of 3: longest file wall s head 300\.0 vs baseline 400\.0 \(-25\.0%\): lower$/m);
  assert.match(lower.text, /^\| 2 \| head \| passed \| 600\.0 \| 4000\.0 \| 3999\.0 \| 300\.0 \| 1\.0, 2\.0, 3\.0 \| 5\.0 \|$/m);
  const cases = [
    ['CPU not lower', [run('baseline', 5000e3, 400e3), run('head', 5000e3, 300e3)], /CPU seconds .*: not lower$/m],
    ['longest file not lower', [run('baseline', 5000e3, 400e3), run('head', 4000e3, 401e3)], /longest file wall s .*\(\+0\.3%\): not lower$/m],
    ['a failed head run', [run('baseline', 5000e3, 400e3), run('head', 1000e3, 100e3, { status: 1 })], /^1 of 1 head runs failed$/m],
    ['no baseline run', [run('head', 1000e3, 100e3)], /^\| 1 \| head \|/m],
  ];
  for (const [name, runs, line] of cases) {
    const r = compare(runs);
    assert.equal(r.ok, false, name);
    assert.match(r.text, line, name);
  }
  const files = compare([run('baseline', 5000e3, 400e3, { host: null }), run('head', 4000e3, 300e3, { host: null })]);
  assert.match(files.text, /^median of 1: CPU seconds \(file processes\) head 3999\.0 vs baseline 4999\.0/m, 'without a cgroup the file processes are summed');
});

test('the suite profile records each test of a real run with its CPU', { skip: process.platform !== 'linux' && 'CPU comes from /proc' }, (t) => {
  const h = makeRepo(t);
  const fixture = path.join(h.base, 'profiled.test.js');
  fs.writeFileSync(fixture, `
const assert = require('node:assert/strict');
require('node:test')('waits', () => { assert.equal(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400), 'timed-out'); }); // wait-allow: the profile measures a timer wait
for (const [name, pause] of [['spins', 0], ['spins after pause', 250]]) {
  require('node:test')(name, () => {
    const start = process.cpuUsage();
    // A pause reproduces time off CPU without depending on other host processes.
    if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause); // wait-allow: the profile measures time off CPU
    let n = 0;
    let used;
    // A CPU budget keeps the work stable when the scheduler gives other tasks a turn.
    do { n++; used = process.cpuUsage(start); } while (used.user + used.system < 400000); // wait-allow: the profile measures CPU work
    assert.ok(n > 0);
  });
}
`);
  const out = path.join(h.base, 'profile.json');
  // This checkout stands in for the baseline, so the verdict is a coin toss; the exit follows it.
  // The request is over any core count, so the report must name the runner's capped workers.
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'suite-profile.js'), '--test-concurrency=999', '--json', out, '--baseline-dir', ROOT, fixture],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base }, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, /: not lower$/m.test(r.stdout) ? 1 : 0, r.stderr + r.stdout);
  const workers = Math.max(1, require('node:os').availableParallelism() - 1);
  assert.equal(r.stdout.match(new RegExp(`^suite wall [\\d.]+ s at ${workers} file workers;`, 'gm'))?.length, 2, r.stdout);
  assert.match(r.stdout, /^# suite profile: baseline run 1 of 1 in /m);
  assert.match(r.stdout, /^host: \d+ cores; 1-minute load /m);
  assert.match(r.stdout, /^median of 1: CPU seconds \((cgroup|file processes)\) head [\d.]+ vs baseline [\d.]+ .*: (lower|not lower)$/m);
  assert.match(r.stdout.trim().split('\n').pop(), /^median of 1: longest file wall s /, 'the verdict ends the log, where a probe receipt keeps it');
  const profile = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(profile.runs.map((x) => [x.tree, x.status, x.longest_file.file]), [['baseline', 0, path.relative(ROOT, fixture)], ['head', 0, path.relative(ROOT, fixture)]]);
  assert.equal(profile.comparison.ok, r.status === 0);
  assert.equal(profile.status, 0, 'the suite itself passed');
  assert.ok(profile.host.load_peak >= 0 && profile.host.cores > 0, JSON.stringify(profile.host));
  const byName = Object.fromEntries(profile.tests.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ['spins', 'spins after pause', 'waits']);
  assert.ok(byName.waits.wall_ms >= 400 && byName.waits.cpu_ms < 200, JSON.stringify(byName.waits));
  for (const name of ['spins', 'spins after pause']) {
    assert.ok(byName[name].cpu_ms >= 300, JSON.stringify(byName[name]));
  }
  assert.equal(profile.files.length, 1);
  assert.match(r.stdout, /^serial tests: .* waiting$/m);
  assert.deepEqual(fs.readdirSync(h.base).filter((name) => name.startsWith('suite-profile-')), [], 'the record directory is removed');
});

test('the suite profile runs a baseline commit from a worktree it removes afterwards', { skip: process.platform !== 'linux' && 'CPU comes from /proc' }, (t) => {
  const h = makeRepo(t);
  // The runner and what it loads, so the repository's own suite runs at both commits.
  for (const file of ['scripts/suite-profile.js', 'test/run.js', 'test/signals.js', 'test/atomic-file.js', 'test/global-setup.js', 'test/host.js', 'test/repo-seed.js', 'test/tmp-root.js',
    'test/fixtures/user-config-guard.js', 'test/fixtures/report-guard.js', 'test/fixtures/no-fsync.js']) {
    fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(h.repo, file));
  }
  fs.mkdirSync(path.join(h.repo, 'test', 'gates'));
  fs.writeFileSync(path.join(h.repo, 'test', 'gates', '.keep'), '');
  const one = (body) => fs.writeFileSync(path.join(h.repo, 'test', 'one.test.js'), `require('node:test')('one', () => {\n  ${body}\n});\n`);
  one("require('node:assert/strict').ok(true);");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'baseline suite']);
  const baseline = h.git(['rev-parse', 'HEAD']);
  // The head's test spins, so its file CPU is the larger whatever the load.
  one("const start = process.cpuUsage(); let used; do { used = process.cpuUsage(start); } while (used.user + used.system < 400000);"); // wait-allow: the profile measures CPU work
  const out = path.join(h.base, 'profile.json');
  const r = cp.spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'suite-profile.js'), '--test-concurrency=1', '--baseline', baseline, '--json', out, 'test/one.test.js'],
    { cwd: h.repo, env: { ...h.env, TOWER_CRANE_TEST_TMP: h.base, TOWER_CRANE_SANDBOX: '0' }, encoding: 'utf8', timeout: 300000 });
  // Inside a suite run the cgroup holds other test files too, so the verdict can go either way; the exit follows it.
  assert.equal(r.status, /: not lower$/m.test(r.stdout) ? 1 : 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`^# suite profile: baseline run 1 of 1 in ${h.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/suite-baseline-[^/]+/tree$`, 'm'));
  assert.match(r.stdout, /^median of 1: CPU seconds \((cgroup|file processes)\) head [\d.]+ vs baseline [\d.]+ .*: (lower|not lower)$/m);
  const profile = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(profile.runs.map((x) => [x.tree, x.status, x.longest_file.file]), [['baseline', 0, 'test/one.test.js'], ['head', 0, 'test/one.test.js']]);
  assert.ok(profile.runs[1].file_cpu_ms > profile.runs[0].file_cpu_ms + 200, JSON.stringify(profile.runs));
  assert.deepEqual(h.git(['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'the baseline worktree is removed');
  assert.deepEqual(fs.readdirSync(h.base).filter((name) => name.startsWith('suite-baseline-')), [], 'its directory is removed');
});
