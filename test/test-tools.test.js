'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, detachedAlive, pinLiveRung } = require('./helpers');
const { tempRoot, liveRoot } = require('./tmp-root');
const { killGroup } = require('./signals');

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
    assert.ok(args.includes('--test-timeout=300000'), 'runner and signal waits share the hung-test backstop');
    assert.ok(args.includes(`--require=${path.join(ROOT, 'test', 'fixtures', 'report-guard.js')}`), 'every test file loads the report guard');
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
  for (const file of ['test/run.js', 'test/signals.js', 'test/atomic-file.js', 'test/global-setup.js', 'test/host.js', 'test/repo-seed.js', 'test/tmp-root.js', 'test/fixtures/user-config-guard.js', 'test/fixtures/report-guard.js']) {
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
