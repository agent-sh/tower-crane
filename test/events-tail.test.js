'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { cachedFixture, useFixtureUserFile, HOOKS, BIN } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const { EventReader, cutsSize, readCuts, cutBack } = require('../lib/event-reader');
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
    env: { ...h.env, EVENT_READ_BUDGET: meter, NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require "${hooksPath}" --require "${budgetPath}"` },
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
    cwd: h.repo, env: { ...h.env, NODE_OPTIONS: `${h.env.NODE_OPTIONS} --require "${hooksPath}" --require "${resetPath}"` },
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

function cutFixture() {
  return cachedFixture(null, 'cut-events', (h) => {
    h.init();
    h.ok(['msg', '--to', 'orchestrator', 'before the cut']);
  });
}

const message = (agent, to, text) => ({ at: new Date().toISOString(), agent, cmd: 'msg', task: null, detail: { to, text },
  id: `E${require('node:crypto').randomUUID()}`, type: 'worker-message', to });

// A commit that died in the middle of its append: its staged tasks.json and
// manifest are on disk, and the log holds its first line whole and the start
// of its second. The next lock holder cuts both off. Returns the log's
// length before the commit and the offset after its first line.
function tornCommit(h, first) {
  const log = path.join(h.state, 'events.jsonl');
  const second = message(first.agent, first.to, 'torn second');
  const fd = fs.openSync(log, 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), fs.readFileSync(path.join(h.state, 'tasks.json')));
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  const line = `${JSON.stringify(first)}\n`;
  fs.writeSync(fd, `${line}${JSON.stringify(second).slice(0, 60)}`);
  fs.closeSync(fd);
  return { size, after: size + Buffer.byteLength(line) };
}

// Whether offset lies in the one recorded cut's range, where only cursors
// taken before the cut move back.
function inCut(h, offset) {
  const cuts = fs.readFileSync(path.join(h.state, 'events.cuts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(cuts.length, 1);
  return cuts[0].size < offset && offset <= cuts[0].from;
}

// Longer than the torn bytes, so the log grows past where readers stopped.
const LONG = `after the cut ${'x'.repeat(400)}`;

test('an event reader that read a torn commit resumes where recovery cut it and reads what was appended after', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const reader = new EventReader(path.join(h.state, 'events.jsonl'));
  reader.read();
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['torn first']);
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG]);
  assert.equal(batch.cut, size);
  assert.equal(batch.reset, false);
  assert.equal(reader.offset, fs.statSync(path.join(h.state, 'events.jsonl')).size);
});

test('a wait cursor inside bytes recovery cut off reads the events appended since', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const { after } = tornCommit(h, message('worker', 'orchestrator', 'torn first'));
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', LONG]);
  const r = h.run(['wait', '--agent', 'orchestrator', '--after', String(after), '--types', 'worker-message', '--timeout', '5']); // wait-allow: the event is already logged, so wait returns at once
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).detail.text, LONG);
});

test('a wait re-armed with the cursor it returned after a cut times out, then wakes for the next event', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const { after } = tornCommit(h, message('worker', 'orchestrator', 'torn first'));
  // Shorter than the cut bytes, so the offset wait returns for it lies in the cut range.
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', 'short']);
  const wait = (cursor, timeout) => h.run(['wait', '--agent', 'orchestrator', '--after', String(cursor), '--types', 'worker-message', '--timeout', timeout]); // wait-allow: each event is logged before the wait starts, or the wait must reach its timeout
  const first = JSON.parse(wait(after, '5').stdout);
  assert.equal(first.detail.text, 'short');
  assert.ok(inCut(h, first.offset), `offset ${first.offset} is inside the cut range`);
  const again = wait(first.offset, '0.5');
  assert.equal(again.code, 2, `the wait returned ${again.stdout}`);
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', 'later']);
  assert.equal(JSON.parse(wait(first.offset, '5').stdout).detail.text, 'later');
});

test('a holder killed after its cut and before recording it leaves the record to the next holder', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const reader = new EventReader(log);
  reader.read();
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['torn first']);
  const r = h.run(['msg', '--to', 'orchestrator', 'never sent'], { hooks: { HOOK_DIE_RECORDING_CUT: '1' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.equal(fs.statSync(log).size, size, 'the log was cut');
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG]);
  assert.equal(batch.cut, size);
});

test('a torn cut record does not swallow the next one', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const reader = new EventReader(log);
  reader.read();
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  reader.read();
  // A record torn by a power cut, after the reader last read.
  fs.writeFileSync(path.join(h.state, 'events.cuts.jsonl'), '{"at":"2026-10-16T00:00:00.000Z","si');
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG]);
  assert.equal(batch.cut, size);
});

test('a reader started from a cursor goes back for a cut recorded after the cursor was taken', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const { size, after } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  const cuts = require('../lib/event-reader').cutsSize(log);
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  const reader = new EventReader(log, { after, cuts });
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG]);
  assert.equal(batch.cut, size);
});

test('served messages after a cursor inside bytes recovery cut off include the messages appended since', async (t) => {
  const h = cutFixture();
  const server = resetReader(t, h, ['serve', '--agent', 'viewer', '--port', '0', '--json']);
  const { url } = await server.until(() => server.lines()[0]);
  const controller = new AbortController();
  const stream = (await fetch(new URL('/events', url), { signal: controller.signal })).body.getReader();
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
  tornCommit(h, message('w-1', 'owner', 'torn first'));
  const first = await (await fetch(new URL('/api/messages', url))).json();
  assert.deepEqual(first.messages.map((m) => m.detail.text), ['before the cut', 'torn first']);
  // Shorter than the cut bytes: it ends before offsets the page was woken for.
  h.ok(['msg', '--to', 'owner', 'short', '--agent', 'w-1']);
  const next = await (await fetch(new URL(`/api/messages?after=${first.cursor}`, url))).json();
  assert.deepEqual(next.messages.map((m) => m.detail.text), ['short']);
  const all = await (await fetch(new URL('/api/messages?after=0', url))).json();
  assert.deepEqual(all.messages.map((m) => m.detail.text), ['before the cut', 'short'], 'the cut message is gone');
  // The cursor handed out after the cut stays where it is.
  assert.ok(inCut(h, next.cursor), `cursor ${next.cursor} is inside the cut range`);
  const after = await (await fetch(new URL(`/api/messages?after=${next.cursor}`, url))).json();
  assert.deepEqual(after.messages, []);
  // The page is woken for it too.
  await server.until(() => output.includes(next.messages[0].id));
});

// Lock recovery by a holder that logs nothing, so the test appends next.
const recover = (h) => S.withLock(h.state, () => {});

// A line as long as first, appended after the cut, so it ends where first
// ended before recovery cut it off.
function sameEnd(h, first) {
  const line = { ...first, id: `E${require('node:crypto').randomUUID()}` };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(line)}\n`);
  return line.id;
}

test('a wait cursor that carries the cuts goes back for a cut even where a new line ends at its offset', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const first = message('worker', 'orchestrator', 'torn first');
  const cuts = cutsSize(log);
  const { after } = tornCommit(h, first);
  recover(h);
  const id = sameEnd(h, first);
  assert.equal(fs.statSync(log).size, after, 'the new line ends where the cut one did');
  const wait = (cursor, timeout) => h.run(['wait', '--agent', 'orchestrator', '--after', cursor, '--types', 'worker-message', '--timeout', timeout]); // wait-allow: the event is logged before the first wait starts; the second must reach its timeout
  const woke = wait(`${after}:${cuts}`, '5');
  assert.equal(woke.code, 0, woke.stderr);
  const e = JSON.parse(woke.stdout);
  assert.equal(e.id, id);
  assert.equal(e.cursor, `${after}:${cutsSize(log)}`);
  const again = wait(e.cursor, '0.5');
  assert.equal(again.code, 2, `the wait returned ${again.stdout}`);
  assert.equal(JSON.parse(again.stdout).cursor, e.cursor);
});

test('served messages after a cursor with its cuts include a message whose line ends where a cut one did', async (t) => {
  const h = cutFixture();
  const log = path.join(h.state, 'events.jsonl');
  const server = resetReader(t, h, ['serve', '--agent', 'viewer', '--port', '0', '--json']);
  const { url } = await server.until(() => server.lines()[0]);
  const first = message('w-1', 'owner', 'torn first');
  const before = await (await fetch(new URL('/api/messages', url))).json();
  const { after } = tornCommit(h, first);
  recover(h);
  const id = sameEnd(h, first);
  const next = await (await fetch(new URL(`/api/messages?after=${after}&cuts=${before.cuts}`, url))).json();
  assert.deepEqual(next.messages.map((m) => m.id), [id]);
  assert.equal(next.cuts, cutsSize(log));
  const again = await (await fetch(new URL(`/api/messages?after=${next.cursor}&cuts=${next.cuts}`, url))).json();
  assert.deepEqual(again.messages, []);
});

test('recovery records two cuts of the same length at the same place, so a reader goes back for the second', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const reader = new EventReader(log);
  reader.read();
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  recover(h);
  tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['torn first']);
  recover(h);
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG]);
  assert.equal(batch.cut, size);
  assert.equal(readCuts(log).cuts.length, 2);
});

test('a cut an older tool finished recovering is recorded late, and only a reader that read the cut bytes goes back', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const reader = new EventReader(log);
  reader.read();
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['torn first']);
  const r = h.run(['msg', '--to', 'orchestrator', 'never sent'], { hooks: { HOOK_DIE_RECORDING_CUT: '1' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.equal(fs.statSync(log).size, size, 'the log was cut');
  // A tool from before cut records finishes the recovery its way: it removes
  // the staged files and the manifest, then appends its own event.
  for (const name of fs.readdirSync(h.state)) {
    if (/^(tasks\.json\.E[0-9a-f-]+\.commit|commit\.E[0-9a-f-]+\.json)$/.test(name)) fs.unlinkSync(path.join(h.state, name));
  }
  fs.appendFileSync(log, `${JSON.stringify(message('worker', 'orchestrator', LONG))}\n`);
  // This reader read the older tool's event, never the cut bytes.
  const later = new EventReader(log);
  assert.deepEqual(later.read().rows.map((e) => e.detail.text).slice(-1), [LONG]);
  h.ok(['msg', '--to', 'orchestrator', 'after the older tool']);
  const recorded = readCuts(log).cuts;
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].late, true);
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.detail.text), [LONG, 'after the older tool']);
  assert.equal(batch.cut, size);
  const read = later.read();
  assert.deepEqual(read.rows.map((e) => e.detail.text), ['after the older tool']);
  assert.equal(read.cut, undefined);
  assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('cut.')), []);
});

test('a cut recorded while a reader reads the log after it is in the cursor the reader hands out', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const log = path.join(h.state, 'events.jsonl');
  const first = message('worker', 'orchestrator', 'torn first');
  const reader = new EventReader(log);
  reader.read();
  tornCommit(h, first);
  // Recovery cuts the torn append and the next line lands after the
  // reader checked the cuts file and before it reads the log.
  const readSync = fs.readSync;
  let id;
  fs.readSync = function (...args) {
    fs.readSync = readSync;
    recover(h);
    id = sameEnd(h, first);
    return readSync.apply(this, args);
  };
  t.after(() => { fs.readSync = readSync; });
  const batch = reader.read();
  assert.deepEqual(batch.rows.map((e) => e.id), [id]);
  assert.equal(reader.cuts, cutsSize(log));
  assert.equal(cutBack(log, batch.offset, reader.cuts), batch.offset, 'the cursor does not move back over the event it was handed out after');
});
