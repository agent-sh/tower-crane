'use strict';

const { waitOnRepo } = require('./signals');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, makeProjectRepo, makeTaskRepo, ownerFallbacks } = require('./helpers');
const { readPublished } = require('./atomic-file');
const A = require('../lib/agents');
const RouteGrants = require('../lib/route-grants');
const { tempRoot } = require('./tmp-root');
// Independent cases run two at a time on every platform: most of each one waits on its child processes.
const caseConcurrency = 2;

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const supervision = { retries: 2, backoff_ms: 10, max_backoff_ms: 20, stall_ms: 60000 };
// A waiter blocks until its event arrives. The runner's per-test timeout
// (test/run.js) is its only bound: three attempts and a route switch, each a
// supervised harness launch, took up to 14 s on a Windows runner.
const WAIT_TIMEOUT_S = '300';

// The owner's personal fallbacks (helpers.js ownerFallbacks).
function setFallbacks(h, routes, rung = 'easy') {
  ownerFallbacks(h, rung, routes);
}

// Fallbacks edited into the user file by hand, outside the CLI.
function handFallbacks(h, routes, rung = 'easy') {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { [rung]: { fallbacks: routes } } }));
}

function setup(t, { reason = 'outage', primaryHarness = 'codex', nextHarness = 'codex', chain = false,
  rung = 'easy', webMcp, fallbackWebMcp } = {}) {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Fallback routes', '--tier', rung,
      '--kind', rung === 'research' ? 'research' : 'code', '--acceptance', 'fresh fallback session'],
    brief: 'Complete the original task brief.\n',
  }]);
  // Harness discovery must use fixture credentials and origin directories.
  Object.assign(h.env, {
    USERPROFILE: h.env.HOME,
    CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'),
    CODEX_HOME: path.join(h.env.HOME, '.codex'),
    PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
    GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'),
    XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(h.env.HOME, '.config', 'opencode'),
  });
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  // A gh on PATH and no token in the environment make every route ask gh for
  // one, as on a CI runner; that must happen outside the state lock.
  for (const harness of ['codex', 'claude', 'agy', 'pi', 'opencode', 'gh']) fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  const routes = [{ harness: nextHarness, model: 'second', env: { ROUTE_ENV: 'fallback', NODE_TEST_CONTEXT: 'child-v8' } }];
  if (fallbackWebMcp) routes[0].web_mcp = fallbackWebMcp;
  if (chain) routes.push({ harness: 'claude', model: 'third' });
  h.ok(['ladder', 'set', rung, '--harness', primaryHarness, '--model', 'first', '--clear', 'profile', '--clear', 'effort',
    '--env', '{"ROUTE_ENV":"primary","NODE_TEST_WORKER_ID":"outer-worker"}', '--supervision', JSON.stringify(supervision),
    ...(webMcp ? ['--web-mcp', JSON.stringify(webMcp)] : [])]);
  // The fallback env is a grant: the owner writes it through ladder set.
  h.ok(['ladder', 'set', rung, '--fallbacks', JSON.stringify(routes)]);
  h.file = path.join(h.base, 'attempts.json');
  h.spawnEnv = {
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), GH_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: h.file, TOWER_CRANE_TEST_FALLBACK_REASON: reason,
    ...(chain ? { TOWER_CRANE_TEST_FALLBACK_CHAIN: '1' } : {}),
  };
  h.spawn = () => h.run(['spawn', '--task', 'T1', '--wait'], { env: h.spawnEnv });
  h.attempts = () => JSON.parse(readPublished(h.file, 'utf8'));
  return h;
}

for (const [route, reason] of [['retry', 'outage'], ['fallback', 'refusal']]) {
  test(`a synchronous containment throw on ${route} is recorded without a supervisor rejection`, async t => {
    const h = setup(t, { reason });
    h.spawnEnv.TC_CONTAINMENT_RELAUNCH_PROBE = 'throw';
    const result = h.spawn();
    assert.notEqual(result.code, 0);
    const blocked = events(h).find(e => e.cmd === 'spawn phase' && e.detail.reason === 'resource-scope-failed' && e.detail.error);
    assert.ok(blocked, result.stdout + result.stderr);
    assert.match(blocked.detail.error, /scope setup failed synchronously/);
    assert.doesNotMatch(result.stderr, /supervisor failed|UnhandledPromiseRejection/);
  });
}

test('a late cap event from an exited attempt does not stop its retry', async t => {
  const h = setup(t);
  h.spawnEnv.TC_CONTAINMENT_RELAUNCH_PROBE = 'late';
  const result = h.spawn();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(events(h).some(e => e.cmd === 'spawn phase' && e.detail.reason === 'resource-memory-max'), false);
  assert.deepEqual(h.attempts().map(a => a.model), ['first', 'first', 'first', 'second']);
});

for (const row of [
  { state: 'fresh', nextHarness: 'codex', reason: 'outage', chain: true, ack: true },
  { state: 'fresh', nextHarness: 'claude', reason: 'refusal', ack: false },
  { state: 'resumed', nextHarness: 'codex', reason: 'refusal', ack: true },
  { state: 'resumed', nextHarness: 'claude', reason: 'outage', ack: true },
  { state: 'running', nextHarness: 'claude', reason: 'auth', ack: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: false },
  { state: 'retrying', primaryHarness: 'agy', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'pi', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'opencode', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'no-session', ack: true },
]) {
  test(`decision answers survive fallback: ${row.state} ${row.primaryHarness || 'codex'} to ${row.nextHarness}, ${row.reason}, ${row.ack ? 'acknowledged' : 'unread'}`, async (t) => {
    const h = setup(t, row);
    const agent = 'worker-T1-1';
    const finish = path.join(h.base, 'finish-primary');
    const login = path.join(h.base, 'login');
    if (row.state === 'running') {
      Object.assign(h.spawnEnv, { TOWER_CRANE_TEST_FALLBACK_FINISH: finish, TOWER_CRANE_TEST_LATE_AUTH: 'first' });
    }
    if (row.state === 'retrying') {
      Object.assign(h.spawnEnv, { TOWER_CRANE_TEST_FALLBACK_FINISH: finish, TOWER_CRANE_TEST_LATE_OUTAGE: '1' });
    }
    if (row.state !== 'fresh') {
      fs.writeFileSync(login, '');
      const first = h.json(['spawn', '--task', 'T1', ...(row.state === 'resumed' ? ['--wait'] : [])], {
        env: { ...h.spawnEnv, TOWER_CRANE_TEST_LOGIN_FLAG: login },
      });
      assert.equal(first.agent, agent);
      if (row.state === 'running' || row.state === 'retrying') {
        await waitOnRepo(h, () => fs.existsSync(h.file) && h.attempts().length === 1, 'the primary worker to start', { alive: first.monitor_pid });
      } else {
        const session = events(h).findLast((e) => e.cmd === 'spawn session').detail.session_id;
        const sessions = path.join(h.state, 'homes', '.codex', agent, 'sessions');
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, `rollout-${session}.jsonl`), '{}\n');
      }
    }
    h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--blocks', 'T1', '--agent', agent]);
    const note = 'Use Redis.\nAlso fix the CI gate so dispatch runs do not poison it.';
    h.ok(['answer', 'D1', '--choice', 'redis', '--note', note, '--agent', 'orchestrator']);
    if (row.ack) {
      const binding = path.join(h.state, 'homes', agent, 'hook.json');
      fs.mkdirSync(path.dirname(binding), { recursive: true });
      fs.writeFileSync(binding, JSON.stringify({ state: h.state, agent, task: 'T1', role: 'worker', attempt: 1 }));
      const delivered = h.json(['hook', 'inbox', '--binding', binding, '--agent', agent]);
      assert.ok(delivered.context.includes(`Orchestrator note:\n${note}`));
      assert.equal(h.json(['hook', 'inbox', '--binding', binding, '--agent', agent]).context, '');
    }
    h.ok(['ask', '--kind', 'technical', '--question', 'Unrelated work?', '--agent', 'other-worker']);
    h.ok(['answer', 'D2', '--choice', 'other', '--note', 'Other task requirement.', '--agent', 'orchestrator']);
    if (row.state === 'resumed') {
      h.ok(['submit', 'T1', '--agent', agent, '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
      h.ok(['rework', 'T1', '--reason', 'Continue after the decision.']);
      assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv }).resumed, true);
    }
    const before = row.state === 'fresh' ? 0 : h.attempts().length;
    if (row.state === 'running' || row.state === 'retrying') {
      if (row.state === 'retrying') fs.unlinkSync(login);
      fs.writeFileSync(finish, '');
      await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit'), 'the fallback worker to exit');
      const exit = events(h).findLast((e) => e.cmd === 'spawn exit').detail;
      assert.equal(exit.code, 0, JSON.stringify({ exit, attempts: h.attempts() }));
    } else {
      const result = h.spawn();
      assert.equal(result.code, 0, result.stderr);
    }
    const attempts = h.attempts().slice(before);
    assert.ok(attempts.some((a) => a.harness === row.nextHarness && a.model === 'second'));
    if (row.state === 'retrying') {
      const retries = attempts.filter((a) => a.model === 'first');
      assert.deepEqual(retries.map((a) => a.retry), ['1', '2']);
      if (row.primaryHarness === 'codex' && row.reason !== 'no-session') {
        assert.ok(retries.every((a) => a.args.includes('resume') && a.args.includes('11111111-1111-1111-1111-111111111111')));
        assert.ok(retries.every((a) => !a.args.some((arg) => arg.includes('## Decision answers'))),
          'warm resumes keep their conversation without repeating the answer section');
      } else assert.ok(retries.every((a) => !a.args.includes('resume') && !a.args.includes('--resume')));
      if (row.primaryHarness === 'claude') {
        const sessions = h.attempts().filter((a) => a.model === 'first')
          .map((a) => a.args[a.args.indexOf('--session-id') + 1]);
        assert.equal(new Set(sessions).size, 3, 'each Claude invocation starts a new conversation');
      }
    }
    const expected = `decision D1 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${note}`;
    for (const attempt of attempts) {
      // Warm retries keep the conversation; route starts rebuild its prompt.
      if (attempt.retry !== '0' && attempt.args.includes('resume')) continue;
      assert.ok(attempt.args.some((arg) => arg.includes(expected)), `${attempt.harness} ${attempt.model} retry ${attempt.retry} lost the answer`);
      assert.ok(!attempt.args.some((arg) => arg.includes('Other task requirement.')));
    }
    assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, row.chain ? 2 : 1);
  });
}

for (const explicit of [false, true]) {
  test(`research Claude fallback ${explicit ? 'sets' : 'inherits'} web MCP tools and worker confinement on Bedrock`, async (t) => {
    const server = { name: 'harness-web', command: 'node', args: ['/web/server.mjs'] };
    const override = { name: 'backup-web', command: 'node', args: ['/web/backup.mjs'] };
    const h = setup(t, { rung: 'research', primaryHarness: 'claude', nextHarness: 'claude',
      reason: 'refusal', webMcp: server, ...(explicit ? { fallbackWebMcp: override } : {}) });
    const cache = path.join(h.base, 'cache');
    fs.mkdirSync(cache);
    h.spawnEnv.XDG_CACHE_HOME = cache;
    h.spawnEnv.LOCALAPPDATA = cache;
    h.spawnEnv.CLAUDE_CODE_USE_BEDROCK = '1';
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.spawnEnv });
    const result = await h.runAsync(['wait', '--observe', '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', WAIT_TIMEOUT_S]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).detail.agent, spawned.agent);
    const [primary, fallback] = h.attempts();
    assert.equal(fallback.model, 'second');
    const web = explicit ? override : server;
    assert.deepEqual(fallback.mcp, { [web.name]: { command: web.command, args: web.args } });
    const tools = fallback.args[fallback.args.indexOf('--allowedTools') + 1].split(',');
    assert.ok(tools.includes(`mcp__${web.name}__websearch`));
    assert.ok(tools.includes(`mcp__${web.name}__webfetch`));
    assert.ok(!tools.includes('WebSearch') && !tools.includes('WebFetch'));
    assert.ok(fallback.args.includes('--strict-mcp-config'));
    assert.deepEqual(fallback.sandbox, primary.sandbox);
    assert.deepEqual(fallback.policy, primary.policy);
    assert.equal(fallback.policy.gitPush, 'branch');
    // No bare *, which claude refuses as too broad and then allows no host.
    assert.ok(fallback.sandbox.network.allowedDomains.includes('github.com') && !fallback.sandbox.network.allowedDomains.includes('*'));
  });
}

describe('independent fallback routes', { concurrency: caseConcurrency }, () => {
for (const nextHarness of ['codex', 'claude']) {
  test(`outage exhausts same-route retries before a fresh ${nextHarness} fallback and records route spend`, async (t) => {
    const h = setup(t, { nextHarness });
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.spawnEnv });
    // Windows pipe closure and hook writers can outlive the final harness.
    // Assert the recorded exit and usage instead of timing a foreground CLI.
    // worker-exited can be derived from a probe of an earlier attempt's process before
    // its exit is recorded, so the recorded spawn exit carries the final code.
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === spawned.agent), 'the worker did not record its exit');
    assert.equal(events(h).findLast((e) => e.cmd === 'spawn exit' && e.detail.agent === spawned.agent).detail.code, 0);
    await waitOnRepo(h, () => events(h).filter((e) => e.cmd === 'spend').length === 2, 'route usage receipts were not recorded');
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.model), ['first', 'first', 'first', 'second']);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '2', '0']);
    assert.ok(attempts[1].args.includes('resume'));
    assert.ok(attempts[2].args.includes('resume'));
    assert.equal(attempts[3].args.includes('resume'), false);
    assert.notEqual(attempts[3].session, attempts[2].session);
    assert.ok(attempts[3].args.some((a) => a.includes('Complete the original task brief.')));
    assert.deepEqual(attempts.map((a) => a.env), ['primary', 'primary', 'primary', 'fallback']);
    assert.ok(attempts.every((a) => a.node_test.length === 0), 'initial, retry and fallback environments exclude Node test runner context');
    for (const attempt of attempts) assert.deepEqual(attempt.claim, attempts[0].claim);
    const switches = events(h).filter((e) => e.cmd === 'spawn fallback');
    assert.equal(switches.length, 1);
    assert.equal(switches[0].detail.route_index, 1);
    assert.equal(switches[0].detail.reason, 'provider outage after 2 retries');
    const wake = h.json(['wait', '--observe', '--after', '0', '--types', 'spawn-fallback', '--timeout', '300']);
    assert.equal(wake.id, switches[0].id);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.run.phase, 'waiting');
    assert.equal(task.run.model, 'second');
    assert.deepEqual(task.spend.entries.map((e) => [e.model, e.harness, e.tokens]),
      [['first', 'codex', 39], ['second', nextHarness, nextHarness === 'codex' ? 13 : 24]]);
    const tokens = task.spend.tokens;
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
    h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
    h.ok(['rework', 'T1', '--reason', 'fix review finding']);
    const preview = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv });
    assert.equal(preview.resumed, false, 'the original route must not resume a fallback session');
  });
}

test('a browser-capable route can fall back to an unsupported harness without blocking dispatch', (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'agy' });
  h.ok(['task', 'update', 'T1', '--kind', 'design', '--needs', '["browser"]']);
  const home = path.join(h.base, 'browser-user');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'browser-server' } } }));
  Object.assign(h.spawnEnv, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: path.join(home, '.codex') });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude', 'claude', 'claude', 'agy']);
  assert.match(result.stderr, /browser kit.*agy.*without it/);
  const fallback = events(h).find((e) => e.cmd === 'spawn fallback');
  assert.deepEqual(fallback.detail.browser_kit.attached, []);
  assert.deepEqual(fallback.detail.browser_kit.omitted, ['playwright']);
  assert.match(fallback.detail.browser_kit.warning, /agy.*without it/);
});

test('policy refusal on a successful exit advances the ordered routes without outage retries', (t) => {
  const h = setup(t, { reason: 'refusal', chain: true });
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'second', 'third']);
  assert.ok(h.attempts().every((a) => !a.args.includes('resume')));
  assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
  assert.deepEqual(events(h).filter((e) => e.cmd === 'spawn fallback').map((e) => e.detail.reason), ['harness refusal', 'harness refusal']);
});

test('Claude policy refusal starts a fresh Codex route', (t) => {
  const h = setup(t, { reason: 'refusal', primaryHarness: 'claude' });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.harness), ['claude', 'codex']);
  assert.equal(h.attempts()[1].args.includes('resume'), false);
  assert.notEqual(h.attempts()[1].session, h.attempts()[0].session);
});

for (const [primaryHarness, reason, chain, routes] of [['claude', 'refusal', true, ['claude first 0', 'codex second 0', 'claude third 0']], ['agy', 'outage', false, ['agy first 0', 'agy first 1', 'agy first 2', 'codex second 0']]]) {
  test(`every sandboxed route after a ${primaryHarness} primary changes the state through the spawn's broker`, (t) => {
    const h = setup(t, { reason, primaryHarness, chain });
    h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_NOTE = '1';
    assert.equal(h.spawn().code, 0);
    const sandboxed = (text) => A.CAPABILITIES[text.split(' ')[0]].osSandbox;
    assert.deepEqual(h.attempts().map((a) => a.broker), routes.map(sandboxed), 'routes with an OS sandbox get the broker');
    const notes = events(h).filter((e) => e.cmd === 'task note').map((e) => [e.detail.text, e.agent, e.via ?? null]);
    assert.deepEqual(notes, routes.map((text) => [text, 'worker-T1-1', sandboxed(text) ? 'broker' : null]));
  });
}

test('a verified agy adapter brokers every retry and its Codex fallback', t => {
  const h = setup(t, { primaryHarness: 'agy' });
  h.spawnEnv.TOWER_CRANE_TEST_VERIFIED_AGY = '1';
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_NOTE = '1';
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map(a => a.harness), ['agy', 'agy', 'agy', 'codex']);
  assert.deepEqual(h.attempts().map(a => a.broker), [true, true, true, true]);
  const notes = events(h).filter(e => e.cmd === 'task note');
  assert.equal(notes.length, 4);
  assert.ok(notes.every(e => e.via === 'broker' && e.agent === 'worker-T1-1'));
});

for (const primaryHarness of ['agy', 'claude']) {
  test(`fresh ${primaryHarness} outage retries record each invocation without counting usage twice`, (t) => {
    const h = setup(t, { primaryHarness });
    assert.equal(h.spawn().code, 0);
    const attempts = h.attempts();
    assert.deepEqual(attempts.map((a) => a.model), ['first', 'first', 'first', 'second']);
    assert.deepEqual(attempts.map((a) => a.retry), ['0', '1', '2', '0']);
    assert.equal(new Set(attempts.map((a) => a.session)).size, 4);
    assert.ok(attempts.every((a) => !a.args.includes('resume')));
    const task = h.json(['task', 'show', 'T1']);
    const tokens = primaryHarness === 'agy' ? 12257 : 24;
    assert.deepEqual(task.spend.entries.map((e) => [e.model, e.harness, e.tokens]),
      [['first', primaryHarness, tokens], ['first', primaryHarness, tokens],
        ['first', primaryHarness, tokens], ['second', 'codex', 13]]);
    assert.equal(task.spend.tokens, tokens * 3 + 13);
    if (primaryHarness === 'agy') {
      assert.equal(task.spend.input, 30010);
      assert.equal(task.spend.cached, 6002);
      assert.equal(task.spend.output, 6774);
    }
    const spendEvents = events(h).filter((e) => e.cmd === 'spend').length;
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    h.ok(['spend', 'T1', '--from-spawn', 'worker-T1-1']);
    assert.deepEqual(h.json(['task', 'show', 'T1']).spend, task.spend);
    assert.equal(events(h).filter((e) => e.cmd === 'spend').length, spendEvents);
  });
}
});

// A full local suite on 2026-10-14 (before #287) timed this test out at 300 s
// and logged nothing else. Its spawn-fallback wait then sat outside the
// try/finally with no liveness bound, so either the supervisor recorded no
// `spawn fallback` (it retired between routes: `valid()` false, group cleanup
// failing after SIGKILL, or a fallback commit that threw) or the waiter missed
// the event (unlikely: wait polls every second). A state lock timeout in a
// supervisor tick is retried on the next tick, so it delays and cannot stall
// on its own. T312 ran this test 68 times under load (60 alone, 8 among the
// fallback, supervision, escalation, worker-slots and task-locks files) without
// a stall. Each wait below now fails within seconds of its supervisor's exit,
// so a repeat names the step that stalled.
test('rework during a live fallback refuses a second worker until the previous attempt exits', async (t) => {
  const h = setup(t);
  // The fallback worker runs until the test has checked every refusal.
  const finish = path.join(h.base, 'finish-fallback');
  const cursor = events(h).at(-1).id;
  const waiting = h.runAsync(['wait', '--observe', '--after', cursor, '--types', 'spawn-fallback', '--timeout', WAIT_TIMEOUT_S]);
  let wake;
  waiting.then((result) => { wake = result; });
  const spawned = h.json(['spawn', '--task', 'T1'], {
    env: { ...h.spawnEnv, TOWER_CRANE_TEST_FALLBACK_FINISH: finish },
  });
  // The supervisor runs until the fallback worker finishes, so each wait
  // fails as soon as it is gone, and any failure releases the worker.
  const alive = spawned.monitor_pid;
  assert.ok(alive, JSON.stringify(spawned));
  try {
    await waitOnRepo(h, () => wake, 'the spawn-fallback wait did not return', { alive });
    assert.equal(wake.code, 0, wake.stderr);
    // The harness publishes attempts.json by rename after each attempt.
    await waitOnRepo(h, () => h.attempts().length === 4, 'fallback worker did not start', { alive });
    h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
    h.ok(['rework', 'T1', '--reason', 'fix while worker is finishing']);
    for (const flags of [['--dry-run'], []]) {
      const result = h.run(['spawn', '--task', 'T1', ...flags], { env: h.spawnEnv });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /previous worker worker-T1-1 is still running or its exit is unverified/);
    }
    assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
    assert.equal(h.attempts().length, 4);
  } finally { fs.writeFileSync(finish, ''); }
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit'), 'fallback worker did not exit', { alive });
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv });
  assert.equal(preview.resumed, false);
});

describe('remaining fallback routes', { concurrency: caseConcurrency }, () => {
test('Codex profile and provider arguments change without carrying the old session or route flags', (t) => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'easy', '--profile', 'first', '--clear', 'model',
    '--args', '["-c","model_provider=bedrock"]']);
  setFallbacks(h, [{ profile: 'second', args: ['-c', 'model_provider=openai'] }]);
  const codex = path.join(h.base, 'codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'config.toml'), '[profiles.first]\nmodel = "first"\n[profiles.second]\nmodel = "second"\n');
  h.spawnEnv.CODEX_HOME = codex;
  assert.equal(h.spawn().code, 0);
  const attempts = h.attempts();
  assert.equal(attempts[2].args[attempts[2].args.indexOf('-p') + 1], 'first');
  const last = attempts[3];
  assert.equal(last.args[last.args.indexOf('-p') + 1], 'second');
  assert.equal(last.args.includes('resume'), false);
  assert.ok(last.args.includes('model_provider=openai'));
  assert.equal(last.args.includes('model_provider=bedrock'), false);
  assert.equal(last.env, null);
  const entries = h.json(['task', 'show', 'T1']).spend.entries;
  assert.deepEqual(entries.map((e) => [e.model, e.profile, e.tokens]), [[null, 'first', 39], [null, 'second', 13]]);
});

test('each fallback route receives a bounded retry budget of its own', (t) => {
  const h = setup(t, { chain: true });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'first', 'first', 'second', 'second', 'second', 'third']);
  assert.deepEqual(h.attempts().map((a) => a.retry), ['0', '1', '2', '0', '1', '2', '0']);
  assert.equal(h.attempts()[3].args.includes('resume'), false);
  assert.ok(h.attempts()[4].args.includes('22222222-2222-2222-2222-222222222222'));
});

test('an outage before session creation reruns fresh within the same budget before fallback', (t) => {
  const h = setup(t, { reason: 'no-session' });
  assert.equal(h.spawn().code, 0);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'first', 'first', 'second']);
  assert.ok(h.attempts().every((a) => !a.args.includes('resume')));
  const task = h.json(['task', 'show', 'T1']);
  assert.deepEqual(task.spend.entries.map((e) => e.tokens), [null, null, null, 13]);
  const receipts = events(h).filter((e) => e.cmd === 'spawn session');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].detail.route_index, 1);
});

// Found in the T276 review: a fallback route written into the user file by
// hand, as the unsandboxed orchestrator can, gave its claude agent every
// host ('*') and its own env with no owner decision.
test('a hand-written user-file fallback cannot widen sandbox.domains or env until the owner writes it', (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'claude', reason: 'refusal' });
  const cache = path.join(h.base, 'cache');
  fs.mkdirSync(cache);
  Object.assign(h.spawnEnv, { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, TOWER_CRANE_AGENT: 'orchestrator' });
  const routes = [{ harness: 'claude', model: 'second', sandbox: { domains: ['*'], write: [path.join(h.base, 'anywhere')] }, env: { ROUTE_ENV: 'fallback' } }];
  handFallbacks(h, routes);
  h.spawn();
  assert.deepEqual(h.attempts().map((a) => [a.model, a.env]), [['first', 'primary']], 'the unapproved route never runs');
  assert.ok(!h.attempts()[0].sandbox.network.allowedDomains.includes('*'));
  const problems = h.json(['ladder', 'show']).problems;
  assert.ok(problems.some((p) => p.startsWith('easy fallback 1 from user file') && p.includes('carries sandbox, env, which the owner has not approved')), problems.join('\n'));
  const spawned = events(h).find((e) => e.cmd === 'spawn');
  assert.ok(spawned.detail.notices.some((n) => n.startsWith('easy fallback 1 from user file')), JSON.stringify(spawned.detail.notices));

  // The same list through the CLI is a grant the owner has not made, though
  // the file already holds it.
  const args = ['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)];
  const asked = h.run(args, { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.equal(asked.code, 1, asked.stderr);
  assert.match(asked.stderr, /opened D1/);
  assert.deepEqual([...h.readState('decisions.json').decisions[0].escalation.settings].sort(), ['env', 'sandbox']);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args, { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.ok(!h.json(['ladder', 'show']).problems.some((p) => p.includes('has not approved')));
  const pins = JSON.parse(fs.readFileSync(path.join(h.readState('project.json').owner_config_dir, 'owner', 'route-grants.json'), 'utf8'));
  assert.ok(!JSON.stringify(pins).includes('fallback'), 'the pin holds hashes, not the values');

  // Approved, the route runs with its grants.
  h.ok(['task', 'add', '--title', 'Second', '--tier', 'easy', '--acceptance', 'approved fallback']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'Complete the original task brief.\n' });
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_FILE = h.file = path.join(h.base, 'attempts-2.json');
  h.run(['spawn', '--task', 'T2', '--wait'], { env: h.spawnEnv });
  const [, fallback] = h.attempts();
  assert.deepEqual([fallback?.model, fallback?.env], ['second', 'fallback']);
  assert.ok(fallback.sandbox.network.allowedDomains.includes('*'));

  // The pin is the whole route at its position: the approved grants moved to
  // another harness, or behind a new first route, are not approved.
  for (const moved of [[{ ...routes[0], harness: 'codex', model: 'evil' }], [{ harness: 'codex', model: 'plain' }, routes[0]]]) {
    handFallbacks(h, moved);
    const shown = h.json(['ladder', 'show']).problems;
    assert.ok(shown.some((p) => p.includes('carries sandbox, env, which the owner has not approved')), JSON.stringify(moved));
  }
});

// A third task of the setup's easy tier, spawned as the orchestrator with a
// fresh attempts file; returns its attempts.
function spawnAnother(h, id, title) {
  h.ok(['task', 'add', '--title', title, '--tier', 'easy', '--acceptance', title]);
  h.ok(['brief', 'set', id, '-'], { input: 'Complete the original task brief.\n' });
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_FILE = h.file = path.join(h.base, `attempts-${id}.json`);
  h.run(['spawn', '--task', id, '--wait'], { env: h.spawnEnv });
  return h.attempts();
}

// Found in the T284 review: a hand-written route that sets no grant but runs
// on a harness without an OS sandbox reaches every host and path, and
// ladder set took it as already approved because it compared with the file.
test('a hand-written fallback on an unsandboxed or command harness never runs, and ladder set asks the owner for it', (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'claude', reason: 'refusal' });
  Object.assign(h.spawnEnv, { TOWER_CRANE_AGENT: 'orchestrator' });
  const agy = [{ harness: 'agy', model: 'second' }];
  handFallbacks(h, agy);
  h.spawn();
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['claude', 'first']], 'the agy route never runs');
  const notices = events(h).find((e) => e.cmd === 'spawn').detail.notices;
  assert.ok(notices.some((n) => n.startsWith('easy fallback 1') && n.includes('agy, which runs it without an OS sandbox')), JSON.stringify(notices));
  const command = [{ harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] }];
  handFallbacks(h, command);
  assert.ok(h.json(['ladder', 'show']).problems.some((p) => p.includes('carries the command harness')));

  const asOrchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };
  for (const [list, setting] of [[agy, 'ladder.reach'], [command, 'ladder.command']]) {
    handFallbacks(h, list);
    const asked = h.run(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(list)], asOrchestrator);
    assert.equal(asked.code, 1, `${JSON.stringify(list)}: ${asked.stderr}`);
    assert.match(asked.stderr, /opened D\d+/);
    assert.ok(h.readState('decisions.json').decisions.at(-1).escalation.settings.includes(setting), setting);
  }
  // The owner's own write approves the agy route, and it runs.
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(agy)]);
  assert.deepEqual(spawnAnother(h, 'T2', 'Approved agy').map((a) => [a.harness, a.model]), [['claude', 'first'], ['agy', 'second']]);
  // Routes that only name a model on a sandboxed harness need no approval.
  handFallbacks(h, [{ harness: 'codex', profile: 'astra', effort: 'high' }, { harness: 'claude', model: 'second' }]);
  assert.ok(!h.json(['ladder', 'show']).problems.some((p) => p.includes('has not approved')));
});

test('an approved env_file counts only with the content the owner approved', (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'claude', reason: 'refusal' });
  Object.assign(h.spawnEnv, { TOWER_CRANE_AGENT: 'orchestrator' });
  const envFile = path.join(h.base, 'route.env');
  fs.writeFileSync(envFile, 'ROUTE_ENV=fallback\n');
  const routes = [{ harness: 'claude', model: 'second', env_file: envFile }];
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)]);
  assert.ok(!h.json(['ladder', 'show']).problems.some((p) => p.includes('has not approved')));
  fs.writeFileSync(envFile, 'ROUTE_ENV=fallback\nANTHROPIC_BASE_URL=http://evil.example\n');
  h.spawn();
  assert.deepEqual(h.attempts().map((a) => [a.model, a.env]), [['first', 'primary']], 'the edited env_file is not the approved one');
  assert.ok(h.json(['ladder', 'show']).problems.some((p) => p.includes('carries env_file, which the owner has not approved')));

  // Edited after dispatch, while the primary runs: the supervisor reads the
  // file again at the switch and refuses the route.
  fs.writeFileSync(envFile, 'ROUTE_ENV=fallback\n');
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)]);
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_TOUCH = envFile;
  h.ok(['task', 'add', '--title', 'Touched', '--tier', 'easy', '--acceptance', 'touched']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'Complete the original task brief.\n' });
  h.spawnEnv.TOWER_CRANE_TEST_FALLBACK_FILE = h.file = path.join(h.base, 'attempts-T2.json');
  const run = h.run(['spawn', '--task', 'T2', '--wait'], { env: h.spawnEnv });
  assert.deepEqual(h.attempts().map((a) => [a.model, a.env]), [['first', 'primary']], 'the file changed after dispatch is not the approved one');
  assert.match(run.stderr, /skipping fallback 1: .*changed since the owner approved/);
});

// T355 review: the model check skipped routes that name their own harness,
// which may reach another vendor's model through a proxy and ran before.
test('spawn skips an inherited route whose model its rung\'s harness cannot run, runs one that names its harness, and lists skips in route order', (t) => {
  const h = setup(t, { primaryHarness: 'codex', reason: 'refusal' });
  // Route 1 carries env the owner has not approved; route 2 follows codex with a Claude model.
  handFallbacks(h, [{ harness: 'claude', model: 'second', env: { ROUTE_ENV: 'fallback' } },
    { model: 'claude-fixture-large' }, { harness: 'codex', model: 'claude-fixture-large' }]);
  h.spawn();
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'claude-fixture-large']);
  const notices = events(h).find((e) => e.cmd === 'spawn').detail.notices;
  const first = notices.findIndex((n) => n.startsWith('easy fallback 1 '));
  const second = notices.indexOf(`easy fallback 2 from user file ${h.userConfig} follows the rung's harness, where model claude-fixture-large does not run on codex; skipped`);
  assert.ok(first !== -1 && second > first, JSON.stringify(notices));
  // ladder show looks for each route's harness on PATH as spawn does. The
  // fixture's stubs are on the spawn PATH; the harness guard's .cmd shims,
  // which Windows lookup skips as non-npm shims, are not a harness there.
  const problems = h.json(['ladder', 'show'], { env: { PATH: h.spawnEnv.PATH } }).problems.filter((p) => p.startsWith('easy fallback'));
  assert.ok(problems.length >= 2 && problems[0].startsWith('easy fallback 1 ') && problems.findIndex((p) => p.startsWith('easy fallback 2 ')) > 0, problems.join('\n'));
  assert.ok(!problems.some((p) => p.startsWith('easy fallback 3')), problems.join('\n'));
});

// Found in the T284 re-review: a pinned route that inherits its harness
// follows the primary, which the orchestrator may move among sandboxed
// harnesses without the owner. The approval is for the harness it resolved to.
test('a pinned route that inherits its harness is not approved on another harness', (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'claude', reason: 'refusal' });
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ model: 'second', env: { ROUTE_ENV: 'fallback' } }])]);
  assert.ok(!h.json(['ladder', 'show']).problems.some((p) => p.includes('has not approved')));
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  const problems = h.json(['ladder', 'show']).problems;
  assert.ok(problems.some((p) => p.startsWith('easy fallback 1') && p.includes('carries env, which the owner has not approved')), problems.join('\n'));
});

// Pins keyed on the user file as spelled: a route the owner approved through
// one path to the file was skipped when spawn reached the file by another.
// A link moved to another file after the approval must not carry the pin
// with it. Creating links needs a privilege on Windows, so the in-process
// test below covers the other spellings there.
test('a route approved through one spelling of the user file runs through another, and a link moved to another file finds no pin', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t, { primaryHarness: 'claude', nextHarness: 'claude', reason: 'refusal' });
  const cache = path.join(h.base, 'cache');
  fs.mkdirSync(cache);
  Object.assign(h.spawnEnv, { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache, TOWER_CRANE_AGENT: 'orchestrator' });
  // setup approved the route through the real path; spawn names it through a link.
  const link = path.join(h.base, 'config-link');
  fs.symlinkSync(path.dirname(h.userConfig), link, 'dir');
  h.spawnEnv.TOWER_CRANE_CONFIG = path.join(link, path.basename(h.userConfig));
  h.spawn();
  assert.deepEqual(h.attempts().map((a) => [a.model, a.env]), [['first', 'primary'], ['second', 'fallback']]);
  const notices = events(h).find((e) => e.cmd === 'spawn').detail.notices || [];
  assert.ok(!notices.some((n) => n.includes('has not approved')), JSON.stringify(notices));

  // The same routes in another file, which the link now names, were never approved.
  const other = path.join(h.base, 'other-config');
  fs.mkdirSync(other);
  fs.copyFileSync(h.userConfig, path.join(other, path.basename(h.userConfig)));
  fs.rmSync(link);
  fs.symlinkSync(other, link, 'dir');
  assert.deepEqual(spawnAnother(h, 'T2', 'Moved link').map((a) => a.model), ['first']);
  const moved = events(h).findLast((e) => e.cmd === 'spawn').detail.notices;
  assert.ok(moved.some((n) => n.startsWith(`easy fallback 1 from user file ${h.spawnEnv.TOWER_CRANE_CONFIG}`) && n.includes('has not approved')), JSON.stringify(moved));
});

test('route pins key on the canonical user file, and a pin written under a spelling counts for it until the next write folds it in', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot(), 'tower-crane-route-pins-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = { owner_config_dir: path.join(dir, 'owner-dir') };
  const real = path.join(dir, 'cfg', 'config.json');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, '{}');
  const base = { home: dir, cwd: dir };
  const routes = [{ harness: 'claude', model: 'second', env: { ROUTE_ENV: 'fallback' } }];
  const open = (file, rung = 'easy') => RouteGrants.unapproved(project, file, rung, routes, ['claude'], base).length;
  // A case-insensitive filesystem, simulated: realpath gives the stored case
  // of any spelling under dir.
  const native = fs.realpathSync.native;
  fs.realpathSync.native = (p, ...rest) => native(String(p).startsWith(dir) ? dir + String(p).slice(dir.length).toLowerCase() : p, ...rest);
  t.after(() => { fs.realpathSync.native = native; });
  const folded = path.join(dir, 'CFG', 'Config.json');

  RouteGrants.pin(project, folded, 'easy', routes, ['claude'], base);
  assert.deepEqual(Object.keys(RouteGrants.read(project)), [real]);
  assert.equal(open(real), 0, 'approved through one case, found through another');
  const elsewhere = path.join(dir, 'cfg2', 'config.json');
  assert.equal(open(elsewhere), 1, 'another file with the same routes has no pin');

  // A pin an earlier version keyed on the spelling still counts for that spelling.
  const sha = RouteGrants.hash(routes[0], base, 'claude');
  fs.writeFileSync(RouteGrants.file(project), JSON.stringify({ version: 1, files: { [folded]: { easy: [sha], medium: [sha] } } }));
  assert.equal(open(folded), 0);
  assert.equal(open(folded, 'medium'), 0);
  // The next write moves it under the canonical key, and the rung it cleared
  // stays cleared through the old spelling.
  RouteGrants.pin(project, real, 'easy', [], ['claude'], base);
  assert.deepEqual(RouteGrants.read(project), { [real]: { medium: [sha] } });
  assert.equal(open(folded), 1);
  assert.equal(open(folded, 'medium'), 0);
});

// Found in the T376 review: a clear that emptied the canonical entry deleted
// it, so an old spelling the fold missed, a link that named another file at
// the clear, was read again once the link came back.
test('a cleared rung stays cleared through an old spelling that named another file at the clear', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot(), 'tower-crane-route-pins-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = { owner_config_dir: path.join(dir, 'owner-dir') };
  const [a, b] = ['a', 'b'].map((d) => path.join(dir, d));
  for (const d of [a, b]) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'c.json'), '{}');
  }
  const base = { home: dir, cwd: dir };
  const routes = [{ harness: 'claude', model: 'second', env: { ROUTE_ENV: 'fallback' } }];
  const open = (file) => RouteGrants.unapproved(project, file, 'easy', routes, ['claude'], base).length;
  // A link L, simulated so the test runs where links need a privilege.
  const link = path.join(dir, 'L');
  let target = a;
  const native = fs.realpathSync.native;
  fs.realpathSync.native = (p, ...rest) => native(String(p).startsWith(link) ? target + String(p).slice(link.length) : p, ...rest);
  t.after(() => { fs.realpathSync.native = native; });
  const spelled = path.join(link, 'c.json');

  // An earlier version pinned the route under L/c.json while L named a.
  fs.mkdirSync(path.dirname(RouteGrants.file(project)), { recursive: true });
  fs.writeFileSync(RouteGrants.file(project), JSON.stringify({ version: 1, files: { [spelled]: { easy: [RouteGrants.hash(routes[0], base, 'claude')] } } }));
  assert.equal(open(spelled), 0);
  target = b;
  RouteGrants.pin(project, path.join(a, 'c.json'), 'easy', [], ['claude'], base);
  assert.deepEqual(RouteGrants.read(project)[path.join(a, 'c.json')], {}, 'the cleared file keeps an empty canonical entry');
  target = a;
  assert.equal(open(spelled), 1, 'the cleared pin does not come back through L');
});

for (const reason of ['outage', 'refusal']) {
  test(`exhausted ${reason} fallback leaves a blocked claim and records the final route exit`, (t) => {
    const h = setup(t, { reason, chain: true });
    setFallbacks(h, [{ harness: 'codex', model: 'second' }]);
    assert.equal(h.spawn().code, 1);
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.run.phase, 'blocked');
    assert.equal(task.run.model, 'second');
    assert.equal(task.claim.agent, 'worker-T1-1');
    assert.match(task.run.reason, reason === 'outage' ? /after 2 retries/ : /harness refusal/);
    const exited = h.json(['status']).exited_claims;
    assert.equal(exited.length, 1);
    assert.equal(exited[0].pid, events(h).findLast((e) => ['spawn fallback', 'spawn retry'].includes(e.cmd)).detail.pid);
    assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
  });
}

for (const reason of ['permanent', 'signal']) {
  test(`${reason} exit without provider outage does not switch routes`, (t) => {
    const h = setup(t, { reason });
    assert.equal(h.spawn().code, reason === 'permanent' ? 2 : 75);
    assert.equal(h.attempts().length, reason === 'permanent' ? 1 : 3);
    assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, 0);
  });
}

test('agent output quoting outage and refusal does not switch routes', (t) => {
  const h = setup(t, { reason: 'quoted' });
  assert.equal(h.spawn().code, 1);
  assert.equal(h.attempts().length, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, 0);
});

test('user fallback configuration validates route shapes without project flags', (t) => {
  const h = makeProjectRepo(t);
  for (const value of [{}, [null], [{ profile: 'fixture-main', fallbacks: [] }]]) {
    setFallbacks(h, value);
    assert.notEqual(h.run(['ladder', 'show']).code, 0);
  }
  setFallbacks(h, [{ profile: 'fixture-main' }]);
  assert.match(h.ok(['ladder', 'show']), /fallback 1.*from user file/);
  assert.deepEqual(h.json(['ladder', 'show']).ladder.easy.fallbacks, [{ profile: 'fixture-main' }]);
  h.ok(['ladder', 'save-user']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).ladder.easy.fallbacks, [{ profile: 'fixture-main' }]);
  setFallbacks(h, []);
  assert.deepEqual(h.json(['ladder', 'show']).ladder.easy.fallbacks, []);
});

test('a project hard rung uses personal fallbacks and skips unavailable routes', (t) => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'hard', '--harness', 'codex', '--model', 'first', '--clear', 'effort',
    '--supervision', JSON.stringify(supervision)]);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  const codex = path.join(h.base, 'codex');
  fs.mkdirSync(codex);
  h.spawnEnv.CODEX_HOME = codex;
  const unavailable = path.join(h.base, 'missing-harness');
  // Written by hand: ladder set refuses the routes that need a model. The
  // command and pi routes carry authority the owner has not approved, so
  // spawn drops them before the supervisor sees them.
  handFallbacks(h, [
    { harness: 'command', command: [unavailable] },
    { harness: 'codex', profile: 'missing' },
    { harness: 'claude' },
    { harness: 'pi', profile: 'fixture-main' },
    { harness: 'claude', model: 'second' },
  ], 'hard');
  const shown = h.json(['ladder', 'show'], { env: h.spawnEnv });
  assert.equal(shown.ladder.hard.model, 'first');
  assert.equal(shown.ladder.hard.fallbacks_from, 'user');
  assert.equal(shown.problems.length, 6);
  assert.match(shown.problems.join('\n'), /no executable.*missing-harness/);
  assert.match(shown.problems.join('\n'), /hard fallback 1 .*carries the command harness/);
  assert.match(shown.problems.join('\n'), /hard fallback 4 .*carries pi, which runs it without an OS sandbox/);
  assert.match(shown.problems.join('\n'), /profile missing is not configured/);
  assert.match(shown.problems.join('\n'), /needs a model/);
  assert.equal(h.json(['validate']).ok, true, 'unavailable personal routes do not invalidate the project');
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /skipping fallback 1/);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [
    ['codex', 'first'], ['codex', 'first'], ['codex', 'first'], ['claude', 'second'],
  ]);
  assert.equal(events(h).find((e) => e.cmd === 'spawn fallback').detail.route_index, 3);
});

test('exhaustion with only unavailable personal fallbacks records a normal blocked exit', (t) => {
  const h = setup(t, { reason: 'refusal' });
  setFallbacks(h, [{ harness: 'command', command: [path.join(h.base, 'missing')] }]);
  const result = h.spawn();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /skipping fallback/);
  assert.equal(h.attempts().length, 1);
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'blocked');
  assert.equal(events(h).filter((e) => e.cmd === 'spawn exit').length, 1);
});

for (const harness of ['claude', 'codex']) {
  for (const config of ['default', 'override']) {
    test(`a spawned ${harness} orchestrator dispatches with personal fallbacks from the ${config} user path`, (t) => {
      const h = setup(t, { reason: 'refusal' });
      const userHome = path.join(h.base, 'user-home');
      fs.mkdirSync(userHome);
      h.env.HOME = userHome;
      h.env.USERPROFILE = userHome;
      if (config === 'default') {
        delete h.env.TOWER_CRANE_CONFIG;
        const ownerDir = path.join(path.dirname(h.userConfig), 'owner');
        h.userConfig = path.join(userHome, '.config', 'tower-crane', 'config.json');
        // The owner key sits beside the user file, so it moves with it.
        fs.cpSync(ownerDir, path.join(path.dirname(h.userConfig), 'owner'), { recursive: true });
      } else {
        h.env.TOWER_CRANE_CONFIG = path.relative(h.repo, h.userConfig);
      }
      setFallbacks(h, [{ harness: 'claude', model: 'second' }], 'hard');
      h.ok(['ladder', 'set', 'orchestrator', '--harness', harness, '--model', 'orchestrator', '--clear', 'effort']);
      h.ok(['ladder', 'set', 'hard', '--harness', 'codex', '--model', 'first', '--clear', 'effort',
        '--supervision', JSON.stringify(supervision)]);
      h.ok(['task', 'add', '--title', 'Nested worker', '--tier', 'hard', '--acceptance', 'uses personal fallback']);
      h.ok(['brief', 'set', 'T2', '-'], { input: 'Dispatch with personal fallback routes.\n' });
      const nested = path.join(h.base, 'nested.json');
      const result = h.run(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait'], {
        env: { ...h.spawnEnv, TOWER_CRANE_TEST_NESTED_DISPATCH: nested },
      });
      assert.equal(result.code, 0, result.stderr);
      const seen = JSON.parse(fs.readFileSync(nested, 'utf8'));
      assert.equal(seen.home, path.join(h.state, 'homes', 'orchestrator-T1-1', 'home'));
      assert.equal(seen.config, h.userConfig);
      assert.deepEqual(seen.ladder.ladder.hard.fallbacks, [{ harness: 'claude', model: 'second' }]);
      assert.equal(seen.dispatch.code, 0);
      assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'second']);
      assert.equal(events(h).find((e) => e.cmd === 'spawn fallback').task, 'T2');
    });
  }
}

test('command fallback executable placeholders are expanded before availability checks', (t) => {
  const h = setup(t, { reason: 'refusal' });
  const scripts = path.join(h.repo, 'scripts');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, process.platform === 'win32' ? 'fallback.exe' : 'fallback'), '', { mode: 0o755 });
  h.git(['add', 'scripts']);
  h.git(['commit', '-m', 'Add fallback executable']);
  setFallbacks(h, [{ harness: 'command', command: ['{cwd}/scripts/fallback', 'second', '{prompt}'] }]);
  assert.deepEqual(h.json(['ladder', 'show'], { env: h.spawnEnv }).problems, []);
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [['codex', 'first'], ['command', 'second']]);
  assert.match(h.attempts()[1].args[1], /Complete the original task brief/);
  const switched = events(h).find((e) => e.cmd === 'spawn fallback');
  assert.equal(switched.detail.harness, 'command');
  assert.equal(h.json(['task', 'show', 'T1']).run.phase, 'waiting');
});

test('missing expanded command fallback executables are skipped during preparation', (t) => {
  const h = setup(t, { reason: 'refusal' });
  setFallbacks(h, [
    { harness: 'command', command: ['{cwd}/scripts/missing', '{prompt}'] },
    { harness: 'claude', model: 'second' },
  ]);
  assert.deepEqual(h.json(['ladder', 'show'], { env: h.spawnEnv }).problems, []);
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /could not start .*scripts[/\\]missing/);
  assert.equal(result.stderr.includes('{cwd}'), false);
  assert.deepEqual(h.attempts().map((a) => a.model), ['first', 'second']);
  assert.equal(events(h).find((e) => e.cmd === 'spawn fallback').detail.route_index, 2);
});
});

test('a detached switch wakes a live waiter, keeps its lease, and collects route usage on exit', async (t) => {
  const h = setup(t);
  const finish = path.join(h.base, 'finish-fallback');
  const cursor = events(h).at(-1).id;
  const waiting = h.runAsync(['wait', '--observe', '--after', cursor, '--types', 'spawn-fallback', '--timeout', WAIT_TIMEOUT_S]);
  const spawn = h.json(['spawn', '--task', 'T1'], {
    env: { ...h.spawnEnv, TOWER_CRANE_TEST_FALLBACK_FINISH: finish },
  });
  const wake = await waiting;
  assert.equal(wake.code, 0, wake.stderr);
  const switched = JSON.parse(wake.stdout);
  assert.equal(switched.detail.model, 'second');
  assert.equal(switched.detail.monitor_pid, spawn.monitor_pid);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, spawn.agent);
  assert.equal(h.run(['release', 'T1', '--agent', 'recovery', '--reason', 'too early']).code, 1);
  fs.writeFileSync(finish, '');
  await waitOnRepo(h, () => {
    const entries = h.readState('tasks.json').tasks[0].spend.entries;
    return entries?.length === 2 && entries.every((entry) => !entry.live)
      && events(h).some((e) => e.cmd === 'worker-exited' && e.detail.agent === spawn.agent);
  }, 'detached route usage and exit receipt were not collected');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.run.phase, 'waiting');
  assert.deepEqual(task.spend.entries.map((e) => [e.model, e.tokens]), [['first', 39], ['second', 13]]);
  assert.ok(task.spend.entries.every((entry) => !entry.live), 'both routes have finalized usage');
  assert.equal(events(h).filter((e) => e.cmd === 'worker-exited').length, 1);
});
