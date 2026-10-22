'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Db = require('./db');

// A state file's stat with an exact identity. Windows file ids run past 2^53,
// where a Number stat rounds neighbouring ids to one value. Times are
// milliseconds taken from the nanosecond fields.
function fileStat(target) {
  const st = typeof target === 'number' ? fs.fstatSync(target, { bigint: true }) : fs.statSync(target, { bigint: true });
  const ms = (ns) => Number(ns / 1000n) / 1000;
  const dev = Number(st.dev);
  const ino = String(st.ino);
  return { size: Number(st.size), dev, ino, id: `${dev}:${ino}`, mtimeMs: ms(st.mtimeNs), ctimeMs: ms(st.ctimeNs) };
}

// Lock recovery in the file layout cut a torn append off events.jsonl and
// then recorded the cut in events.cuts.jsonl, one JSON line each: `id`, the
// last event id of the commit it cut, `size`, the length it cut the log back
// to, `from`, the length before, and `ends`, the offsets where the lines it
// removed ended. `late` marks a cut an older tool made and a later holder
// recorded. Migration keeps that file's text in the database; no cut happens
// after it, so its length is the cuts count of every cursor handed out since.
function cutsFile(log) {
  return path.join(path.dirname(log), 'events.cuts.jsonl');
}

// The cuts in `bytes` from byte `from` on, and where the last whole record
// read ends: a record still being appended is read again next time.
function parseCuts(bytes, from = 0) {
  if (bytes.length <= from) return { cuts: [], end: from };
  const rest = bytes.subarray(from);
  const whole = rest.subarray(0, rest.lastIndexOf(10) + 1);
  const cuts = [];
  for (const line of whole.toString('utf8').split('\n')) {
    try {
      const cut = JSON.parse(line);
      if (Number.isSafeInteger(cut.size) && Number.isSafeInteger(cut.from)) cuts.push(cut);
    } catch {
      // A record torn by a crash. The holder that cut the log died before
      // its commit's files were removed, so the next one records it again.
    }
  }
  return { cuts, end: from + whole.length };
}

// The cuts events.cuts.jsonl beside `log` holds, for recovery in the file layout.
function readCuts(log, from = 0) {
  let bytes;
  try {
    bytes = fs.readFileSync(cutsFile(log));
  } catch (e) {
    if (e.code === 'ENOENT') return { cuts: [], end: from };
    throw e;
  }
  return parseCuts(bytes, from);
}

// The cuts count of a cursor taken now in the state at dir.
function cutsSize(dir) {
  return Buffer.byteLength(Db.legacyCuts(dir));
}

// Whether offset, inside cut's range, ended one of the lines it removed and
// ends no line of the log now: every cursor handed out after a cut ends a
// line of the log as it is then.
function removedEnd(dir, cut, offset) {
  return cut.size < offset && offset <= cut.from && (!Array.isArray(cut.ends) || cut.ends.includes(offset)) && !Db.endsLine(dir, offset);
}

// A byte cursor taken before a cut, at the end of a line the cut removed,
// moves back to where the cut left the log, so the events appended since are
// read and none is skipped. With `since`, the cuts file's length when the
// cursor was taken, every cut recorded after it applies, exactly. A plain
// number does not say when it was taken, so it moves only for a cut whose
// removed line it ended and that leaves it ending no line now; a cursor from
// before the cut whose offset a new line happens to end at too stays. A late
// record may come after an older tool appended, so it moves any cursor only
// that way.
function cutBack(dir, offset, since = null) {
  if (!offset) return offset;
  const text = Buffer.from(Db.legacyCuts(dir));
  if (text.length <= (since ?? 0)) return offset;
  for (const cut of parseCuts(text, since ?? 0).cuts) {
    if (!(cut.size < offset && offset <= cut.from)) continue;
    if ((since === null || cut.late) && !removedEnd(dir, cut, offset)) continue;
    offset = cut.size;
  }
  return offset;
}

// A byte cursor as wait and serve return it, `OFFSET:CUTS` with the cuts
// count when it was taken, or a plain OFFSET (cuts null); null when value is
// neither.
function parseCursor(value) {
  const m = /^(\d+)(?::(\d+))?$/.exec(String(value));
  if (!m) return null;
  const offset = Number(m[1]);
  const cuts = m[2] === undefined ? null : Number(m[2]);
  if (!Number.isSafeInteger(offset) || cuts !== null && !Number.isSafeInteger(cuts)) return null;
  return { offset, cuts };
}

const formatCursor = (offset, cuts) => `${offset}:${cuts}`;

// Reads the events committed after a cursor, in order. Each event carries the
// cursor after it, which counts bytes as the file layout's log did, so
// cursors taken before migration still name the same place. A database
// replaced since the last read starts over (`reset`): Db.uid names the
// database file as well as its uid, so a restored copy, which keeps the uid,
// differs too.
class EventReader {
  // `restores` tells restored history from new events after a reset (see
  // read), for readers that deliver events rather than rebuild history.
  constructor(dir, { after = 0, parse = JSON.parse, restores = false } = {}) {
    this.dir = dir;
    this.position = after;
    this.offset = after;
    this.identity = null;
    this.parse = parse;
    if (restores) {
      // Event ids are random, so identity, not order or a writer's clock,
      // says whether a row came back: the ids of the rows read since the
      // start, one per row the caller was handed, and the id that ends the
      // history before the start.
      this.ids = new Set();
      this.startId = Db.idEndingAt(dir, after);
      this.startOffset = after;
      this.startedAt = new Date().toISOString();
      // After a reset and until the start id comes back, rows may be history
      // from before the start.
      this.beforeStart = false;
    }
    this.cuts = cutsSize(dir);
  }

  reset() {
    if (this.ids && (this.identity !== null || this.position !== 0)) this.beforeStart = this.startOffset > 0;
    this.resume(0);
    this.identity = null;
  }

  // Whether a row is history a reset brought back: one read since the start,
  // or one from before it, which ends with the start id. A restore without
  // that id, an older backup, leaves only the writer's clock: rows written
  // no later than the start are history.
  restoredRow(row) {
    const id = typeof row?.id === 'string' ? row.id : null;
    let restored = false;
    if (this.beforeStart && id !== null && id === this.startId) {
      this.beforeStart = false;
      restored = true;
    } else if (id !== null && this.ids.has(id)) restored = true;
    else if (this.beforeStart) restored = typeof row?.at === 'string' && row.at <= this.startedAt;
    if (row && id !== null) this.ids.add(id);
    return restored;
  }

  resume(at) {
    this.position = at;
    this.offset = at;
  }

  // With `restores`, `restored` holds the rows that are history a reset
  // brought back, not new events.
  read() {
    let reset = false;
    const restored = new Set();
    const rows = [];
    const identity = Db.handle(this.dir) ? Db.uid(this.dir) : null;
    if (this.identity !== null && (this.identity !== identity || identity !== null && Db.end(this.dir) < this.position)) {
      this.reset();
      this.cuts = cutsSize(this.dir);
      reset = true;
    } else if (identity === null && this.position !== 0) {
      reset = true;
      this.reset();
    }
    this.identity = identity;
    for (const r of identity === null ? [] : Db.eventsAfter(this.dir, this.position)) {
      this.position = r.pos;
      this.offset = r.pos;
      let row = null;
      try {
        row = this.parse(r.body, r.pos);
      } catch {
        // A row a parser refuses never stops the ones after it.
      }
      if (this.ids && this.restoredRow(row) && row) restored.add(row);
      if (row) rows.push(row);
    }
    return { rows, offset: this.offset, reset, restored };
  }
}

module.exports = { fileStat, EventReader, cutsFile, cutsSize, readCuts, parseCuts, cutBack, parseCursor, formatCursor };
