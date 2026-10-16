'use strict';

// test/fixtures/user-config-guard.js: a process that resolves the user ladder
// file outside the test roots fails, through every lib/ladder.js entry point,
// even when the code that called it caught the error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, TMP_ROOT } = require('./helpers');

const GUARD = path.join(__dirname, 'fixtures', 'user-config-guard.js');
const LADDER = path.join(ROOT, 'lib', 'ladder.js');
// Never created: the guard refuses before any read.
const OUTSIDE = path.join(path.parse(TMP_ROOT).root, 'tower-crane-guard-outside', 'config.json');

// os.homedir() reads HOME, or USERPROFILE on Windows.
const homeEnv = (home) => ({ HOME: home, USERPROFILE: home });
const OUTSIDE_HOME = path.dirname(path.dirname(path.dirname(OUTSIDE)));

// Runs a script with the guard preloaded and the given root as the only one.
function guarded(t, script, env) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'user-config-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inside = path.join(root, 'home', '.config', 'tower-crane', 'config.json');
  const r = cp.spawnSync(process.execPath, ['--require', GUARD, '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: '', TOWER_CRANE_CONFIG: '', TC_USER_CONFIG_HITS: '', TC_USER_CONFIG_ROOTS: root, ...homeEnv(path.join(root, 'home')), ...env({ root, inside }) },
  });
  return { code: r.status, stderr: r.stderr };
}

const swallowed = (call) => `const L = require(${JSON.stringify(LADDER)}); try { ${call}; } catch {} console.log('done');`;

test('a ladder call that resolves the user file outside the test roots fails the process, though its caller caught the error', (t) => {
  const cases = [
    // resolve and readUser reach userFile inside lib/ladder.js, not through its export.
    ['resolve with an explicit file', 'L.resolve({}, process.env)', () => ({ TOWER_CRANE_CONFIG: OUTSIDE })],
    ['readUser with an explicit file', 'L.readUser(process.env)', () => ({ TOWER_CRANE_CONFIG: OUTSIDE })],
    ['check with an explicit file', 'L.check({}, process.env)', () => ({ TOWER_CRANE_CONFIG: OUTSIDE })],
    ['the exported userFile', 'L.userFile(process.env)', () => ({ TOWER_CRANE_CONFIG: OUTSIDE })],
    ['resolve with the default file under a home outside the roots', 'L.resolve({}, process.env)', () => homeEnv(OUTSIDE_HOME)],
  ];
  for (const [name, call, env] of cases) {
    const r = guarded(t, swallowed(call), env);
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /a test resolved the user config outside the fixture root/, name);
    assert.ok(r.stderr.includes(name.includes('default') ? path.join(OUTSIDE_HOME, '.config', 'tower-crane', 'config.json') : OUTSIDE), name);
  }
  for (const [name, env] of [
    ['an explicit file in the root', ({ inside }) => ({ TOWER_CRANE_CONFIG: inside })],
    ['the default file under a home in the root', () => ({})],
  ]) {
    const r = guarded(t, swallowed('L.resolve({}, process.env)'), env);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
  }
});

test('a CLI a test runs fails, and fails its fixture cleanup, when its user file lies outside the test roots', async () => {
  const h = makeRepo(null);
  h.init();
  h.ok(['status']);
  // The board view draws a broken ladder as an error, so only the exit check fails the CLI.
  const r = h.run(['status'], { env: { TOWER_CRANE_CONFIG: OUTSIDE } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /a test resolved the user config outside the fixture root/);
  // A test that expects a nonzero exit, or never waits for the CLI, still fails at cleanup.
  await assert.rejects(h.cleanup(), (error) => error.message.includes('a test resolved the user config outside the fixture root') && error.message.includes(OUTSIDE));
});
