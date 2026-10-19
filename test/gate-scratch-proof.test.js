'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture } = require('./helpers');
const { writeHost } = require('./host');
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
    const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js', environment: h.env });
    assert.equal(result.exit, row.exit, row.name);
    assert.equal(result.ok, row.exit === 0, row.name);
    if (row.exit !== 0) {
      assert.equal(result.gate, null, row.name);
      assert.match(result.stderr, row.reason, row.name);
      assert.deepEqual(result.gate_parents, [], row.name);
      assert.equal(result.cleanup_ok, false, 'a command that never ran cannot prove its scratch cleanup');
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
    const result = probe({ root: h.repo, cache: path.join(h.base, 'probe'), command: 'node scratch.js', environment: h.env });
    assert.equal(result.exit, row.status);
    assert.equal(result.stderr, row.stderr);
    assert.equal(result.gate, null);
    assert.equal(result.ok, false);
    assert.equal(result.cleanup_ok, false);
    assert.deepEqual(result.gate_parents, []);
    assert.deepEqual(result.outer_after, []);
    assert.deepEqual(result.gate_root_after, []);
    assert.equal(fs.existsSync(result.outer), false, 'the measurement state is removed even without a receipt');
  });
}
