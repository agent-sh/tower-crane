'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, ROOT } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');

function fixture(t) {
  return cachedFixture(t, 'proof-break-driver', h => {
    // The host proof response is bounded; its actual generated mutation hook runs.
    fs.writeFileSync(path.join(h.repo, 'driver.cjs'), `
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.PROOF_REAL_ROOT;
const originalHarness = require(path.join(root, 'lib', 'ladder.js')).BUILTIN.harness;
const { PROOF_DEADLINE_MIN } = require(path.join(root, 'scripts', 'suite-time.js'));
const expected = 'worker setup depends on the built-in harness';
cp.spawnSync = (program, args, options) => {
  const kind = process.argv[2];
  const variant = process.env.PROOF_VARIANT;
  const run = options.env.TOWER_CRANE_TEST_TMP;
  assert.equal(program, process.execPath);
  assert.deepEqual(args, ['--require', path.join(run, 'plant.cjs'),
    path.join(root, 'scripts', kind === 'scratch' ? 'probe-gate-scratch.js' : 'probe-model-swap.js')]);
  assert.equal(options.cwd, root);
  assert.equal(options.timeout, (2 * PROOF_DEADLINE_MIN + 3) * 60000);
  assert.ok(options.env.NODE_OPTIONS.includes(JSON.stringify(args[1])));
  fs.writeFileSync(process.env.PROOF_RECORD, JSON.stringify({ run, hook: args[1] }));
  if (variant === 'child error') return { error: new Error('fixture subprocess error'), status: null };

  let stderr = '';
  if (kind === 'scratch') {
    const gates = path.join(run, 'gates');
    const parent = path.join(gates, 'tower-crane-planted');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'owner.json'), '{}');
    const remove = fs.rmSync;
    const argv = process.argv;
    const tmp = process.env.TOWER_CRANE_TMP;
    try {
      process.argv = [process.execPath, 'tower-crane.js', 'check', 'tests'];
      process.env.TOWER_CRANE_TMP = gates;
      require(args[1]);
      fs.rmSync(parent, { recursive: true, force: true });
      assert.ok(fs.existsSync(parent), 'the actual scratch hook must leave the gate parent');
      if (variant === 'property absent') remove(parent, { recursive: true, force: true });
      const leaked = fs.existsSync(parent);
      fs.writeFileSync(options.env.TOWER_CRANE_PROOF_OUTPUT, JSON.stringify({
        gate: { ok: variant !== 'failed gate' }, cleanup_ok: !leaked,
        gate_parents: [{ path: parent, removed: !leaked }],
      }));
    } finally {
      fs.rmSync = remove;
      process.argv = argv;
      if (tmp === undefined) delete process.env.TOWER_CRANE_TMP;
      else process.env.TOWER_CRANE_TMP = tmp;
    }
  } else {
    const source = path.join(run, 'seed.js');
    const dest = path.join(run, 'copy', 'test', 'spawn.test.js');
    fs.writeFileSync(source, "'use strict';\\n");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const copy = fs.copyFileSync;
    try {
      require(args[1]);
      fs.copyFileSync(source, dest);
    } finally { fs.copyFileSync = copy; }
    const harness = variant === 'property absent' ? originalHarness
      : originalHarness === 'pi' ? 'codex' : 'pi';
    const failures = [];
    let tests = 0;
    vm.runInNewContext(fs.readFileSync(dest, 'utf8'), { require(id) {
      if (id === 'node:assert/strict') return assert;
      if (id === '../lib/ladder') return { BUILTIN: { harness } };
      assert.equal(id, 'node:test');
      return (name, fn) => {
        tests++;
        assert.equal(name, expected);
        try { fn(); } catch { failures.push(name); }
      };
    } });
    assert.equal(tests, 1, 'the actual copy hook must add its harness dependency test');
    const prefix = variant === 'wrong diagnostic' ? 'unrelated failure'
      : 'expected only "BUILTIN matches the documented defaults and init fallback" to fail';
    stderr = prefix + ': ' + JSON.stringify(failures);
  }
  return { status: variant === 'wrong status' ? 0 : 1, stdout: '', stderr };
};
`);
  });
}

test('planted proof CLI detects each property and rejects false evidence, cleaning every outcome', async t => {
  for (const row of [
    { kind: 'scratch', variant: 'detected', ok: true },
    { kind: 'scratch', variant: 'property absent', ok: false },
    { kind: 'scratch', variant: 'failed gate', ok: false },
    { kind: 'scratch', variant: 'wrong status', ok: false },
    { kind: 'scratch', variant: 'child error', ok: false },
    { kind: 'model-swap', variant: 'detected', ok: true },
    { kind: 'model-swap', variant: 'property absent', ok: false },
    { kind: 'model-swap', variant: 'wrong diagnostic', ok: false },
    { kind: 'model-swap', variant: 'wrong status', ok: false },
    { kind: 'model-swap', variant: 'child error', ok: false },
  ]) {
    await t.test(`${row.kind}: ${row.variant}`, t => {
      const h = fixture(t);
      const cache = path.join(h.base, 'probe-cache');
      const record = path.join(h.base, 'record.json');
      const result = cp.spawnSync(process.execPath, ['--require', path.join(h.repo, 'driver.cjs'),
        path.join(ROOT, 'test', 'proof-breaks.js'), row.kind], {
        cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache,
          PROOF_VARIANT: row.variant, PROOF_RECORD: record, PROOF_REAL_ROOT: ROOT },
        encoding: 'utf8', timeout: HUNG_TEST_MS,
      });
      assert.ifError(result.error);
      assert.equal(result.status, row.ok ? 0 : 1, result.stdout + result.stderr);
      if (row.ok) assert.match(result.stdout, new RegExp(`^${row.kind}: planted .* caught in \\d+\\.\\d s`, 'm'));
      else assert.match(result.stderr, /AssertionError/);
      const { run, hook } = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.equal(fs.existsSync(run), false, 'scratch is removed after success and failure');
      assert.equal(fs.existsSync(hook), false, 'the mutation hook is removed');
      assert.deepEqual(fs.readdirSync(cache), []);
    });
  }
});

test('planted proof CLI refuses invalid modes before allocating scratch', async t => {
  for (const kind of [undefined, 'unknown']) {
    await t.test(kind || 'missing mode', t => {
      const h = fixture(t);
      const cache = path.join(h.base, 'probe-cache');
      const result = cp.spawnSync(process.execPath, [path.join(ROOT, 'test', 'proof-breaks.js'),
        ...(kind ? [kind] : [])], {
        cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache },
        encoding: 'utf8', timeout: HUNG_TEST_MS,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /use scratch or model-swap/);
      assert.equal(fs.existsSync(cache), false);
    });
  }
});
