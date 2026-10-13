'use strict';
// A-proto: the T254 file layout and algorithm with only the storage work left.
// It uses the T254 tree's own lock, atomic write and event reader. A writer
// parses tasks.json and the whole log outside the lock, re-reads only the
// appended tail under it, rewrites tasks.json (fsync + rename) and appends its
// event. Unlike T254, the append is fsynced, so an acknowledged event survives
// a power loss like the other options.
const fs = require('node:fs');
const path = require('node:path');
const M = require('./model');

function parseEvent(line) {
  const progress = line.indexOf('"cmd":"hook progress"');
  const detail = line.indexOf('"detail":');
  if (!line.trim() || progress !== -1 && (detail === -1 || progress < detail)) return null;
  return JSON.parse(line);
}

function open(cfg) {
  const lib = (name) => require(path.join(cfg.aTree, 'lib', name));
  return { cfg, dir: cfg.dir, S: lib('state'), EventReader: lib('event-reader').EventReader };
}

const tasksFile = (h) => path.join(h.dir, 'tasks.json');
const eventsFile = (h) => path.join(h.dir, 'events.jsonl');

function snapshotKey(h) {
  const s = fs.statSync(tasksFile(h));
  return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}

function load(h) {
  const key = snapshotKey(h);
  const reader = new h.EventReader(eventsFile(h), { parse: parseEvent });
  const events = reader.read().rows;
  const doc = JSON.parse(fs.readFileSync(tasksFile(h), 'utf8'));
  return { key, reader, events, doc };
}

function locked(h, prep, fn, waitMs) {
  return h.S.withLock(h.dir, () => {
    let st = prep;
    if (snapshotKey(h) !== prep.key) st = load(h);
    else st.events = st.events.concat(st.reader.read().rows);
    return fn(st);
  }, waitMs);
}

function append(h, events) {
  const fd = fs.openSync(eventsFile(h), 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) prefix = '\n';
    }
    fs.writeSync(fd, prefix + events.map((e) => JSON.stringify(e) + '\n').join(''));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const findTask = (doc, id) => doc.tasks.find((t) => t.id === id);

function transition(h, taskId, agent, kind, args) {
  const prep = load(h);
  return locked(h, prep, (st) => {
    const task = findTask(st.doc, taskId);
    const e = M.plan(task, agent, kind, args);
    M.apply(task, e);
    // T254 order: the snapshot first, then the receipt.
    h.S.writeAtomic(tasksFile(h), JSON.stringify(st.doc, null, 2) + '\n');
    append(h, [e]);
    return { id: e.id };
  });
}

function send(h, from, to, taskId, text) {
  const prep = load(h);
  return locked(h, prep, () => {
    const e = M.event(from, 'msg', taskId, { to, text });
    append(h, [e]);
    return { id: e.id };
  });
}

// A polling hook in T254 never waits for the lock: a busy lock leaves the
// messages for the next poll.
function hook(h, agent, taskId) {
  const prep = load(h);
  const task = findTask(prep.doc, taskId);
  if (!task || task.status === 'cancelled') return { delivered: 0, stale: true };
  const pending = M.inboxFrom(prep.events).get(agent);
  if (!pending?.size) return { delivered: 0 };
  try {
    return locked(h, prep, (st) => {
      const now = M.inboxFrom(st.events).get(agent);
      if (!now?.size) return { delivered: 0 };
      append(h, [M.event(agent, 'hook inbox', taskId, { messages: [...now.keys()] })]);
      return { delivered: now.size };
    }, 0);
  } catch (e) {
    if (e.code !== 3) throw e;
    return { delivered: 0, busy: true };
  }
}

function replay(h, from) {
  const reader = new h.EventReader(eventsFile(h), { after: from, parse: parseEvent });
  const rows = reader.read().rows;
  return { count: rows.length };
}

// Byte offset where the n-th last line starts.
function offsetBack(h, n) {
  const fd = fs.openSync(eventsFile(h), 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let lines = -1;
    const buf = Buffer.alloc(1 << 20);
    while (pos > 0) {
      const len = Math.min(buf.length, pos);
      pos -= len;
      fs.readSync(fd, buf, 0, len, pos);
      for (let i = len - 1; i >= 0; i--) {
        if (buf[i] === 10 && ++lines === n) return pos + i + 1;
      }
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function tokensFrom(events, doc) {
  const out = { taskTokens: [], noteTokens: [], msgTokens: [] };
  for (const t of doc.tasks) for (const n of Array.isArray(t.notes) ? t.notes : []) {
    if (typeof n?.text === 'string' && n.text.startsWith('tok-')) out.taskTokens.push(n.text);
  }
  for (const e of events) {
    const text = e.detail?.text;
    if (typeof text !== 'string' || !text.startsWith('tok-')) continue;
    if (e.cmd === 'task note') out.noteTokens.push(text);
    if (e.cmd === 'msg') out.msgTokens.push(text);
  }
  return out;
}

// Reads the files as a fresh reader would; lines that do not parse are
// counted, a torn last line separately from damage in the middle.
function verify(h) {
  const doc = JSON.parse(fs.readFileSync(tasksFile(h), 'utf8'));
  const raw = fs.readFileSync(eventsFile(h), 'utf8');
  const lines = raw.split('\n');
  const tail = lines.pop();
  const events = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const e = parseEvent(line);
      if (e) events.push(e);
    } catch {
      bad++;
    }
  }
  return { ...tokensFrom(events, doc), badLines: bad, tornTail: tail.length > 0, inboxMismatch: 0 };
}

module.exports = { open, transition, send, hook, replay, offsetBack, verify, tokensFrom, parseEvent, close() {} };
