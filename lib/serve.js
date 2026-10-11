'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { TowerCraneError, refuse, usage } = require('./util');
const S = require('./state');
const R = require('./render');
const L = require('./ladder');
const P = require('./project');
const T = require('./tasks');
const D = require('./decisions');
const E = require('./events');
const { renderSettings } = require('./settings');

const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';
const WATCHED = ['tasks.json', 'decisions.json', 'project.json', 'events.jsonl'];

function ownerWrite(url) {
  const route = /^\/api\/(tasks|decisions)\/([TD]\d+)\/(comments|answer|owner-done|rework)$/.exec(url);
  if (!route || (route[1] === 'tasks' && route[3] === 'answer') || (route[1] === 'decisions' && ['owner-done', 'rework'].includes(route[3]))) {
    return null;
  }
  return (ctx, body) => {
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.values(body).some((v) => typeof v !== 'string')) throw usage('body must contain string fields');
    const actor = { ...ctx, flags: {}, pos: [route[2]] };
    let result;
    if (route[3] === 'comments') {
      actor.pos.push(body.text || '');
      result = route[1] === 'tasks' ? T.taskNote(actor) : D.comment(actor);
    } else if (route[3] === 'rework') {
      actor.flags = { reason: body.reason };
      result = T.rework(actor);
    } else if (route[3] === 'answer') {
      actor.flags = { choice: body.choice, note: body.note };
      result = D.answer(actor);
    } else {
      actor.flags = { note: body.note };
      result = T.ownerDone(actor);
    }
    return result.data;
  };
}

function signature(dir) {
  return WATCHED.map((f) => {
    try {
      const s = fs.statSync(path.join(dir, f));
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return '-';
    }
  }).join('|');
}

// The signature as an opaque token, for the page: it travels in reload
// events and save replies.
const version = (dir) => crypto.createHash('sha256').update(signature(dir)).digest('hex').slice(0, 16);

const BODY_LIMIT = 64 * 1024;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Pages are rendered from the state on each request rather than read from
// sketch.html, so a reload never races the CLI's own re-render.
function page(dir, draw) {
  try {
    return { code: 200, body: draw(S.loadState(dir)) };
  } catch (e) {
    return { code: 500, body: `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Tower Crane</title><pre>${String(e.message).replace(/</g, '&lt;')}</pre><p>Fix the state, then reload this page.</p>` };
  }
}

// The Settings form sends every field of a rung it changed; an empty field
// is cleared. The patch is built by the same function ladder set uses. base
// is the default harness and each sent rung's own fields as the page loaded
// them; the write is refused if any changed since, because the form's other
// fields would silently undo that change.
function saveLadder(ctx, body) {
  if (!isObject(body) || Object.keys(body).some((k) => !['harness', 'rungs', 'base'].includes(k))) throw usage('send { "harness", "rungs", "base" }');
  const base = body.base;
  if (!isObject(base) || typeof base.harness !== 'string' || (base.rungs !== undefined && !isObject(base.rungs))) {
    throw usage('send base: { "harness", "rungs" } as the page loaded them, so a change made elsewhere since is not overwritten');
  }
  const changes = {};
  if (body.harness !== undefined) {
    if (typeof body.harness !== 'string') throw usage('harness must be a string');
    changes.harness = body.harness;
  }
  if (body.rungs !== undefined) {
    if (!isObject(body.rungs)) throw usage('rungs must be an object of rung fields');
    changes.rungs = {};
    for (const [name, fields] of Object.entries(body.rungs)) {
      if (!L.RUNGS.includes(name)) throw usage(`unknown rung "${name}"; the rungs are ${L.RUNGS.join(', ')}`);
      if (!isObject(fields)) throw usage(`ladder ${name}: send its fields as an object`);
      if (!base.rungs || !isObject(base.rungs[name])) throw usage(`ladder ${name}: send base.rungs.${name}, the rung as the page loaded it`);
      const values = {};
      const clear = [];
      for (const [k, v] of Object.entries(fields)) {
        if (!L.FIELDS.includes(k)) throw usage(`ladder ${name}: unknown field ${k}; a rung takes ${L.FIELDS.join(', ')}`);
        if (typeof v === 'string' && v.trim() === '') clear.push(k);
        else values[k] = v;
      }
      try {
        changes.rungs[name] = P.rungPatch(values, clear, false, name);
      } catch (e) {
        e.message = `ladder ${name}: ${e.message}`;
        throw e;
      }
    }
  }
  if (changes.harness === undefined && !(changes.rungs && Object.keys(changes.rungs).length)) throw usage('nothing to save');
  // The reply is what tower-crane ladder show --json prints, so a page can redraw
  // from it without another request.
  changes.expect = { harness: base.harness, rungs: Object.fromEntries(Object.keys(changes.rungs || {}).map((n) => [n, base.rungs[n]])) };
  return { ok: true, ...P.showData(P.updateLadder(ctx, changes, 'serve')) };
}

// base holds each sent task's tier as the page loaded it, for the same reason
// as the ladder's.
function saveTiers(ctx, body) {
  if (!isObject(body) || !isObject(body.tiers) || !Object.keys(body.tiers).length) throw usage('send { "tiers": { "T1": "hard" }, "base": { "T1": "medium" } }');
  for (const [id, tier] of Object.entries(body.tiers)) {
    if (!L.TIERS.includes(tier)) throw usage(`${id}: tier must be one of ${L.TIERS.join(', ')}, got ${JSON.stringify(tier)}`);
    if (!isObject(body.base) || typeof body.base[id] !== 'string') throw usage(`${id}: send base.${id}, its tier as the page loaded it`);
  }
  return { ok: true, tiers: T.setTiers(ctx, body.tiers, 'serve', body.base) };
}

// The owner's conversation with the orchestrator, as a phone or terminal
// client keeps it: messages either way, and the decisions it answers.
const channel = (e) => (e.cmd === 'msg' && (e.to === 'owner' || e.agent === 'owner')) || ['decision-opened', 'decision-answer'].includes(e.type);

function eventsFile(dir) {
  return path.join(dir, 'events.jsonl');
}

function messages(dir, after) {
  if (after !== null && !/^\d+$/.test(after)) throw usage('after must be a byte offset from an earlier reply');
  const n = after === null ? 0 : Number(after);
  let size = 0;
  try { size = fs.statSync(eventsFile(dir)).size; } catch { /* no events yet */ }
  if (n > size) throw usage('after is past the end of events.jsonl');
  const batch = E.readFrom(eventsFile(dir), n);
  return { messages: batch.rows.filter(channel), cursor: batch.offset };
}

// mode follows the phone's composer: queue (the default) waits for the
// orchestrator's turn to end, steer joins the running one.
function sendMessage(ctx, body) {
  if (!isObject(body) || typeof body.text !== 'string' || !body.text.trim()) throw usage('send { "text": "...", "mode": "queue" | "steer", "task": "T1" }');
  if (body.mode !== undefined && !['queue', 'steer'].includes(body.mode)) throw usage('mode must be queue or steer');
  if (body.task !== undefined && typeof body.task !== 'string') throw usage('task must be a task id');
  const r = E.message({ ...ctx, env: {}, flags: { to: 'orchestrator', task: body.task, steer: body.mode === 'steer' }, pos: [body.text] });
  return { ok: true, message: r.data };
}

const POSTS = { '/api/ladder': saveLadder, '/api/tiers': saveTiers, '/api/messages': sendMessage };

function reply(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data) + '\n');
}

function serve(ctx) {
  const dir = ctx.stateDir;
  S.loadState(dir);
  const port = ctx.flags.port !== undefined ? ctx.flags.port : 4747;
  if (port < 0 || port > 65535) throw usage('--port must be between 0 and 65535');
  const clients = new Set();
  // A fresh token per run, required on every POST. Pages from other origins
  // cannot read it, and a local process cannot either: a page carries it only
  // when its request brings the one-time key printed to the owner's terminal.
  const token = crypto.randomBytes(24).toString('hex');
  // mode marks the board in the settings audit; the authority check is the CLI's.
  const writer = { ...ctx, flags: {}, pos: [], mode: 'board' };
  const canWriteOwner = ctx.agent === 'owner' && ctx.agentExplicit;
  let key = canWriteOwner ? crypto.randomBytes(24).toString('hex') : null;
  const same = (given, want) => {
    const a = Buffer.from(String(given || ''));
    return a.length === want.length && crypto.timingSafeEqual(a, Buffer.from(want));
  };
  const pageToken = (query) => {
    if (!key || !same(new URLSearchParams(query).get('key'), key)) return '';
    key = null;
    return token;
  };
  const local = () => {
    const p = server.address().port;
    return [`127.0.0.1:${p}`, `localhost:${p}`];
  };

  const post = (req, res, url) => {
    const owner = ownerWrite(url);
    const fn = POSTS[url] || owner;
    if (!fn) return reply(res, 404, { error: 'not found' });
    if (!canWriteOwner) return reply(res, 403, { error: 'owner routes require serve to run with explicit owner identity' });
    const origin = req.headers.origin;
    if (origin !== undefined && !local().some((h) => origin === `http://${h}`)) return reply(res, 403, { error: 'requests from other origins are refused' });
    if (!same(req.headers['x-tower-crane-token'], token)) {
      return reply(res, 403, { error: 'missing or wrong token; open the link serve printed, which works once, or restart serve for a new one' });
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'send application/json' });
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size <= BODY_LIMIT) chunks.push(d);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return reply(res, 413, { error: `the body is over ${BODY_LIMIT} bytes` });
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return reply(res, 400, { error: `not valid JSON (${e.message})` });
      }
      try {
        // version lets the page tell the reload its own write causes from a
        // change made elsewhere.
        reply(res, 200, { ...fn(writer, body), version: version(dir) });
      } catch (e) {
        if (!(e instanceof TowerCraneError)) return reply(res, 500, { error: e.message });
        reply(res, e.conflict ? 409 : e.code === 3 ? 503 : 400, { error: e.message });
      }
    });
  };

  const server = http.createServer((req, res) => {
    const [url, query = ''] = (req.url || '/').split('?');
    // A name rebound to 127.0.0.1 arrives with its own Host header; refusing
    // it keeps another site from reading the page and its token.
    if (!local().includes(String(req.headers.host || '').toLowerCase())) return reply(res, 403, { error: 'forbidden host' });
    if (req.method === 'POST') return post(req, res, url);
    if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed; use GET or POST' });
    if (url === '/' || url === '/sketch.html' || url === '/settings') {
      const given = pageToken(query);
      const p = url === '/settings'
        ? page(dir, (st) => renderSettings(st, given, version(dir), { owner: canWriteOwner }))
        : page(dir, (st) => R.renderHtml(st, Date.now(), { live: true, owner: canWriteOwner, token: given, version: version(dir) }));
      res.writeHead(p.code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(p.body);
    } else if (url === '/api/messages') {
      try {
        reply(res, 200, messages(dir, new URL(req.url, 'http://local').searchParams.get('after')));
      } catch (e) {
        reply(res, e instanceof TowerCraneError ? 400 : 500, { error: e.message });
      }
    } else if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    }
  });

  let last = signature(dir);
  let read = E.readFrom(eventsFile(dir), 0).offset;
  let timer = null;
  const check = () => {
    const sig = signature(dir);
    if (sig === last) return;
    last = sig;
    const data = JSON.stringify({ version: version(dir) });
    for (const res of clients) res.write(`event: reload\ndata: ${data}\n\n`);
    // A wake names the event; the client fetches /api/messages for its text.
    let batch;
    try {
      batch = E.readFrom(eventsFile(dir), read);
    } catch {
      // A replaced log: wake from its new end rather than stop serving.
      batch = { rows: [], offset: E.readFrom(eventsFile(dir), 0).offset };
    }
    read = batch.offset;
    for (const e of batch.rows.filter(channel)) {
      const wake = JSON.stringify({ id: e.id, type: e.type, to: e.to, offset: e.offset });
      for (const res of clients) res.write(`event: wake\ndata: ${wake}\n\n`);
    }
  };
  // Renames replace the files, so watch the directory and debounce bursts.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 60);
  };
  let watcher = null;
  let poll = null;
  const startPolling = () => {
    if (!poll) poll = setInterval(check, 1000);
  };
  try {
    watcher = fs.watch(dir, (event, name) => {
      if (!name || WATCHED.includes(String(name))) schedule();
    });
    watcher.on('error', startPolling);
  } catch {
    startPolling();
  }
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20000);

  // The watcher and timers keep the process alive, so every way out closes them.
  const quiet = () => {
    clearInterval(keepAlive);
    clearInterval(poll);
    clearTimeout(timer);
    if (watcher) watcher.close();
  };

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      quiet();
      reject(e.code === 'EADDRINUSE' ? refuse(`port ${port} is in use; pass --port P (0 picks a free one)`) : e);
    });
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        quiet();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        process.removeListener(OUTPUT_PIPE_CLOSED, stop);
        for (const res of clients) res.end();
        server.close(() => resolve({ printed: true }));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.once(OUTPUT_PIPE_CLOSED, stop);
      const open = key ? `${url}?key=${key}` : url;
      process.stdout.write(ctx.json ? JSON.stringify({ url, state: dir, open }) + '\n'
        : `serving ${url} (state ${dir}); ${key ? `open ${open} once in your browser to write; ` : ''}Ctrl-C stops\n`);
    });
  });
}

module.exports = { serve };
