'use strict';
// B: SQLite in WAL mode with synchronous=FULL, so every commit fsyncs the WAL
// before it returns. One row per task, one row per event, and an inbox table
// with a partial index over undelivered messages, so a hook poll is an index
// lookup instead of a log scan.
const { DatabaseSync } = require('node:sqlite');
const M = require('./model');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, at TEXT, agent TEXT, cmd TEXT, task TEXT, to_agent TEXT, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events(task, seq);
CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY, agent TEXT NOT NULL, id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(agent) WHERE delivered = 0;
`;

function open(cfg) {
  const db = new DatabaseSync(cfg.db);
  // The busy timeout comes first: even the journal_mode pragma can meet a busy lock.
  db.exec('PRAGMA busy_timeout=60000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const h = { db, cfg, st: {} };
  const prep = (k, sql) => { h.st[k] = db.prepare(sql); };
  prep('task', 'SELECT body FROM tasks WHERE id = ?');
  prep('putTask', 'UPDATE tasks SET body = ? WHERE id = ?');
  prep('event', 'INSERT INTO events(id, at, agent, cmd, task, to_agent, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
  prep('inboxAdd', 'INSERT INTO inbox(seq, agent, id, delivered) VALUES (?, ?, ?, 0)');
  prep('pending', 'SELECT seq, id FROM inbox WHERE agent = ? AND delivered = 0');
  prep('deliver', 'UPDATE inbox SET delivered = 1 WHERE agent = ? AND delivered = 0 AND seq <= ?');
  return h;
}

function insertEvent(h, e, line = JSON.stringify(e)) {
  const r = h.st.event.run(e.id, e.at, e.agent, e.cmd, e.task, e.to || null, line);
  const seq = Number(r.lastInsertRowid);
  if (e.cmd === 'msg' && e.detail?.to) h.st.inboxAdd.run(seq, e.detail.to, e.id);
  return seq;
}

function tx(h, fn) {
  h.db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    h.db.exec('COMMIT');
    return r;
  } catch (e) {
    h.db.exec('ROLLBACK');
    throw e;
  }
}

function transition(h, taskId, agent, kind, args) {
  return tx(h, () => {
    const row = h.st.task.get(taskId);
    const task = row && JSON.parse(row.body);
    const e = M.plan(task, agent, kind, args);
    M.apply(task, e);
    h.st.putTask.run(JSON.stringify(task), taskId);
    insertEvent(h, e);
    return { id: e.id };
  });
}

function send(h, from, to, taskId, text) {
  return tx(h, () => {
    const e = M.event(from, 'msg', taskId, { to, text });
    insertEvent(h, e);
    return { id: e.id };
  });
}

function hook(h, agent, taskId) {
  const row = h.st.task.get(taskId);
  const task = row && JSON.parse(row.body);
  if (!task || task.status === 'cancelled') return { delivered: 0, stale: true };
  if (!h.st.pending.all(agent).length) return { delivered: 0 };
  return tx(h, () => {
    const rows = h.st.pending.all(agent);
    if (!rows.length) return { delivered: 0 };
    insertEvent(h, M.event(agent, 'hook inbox', taskId, { messages: rows.map((r) => r.id) }));
    h.st.deliver.run(agent, Math.max(...rows.map((r) => Number(r.seq))));
    return { delivered: rows.length };
  });
}

function replay(h, from) {
  let count = 0;
  for (const r of h.db.prepare('SELECT seq, body FROM events WHERE seq > ? ORDER BY seq').iterate(from)) {
    JSON.parse(r.body);
    count++;
  }
  return { count };
}

function offsetBack(h, n) {
  const r = h.db.prepare('SELECT max(seq) AS m FROM events').get();
  return Math.max(0, Number(r.m) - n);
}

function verify(h) {
  const doc = { tasks: h.db.prepare('SELECT body FROM tasks').all().map((r) => JSON.parse(r.body)) };
  const events = [];
  let bad = 0;
  for (const r of h.db.prepare("SELECT body FROM events WHERE cmd IN ('task note', 'msg', 'hook inbox') ORDER BY seq").iterate()) {
    try { events.push(JSON.parse(r.body)); } catch { bad++; }
  }
  const out = require('./files').tokensFrom(events, doc);
  const expect = M.inboxFrom(events);
  const have = new Map();
  for (const r of h.db.prepare('SELECT agent, id FROM inbox WHERE delivered = 0').iterate()) {
    if (!have.has(r.agent)) have.set(r.agent, new Set());
    have.get(r.agent).add(r.id);
  }
  out.inboxMismatch = mismatch(expect, have);
  out.badLines = bad;
  out.integrity = h.db.prepare('PRAGMA quick_check').get().quick_check;
  return out;
}

function mismatch(expect, have) {
  let n = 0;
  const agents = new Set([...expect.keys(), ...have.keys()]);
  for (const a of agents) {
    const e = new Set(expect.get(a)?.keys() || []);
    const h = have.get(a) || new Set();
    for (const id of e) if (!h.has(id)) n++;
    for (const id of h) if (!e.has(id)) n++;
  }
  return n;
}

// Builds a database from a T254 state directory: tasks.json rows and every
// event line as written, so replay returns the same records.
function importState(dbFile, tasksDoc, eventLines) {
  const init = new DatabaseSync(dbFile);
  init.exec('PRAGMA journal_mode=WAL;');
  init.exec(SCHEMA);
  init.close();
  const h = open({ db: dbFile });
  const db = h.db;
  db.exec('PRAGMA synchronous=OFF');
  db.exec('BEGIN');
  const { tasks, ...meta } = tasksDoc;
  db.prepare('INSERT INTO meta(k, v) VALUES (?, ?)').run('tasks_meta', JSON.stringify(meta));
  const put = db.prepare('INSERT INTO tasks(id, body) VALUES (?, ?)');
  for (const t of tasks) put.run(t.id, JSON.stringify(t));
  const pending = new Map();
  const markDelivered = [];
  for (const line of eventLines) {
    let e;
    // Legacy tool-progress lines stay in A's log only so byte cursors hold;
    // a migration keeps the state events, which is all A's readers keep too.
    try { e = require('./files').parseEvent(line); } catch { continue; }
    if (!e) continue;
    h.st.event.run(e.id, e.at, e.agent, e.cmd, e.task ?? null, e.to ?? null, line);
    M.foldInbox(pending, e);
    if (e.cmd === 'msg' && e.detail?.to) markDelivered.push(e);
  }
  // Inbox rows carry the event's seq, so they are added after the log.
  const seqOf = db.prepare('SELECT seq FROM events WHERE id = ?');
  const add = db.prepare('INSERT INTO inbox(seq, agent, id, delivered) VALUES (?, ?, ?, ?)');
  for (const e of markDelivered) {
    const still = pending.get(e.detail.to)?.has(e.id);
    add.run(Number(seqOf.get(e.id).seq), e.detail.to, e.id, still ? 0 : 1);
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function close(h) {
  h.db.close();
}

module.exports = { open, transition, send, hook, replay, offsetBack, verify, importState, insertEvent, mismatch, close, SCHEMA };
