'use strict';

// Tests read and write the state as the file layout held it: project.json,
// tasks.json and decisions.json as documents, and the event log as its
// events. Each call opens state.db and closes it again, so no connection of
// the test process keeps a fixture from being removed on Windows.

const path = require('node:path');
const Db = require('../lib/db');
const S = require('../lib/state');

function withDb(dir, fn) {
  try {
    return fn();
  } finally {
    Db.close(dir);
  }
}

function fromSnapshot(snap, file) {
  if (file === 'project.json') return JSON.parse(snap.docs.project);
  if (file === 'decisions.json') return JSON.parse(snap.docs.decisions);
  if (file === 'tasks.json') return { ...JSON.parse(snap.docs.tasks), tasks: snap.tasks.map((r) => JSON.parse(r.body)) };
  throw new Error(`${file} is not a state document`);
}

// The document a file layout kept in `file`, as the database holds it now.
function readDoc(dir, file) {
  return withDb(dir, () => fromSnapshot(Db.snapshot(dir), file));
}

// Replaces a document as the file layout's writer replaced the file, under
// the state lock, so a running CLI never commits over half of it.
function writeDoc(dir, file, data) {
  withDb(dir, () => S.withLock(dir, () => {
    if (file === 'project.json') return Db.commit(dir, { docs: { project: JSON.stringify(data) } });
    if (file === 'decisions.json') return Db.commit(dir, { docs: { decisions: JSON.stringify(data) } });
    if (file !== 'tasks.json') throw new Error(`${file} is not a state document`);
    const { tasks, ...envelope } = data;
    const keep = new Set(tasks.map((t) => t.id));
    return Db.commit(dir, {
      docs: { tasks: JSON.stringify(envelope) },
      tasks: tasks.map((t, ord) => ({ id: t.id, ord, status: String(t.status), body: JSON.stringify(t) })),
      drop: Db.snapshot(dir).tasks.map((r) => r.id).filter((id) => !keep.has(id)),
    });
  }));
}

// Every event the log holds, parsed, each with its cursor as `offset` when
// `offsets` is set.
function readEvents(dir, { offsets = false } = {}) {
  return withDb(dir, () => Db.eventsAfter(dir, 0).map((r) => (offsets ? { ...JSON.parse(r.body), offset: r.pos } : JSON.parse(r.body))));
}

// The log's lines, as the file layout's events.jsonl held them.
function eventLines(dir) {
  return withDb(dir, () => Db.eventsAfter(dir, 0).map((r) => r.body));
}

// The cursor after the last event, which counts bytes as events.jsonl did.
function logEnd(dir) {
  return withDb(dir, () => Db.end(dir));
}

// Appends events as a CLI command would log them, under the state lock. An
// event without an id gets one, its type and its recipient.
function appendEvents(dir, events) {
  withDb(dir, () => S.withLock(dir, () => S.appendEvents(dir, events)));
}

const dbFile = (dir) => path.join(dir, Db.FILE);

module.exports = { readDoc, writeDoc, readEvents, eventLines, logEnd, appendEvents, dbFile, withDb };
