'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { cachedFixture, useFixtureUserFile, HOOKS, BIN } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const { EventReader, parseCuts } = require('../lib/event-reader');
const S = require('../lib/state');
const T = require('../lib/tasks');
const Db = require('../lib/db');
const hooksPath = HOOKS.replace(/\\/g, '/');
const budgetPath = path.join(__dirname, 'fixtures', 'events-read-budget.js').replace(/\\/g, '/');
const resetPath = path.join(__dirname, 'fixtures', 'event-reset-notice.js').replace(/\\/g, '/');

// About 50 MiB of quiet events, as months of lease renewals leave.
function largeFixture(t) {
  return cachedFixture(t, 'large-events', (h) => {
    h.init();
    const text = 'x'.repeat(1024);
    for (let n = 0; n < 48; n++) {
      const events = Array.from({ length: 1024 }, () => ({ id: `E${crypto.randomUUID()}`, at: new Date().toISOString(), agent: 'worker', cmd: 'renew', task: null, detail: { text }, type: 'renew', to: 'orchestrator' }));
      StateFiles.withDb(h.state, () => S.withLock(h.state, () => Db.commit(h.state, { events })));
    }
  });
}

const waitModes = [{ observe: true, silent: false }, { observe: true, silent: true }, { observe: false, silent: false }];
for (const { observe, silent } of waitModes) test(`idle wait reads no historical events on fallback ticks with a 50 MiB log (observe: ${observe}, silent watch: ${silent})`, async (t) => {
  const h = largeFixture(t);
  const meter = path.join(h.base, 'read-budget.json');
  const result = await h.runAsync(['wait', ...(observe ? ['--observe'] : []), '--agent', 'orchestrator', '--timeout', '3'], { // wait-allow: an idle wait must reach its timeout to prove fallback ticks read no history
    env: { EVENT_READ_BUDGET: meter, NODE_OPTIONS: `--require "${hooksPath}" --require "${budgetPath}"`, ...(silent ? { HOOK_SILENT_WATCH: '1' } : {}) },
  });
  assert.equal(result.code, 2, result.stderr);
  const budget = JSON.parse(fs.readFileSync(meter, 'utf8'));
  assert.equal(budget.rows, 0);
  assert.equal(budget.snapshots, 0, 'idle checks must reuse validated state snapshots');
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
  assert.equal(budget.rows, 0);
  assert.equal(budget.snapshots, 0);
});

const message = (agent, to, text, at = new Date().toISOString()) => ({ at, agent, cmd: 'msg', task: null, detail: { to, text },
  id: `E${crypto.randomUUID()}`, type: 'worker-message', to });

// Event rows this process reads of dir while fn runs.
function rowsRead(dir, fn) {
  let rows = 0;
  const count = (step, at, n) => { if (step === 'events' && path.resolve(at) === path.resolve(dir)) rows += n; };
  process.on('tower-crane:state-step', count);
  try {
    fn();
  } finally {
    process.off('tower-crane:state-step', count);
  }
  return rows;
}

test('an event reader reads only the events committed past it, and starts over when the database is replaced or removed', async (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  const reader = new EventReader(h.state);
  t.after(() => Db.closeAll());
  const history = reader.read().rows.length;
  assert.ok(history > 0);
  h.appendEvents([message('owner', 'orchestrator', 'שלום')]);
  let batch;
  assert.equal(rowsRead(h.state, () => { batch = reader.read(); }), 1, 'only the new event is read');
  assert.deepEqual(batch.rows.map((e) => e.detail.text), ['שלום']);
  assert.equal(reader.offset, StateFiles.logEnd(h.state));
  for (let i = 0; i < 20; i++) assert.deepEqual(reader.read().rows, []);
  const copy = path.join(h.base, 'backup.db');
  StateFiles.backup(h.state, copy);
  h.appendEvents([message('owner', 'orchestrator', 'after the backup')]);
  assert.deepEqual(reader.read().rows.map((e) => e.detail.text), ['after the backup']);
  // An older copy of this database ends before the reader's position.
  Db.closeAll();
  await StateFiles.restore(h.state, copy);
  batch = reader.read();
  assert.equal(batch.reset, true);
  assert.equal(batch.rows.length, history + 1);
  // Another database: the same events under another uid.
  Db.closeAll();
  StateFiles.rewriteState(h.state, (text) => text);
  batch = reader.read();
  assert.equal(batch.reset, true, 'a database with another uid is read from the start');
  // Gone, then back.
  Db.closeAll();
  await StateFiles.restore(h.state, copy, { how: 'remove', between: async () => assert.deepEqual([reader.read().reset, reader.read().rows], [true, []]) });
  assert.equal(reader.read().rows.length, history + 1);
});

// A copy of the database renamed over state.db, as an owner restores a
// `VACUUM INTO` backup: it keeps the uid, and the commits after it carry the
// counters past what a reader last read.
function restoreThenCommit(h, copy) {
  if (process.platform === 'win32') Db.closeAll();
  const target = path.join(h.state, Db.FILE);
  fs.copyFileSync(copy, `${target}.restore`);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
  fs.renameSync(`${target}.restore`, target);
  for (let i = 0; i < 5; i++) h.ok(['task', 'note', 'T1', `after the restore ${i}`]);
}

function storedUid(file) {
  const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'uid'").get().value;
  } finally {
    db.close();
  }
}

const lostNote = (e) => e.cmd === 'task note' && e.task === 'T2';
const restoreReaders = [
  ['a retained snapshot', (h, copy, t) => {
    t.after(S.retainEvents(h.state, { long: true }));
    return () => S.loadState(h.state).tasks.tasks.find((task) => task.id === 'T2');
  }, (before, after) => {
    assert.deepEqual([before.title, before.notes.length], ['Renamed then lost', 1]);
    assert.deepEqual([after.title, after.notes.length], ['B', 0], 'the reader keeps a task the restore reverted');
  }],
  ['retained events', (h, copy, t) => {
    t.after(S.retainEvents(h.state, { long: true }));
    return () => S.readEvents(h.state);
  }, (before, after, h) => {
    assert.equal(before.some(lostNote), true);
    assert.equal(after.some(lostNote), false, 'the reader keeps an event the restore removed');
    assert.equal(after.length, S.loadState(h.state, { fresh: true }).events.length);
  }],
  ['an event reader', (h) => {
    const reader = new EventReader(h.state);
    return () => reader.read();
  }, (before, after) => {
    assert.equal(before.rows.some(lostNote), true);
    assert.equal(after.reset, true, 'the reader goes on past events the restore removed');
  }],
  ['a write read before the restore', (h, copy, t) => {
    useFixtureUserFile(t, h);
    return () => {
      const ctx = { stateDir: h.state, agent: 'owner', env: h.env, flags: {}, pos: [] };
      let restored = false;
      // The restore comes after the write's read and before its lock.
      const between = (step, dir) => {
        if (step !== 'snapshot' || restored || path.resolve(dir) !== path.resolve(h.state)) return;
        restored = true;
        restoreThenCommit(h, copy);
      };
      process.on('tower-crane:state-step', between);
      try {
        S.mutate(ctx, 'task update', (st, emit) => {
          st.tasks.tasks.find((task) => task.id === 'T2').priority = 'high';
          emit('T2', { priority: 'high' });
        });
      } finally {
        process.off('tower-crane:state-step', between);
      }
      return S.loadState(h.state, { fresh: true }).tasks.tasks.find((task) => task.id === 'T2');
    };
  }, (_before, after) => {
    assert.deepEqual([after.title, after.priority], ['B', 'high'], 'the write puts back a task the restore reverted');
  }, { during: true }],
];

// `during`: the row's read restores the copy itself, between its steps.
for (const [name, open, check, { during = false } = {}] of restoreReaders) {
  test(`${name} starts over on a restored copy of the same database, whatever commits come after it`, (t) => {
    const h = cachedFixture(t, 'restore-readers', (h) => {
      h.init();
      for (const title of ['A', 'B']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
    });
    t.after(() => Db.closeAll());
    const copy = path.join(h.base, 'backup.db');
    const read = open(h, copy, t);
    if (!during) read();
    StateFiles.backup(h.state, copy);
    h.ok(['task', 'note', 'T2', 'lost by the restore']);
    h.ok(['task', 'update', 'T2', '--title', 'Renamed then lost']);
    const before = during ? null : read();
    if (!during) restoreThenCommit(h, copy);
    check(before, read(), h);
    assert.equal(storedUid(path.join(h.state, Db.FILE)), storedUid(copy), 'the restored database keeps the uid of the one backed up');
  });
}

test('a restored copy is history by event id, and an event from a clock behind is new', async (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  t.after(() => Db.closeAll());
  const minutes = (n) => new Date(Date.now() + n * 60000).toISOString();
  // Written across a clock step back: the newest `at` is not on the last event.
  h.appendEvents([message('owner', 'orchestrator', 'one', minutes(5)), message('owner', 'orchestrator', 'two', minutes(0))]);
  const reader = new EventReader(h.state, { restores: true });
  const texts = (b) => b.rows.filter((e) => !b.restored.has(e) && e.cmd === 'msg').map((e) => e.detail.text);
  assert.deepEqual(texts(reader.read()), ['one', 'two']);
  const copy = path.join(h.base, 'backup.db');
  StateFiles.backup(h.state, copy);
  StateFiles.rewriteState(h.state, (text) => text);
  const batch = reader.read();
  assert.deepEqual([batch.reset, texts(batch)], [true, []], 'the same events under another database are history');
  h.appendEvents([message('owner', 'orchestrator', 'behind', minutes(-60))]);
  assert.deepEqual(texts(reader.read()), ['behind']);
  Db.closeAll();
  await StateFiles.restore(h.state, copy);
  h.appendEvents([message('owner', 'orchestrator', 'new', minutes(-120))]);
  const back = reader.read();
  assert.deepEqual([back.reset, texts(back)], [true, ['new']]);
});

test('history before a start cursor is restored up to the start event, then a clock behind still wakes', async (t) => {
  const h = cachedFixture(t, 'reader', (h) => h.init());
  t.after(() => Db.closeAll());
  h.appendEvents([message('owner', 'orchestrator', 'old one'), message('owner', 'orchestrator', 'old two')]);
  const copy = path.join(h.base, 'backup.db');
  StateFiles.backup(h.state, copy);
  const reader = new EventReader(h.state, { after: StateFiles.logEnd(h.state), restores: true });
  assert.deepEqual(reader.read().rows, []);
  Db.closeAll();
  StateFiles.rewriteState(h.state, (text) => text);
  h.appendEvents([message('owner', 'orchestrator', 'behind', new Date(Date.now() - 3600000).toISOString())]);
  const batch = reader.read();
  assert.deepEqual([batch.reset, batch.rows.filter((e) => !batch.restored.has(e)).map((e) => e.detail.text)], [true, ['behind']]);
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
  // A snapshot's events end where it was taken, whatever is committed later.
  const old = S.loadState(h.state, { fresh: true });
  h.appendEvents([message('owner', 'orchestrator', 'later')]);
  assert.equal(old.events.some((e) => e.detail?.text === 'later'), false);
  assert.equal(S.readEvents(h.state).at(-1).detail.text, 'later');
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

// Puts the backup in `copy` back under a running reader, and returns the
// messages it holds once the reader has read them.
async function restoreLog(h, reader, copy, { how = 'rename' } = {}) {
  const end = StateFiles.withDb(copy, () => Db.end(copy));
  let seen = reader.notices.length;
  const read = (probe) => reader.until(() => reader.notices.slice(seen).some(probe));
  await StateFiles.restore(h.state, path.join(copy, Db.FILE), {
    how,
    between: async () => {
      await read((notice) => notice.reset);
      seen = reader.notices.length;
    },
  });
  // Nothing wakes a reader for a renamed file it does not watch for; the next event does.
  await read((notice) => notice.offset === end && (how !== 'rename' || notice.reset));
  return StateFiles.withDb(copy, () => Db.eventsAfter(copy, 0).map((r) => JSON.parse(r.body)).filter((row) => row.cmd === 'msg').map((row) => row.detail.text));
}

// A backup of the state, as of now or before its last message, in its own
// state directory so it reads as one.
function backupState(h, smaller) {
  const dir = path.join(h.base, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  StateFiles.backup(h.state, path.join(dir, Db.FILE));
  if (smaller) {
    StateFiles.withDb(dir, () => {
      const { db } = Db.handle(dir);
      const last = db.prepare("SELECT pos FROM events WHERE cmd = 'msg' ORDER BY pos DESC LIMIT 1").get().pos;
      // As a backup taken a commit earlier: one commit fewer, without its message.
      db.exec(`BEGIN; DELETE FROM events WHERE pos >= ${last}; UPDATE meta SET value = (SELECT coalesce(max(pos), 0) FROM events) WHERE key = 'end';
        UPDATE meta SET value = CAST(value AS INTEGER) - 1 WHERE key = 'rev'; COMMIT`);
    });
  }
  return dir;
}

const clockBehind = path.join(__dirname, 'fixtures', 'clock-behind.js');

// New events after a restore: one from a writer whose clock is behind every
// restored record and the reader's start, then one from this host's clock.
// An older, smaller backup lacks the event the reader started after, so only
// the writer's clock is left to tell its history from new events there.
function appendAfterRestore(h, behind) {
  const ids = [];
  for (const pre of [...(behind ? [['--require', clockBehind]] : []), []]) {
    h.ok(['msg', '--to', 'orchestrator', 'after restore'], { pre, env: { CLOCK_BEHIND_MS: '600000' } });
    ids.push(h.events().at(-1));
  }
  if (behind) assert.ok(Date.parse(ids[1].at) - Date.parse(ids[0].at) > 300000, 'the first writer\'s clock must be behind');
  return ids.map((e) => e.id);
}

// A backup the same as the state is no restore at all, so a reader that
// restores one first reads an event past it. `to` keeps that event from
// waking the reader under test.
async function advance(h, reader, to) {
  h.ok(['msg', '--agent', 'worker', '--to', to, 'past the backup']);
  const end = StateFiles.logEnd(h.state);
  await reader.until(() => reader.notices.some((notice) => notice.offset === end));
}

// A restore under a running reader renames the copy over the database; a
// reader that finds the database gone refuses, as for any missing state.
// Windows refuses to replace a database another process holds open.
const restoreCases = [false, true].map((smaller) => ({ smaller, how: 'rename' }));
for (const follow of [false, true]) for (const { smaller, how } of restoreCases) {
  test(`restored history does not wake wait (follow: ${follow}, smaller: ${smaller}, restore: ${how})`, { skip: process.platform === 'win32' }, async (t) => {
    const h = restoreFixture();
    const copy = backupState(h, smaller);
    const reader = resetReader(t, h, ['wait', '--observe', '--agent', 'orchestrator',
      ...(follow ? ['--follow'] : ['--timeout', '300'])]);
    await reader.until(() => reader.notices.some((notice) => !notice.reset));
    if (!smaller) await advance(h, reader, 'owner');
    await restoreLog(h, reader, copy, { how });
    const ids = appendAfterRestore(h, !smaller);
    if (follow) {
      await reader.until(() => reader.lines().some((row) => row.id === ids.at(-1)));
      await reader.stop();
    } else {
      const [code] = await reader.closed;
      assert.equal(code, 0);
    }
    const rows = reader.lines().filter((row) => row.type !== 'ready');
    // stop() delivers SIGTERM; a follower ends with its signal stop notice, not a wake.
    if (follow) assert.deepEqual(rows.pop(), { reason: 'signal', signal: 'SIGTERM', drained: 0 });
    // A plain wait returns with the first.
    assert.deepEqual(rows.map((row) => row.id), follow ? ids : ids.slice(0, 1));
  });
}

for (const { smaller, how } of restoreCases) {
  test(`restored owner history stays queryable without SSE replay (smaller: ${smaller}, restore: ${how})`, { skip: process.platform === 'win32' }, async (t) => {
    const h = restoreFixture();
    const copy = backupState(h, smaller);
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
    if (!smaller) await advance(h, server, 'orchestrator');
    const history = await restoreLog(h, server, copy, { how });
    const restored = await fetch(new URL('/api/messages?after=0', url));
    assert.deepEqual((await restored.json()).messages.map((row) => row.detail.text), history);
    // Serve reads from the start, so every restored record is one it read.
    const ids = appendAfterRestore(h, true);
    await server.until(() => output.includes(ids.at(-1)));
    controller.abort();
    await drained;
    await server.stop();
    const wakes = output.split('\n\n').filter((block) => block.startsWith('event: wake'))
      .map((block) => JSON.parse(block.split('data: ')[1]));
    assert.deepEqual(wakes.map((wake) => wake.id), ids);
  });
}

// A state in the file layout of 0.1 with a message logged: lock recovery
// can cut a torn append off its log before this tool migrates it, and
// cursors 0.1 handed out from that log must still resolve after.
function cutFixture() {
  const h = cachedFixture(null, 'cut-events', (h) => {
    h.init();
    h.ok(['msg', '--to', 'orchestrator', 'before the cut']);
  });
  StateFiles.toFileLayout(h.state);
  return h;
}

const logFile = (h) => path.join(h.state, 'events.jsonl');
// The cuts count a 0.1 tool hands out with a cursor: the cuts file's length.
const fileCuts = (h) => fs.statSync(path.join(h.state, 'events.cuts.jsonl'), { throwIfNoEntry: false })?.size ?? 0;

// A commit that died in the middle of its append: its staged tasks.json and
// manifest are on disk, and the log holds its first line whole and the start
// of its second. The next lock holder cuts both off. Returns the log's
// length before the commit and the offset after its first line.
function tornCommit(h, first) {
  const second = message(first.agent, first.to, 'torn second');
  const fd = fs.openSync(logFile(h), 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), fs.readFileSync(path.join(h.state, 'tasks.json')));
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  const line = `${JSON.stringify(first)}\n`;
  fs.writeSync(fd, `${line}${JSON.stringify(second).slice(0, 60)}`);
  fs.closeSync(fd);
  return { size, after: size + Buffer.byteLength(line) };
}

// The cuts the migrated state records.
const recorded = (h) => StateFiles.withDb(h.state, () => parseCuts(Buffer.from(Db.legacyCuts(h.state))).cuts);

// Whether offset lies in the one recorded cut's range, where only cursors
// taken before the cut move back.
function inCut(h, offset) {
  const cuts = recorded(h);
  assert.equal(cuts.length, 1);
  return cuts[0].size < offset && offset <= cuts[0].from;
}

// Longer than the torn bytes, so the log grows past where readers stopped.
const LONG = `after the cut ${'x'.repeat(400)}`;

test('a wait cursor inside bytes recovery cut off before migration reads the events appended since', (t) => {
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

test('a holder killed after its cut and before recording it leaves the record to the next command, which migrates', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const cuts = fileCuts(h);
  const { size, after } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  const r = h.run(['msg', '--to', 'orchestrator', 'never sent'], { hooks: { HOOK_DIE_RECORDING_CUT: '1' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.equal(fs.statSync(logFile(h)).size, size, 'the log was cut');
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  assert.deepEqual(recorded(h).map((c) => c.size), [size]);
  const woke = JSON.parse(h.ok(['wait', '--agent', 'orchestrator', '--after', `${after}:${cuts}`, '--types', 'decision-opened,worker-message,msg', '--timeout', '5'])); // wait-allow: the event is already logged, so wait returns at once
  assert.equal(woke.detail.text, LONG);
});

test('a torn cut record does not swallow the next one', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const { size } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  // A record torn by a power cut.
  fs.writeFileSync(path.join(h.state, 'events.cuts.jsonl'), '{"at":"2026-10-16T00:00:00.000Z","si');
  h.ok(['msg', '--to', 'orchestrator', LONG]);
  assert.deepEqual(recorded(h).map((c) => c.size), [size]);
});

test('served messages after a cursor inside bytes recovery cut off include the messages appended since', async (t) => {
  const h = cutFixture();
  const { after } = tornCommit(h, message('w-1', 'owner', 'torn first'));
  // Shorter than the cut bytes: it ends before offsets a 0.1 page was handed.
  h.ok(['msg', '--to', 'owner', 'short', '--agent', 'w-1']);
  const server = resetReader(t, h, ['serve', '--agent', 'viewer', '--port', '0', '--json']);
  const { url } = await server.until(() => server.lines()[0]);
  const next = await (await fetch(new URL(`/api/messages?after=${after}`, url))).json();
  assert.deepEqual(next.messages.map((m) => m.detail.text), ['short']);
  const all = await (await fetch(new URL('/api/messages?after=0', url))).json();
  assert.deepEqual(all.messages.map((m) => m.detail.text), ['before the cut', 'short'], 'the cut message is gone');
  // The cursor handed out after the cut stays where it is.
  assert.ok(inCut(h, next.cursor), `cursor ${next.cursor} is inside the cut range`);
  const later = await (await fetch(new URL(`/api/messages?after=${next.cursor}&cuts=${next.cuts}`, url))).json();
  assert.deepEqual(later.messages, []);
});

// Lock recovery by a holder that logs nothing, so the test appends next.
const recover = (h) => S.withLock(h.state, () => {});

// A line as long as first, appended after the cut as a 0.1 tool appends, so
// it ends where first ended before recovery cut it off.
function sameEnd(h, first) {
  const line = { ...first, id: `E${crypto.randomUUID()}` };
  fs.appendFileSync(logFile(h), `${JSON.stringify(line)}\n`);
  return line.id;
}

test('a wait cursor that carries the cuts goes back for a cut even where a new line ends at its offset', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const first = message('worker', 'orchestrator', 'torn first');
  const cuts = fileCuts(h);
  const { after } = tornCommit(h, first);
  recover(h);
  const id = sameEnd(h, first);
  assert.equal(fs.statSync(logFile(h)).size, after, 'the new line ends where the cut one did');
  const wait = (cursor, timeout) => h.run(['wait', '--agent', 'orchestrator', '--after', cursor, '--types', 'worker-message', '--timeout', timeout]); // wait-allow: the event is logged before the first wait starts; the second must reach its timeout
  const woke = wait(`${after}:${cuts}`, '5');
  assert.equal(woke.code, 0, woke.stderr);
  const e = JSON.parse(woke.stdout);
  assert.equal(e.id, id);
  const now = StateFiles.withDb(h.state, () => Buffer.byteLength(Db.legacyCuts(h.state)));
  assert.equal(e.cursor, `${after}:${now}`);
  const again = wait(e.cursor, '0.5');
  assert.equal(again.code, 2, `the wait returned ${again.stdout}`);
  assert.equal(JSON.parse(again.stdout).cursor, e.cursor);
});

test('served messages after a cursor with its cuts include a message whose line ends where a cut one did', async (t) => {
  const h = cutFixture();
  const first = message('w-1', 'owner', 'torn first');
  const cuts = fileCuts(h);
  const { after } = tornCommit(h, first);
  recover(h);
  const id = sameEnd(h, first);
  const server = resetReader(t, h, ['serve', '--agent', 'viewer', '--port', '0', '--json']);
  const { url } = await server.until(() => server.lines()[0]);
  const next = await (await fetch(new URL(`/api/messages?after=${after}&cuts=${cuts}`, url))).json();
  assert.deepEqual(next.messages.map((m) => m.id), [id]);
  const again = await (await fetch(new URL(`/api/messages?after=${next.cursor}&cuts=${next.cuts}`, url))).json();
  assert.deepEqual(again.messages, []);
});

test('recovery records two cuts of the same length at the same place, and a cursor from before both reads on from there', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const cuts = fileCuts(h);
  const { size, after } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  recover(h);
  tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  recover(h);
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', LONG]);
  assert.deepEqual(recorded(h).map((c) => c.size), [size, size]);
  const woke = JSON.parse(h.ok(['wait', '--agent', 'orchestrator', '--after', `${after}:${cuts}`, '--types', 'worker-message', '--timeout', '5'])); // wait-allow: the event is already logged, so wait returns at once
  assert.equal(woke.detail.text, LONG);
});

test('a cut an older tool finished recovering is recorded late, and moves only a cursor that ended a line it removed', (t) => {
  const h = cutFixture();
  t.after(h.cleanup);
  const { size, after } = tornCommit(h, message('owner', 'orchestrator', 'torn first'));
  const r = h.run(['msg', '--to', 'orchestrator', 'never sent'], { hooks: { HOOK_DIE_RECORDING_CUT: '1' } });
  assert.notEqual(r.code, 0, 'the holder was killed');
  assert.equal(fs.statSync(logFile(h)).size, size, 'the log was cut');
  // A tool from before cut records finishes the recovery its way: it removes
  // the staged files and the manifest, then appends its own event.
  for (const name of fs.readdirSync(h.state)) {
    if (/^(tasks\.json\.E[0-9a-f-]+\.commit|commit\.E[0-9a-f-]+\.json)$/.test(name)) fs.unlinkSync(path.join(h.state, name));
  }
  fs.appendFileSync(logFile(h), `${JSON.stringify(message('worker', 'orchestrator', LONG))}\n`);
  const older = fs.statSync(logFile(h)).size;
  h.ok(['msg', '--agent', 'worker', '--to', 'orchestrator', 'after the older tool']);
  const cuts = recorded(h);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].late, true);
  assert.deepEqual(fs.readdirSync(h.state).filter((name) => name.startsWith('cut.')), []);
  const wait = (cursor) => JSON.parse(h.ok(['wait', '--agent', 'orchestrator', '--after', cursor, '--types', 'worker-message', '--timeout', '5'])).detail.text; // wait-allow: the event is already logged, so wait returns at once
  // A cursor that ended the cut line reads from the cut; one the older tool handed out after it stays.
  assert.equal(wait(String(after)), LONG);
  assert.equal(wait(String(older)), 'after the older tool');
});
