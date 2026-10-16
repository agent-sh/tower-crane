'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { cachedFixture, useFixtureUserFile, HOOKS, BIN } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const { EventReader } = require('../lib/event-reader');
const S = require('../lib/state');
const T = require('../lib/tasks');
const hooksPath = HOOKS.replace(/\\/g, '/');
const budgetPath = path.join(__dirname, 'fixtures', 'events-read-budget.js').replace(/\\/g, '/');
const resetPath = path.join(__dirname, 'fixtures', 'event-reset-notice.js').replace(/\\/g, '/');

function largeFixture(t) {
  return cachedFixture(t, 'large-events', (h) => {
    h.init();
    const line = JSON.stringify({ cmd: 'hook progress', detail: { text: 'x'.repeat(1024) } }) + '\n';
    const chunk = line.repeat(1024);
    const fd = fs.openSync(path.join(h.state, 'events.jsonl'), 'a');
    try {
      for (let size = 0; size < 50 * 1024 * 1024; size += Buffer.byteLength(chunk)) fs.writeSync(fd, chunk);
    } finally {
      fs.closeSync(fd);
    }
  });
}

const waitModes = [{ observe: true, silent: false }, { observe: true, silent: true }, { observe: false, silent: false }];
for (const { observe, silent } of waitModes) test(`idle wait reads no historical bytes on fallback ticks with a 50 MiB log (observe: ${observe}, silent watch: ${silent})`, async (t) => {
  const h = largeFixture(t);
  const meter = path.join(h.base, 'read-budget.json');
  const result = await h.runAsync(['wait', ...(observe ? ['--observe'] : []), '--agent', 'orchestrator', '--timeout', '3'], { // wait-allow: an idle wait must reach its timeout to prove fallback ticks read no history
    env: { EVENT_READ_BUDGET: meter, NODE_OPTIONS: `--require "${hooksPath}" --require "${budgetPath}"`, ...(silent ? { HOOK_SILENT_WATCH: '1' } : {}) },
  });
  assert.equal(result.code, 2, result.stderr);
  const budget = JSON.parse(fs.readFileSync(meter, 'utf8'));
  assert.equal(budget.bytes, 0);
  assert.equal(budget.snapshotBytes, 0, 'idle checks must reuse validated state snapshots');
});

test('served pages and owner message requests reuse history on a 50 MiB log', async (t) => {
  const h = largeFixture(null);
  const meter = path.join(h.base, 'board-read-budget.json');
  const child = cp.spawn(process.execPath, [BIN, 'serve', '--agent', 'viewer', '--port', '0', '--json'], {
    cwd: h.repo,
    env: { ...h.env, EVENT_READ_BUDGET: meter, NODE_OPTIONS: `--require "${hooksPath}" --require "${budgetPath}"` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill(), HUNG_TEST_MS);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    await closed;
    clearTimeout(timer);
    await h.cleanup();
  });
  const ready = once(child.stdout, 'data').then(([chunk]) => JSON.parse(chunk.toString()));
  const { url } = await Promise.race([ready, closed.then(() => { throw new Error(stderr || 'serve exited before ready'); })]);
  for (let i = 0; i < 3; i++) {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    await page.text();
    const response = await fetch(new URL('/api/messages?after=0', url));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages, []);
  }
  // Windows kill terminates immediately, without running the exit meter.
  child.send('stop');
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const budget = JSON.parse(fs.readFileSync(meter, 'utf8'));
  assert.equal(budget.bytes, 0);
  assert.equal(budget.snapshotBytes, 0);
});

test('event tail buffers partial UTF-8 bytes and resets history only on truncation or replacement', (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  const file = path.join(h.base, 'tail.jsonl');
  const line = (cmd, text = '') => Buffer.from(JSON.stringify({ cmd, detail: { text } }) + '\n');
  const original = line('msg', 'start');
  fs.writeFileSync(file, original);
  const reader = new EventReader(file);
  let bytes = 0;
  const read = fs.readSync;
  fs.readSync = function (...args) {
    const n = read.apply(this, args);
    bytes += n;
    return n;
  };
  t.after(() => { fs.readSync = read; });
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['start']);
  assert.equal(bytes, original.length);
  const next = line('msg', 'שלום');
  const split = next.indexOf(Buffer.from('שלום')) + 1;
  fs.appendFileSync(file, next.subarray(0, split));
  assert.deepEqual(reader.read().rows, []);
  assert.equal(reader.offset, original.length);
  const partialBytes = bytes;
  for (let i = 0; i < 20; i++) assert.deepEqual(reader.read().rows, []);
  assert.equal(bytes, partialBytes, 'idle checks must not reread the partial suffix');
  fs.appendFileSync(file, next.subarray(split));
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['שלום']);
  assert.equal(bytes, original.length + next.length);
  fs.appendFileSync(file, 'broken\n');
  const renewal = line('renew');
  fs.appendFileSync(file, renewal);
  assert.deepEqual(reader.read().rows.map((e) => e.cmd), ['renew']);
  assert.equal(reader.offset, original.length + next.length + Buffer.byteLength('broken\n') + renewal.length);

  fs.writeFileSync(file, line('truncate'));
  let batch = reader.read();
  assert.equal(batch.reset, true);
  assert.deepEqual(batch.rows.map((e) => e.cmd), ['truncate']);
  const replacement = file + '.new';
  fs.writeFileSync(replacement, line('replace', 'x'.repeat(128)));
  fs.renameSync(replacement, file);
  batch = reader.read();
  assert.equal(batch.reset, true, 'replacement larger than the old log must reset too');
  assert.deepEqual(batch.rows.map((e) => e.cmd), ['replace']);
  fs.unlinkSync(file);
  assert.equal(reader.read().reset, true);
  fs.writeFileSync(file, line('recreate'));
  assert.deepEqual(reader.read().rows.map((e) => e.cmd), ['recreate']);
});

test('retained state history keeps snapshots independent and does not duplicate local writes', (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  const release = S.retainEvents(h.state);
  t.after(release);
  useFixtureUserFile(t, h);
  const before = S.readEvents(h.state);
  const ctx = { stateDir: h.state, agent: 'owner', env: h.env, flags: {}, pos: [] };
  S.mutate(ctx, 'msg', (st, emit) => {
    emit(null, { to: 'orchestrator', text: 'one receipt' });
  });
  const after = S.readEvents(h.state);
  assert.equal(after.length, before.length + 1);
  assert.equal(before.some((e) => e.detail?.text === 'one receipt'), false);
  assert.equal(after.filter((e) => e.detail?.text === 'one receipt').length, 1);
  assert.equal(S.readEvents(h.state), after, 'idle loads reuse their snapshot');
  const snapshot = S.loadState(h.state);
  assert.equal(S.loadState(h.state).tasks, snapshot.tasks);
  S.mutate(ctx, 'project set', (st, emit) => {
    st.project.goal = 'Changed goal';
    emit(null, { goal: st.project.goal });
  });
  assert.notEqual(snapshot.project.goal, 'Changed goal', 'writers must not mutate retained snapshots');
  assert.equal(S.loadState(h.state).project.goal, 'Changed goal');
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), '');
  assert.deepEqual(S.readEvents(h.state), []);
  release();
  release();
});

test('idle reservation checks reuse history while expiry and appended claims remain visible', () => {
  let visits = 0;
  const history = Array.from({ length: 1000 }, () => ({ cmd: 'msg', detail: {} }));
  history.push({ at: new Date(0).toISOString(), cmd: 'spawn', task: 'T1',
    detail: { role: 'worker', reserved: true, agent: 'worker', attempt: 1, pid: 10 } });
  const events = new Proxy(history, { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) visits++;
    return Reflect.get(target, key, receiver);
  } });
  const st = { events, project: { limits: { lease_minutes: 1 } } };
  const slots = T.reservations(st, 0);
  assert.equal(slots.length, 1);
  slots[0].until = 0;
  slots[0].proc.pid = 99;
  visits = 0;
  for (let i = 0; i < 10; i++) assert.equal(T.reservations(st, 1000).length, 1);
  assert.deepEqual(T.reservations(st, 60001), []);
  assert.equal(visits, 0, 'unchanged history must not be replayed on idle checks');
  assert.equal(T.reservations(st, 1000)[0].proc.pid, 10, 'callers must not mutate cached reservations');
  st.project.limits.lease_minutes = 2;
  assert.equal(T.reservations(st, 60001).length, 1, 'a changed lease horizon must rebuild reservations');
  st.project.limits.lease_minutes = 1;
  assert.equal(T.reservations(st, 1000).length, 1);
  visits = 0;
  history.push({ cmd: 'claim', task: 'T1', agent: 'worker', detail: {} });
  assert.deepEqual(T.reservations(st, 1000), []);
  assert.ok(visits > 0, 'a new receipt must invalidate the cached reservation history');
});

test('orchestrator lease writes leave frozen retained snapshots unchanged', (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  t.after(S.retainEvents(h.state));
  useFixtureUserFile(t, h);
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  const session = { session_id: 'snapshot-writer', harness_session_id: null,
    agent: 'orchestrator', host: 'fixture', pid: process.pid };
  const ctx = { stateDir: h.state, agent: 'orchestrator', agentExplicit: true,
    env: h.env, flags: {}, pos: [], orchestratorSession: session };
  for (const action of ['acquire', 'renew']) {
    const snapshot = freeze(S.loadState(h.state));
    const before = structuredClone(snapshot);
    assert.doesNotThrow(() => require('../lib/orchestrator').command(ctx, 'wait'), action);
    assert.deepEqual(snapshot, before, `${action} must not mutate a retained reader snapshot`);
    assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, session.session_id);
  }
});

function restoreFixture() {
  return cachedFixture(null, 'restore-events', (h) => {
    h.init();
    for (let i = 1; i <= 3; i++) h.ok(['msg', '--to', 'orchestrator', `historical ${i}`]);
  });
}

function resetReader(t, h, args) {
  const changes = new EventEmitter();
  const notices = [];
  let output = '';
  let stderr = '';
  const child = cp.spawn(process.execPath, [BIN, ...args], {
    cwd: h.repo, env: { ...h.env, NODE_OPTIONS: `--require "${hooksPath}" --require "${resetPath}"` },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const closed = once(child, 'close');
  child.stdout.on('data', (data) => { output += data; changes.emit('change'); });
  child.stderr.on('data', (data) => { stderr += data; });
  child.on('message', (message) => { notices.push(message); changes.emit('change'); });
  const timer = setTimeout(() => child.kill(), HUNG_TEST_MS);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send('stop');
      else child.kill();
    }
    return await closed;
  };
  t.after(async () => {
    await stop();
    clearTimeout(timer);
    await h.cleanup();
  });
  const until = async (probe) => {
    for (;;) {
      const value = probe();
      if (value) return value;
      await Promise.race([
        once(changes, 'change'),
        closed.then(() => { throw new Error(stderr || 'reader exited before its notification'); }),
      ]);
    }
  };
  const lines = () => output.slice(0, output.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
  return { child, notices, changes, closed, stop, until, lines };
}

function restoreLog(h, smaller) {
  const file = path.join(h.state, 'events.jsonl');
  const original = fs.readFileSync(file, 'utf8');
  const restored = smaller ? original.trimEnd().split('\n').slice(0, -1).join('\n') + '\n' : original;
  fs.writeFileSync(file + '.restore', restored);
  fs.renameSync(file + '.restore', file);
  return restored.trimEnd().split('\n').map(JSON.parse).filter((row) => row.cmd === 'msg').map((row) => row.detail.text);
}

function appendAfterRestore(h) {
  h.ok(['msg', '--to', 'orchestrator', 'after restore']);
  return JSON.parse(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trimEnd().split('\n').at(-1)).id;
}

for (const follow of [false, true]) for (const smaller of [false, true]) {
  test(`restored history does not wake wait (follow: ${follow}, smaller: ${smaller})`, async (t) => {
    const h = restoreFixture();
    const reader = resetReader(t, h, ['wait', '--observe', '--agent', 'orchestrator',
      ...(follow ? ['--follow'] : ['--timeout', '300'])]);
    await reader.until(() => reader.notices.some((notice) => !notice.reset));
    restoreLog(h, smaller);
    await reader.until(() => reader.notices.some((notice) => notice.reset));
    const id = appendAfterRestore(h);
    if (follow) {
      await reader.until(() => reader.lines().some((row) => row.id === id));
      await reader.stop();
    } else {
      const [code] = await reader.closed;
      assert.equal(code, 0);
    }
    const rows = reader.lines().filter((row) => row.type !== 'ready');
    // stop() delivers SIGTERM; a follower ends with its signal stop notice, not a wake.
    if (follow) assert.deepEqual(rows.pop(), { reason: 'signal', signal: 'SIGTERM', drained: 0 });
    assert.deepEqual(rows.map((row) => row.id), [id]);
  });
}

for (const smaller of [false, true]) {
  test(`restored owner history stays queryable without SSE replay (smaller: ${smaller})`, async (t) => {
    const h = restoreFixture();
    const server = resetReader(t, h, ['serve', '--agent', 'viewer', '--port', '0', '--json']);
    const { url } = await server.until(() => server.lines()[0]);
    const controller = new AbortController();
    const response = await fetch(new URL('/events', url), { signal: controller.signal });
    const stream = response.body.getReader();
    let output = '';
    const drained = (async () => {
      try {
        for (;;) {
          const { value, done } = await stream.read();
          if (done) return;
          output += Buffer.from(value).toString('utf8');
          server.changes.emit('change');
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    })();
    t.after(async () => { controller.abort(); await drained; });
    await server.until(() => output.includes(': connected'));
    const history = restoreLog(h, smaller);
    const restored = await fetch(new URL('/api/messages?after=0', url));
    assert.deepEqual((await restored.json()).messages.map((row) => row.detail.text), history);
    await server.until(() => server.notices.some((notice) => notice.reset));
    const id = appendAfterRestore(h);
    await server.until(() => output.includes(id));
    controller.abort();
    await drained;
    await server.stop();
    const wakes = output.split('\n\n').filter((block) => block.startsWith('event: wake'))
      .map((block) => JSON.parse(block.split('data: ')[1]));
    assert.deepEqual(wakes.map((wake) => wake.id), [id]);
  });
}
