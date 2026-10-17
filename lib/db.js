'use strict';

// Tower Crane state in one SQLite database, state.db in the state directory:
// the project, the decisions and the tasks file's envelope as documents, one
// row per task, one row per event and an inbox of messages not yet delivered
// by a hook. WAL with synchronous=FULL syncs the log before a commit returns.
// Each process opens the database itself and keeps the connection until it
// exits; nothing serves it. The schema is in docs/state.md.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = 'state.db';
// The layout of the tables below. A change that older tools of the same
// project schema cannot read raises it, and they refuse the database.
const LAYOUT = 1;
// How long a statement waits on a lock another connection holds: writers
// already queue on the state lock, so only a checkpoint or a reader rebuilding
// the WAL index after a crash is left to wait for, and those are short.
const BUSY_MS = 10000;

const TABLES = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE docs(name TEXT PRIMARY KEY, body TEXT NOT NULL, rev INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE tasks(id TEXT PRIMARY KEY, ord INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, rev INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX tasks_ord ON tasks(ord);
CREATE INDEX tasks_rev ON tasks(rev);
CREATE TABLE events(pos INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, agent TEXT, cmd TEXT NOT NULL, task TEXT, recipient TEXT, body TEXT NOT NULL);
CREATE INDEX events_task ON events(task, pos);
CREATE INDEX events_cmd ON events(cmd, pos);
CREATE TABLE inbox(pos INTEGER PRIMARY KEY, agent TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX inbox_pending ON inbox(agent, pos) WHERE delivered = 0;
CREATE TABLE legacy_lines(pos INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
`;

let sqlite;
function driver() {
  if (!sqlite) {
    // Node 24 marks node:sqlite experimental and warns on its first load,
    // which would print on every command's stderr.
    const emit = process.emitWarning;
    process.emitWarning = function (warning, ...rest) {
      const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
      if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return undefined;
      return emit.call(this, warning, ...rest);
    };
    try {
      sqlite = require('node:sqlite');
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite;
}

const file = (dir) => path.join(dir, FILE);

function identity(target) {
  const st = fs.statSync(target, { bigint: true, throwIfNoEntry: false });
  return st ? `${st.dev}:${st.ino}` : null;
}

// A read-only directory (a sandboxed agent's view of the state) can read a WAL
// database only while its -wal and -shm files exist. A connection that closes
// last deletes them, so writers never close: the process exit leaves both for
// the next reader. One that finds them gone, in the moment before another
// process opens the database, retries.
const READONLY_RETRY_MS = 2000;

const handles = new Map();
// Node closes every open database when a process ends on its own, and the
// last close deletes both files. A process still holding a connection when
// its work is done ends with process.exit instead, which leaves them: exit
// listeners still run, and its output is already written. It also skips the
// checkpoint a close runs; the next commit over 1000 pages of log runs one.
process.on('beforeExit', () => {
  if (handles.size) process.exit();
});

function connect(dir) {
  const { DatabaseSync } = driver();
  const deadline = Date.now() + READONLY_RETRY_MS;
  for (;;) {
    const db = new DatabaseSync(file(dir), { timeout: BUSY_MS });
    try {
      // fullfsync makes macOS flush the drive's cache, as Node's own file sync
      // does there; other platforms ignore it.
      db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON');
      const layout = db.prepare("SELECT value FROM meta WHERE key = 'layout'").get()?.value;
      if (Number(layout) !== LAYOUT) {
        throw Object.assign(new Error(`${file(dir)} has table layout ${layout}; this tool reads layout ${LAYOUT}; upgrade Tower Crane before reading or writing this project`), { code: 1, stateIncompatible: true });
      }
      return db;
    } catch (e) {
      try { db.close(); } catch { /* not open */ }
      if (!/readonly|read-only/i.test(e.message) || Date.now() > deadline) throw e;
      require('./util').sleepSync(10);
    }
  }
}

// The connection for dir, opened on first use. A database replaced since
// (restored from a copy, or the state directory removed and made again) gets
// a new one.
function handle(dir) {
  const key = path.resolve(dir);
  const id = identity(file(key));
  if (id === null) return null;
  let h = handles.get(key);
  if (h && h.id === id) return h;
  const db = connect(key);
  h = { db, dir: key, id, stmts: new Map() };
  handles.set(key, h);
  h.uid = get(h, "SELECT value FROM meta WHERE key = 'uid'").value;
  return h;
}

// Closes this process's connection to dir. The CLI never does (see
// READONLY_RETRY_MS); a test process does, so Windows can remove the fixture.
function close(dir) {
  const key = path.resolve(dir);
  const h = handles.get(key);
  if (!h) return;
  handles.delete(key);
  h.db.close();
}

// Closes every connection of this process, as a test does before it removes
// its fixtures.
function closeAll() {
  for (const key of [...handles.keys()]) close(key);
}

function stmt(h, sql) {
  let s = h.stmts.get(sql);
  if (!s) {
    s = h.db.prepare(sql);
    h.stmts.set(sql, s);
  }
  return s;
}

const get = (h, sql, ...args) => stmt(h, sql).get(...args);
const all = (h, sql, ...args) => stmt(h, sql).all(...args);
const run = (h, sql, ...args) => stmt(h, sql).run(...args);

// Each read and write passes named steps, which test fixtures listen for to
// stop or kill a process there (test/fixtures/hooks.js). A process event
// reaches every copy of this module, including a supervisor's pinned one.
const STEP = 'tower-crane:state-step';
const reached = (step, dir) => process.emit(STEP, step, dir);

function transaction(h, mode, fn) {
  h.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  let done = false;
  try {
    const out = fn();
    if (mode === 'write') reached('commit', h.dir);
    h.db.exec('COMMIT');
    done = true;
    reached(mode === 'write' ? 'committed' : 'read', h.dir);
    return out;
  } finally {
    if (!done && h.db.isTransaction) h.db.exec('ROLLBACK');
  }
}

function meta(h, key) {
  return get(h, 'SELECT value FROM meta WHERE key = ?', key)?.value;
}

// The database's own counters: `rev` counts commits, and every document and
// task row records the commit that last wrote it, so a reader catches up on
// what changed since its snapshot. `end` is the event cursor after the last
// event, counted in bytes as the file layout counted its log.
function counters(h) {
  return { rev: Number(meta(h, 'rev')), end: Number(meta(h, 'end')) };
}

// Everything a snapshot holds, in one read transaction.
function snapshot(dir) {
  const h = handle(dir);
  return transaction(h, 'read', () => ({
    ...counters(h),
    uid: h.uid,
    docs: Object.fromEntries(all(h, 'SELECT name, body FROM docs').map((r) => [r.name, r.body])),
    tasks: all(h, 'SELECT id, ord, body FROM tasks ORDER BY ord'),
  }));
}

// What changed after commit `rev`: the documents and task rows written since,
// and the counters now.
function since(dir, rev) {
  const h = handle(dir);
  return transaction(h, 'read', () => {
    const now = counters(h);
    if (now.rev === rev) return { ...now, uid: h.uid, docs: {}, tasks: [] };
    return {
      ...now,
      uid: h.uid,
      docs: Object.fromEntries(all(h, 'SELECT name, body FROM docs WHERE rev > ?', rev).map((r) => [r.name, r.body])),
      tasks: all(h, 'SELECT id, ord, body FROM tasks WHERE rev > ? ORDER BY ord', rev),
    };
  });
}

function uid(dir) {
  return handle(dir).uid;
}

function rev(dir) {
  return counters(handle(dir)).rev;
}

// The cursor after the last event.
function end(dir) {
  const h = handle(dir);
  return h ? counters(h).end : 0;
}

// Event rows after cursor `after`, through `upto` when given, in order.
function eventsAfter(dir, after = 0, upto = null) {
  const h = handle(dir);
  if (!h) return [];
  const rows = upto === null
    ? all(h, 'SELECT pos, body FROM events WHERE pos > ? ORDER BY pos', after)
    : all(h, 'SELECT pos, body FROM events WHERE pos > ? AND pos <= ? ORDER BY pos', after, upto);
  reached('events', h.dir);
  return rows;
}

function eventById(dir, id) {
  const h = handle(dir);
  return h ? get(h, 'SELECT pos, body FROM events WHERE id = ?', id) ?? null : null;
}

function lastEvent(dir) {
  const h = handle(dir);
  return h ? get(h, 'SELECT pos, body FROM events ORDER BY pos DESC LIMIT 1') ?? null : null;
}

// Messages to agent that no hook of that agent delivered yet.
function undelivered(dir, agent) {
  const h = handle(dir);
  if (!h) return [];
  return all(h, 'SELECT e.pos, e.body FROM inbox i JOIN events e ON e.pos = i.pos WHERE i.agent = ? AND i.delivered = 0 ORDER BY i.pos', agent);
}

// Whether a line of the log ends at pos: an event, or a line migration kept
// from the file layout (an older tool's progress, a torn record).
function endsLine(dir, pos) {
  const h = handle(dir);
  if (!h || pos <= 0) return false;
  return !!get(h, 'SELECT 1 FROM events WHERE pos = ?', pos) || !!get(h, 'SELECT 1 FROM legacy_lines WHERE pos = ?', pos);
}

// The id of the event whose line ends at pos, or null.
function idEndingAt(dir, pos) {
  const h = handle(dir);
  return h ? get(h, 'SELECT id FROM events WHERE pos = ?', pos)?.id ?? null : null;
}

// events.cuts.jsonl as migration found it. No cut happens after migration,
// so its length is the cuts count every later cursor carries.
function legacyCuts(dir) {
  const h = handle(dir);
  return h ? meta(h, 'cuts_file') ?? '' : '';
}

// What a migration still has to move: `dir`, relative to the state, where
// the file layout goes, and `project`, the project.json text the marker
// replaced; null once it is done.
function legacy(dir) {
  const h = handle(dir);
  const value = h ? meta(h, 'legacy') : undefined;
  return value === undefined ? null : JSON.parse(value);
}

function markMoved(dir) {
  const h = handle(dir);
  transaction(h, 'write', () => run(h, "DELETE FROM meta WHERE key = 'legacy'"));
}

function hasTask(dir, id) {
  const h = handle(dir);
  return !!h && !!get(h, 'SELECT 1 FROM tasks WHERE id = ?', id);
}

// A line's length in the log, with its newline.
const lineBytes = (body) => Buffer.byteLength(body) + 1;

// One transaction: the documents and task rows that changed, then the
// events, each at the cursor after the one before. Returns the counters
// after it.
function commit(dir, { docs = {}, tasks = [], events = [], drop = [] }) {
  const h = handle(dir);
  return transaction(h, 'write', () => {
    const before = counters(h);
    const next = before.rev + 1;
    for (const [name, body] of Object.entries(docs)) {
      run(h, 'INSERT INTO docs(name, body, rev) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, rev = excluded.rev', name, body, next);
    }
    for (const t of tasks) {
      run(h, 'INSERT INTO tasks(id, ord, status, body, rev) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, status = excluded.status, body = excluded.body, rev = excluded.rev',
        t.id, t.ord, t.status, t.body, next);
    }
    for (const id of drop) run(h, 'DELETE FROM tasks WHERE id = ?', id);
    let at = before.end;
    for (const e of events) {
      const body = JSON.stringify(e);
      at += lineBytes(body);
      insertEvent(h, e, at, body);
    }
    run(h, "UPDATE meta SET value = ? WHERE key = 'rev'", String(next));
    run(h, "UPDATE meta SET value = ? WHERE key = 'end'", String(at));
    return { rev: next, end: at };
  });
}

function insertEvent(h, e, pos, body) {
  run(h, 'INSERT INTO events(pos, id, at, agent, cmd, task, recipient, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    pos, e.id, String(e.at ?? ''), e.agent ?? null, e.cmd, e.task ?? null, e.to ?? null, body);
  if (e.cmd === 'msg' && typeof e.detail?.to === 'string') run(h, 'INSERT INTO inbox(pos, agent) VALUES (?, ?)', pos, e.detail.to);
  if (e.cmd === 'hook inbox' && Array.isArray(e.detail?.messages)) {
    for (const id of e.detail.messages) {
      if (typeof id === 'string') run(h, 'UPDATE inbox SET delivered = 1 WHERE agent = ? AND pos = (SELECT pos FROM events WHERE id = ?)', e.agent, id);
    }
  }
}

// Builds a database from a file layout at `target` and syncs it. `log` is
// the bytes of events.jsonl and `parse` returns the event a line holds, or
// null for a line that is not one (an older tool's progress, a torn record).
// Lines that are not events are kept, so an export writes the log back byte
// for byte and every byte cursor taken from it still names the same place.
function build(target, { docs, tasks, log, cuts, parse, legacy = null }) {
  const { DatabaseSync } = driver();
  fs.rmSync(target, { force: true });
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true });
  const db = new DatabaseSync(target);
  try {
    // Nothing reads this file until it is renamed into place, synced, so
    // the build skips the per-statement syncs.
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
    db.exec('BEGIN');
    db.exec(TABLES);
    const h = { db, stmts: new Map() };
    const metaRow = (key, value) => run(h, 'INSERT INTO meta(key, value) VALUES (?, ?)', key, String(value));
    for (const [name, body] of Object.entries(docs)) run(h, 'INSERT INTO docs(name, body, rev) VALUES (?, ?, 1)', name, body);
    tasks.forEach((t, ord) => run(h, 'INSERT INTO tasks(id, ord, status, body, rev) VALUES (?, ?, ?, ?, 1)', t.id, ord, t.status, t.body));
    // Positions come from the bytes, so a torn multibyte fragment cannot move
    // a later line's cursor. A final fragment without its newline is ended as
    // the next append of the file layout would end it.
    let at = 0;
    for (let from = 0; from < log.length;) {
      let nl = log.indexOf(10, from);
      if (nl === -1) nl = log.length;
      const raw = log.subarray(from, nl);
      from = nl + 1;
      at += raw.length + 1;
      const line = raw.toString('utf8');
      let e = null;
      try {
        // A line that does not decode to the same bytes is not one a tool wrote.
        if (Buffer.byteLength(line) === raw.length) e = parse(line);
      } catch {
        // A torn record, kept as a line.
      }
      if (e && typeof e.id === 'string' && typeof e.cmd === 'string' && !get(h, 'SELECT 1 FROM events WHERE id = ?', e.id)) {
        insertEvent(h, e, at, line);
      } else {
        run(h, 'INSERT INTO legacy_lines(pos, bytes) VALUES (?, ?)', at, raw);
      }
    }
    metaRow('layout', LAYOUT);
    metaRow('uid', crypto.randomUUID());
    metaRow('rev', 1);
    metaRow('end', at);
    metaRow('cuts', cuts.length);
    metaRow('cuts_file', cuts.toString('utf8'));
    // Where a migration moves the files it read, with the project.json its
    // marker replaces; cleared once they are there.
    if (legacy) metaRow('legacy', JSON.stringify(legacy));
    metaRow('created', JSON.stringify({ at: new Date().toISOString(), migrated: !!legacy, log_bytes: log.length, cuts_bytes: cuts.length }));
    db.exec('COMMIT');
    db.exec('PRAGMA journal_mode=WAL');
  } finally {
    db.close();
  }
  const fd = fs.openSync(target, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// The file layout a 0.1 tool reads: the documents and task rows as written,
// and events.jsonl and events.cuts.jsonl as migration found them followed by
// every event since, each line ending at its cursor.
function exportTo(dir, write) {
  const h = handle(dir);
  return transaction(h, 'read', () => {
    const docs = Object.fromEntries(all(h, 'SELECT name, body FROM docs').map((r) => [r.name, r.body]));
    const tasks = all(h, 'SELECT body FROM tasks ORDER BY ord').map((r) => r.body);
    write.docs(docs, tasks);
    const events = stmt(h, 'SELECT pos, body FROM events ORDER BY pos').iterate();
    const legacy = stmt(h, 'SELECT pos, bytes FROM legacy_lines ORDER BY pos').iterate();
    let e = events.next();
    let l = legacy.next();
    let at = 0;
    while (!e.done || !l.done) {
      const takeLegacy = e.done || (!l.done && l.value.pos < e.value.pos);
      const row = takeLegacy ? l.value : e.value;
      const line = takeLegacy ? Buffer.from(row.bytes) : Buffer.from(row.body);
      at += line.length + 1;
      if (at !== row.pos) throw new Error(`event log export reached ${at} where the line at ${row.pos} ends; the database does not hold a whole log`);
      write.line(line);
      if (takeLegacy) l = legacy.next();
      else e = events.next();
    }
    write.cuts(meta(h, 'cuts_file') ?? '');
    return { end: at };
  });
}

module.exports = {
  FILE, LAYOUT, file, handle, close, closeAll, snapshot, since, uid, rev, end, eventsAfter, eventById, lastEvent, undelivered, endsLine, idEndingAt,
  legacyCuts, legacy, markMoved, hasTask, commit, build, exportTo, STEP,
};
