'use strict';

// Where gates build their detached worktrees and scratch. TOWER_CRANE_TMP overrides the
// project's gates.tmp_root, and tower-crane/gates under the user's cache is the default.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIELDS = ['tmp_root'];

function valid(value) {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') && path.isAbsolute(value.trim());
}

function errors(gates) {
  return gates?.tmp_root != null && !valid(gates.tmp_root)
    ? ['project.json gates.tmp_root must be an absolute directory path or null'] : [];
}

// The default root is on disk, not in the OS temporary directory: /tmp is often a RAM-backed
// tmpfs, where a build tree competes with memory, and some suites refuse to run there (ginza's
// SSD campaign guard refuses dry media under /tmp or on tmpfs, so its local CI failed in a
// gate worktree under /tmp and passed under ~/.cache). The cache root is the user's own, also
// when the gate runs inside an agent's home (lib/agents.js cacheDir).
function cacheRoot(env = process.env) {
  const agents = require('./agents');
  const { home } = agents.origin(env);
  const cache = agents.cacheDir(env, home);
  // The XDG spec ignores a relative XDG_CACHE_HOME; a relative root would follow the caller's cwd.
  return path.join(path.isAbsolute(cache) ? cache : path.join(home, '.cache'), 'tower-crane', 'gates');
}

// The root and the setting that chose it: TOWER_CRANE_TMP, then gates.tmp_root, then the user cache.
function resolve(project, env = process.env) {
  if (env.TOWER_CRANE_TMP) return { root: env.TOWER_CRANE_TMP, source: 'TOWER_CRANE_TMP' };
  if (project?.gates?.tmp_root) return { root: project.gates.tmp_root, source: 'gates.tmp_root' };
  return { root: cacheRoot(env), source: 'cache' };
}

function root(project, env = process.env) {
  return resolve(project, env).root;
}

// Claude Code's Linux sandbox starts a socat bridge listening on a Unix socket in os.tmpdir(),
// named claude-http-<16 hex>.sock, or also claude-socks-<16 hex>.sock when the HTTP and SOCKS
// proxies use different ports. socat takes a socket path of at most 108 bytes. Measured with
// Claude Code 2.1.296: a 74-byte TMPDIR starts the bridge, a 75-byte one fails with "Failed to
// create bridge sockets after 5 attempts". The bound below uses the longer socks name, so a
// TMPDIR passes when it is at most 73 bytes.
const SOCKET_PATH_MAX = 108;
const HARNESS_SOCKET = 'claude-socks-0123456789abcdef.sock';

function harnessFits(dir) {
  return typeof dir === 'string' && Buffer.byteLength(path.join(dir, HARNESS_SOCKET)) <= SOCKET_PATH_MAX;
}

const HARNESS_TMPDIR_MAX = SOCKET_PATH_MAX - Buffer.byteLength(path.sep + HARNESS_SOCKET);

// Where a short harness TMPDIR can go: the user's own ~/.cache, which is on disk, then
// XDG_RUNTIME_DIR. The home comes from the password database, since HOME can name a deep fixture.
function shortBases(env = process.env) {
  const bases = [];
  try {
    bases.push(path.join(os.userInfo().homedir, '.cache'));
  } catch {
    // No password entry: only the runtime directory is left.
  }
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) bases.push(env.XDG_RUNTIME_DIR);
  return bases;
}

// The first base whose tc-XXXXXX directory fits the harness socket and can be written, or null.
function shortBase(env = process.env) {
  for (const base of shortBases(env)) {
    if (!harnessFits(path.join(base, 'tc-XXXXXX'))) continue;
    try {
      fs.mkdirSync(base, { recursive: true });
      fs.accessSync(base, fs.constants.W_OK);
      return base;
    } catch {
      // Not writable: the next base is tried.
    }
  }
  return null;
}

// A fresh private directory under base for one harness run; the caller removes it.
function harnessTmp(base) {
  return fs.mkdtempSync(path.join(base, 'tc-'));
}

module.exports = { FIELDS, valid, errors, cacheRoot, resolve, root, SOCKET_PATH_MAX, HARNESS_TMPDIR_MAX, harnessFits, shortBases, shortBase, harnessTmp };
