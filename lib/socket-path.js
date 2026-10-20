'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { refuse } = require('./util');

// macOS sun_path holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH = 103;

function assertFits(socket) {
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw refuse(`socket path exceeds ${MAX_SOCKET_PATH} bytes: ${socket}; use a shorter TMPDIR or XDG_RUNTIME_DIR`);
  return socket;
}

// A home names one spawn. Grant its leaf, never the runtime or temp root.
function agentDir(home, env) {
  const name = `tc-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  const bases = [env.XDG_RUNTIME_DIR, os.tmpdir(), ...require('./gate-tmp').shortBases(env)];
  for (const base of [...new Set(bases.filter((p) => p && path.isAbsolute(p)))]) {
    let real;
    try {
      real = fs.realpathSync(base);
      fs.accessSync(real, fs.constants.W_OK);
    } catch {
      continue;
    }
    const dir = path.join(real, name);
    // Leave room for a command's private child directory and socket filename.
    if (Buffer.byteLength(path.join(dir, 'tc-XXXXXX', 's')) <= MAX_SOCKET_PATH) return dir;
  }
  throw refuse('no writable short socket directory; use a shorter TMPDIR or XDG_RUNTIME_DIR');
}

module.exports = { MAX_SOCKET_PATH, assertFits, agentDir };
