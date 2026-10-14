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

// Live probes whose agent hides the user's own home keep their fixtures here,
// where only other live probes come and go. Every test process adds and
// removes fixtures and a harness guard in tempRoot, and Tower Crane's own
// spawns do the same in the cache's tower-crane directory. No sandbox lists
// those entries now (claude hides the home whole), so this is isolation, not
// a fix: a probe's agent sees none of another test's churn.
function liveRoot(env = process.env, platform = process.platform) {
  return path.join(cacheDir(env, platform), 'tower-crane-live');
}

module.exports = { tempRoot, liveRoot };
