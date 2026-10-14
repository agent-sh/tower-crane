'use strict';

const os = require('node:os');
const path = require('node:path');

function cacheDir(env, platform) {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  return platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_CACHE_HOME || path.join(home, '.cache');
}

function tempRoot(env = process.env, platform = process.platform) {
  return env.TOWER_CRANE_TEST_TMP || env.TOWER_CRANE_TMP || path.join(cacheDir(env, platform), 'tower-crane', 'test-tmp');
}

// A live claude small agent whose home is the user's own hides every entry
// beside the path from that home to its worktree, as each entry was at spawn.
// One that goes while a command starts fails the command: bwrap cannot make
// its mount point under a read-only parent. Every test process adds and
// removes fixtures and a harness guard in tempRoot, and Tower Crane's own
// spawns do the same in the cache's tower-crane directory, so such a probe's
// fixtures live here instead, where only other live probes come and go.
function liveRoot(env = process.env, platform = process.platform) {
  return path.join(cacheDir(env, platform), 'tower-crane-live');
}

module.exports = { tempRoot, liveRoot };
