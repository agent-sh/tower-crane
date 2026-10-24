'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const OWNER_FILE = '.tower-crane-test-owner.json';
// The full-suite gate allows 75 minutes; two hours leaves startup and teardown room.
const SWEEP_AGE_MS = 2 * 60 * 60 * 1000;

function pidNamespace() {
  if (process.platform !== 'linux') return null;
  try { return fs.readlinkSync('/proc/self/ns/pid'); }
  catch { return undefined; }
}

function markFixtureOwner(dir) {
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({
    pid: process.pid, host: os.hostname(), pidns: pidNamespace(), at: Date.now(),
  }), { flag: 'wx', mode: 0o600 });
}

function ownerGone(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.host !== os.hostname()) return false;
  // A live host PID can look absent inside a sandbox's different PID namespace.
  const pidns = pidNamespace();
  if (pidns === undefined || owner.pidns !== pidns) return false;
  try { require('./signals').killPid(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; }
  return false;
}

function fileBytes(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(file).reduce((sum, name) => sum + fileBytes(path.join(file, name)), 0);
}

function sameDirectory(dir, stat) {
  const current = fs.lstatSync(dir, { bigint: true });
  return current.isDirectory() && current.dev === stat.dev && current.ino === stat.ino;
}

function sameMarker(marker, stat) {
  const current = fs.lstatSync(marker, { bigint: true });
  return current.isFile() && current.dev === stat.dev && current.ino === stat.ino
    && current.size === stat.size && current.mtimeNs === stat.mtimeNs && current.ctimeNs === stat.ctimeNs;
}

function readOwner(marker, validDirectories) {
  // No-follow refuses a substituted link; nonblocking avoids waiting on a substituted FIFO.
  const fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    // Windows lacks no-follow, so check the opened handle against the current name before reading.
    if (!stat.isFile() || !validDirectories() || !sameMarker(marker, stat)) return null;
    const owner = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!validDirectories() || !sameMarker(marker, stat)) return null;
    return { owner, stat };
  } finally { fs.closeSync(fd); }
}

function sweepTempRoot(root = tempRoot(), now = Date.now()) {
  const result = { count: 0, bytes: 0 };
  let entries;
  let rootStat;
  try {
    // An explicitly linked root stays untouched, as do links among its entries.
    rootStat = fs.lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory()) return result;
    entries = fs.readdirSync(root);
  } catch { return result; }
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const dirStat = fs.lstatSync(dir, { bigint: true });
      if (!dirStat.isDirectory()) continue;
      const validDirectories = () => sameDirectory(root, rootStat) && sameDirectory(dir, dirStat);
      const marker = path.join(dir, OWNER_FILE);
      const record = readOwner(marker, validDirectories);
      if (!record) continue;
      const { owner, stat } = record;
      if (!owner || !Number.isFinite(owner.at) || owner.at <= 0 || now - owner.at <= SWEEP_AGE_MS || !ownerGone(owner)) continue;
      const bytes = fileBytes(dir);
      if (!validDirectories() || !sameMarker(marker, stat)) continue;
      // rm removes symlinks themselves; lstat-based accounting also avoids their targets.
      fs.rmSync(dir, { recursive: true, force: true });
      result.count++;
      result.bytes += bytes;
    } catch {
      // Missing, incomplete or inaccessible metadata cannot prove abandonment.
    }
  }
  return result;
}

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

module.exports = { tempRoot, liveRoot, markFixtureOwner, sweepTempRoot, SWEEP_AGE_MS, OWNER_FILE };
