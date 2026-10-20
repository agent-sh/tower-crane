'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertFits } = require('../lib/socket-path');

function socketDir(t) {
  const root = process.env.TOWER_CRANE_SOCKET_DIR || os.tmpdir();
  assertFits(path.join(fs.realpathSync(root), 'tc-XXXXXX', 's'));
  const dir = fs.mkdtempSync(path.join(root, 'tc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

module.exports = { socketDir };
