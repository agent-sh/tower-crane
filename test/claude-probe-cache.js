'use strict';

const path = require('node:path');
const { shortCacheRoot } = require('./helpers');
const { HARNESS_TMPDIR_MAX } = require('../lib/gate-tmp');

// The cache prefix must leave room for the private temp leaf and proxy socket.
function configureClaudeCache(t, env, allocate = shortCacheRoot) {
  const suffix = path.join(path.sep, 'tower-crane', 'tc', '0'.repeat(12));
  const max = HARNESS_TMPDIR_MAX - Buffer.byteLength(suffix);
  const cache = allocate(t, max);
  if (!cache) throw new Error(`no writable short cache root within ${max} bytes for Claude proxy sockets`);
  env.XDG_CACHE_HOME = cache;
  return cache;
}

module.exports = { configureClaudeCache };
