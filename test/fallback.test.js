'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, makeProjectRepo, makeTaskRepo } = require('./helpers');
const A = require('../lib/agents');
const windowsConcurrency = process.platform === 'win32' ? 2 : false;

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const supervision = { retries: 2, backoff_ms: 10, max_backoff_ms: 20, stall_ms: 60000 };

function setFallbacks(h, routes, rung = 'easy') {
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { [rung]: { fallbacks: routes } } }));
}

async function until(fn, message) {
  const deadline = Date.now() + 12000;
  while (!fn()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(t, { reason = 'outage', primaryHarness = 'codex', nextHarness = 'codex', chain = false,
  rung = 'easy', webMcp, fallbackWebMcp } = {}) {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Fallback routes', '--tier', rung,
      '--kind', rung === 'research' ? 'research' : 'code', '--acceptance', 'fresh fallback session'],
    brief: 'Complete the original task brief.\n',
  }]);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  // A gh on PATH and no token in the environment make every route ask gh for
  // one, as on a CI runner; that must happen outside the state lock.
  for (const harness of ['codex', 'claude', 'agy', 'gh']) fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  const routes = [{ harness: nextHarness, model: 'second', env: { ROUTE_ENV: 'fallback', NODE_TEST_CONTEXT: 'child-v8' } }];
  if (fallbackWebMcp) routes[0].web_mcp = fallbackWebMcp;
  if (chain) routes.push({ harness: 'claude', model: 'third' });
  h.ok(['ladder', 'set', rung, '--harness', primaryHarness, '--model', 'first', '--clear', 'profile', '--clear', 'effort',
    '--env', '{"ROUTE_ENV":"primary","NODE_TEST_WORKER_ID":"outer-worker"}', '--supervision', JSON.stringify(supervision),
    ...(webMcp ? ['--web-mcp', JSON.stringify(webMcp)] : [])]);
  setFallbacks(h, routes, rung);
  h.file = path.join(h.base, 'attempts.json');
  h.spawnEnv = {
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), GH_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require "${path.join(__dirname, 'fixtures', 'fallback-harness.js').replace(/\\/g, '/')}"`,
    TOWER_CRANE_TEST_FALLBACK_FILE: h.file, TOWER_CRANE_TEST_FALLBACK_REASON: reason,
    ...(chain ? { TOWER_CRANE_TEST_FALLBACK_CHAIN: '1' } : {}),
  };
  h.spawn = () => h.run(['spawn', '--task', 'T1', '--wait'], { env: h.spawnEnv });
  h.attempts = () => JSON.parse(fs.readFileSync(h.file, 'utf8'));
  return h;
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
    const result = await h.runAsync(['wait', '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', '20']);
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
    assert.deepEqual(fallback.sandbox.network.allowedDomains, ['*']);
  });
}

describe('independent fallback routes', { concurrency: windowsConcurrency }, () => {
for (const nextHarness of ['codex', 'claude']) {
  test(`outage exhausts same-route retries before a fresh ${nextHarness} fallback and records route spend`, async (t) => {
    const h = setup(t, { nextHarness });
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.spawnEnv });
    // Windows pipe closure and hook writers can outlive the final harness.
    // Assert the recorded exit and usage instead of timing a foreground CLI.
    const result = await h.runAsync(['wait', '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', '20']);
    assert.equal(result.code, 0, result.stderr);
    const exited = JSON.parse(result.stdout);
    assert.equal(exited.detail.agent, spawned.agent);
    assert.equal(exited.detail.code, 0);
    await until(() => events(h).filter((e) => e.cmd === 'spend').length === 2, 'route usage receipts were not recorded');
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
    const wake = h.json(['wait', '--after', '0', '--types', 'spawn-fallback', '--timeout', '1']);
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

test('rework during a live fallback refuses a second worker until the previous attempt exits', async (t) => {
  const h = setup(t);
  const cursor = events(h).at(-1).id;
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn-fallback', '--timeout', '10']);
  h.json(['spawn', '--task', 'T1'], {
    env: { ...h.spawnEnv, TOWER_CRANE_TEST_FALLBACK_HOLD: '4000' },
  });
  const wake = await waiting;
  assert.equal(wake.code, 0, wake.stderr);
  // The harness truncates and rewrites attempts.json between fallback routes.
  await until(() => {
    try {
      return h.attempts().length === 4;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, 'fallback worker did not start');
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
  h.ok(['rework', 'T1', '--reason', 'fix while worker is finishing']);
  for (const flags of [['--dry-run'], []]) {
    const result = h.run(['spawn', '--task', 'T1', ...flags], { env: h.spawnEnv });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /previous worker worker-T1-1 is still running or its exit is unverified/);
  }
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
  assert.equal(h.attempts().length, 4);
  await until(() => events(h).some((e) => e.cmd === 'spawn exit'), 'fallback worker did not exit');
  const preview = h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv });
  assert.equal(preview.resumed, false);
});

describe('remaining fallback routes', { concurrency: windowsConcurrency }, () => {
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
  setFallbacks(h, [
    { harness: 'command', command: [unavailable] },
    { harness: 'codex', profile: 'missing' },
    { harness: 'claude' },
    { harness: 'pi', profile: 'fixture-main' },
    { harness: 'claude', model: 'second' },
  ], 'hard');
  const shown = h.json(['ladder', 'show'], { env: h.spawnEnv });
  assert.equal(shown.ladder.hard.model, 'first');
  assert.equal(shown.ladder.hard.fallbacks_from, 'user');
  assert.equal(shown.problems.length, 4);
  assert.match(shown.problems.join('\n'), /no executable.*missing-harness/);
  assert.match(shown.problems.join('\n'), /profile missing is not configured/);
  assert.match(shown.problems.join('\n'), /needs a model/);
  assert.equal(h.json(['validate']).ok, true, 'unavailable personal routes do not invalidate the project');
  const result = h.spawn();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /skipping fallback 1/);
  assert.deepEqual(h.attempts().map((a) => [a.harness, a.model]), [
    ['codex', 'first'], ['codex', 'first'], ['codex', 'first'], ['claude', 'second'],
  ]);
  assert.equal(events(h).find((e) => e.cmd === 'spawn fallback').detail.route_index, 5);
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
        env: { ...h.spawnEnv, TOWER_CRANE_TEST_NESTED_DISPATCH: nested }, timeout: 25000,
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
  const waiting = h.runAsync(['wait', '--after', cursor, '--types', 'spawn-fallback', '--timeout', '10']);
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
  await until(() => {
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
