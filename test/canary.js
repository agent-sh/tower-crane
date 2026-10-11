'use strict';

const { fileWritten } = require('./signals');

// Secret canaries: unique random values placed where an owner keeps secrets
// (rung and project env, an env_file, a harness credential), then searched
// for in every file, event, output and process listing a run leaves. A hit
// names the file and the canary's label, never its value.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

function make(labels) {
  return Object.fromEntries(labels.map((label) => [label, `tccanary${label.replace(/\W/g, '')}${crypto.randomBytes(12).toString('hex')}`]));
}

function hitsIn(buffer, canaries) {
  return Object.entries(canaries).filter(([, value]) => buffer.includes(value)).map(([label]) => label);
}

// Walks without following links: a home links to the user's credential
// files, which are scanned where they live, as configured sources. Each file
// is opened once, without following a link, and read through that handle.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const GONE = ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'];

function scanTree(roots, canaries, allow = []) {
  const allowed = new Set(allow.map((f) => path.resolve(f)));
  const hits = [];
  const read = (file) => {
    if (allowed.has(path.resolve(file))) return;
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW); } catch (e) {
      if (GONE.includes(e.code)) return;
      throw e;
    }
    try {
      if (!fs.fstatSync(fd).isFile()) return;
      for (const label of hitsIn(fs.readFileSync(fd), canaries)) hits.push({ where: file, label });
    } finally { fs.closeSync(fd); }
  };
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOTDIR') return read(dir);
      if (GONE.includes(e.code)) return;
      throw e;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) read(file);
    }
  };
  for (const root of [].concat(roots)) visit(root);
  return hits;
}

function scanText(text, canaries, where) {
  return hitsIn(Buffer.from(String(text)), canaries).map((label) => ({ where, label }));
}

// What any process of the same user can list: every visible argv, through
// /proc and through ps -eww.
function processListing() {
  const parts = [];
  if (process.platform === 'linux') {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { parts.push(fs.readFileSync(`/proc/${name}/cmdline`).toString().replace(/\0/g, ' ')); } catch {
        // Exited while listing.
      }
    }
  }
  if (process.platform !== 'win32') {
    const r = cp.spawnSync('ps', ['-eww', '-o', 'args='], { encoding: 'utf8', timeout: 300000 });
    if (r.status === 0) parts.push(r.stdout);
  }
  return parts.join('\n');
}

// Empty files signal events; PID markers need content after file creation.
const waitFor = (file, { nonempty = false } = {}) => fileWritten(file, { check: (text) => !nonempty || text });

function assertNoHits(hits, what) {
  assert.deepEqual(hits.map((h) => `${h.label} in ${h.where}`), [], `secret canaries leaked into ${what}`);
}

module.exports = { make, scanTree, scanText, processListing, waitFor, assertNoHits };
