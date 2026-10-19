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
CREATE TABLE tasks(id TEXT PRIMARY KEY, ord INTEGER NOT NULL, status TEXT NOT NULL, head TEXT NOT NULL, rev INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE task_bulk(id TEXT PRIMARY KEY, rev INTEGER NOT NULL, bulk TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX tasks_ord ON tasks(ord);
CREATE INDEX tasks_rev ON tasks(rev);
CREATE TABLE events(pos INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, agent TEXT, cmd TEXT NOT NULL, task TEXT, recipient TEXT, reach INTEGER, body TEXT NOT NULL);
CREATE INDEX events_task ON events(task, pos);
CREATE INDEX events_cmd ON events(cmd, pos);
CREATE INDEX events_agent ON events(agent, cmd, pos);
CREATE INDEX events_reach ON events(reach) WHERE reach IS NOT NULL;
CREATE INDEX events_spawned ON events(json_extract(body, '$.detail.agent'), pos) WHERE cmd IN ('spawn', 'spawn retry', 'spawn fallback');
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

// The fields a task row keeps apart from the rest of the task, in task_bulk:
// they hold most of its bytes (every evidence entry, note and spend entry),
// and most commands read them for one task or none. Kept in their own table,
// they leave the heads on pages of their own, which every command reads.
// `head` is the task with each of them that it has replaced by 0, in its
// place, so a join keeps the key order.
const BULK = ['evidence', 'notes', 'spend'];

function split(task) {
  const head = {};
  const bulk = {};
  for (const key of Object.keys(task)) {
    if (BULK.includes(key)) {
      head[key] = 0;
      bulk[key] = task[key];
    } else {
      head[key] = task[key];
    }
  }
  return { head: JSON.stringify(head), bulk: JSON.stringify(bulk) };
}

function join(head, bulk) {
  const task = JSON.parse(head);
  return Object.assign(task, JSON.parse(bulk));
}

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
      // A database restored from a copy that is not in WAL mode returns to it
      // with the first process that can write it.
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') {
        try { db.exec('PRAGMA journal_mode=WAL'); } catch { /* a reader that cannot write */ }
      }
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

// Connections to a database file since replaced. They stay open and
// referenced: a close would checkpoint into the old file and delete the
// -wal and -shm by name, which now belong to the new one.
const replaced = [];

// The connection for dir, opened on first use. A database replaced since
// (restored from a copy, or the state directory removed and made again) gets
// a new one.
function handle(dir) {
  const key = path.resolve(dir);
  const id = identity(file(key));
  if (id === null) return null;
  let h = handles.get(key);
  if (h && h.id === id) return h;
  if (h) replaced.push(h);
  const db = connect(key);
  // `views` are the connections views use (openView), open or idle.
  h = { db, dir: key, id, stmts: new Map(), views: [], idle: [] };
  handles.set(key, h);
  h.uid = get(h, "SELECT value FROM meta WHERE key = 'uid'").value;
  return h;
}

// What runs before a close: lib/state.js gives the rows its views hold
// their bulk, so nothing it handed out reads a closed connection.
const closing = [];
const onClose = (fn) => closing.push(fn);

// Closes this process's connection to dir. The CLI never does (see
// READONLY_RETRY_MS); a test process does, so Windows can remove the fixture.
function close(dir) {
  const key = path.resolve(dir);
  const h = handles.get(key);
  if (!h) return;
  for (const fn of closing) fn(key);
  handles.delete(key);
  for (const conn of h.views) conn.db.close();
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
const reached = (step, dir, rows) => process.emit(STEP, step, dir, rows);

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

const taskRows = (bulk, where) => (bulk
  ? `SELECT t.id, t.ord, t.rev, t.head, b.bulk FROM tasks t JOIN task_bulk b ON b.id = t.id ${where.replaceAll('rev', 't.rev')} ORDER BY t.ord`
  : `SELECT id, ord, rev, head FROM tasks ${where} ORDER BY ord`);

// Everything a snapshot holds, in one read transaction, or in a view's.
// Without `bulk`, task rows come without their bulk, read later with
// taskBulk: by a holder of the state lock, which no commit can come between,
// or through the view the snapshot was read in.
function snapshot(dir, { bulk = true, view = null } = {}) {
  const h = view ? view.h : handle(dir);
  const read = (c) => ({
    ...counters(c),
    uid: h.uid,
    docs: Object.fromEntries(all(c, 'SELECT name, body FROM docs').map((r) => [r.name, r.body])),
    tasks: all(c, taskRows(bulk, '')),
  });
  let out;
  if (view) {
    out = read(view.conn);
    reached('read', h.dir);
  } else {
    out = transaction(h, 'read', () => read(h));
  }
  reached('snapshot', h.dir, out.tasks.length);
  return out;
}

// What changed after commit `rev`: the documents and task rows written since,
// and the counters now.
function since(dir, rev, { bulk = true } = {}) {
  const h = handle(dir);
  return transaction(h, 'read', () => {
    const now = counters(h);
    if (now.rev === rev) return { ...now, uid: h.uid, docs: {}, tasks: [] };
    return {
      ...now,
      uid: h.uid,
      docs: Object.fromEntries(all(h, 'SELECT name, body FROM docs WHERE rev > ?', rev).map((r) => [r.name, r.body])),
      tasks: all(h, taskRows(bulk, 'WHERE rev > ?'), rev),
    };
  });
}

// One task row with its bulk, and the documents and counters, in one read
// transaction; null when no task has that id.
function taskRow(dir, id) {
  const h = handle(dir);
  return transaction(h, 'read', () => {
    const row = get(h, 'SELECT t.id, t.ord, t.rev, t.head, b.bulk FROM tasks t JOIN task_bulk b ON b.id = t.id WHERE t.id = ?', id);
    return row ? { ...counters(h), uid: h.uid, row } : null;
  });
}

// The bulk of task id as commit `rev` wrote it: every write of a row gives it
// the commit's number, so that pair names one text. A row another writer
// replaced since is read through `view`, a view that holds that commit.
function taskBulk(dir, id, rev, view = null) {
  const h = view ? view.h : handle(dir);
  const sql = 'SELECT bulk FROM task_bulk WHERE id = ? AND rev = ?';
  const row = get(h, sql, id, rev) ?? (view && get(view.conn, sql, id, rev));
  if (!row) throw new Error(`task ${id} was rewritten after commit ${rev}, and this process holds no read of that commit`);
  return row.bulk;
}

// A view: a read transaction kept open on a connection of its own, so rows a
// snapshot left unread stay readable as of its commit, whatever commits come
// after, until closeView. A reader takes its snapshot in one; a holder of the
// state lock opens one after its last commit, so a command can read its rows
// after it releases the lock, such as to print its result.
function openView(dir) {
  const h = handle(dir);
  let conn = h.idle.pop();
  if (!conn) {
    conn = { db: connect(h.dir), stmts: new Map() };
    h.views.push(conn);
  }
  conn.db.exec('BEGIN');
  // A read transaction takes its snapshot at its first read.
  return { h, conn, ...counters(conn) };
}

// Tasks whose bulk a commit after `rev` wrote.
function bulkSince(dir, rev) {
  return all(handle(dir), 'SELECT id FROM task_bulk WHERE rev > ?', rev).map((r) => r.id);
}

function closeView(view) {
  if (!view.conn.db.isOpen || !view.conn.db.isTransaction) return;
  view.conn.db.exec('COMMIT');
  view.h.idle.push(view.conn);
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
  reached('events', h.dir, rows.length);
  return rows;
}

// Events of task id through cursor `upto`, in order; only those of the
// commands `cmds` when given.
function taskEvents(dir, id, upto, cmds = null) {
  const h = handle(dir);
  if (!h) return [];
  const rows = cmds
    ? all(h, `SELECT pos, body FROM events WHERE task = ? AND pos <= ? AND cmd IN (${cmds.map(() => '?').join(', ')}) ORDER BY pos`, id, upto, ...cmds)
    : all(h, 'SELECT pos, body FROM events WHERE task = ? AND pos <= ? ORDER BY pos', id, upto);
  reached('events', h.dir, rows.length);
  return rows;
}

// Events agent logged with command cmd, in order.
function agentEvents(dir, agent, cmd) {
  const h = handle(dir);
  if (!h) return [];
  const rows = all(h, 'SELECT pos, body FROM events WHERE agent = ? AND cmd = ? ORDER BY pos', agent, cmd);
  reached('events', h.dir, rows.length);
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

// The roles agent was started as, in order, from its spawn events.
function spawnRoles(dir, agent) {
  const h = handle(dir);
  if (!h) return [];
  // The terms match the events_spawned index.
  return all(h, `SELECT json_extract(body, '$.detail.role') AS role FROM events WHERE json_extract(body, '$.detail.agent') = ?
    AND cmd IN ('spawn', 'spawn retry', 'spawn fallback') ORDER BY pos`, agent).map((r) => r.role);
}

// Messages to agent that no hook of that agent delivered yet.
function undelivered(dir, agent) {
  const h = handle(dir);
  if (!h) return [];
  return all(h, 'SELECT e.pos, e.body FROM inbox i JOIN events e ON e.pos = i.pos WHERE i.agent = ? AND i.delivered = 0 ORDER BY i.pos', agent);
}

function hasUndelivered(dir, agent) {
  const h = handle(dir);
  return !!h && !!get(h, 'SELECT 1 FROM inbox WHERE agent = ? AND delivered = 0 LIMIT 1', agent);
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
      run(h, 'INSERT INTO tasks(id, ord, status, head, rev) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, status = excluded.status, head = excluded.head, rev = excluded.rev',
        t.id, t.ord, t.status, t.head, next);
      run(h, 'INSERT INTO task_bulk(id, rev, bulk) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, bulk = excluded.bulk', t.id, next, t.bulk);
    }
    for (const id of drop) {
      run(h, 'DELETE FROM tasks WHERE id = ?', id);
      run(h, 'DELETE FROM task_bulk WHERE id = ?', id);
    }
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

// How late, in ms, an event can keep an unclaimed worker's slot held
// (reservations in tasks.js): a reserved worker spawn or an active worker
// interrupt holds one from its time, and a monitor's record extends one past
// its time by any backoff it schedules. Any slot still held now has an event
// whose reach is within one lease of now, so only those tasks' events are
// folded. Null for an event that holds nothing.
function reach(e) {
  const d = e.detail || {};
  const holds = e.cmd === 'spawn' ? d.role === 'worker' && d.reserved === true && !d.claim_since
    : e.cmd === 'interrupt' ? d.role === 'worker' && !!d.active
      : ['spawn retry', 'spawn fallback', 'spawn phase'].includes(e.cmd);
  const at = Date.parse(e.at);
  if (!holds || !Number.isFinite(at)) return null;
  return at + (e.cmd === 'spawn phase' && Number.isFinite(d.backoff_ms) ? Math.max(0, d.backoff_ms) : 0);
}

// Tasks with an event through cursor `upto` whose reach is after `after`.
function slotTasks(dir, after, upto) {
  const h = handle(dir);
  if (!h) return [];
  return all(h, 'SELECT DISTINCT task FROM events WHERE reach > ? AND pos <= ? AND task IS NOT NULL', after, upto).map((r) => r.task);
}

function insertEvent(h, e, pos, body) {
  run(h, 'INSERT INTO events(pos, id, at, agent, cmd, task, recipient, reach, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    pos, e.id, String(e.at ?? ''), e.agent ?? null, e.cmd, e.task ?? null, e.to ?? null, reach(e), body);
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
    tasks.forEach((t, ord) => {
      run(h, 'INSERT INTO tasks(id, ord, status, head, rev) VALUES (?, ?, ?, ?, 1)', t.id, ord, t.status, t.head);
      run(h, 'INSERT INTO task_bulk(id, rev, bulk) VALUES (?, 1, ?)', t.id, t.bulk);
    });
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
    const tasks = all(h, taskRows(true, '')).map((r) => join(r.head, r.bulk));
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
  FILE, LAYOUT, BULK, file, split, join, handle, close, closeAll, onClose, snapshot, since, taskRow, taskBulk, openView, closeView, bulkSince, spawnRoles, uid, rev, end, eventsAfter, taskEvents, agentEvents, slotTasks, reach, eventById, lastEvent,
  undelivered, hasUndelivered, endsLine, idEndingAt, legacyCuts, legacy, markMoved, hasTask, commit, build, exportTo, STEP,
};
