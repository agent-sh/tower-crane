'use strict';
// C: one long-lived process owns the state; CLI processes and hooks send one
// JSON line over a Unix socket and get one line back. Reads are answered from
// memory. Writes queue; each event loop turn commits every queued write with
// one fsync (group commit) and only then replies, so an acknowledgement means
// the same as in A, B and D.
//
// Backends:
//   files   A's files. events.jsonl is the redo log (append + fsync per batch);
//           tasks.json is a checkpoint written every few seconds with the log
//           offset it covers, and a restart redoes the events after it.
//   sqlite  B's database, one transaction per batch.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const M = require('./model');
const F = require('./files');
const B = require('./sqlite');

const CHECKPOINT_MS = 5000;

function filesBackend(dir) {
  const tasksFile = path.join(dir, 'tasks.json');
  const eventsFile = path.join(dir, 'events.jsonl');
  const doc = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  // A torn last line was never acknowledged; drop it before appending.
  let raw = fs.readFileSync(eventsFile);
  const end = raw.lastIndexOf(10) + 1;
  if (end !== raw.length) {
    fs.truncateSync(eventsFile, end);
    raw = raw.subarray(0, end);
  }
  const covered = doc._service_offset ?? raw.length;
  const tasks = new Map(doc.tasks.map((t) => [t.id, t]));
  const inbox = new Map();
  let offset = 0;
  let redone = 0;
  let start = 0;
  while (start < raw.length) {
    const nl = raw.indexOf(10, start);
    const line = raw.toString('utf8', start, nl);
    start = nl + 1;
    let e = null;
    try { e = F.parseEvent(line); } catch { /* skipped like the product does */ }
    offset = start;
    if (!e) continue;
    M.foldInbox(inbox, e);
    if (offset > covered && M.MUTATING.has(e.cmd) && tasks.has(e.task)) {
      M.apply(tasks.get(e.task), e);
      redone++;
    }
  }
  raw = null;
  const fd = fs.openSync(eventsFile, 'a');
  let size = offset;
  let dirty = redone > 0;
  const checkpoint = () => {
    if (!dirty) return;
    doc._service_offset = size;
    const tmp = `${tasksFile}.ckpt`;
    const t = fs.openSync(tmp, 'w');
    fs.writeSync(t, JSON.stringify(doc, null, 2) + '\n');
    fs.fsyncSync(t);
    fs.closeSync(t);
    fs.renameSync(tmp, tasksFile);
    const d = fs.openSync(dir, 'r');
    fs.fsyncSync(d);
    fs.closeSync(d);
    dirty = false;
  };
  // The first start records the offset tasks.json covers before any write,
  // or a crash before the first checkpoint would skip the redo.
  if (doc._service_offset === undefined) {
    dirty = true;
    checkpoint();
  }
  setInterval(checkpoint, CHECKPOINT_MS).unref();
  return {
    tasks, inbox, redone,
    commit(events) {
      if (!events.length) return;
      const buf = Buffer.from(events.map((e) => JSON.stringify(e) + '\n').join(''));
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
      size += buf.length;
      if (events.some((e) => M.MUTATING.has(e.cmd))) dirty = true;
    },
    shutdown: checkpoint,
    // tasks.json is only a checkpoint here, so task tokens come from memory
    // (rebuilt by redo at startup) and the inbox index is checked against the log.
    verify() {
      const raw = fs.readFileSync(eventsFile, 'utf8').split('\n');
      const tail = raw.pop();
      const events = [];
      let bad = 0;
      for (const line of raw) {
        try { const e = F.parseEvent(line); if (e) events.push(e); } catch { bad++; }
      }
      const out = F.tokensFrom(events, { tasks: [...tasks.values()] });
      const have = new Map([...inbox].map(([a, m]) => [a, new Set(m.keys())]));
      out.inboxMismatch = B.mismatch(M.inboxFrom(events), have);
      out.badLines = bad;
      out.tornTail = tail.length > 0;
      return out;
    },
  };
}

function sqliteBackend(db) {
  const h = B.open({ db });
  const tasks = new Map(h.db.prepare('SELECT body FROM tasks').all().map((r) => {
    const t = JSON.parse(r.body);
    return [t.id, t];
  }));
  const inbox = new Map();
  for (const r of h.db.prepare('SELECT seq, agent, id FROM inbox WHERE delivered = 0 ORDER BY seq').iterate()) {
    if (!inbox.has(r.agent)) inbox.set(r.agent, new Map());
    inbox.get(r.agent).set(r.id, true);
  }
  const deliver = h.db.prepare('UPDATE inbox SET delivered = 1 WHERE id = ?');
  return {
    tasks, inbox, redone: 0,
    commit(events, touched) {
      if (!events.length) return;
      h.db.exec('BEGIN IMMEDIATE');
      for (const id of touched) h.st.putTask.run(JSON.stringify(tasks.get(id)), id);
      for (const e of events) {
        B.insertEvent(h, e);
        if (e.cmd === 'hook inbox') for (const id of e.detail.messages) deliver.run(id);
      }
      h.db.exec('COMMIT');
    },
    shutdown() {},
    verify() {
      return B.verify(h);
    },
  };
}

function serve({ backend, dir, db, socket }) {
  const store = backend === 'files' ? filesBackend(dir) : sqliteBackend(db);
  const { tasks, inbox } = store;
  let queue = [];
  let scheduled = false;

  const pendingFor = (agent) => inbox.get(agent);

  function handle(req, events, touched) {
    const a = req.args;
    if (req.op === 'transition') {
      const task = tasks.get(a.task);
      const e = M.plan(task, a.agent, a.kind, a.args);
      M.apply(task, e);
      touched.add(a.task);
      events.push(e);
      return { id: e.id };
    }
    if (req.op === 'send') {
      const e = M.event(a.from, 'msg', a.task, { to: a.to, text: a.text });
      M.foldInbox(inbox, e);
      events.push(e);
      return { id: e.id };
    }
    if (req.op === 'hook') {
      const mine = pendingFor(a.agent);
      if (!mine?.size) return { delivered: 0 };
      const ids = [...mine.keys()];
      const e = M.event(a.agent, 'hook inbox', a.task, { messages: ids });
      M.foldInbox(inbox, e);
      events.push(e);
      return { delivered: ids.length };
    }
    throw new Error(`unknown op ${req.op}`);
  }

  function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    const events = [];
    const touched = new Set();
    const results = batch.map(({ req }) => {
      try {
        return { ok: true, result: handle(req, events, touched) };
      } catch (e) {
        return { ok: false, error: e.message, conflict: e.code === 'CONFLICT' };
      }
    });
    try {
      store.commit(events, touched);
    } catch (e) {
      // Memory already holds the batch; without its commit the process must not answer.
      process.stderr.write(`commit failed: ${e.stack}\n`);
      process.exit(70);
    }
    batch.forEach((b, i) => b.reply({ ...results[i], batch: batch.length }));
  }

  function request(req, reply) {
    if (req.op === 'ping') return reply({ ok: true, result: { redone: store.redone } });
    if (req.op === 'verify') return reply({ ok: true, result: store.verify() });
    if (req.op === 'hook') {
      const task = tasks.get(req.args.task);
      if (!task || task.status === 'cancelled') return reply({ ok: true, result: { delivered: 0, stale: true } });
      // An empty poll needs no write and no fsync.
      if (!pendingFor(req.args.agent)?.size) return reply({ ok: true, result: { delivered: 0 } });
    }
    queue.push({ req, reply });
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  }

  try { fs.unlinkSync(socket); } catch { /* none left */ }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { conn.end('{"ok":false,"error":"bad request"}\n'); return; }
        request(req, (res) => { if (!conn.destroyed) conn.write(JSON.stringify(res) + '\n'); });
      }
    });
    conn.on('error', () => {});
  });
  server.listen(socket, () => process.stdout.write(`ready ${JSON.stringify({ redone: store.redone })}\n`));
  const stop = () => { store.shutdown(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function call(socket, op, args) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket, () => conn.write(JSON.stringify({ op, args }) + '\n'));
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    conn.on('error', reject);
    conn.on('close', () => { if (!buf.includes('\n')) reject(new Error('service closed the connection')); });
  });
}

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
  serve({ backend: arg('backend'), dir: arg('dir'), db: arg('db'), socket: arg('socket') });
}

module.exports = { serve, call };
