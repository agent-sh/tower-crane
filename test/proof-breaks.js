'use strict';

// Host probes plant defects in the proof's temporary processes and copies.
// The task checkout stays intact so the same head can run both clean proofs.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROOF_DEADLINE_MIN } = require('../scripts/suite-time');

const kind = process.argv[2];
assert.ok(['scratch', 'model-swap'].includes(kind), 'use scratch or model-swap');
const root = path.resolve(__dirname, '..');
const cache = process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-proof');
fs.mkdirSync(cache, { recursive: true });
const run = fs.mkdtempSync(path.join(cache, 'proof-break-'));
const hook = path.join(run, 'plant.cjs');
const expected = 'worker setup depends on the built-in harness';
const originalHarness = require('../lib/ladder').BUILTIN.harness;
try {
  fs.writeFileSync(hook, kind === 'scratch' ? `
const fs = require('node:fs');
const path = require('node:path');
const remove = fs.rmSync;
fs.rmSync = function (dir, options) {
  if (process.argv[2] === 'check' && process.argv[3] === 'tests'
    && path.dirname(String(dir)) === process.env.TOWER_CRANE_TMP) return;
  return remove.call(this, dir, options);
};
` : `
const fs = require('node:fs');
const path = require('node:path');
const copy = fs.copyFileSync;
fs.copyFileSync = function (source, dest, ...rest) {
  const result = copy.call(this, source, dest, ...rest);
  if (dest.endsWith(path.join('test', 'spawn.test.js'))) {
    fs.appendFileSync(dest, '\\nrequire("node:test")(${JSON.stringify(expected)}, () => { require("node:assert/strict").equal(require("../lib/ladder").BUILTIN.harness, ${JSON.stringify(originalHarness)}); });\\n');
  }
  return result;
};
`);
  const script = kind === 'scratch' ? 'probe-gate-scratch.js' : 'probe-model-swap.js';
  const started = performance.now();
  const result = cp.spawnSync(process.execPath, ['--require', hook, path.join(root, 'scripts', script)], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 << 20,
    timeout: (2 * PROOF_DEADLINE_MIN + 3) * 60000, // wait-allow: two proof deadlines plus setup
    env: { ...process.env, TOWER_CRANE_TEST_TMP: run,
      TOWER_CRANE_PROOF_OUTPUT: path.join(run, 'scratch.json'),
      // The scratch proof starts its real gate in another process.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(hook)}` },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  if (kind === 'scratch') {
    const proof = JSON.parse(fs.readFileSync(path.join(run, 'scratch.json'), 'utf8'));
    assert.equal(proof.gate.ok, true, JSON.stringify(proof.gate));
    assert.equal(proof.cleanup_ok, false);
    assert.ok(proof.gate_parents.some(parent => !parent.removed));
  } else {
    assert.match(result.stderr, /expected only "BUILTIN matches the documented defaults and init fallback" to fail/);
    assert.ok(result.stderr.includes(expected), result.stderr);
  }
  console.log(`${kind}: planted ${kind === 'scratch' ? 'gate parent leak' : 'built-in harness dependency'} caught in ${((performance.now() - started) / 1000).toFixed(1)} s`);
} finally {
  fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
