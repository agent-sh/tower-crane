'use strict';

const os = require('node:os');
const path = require('node:path');

function tempRoot(env = process.env, platform = process.platform) {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const cache = platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_CACHE_HOME || path.join(home, '.cache');
  return env.TOWER_CRANE_TEST_TMP || env.TOWER_CRANE_TMP || path.join(cache, 'tower-crane', 'test-tmp');
}

module.exports = { tempRoot };
