'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertFits, roots, MAX_SOCKET_PATH } = require('../lib/socket-path');

// A fresh socket directory under the worker's TOWER_CRANE_SOCKET_DIR, then the
// broker's own socket bases (lib/socket-path.js), never TMPDIR, which a gate or
// test root nests too deep.
function socketDir(t, maxDirBytes = MAX_SOCKET_PATH - 2) {
  const own = process.env.TOWER_CRANE_SOCKET_DIR && path.isAbsolute(process.env.TOWER_CRANE_SOCKET_DIR)
    ? [process.env.TOWER_CRANE_SOCKET_DIR] : [];
  const tried = [];
  for (const root of [...new Set([...own, ...roots(process.env).filter((r) => r.real).map((r) => r.real)])]) {
    let dir;
    try {
      const real = fs.realpathSync(root);
      const template = path.join(real, 'sXXXXXX');
      tried.push(`${template} (${Buffer.byteLength(template)} bytes)`);
      if (Buffer.byteLength(template) > maxDirBytes) continue;
      assertFits(path.join(template, 's'));
      dir = fs.mkdtempSync(path.join(real, 's'));
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) continue;
      throw error;
    }
    t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return dir;
  }
  throw new Error(`no writable socket directory within ${maxDirBytes} bytes: tried ${tried.join(', ') || 'none'}`);
}

module.exports = { socketDir };
