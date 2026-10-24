'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');

// The host probe at a load small enough for a test: one short window with the
// profiler preloaded into the supervisor and the follow host, then the agent's exit.
test('the supervision probe measures a window, profiles both processes and times the monitor exit', { skip: process.platform !== 'linux' && 'the probe reads /proc' }, (t) => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const profiles = fs.mkdtempSync(path.join(TMP_ROOT, 'bench-profiles-'));
  t.after(() => fs.rmSync(profiles, { recursive: true, force: true }));
  // The probe loads test/helpers.js, which would report to this runner under its test context.
  const env = { ...process.env, TOWER_CRANE_TEST_TMP: TMP_ROOT };
  delete env.NODE_TEST_CONTEXT;
  const run = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bench-supervision.js'),
    '--windows', '1', '--window-s', '1', '--warmup-s', '0', '--log-mb', '1', '--log-lines', '2000', '--tasks', '3', '--profile', profiles],
  { cwd: ROOT, env, encoding: 'utf8', timeout: HUNG_TEST_MS, maxBuffer: 16 * 2 ** 20 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(result.windows.length, 1);
  for (const who of ['monitor', 'follow']) {
    assert.ok(result.windows[0][who].cpu_s_per_min >= 0, `${who} CPU`);
    assert.ok(result.windows[0][who].rss_mb > 0, `${who} RSS`);
  }
  assert.ok(result.log_bytes >= 2 ** 20, `log of ${result.log_bytes} bytes`);
  assert.ok(result.monitor_exit_s !== null && result.monitor_exit_s < 120, `monitor exit ${result.monitor_exit_s}`);
  const written = fs.readdirSync(profiles).filter((f) => f.endsWith('.cpuprofile'));
  assert.equal(written.length, 2, `profiles: ${written.join(', ')}`);
  for (const file of written) assert.ok(JSON.parse(fs.readFileSync(path.join(profiles, file), 'utf8')).nodes.length > 0, file);
});
