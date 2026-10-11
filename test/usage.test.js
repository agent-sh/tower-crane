'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, detachedAlive } = require('./helpers');

const fixture = (name) => path.join(__dirname, 'fixtures', 'usage', name);
const text = (name) => fs.readFileSync(fixture(name), 'utf8');
const parse = (...args) => require('../lib/usage').parseUsage(...args);

test('codex captured footer and repeated session totals are counted once', () => {
  assert.equal(parse('codex', text('codex.log')), null, 'the footer excludes cached input');
  assert.deepEqual(parse('codex', text('codex-stream.jsonl')), {
    tokens: 24816, input: 24811, cached: 0, output: 5, model: null,
  });
  const session = text('codex-session.jsonl');
  assert.deepEqual(parse('codex', text('codex.log'), session + session), {
    tokens: 24675, input: 24670, cached: 0, output: 5, model: 'openai.gpt-6.1-sol',
  });
  assert.deepEqual(parse('codex', text('codex.log'), text('codex-cache-session.jsonl')), {
    tokens: 1529656, input: 1516556, cached: 1398443, output: 13100, model: 'openai.gpt-6.1-sol',
  });
  const writes = text('codex-cache-write-session.jsonl');
  assert.deepEqual(parse('codex', '', writes + writes), {
    tokens: 668176, input: 660162, cached: 575581, output: 8014, model: 'openai.gpt-6.1-sol',
  }, 'cache writes and reasoning are already included in input and output');
});

test('claude captured usage includes cache reads and writes in input', () => {
  assert.deepEqual(parse('claude', text('claude.jsonl')), {
    tokens: 31948, input: 31773, cached: 31771, output: 175, model: 'claude-opus-5-5',
  });
  assert.deepEqual(parse('claude', text('claude.jsonl') + text('claude.jsonl')), parse('claude', text('claude.jsonl')));
  assert.deepEqual(parse('claude', text('claude-result.json')), {
    tokens: 0, input: 0, cached: 0, output: 0, model: null,
  });
  assert.deepEqual(parse('claude', text('claude.jsonl') + text('claude-result.json')), parse('claude', text('claude-result.json')), 'a result is not added to assistant usage');
  const result = text('claude-print-result.json');
  assert.deepEqual(parse('claude', result + result), {
    tokens: 788527, input: 780011, cached: 719614, output: 8516, model: 'claude-opus-5-5',
  });
});

test('opencode captured step-finish totals include each step once', () => {
  assert.deepEqual(parse('opencode', text('opencode.jsonl')), {
    tokens: 289055, input: 288796, cached: 0, output: 259, model: null,
  });
  const cached = text('opencode-cache.jsonl');
  assert.deepEqual(parse('opencode', cached + cached), {
    tokens: 288768, input: 288252, cached: 282624, output: 516, model: null,
  });
  assert.deepEqual(parse('opencode', text('opencode-reasoning.jsonl')), {
    tokens: 223603, input: 213750, cached: 0, output: 9853, model: null,
  });
});

test('agy captured json reports inclusive input and separate thinking', () => {
  assert.deepEqual(parse('agy', text('agy.json')), {
    tokens: 12257, input: 12256, cached: 0, output: 1, model: null,
  });
});

test('pi captured message usage includes cache writes in input', () => {
  assert.deepEqual(parse('pi', text('pi.jsonl')), {
    tokens: 12559, input: 12394, cached: 0, output: 165, model: 'global.anthropic.claude-fable-5',
  });
});

test('absent or malformed telemetry is unknown, explicit zero is measured', () => {
  for (const harness of ['codex', 'claude', 'opencode', 'agy', 'pi', 'command']) {
    assert.equal(parse(harness, 'hello\n{broken json'), null);
    assert.equal(parse(harness, 'null'), null);
  }
  assert.equal(parse('constructor', text('agy.json')), null);
  assert.deepEqual(parse('agy', '{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"total_tokens":0}}'), {
    tokens: 0, input: 0, cached: 0, output: 0, model: null,
  });
  assert.equal(parse('codex', '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":3}}'), null);
});

function setup(t, harness = 'codex') {
  return cachedFixture(t, harness, (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Usage', '--acceptance', 'accounted', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Record usage.\n' });
    h.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'dispatch-model', '--clear', 'profile', '--clear', 'effort']);
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    h.usageEnv = { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), CODEX_HOME: path.join(h.base, 'codex') };
    h.usageHooks = { HOOK_USAGE_HARNESS: harness, HOOK_USAGE_FILE: fixture(harness === 'codex' ? 'codex-stream.jsonl' : `${harness}.jsonl`) };
    return { usageEnv: h.usageEnv, usageHooks: h.usageHooks };
  });
}

const spends = (h, task = 'T1') => h.json(['task', 'show', task]).spend;
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function collected(h, length = 1, timeout = 15000, task = 'T1') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const spend = spends(h, task);
    if (spend.entries?.length === length && spend.entries.every((entry) => !entry.live)) return spend;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('usage was not collected within 15 s');
}

function waitForFile(t, file) {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), check);
    const abort = () => finish(t.signal.reason);
    function finish(error) {
      watcher.close();
      t.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    function check() { if (fs.existsSync(file)) finish(); }
    watcher.once('error', finish);
    t.signal.addEventListener('abort', abort, { once: true });
    if (t.signal.aborted) abort();
    else check();
  });
}

async function waitForText(file, text, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let contents = '';
  while (Date.now() < deadline) {
    contents = fs.readFileSync(file, 'utf8');
    if (contents.includes(text)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${file} did not contain ${text} within ${timeout} ms`);
}

test('native usage uses one CLI call and preserves rung metadata across ladder changes', (t) => {
  const h = setup(t, 'claude');
  const s = h.json(['spend', 'T1', '--tokens', '100', '--input', '80', '--cached', '60', '--output', '20', '--rung', 'easy'], { env: { TOWER_CRANE_AGENT: 'native-worker' } }).spend;
  assert.equal(s.tokens, 100);
  assert.equal(s.input, 80);
  assert.equal(s.cached, 60);
  assert.equal(s.output, 20);
  assert.equal(s.entries[0].rung, 'easy');
  assert.equal(s.entries[0].harness, 'claude');
  assert.equal(s.entries[0].model, 'dispatch-model');
  assert.equal(s.entries[0].agent, 'native-worker');
  h.ok(['ladder', 'set', 'easy', '--model', 'replacement']);
  assert.equal(spends(h).entries[0].model, 'dispatch-model');
  assert.match(h.ok(['status']), /100 tokens/);
  for (const args of [
    ['--tokens', '-1'], ['--tokens', '10', '--input', '11'],
    ['--tokens', '10', '--input', '5', '--cached', '6'], ['--cached', '1'],
    ['--tokens', '10', '--rung', 'unknown'], ['--tokens', '9007199254740992'],
  ]) assert.equal(h.run(['spend', 'T1', ...args]).code, 2, args.join(' '));
  assert.equal(spends(h).tokens, 100, 'refused usage writes nothing');
  const time = h.json(['spend', 'T1', '--minutes', '5']).spend;
  assert.equal(time.entries.at(-1).tokens, null, 'time-only spend does not claim measured zero tokens');
  assert.equal(time.tokens, 100);
  assert.equal(h.json(['status']).spend.missing_usage, 0);
});

test('foreground spawn captures usage after stderr and stdout close, including failed agents', (t) => {
  const h = setup(t);
  const r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...h.usageEnv, USAGE_EXIT: '7' }, hooks: h.usageHooks,
  });
  assert.equal(r.code, 7, r.stderr);
  const started = JSON.parse(r.stdout);
  assert.match(r.stderr, /turn.completed/);
  assert.ok(fs.existsSync(started.log));
  const s = spends(h);
  assert.equal(s.tokens, 24816);
  assert.equal(s.entries[0].rung, 'easy');
  assert.equal(s.entries[0].harness, 'codex');
  assert.equal(s.entries[0].model, 'dispatch-model');
  assert.equal(s.entries[0].agent, started.agent);
  assert.equal(events(h).find((e) => e.cmd === 'spend').agent, 'owner');
  assert.equal(events(h).find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('completed processes cannot leave teardown targeting a reused pid', async (t) => {
  const h = setup(t);
  h.json(['spawn', '--task', 'T1'], {
    env: { ...h.usageEnv, USAGE_DELAY: '100' }, hooks: h.usageHooks,
  });
  await collected(h);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tracked = h.detached();
    if (!tracked.some((child) => child.kind === 'worker') && tracked.filter((child) => child.kind === 'monitor').every((child) => child.exited)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const tracked = h.detached();
  assert.equal(tracked.filter((child) => child.kind === 'worker').length, 0);
  const monitors = tracked.filter((child) => child.kind === 'monitor');
  assert.equal(monitors.length, 1, 'monitor dispatch remains in the audit tracker');
  assert.equal(monitors[0].exited, true, 'the monitor reached its exit listener; teardown still checks OS termination');
});

test('detached exits record both spawns exactly once and keep dispatch metadata', async (t) => {
  const h = setup(t);
  // A live unclaimed worker holds its task's reservation, so the second spawn takes a second task.
  h.ok(['task', 'add', '--title', 'Usage again', '--acceptance', 'accounted', '--tier', 'easy']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'Record usage.\n' });
  const options = { env: { ...h.usageEnv, USAGE_DELAY: '900' }, hooks: h.usageHooks };
  const a = h.json(['spawn', '--task', 'T1'], options);
  const b = h.json(['spawn', '--task', 'T2'], options);
  h.ok(['ladder', 'set', 'easy', '--model', 'replacement']);
  const [first, second] = await Promise.all([collected(h, 1, 15000, 'T1'), collected(h, 1, 15000, 'T2')]);
  assert.equal(first.tokens, 24816);
  assert.equal(second.tokens, 24816);
  assert.equal(first.entries[0].source, `spawn:${a.agent}`);
  assert.equal(second.entries[0].source, `spawn:${b.agent}`);
  for (const e of [...first.entries, ...second.entries]) {
    assert.equal(e.rung, 'easy');
    assert.equal(e.harness, 'codex');
    assert.equal(e.model, 'dispatch-model');
  }
  h.ok(['spend', 'T1', '--from-spawn', a.agent]);
  h.ok(['spend', 'T2', '--from-spawn', b.agent]);
  assert.equal(spends(h, 'T1').tokens, 24816);
  assert.equal(spends(h, 'T2').tokens, 24816);
  assert.equal(events(h).filter((e) => e.cmd === 'spend').length, 2);
  const monitors = h.detached().filter((c) => c.kind === 'monitor');
  assert.equal(monitors.length, 2, 'both collectors are tracked for teardown');
  const deadline = Date.now() + 3000;
  while (monitors.some(detachedAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(monitors.every((c) => !detachedAlive(c)), 'collectors exit after recording usage');
});

test('collectors and concurrent waiters share one private exit event and usage entry', async (t) => {
  const h = setup(t);
  const privateText = 'prompt: private task text\ncredential: synthetic-private-token';
  const sample = path.join(h.base, 'usage-with-private-text.log');
  fs.writeFileSync(sample, privateText + '\n' + fs.readFileSync(fixture('codex-stream.jsonl'), 'utf8'));
  const waits = ['observer-a', 'observer-b'].map((agent) => h.runAsync([
    'wait', '--agent', agent, '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', '60',
  ]));
  const started = h.json(['spawn', '--task', 'T1'], {
    env: { ...h.usageEnv, USAGE_DELAY: '900', USAGE_CLAIM: '1' },
    hooks: { ...h.usageHooks, HOOK_USAGE_FILE: sample },
  });
  const results = await Promise.all(waits);
  for (const r of results) assert.equal(r.code, 0, r.stderr || r.stdout);
  const [a, b] = results.map((r) => JSON.parse(r.stdout));
  assert.equal(a.id, b.id, 'all observers consume the same exit');
  assert.equal(a.detail.agent, started.agent);
  assert.equal(a.detail.pid, started.pid);
  assert.equal(a.detail.log, started.log);
  assert.equal(a.detail.tail, undefined);
  const spend = await collected(h, 1);
  assert.equal(spend.tokens, 24816);
  assert.equal(spend.entries[0].rung, 'easy');
  assert.equal(spend.entries[0].model, 'dispatch-model');
  h.ok(['spend', 'T1', '--from-spawn', started.agent]);
  h.ok(['spend', 'T1', '--from-spawn', started.agent]);
  assert.equal(events(h).filter((e) => e.type === 'worker-exited').length, 1);
  assert.equal(events(h).filter((e) => e.cmd === 'spend').length, 1);
  assert.match(h.json(['status']).exited_claims[0].tail, /private task text/);
  h.ok(['release', 'T1', '--agent', 'recovery-agent', '--reason', 'worker exited']);
  for (const file of ['tasks.json', 'events.jsonl']) {
    const text = fs.readFileSync(path.join(h.state, file), 'utf8');
    for (const line of privateText.split('\n')) assert.ok(!text.includes(line), `${file} contains harness text`);
  }
});

test('codex session fallback opens only the exact session and counts cached input once', (t) => {
  const h = setup(t);
  // The agent writes its session in its own home, which links sessions to
  // one kept after the home is removed.
  const codexHome = path.join(h.state, 'homes', '.codex', 'worker-T1-1');
  const id = '01a11284-12da-7953-94fb-07a97b081e94';
  const file = path.join('sessions', '2026', '10', '06', `rollout-2026-10-06T21-40-07-${id}.jsonl`);
  h.ok(['spawn', '--task', 'T1', '--wait'], {
    env: { ...h.usageEnv, USAGE_SESSION: file, USAGE_SESSION_FIXTURE: fixture('codex-session.jsonl') },
    hooks: { ...h.usageHooks, HOOK_USAGE_FILE: fixture('codex.log') },
  });
  const s = spends(h);
  assert.equal(s.input, 24670);
  assert.equal(s.cached, 0);
  assert.equal(s.output, 5);
  assert.equal(s.tokens, 24675);
  const detail = { ...events(h).find((e) => e.cmd === 'spawn').detail };
  delete detail.codex_home;
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(require('../lib/usage-files').readUsage(detail).tokens, 24675, 'legacy events use the configured session root');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('an exited spawn without telemetry is marked unknown and can be recollected', async (t) => {
  const h = setup(t);
  const empty = path.join(h.base, 'empty.log');
  const barrier = path.join(h.base, 'collect-paused');
  const preload = path.join(__dirname, 'fixtures', 'pause-usage-collection.js').replace(/\\/g, '/');
  fs.writeFileSync(empty, 'No telemetry\n');
  const a = h.json(['spawn', '--task', 'T1'], {
    env: { ...h.usageEnv, NODE_OPTIONS: `--require "${preload}"`, USAGE_COLLECT_BARRIER: barrier },
    hooks: { ...h.usageHooks, HOOK_USAGE_FILE: empty },
  });
  let collection;
  try {
    await waitForFile(t, barrier);
    const pending = h.readState('tasks.json').tasks[0].spend;
    assert.equal(pending.entries[0].live.state, 'unavailable');
    assert.equal(pending.entries[0].tokens, null);
    let complete = false;
    collection = collected(h).then((spend) => { complete = true; return spend; });
    await Promise.resolve();
    assert.equal(complete, false, 'a live snapshot is not an exit collection receipt');
  } finally {
    fs.writeFileSync(`${barrier}.go`, '');
  }
  const s = await collection;
  assert.equal(s.entries[0].live, undefined, 'the exit collector finalized the usage entry');
  assert.equal(s.entries[0].tokens, null);
  assert.equal(s.tokens, 0);
  assert.equal(h.json(['status']).spend.missing_usage, 1);
  assert.match(h.ok(['status']), /1 spawns without usage/);
  // The collector writes state before rendering. Take the same lock and
  // render from the completed receipt before checking the derived file.
  h.ok(['render']);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /Spawns without usage/);
  await waitForText(path.join(h.state, 'sketch.html'), 'Spawns without usage');
  fs.appendFileSync(a.log, text('codex-stream.jsonl'));
  h.ok(['spend', 'T1', '--from-spawn', a.agent]);
  assert.equal(spends(h).entries.length, 1);
  assert.equal(spends(h).tokens, 24816);
  assert.equal(h.json(['status']).spend.missing_usage, 0);
});

test('late session detail enriches a partial total without counting it twice', (t) => {
  const h = setup(t);
  const id = '00000000-0000-0000-0000-000000000001';
  const partial = path.join(h.base, 'partial.jsonl');
  fs.writeFileSync(partial, [
    JSON.stringify({ type: 'thread.started', thread_id: id }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
  ].join('\n') + '\n');
  const started = h.json(['spawn', '--task', 'T1', '--wait'], {
    env: h.usageEnv, hooks: { ...h.usageHooks, HOOK_USAGE_FILE: partial },
  });
  assert.equal(spends(h).tokens, 120);
  assert.equal(spends(h).entries[0].cached, null);
  const dir = path.join(started.codex_home, 'sessions', '2026', '10', '06');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-10-06T00-00-00-${id}.jsonl`), [
    JSON.stringify({ type: 'turn_context', payload: { model: 'enriched-model' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, total_tokens: 120,
    } } } }),
  ].join('\n') + '\n');
  h.ok(['spend', 'T1', '--from-spawn', started.agent]);
  h.ok(['spend', 'T1', '--from-spawn', started.agent]);
  const s = spends(h);
  assert.equal(s.tokens, 120);
  assert.equal(s.input, 100);
  assert.equal(s.cached, 80);
  assert.equal(s.output, 20);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].model, 'enriched-model');
  fs.unlinkSync(path.join(dir, `rollout-2026-10-06T00-00-00-${id}.jsonl`));
  h.ok(['spend', 'T1', '--from-spawn', started.agent]);
  assert.equal(spends(h).entries[0].model, 'enriched-model');
  assert.equal(events(h).filter((e) => e.cmd === 'spend').length, 2, 'missing detail does not downgrade measured metadata');
});

test('detached accounting retries a lock held across the first collection attempt', async (t) => {
  const h = setup(t);
  h.json(['spawn', '--task', 'T1'], { env: { ...h.usageEnv, USAGE_DELAY: '1000' }, hooks: h.usageHooks });
  // The worker takes its lease before the lock is held; the lock then delays only its collection.
  const claimed = Date.now() + 10000;
  while (!events(h).some((e) => e.cmd === 'claim')) {
    assert.ok(Date.now() < claimed, 'worker did not take its lease');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const S = require('../lib/state');
  const lock = S.acquireLock(h.state);
  const timer = setTimeout(() => S.releaseLock(lock), S.LOCK_WAIT_MS + 3000);
  t.after(() => { clearTimeout(timer); S.releaseLock(lock); });
  const s = await collected(h, 1, S.LOCK_WAIT_MS * 3);
  assert.equal(s.tokens, 24816);
});

test('foreground accounting errors retain the harness exit code and exit event', (t) => {
  const h = setup(t);
  const r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...h.usageEnv, USAGE_EXIT: '7' }, hooks: { ...h.usageHooks, HOOK_USAGE_READ_FAIL: '1' },
  });
  assert.equal(r.code, 7);
  assert.equal(JSON.parse(r.stdout).code, 7);
  assert.match(r.stderr, /usage not recorded: usage log unavailable; retry spend/);
  assert.equal(events(h).find((e) => e.cmd === 'spawn exit').detail.code, 7);
  assert.equal(spends(h).tokens, 0);
});

test('a full usage disk still drains output and preserves the foreground result', (t) => {
  const h = setup(t);
  const r = h.run(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...h.usageEnv, USAGE_EXIT: '7' }, hooks: { ...h.usageHooks, HOOK_USAGE_WRITE_FAIL: '1' },
  });
  assert.equal(r.code, 7, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, 7);
  assert.match(r.stderr, /turn.completed/);
  assert.match(r.stderr, /usage log capture failed: usage disk full/);
  assert.equal(events(h).find((e) => e.cmd === 'spawn exit').detail.code, 7);
  assert.equal(spends(h).entries[0].tokens, null);
});

test('spawn refuses an existing log and never follows its symlink', { skip: process.platform === 'win32' }, (t) => {
  const h = setup(t);
  const planned = h.json(['spawn', '--task', 'T1', '--dry-run']);
  const target = path.join(h.base, 'protected.txt');
  fs.writeFileSync(target, 'keep\n');
  fs.mkdirSync(path.dirname(planned.log), { recursive: true });
  fs.symlinkSync(target, planned.log);
  const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: h.usageEnv, hooks: h.usageHooks });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 0);
});

async function runMonitor(t, h, detail, { clock = false, env = {} } = {}) {
  const child = cp.spawn(process.execPath, [
    ...(clock ? ['--require', path.join(__dirname, 'fixtures', 'monitor-clock.js')] : []),
    path.join(__dirname, '..', 'lib', 'spawn-monitor.js'),
    JSON.stringify({ state: h.state, task: 'T1', agent: 'worker-T1-1', ...detail }),
  ], { env: { ...h.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let timedOut = false;
  child.stderr.on('data', (data) => { stderr += data; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 3000);
  try {
    const code = await closed;
    return { code: timedOut ? 'timeout' : code, stderr };
  } finally { clearTimeout(timer); }
}

test('an accounting monitor exits when its project is removed', async (t) => {
  const h = setup(t);
  fs.rmSync(h.state, { recursive: true, force: true });
  const { code } = await runMonitor(t, h, { pid: 0 });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(h.state), false, 'cleanup does not recreate the project');
});

for (const scenario of ['host', 'signal', 'stat']) {
  test(`an accounting monitor bounds unknown ${scenario} observations without recording usage`, {
    skip: scenario === 'stat' && process.platform !== 'linux',
  }, async (t) => {
    const h = setup(t);
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const { code, stderr } = await runMonitor(t, h, {
      pid: process.pid,
      ...(scenario === 'host' ? { host: require('node:os').hostname() + '-other' } : {}),
    }, { clock: true, env: { TOWER_CRANE_TEST_MONITOR_PERMISSION: scenario, TOWER_CRANE_TEST_MONITOR_PID: String(process.pid) } });
    assert.equal(code, 1, stderr);
    assert.match(stderr, /cannot observe.*retry spend T1 --from-spawn worker-T1-1/);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before, 'unknown is not proof of exit');
  });
}

test('test teardown stops a surviving detached monitor and waits for its exit', async (t) => {
  const h = setup(t);
  h.json(['spawn', '--task', 'T1'], {
    env: { ...h.usageEnv, USAGE_DELAY: '60000' },
    hooks: { ...h.usageHooks, HOOK_MONITOR_HOST: require('node:os').hostname() + '-other' },
  });
  const monitors = h.detached().filter((c) => c.kind === 'monitor');
  assert.equal(monitors.length, 1);
  if (process.platform === 'win32') await h.cleanup();
  else await assert.rejects(h.cleanup(), /detached usage monitors outlived test teardown/);
  assert.ok(monitors.every((c) => !detachedAlive(c)));
});

test('a monitor bounds failed collection with a fractional monotonic deadline', async (t) => {
  const h = setup(t);
  const { code, stderr } = await runMonitor(t, h, { pid: process.pid }, {
    clock: true,
    env: {
      TOWER_CRANE_TEST_MONITOR_PERMISSION: 'exited', TOWER_CRANE_TEST_MONITOR_PID: String(process.pid),
      TOWER_CRANE_TEST_MONITOR_STEP: '590000.5',
    },
  });
  assert.equal(code, 1);
  assert.match(stderr, /usage not recorded after 10 min; retry spend T1 --from-spawn worker-T1-1/);
  assert.doesNotMatch(stderr, /usage monitor failed/);
});
