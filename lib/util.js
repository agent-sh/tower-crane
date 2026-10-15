'use strict';

const fs = require('node:fs');

// Exit codes from docs/cli.md: 1 refused, 2 usage error, 3 lock not acquired.
class TowerCraneError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (message) => new TowerCraneError(1, message);
const usage = (message) => new TowerCraneError(2, message);
// A write refused because what it was based on changed underneath it; serve
// answers it with 409 so a page can tell it from a bad value.
const conflict = (message) => Object.assign(new TowerCraneError(1, message), { conflict: true });

const nowIso = () => new Date().toISOString();

// The CLI is synchronous between the lock and the write, so a blocking sleep
// keeps the lock loop simple without turning every caller async.
// A synchronous wait holds every timer, so work that must go on while a
// process waits (touching a held lock's marker, lib/state.js
// keepMarkedLockFresh) registers here and runs before each sleep.
const sleepHooks = new Set();

function sleepSync(ms) {
  for (const hook of sleepHooks) hook();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// readFileSync(0) can throw EAGAIN or EOF on some pipes (Windows, non-blocking
// stdin), so read in a loop until the writer closes its end.
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        sleepSync(10);
        continue;
      }
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Gates may report a full sha while a worker submitted a short one; accept
// either direction as long as the shorter side is a real abbreviation.
function shaMatch(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 7 && long.startsWith(short);
}

function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'task';
}

function shortTime(iso) {
  if (!iso) return '-';
  return String(iso).replace('T', ' ').slice(0, 16) + 'Z';
}

function idNum(id) {
  const n = parseInt(String(id).slice(1), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function byId(a, b) {
  return idNum(a.id) - idNum(b.id) || String(a.id).localeCompare(String(b.id));
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

module.exports = { TowerCraneError, refuse, usage, conflict, nowIso, sleepSync, sleepHooks, readStdin, shaMatch, slugify, shortTime, idNum, byId, truncate };
