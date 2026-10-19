'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
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
