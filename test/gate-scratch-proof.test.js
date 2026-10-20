'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture } = require('./helpers');
const { writeHost } = require('./host');
const { HUNG_TEST_MS } = require('./signals');
const { probe } = require('../scripts/probe-gate-scratch');
const { suiteTime, reportSuiteTime, DEADLINE_MIN } = require('../scripts/suite-time');

function fixture(t) {
  return cachedFixture(t, 'scratch-proof', (h) => {
    fs.writeFileSync(path.join(h.repo, 'scratch.js'), `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-unremoved-'));
if (process.env.PROOF_LEAK === '1') {
  fs.mkdirSync(path.resolve(process.env.TOWER_CRANE_TMP, '../outer/escaped'));
}
if (process.env.PROOF_ROOT_ENTRY) {
  const entry = path.join(process.env.TOWER_CRANE_TMP, process.env.PROOF_ROOT_ENTRY);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '{}');
}
if (process.env.PROOF_FAIL === '1') process.exit(7);
`);
    h.git(['add', 'scratch.js']);
    h.git(['commit', '-qm', 'Add scratch command']);
  });
}

test('the gate proof measures caller contents and the actual removed parent', (t) => {
  const h = fixture(t);
  const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js', environment: h.env });
  assert.equal(result.sha, h.git(['rev-parse', 'HEAD']));
  assert.equal(result.ok, true);
  assert.deepEqual(result.outer_before, []);
  assert.deepEqual(result.outer_after, []);
  assert.deepEqual(result.gate_root_after, []);
  assert.equal(result.gate_parents.length, 1);
  assert.equal(result.gate_parents[0].removed, true);
  assert.equal(result.suite_time.deadline_min, DEADLINE_MIN);
  assert.ok(result.suite_time.wall_ms > 0 && result.suite_time.wall_ms < DEADLINE_MIN * 60000);
  assert.equal(result.suite_time.warn, false);
});

test('suite time warns on GitHub past 75% of the deadline and records each run in the step summary', (t) => {
  const h = fixture(t);
  const summary = path.join(h.base, 'summary.md');
  for (const [minutes, warn] of [[33.75, false], [33.8, true], [46, true]]) {
    const time = suiteTime(minutes * 60000);
    assert.equal(time.warn, warn, `${minutes} min`);
    const lines = [];
    reportSuiteTime('Proof', time, { env: { GITHUB_STEP_SUMMARY: summary }, write: (line) => lines.push(line) });
    assert.match(lines[0], new RegExp(`^Proof: suite wall time ${minutes.toFixed(1)} min, \\d+% of the ${DEADLINE_MIN}-minute software-gate deadline$`));
    assert.equal(lines.length, warn ? 2 : 1);
    if (warn) assert.match(lines[1], /^::warning title=Suite time::Proof: suite wall time .* over the 75% warning line$/);
  }
  assert.deepEqual(fs.readFileSync(summary, 'utf8').trim().split('\n').map((line) => line.startsWith('Warning: ')), [false, true, true]);
});

test('the gate proof rejects a command that writes into the caller temp root', (t) => {
  const h = fixture(t);
  const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js',
    environment: { ...h.env, PROOF_LEAK: '1' } });
  assert.equal(result.exit, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.outer_after, ['escaped']);
});

test('the gate proof keeps the documented base rerun cache apart from gate scratch it fails on', (t) => {
  const h = fixture(t);
  const cache = path.join('tests-base-cache', 'repository', 'result.json');
  for (const [entry, ok, scratch, kept] of [
    [cache, true, [], ['tests-base-cache', path.dirname(cache), cache]],
    [path.join('tower-crane-stray', 'host'), false, ['tower-crane-stray', path.join('tower-crane-stray', 'host')], []],
  ]) {
    const result = probe({ root: h.repo, cache: path.join(h.base, `probe-${ok}`), command: 'node scratch.js',
      environment: { ...h.env, PROOF_ROOT_ENTRY: entry } });
    assert.equal(result.cleanup_ok, ok, entry);
    assert.deepEqual(result.gate_root_after, scratch, entry);
    assert.deepEqual(result.base_cache_after, kept, entry);
  }
});

test('the gate proof retains a failing gate result even when cleanup succeeds', (t) => {
  const h = fixture(t);
  const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js',
    environment: { ...h.env, PROOF_FAIL: '1' } });
  assert.equal(result.exit, 1);
  assert.equal(result.cleanup_ok, true);
  assert.equal(result.ok, false);
});

test('custom gate proofs retain their caller host readings across admission states', (t) => {
  const h = fixture(t);
  const variants = [
    { name: 'available', readings: {}, exit: 0 },
    { name: 'memory limit', readings: { used: 63 }, exit: 3, reason: /memory|line/ },
    { name: 'memory pressure', readings: { memorySome: 50 }, exit: 3, reason: /memory pressure/ },
    { name: 'CPU pressure', readings: { cpuSome: 90 }, exit: 3, reason: /cpu pressure/ },
    { name: 'load', readings: { load: 10000 }, exit: 3, reason: /load/ },
  ];
  for (const row of variants) {
    writeHost(h.env.TOWER_CRANE_HOST_ROOT, row.readings);
    const cache = path.join(h.base, 'probe');
    if (row.exit !== 0) {
      assert.throws(() => probe({ root: h.repo, cache, command: 'node scratch.js', environment: h.env }), (error) => {
        assert.match(error.message, /returned no JSON \(exit code 3\)/, row.name);
        assert.match(error.message, row.reason, row.name);
        return true;
      });
      assert.deepEqual(fs.readdirSync(cache), [], row.name);
    } else {
      const result = probe({ root: h.repo, cache, command: 'node scratch.js', environment: h.env });
      assert.equal(result.exit, 0, row.name);
      assert.equal(result.ok, true, row.name);
    }
  }
});

for (const row of [
  { name: 'refused', status: 1, stderr: 'fixture gate refused' },
  { name: 'usage failure', status: 2, stderr: 'fixture gate usage error' },
  { name: 'deferred', status: 3, stderr: 'fixture gate deferred by the host governor' },
  { name: 'empty successful output', status: 0, stderr: '' },
]) {
  test(`the gate proof reports a check with no receipt: ${row.name}`, (t) => {
    const h = fixture(t);
    const spawn = cp.spawnSync;
    t.mock.method(cp, 'spawnSync', (program, args, options) => {
      if (program === process.execPath && path.basename(args[0]) === 'tower-crane.js' && args[1] === 'check') {
        return { status: row.status, stdout: '', stderr: row.stderr };
      }
      return spawn(program, args, options);
    });
    const cache = path.join(h.base, 'probe');
    assert.throws(() => probe({ root: h.repo, cache, command: 'node scratch.js', environment: h.env }), (error) => {
      assert.equal(error.message,
        `tower-crane check tests T1 returned no JSON (exit code ${row.status}): ${row.stderr || '(no stderr)'}`);
      return true;
    });
    assert.deepEqual(fs.readdirSync(cache), [], 'the measurement state is removed even without a receipt');
  });
}
test('scratch proof preserves virtual host inputs and rejects missing gate receipts', (t) => {
  const failures = [];
  for (const row of [
    { name: 'healthy input, busy ambient host', supplied: {}, ambient: { memorySome: 15 }, exit: 0 },
    { name: 'memory deferral', supplied: { memorySome: 15 }, ambient: {}, exit: 3 },
    { name: 'CPU deferral', supplied: { cpuSome: 95 }, ambient: {}, exit: 3 },
    { name: 'ambient deferral without receipt', supplied: {}, ambient: { memorySome: 15 }, forced: true, exit: 3 },
  ]) {
    const h = fixture(t);
    const host = writeHost(h.env.TOWER_CRANE_HOST_ROOT, row.supplied);
    const ambient = writeHost(path.join(h.base, 'ambient-host'), row.ambient);
    const preload = path.join(h.base, 'ambient-host.js');
    // The real CLI sees this stand-in for the machine only when the probe
    // drops its supplied host, or when a row forces an admission deferral.
    fs.writeFileSync(preload, `if (!process.env.TOWER_CRANE_HOST_ROOT || process.env.PROOF_FORCE_HOST === '1') {
  process.env.TOWER_CRANE_HOST_ROOT = process.env.PROOF_AMBIENT_HOST;
}\n`);
    let result;
    try {
      result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js',
        environment: { ...h.env, TOWER_CRANE_HOST_ROOT: host, PROOF_AMBIENT_HOST: ambient,
          PROOF_FORCE_HOST: row.forced ? '1' : '0',
          NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require ${JSON.stringify(preload)}` } });
    } catch (error) {
      if (row.exit === 3) {
        assert.match(error.message, /returned no JSON \(exit code 3\):[\s\S]*deferred by the host governor/, row.name);
        assert.deepEqual(fs.readdirSync(path.join(h.base, 'probe')), [], row.name);
      } else failures.push(`${row.name}: ${error.message}`);
      continue;
    }
    if (row.exit === 3) {
      failures.push(`${row.name}: expected a missing-receipt error`);
      continue;
    }
    if (result.exit !== row.exit) {
      failures.push(`${row.name}: expected exit ${row.exit}, got ${result.exit}`);
      continue;
    }
    assert.equal(result.ok, row.exit === 0, row.name);
    assert.deepEqual(result.outer_after, [], row.name);
    assert.deepEqual(result.gate_root_after, [], row.name);
  }
  assert.deepEqual(failures, [], 'host readings and no-receipt outcomes are handled for every variant');
});

test('the gate proof stays isolated from a host over the governor defer line', (t) => {
  const h = fixture(t);
  const busyHost = writeHost(path.join(h.base, 'busy-host'), { cpuSome: 80, load: 10000 });
  const spawnSync = cp.spawnSync;
  const hosts = [];
  // A missing fake host sees a busy machine; the real CLI still runs the gate.
  t.mock.method(cp, 'spawnSync', (bin, args, options) => {
    if (args[1] === 'check') {
      hosts.push(options.env.TOWER_CRANE_HOST_ROOT);
      options = { ...options, env: { ...options.env,
        TOWER_CRANE_HOST_ROOT: options.env.TOWER_CRANE_HOST_ROOT || busyHost } };
    }
    return spawnSync(bin, args, options);
  });
  for (const [supplied, context] of [[true, undefined], [false, undefined], [false, 'child-v8']]) {
    const environment = { ...h.env, NODE_TEST_CONTEXT: context };
    if (!supplied) delete environment.TOWER_CRANE_HOST_ROOT;
    const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'),
      command: 'node scratch.js', environment });
    assert.equal(result.ok, true, `fake host supplied: ${supplied}, context: ${context}`);
    assert.ok(hosts.at(-1));
    if (supplied) assert.equal(hosts.at(-1), h.env.TOWER_CRANE_HOST_ROOT);
    assert.notEqual(hosts.at(-1), busyHost);
  }
});

test('human-bench fixtures give the nested CLI an idle fake host', (t) => {
  const h = fixture(t);
  h.init();
  const env = require('./bench/fixtures').cleanEnv(path.join(h.base, 'bench'));
  assert.equal(env.TOWER_CRANE_HOST_ROOT, path.join(h.base, 'bench', 'host'));
  const status = h.json(['status', '--agent', 'orchestrator'], { env });
  assert.equal(status.governor.state, 'open');
  assert.equal(status.governor.reading.load, 0);
});

test('a deferred nested gate reports its exit code and stderr and cleans the probe', (t) => {
  const h = fixture(t);
  const busyHost = writeHost(path.join(h.base, 'busy-host'), { cpuSome: 80, load: 10000 });
  const cache = path.join(h.base, 'probe');
  assert.throws(() => probe({ root: h.repo, cache, command: 'node scratch.js',
    environment: { ...h.env, TOWER_CRANE_HOST_ROOT: busyHost } }),
  /check tests T1 returned no JSON \(exit code 3\):[\s\S]*deferred by the host governor[\s\S]*cpu pressure/);
  assert.deepEqual(fs.readdirSync(cache), []);
});

test('a host measurement without a fake host still consults the real governor', (t) => {
  const h = fixture(t);
  const environment = { ...h.env };
  delete environment.TOWER_CRANE_HOST_ROOT;
  const script = `
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = (bin, args, options) => {
  if (args[1] === 'check') {
    assert.equal(options.env.TOWER_CRANE_HOST_ROOT, undefined);
    return JSON.parse(process.argv[2]);
  }
  return spawnSync(bin, args, options);
};
const { probe } = require(${JSON.stringify(require.resolve('../scripts/probe-gate-scratch'))});
try { probe({ root: process.cwd(), cache: process.argv[1], command: 'node scratch.js' }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`;
  for (const response of [
    { status: 3, stdout: '', stderr: 'host governor deferred the measurement' },
    { status: 0, stdout: ' \n ', stderr: '' },
    { status: 2, stdout: 'not JSON', stderr: 'invalid gate output' },
    { status: 1, stdout: 'null', stderr: 'missing gate result' },
  ]) {
    const out = cp.spawnSync(process.execPath, ['-e', script, path.join(h.base, 'probe'), JSON.stringify(response)], {
      cwd: h.repo, env: environment, encoding: 'utf8', timeout: HUNG_TEST_MS,
    });
    assert.equal(out.status, 1, out.stderr);
    assert.equal(out.stderr,
      `tower-crane check tests T1 returned no JSON (exit code ${response.status}): ${response.stderr || '(no stderr)'}\n`);
    assert.deepEqual(fs.readdirSync(path.join(h.base, 'probe')), []);
  }
});

test('the gate proof reports receipt-free governor deferrals from the supplied host', async (t) => {
  const cases = [
    ['memory capacity', { limit: 10, used: 8 }, /memory: tests\.slice/],
    ['memory pressure', { memorySome: 10 }, /memory pressure: some avg10 10%/],
    ['CPU pressure', { cpuSome: 60 }, /cpu pressure: some avg10 60%/],
    ['load', { load: os.availableParallelism() * 2 }, /load: /],
  ];
  for (const [name, host, reason] of cases) {
    await t.test(name, (t) => {
      const h = fixture(t);
      writeHost(h.env.TOWER_CRANE_HOST_ROOT, host);
      const cache = path.join(h.base, 'probe');
      assert.throws(() => probe({ root: h.repo, cache,
        command: 'node scratch.js', environment: h.env }), (error) => {
        assert.match(error.message, /check tests T1 returned no JSON \(exit code 3\):/);
        assert.match(error.message, /tests gate deferred by the host governor:/);
        assert.match(error.message, reason);
        return true;
      });
      assert.deepEqual(fs.readdirSync(cache), []);
    });
  }
});
