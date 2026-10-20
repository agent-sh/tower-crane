'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertFits, MAX_SOCKET_PATH } = require('../lib/socket-path');

function socketDir(t, maxDirBytes = MAX_SOCKET_PATH - 2) {
  const roots = [process.env.TOWER_CRANE_SOCKET_DIR, os.tmpdir(), process.env.XDG_CACHE_HOME].filter((root) => root && path.isAbsolute(root));
  for (const root of [...new Set(roots)]) {
    let dir;
    try {
      const real = fs.realpathSync(root);
      const template = path.join(real, 'sXXXXXX');
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
  throw new Error(`no writable socket directory within ${maxDirBytes} bytes`);
}

module.exports = { socketDir };
