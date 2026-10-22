'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { refuse } = require('./util');

// macOS sun_path holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH = 103;

function assertFits(socket) {
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw refuse(`socket path exceeds ${MAX_SOCKET_PATH} bytes: ${socket}; set XDG_RUNTIME_DIR to a shorter directory`);
  return socket;
}

// Where socket directories go, in order: the per-user runtime directory, made
// for sockets; tc/ in the account's own ~/.cache, from the password database
// since HOME and XDG_CACHE_HOME can name a deep agent home or test root; then
// the leaf an enclosing sandbox granted, so a spawn inside a worker's sandbox
// still has one. Never /tmp or TMPDIR: a gate or test root nests TMPDIR deep,
// and /tmp is shared by every user.
function bases(env = process.env) {
  const out = [];
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) out.push({ dir: env.XDG_RUNTIME_DIR, make: false });
  try {
    out.push({ dir: path.join(os.userInfo().homedir, '.cache', 'tc'), make: true });
  } catch {
    // No password entry: the other bases are left.
  }
  if (env.TOWER_CRANE_SOCKET_DIR && path.isAbsolute(env.TOWER_CRANE_SOCKET_DIR)) out.push({ dir: env.TOWER_CRANE_SOCKET_DIR, make: false });
  return out;
}

// The resolved bases this user can write, each with why it was passed over
// when it cannot be: [{ dir, real }] or [{ dir, error }].
function roots(env = process.env) {
  const out = [];
  const seen = new Set();
  for (const { dir, make } of bases(env)) {
    try {
      if (make) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const real = fs.realpathSync(dir);
      fs.accessSync(real, fs.constants.W_OK);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ dir, real });
    } catch (e) {
      out.push({ dir, error: e.code || e.message });
    }
  }
  return out;
}

// The first writable root where root/name/rest fits, or a refusal naming each
// path tried with its length or error.
function pick(env, name, rest) {
  const tried = [];
  for (const root of roots(env)) {
    if (root.error) {
      tried.push(`${root.dir} (${root.error})`);
      continue;
    }
    const full = path.join(root.real, name, rest);
    const bytes = Buffer.byteLength(full);
    if (bytes <= MAX_SOCKET_PATH) return path.join(root.real, name);
    tried.push(`${full} (${bytes} bytes)`);
  }
  throw refuse(`no socket directory within ${MAX_SOCKET_PATH} bytes: tried ${tried.join(', ') || 'no base (no XDG_RUNTIME_DIR and no account home)'}; set XDG_RUNTIME_DIR to a short directory this user writes`);
}

// A home names one spawn. Grant its leaf, never the runtime or cache root.
// The leaf leaves room for a command's private child directory and socket
// filename. A route whose agents all reach the broker over TCP gets null when
// no leaf fits, instead of a refusal.
function agentDir(home, env, { tcp = false } = {}) {
  const name = `tc-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  try {
    return pick(env, name, path.join('tc-XXXXXX', 's'));
  } catch (e) {
    if (tcp) return null;
    throw e;
  }
}

// A fresh private directory for a broker with no granted leaf, holding its
// socket s. The caller removes it.
function freshDir(env = process.env) {
  const prefix = pick(env, 'tower-crane-XXXXXX', 's');
  return fs.mkdtempSync(path.join(path.dirname(prefix), 'tower-crane-'));
}

module.exports = { MAX_SOCKET_PATH, assertFits, bases, roots, agentDir, freshDir };
