'use strict';
// D: Valkey with appendonly yes and appendfsync always, so the server fsyncs
// the AOF before it replies to a write. Tasks are JSON strings under task:ID,
// events are entries of one Stream (field e holds the event line), and each
// agent's undelivered messages are a set under inbox:AGENT. A transition is
// WATCH task, GET, check, MULTI SET + XADD EXEC, retried when EXEC aborts.
const { Resp } = require('./resp');
const M = require('./model');

async function open(cfg) {
  return { cfg, c: await Resp.connect({ port: cfg.port }), retries: 0 };
}

function xadd(e, line = JSON.stringify(e)) {
  return ['XADD', 'events', '*', 'e', line];
}

async function transition(h, taskId, agent, kind, args) {
  for (let i = 0; i < 1000; i++) {
    await h.c.call('WATCH', `task:${taskId}`);
    const raw = await h.c.call('GET', `task:${taskId}`);
    const task = raw && JSON.parse(raw);
    let e;
    try {
      e = M.plan(task, agent, kind, args);
    } catch (err) {
      await h.c.call('UNWATCH');
      throw err;
    }
    M.apply(task, e);
    const r = await h.c.pipeline([['MULTI'], ['SET', `task:${taskId}`, JSON.stringify(task)], xadd(e), ['EXEC']]);
    if (r[3] !== null) return { id: e.id, retries: i };
    h.retries++;
  }
  throw new Error('transition kept conflicting');
}

async function send(h, from, to, taskId, text) {
  const e = M.event(from, 'msg', taskId, { to, text });
  const r = await h.c.pipeline([['MULTI'], xadd(e), ['SADD', `inbox:${to}`, e.id], ['EXEC']]);
  if (!r[3]) throw new Error('send aborted');
  return { id: e.id };
}

async function hook(h, agent, taskId) {
  const [raw, members] = await h.c.pipeline([['GET', `task:${taskId}`], ['SMEMBERS', `inbox:${agent}`]]);
  const task = raw && JSON.parse(raw);
  if (!task || task.status === 'cancelled') return { delivered: 0, stale: true };
  if (!members.length) return { delivered: 0 };
  for (let i = 0; i < 1000; i++) {
    await h.c.call('WATCH', `inbox:${agent}`);
    const ids = await h.c.call('SMEMBERS', `inbox:${agent}`);
    if (!ids.length) {
      await h.c.call('UNWATCH');
      return { delivered: 0 };
    }
    const e = M.event(agent, 'hook inbox', taskId, { messages: ids });
    const r = await h.c.pipeline([['MULTI'], ['SREM', `inbox:${agent}`, ...ids], xadd(e), ['EXEC']]);
    if (r[3] !== null) return { delivered: ids.length };
    h.retries++;
  }
  throw new Error('hook kept conflicting');
}

async function replay(h, from) {
  let start = from === 0 ? '-' : from;
  let count = 0;
  for (;;) {
    const rows = await h.c.call('XRANGE', 'events', start, '+', 'COUNT', 10000);
    for (const [, fields] of rows) {
      JSON.parse(fields[1]);
      count++;
    }
    if (rows.length < 10000) return { count };
    start = `(${rows.at(-1)[0]}`;
  }
}

async function offsetBack(h, n) {
  const rows = await h.c.call('XREVRANGE', 'events', '+', '-', 'COUNT', n);
  return rows.length ? rows.at(-1)[0] : 0;
}

async function verify(h) {
  const keys = await h.c.call('KEYS', 'task:*');
  const bodies = keys.length ? await h.c.call('MGET', ...keys) : [];
  const doc = { tasks: bodies.map((b) => JSON.parse(b)) };
  const events = [];
  let start = '-';
  for (;;) {
    const rows = await h.c.call('XRANGE', 'events', start, '+', 'COUNT', 10000);
    for (const [, fields] of rows) {
      const line = fields[1];
      if (line.includes('"cmd":"task note"') || line.includes('"cmd":"msg"') || line.includes('"cmd":"hook inbox"')) events.push(JSON.parse(line));
    }
    if (rows.length < 10000) break;
    start = `(${rows.at(-1)[0]}`;
  }
  const out = require('./files').tokensFrom(events, doc);
  const have = new Map();
  for (const key of await h.c.call('KEYS', 'inbox:*')) {
    have.set(key.slice('inbox:'.length), new Set(await h.c.call('SMEMBERS', key)));
  }
  out.inboxMismatch = require('./sqlite').mismatch(M.inboxFrom(events), have);
  out.badLines = 0;
  return out;
}

// Loads a T254 state directory into a server started without per-write
// fsync; the caller rewrites the AOF afterwards.
async function importState(port, tasksDoc, eventLines) {
  const h = await open({ port });
  const { tasks } = tasksDoc;
  await h.c.pipeline(tasks.map((t) => ['SET', `task:${t.id}`, JSON.stringify(t)]));
  const pending = new Map();
  let batch = [];
  for (const line of eventLines) {
    let e;
    try { e = require('./files').parseEvent(line); } catch { continue; }
    if (!e) continue;
    M.foldInbox(pending, e);
    batch.push(['XADD', 'events', '*', 'e', line]);
    if (batch.length === 2000) { await h.c.pipeline(batch); batch = []; }
  }
  if (batch.length) await h.c.pipeline(batch);
  const sets = [];
  for (const [agent, ids] of pending) if (ids.size) sets.push(['SADD', `inbox:${agent}`, ...ids.keys()]);
  if (sets.length) await h.c.pipeline(sets);
  h.c.close();
}

function close(h) {
  h.c.close();
}

module.exports = { open, transition, send, hook, replay, offsetBack, verify, importState, close };
