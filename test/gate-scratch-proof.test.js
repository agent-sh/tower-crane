'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('the gate proof retains a failing gate result even when cleanup succeeds', (t) => {
  const h = fixture(t);
  const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js',
    environment: { ...h.env, PROOF_FAIL: '1' } });
  assert.equal(result.exit, 1);
  assert.equal(result.cleanup_ok, true);
  assert.equal(result.ok, false);
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
