'use strict';
// B-cli's readers: the state.db of a real CLI tree (T267), read through that
// tree's own lib, so replay and verify see what its commands see.
const path = require('node:path');
const { tokensFrom } = require('./files');

function open(cfg) {
  const lib = (name) => require(path.join(cfg.aTree, 'lib', name));
  return { S: lib('state'), Db: lib('db'), dir: cfg.dir };
}

function replay(h, from) {
  h.S.open(h.dir);
  let count = 0;
  for (const row of h.Db.eventsAfter(h.dir, from)) {
    JSON.parse(row.body);
    count++;
  }
  return { count };
}

// The cursor before the n-th last event.
function offsetBack(h, n) {
  h.S.open(h.dir);
  const row = h.Db.handle(h.dir).db.prepare('SELECT pos FROM events ORDER BY pos DESC LIMIT 1 OFFSET ?').get(n);
  return row ? row.pos : 0;
}

// Every task note and message the database holds, its integrity check, and
// whether the inbox table agrees with the messages and deliveries in the log.
function verify(h) {
  const st = h.S.loadState(h.dir, { fresh: true });
  const events = h.S.readEvents(h.dir);
  const db = h.Db.handle(h.dir).db;
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const delivered = new Set(events.filter((e) => e.cmd === 'hook inbox').flatMap((e) => e.detail.messages.map((id) => `${e.agent} ${id}`)));
  const unread = new Set(events.filter((e) => e.cmd === 'msg' && typeof e.detail.to === 'string' && !delivered.has(`${e.detail.to} ${e.id}`)).map((e) => e.id));
  const pending = new Set(db.prepare('SELECT e.id FROM inbox i JOIN events e ON e.pos = i.pos WHERE i.delivered = 0').all().map((r) => r.id));
  const inboxMismatch = [...unread].filter((id) => !pending.has(id)).length + [...pending].filter((id) => !unread.has(id)).length;
  return { ...tokensFrom(events, st.tasks), badLines: 0, tornTail: false, inboxMismatch, integrity };
}

module.exports = { open, replay, offsetBack, verify, close() {} };
