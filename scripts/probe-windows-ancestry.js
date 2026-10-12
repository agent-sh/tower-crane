'use strict';

// Prove the new regression against a PR base that still queries each parent,
// then restore the submitted code before running its Windows repetitions.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'lib', 'orchestrator.js');
const base = process.env.TOWER_CRANE_CHANGE_BASE;
if (process.platform !== 'win32' || !base) {
  console.log('Windows ancestry baseline proof: no Windows PR base');
  return;
}
const before = cp.execFileSync('git', ['show', `${base}:lib/orchestrator.js`], { cwd: root });
if (!before.includes('Get-CimInstance Win32_Process -Filter')) {
  console.log('Windows ancestry baseline proof: base already uses a snapshot');
  return;
}
const after = fs.readFileSync(file);
let result;
try {
  fs.writeFileSync(file, before);
  const env = { ...process.env };
  delete env.TC_TEST_SHARD;
  result = cp.spawnSync(process.execPath, [
    path.join(root, 'test', 'run.js'), 'test/windows-ancestry.test.js',
  ], { cwd: root, env, encoding: 'utf8', timeout: 300000 });
} finally {
  fs.writeFileSync(file, after);
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error || result.status !== 1
  || !result.stdout.includes('discovery must use one consistent snapshot')) {
  throw new Error('Windows ancestry baseline did not fail for per-parent CIM queries');
}
console.log('Windows ancestry baseline proof: failed as expected for per-parent CIM queries');
