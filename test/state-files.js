'use strict';

// Tests read and write the state as the file layout held it: project.json,
// tasks.json and decisions.json as documents, and the event log as its
// events. Each call opens state.db and closes it again, so no connection of
// the test process keeps a fixture from being removed on Windows.

const fs = require('node:fs');
const path = require('node:path');
const Db = require('../lib/db');
const S = require('../lib/state');
const { readPublished } = require('./atomic-file');

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
  if (file === 'tasks.json') return { ...JSON.parse(snap.docs.tasks), tasks: snap.tasks.map((r) => Db.join(r.head, r.bulk)) };
  throw new Error(`${file} is not a state document`);
}

// The document a file layout kept in `file`, as the database holds it now.
function readDoc(dir, file) {
  return withDb(dir, () => fromSnapshot(Db.snapshot(dir), file));
}

// Under the state lock, or inside one the caller holds (`locked`).
const underLock = (dir, locked, fn) => (locked ? fn() : S.withLock(dir, fn));

// Replaces a document as the file layout's writer replaced the file, under
// the state lock, so a running CLI never commits over half of it.
function writeDoc(dir, file, data, { locked = false } = {}) {
  withDb(dir, () => underLock(dir, locked, () => {
    if (file === 'project.json') return Db.commit(dir, { docs: { project: JSON.stringify(data) } });
    if (file === 'decisions.json') return Db.commit(dir, { docs: { decisions: JSON.stringify(data) } });
    if (file !== 'tasks.json') throw new Error(`${file} is not a state document`);
    const { tasks, ...envelope } = data;
    const keep = new Set(tasks.map((t) => t.id));
    return Db.commit(dir, {
      docs: { tasks: JSON.stringify(envelope) },
      tasks: tasks.map((t, ord) => ({ id: t.id, ord, status: String(t.status), ...Db.split(t) })),
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

// The log as events.jsonl held it: one line per event, each ending at its cursor.
function logText(dir) {
  const lines = eventLines(dir);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Appends the events on the lines of `text` as they are, as a test appended
// them to events.jsonl. A line without an id gets one, since the database
// names every event, and so does a copy of an event the log holds: no two
// events share an id there.
function appendLog(dir, text, { locked = false } = {}) {
  const fresh = () => `E${require('node:crypto').randomUUID()}`;
  withDb(dir, () => underLock(dir, locked, () => {
    const seen = new Set();
    const events = String(text).split('\n').filter((line) => line.trim()).map((line) => {
      const e = JSON.parse(line);
      const copied = e.id && (seen.has(e.id) || Db.eventById(dir, e.id));
      if (e.id) seen.add(e.id);
      return !e.id || copied ? { ...e, id: fresh() } : e;
    });
    Db.commit(dir, { events });
  }));
}

// Replaces the whole log with the events on the lines of `text`, as a test
// rewrote events.jsonl: the events are numbered from the start again.
function replaceLog(dir, text) {
  const events = String(text).split('\n').filter((line) => line.trim()).map((line) => {
    const e = JSON.parse(line);
    return e.id ? e : { id: `E${require('node:crypto').randomUUID()}`, ...e };
  });
  withDb(dir, () => S.withLock(dir, () => {
    const { db } = Db.handle(dir);
    db.exec("BEGIN IMMEDIATE; DELETE FROM inbox; DELETE FROM events; UPDATE meta SET value = '0' WHERE key = 'end'; COMMIT");
    Db.commit(dir, { events });
  }));
}

// A consistent copy of the database at `file`, as a backup takes it.
function backup(dir, file) {
  fs.rmSync(file, { force: true });
  withDb(dir, () => Db.handle(dir).db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`));
}

// Puts a backup back as state.db, as an owner restores one: its old log
// files go first, so the copy never meets the log of the database it
// replaces. `rename` replaces it at once; `remove` takes it away and returns
// once `between` has run, so a reader sees the state gone first.
async function restore(dir, file, { how = 'rename', between = async () => {} } = {}) {
  const target = path.join(dir, Db.FILE);
  fs.copyFileSync(file, `${target}.restore`);
  if (how === 'remove') {
    for (const name of DB_FILES) fs.rmSync(path.join(dir, name), { force: true });
    await between();
  } else {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
  }
  fs.renameSync(`${target}.restore`, target);
}

// A document as the file layout's writer laid it out.
function docText(dir, file) {
  return `${JSON.stringify(readDoc(dir, file), null, 2)}\n`;
}

// Everything a write could change, as text: the project.json marker, the
// documents, the log, and the other files of the state directory named in
// `files`, such as the sketch, or null for one that is not there.
function stateText(dir, files = []) {
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? readPublished(path.join(dir, name), 'utf8') : null);
  return [read('project.json'), ...['project.json', 'tasks.json', 'decisions.json'].map((file) => docText(dir, file)), logText(dir), ...files.map(read)];
}

// A file of the file layout as the database holds it now: a document as its
// writer laid it out, events.jsonl as the log's lines; any other file of the
// state directory is read as it is.
function fileText(dir, name) {
  if (['project.json', 'tasks.json', 'decisions.json'].includes(name)) return docText(dir, name);
  if (name === 'events.jsonl') return logText(dir);
  return readPublished(path.join(dir, name), 'utf8');
}

function writeDocText(dir, file, text) {
  writeDoc(dir, file, JSON.parse(text));
}

// A copied state's database with `rewrite` applied to every document, task
// row and event, as a fixture copy rewrites the paths in its other files.
// Rebuilt rather than edited, so each event's cursor follows the new lengths.
function rewriteState(dir, rewrite) {
  if (!fs.existsSync(path.join(dir, Db.FILE))) return;
  const { docs, tasks, lines } = withDb(dir, () => {
    const snap = Db.snapshot(dir);
    return { docs: snap.docs, tasks: snap.tasks, lines: Db.eventsAfter(dir, 0).map((r) => r.body) };
  });
  const target = path.join(dir, Db.FILE);
  const building = `${target}.rewrite`;
  Db.build(building, {
    docs: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, rewrite(v)])),
    tasks: tasks.map((r) => {
      const head = rewrite(r.head);
      return { id: r.id, status: String(JSON.parse(head).status), head, bulk: rewrite(r.bulk) };
    }),
    log: Buffer.from(lines.map((l) => `${rewrite(l)}\n`).join('')),
    cuts: Buffer.alloc(0),
    parse: JSON.parse,
  });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
  fs.renameSync(building, target);
}

// Turns a state directory back into the file layout of tower-crane 0.1, as a
// 0.1 tool left it: its export in place of the database and the marker. The
// next command of this tool migrates it again.
function toFileLayout(dir) {
  const out = `${dir}.layout`;
  withDb(dir, () => S.exportState(dir, out));
  for (const name of [...DB_FILES, 'project.json']) fs.rmSync(path.join(dir, name), { force: true });
  fs.rmSync(path.join(dir, 'legacy'), { recursive: true, force: true });
  for (const name of ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl', 'events.cuts.jsonl']) {
    if (fs.existsSync(path.join(out, name))) fs.renameSync(path.join(out, name), path.join(dir, name));
  }
  fs.rmSync(out, { recursive: true, force: true });
}

const DB_FILES = new Set([Db.FILE, `${Db.FILE}-wal`, `${Db.FILE}-shm`]);
const dbFile = (dir) => path.join(dir, Db.FILE);

module.exports = { toFileLayout, rewriteState, DB_FILES, readDoc, writeDoc, docText, stateText, fileText, writeDocText, readEvents, eventLines, logText, logEnd, appendEvents, appendLog, replaceLog, backup, restore, dbFile, withDb };
