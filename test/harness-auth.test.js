'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTaskRepo } = require('./helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const fixture = path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/');
const clock = path.join(__dirname, 'fixtures', 'shifted-clock.js').replace(/\\/g, '/');
const supervision = { retries: 2, backoff_ms: 10, max_backoff_ms: 20, stall_ms: 60000 };
const owner = (h) => events(h).filter((e) => e.cmd === 'msg' && e.detail.to === 'owner');
const health = (h, source) => events(h).filter((e) => e.cmd === 'harness health' && (!source || e.detail.source === source));

// The claude login check is a real command on PATH. It reports the login flag file's presence.
function setup(t, { tier = 'easy', tasks = ['T1'], fallbacks = [] } = {}) {
  const h = makeTaskRepo(t, tasks.map((id) => ({
    args: ['--title', `Task ${id}`, '--tier', tier, '--kind', 'code', '--acceptance', 'a login failure is not a task attempt'],
    brief: 'Complete the original task brief.\n',
  })));
  const bin = path.join(h.base, 'bin');
  const exe = (name) => name + (process.platform === 'win32' ? '.exe' : '');
  fs.mkdirSync(bin);
  for (const harness of ['codex', 'agy', 'gh']) fs.writeFileSync(path.join(bin, exe(harness)), '', { mode: 0o755 });
  h.loginFlag = path.join(h.base, 'relogged');
  // The login check runs this script; on Windows the stub is only a placeholder that cannot run.
  fs.writeFileSync(path.join(bin, exe('claude')), process.platform === 'win32' ? ''
    : `#!${process.execPath}\nconsole.log(JSON.stringify({ loggedIn: require('node:fs').existsSync(process.env.TOWER_CRANE_TEST_LOGIN_FLAG) }));\n`, { mode: 0o755 });
  h.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--model', 'first', '--clear', 'profile', '--clear', 'effort', '--supervision', JSON.stringify(supervision)]);
  h.fallbacks = (routes) => {
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { easy: { fallbacks: routes } } }));
  };
  if (fallbacks.length) h.fallbacks(fallbacks);
  h.file = path.join(h.base, 'attempts.json');
  h.spawnEnv = {
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), GH_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require "${fixture}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: h.file, TOWER_CRANE_TEST_FALLBACK_REASON: 'auth',
    TOWER_CRANE_TEST_LOGIN_FLAG: h.loginFlag,
  };
  h.spawnTask = (id, env = h.spawnEnv) => h.run(['spawn', '--task', id, '--wait'], { env });
  // The shifted clock stamps events and reads intervals on one clock, so a pause can age past its probe interval.
  h.later = (minutes) => ({ ...h.spawnEnv, NODE_OPTIONS: `${h.spawnEnv.NODE_OPTIONS} --require "${clock}"`, TOWER_CRANE_TEST_NOW: String(Date.now() + minutes * 60000) });
  h.attempts = () => (fs.existsSync(h.file) ? JSON.parse(fs.readFileSync(h.file, 'utf8')) : []);
  return h;
}

test('a claude login failure falls back to another harness, pauses claude with one owner notice, and retries nothing', (t) => {
  const h = setup(t, { tasks: ['T1', 'T2'], fallbacks: [{ harness: 'codex', model: 'second' }] });
  const first = h.spawnTask('T1');
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model, a.retry]), [['claude', 'first', '0'], ['codex', 'second', '0']]);
  assert.deepEqual(health(h).map((e) => [e.detail.harness, e.detail.status, e.detail.source]), [['claude', 'unavailable', 'exit']]);
  assert.match(health(h)[0].detail.reason, /Failed to authenticate: OAuth session expired/);
  assert.equal(owner(h).length, 1);
  assert.match(owner(h)[0].detail.text, /claude login failed.*claude auth login/);
  // While claude is paused, the next task goes straight to the other harness.
  const second = h.spawnTask('T2');
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude', 'codex', 'codex']);
  assert.equal(owner(h).length, 1, 'a paused harness raises no second notice');
  assert.equal(health(h).length, 1, 'no login check runs before the probe interval');
});

test('a login failure on a ranged task is an availability failure, so the tier does not climb', (t) => {
  const h = setup(t, { tier: 'easy..medium' });
  const result = h.spawnTask('T1');
  assert.notEqual(result.code, 0);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude']);
  const exit = events(h).find((e) => e.cmd === 'spawn exit');
  assert.equal(exit.detail.code, 1);
  assert.equal(exit.detail.availability_failure, true);
  assert.equal(events(h).filter((e) => e.cmd === 'escalate').length, 0);
  assert.equal(h.json(['task', 'show', 'T1']).tier, 'easy');
  assert.equal(owner(h).length, 1);
});

test('a paused claude waits for its login check, then runs again once the check passes', { skip: process.platform === 'win32' && 'the login check stub is a POSIX script' }, (t) => {
  const h = setup(t, { tasks: ['T1', 'T2', 'T3'] });
  assert.notEqual(h.spawnTask('T1').code, 0);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude']);
  // Not yet due: dispatch refuses without running a check or a claude attempt.
  const early = h.run(['spawn', '--task', 'T2'], { env: h.spawnEnv });
  assert.notEqual(early.code, 0);
  assert.match(early.stderr, /claude is paused after a login failure \(Failed to authenticate.*re-login with `claude auth login`/);
  assert.equal(h.attempts().length, 1);
  // Due, and still logged out: the check records it, and dispatch keeps refusing.
  const stillOut = h.run(['spawn', '--task', 'T2'], { env: h.later(6) });
  assert.notEqual(stillOut.code, 0);
  assert.match(stillOut.stderr, /claude is paused/);
  // The interval is claimed before the check, then the failed check is recorded.
  assert.deepEqual(health(h, 'probe').map((e) => e.detail.status), ['unavailable', 'unavailable']);
  assert.equal(h.attempts().length, 1);
  // Within the same interval, another spawn runs no check.
  const throttled = h.run(['spawn', '--task', 'T3'], { env: h.spawnEnv });
  assert.notEqual(throttled.code, 0);
  assert.equal(health(h, 'probe').length, 2);
  // Logged in again: the next check clears the pause and claude runs.
  fs.writeFileSync(h.loginFlag, '');
  const relogged = h.run(['spawn', '--task', 'T2', '--wait'], { env: h.later(12) });
  assert.equal(relogged.code, 0, relogged.stderr);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['claude', 'first'], ['claude', 'first']]);
  assert.deepEqual(health(h, 'probe').map((e) => e.detail.status), ['unavailable', 'unavailable', 'unavailable', 'available']);
  assert.equal(owner(h).length, 1, 'clearing a pause raises no notice');
});

// Command fallback routes run the fixture through an executable committed in the repository.
function commandFallback(h) {
  const scripts = path.join(h.repo, 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, process.platform === 'win32' ? 'fallback.exe' : 'fallback'), '', { mode: 0o755 });
  h.git(['add', 'scripts']);
  h.git(['commit', '-m', 'Add fallback executable']);
}

test('a rung moved off a paused harness keeps the fallbacks after its new route', (t) => {
  const h = setup(t, { tasks: ['T1', 'T2'] });
  assert.notEqual(h.spawnTask('T1').code, 0);
  commandFallback(h);
  h.fallbacks([{ harness: 'codex', model: 'second' }, { harness: 'command', command: ['{cwd}/scripts/fallback', '--model', 'third', '{prompt}'] }]);
  // Claude is paused, so T2 starts on codex; codex's second model fails with the login error, and command's third does not.
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN = '1';
  const result = h.spawnTask('T2');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().slice(1).map((a) => [a.harness, a.model]), [['codex', 'second'], ['command', 'third']]);
  assert.deepEqual(health(h).map((e) => e.detail.harness), ['claude', 'codex']);
});

test('a fallback never revisits a harness that its own login failure paused', (t) => {
  const h = setup(t, { fallbacks: [
    { harness: 'command', command: ['{cwd}/scripts/fallback', '--model', 'second', '{prompt}'] },
    { harness: 'command', command: ['{cwd}/scripts/fallback', '--model', 'third', '{prompt}'] },
  ] });
  commandFallback(h);
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN = '1';
  assert.notEqual(h.spawnTask('T1').code, 0);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['claude', 'first'], ['command', 'second']]);
  assert.deepEqual(health(h).map((e) => e.detail.harness), ['claude', 'command']);
  assert.equal(owner(h).length, 2);
});

test('a paused fallback takes its probe interval only when it runs, not when its primary is dispatched', { skip: process.platform === 'win32' && 'the login check stub is a POSIX script' }, (t) => {
  const h = setup(t, { tasks: ['T1', 'T2'], fallbacks: [{ harness: 'command', command: ['{cwd}/scripts/fallback', '--model', 'second', '{prompt}'] }] });
  commandFallback(h);
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN = '1';
  assert.notEqual(h.spawnTask('T1').code, 0);
  // Re-login clears claude's check, but the login still fails on the next spawn; command is past its interval and runs as the fallback.
  fs.writeFileSync(h.loginFlag, '');
  delete h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN;
  h.spawnEnv.TOWER_CRANE_TEST_LOGIN_BROKEN = '1';
  const result = h.run(['spawn', '--task', 'T2', '--wait'], { env: h.later(6) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['claude', 'first'], ['command', 'second'], ['claude', 'first'], ['command', 'second']]);
  assert.deepEqual(health(h).filter((e) => e.detail.harness === 'command').map((e) => [e.detail.status, e.detail.source]),
    [['unavailable', 'exit'], ['unavailable', 'probe'], ['available', 'spawn']]);
});

test('a harness without a login check takes one spawn per interval as its probe, and a clean exit clears the pause', (t) => {
  const h = setup(t, { tasks: ['T1', 'T2', 'T3'], fallbacks: [{ harness: 'command', command: ['{cwd}/scripts/fallback', '--model', 'second', '{prompt}'] }] });
  commandFallback(h);
  // The second route fails too, so claude and command both pause.
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN = '1';
  assert.notEqual(h.spawnTask('T1').code, 0);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['claude', 'first'], ['command', 'second']]);
  assert.equal(owner(h).length, 2);
  const early = h.run(['spawn', '--task', 'T2'], { env: h.spawnEnv });
  assert.match(early.stderr, /claude is paused/);
  assert.equal(h.attempts().length, 2);
  // Past the interval, command is let through as its own probe; it fails again, so it stays paused without a second notice.
  const probing = h.run(['spawn', '--task', 'T2', '--wait'], { env: h.later(6) });
  assert.notEqual(probing.code, 0);
  assert.deepEqual(h.attempts().slice(2).map((a) => a.harness), ['command']);
  assert.equal(owner(h).length, 2);
  // A clean exit on command clears its pause; claude is still logged out.
  delete h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_CHAIN;
  const cleared = h.run(['spawn', '--task', 'T3', '--wait'], { env: h.later(12) });
  assert.equal(cleared.code, 0, cleared.stderr);
  // Each admitted spawn is recorded as the probe for its interval before it runs.
  assert.deepEqual(health(h).filter((e) => e.detail.harness === 'command').map((e) => [e.detail.status, e.detail.source]),
    [['unavailable', 'exit'], ['unavailable', 'probe'], ['unavailable', 'exit'], ['unavailable', 'probe'], ['available', 'spawn']]);
  assert.equal(owner(h).length, 2, 'clearing a pause raises no notice');
});
