'use strict';

const path = require('node:path');

// A nested supervisor inherits an agent's writable cache, not the user's cache root.
function scratchRoot(env = process.env, home, platform = process.platform) {
  if (!home) home = require('./agents').origin(env).home;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const cache = platform === 'win32' ? env.LOCALAPPDATA : env.XDG_CACHE_HOME;
  const agentCache = cache && /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(paths.resolve(cache));
  const base = cache && paths.isAbsolute(cache) && !agentCache ? cache
    : paths.join(home, ...(platform === 'win32' ? ['AppData', 'Local'] : ['.cache']));
  return paths.join(base, 'tower-crane');
}

// Sandbox commands can write their private temp directory, not the shared origin cache.
function commandRoot(env = process.env, home, platform = process.platform) {
  if (env.TOWER_CRANE_TMP) return env.TOWER_CRANE_TMP;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.TOWER_CRANE_SANDBOX === '1') {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      if (env[key] && paths.isAbsolute(env[key])) return env[key];
    }
  }
  return scratchRoot(env, home, platform);
}

module.exports = { scratchRoot, commandRoot };
