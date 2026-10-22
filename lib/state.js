'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('./util').lazy('node:crypto');
const { performance } = require('node:perf_hooks');
const Commands = require('./commands');
const { execFileSync } = Commands;
const { TowerCraneError, refuse, nowIso, sleepSync, sleepHooks } = require('./util');
const L = require('./ladder');
const Secrets = require('./secrets');
const EvidenceStore = require('./evidence-store');
const Intervals = require('./intervals');
const { fileStat, cutsFile, readCuts } = require('./event-reader');
const Db = require('./db');

const KINDS = ['code', 'docs', 'research', 'design', 'ops'];
const NEEDS = ['browser'];
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['todo', 'in_progress', 'submitted', 'accepted', 'rework', 'cancelled'];
const EVIDENCE_TYPES = ['tests', 'clean', 'sources', 'review', 'ci', 'merge', 'note'];
// What the asker says a decision is. Only technical is the orchestrator's to answer.
const DECISION_KINDS = ['technical', 'spend', 'credential', 'setting', 'crisis'];
const { HARNESSES, TIERS } = L;
// Additive fields and enum members keep this version. Changes that old
// readers cannot safely ignore must publish a higher version first.
const SCHEMA_VERSION = 2;

// Startup bursts share this bound with the existing stale-marker window.
// LOCK_WAIT_MS is the production wait; lockWaitMs() is the one in force (lib/intervals.js).
const LOCK_WAIT_MS = Intervals.DEFAULTS.lock_wait;
const LOCK_STALE_MS = 60000;
const lockWaitMs = () => Intervals.ms('lock_wait');

function git(args, cwd) {
  Commands.assertUnlocked('git');
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // A refused config scan is not a missing repository.
    if (e instanceof TowerCraneError) throw e;
    return null;
  }
}

// Git's absolute git directory (`own`) or common directory for `dir`,
// confirmed as repoAt confirms the common directory; null when git finds none.
function gitLocation(dir, which) {
  const out = git(['rev-parse', '--path-format=absolute', which === 'own' ? '--git-dir' : '--git-common-dir'], dir);
  if (!out) return null;
  Commands.confirmLocation(dir, process.env, { [which]: out });
  return out;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A command the state broker runs for a sandboxed agent runs no git: the
// repository's config and the commits in it are the agent's to write, and
// git can run commands they name (merge drivers, fsmonitor).
function repoAt(dir) {
  if (process.env.TOWER_CRANE_VIA === 'broker') return null;
  if (!isDir(dir)) return null;
  const out = git(['rev-parse', '--git-common-dir'], dir);
  if (!out) return null;
  // The state sits beside the common directory, so git's answer must be the
  // one found from files that a redirect could not change between lookups.
  Commands.confirmLocation(dir, process.env, { common: out });
  const commonDir = path.resolve(dir, out);
  // A bare repository has no main checkout, so its common dir stands in for one.
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { root, commonDir };
}

function locateStateDir(flag, env, cwd) {
  if (flag) return path.resolve(cwd, flag);
  if (env.TOWER_CRANE_STATE) return path.resolve(cwd, env.TOWER_CRANE_STATE);
  const repo = repoAt(cwd);
  if (!repo) {
    throw refuse('not inside a git repository; run tower-crane from the repo, or pass --state DIR or set TOWER_CRANE_STATE');
  }
  return path.join(repo.root, '.tower-crane');
}

// The repository tower-crane runs in wins; outside one, fall back to the repository
// that holds the state directory.
// The state directory travels with it: the worktree lock lives there (lib/worktree.js lockPath).
function findRepo(stateDir, cwd) {
  const repo = repoAt(cwd) || (stateDir ? repoAt(path.dirname(stateDir)) : null);
  return repo && stateDir ? { ...repo, stateDir } : repo;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// The lock is a directory, `lock`, holding one marker file named after its
// holder's random nonce, with its pid, host, process identity and time inside.
//
// - Taking it: the writer prepares a private directory with its marker and
//   renames it to `lock`. The rename fails while `lock` holds a marker, so a
//   holder's marker is in the lock from the moment it holds it, and no other
//   writer's rename can land until that marker is gone.
// - Breaking a stale one: unlink the stale marker by its own name, then rmdir
//   `lock`. Nonces are never reused, so a breaker that lost a race to another
//   breaker unlinks nothing; it cannot reach the marker of whoever took the
//   lock since. rmdir removes only an empty directory.
// - Releasing: the same two steps on the holder's own marker.
//
// Every removal names exactly what it removes, so no process acts on a lock it
// looked at earlier that has since been replaced, whatever the interleaving.
const MARKER_BYTES = 8;
const STAGING_RE = /^lock\.(\d+)\.([0-9a-f]{16})\.new$/;
// The errors a rename onto a held lock gives. Windows cannot rename onto any
// existing directory and reports that, and a directory still pending delete,
// as EPERM or EACCES.
const LOCK_BUSY = process.platform === 'win32'
  ? ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY']
  : ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'];
const LOCK_BACKOFF_MIN_MS = 10;
const LOCK_BACKOFF_MAX_MS = 100;
const LOCK_POLL_MS = 2;

function readMarker(file) {
  let fd;
  let stat;
  let raw;
  try {
    fd = fs.openSync(file, 'r');
    stat = fs.fstatSync(fd);
    raw = fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let holder = {};
  try {
    holder = JSON.parse(raw) || {};
  } catch {
    // Markers are complete before the lock appears, so only a hand edit gets here.
  }
  return { holder, mtimeMs: stat.mtimeMs };
}

// A pid means something only inside its pid namespace. Command sandboxes
// (bubblewrap, containers) give each command a namespace of its own on the
// same host, where another namespace's live holder looks gone, so breaking on
// it lets two writers hold the lock and one overwrite the other's update.
// Platforms without namespaces read null on both sides.
let ownPidNamespace;
function pidNamespace() {
  if (ownPidNamespace === undefined) {
    try {
      ownPidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    } catch {
      ownPidNamespace = null;
    }
  }
  return ownPidNamespace;
}

let ownBootId;
function bootId() {
  if (ownBootId === undefined) {
    try {
      ownBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      ownBootId = null;
    }
  }
  return ownBootId;
}

// When Windows created the process now at a pid, as UTC epoch ms (the
// FILETIME read of processes.windowsCreated), or null: off Windows, for a pid
// Windows does not let us read, or when PowerShell fails or runs out of time.
// Windows records no start ticks and gives a freed pid to a new process
// within seconds, so this time is what tells a lock holder from a process
// that took its pid. Windows PowerShell starts in about a second, so one call
// gets a few seconds. `cache` keeps each pid's last read and `gone` the
// holders, as "pid created", that a read proved gone.
const CREATED_READ_MS = 5000;
const processCreated = {
  read(pid) {
    if (process.platform !== 'win32') return null;
    const created = require('./processes').windowsCreated([pid], CREATED_READ_MS).get(pid);
    return Number.isFinite(created) ? created : null;
  },
  cache: new Map(),
  gone: new Set(),
};

// Our own creation time never changes, so it is read once.
function ownCreated() {
  if (!processCreated.cache.has(process.pid)) processCreated.cache.set(process.pid, { created: processCreated.read(process.pid), at: Date.now() });
  return processCreated.cache.get(process.pid).created;
}

// Whether the process now at `pid` is the one created at `created`: true,
// false, or null when its time cannot be read. A read only says which process
// had the pid when it ran: the holder seen then may have died since and its
// pid gone to a new process that took the same lock and wrote its own time.
// So a cached read is trusted only to keep a holder whose time it equals, and
// only for LOCK_STALE_MS, which bounds how long a waiter that read a holder
// before it died keeps its lock as it bounds a holder judged by marker age. A
// holder is judged gone only by a read made now, and stays gone: no live
// process has its pid and creation time.
function holderCreated(pid, created) {
  if (pid === process.pid) {
    const mine = ownCreated();
    return mine === null ? null : mine === created;
  }
  if (processCreated.gone.has(`${pid} ${created}`)) return false;
  const hit = processCreated.cache.get(pid);
  if (hit && Date.now() - hit.at < LOCK_STALE_MS) {
    if (hit.created === created) return true;
    if (hit.created === null) return null;
  }
  const now = processCreated.read(pid);
  processCreated.cache.set(pid, { created: now, at: Date.now() });
  if (now === null) return null;
  if (now !== created) processCreated.gone.add(`${pid} ${created}`);
  return now === created;
}

// `keepLive` keeps a holder whose pid is alive on this host and in this pid
// namespace whatever the marker's age, for a lock held across long commands;
// a start time or, on Windows, a creation time that no longer matches still
// marks it gone.
function lockIsStale(marker, keepLive = false) {
  const { pid, host, pidns, start_ticks, boot_id, created } = marker.holder;
  if (host === os.hostname()) {
    const boot = bootId();
    // A reboot also replaces pid namespaces; its old holders are all gone.
    if (boot_id && boot && boot_id !== boot) return true;
    if ((pidns ?? null) === pidNamespace() && Number.isInteger(pid) && pid > 0) {
      if (!pidAlive(pid)) return true;
      // Only Windows writes `created`; an unreadable time leaves the holder to
      // the checks below, as before markers carried it.
      if (Number.isFinite(created)) {
        const same = holderCreated(pid, created);
        if (same !== null) return !same;
      }
      if (process.platform === 'linux' && typeof start_ticks === 'string') {
        const state = require('./processes').processState({ pid, host, start_ticks });
        if (state === 'exited') return true;
        if (state === 'running') return false;
      }
      if (keepLive) return false;
    }
  }
  // Without a readable start identity, a live PID may belong to a replacement.
  return Date.now() - marker.mtimeMs > LOCK_STALE_MS;
}

function holderText(h) {
  return h && h.pid ? `pid ${h.pid} on ${h.host} since ${h.at}` : 'another process';
}

function removeQuietly(fn, target) {
  try {
    fn(target);
    return true;
  } catch {
    return false;
  }
}

// Markers of locks this process released but could not delete. Nonces are
// never reused, so a path here is never another holder's.
const releasedMarkers = new Set();

// The live holder of a marked lock, read without clearing anything, for
// readers such as status that must not write.
function markedLockHolder(dir, keepLive = false) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const marker = readMarker(path.join(dir, name));
    if (marker && !releasedMarkers.has(path.join(dir, name)) && !lockIsStale(marker, keepLive)) return marker.holder;
  }
  return null;
}

// One look at a lock we could not take: who holds it, and clear what is stale.
// progress is true when this call removed something, so the caller retries at
// once; stuck names a stale holder whose marker could not be removed.
function clearStale(dir, keepLive = false) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    // A plain file here is not a lock this version takes or breaks.
    if (e.code === 'ENOTDIR') return { progress: false, holder: (readMarker(dir) || {}).holder || null };
    return { progress: false, holder: null };
  }
  let progress = false;
  let holder = null;
  let stuck = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const marker = readMarker(file);
    if (!marker) continue;
    // This process released it, so whatever its age or holder's liveness it is
    // gone; it is still here because its deletion failed (a scanner holding it
    // open on Windows), and each look retries it.
    if (!releasedMarkers.has(file) && !lockIsStale(marker, keepLive)) {
      holder = marker.holder;
      continue;
    }
    try {
      fs.unlinkSync(file);
      releasedMarkers.delete(file);
      progress = true;
    } catch (e) {
      if (e.code === 'ENOENT') {
        releasedMarkers.delete(file);
        progress = true;
      } else stuck = { holder: marker.holder, code: e.code };
    }
  }
  if (!holder && !stuck && removeQuietly(fs.rmdirSync, dir)) progress = true;
  return { progress, holder, stuck };
}

function lockTimeout(dir, seen) {
  if (seen.stuck) {
    return new TowerCraneError(3, `state is locked by ${holderText(seen.stuck.holder)}, which is gone, but its lock could not be removed (${seen.stuck.code}); remove ${dir} by hand`);
  }
  return new TowerCraneError(3, `state is locked by ${holderText(seen.holder)}; retry, or remove ${dir} if that process is gone`);
}

// A writer killed while preparing leaves its directory behind. The pid in
// its name protects a live writer even before its marker exists, when a
// clock jump or suspension can make the directory appear old.
function sweepStaging(stateDir, names, re = STAGING_RE) {
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    if (pidAlive(Number(m[1]))) continue;
    const dir = path.join(stateDir, name);
    const marker = readMarker(path.join(dir, m[2]));
    let mtimeMs = marker ? marker.mtimeMs : null;
    if (mtimeMs === null) {
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) continue;
    removeQuietly(fs.unlinkSync, path.join(dir, m[2]));
    removeQuietly(fs.rmdirSync, dir);
  }
}

// stageAtomic's temp files. A writer killed between writing one and renaming
// it leaves it behind; as with staging directories, a live pid keeps it, and
// so does a recent one, which may belong to a writer in another pid namespace.
const TMP_RE = /^.+\.(\d+)\.[0-9a-f]{8}\.tmp$/;
function sweepTmp(stateDir, names) {
  for (const name of names) {
    const m = TMP_RE.exec(name);
    if (!m || pidAlive(Number(m[1]))) continue;
    const file = path.join(stateDir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || Date.now() - st.mtimeMs <= LOCK_STALE_MS) continue;
    } catch {
      continue;
    }
    removeQuietly(fs.unlinkSync, file);
  }
}

// TOWER_CRANE_LOCK_TRACE=FILE appends one line per lock holding: what took
// it, how long this process waited and held it, and how many event log bytes
// it read while holding it. Off by default.
function traceLock(lock) {
  const file = process.env.TOWER_CRANE_LOCK_TRACE;
  if (!file) return;
  const released = performance.now();
  try {
    fs.appendFileSync(file, JSON.stringify({
      pid: process.pid, argv: process.argv.slice(2, 5), label: lock.label || null, at: nowIso(),
      wait_ms: Math.round(lock.acquired - lock.started), hold_ms: Math.round(released - lock.acquired),
      event_bytes: eventBytesRead - lock.eventBytes,
    }) + '\n');
  } catch {
    // A trace is a measurement aid; it never fails the write it measures.
  }
}

// A synchronous waiter cannot be signalled by the holder's release, so while
// a live holder has the lock it checks for the lock directory every couple of
// milliseconds, one stat each, and tries again as soon as it is gone. The
// backoff only paces the heavier look at whether the holder is still alive.
function waitForRelease(dir, ms) {
  const until = performance.now() + ms;
  for (;;) {
    const left = until - performance.now();
    if (left <= 0 || !fs.existsSync(dir)) return;
    sleepSync(Math.min(left, LOCK_POLL_MS));
  }
}

// Locks this process holds now. A reader inside one reads files no rename can
// change under it.
let heldLocks = 0;

// `unwritableFails` makes a failure to write the private directory final at once.
// Windows reports a held lock as EPERM or EACCES on the rename, and also an
// unwritable state directory on the mkdir; without it both wait the deadline.
function acquireLock(stateDir, waitMs = lockWaitMs(), label = null, { unwritableFails = false } = {}) {
  const dir = path.join(stateDir, 'lock');
  const started = performance.now();
  const deadline = started + waitMs;
  const identity = require('./processes').identity(process.pid);
  const boot_id = bootId();
  let backoff = LOCK_BACKOFF_MIN_MS;
  let finalAttempt = false;
  // The last recovery another process's open file stopped, if any.
  let recovering = null;
  for (;;) {
    const nonce = crypto.randomBytes(MARKER_BYTES).toString('hex');
    const staging = path.join(stateDir, `lock.${process.pid}.${nonce}.new`);
    const marker = path.join(staging, nonce);
    const mine = path.join(dir, nonce);
    let prepared = false;
    let renaming = false;
    try {
      // Never reuse a directory another attempt might still be cleaning up.
      fs.mkdirSync(staging);
      prepared = true;
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, ...identity, boot_id, pidns: pidNamespace(), at: nowIso(), nonce }));
      renaming = true;
      fs.renameSync(staging, dir);
      // A sweeper in another pid namespace can see us as gone. The rename
      // can land on an empty directory if it removed our marker first.
      if (fs.existsSync(mine)) {
        const lock = { dir, nonce, file: mine, label, started, acquired: performance.now(), eventBytes: eventBytesRead };
        heldLocks++;
        try {
          const names = fs.readdirSync(stateDir);
          sweepStaging(stateDir, names);
          sweepTmp(stateDir, names);
          recoverCommit(stateDir, names);
        } catch (error) {
          releaseLock(lock);
          // Windows keeps an interrupted commit's file while another process
          // holds it open. That ends when the process closes it, so the lock
          // counts as busy: waiters retry and a try-lock reports exit 3.
          if (SHARING_BUSY.includes(error.code) || error.sharing) {
            recovering = error;
            throw Object.assign(new Error(error.message), { code: 'EBUSY', recovering: true });
          }
          throw error;
        }
        return lock;
      }
      removeQuietly(fs.rmdirSync, dir);
    } catch (e) {
      if (e.code === 'ENOENT' && !isDir(stateDir)) {
        throw refuse(`no tower-crane state at ${stateDir}; run tower-crane init --name N --goal G (or point --state at the right directory)`);
      }
      if (!e.recovering && e.code !== 'ENOENT' && (!LOCK_BUSY.includes(e.code) || unwritableFails && !renaming)) throw e;
    } finally {
      if (prepared) {
        removeQuietly(fs.unlinkSync, marker);
        removeQuietly(fs.rmdirSync, staging);
      }
    }
    const seen = clearStale(dir);
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      if (recovering && !seen.holder) {
        throw new TowerCraneError(3, `state is busy: another process holds an interrupted commit's file open (${recovering.message}); retry once it closes`);
      }
      // Reclaim at the deadline permits one attempt, never another retry loop.
      if (!seen.progress || finalAttempt) throw lockTimeout(dir, seen);
      finalAttempt = true;
    } else {
      const pause = Math.min(remaining, backoff + Math.floor(Math.random() * backoff));
      // Only a live holder's release is worth waking for; reclaims and
      // cleanup races keep the full backoff.
      if (seen.holder && !seen.progress) waitForRelease(dir, pause);
      else sleepSync(pause);
      backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
    }
  }
}

// Windows refuses to delete a file another process has open without
// FILE_SHARE_DELETE (a virus scanner, say), so retry briefly.
function unlinkRetry(file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) return false;
      sleepSync(25);
    }
  }
}

function releaseLock(lock) {
  heldLocks--;
  if (!unlinkRetry(lock.file)) releasedMarkers.add(lock.file);
  // Removes only an empty directory: a holder that took over since keeps its lock.
  removeQuietly(fs.rmdirSync, lock.dir);
  traceLock(lock);
}

// The state lock's scheme for another lock directory `dir`, one attempt at a
// time, so a caller waits in its own way (lib/worktree.js underWorktreeLock).
// Returns the lock when taken. Otherwise it clears what is stale, as the
// state lock does, and returns null; `keepLive` as in lockIsStale. It is not
// a state lock: readers do not count it, and the staging directory beside
// `dir` carries its name. A `label` puts its holdings in the lock trace,
// waited from `started` (a performance.now() time, default the taking).
function tryMarkedLock(dir, { keepLive = false, label = null, started = null } = {}) {
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  const nonce = crypto.randomBytes(MARKER_BYTES).toString('hex');
  const staging = path.join(parent, `${name}.${process.pid}.${nonce}.new`);
  const marker = path.join(staging, nonce);
  const mine = path.join(dir, nonce);
  let prepared = false;
  try {
    fs.mkdirSync(staging);
    prepared = true;
    fs.writeFileSync(marker, markerText(nonce));
    fs.renameSync(staging, dir);
    if (fs.existsSync(mine)) {
      const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.([0-9a-f]{16})\\.new$`);
      try { sweepStaging(parent, fs.readdirSync(parent), re); } catch { /* the next holder sweeps */ }
      const acquired = performance.now();
      return { dir, nonce, file: mine, label, started: started ?? acquired, acquired, eventBytes: eventBytesRead };
    }
    removeQuietly(fs.rmdirSync, dir);
  } catch (e) {
    if (!LOCK_BUSY.includes(e.code)) throw e;
  } finally {
    if (prepared) {
      removeQuietly(fs.unlinkSync, marker);
      removeQuietly(fs.rmdirSync, staging);
    }
  }
  clearStale(dir, keepLive);
  return null;
}

// A holder that cannot be judged by its pid (another host or pid namespace,
// or no start time) counts as gone LOCK_STALE_MS after its marker last
// changed, so a long holder touches it.
function refreshMarkedLock(lock) {
  const now = new Date();
  try { fs.utimesSync(lock.file, now, now); } catch { /* released, or taken over */ }
}

// Keeps a held marked lock's marker fresh until its release: every
// lock_refresh interval (lib/intervals.js) from a timer while the event loop runs, and from inside
// synchronous waits (sleepSync), which hold the timer, such as a wait for the
// worktree or state lock. A single long synchronous command, such as a git
// checkout, still holds both.
const lockRefreshMs = () => Intervals.ms('lock_refresh');
const freshLocks = new Set();
let freshTimer = null;

function touchFreshLocks() {
  const now = Date.now();
  for (const lock of freshLocks) {
    if (now - lock.touched < lockRefreshMs()) continue;
    lock.touched = now;
    refreshMarkedLock(lock);
  }
}

function keepMarkedLockFresh(lock) {
  lock.touched = Date.now();
  freshLocks.add(lock);
  sleepHooks.add(touchFreshLocks);
  if (!freshTimer) {
    freshTimer = setInterval(touchFreshLocks, lockRefreshMs());
    freshTimer.unref();
  }
}

function forgetFresh(lock) {
  if (!freshLocks.delete(lock) || freshLocks.size) return;
  sleepHooks.delete(touchFreshLocks);
  clearInterval(freshTimer);
  freshTimer = null;
}

// The marker of a lock that keeps a live holder (tryMarkedLock with keepLive,
// mkdirMarkedLock) records our creation time where Windows gives one, read
// once per process. The state lock writes its own marker without it: every
// command takes that lock, and a PowerShell call each would cost a second.
function markerText(nonce) {
  const created = ownCreated();
  return JSON.stringify({ pid: process.pid, ...require('./processes').identity(process.pid), ...(created !== null ? { created } : {}), boot_id: bootId(), pidns: pidNamespace(), at: nowIso(), nonce });
}

// Takes `dir` with mkdir, which fails on any directory there, empty or not,
// and then puts the marker in: the lock, or null when `dir` exists. Killed
// between the two steps, a holder leaves an empty directory that only a
// person removes.
function mkdirMarkedLock(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code === 'EEXIST') return null;
    throw e;
  }
  const nonce = crypto.randomBytes(MARKER_BYTES).toString('hex');
  const file = path.join(dir, nonce);
  try {
    fs.writeFileSync(file, markerText(nonce));
  } catch (e) {
    removeQuietly(fs.rmdirSync, dir);
    throw e;
  }
  return { dir, nonce, file };
}

function releaseMarkedLock(lock) {
  forgetFresh(lock);
  if (!unlinkRetry(lock.file)) releasedMarkers.add(lock.file);
  removeQuietly(fs.rmdirSync, lock.dir);
  if (lock.label) traceLock(lock);
}

function withLock(stateDir, fn, waitMs = lockWaitMs(), label = null, opts = {}) {
  const lock = acquireLock(stateDir, waitMs, label, opts);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// How long a caller waits for another process to close a file Windows
// refuses to open, replace or remove while that process holds it.
const SHARING_RETRY_MS = 2000;
// Windows refuses to open or stat a state file while a writer renames a new
// copy over it, with EPERM and sometimes EACCES or EBUSY, until the writer's
// handles close. Elsewhere these codes are a permission failure that no wait
// ends, so they fail at once. Exported so tests can inject the Windows refusal.
const SHARING_BUSY = process.platform === 'win32' ? ['EPERM', 'EACCES', 'EBUSY'] : [];

// A lock-free reader, such as the supervisor's periodic state read, waits a
// sharing refusal out as the writer's rename does, instead of failing the
// command or stopping a worker over another process's commit.
function sharingRetry(fn) {
  const deadline = Date.now() + SHARING_RETRY_MS;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!SHARING_BUSY.includes(e.code) || Date.now() > deadline) throw e;
      sleepSync(10);
    }
  }
}

// fs.existsSync reports false for a file Windows refuses mid-rename, which
// would read as a removed state directory.
function fileExists(file) {
  try {
    sharingRetry(() => fs.statSync(file));
    return true;
  } catch {
    return false;
  }
}

// Windows refuses to replace a file another process has open (a reader or
// fs.watch), so retry the rename briefly before giving up.
// A staged commit file is kept on failure: its events are already logged,
// so the next lock holder must still be able to rename it into place.
// settled, when given, is asked after each refusal whether another process
// has already put the same thing at `to`; the rename then has nothing left to
// do and ends without an error. Windows refuses a rename onto an existing
// directory with EPERM, which would otherwise be retried until the deadline.
function renameRetry(from, to, keep = false, settled = null) {
  const deadline = Date.now() + SHARING_RETRY_MS;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (settled && settled()) return;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) {
        if (!keep) {
          try {
            fs.unlinkSync(from);
          } catch {
            // Nothing to clean up.
          }
        }
        throw e;
      }
      sleepSync(25);
    }
  }
}

// A rename or a new file is durable only once its directory is synced.
// Windows cannot open a directory to sync it, and some file systems refuse
// the call; there the rename is as durable as the platform makes it.
const DIR_SYNC_UNSUPPORTED = ['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'];
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    if (!DIR_SYNC_UNSUPPORTED.includes(e.code)) throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeSynced(file, content) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes and syncs content beside file; renaming it over file publishes it.
function stageAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  writeSynced(tmp, content);
  return tmp;
}

function writeAtomic(file, content) {
  renameRetry(stageAtomic(file, content), file);
  syncDir(path.dirname(file));
}

// A commit that changes state files and logs events stages each file as
// `<name>.<last event id>.commit`, synced, before it appends the events. The
// append is the commit point: a holder that dies after it leaves staged files
// the next lock holder renames into place, and one that dies before it leaves
// files the next holder deletes.
// A commit's staged files are named by its last event id. Beside them,
// `commit.<id>.json` records the log's identity and size before the append
// and every event id the commit logs, so recovery can tell its own torn lines
// from anything another writer appended.
const COMMIT_RE = /^(project|tasks|decisions)\.json\.(E[0-9a-f-]{36})\.commit$/;
const MANIFEST_RE = /^commit\.(E[0-9a-f-]{36})\.json$/;
// The cut recovery is about to make to a commit's torn append, written before
// the cut and removed after the commit's other files. Tools before this file
// existed finish a recovery by removing the staged files and the manifest and
// leave this name alone, so it outlives them.
const CUT_RE = /^cut\.(E[0-9a-f-]{36})\.json$/;
const commitFile = (dir, key, id) => path.join(dir, `${key}.json.${id}.commit`);
const manifestFile = (dir, id) => path.join(dir, `commit.${id}.json`);
const cutFile = (dir, id) => path.join(dir, `cut.${id}.json`);

function readCut(dir, id) {
  try {
    const cut = JSON.parse(fs.readFileSync(cutFile(dir, id), 'utf8'));
    return Number.isSafeInteger(cut.size) && Number.isSafeInteger(cut.from) ? cut : null;
  } catch {
    return null;
  }
}

// The staged copies of one state file a commit left in dir, with their ids.
function stagedCommits(dir, key) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => COMMIT_RE.exec(name)).filter((m) => m?.[1] === key).map((m) => ({ file: path.join(dir, m[0]), id: m[2] }));
}

function logStat(dir) {
  try {
    // `ino` is the Number released tools write to and compare with a commit
    // manifest; `ino_exact` tells apart the Windows ids that Number rounds.
    const { size, dev, ino, mtimeMs, ctimeMs } = fileStat(path.join(dir, 'events.jsonl'));
    return { size, dev, ino: Number(BigInt(ino)), ino_exact: ino, mtimeMs, ctimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return { size: 0, dev: null, ino: null, ino_exact: null };
    throw e;
  }
}

function readManifest(dir, id) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile(dir, id), 'utf8'));
    return Number.isSafeInteger(m.size) && Array.isArray(m.ids) ? m : null;
  } catch {
    return null;
  }
}

// A commit whose last event is not in the log never reached its commit
// point, but a torn append can have left its first lines, and a final
// fragment that the next append's newline would turn into a valid line. The
// bytes after the commit's starting size are cut off only when the log is
// the same file and every line there, complete or torn, is one of the
// commit's own events; another writer's line keeps the log as it is.
function truncateTorn(dir, manifest) {
  if (!manifest) return;
  const last = manifest.ids.at(-1);
  const now = logStat(dir);
  // A manifest from a tool through 0.1.2 has only the Number inode, rounded as
  // that tool rounded it.
  const sameFile = typeof manifest.ino_exact === 'string' ? now.ino_exact === manifest.ino_exact : now.ino === manifest.ino;
  if (manifest.dev !== null && (now.dev !== manifest.dev || !sameFile)) return;
  if (now.size <= manifest.size) {
    // A holder that died after its cut and before recording it left the
    // cut beside the manifest; nothing was appended since.
    const cut = readCut(dir, last);
    if (cut && now.size === manifest.size) recordCut(dir, last, cut);
    return;
  }
  const own = new Set(manifest.ids);
  const fd = fs.openSync(path.join(dir, 'events.jsonl'), 'r+');
  let cut;
  try {
    const tail = Buffer.alloc(now.size - manifest.size);
    fs.readSync(fd, tail, 0, tail.length, manifest.size);
    // An append opens with a newline when it ends an earlier torn line.
    const lines = tail.toString('utf8').replace(/^\n/, '').split('\n');
    const fragment = lines.pop();
    for (const line of lines) {
      let id;
      try {
        id = JSON.parse(line).id;
      } catch {
        return;
      }
      if (!own.has(id)) return;
    }
    const id = topLevelId(fragment);
    if (id && !own.has(id)) return;
    const ends = [];
    for (let i = tail.indexOf(10); i !== -1; i = tail.indexOf(10, i + 1)) ends.push(manifest.size + i + 1);
    cut = { size: manifest.size, from: now.size, ends };
    // The cut is written down first, so a holder that dies right after it
    // leaves it for the next one to record.
    writeAtomic(cutFile(dir, last), JSON.stringify(cut));
    fs.ftruncateSync(fd, manifest.size);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  recordCut(dir, last, cut);
}

// After the cut, so a reader that sees the record also sees the shorter log;
// before the holder appends, so none has read past the cut into new events
// without the record there to send it back. A record is keyed by the last
// event id of the commit whose append was cut, so one already there, from a
// holder that died before removing its files, is not written twice, and two
// cuts of the same length at the same place are both recorded.
function recordCut(dir, id, cut) {
  const file = cutsFile(path.join(dir, 'events.jsonl'));
  const { cuts } = readCuts(path.join(dir, 'events.jsonl'));
  if (cuts.some((c) => c.id === id)) return;
  const fd = fs.openSync(file, 'a+');
  let size;
  try {
    size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      // A torn record must not swallow this one.
      if (last[0] !== 10) prefix = '\n';
    }
    fs.appendFileSync(fd, `${prefix}${JSON.stringify({ at: nowIso(), id, ...cut })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!size) syncDir(dir);
}

// The event id of a torn line, if it got that far: the `id` key of the
// outer object, never one inside `detail`.
function topLevelId(text) {
  let depth = 0;
  let key = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return null;
      const str = text.slice(i + 1, j);
      if (key === 'id' && depth === 1) return /^E[0-9a-f-]{36}$/.test(str) ? str : null;
      key = depth === 1 && text[j + 1] === ':' ? str : null;
      i = j;
    } else if (c === '{' || c === '[') {
      depth++;
      key = null;
    } else if (c === '}' || c === ']') {
      depth--;
    }
  }
  return null;
}

// A staged file that cannot be removed must stop the holder: left behind, it
// would make a later holder judge newer events against an old commit.
function removeStaged(file) {
  if (unlinkRetry(file)) return;
  let code;
  try {
    fs.unlinkSync(file);
    return;
  } catch (e) {
    if (e.code === 'ENOENT') return;
    code = e.code;
  }
  throw Object.assign(refuse(`cannot remove the interrupted commit file ${file}; remove it by hand once no other process holds it open`),
    { sharing: SHARING_BUSY.includes(code) });
}

function syncLog(dir) {
  // Windows flushes only a handle opened for writing.
  const fd = fs.openSync(path.join(dir, 'events.jsonl'), 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// After a failed commit: if its last event reached the log, the staged files
// stay for the next lock holder to rename into place; otherwise the torn
// append is cut off and the staged files are deleted.
function abortCommit(dir, staged, manifest) {
  if (lastLogged(dir)?.id === manifest.ids.at(-1)) return;
  truncateTorn(dir, manifest);
  for (const file of staged) removeStaged(file);
  // A manifest without staged files is never read again.
  unlinkRetry(manifestFile(dir, manifest.ids.at(-1)));
  unlinkRetry(cutFile(dir, manifest.ids.at(-1)));
}

// The last complete line of the event log; a torn final fragment is not a
// commit point.
function lastLogged(dir) {
  const file = path.join(dir, 'events.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (let span = 64 * 1024; ; span *= 4) {
      const start = Math.max(0, size - span);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const end = buf.lastIndexOf(10);
      const begin = end === -1 ? -1 : buf.lastIndexOf(10, end - 1);
      if (begin === -1 && start > 0) continue;
      if (end === -1) return null;
      try {
        return JSON.parse(buf.subarray(begin + 1, end).toString('utf8'));
      } catch {
        return null;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Runs under the lock before the holder reads anything. Only a holder that
// died leaves staged commit files, and nothing was appended after its events,
// so they are the log's last line when its commit point was reached.
function recoverCommit(dir, names) {
  const commits = new Map();
  const of = (id) => commits.get(id) || commits.set(id, { id, staged: [], manifest: false }).get(id);
  for (const name of names) {
    const m = COMMIT_RE.exec(name);
    if (m) of(m[2]).staged.push({ from: path.join(dir, name), to: path.join(dir, `${m[1]}.json`) });
    const n = MANIFEST_RE.exec(name);
    if (n) of(n[1]).manifest = true;
    const c = CUT_RE.exec(name);
    if (c) of(c[1]).cut = true;
  }
  if (!commits.size) return;
  // A newer tool raises the schema before it stages files this one may not
  // understand, so this one leaves them alone and refuses, as it refuses to
  // read that state. A project.json it cannot read is reported by the read
  // after recovery, as before.
  let project = null;
  try {
    project = JSON.parse(sharingRetry(() => fs.readFileSync(path.join(dir, 'project.json'), 'utf8')));
  } catch {
    // Not a newer schema, as far as this tool can tell.
  }
  assertSchema(project);
  const last = lastLogged(dir)?.id;
  for (const c of commits.values()) {
    if (c.staged.length && c.id === last) {
      // The renamed files must never be on disk without their events.
      syncLog(dir);
      for (const s of c.staged) renameRetry(s.from, s.to, true);
    } else if (c.staged.length) {
      truncateTorn(dir, readManifest(dir, c.id));
      for (const s of c.staged) removeStaged(s.from);
    } else if (c.cut) {
      // Every holder of this version records a cut before it removes the
      // commit's staged files, so a cut whose staged files are gone and that
      // has no record was finished by an older tool, which may have appended
      // since: readers judge it by the bytes they read (cutBack).
      const cut = readCut(dir, c.id);
      if (cut) recordCut(dir, c.id, { ...cut, late: true });
    }
    // A manifest without staged files is never read again, so its removal
    // never stops the holder; the cut goes last, once nothing else is left.
    if (c.manifest) unlinkRetry(manifestFile(dir, c.id));
    if (c.cut) unlinkRetry(cutFile(dir, c.id));
  }
  syncDir(dir);
}

// init keeps the state directory out of git, so version control holds no copy.
const REPAIR_HINT = 'restore the state directory from your own backup or from a tower-crane state export; git does not track it';

function readJson(file) {
  let raw;
  try {
    raw = sharingRetry(() => fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw refuse(`${path.basename(file)} is missing from ${path.dirname(file)}; restore it or run tower-crane init in a fresh state directory`);
    throw e;
  }
  return parseJson(file, raw);
}

function parseJson(file, raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message}); ${REPAIR_HINT}`);
  }
}

const isStr = (v) => typeof v === 'string';
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isNullOr = (v, check) => v === null || check(v);
const isInt = (v) => Number.isInteger(v);
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['project.json must hold an object'];
  if (p.version !== 1) errs.push('version must be 1');
  if (p.schema_version !== undefined && (!Number.isSafeInteger(p.schema_version) || p.schema_version < 1)) {
    errs.push('schema_version must be a positive safe integer');
  }
  if (!isNonEmpty(p.name)) errs.push('name must be a non-empty string');
  if (!isNonEmpty(p.goal)) errs.push('goal must be a non-empty string');
  if (!isNullOr(p.repo, isNonEmpty)) errs.push('repo must be null or "owner/repo"');
  if (!isNonEmpty(p.base)) errs.push('base must be a branch name');
  if (!isNonEmpty(p.standards)) errs.push('standards must be "default" or a path');
  if (p.owner_config_dir !== undefined
    && (!isNonEmpty(p.owner_config_dir) || !path.isAbsolute(p.owner_config_dir) || p.owner_config_dir.includes('\0'))) {
    errs.push('owner_config_dir must be an absolute path without NUL bytes');
  }
  if (p.roles !== undefined) errs.push('roles was replaced by harness and ladder (docs/state.md); remove roles, and add a ladder if the defaults do not fit');
  // Shape only: whether a rung can run may depend on the user file, which
  // can change under a project; spawn, ladder writes and validate check that.
  errs.push(...L.shapeErrors(p));
  errs.push(...require('./reviewer').errors(p.review));
  errs.push(...require('./research').errors(p.research));
  errs.push(...require('./gate-commands').errors(p.gates));
  errs.push(...require('./governor').errors(p.governor));
  if (p.merge !== undefined) {
    if (!p.merge || typeof p.merge !== 'object' || Array.isArray(p.merge)) errs.push('merge must be an object');
    else {
      for (const key of ['keep_branch', 'admin']) {
        if (p.merge[key] !== undefined && typeof p.merge[key] !== 'boolean') errs.push(`merge.${key} must be a boolean`);
      }
    }
  }
  if (p.decision_delegation !== undefined) {
    const delegation = p.decision_delegation;
    if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) {
      errs.push('decision_delegation must be an object');
    } else {
      for (const key of Object.keys(delegation)) {
        if (!['orchestrator_technical', 'orchestrator_escalated_questions'].includes(key)) errs.push(`decision_delegation.${key} is unknown`);
        else if (typeof delegation[key] !== 'boolean') errs.push(`decision_delegation.${key} must be a boolean`);
      }
    }
  }
  if (p.publish_policy !== undefined && require('./publish-policy').errors(p.publish_policy).length) {
    errs.push('publish_policy must be { conditions: [...] } naming known conditions');
  }
  const l = p.limits || {};
  if (!isInt(l.workers) || l.workers < 1) errs.push('limits.workers must be a positive integer');
  if (!isInt(l.lease_minutes) || l.lease_minutes < 1) errs.push('limits.lease_minutes must be a positive integer');
  if (l.paused !== undefined && (typeof l.paused !== 'string' || !l.paused.trim())) errs.push('limits.paused must be a non-blank reason');
  errs.push(...require('./containment').errors(p.resources));
  const b = p.budget || {};
  if (!isNullOr(b.hours, isNonNegNum)) errs.push('budget.hours must be null or a non-negative number');
  if (!isNullOr(b.tokens, isNonNegNum)) errs.push('budget.tokens must be null or a non-negative number');
  return errs;
}

function validateTask(t, errs) {
  const at = t && t.id ? t.id : 'a task';
  const bad = (m) => errs.push(`${at}: ${m}`);
  if (!t || typeof t !== 'object') return errs.push('every task must be an object');
  if (!/^T\d+$/.test(t.id)) bad('id must look like T1');
  if (!isNonEmpty(t.title)) bad('title must be a non-empty string');
  if (!isNonEmpty(t.kind)) bad('kind must be a non-empty string');
  if (t.needs !== undefined && (!Array.isArray(t.needs) || !t.needs.every(isNonEmpty))) bad('needs must be an array of capability names');
  if (!Array.isArray(t.acceptance) || !t.acceptance.every(isStr)) bad('acceptance must be an array of strings');
  if (!Array.isArray(t.depends_on) || !t.depends_on.every(isStr)) bad('depends_on must be an array of task ids');
  if (!Array.isArray(t.locks) || !t.locks.every(isNonEmpty) || new Set(t.locks).size !== t.locks.length) {
    bad('locks must be an array of unique non-empty resource names');
  }
  if (!isNullOr(t.environment, isNonEmpty)) bad('environment must be null or a non-empty label');
  if (!isNullOr(t.needs_owner, isNonEmpty)) bad('needs_owner must be null or a reason');
  if (t.needs_owner_by !== undefined && (!t.needs_owner || !t.needs_owner_by || !isNonEmpty(t.needs_owner_by.agent) || !isNonEmpty(t.needs_owner_by.role))) {
    bad('needs_owner_by must record the agent and role that set needs_owner');
  }
  if (!isNonEmpty(t.size)) bad('size must be a non-empty string');
  if (!isNonEmpty(t.tier)) bad('tier must be a non-empty string');
  // Like tier and status, an unfamiliar value from a newer tool loads and orders as normal.
  if (t.priority !== undefined && !isNonEmpty(t.priority)) bad('priority must be a non-empty string when set');
  if (t.tier_range !== undefined) {
    const range = t.tier_range;
    if (!range || !isNonEmpty(range.min) || !isNonEmpty(range.max)
      || [range.min, range.max, t.tier].every((tier) => TIERS.includes(tier))
        && (!L.tierSpec(`${range.min}..${range.max}`)
          || TIERS.indexOf(t.tier) < TIERS.indexOf(range.min) || TIERS.indexOf(t.tier) > TIERS.indexOf(range.max))) bad('tier_range must be { min, max } containing the current tier');
  }
  if (t.escalation_pending !== undefined && typeof t.escalation_pending !== 'boolean') bad('escalation_pending must be boolean');
  if (t.escalations !== undefined && (!Array.isArray(t.escalations) || t.escalations.some((e) => !e || !isNonEmpty(e.source) || !isNonEmpty(e.from) || !isNullOr(e.to, isNonEmpty) || !isNonEmpty(e.reason)))) bad('escalations must record source, from, to and reason');
  if (!isNonEmpty(t.status)) bad('status must be a non-empty string');
  if (t.claim !== null) {
    const c = t.claim;
    if (!c || !isNonEmpty(c.agent) || !isStr(c.since) || !isStr(c.until)) bad('claim must be null or { agent, since, until }');
  }
  if (t.status === 'in_progress' && !t.claim) bad('an in_progress task needs a claim');
  if (!isNullOr(t.branch, isNonEmpty)) bad('branch must be null or a branch name');
  if (!isNullOr(t.pr, (v) => isInt(v) && v > 0)) bad('pr must be null or a pull request number');
  if (!isNullOr(t.sha, isNonEmpty)) bad('sha must be null or a commit hash');
  if (!isNullOr(t.submitted_by, isNonEmpty)) bad('submitted_by must be null or an agent');
  if (t.retiring !== undefined && t.retiring !== null) {
    const r = t.retiring;
    if (!r || !isStr(r.since) || !Number.isInteger(r.pid) || r.pid <= 0 || !isNonEmpty(r.host)) bad('retiring must be null or { since, pid, host }');
  }
  if (t.stack !== undefined && t.stack !== null) {
    const s = t.stack;
    if (!s || !/^T\d+$/.test(s.parent) || !isNonEmpty(s.base) || !isNonEmpty(s.repo)
      || !isNonEmpty(s.parent_sha) || !isNonEmpty(s.synced_base) || typeof s.linked !== 'boolean') {
      bad('stack must hold parent, base, repo, parent_sha, synced_base and linked');
    }
  }
  if (t.stack_disabled !== undefined && typeof t.stack_disabled !== 'boolean') bad('stack_disabled must be a boolean');
  if (t.github_stack != null && (typeof t.github_stack !== 'object' || Array.isArray(t.github_stack))) bad('github_stack must be an object or null');
  if (t.ci_dispatches !== undefined && (!Array.isArray(t.ci_dispatches) || t.ci_dispatches.some((d) => !d || !isNonEmpty(d.sha)
    || !isNonEmpty(d.branch) || !isNonEmpty(d.workflow) || !isNonEmpty(d.agent) || !Number.isFinite(Date.parse(d.at))
    || !isNullOr(d.run, (v) => isInt(v) && v > 0)))) bad('ci_dispatches must record sha, branch, workflow, at, agent and run (null or a run id)');
  // A bulk field no one read since its row was checked is as it was then.
  if (bulkUnread(t, 'evidence')) { /* checked when written */ } else if (!Array.isArray(t.evidence)) bad('evidence must be an array');
  else {
    for (const e of t.evidence) {
      // An unfamiliar receipt cannot satisfy a known gate. Its payload is
      // owned by the tool that wrote that evidence type.
      if (e && isNonEmpty(e.type) && !EVIDENCE_TYPES.includes(e.type)) continue;
      if (e?.confirmed_failure !== undefined && typeof e.confirmed_failure !== 'boolean') bad('confirmed_failure must be a boolean');
      if (!e || !EVIDENCE_TYPES.includes(e.type) || typeof e.ok !== 'boolean' || !isNonEmpty(e.agent) || !isInt(e.revision)) {
        bad(`evidence entries need type (${EVIDENCE_TYPES.join(', ')}), ok, agent and revision`);
        break;
      }
    }
  }
  if (!isInt(t.revision) || t.revision < 1) bad('revision must be a positive integer');
  if (t.budget !== undefined && (!t.budget || typeof t.budget !== 'object'
    || !isNullOr(t.budget.hours, isNonNegNum) || !isNullOr(t.budget.tokens, isNonNegNum))) {
    bad('budget must be { hours, tokens }, each null or a non-negative number');
  }
  if (bulkUnread(t, 'spend')) { /* checked when written */ } else if (!t.spend || !isNonNegNum(t.spend.minutes) || !Number.isSafeInteger(t.spend.tokens) || t.spend.tokens < 0) bad('spend must be { minutes, tokens }, with non-negative safe integer tokens');
  else {
    for (const key of ['input', 'cached', 'output']) {
      if (t.spend[key] !== undefined && (!Number.isSafeInteger(t.spend[key]) || t.spend[key] < 0)) bad(`spend.${key} must be a non-negative safe integer`);
    }
    if (t.spend.entries !== undefined) {
      if (!Array.isArray(t.spend.entries)) bad('spend.entries must be an array');
      else for (const entry of t.spend.entries) {
        if (!entry || !isNonEmpty(entry.at) || !isNonEmpty(entry.agent) || !isNonEmpty(entry.source) || !isNonNegNum(entry.minutes)) {
          bad('spend entries need at, agent, source and minutes');
          continue;
        }
        for (const key of ['tokens', 'input', 'cached', 'output']) {
          if (entry[key] !== null && (!Number.isSafeInteger(entry[key]) || entry[key] < 0)) bad(`spend entry ${key} must be null or a non-negative safe integer`);
        }
        if (entry.cost_usd !== undefined && !isNullOr(entry.cost_usd, isNonNegNum)) bad('spend entry cost_usd must be null or a non-negative number');
        if (!isNullOr(entry.rung, isNonEmpty)) bad('spend entry rung must be null or a ladder rung');
        if (!isNullOr(entry.harness, isNonEmpty)) bad('spend entry harness must be null or a harness');
        for (const key of ['model', 'profile']) if (!isNullOr(entry[key], isNonEmpty)) bad(`spend entry ${key} must be null or a non-empty string`);
        if (entry.live !== undefined && (!entry.live || !isNonEmpty(entry.live.state)
          || !Number.isSafeInteger(entry.live.interval_ms) || entry.live.interval_ms < 1)) {
          bad('spend entry live must have a non-empty state and positive integer interval_ms');
        }
        if (entry.live?.error !== undefined && !isNonEmpty(entry.live.error)) {
          bad('spend entry live.error must be a non-empty error class');
        }
        if (entry.provider !== undefined && !isNonEmpty(entry.provider)) bad('spend entry provider must be a non-empty string');
        if (entry.billing !== undefined && !isNullOr(entry.billing, (v) => v === 'api' || v === 'subscription')) bad('spend entry billing must be api, subscription or null');
        if (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.some((row) => !row
          || !isNullOr(row.model, isNonEmpty) || ['tokens', 'input', 'cached', 'output'].some((key) => row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0))))) {
          bad('spend entry models must list { model, tokens, input, cached, output } rows, each count null or a non-negative safe integer');
        }
      }
    }
  }
  if (!bulkUnread(t, 'notes') && !Array.isArray(t.notes)) bad('notes must be an array');
}

function validateTasks(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['tasks.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (doc.last_event !== undefined && !isNullOr(doc.last_event, isNonEmpty)) errs.push('last_event must be null or an event id');
  if (doc.orchestrator_lease != null) {
    const lease = doc.orchestrator_lease;
    if (!isNonEmpty(lease.session_id) || !isNonEmpty(lease.agent) || !isInt(lease.pid) || lease.pid < 1
      || !isNonEmpty(lease.host) || !isNonEmpty(lease.heartbeat) || !Number.isFinite(Date.parse(lease.heartbeat))
      || !isNullOr(lease.harness_session_id, isNonEmpty)) errs.push('orchestrator_lease must hold session_id, harness_session_id, agent, pid, host and heartbeat');
  }
  if (!Array.isArray(doc.tasks)) return errs.concat('tasks must be an array');
  const seen = new Set();
  for (const t of doc.tasks) {
    validateTask(t, errs);
    if (t && t.id) {
      if (seen.has(t.id)) errs.push(`${t.id}: duplicate id`);
      seen.add(t.id);
    }
  }
  return errs;
}

function validateDecisions(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['decisions.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (!Array.isArray(doc.decisions)) return errs.concat('decisions must be an array');
  const seen = new Set();
  for (const d of doc.decisions) {
    const at = d && d.id ? d.id : 'a decision';
    if (!d || !/^D\d+$/.test(d.id)) errs.push(`${at}: id must look like D1`);
    else if (seen.has(d.id)) errs.push(`${d.id}: duplicate id`);
    else seen.add(d.id);
    if (!d) continue;
    if (!isNonEmpty(d.question)) errs.push(`${at}: question must be a non-empty string`);
    if (!Array.isArray(d.options) || !d.options.every(isNonEmpty)) errs.push(`${at}: options must be an array of strings`);
    if (!Array.isArray(d.blocks) || !d.blocks.every(isStr)) errs.push(`${at}: blocks must be an array of task ids`);
    if (!Array.isArray(d.answerers) || !d.answerers.every(isNonEmpty)) errs.push(`${at}: answerers must be an array of agent names`);
    else {
      if (new Set(d.answerers).size !== d.answerers.length) errs.push(`${at}: answerers must be distinct`);
      if (d.answerers.some((agent) => ['owner', 'orchestrator'].includes(agent))) {
        errs.push(`${at}: owner and orchestrator cannot be named answerers`);
      }
    }
    if (typeof d.technical !== 'boolean') errs.push(`${at}: technical must be a boolean`);
    if (d.kind !== undefined && d.kind !== null && !DECISION_KINDS.includes(d.kind)) {
      errs.push(`${at}: kind must be one of ${DECISION_KINDS.join(', ')}`);
    }
    if ((d.kind === 'crisis') !== (d.crisis !== undefined && d.crisis !== null) || (d.crisis != null && !isNonEmpty(d.crisis))) {
      errs.push(`${at}: a crisis decision, and only one, names its crisis class`);
    }
    if (d.owner_required !== undefined && d.owner_required !== null && !isNonEmpty(d.owner_required)) {
      errs.push(`${at}: owner_required must be a non-empty string`);
    }
    if (d.answer_rule !== undefined && d.answer_rule !== null
      && !isNonEmpty(d.answer_rule)) {
      errs.push(`${at}: answer_rule must be a non-empty string`);
    }
    if (!isNonEmpty(d.status)) errs.push(`${at}: status must be a non-empty string`);
    if (d.status === 'answered' && !isNonEmpty(d.answer)) errs.push(`${at}: an answered decision needs an answer`);
    if (d.status === 'withdrawn' && !(isNonEmpty(d.withdrawn_by) && isNonEmpty(d.withdraw_reason))) {
      errs.push(`${at}: a withdrawn decision needs withdrawn_by and withdraw_reason`);
    }
  }
  return errs;
}

// Fields added after the first files were written default here, so older
// files keep loading.
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  const defaults = {
    kind: 'code', needs: [], acceptance: [], depends_on: [], locks: [], environment: null, needs_owner: null, size: 'M',
    claim: null, branch: null, pr: null, sha: null, submitted_by: null, evidence: [], revision: 1, notes: [],
  };
  // A bulk field still unread is in its row; reading it would parse it.
  for (const [k, v] of Object.entries(defaults)) if (!bulkUnread(t, k) && t[k] === undefined) t[k] = Array.isArray(v) ? [] : v;
  if (t.tier === undefined) t.tier = L.defaultTier(t.kind, t.size);
  // tier replaced role; a stale role would read as if it still chose the model.
  delete t.role;
  if (!bulkUnread(t, 'spend') && !t.spend) t.spend = { minutes: 0, tokens: 0 };
  return t;
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return d;
  const defaults = {
    options: [], recommendation: null, why: null, blocks: [], answer: null, note: null,
    answerers: [], technical: false, answered_by: null, answered_at: null, answer_rule: null,
    withdrawn_by: null, withdrawn_at: null, withdraw_reason: null,
  };
  for (const [k, v] of Object.entries(defaults)) if (d[k] === undefined) d[k] = Array.isArray(v) ? [] : v;
  return d;
}

function checkOrRefuse(file, errs) {
  if (errs.length) throw refuse(`${file} is invalid: ${errs.join('; ')}; ${REPAIR_HINT}`);
}

function assertSchema(project) {
  const version = project?.schema_version ?? 1;
  if (Number.isSafeInteger(version) && version > SCHEMA_VERSION) {
    throw Object.assign(refuse(`state schema ${version} is incompatible with this tool (supports through ${SCHEMA_VERSION}); upgrade Tower Crane before reading or writing this project`),
      { stateIncompatible: true });
  }
}

// The three state files of the file layout, parsed and validated, so a
// migration refuses a layout that every read of it refused.
function readFiles(dir) {
  const project = readJson(path.join(dir, 'project.json'));
  assertSchema(project);
  checkOrRefuse('project.json', validateProject(project));
  const tasks = readJson(path.join(dir, 'tasks.json'));
  if (tasks && Array.isArray(tasks.tasks)) tasks.tasks.forEach(normalizeTask);
  checkOrRefuse('tasks.json', validateTasks(tasks));
  const decisions = readJson(path.join(dir, 'decisions.json'));
  if (decisions && Array.isArray(decisions.decisions)) decisions.decisions.forEach(normalizeDecision);
  checkOrRefuse('decisions.json', validateDecisions(decisions));
}

// A migrated state directory keeps a project.json that names the database.
// Its schema is above every released tool's, and each of them refuses a
// state directory whose project.json is newer before reading anything else.
// It also names the owner's credential directory, which a 0.1 tool checks
// first for a headless owner, so that owner meets the schema refusal too.
const isMarker = (project) => project?.storage === Db.FILE;
const storageMarker = (project) => json({ version: 1, schema_version: SCHEMA_VERSION, storage: Db.FILE,
  ...(typeof project?.owner_config_dir === 'string' ? { owner_config_dir: project.owner_config_dir } : {}) });

// Lines of a file layout log that its readers skipped (an older tool's
// progress, a blank or torn line) stay lines; every JSON object is an event,
// given its recipient.
function legacyEvent(line) {
  const e = parseEvent(line);
  if (!e) return null;
  if (e.to === undefined) e.to = e.cmd === 'msg' ? e.detail?.to : 'orchestrator';
  return e;
}

const LEGACY_FILES = ['tasks.json', 'decisions.json', 'events.jsonl', 'events.cuts.jsonl'];

function readBytes(file) {
  try {
    return sharingRetry(() => fs.readFileSync(file));
  } catch (e) {
    if (e.code === 'ENOENT') return Buffer.alloc(0);
    throw e;
  }
}

// Builds a database at a temp name the next lock holder sweeps if this one
// dies (sweepTmp), then renames it into place.
function buildInPlace(dir, input) {
  const target = Db.file(dir);
  const building = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    Db.build(building, input);
    // A database from a migration that died before its marker, and its log,
    // must not meet the new one.
    for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
    renameRetry(building, target);
  } finally {
    fs.rmSync(building, { force: true });
  }
  syncDir(dir);
}

// Moves a file layout into the database, under the lock, after lock
// recovery finished or discarded any interrupted commit. The marker written
// over project.json is the commit point. The old files then move into
// legacy/<time>/, which keeps them for the owner and nothing reads.
function migrateLocked(dir) {
  const projectFile = path.join(dir, 'project.json');
  const current = readJson(projectFile);
  assertSchema(current);
  if (isMarker(current)) return finishMigration(dir);
  readFiles(dir);
  const { tasks: list, ...envelope } = readJson(path.join(dir, 'tasks.json'));
  buildInPlace(dir, {
    docs: {
      project: JSON.stringify({ ...current, schema_version: SCHEMA_VERSION }),
      tasks: JSON.stringify(envelope),
      decisions: JSON.stringify(readJson(path.join(dir, 'decisions.json'))),
    },
    tasks: list.map((t) => ({ id: t.id, status: String(t.status), ...Db.split(t) })),
    log: readBytes(path.join(dir, 'events.jsonl')),
    cuts: readBytes(path.join(dir, 'events.cuts.jsonl')),
    parse: legacyEvent,
    legacy: { dir: path.join('legacy', nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')), project: readBytes(projectFile).toString('utf8') },
  });
  writeAtomic(projectFile, storageMarker(current));
  finishMigration(dir);
}

// Moves the old files a migration left into legacy/<time>/, with the
// project.json the marker replaced, also after a holder that died past its
// marker.
function finishMigration(dir) {
  const legacy = Db.legacy(dir);
  if (!legacy) return;
  fs.mkdirSync(path.join(dir, legacy.dir), { recursive: true });
  if (!fileExists(path.join(dir, legacy.dir, 'project.json'))) writeAtomic(path.join(dir, legacy.dir, 'project.json'), legacy.project);
  for (const name of LEGACY_FILES) {
    if (fileExists(path.join(dir, name))) renameRetry(path.join(dir, name), path.join(dir, legacy.dir, name));
  }
  syncDir(path.join(dir, legacy.dir));
  syncDir(dir);
  Db.markMoved(dir);
}

const opened = new Set();

// The state's database, migrating a file layout first. A process that cannot
// write the state directory (a sandboxed agent) cannot migrate it.
function open(dir) {
  const key = path.resolve(dir);
  const projectFile = path.join(key, 'project.json');
  // A newer tool marks its schema in the marker first, so every read checks it.
  if (opened.has(key) && Db.handle(key)) {
    if (fileExists(projectFile)) assertSchema(readJson(projectFile));
    return;
  }
  if (!fileExists(projectFile)) {
    throw refuse(`no tower-crane state at ${dir}; run tower-crane init --name N --goal G (or point --state at the right directory)`);
  }
  const marker = readJson(projectFile);
  assertSchema(marker);
  if (!isMarker(marker) || Db.handle(key) && Db.legacy(key)) {
    try {
      withLock(key, () => migrateLocked(key), LOCK_WAIT_MS, 'migrate', { unwritableFails: true });
    } catch (e) {
      if (!['EROFS', 'EACCES', 'EPERM'].includes(e.code)) throw e;
      if (!isMarker(marker)) {
        throw refuse(`the state at ${dir} is in the file layout of tower-crane 0.1, and this process cannot write it to move it into ${Db.FILE}; run any tower-crane command where the state directory is writable`);
      }
    }
  }
  if (!Db.handle(key)) {
    throw refuse(`${Db.file(key)} is missing, and project.json marks this state as moved into it; restore the state directory from a backup or from a tower-crane state export`);
  }
  opened.add(key);
}

// Builds a new state directory's database from its first documents and
// events. The marker goes last: its presence marks the state as initialized.
function create(dir, { project, tasks, decisions, events }) {
  sealEvents(events);
  const { tasks: list, ...envelope } = tasks;
  buildInPlace(dir, {
    docs: { project: JSON.stringify(project), tasks: JSON.stringify(envelope), decisions: JSON.stringify(decisions) },
    tasks: list.map((t) => ({ id: t.id, status: String(t.status), ...Db.split(t) })),
    log: Buffer.from(events.map((e) => JSON.stringify(e) + '\n').join('')),
    cuts: Buffer.alloc(0),
    parse: JSON.parse,
    legacy: null,
  });
  writeAtomic(path.join(dir, 'project.json'), storageMarker(project));
}

function parseDoc(name, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw refuse(`${name} in ${Db.FILE} is not valid JSON (${e.message}); ${REPAIR_HINT}`);
  }
}

// A task from its row. The bulk fields (Db.BULK) stay unparsed until first
// read, and their text unread until then when the row came without it: it is
// read then by the row's commit, through the view the row was read in, or,
// for a row a holder of the state lock read, directly until the holder binds
// it to a view after its last commit (bindRows). A field read becomes a plain
// value; one never read keeps its getter, which is how a commit knows it is
// unchanged without laying it out again.
const rowsOf = new WeakMap();

// Per state directory: rows without their bulk that no view holds yet, and
// the open views with the rows each still holds.
const unread = new Map();
// Views a process keeps open at once. A one-shot command opens one or two;
// past this, the oldest view's rows read their bulk and it closes.
const VIEWS = 8;
// How long a view stays open. A command that runs longer, such as one that
// waits on a gate's suite, would hold back every other process's checkpoint
// meanwhile, so its rows read their bulk then and the view closes. The timer
// does not keep a process alive; most commands exit before it fires.
const VIEW_MS = 2000;

// `dir` is resolved once per read, not per row.
const resolved = new Map();
function unreadOf(dir) {
  let key = resolved.get(dir);
  if (!key) resolved.set(dir, key = path.resolve(dir));
  let u = unread.get(key);
  if (!u) {
    u = { unbound: new Set(), views: [] };
    unread.set(key, u);
  }
  return u;
}

function trackRow(dir, row, view) {
  const u = unreadOf(dir);
  if (!view) {
    u.unbound.add(row);
    return;
  }
  let entry = u.views.find((v) => v.view === view);
  if (!entry) {
    entry = { view, rows: new Set(), timer: null };
    u.views.push(entry);
    entry.timer = setTimeout(() => {
      const at = u.views.indexOf(entry);
      if (at !== -1) closeEntry(dir, u.views.splice(at, 1)[0]);
    }, VIEW_MS);
    entry.timer.unref?.();
    while (u.views.length > VIEWS) closeEntry(dir, u.views.shift());
  }
  row.view = view;
  entry.rows.add(row);
}

function closeEntry(dir, entry) {
  clearTimeout(entry.timer);
  for (const row of entry.rows) if (row.bulk === null) row.bulk = Db.taskBulk(dir, row.id, row.rev, entry.view);
  entry.rows.clear();
  Db.closeView(entry.view);
}

// A view holds back the log's checkpoint for every commit after its own, and
// the log starts over only once one has nothing left to copy. So a holder of
// the state lock closes its process's views before it writes. A row whose
// task was written since its view reads its bulk from it first; the others
// still hold the current text, read directly while the lock is held, and
// bindRows gives them the next view.
function releaseViews(dir) {
  const u = unread.get(path.resolve(dir));
  if (!u || !u.views.length) return;
  for (const entry of u.views.splice(0)) {
    clearTimeout(entry.timer);
    const changed = new Set(Db.bulkSince(dir, entry.view.rev));
    for (const row of entry.rows) {
      if (row.bulk !== null) continue;
      if (changed.has(row.id)) row.bulk = Db.taskBulk(dir, row.id, row.rev, entry.view);
      else {
        row.view = null;
        u.unbound.add(row);
      }
    }
    entry.rows.clear();
    Db.closeView(entry.view);
  }
}

// Reads the bulk of the rows a holder of the state lock is about to write
// over, while it still can: a snapshot read earlier may still read them.
// A row a discarded read left (one taken before the lock that a fresh read
// replaced) may name a commit since written over; nothing reads it.
function keepBulk(dir, ids) {
  const u = unread.get(path.resolve(dir));
  if (!u || !ids.size) return;
  const rows = [...u.unbound].filter((row) => row.bulk === null && ids.has(row.id));
  const revs = Db.bulkRevs(dir, [...new Set(rows.map((row) => row.id))]);
  for (const row of rows) {
    if (revs.get(row.id) === row.rev) row.bulk = Db.taskBulk(dir, row.id, row.rev);
    u.unbound.delete(row);
  }
}

// A row a catch-up replaced is no longer anyone's to read.
function forgetRow(dir, row) {
  if (!row || row.bulk !== null) return;
  const u = unreadOf(dir);
  u.unbound.delete(row);
  u.views.find((v) => v.view === row.view)?.rows.delete(row);
}

// Gives the rows a holder of the state lock read without their bulk a view
// of the commit it holds, before it releases the lock.
function bindRows(dir) {
  const u = unread.get(path.resolve(dir));
  if (!u || !u.unbound.size) return;
  const view = Db.openView(dir);
  for (const row of u.unbound) trackRow(dir, row, view);
  u.unbound.clear();
}

// Closes every view of dir, reading the bulk its rows still lack, before
// the database closes (a test does that before it removes its fixtures).
Db.onClose((dir) => {
  const u = unread.get(dir);
  if (!u) return;
  unread.delete(dir);
  for (const entry of u.views) closeEntry(dir, entry);
});

function parseTask(dir, r, view = null) {
  const task = parseDoc('tasks.json', r.head);
  if (!task || typeof task !== 'object') return task;
  const row = { id: r.id, ord: r.ord, rev: r.rev, head: r.head, bulk: r.bulk ?? null, value: null, view: null };
  rowsOf.set(task, row);
  if (row.bulk === null) trackRow(dir, row, view);
  const load = () => {
    if (!row.value) {
      if (row.bulk === null) {
        row.bulk = Db.taskBulk(dir, row.id, row.rev, row.view);
        const u = unreadOf(dir);
        u.unbound.delete(row);
        u.views.find((v) => v.view === row.view)?.rows.delete(row);
      }
      row.value = parseDoc('tasks.json', row.bulk);
      if (Array.isArray(row.value.evidence)) for (const entry of row.value.evidence) EvidenceStore.hydrate(entry, dir, task.id);
      if (Object.hasOwn(row.value, 'spend') && !row.value.spend) row.value.spend = { minutes: 0, tokens: 0 };
    }
    return row.value;
  };
  for (const key of Db.BULK) {
    if (!Object.hasOwn(task, key)) continue;
    Object.defineProperty(task, key, {
      enumerable: true, configurable: true,
      get() {
        const value = load()[key];
        Object.defineProperty(task, key, { value, enumerable: true, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(task, key, { value, enumerable: true, configurable: true, writable: true });
      },
    });
  }
  return normalizeTask(task);
}

// Whether field key of task is a bulk field no one has read or set yet.
const bulkUnread = (task, key) => typeof Object.getOwnPropertyDescriptor(task, key)?.get === 'function' && Db.BULK.includes(key);

// The head text task would have now, from the fields that are not bulk.
function headText(task) {
  const head = {};
  for (const key of Object.keys(task)) head[key] = Db.BULK.includes(key) ? 0 : task[key];
  return JSON.stringify(head);
}

// Whether task's row at position ord holds it as read: its bulk no one read
// or set, and its head unchanged. Such a task was checked when it was read.
function unchanged(task, ord) {
  const row = rowsOf.get(task);
  return !!row && row.ord === ord && Db.BULK.every((key) => !Object.hasOwn(task, key) || bulkUnread(task, key)) && headText(task) === row.head;
}

// The row a task that may have changed (not unchanged) needs at position
// ord, or null when its row already holds it. It is laid out in full, since
// its evidence layout follows the head's sha, revision and status.
function changedRow(dir, task, ord) {
  const row = rowsOf.get(task);
  const { head, bulk } = Db.split(EvidenceStore.taskRow(task, dir));
  if (row && row.ord === ord && head === row.head && bulk === (row.bulk ?? Db.taskBulk(dir, row.id, row.rev, row.view))) return null;
  return { id: task.id, ord, status: String(task.status), head, bulk };
}

function parseProject(text) {
  const project = parseDoc('project.json', text);
  assertSchema(project);
  checkOrRefuse('project.json', validateProject(project));
  return project;
}

function parseDecisions(text) {
  const decisions = parseDoc('decisions.json', text);
  if (decisions && Array.isArray(decisions.decisions)) decisions.decisions.forEach(normalizeDecision);
  checkOrRefuse('decisions.json', validateDecisions(decisions));
  return decisions;
}

// Documents and task rows as the database holds them, parsed and checked.
// `texts` keeps each document's and row's text and each row's order, so a
// commit writes only what changed.
// `ords` keeps each task's place, so a catch-up puts changed rows back in order.
function parts(dir, snap, view = null) {
  const project = parseProject(snap.docs.project);
  const ords = new Map();
  const list = snap.tasks.map((r) => {
    ords.set(r.id, r.ord);
    return parseTask(dir, r, view);
  });
  const tasks = { ...parseDoc('tasks.json', snap.docs.tasks), tasks: list };
  checkOrRefuse('tasks.json', validateTasks(tasks));
  const decisions = parseDecisions(snap.docs.decisions);
  return { project, tasks, decisions, texts: { docs: readTexts(snap.docs, project, decisions), ords }, rev: snap.rev, end: snap.end, uid: snap.uid };
}

// The text a commit compares each document with: the project and decisions
// as read, with the defaults reading fills in, so a command that leaves them
// alone does not write them back.
function readTexts(docs, project, decisions) {
  const out = { ...docs };
  if (docs.project !== undefined) out.project = JSON.stringify(project);
  if (docs.decisions !== undefined) out.decisions = JSON.stringify(decisions);
  return out;
}

// A copy a catch-up can change without changing snapshots already handed out.
function copyParts(p) {
  return { ...p, tasks: { ...p.tasks, tasks: [...p.tasks.tasks] }, texts: { docs: { ...p.texts.docs }, ords: new Map(p.texts.ords) } };
}

// Applies what was committed after a snapshot's commit to its parts, in place.
function catchUp(dir, p, changes) {
  const docs = changes.docs;
  if (docs.project !== undefined) p.project = parseProject(docs.project);
  if (docs.decisions !== undefined) p.decisions = parseDecisions(docs.decisions);
  if (docs.tasks !== undefined) p.tasks = { ...parseDoc('tasks.json', docs.tasks), tasks: p.tasks.tasks };
  Object.assign(p.texts.docs, readTexts(docs, p.project, p.decisions));
  if (changes.tasks.length) {
    const byId = new Map(p.tasks.tasks.map((t) => [t.id, t]));
    const changed = [];
    for (const r of changes.tasks) {
      if (byId.has(r.id)) forgetRow(dir, rowsOf.get(byId.get(r.id)));
      const task = parseTask(dir, r);
      byId.set(r.id, task);
      changed.push(task);
      p.texts.ords.set(r.id, r.ord);
    }
    p.tasks.tasks = [...byId.values()].sort((a, b) => p.texts.ords.get(a.id) - p.texts.ords.get(b.id));
    // Rows not written since were checked when their snapshot was taken.
    checkOrRefuse('tasks.json', validateTasks({ ...p.tasks, tasks: changed }));
  } else if (docs.tasks !== undefined) {
    checkOrRefuse('tasks.json', validateTasks({ ...p.tasks, tasks: [] }));
  }
  p.rev = changes.rev;
  p.end = changes.end;
  return p;
}

// What a process keeps of a state directory while it is retained
// (retainEvents): the events read so far and the last snapshot's parts, so
// each later read takes only what was committed since.
const entries = new Map();
// Event bytes this process has read, so the lock trace can show what a
// holder read under the lock.
let eventBytesRead = 0;

// Each event row this process parsed, by database and cursor: every read of
// the log hands out the same object for one event, so a path that finds an
// event in one read (a task's events) finds it in another (every event) by
// identity, as code comparing events with === and indexOf does. A row is
// known by its cursor and id, which a long-lived reader keeps no copy of the
// log's text for.
const parsed = new Map();

function parseRows(dir, rows) {
  const key = path.resolve(dir);
  const uid = rows.length ? Db.uid(dir) : null;
  let cache = parsed.get(key);
  if (rows.length && cache?.uid !== uid) parsed.set(key, cache = { uid, byPos: new Map() });
  const out = [];
  for (const r of rows) {
    // An older copy written over the file in place keeps its Db.uid and puts
    // other events at a cursor.
    const known = cache.byPos.get(r.pos);
    if (known && known.id === r.id) {
      out.push(known.event);
      continue;
    }
    eventBytesRead += r.body.length + 1;
    const event = JSON.parse(r.body);
    cache.byPos.set(r.pos, { id: r.id, event });
    out.push(event);
  }
  return out;
}

// The events a commit of this process logged, at their cursors, so a later
// read hands out the objects the command already holds.
function knowParsed(dir, events, positions) {
  const key = path.resolve(dir);
  const uid = Db.uid(dir);
  let cache = parsed.get(key);
  if (cache?.uid !== uid) parsed.set(key, cache = { uid, byPos: new Map() });
  events.forEach((event, i) => cache.byPos.set(positions[i], { id: event.id, event }));
}

// The events through cursor `end`.
function eventsThrough(dir, end) {
  const entry = entries.get(path.resolve(dir));
  if (!entry) return parseRows(dir, Db.eventsAfter(dir, 0, end));
  const uid = Db.handle(dir) ? Db.uid(dir) : null;
  // A restored copy is another file, so another Db.uid; one copied over the
  // file in place keeps both and can end before the entry's events. An entry
  // that has read no events yet records the database it reads; its parts
  // name their own.
  if (entry.uid === null) entry.uid = uid;
  if (entry.uid !== uid || entry.pos > end && Db.end(dir) < entry.pos) Object.assign(entry, { uid, events: [], positions: [], pos: 0, parts: null });
  if (end > entry.pos) {
    const rows = Db.eventsAfter(dir, entry.pos);
    if (rows.length) {
      // Snapshots already handed out keep their own arrays.
      entry.events = entry.events.concat(parseRows(dir, rows));
      entry.positions = entry.positions.concat(rows.map((r) => r.pos));
      entry.pos = rows.at(-1).pos;
    }
  }
  let lo = 0;
  let hi = entry.positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entry.positions[mid] <= end) lo = mid + 1;
    else hi = mid;
  }
  return lo === entry.events.length ? entry.events : entry.events.slice(0, lo);
}

const ADD_EVENTS = Symbol('addEvents');

// A snapshot: the parts, and its events, read on first use through the
// cursor the snapshot was taken at. Events a mutation commits join them
// without reading the rest. `log` reads only the events a path asks for,
// through the same cursor (logOf).
function snapshotOf(dir, p) {
  const st = { dir, project: p.project, tasks: p.tasks, decisions: p.decisions };
  const end = p.end;
  let events = null;
  let added = [];
  // Every event this snapshot's mutation committed, for the log's queries.
  let committed = [];
  Object.defineProperty(st, 'events', {
    enumerable: true, configurable: true,
    get() {
      if (!events) {
        events = eventsThrough(dir, end);
        if (added.length) events = events.concat(added);
        added = [];
      }
      return events;
    },
    set(value) {
      events = value;
      added = [];
    },
  });
  Object.defineProperty(st, ADD_EVENTS, {
    value: (list) => {
      committed = committed.concat(list);
      if (events) events = events.concat(list);
      else added = added.concat(list);
    },
  });
  Object.defineProperty(st, 'log', { value: logOf(dir, end, () => events, () => committed, () => st.events) });
  return st;
}

// Reads of the log through cursor `end` that query the database's indexes
// instead of every event: one task's events, the roles an agent was spawned
// as, and an agent's undelivered messages. Once the snapshot's events are
// read (`loaded`), they answer instead. `all` is every event.
function logOf(dir, end, loaded, committed, all) {
  const byTask = new Map();
  return {
    // `cmds`, when given, keeps only events of those commands: a task's
    // bookkeeping, such as its live spend readings, outweighs the rest.
    forTask(id, cmds = null) {
      const pick = (e) => e && e.task === id && (!cmds || cmds.includes(e.cmd));
      const events = loaded();
      // Every event read: the log's per-task index answers.
      if (events) return require('./tasks').taskEvents(events, id, cmds);
      const key = cmds ? `${id}\0${cmds.join('\0')}` : id;
      if (!byTask.has(key)) byTask.set(key, byTask.has(id) ? byTask.get(id).filter(pick) : parseRows(dir, Db.taskEvents(dir, id, end, cmds)));
      const own = committed().filter(pick);
      return own.length ? byTask.get(key).concat(own) : byTask.get(key);
    },
    // Tasks whose events may still hold a worker slot after `after` (Db.reach),
    // or null once every event is read and a fold over them is as cheap.
    slotTasks(after) {
      if (loaded()) return null;
      const ids = new Set(Db.slotTasks(dir, after, end));
      for (const e of committed()) if (e.task && Db.reach(e) > after) ids.add(e.task);
      return [...ids];
    },
    spawnRoles(agent) {
      const events = loaded();
      if (events) return events.filter((e) => SPAWNS.includes(e.cmd) && e.detail?.agent === agent).map((e) => e.detail.role);
      return Db.spawnRoles(dir, agent).concat(committed().filter((e) => SPAWNS.includes(e.cmd) && e.detail?.agent === agent).map((e) => e.detail.role));
    },
    all,
  };
}
const SPAWNS = ['spawn', 'spawn retry', 'spawn fallback'];

// Messages to agent that no hook of that agent delivered yet, as they are
// committed now. A holder of the state lock reads what it is about to deliver.
function undelivered(dir, agent) {
  open(dir);
  return parseRows(dir, Db.undelivered(dir, agent));
}

// Events agent logged with command cmd, as they are committed now.
function agentEvents(dir, agent, cmd) {
  open(dir);
  return parseRows(dir, Db.agentEvents(dir, agent, cmd));
}

function hasUndelivered(dir, agent) {
  open(dir);
  return Db.hasUndelivered(dir, agent);
}

// The project, the decisions and the tasks envelope as they are committed
// now, without any task: for a path that reads only those, such as the
// orchestrator lease. `tasks.tasks` is empty.
function docsView(dir) {
  open(dir);
  const { docs } = Db.docs(dir);
  // The project first: a newer schema is reported before any payload error.
  const project = parseProject(docs.project);
  const tasks = { ...parseDoc('tasks.json', docs.tasks), tasks: [] };
  checkOrRefuse('tasks.json', validateTasks(tasks));
  return { dir, project, tasks, decisions: parseDecisions(docs.decisions) };
}

// One task and the log as one read left them, without the other tasks: for
// a path that needs only its own task, such as a hook. Its `log` has the
// indexed reads of a snapshot's (logOf); `events` reads every event.
function taskView(dir, id) {
  open(dir);
  const found = Db.taskRow(dir, id);
  if (!found) throw refuse(`no task ${id}; tower-crane task list shows the ids`);
  const view = { dir, task: parseTask(dir, found.row) };
  let events = null;
  const all = () => {
    if (!events) events = eventsThrough(dir, found.end);
    return events;
  };
  Object.defineProperty(view, 'events', { enumerable: true, get: all });
  Object.defineProperty(view, 'log', { value: logOf(dir, found.end, () => events, () => [], all) });
  return view;
}

// The snapshot and its parts. A retained reader catches up from its last
// snapshot; others read the whole state. A read is one transaction, so it
// always sees whole commits. `lazy` leaves the task bulks unread: 'lock' for a
// holder of the state lock, who reads them while no commit can come between,
// and 'view' for a reader, who reads its snapshot in a view and the bulks
// through it.
function readState(dir, fresh, lazy = null) {
  open(dir);
  const entry = !fresh && entries.get(path.resolve(dir));
  let p;
  const changes = entry?.parts && entry.parts.uid === Db.uid(dir) ? Db.since(dir, entry.parts.rev) : null;
  // Fewer commits than the snapshot counted: an older copy was written over
  // the file in place.
  if (changes && changes.rev >= entry.parts.rev) {
    p = changes.rev === entry.parts.rev ? entry.parts : catchUp(dir, copyParts(entry.parts), changes);
  } else if (lazy === 'view') {
    const view = Db.openView(dir);
    p = parts(dir, Db.snapshot(dir, { bulk: false, view }), view);
    // A state without tasks left nothing for the view to hold.
    if (!unreadOf(dir).views.some((v) => v.view === view)) Db.closeView(view);
  } else {
    p = parts(dir, Db.snapshot(dir, { bulk: !lazy }));
  }
  if (entry) entry.parts = p;
  return { st: snapshotOf(dir, p), parts: p };
}

// A one-shot command reads each task's bulk only when it is used (lazyMode).
function loadState(dir, { fresh = false } = {}) {
  return readState(dir, fresh, lazyMode(dir, 'view')).st;
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

function sealEvents(events) {
  for (const e of events) {
    if (e.id) continue;
    e.detail = Secrets.redact(e.detail);
    e.id = `E${crypto.randomUUID()}`;
    e.type = eventType(e);
    e.to = e.cmd === 'msg' ? e.detail.to : 'orchestrator';
  }
}

// Returns once the events are on disk: an acknowledged message or receipt
// survives a power loss. The caller holds the state lock.
function appendEvents(dir, events) {
  if (!events.length) return;
  open(dir);
  sealEvents(events);
  Db.commit(dir, { events });
}

// Writes the tasks envelope (the orchestrator lease) with no event. The
// caller holds the state lock.
function writeTasksEnvelope(dir, tasks) {
  const { tasks: _, ...envelope } = tasks;
  releaseViews(dir);
  Db.commit(dir, { docs: { tasks: JSON.stringify(envelope) } });
}

// Whether the database holds task id: the commit that recorded it returned.
function taskCommitted(dir, id) {
  return Db.hasTask(dir, id);
}

function eventType(e) {
  const names = { submit: 'submitted', accept: 'accepted', rework: 'rework', ask: 'decision-opened', answer: 'decision-answer', 'decision withdraw': 'decision-withdrawn', release: 'released', msg: 'worker-message', 'spawn fallback': 'spawn-fallback', 'ci completed': 'ci-completed' };
  if (names[e.cmd]) return names[e.cmd];
  if (['task note', 'decision note'].includes(e.cmd) && e.agent === 'owner') return 'owner-comment';
  if ((e.cmd === 'evidence' || e.cmd.startsWith('check ') || e.cmd === 'merge') && e.detail.type) {
    return e.detail.type === 'merge' && e.detail.ok ? 'merged' : 'evidence';
  }
  return e.cmd;
}

function parseEvent(line) {
  // Old progress stays in the file layout's log so byte cursors hold, but
  // state decisions skip it; migration keeps it as a line, not an event.
  const progress = line.indexOf('"cmd":"hook progress"');
  const detail = line.indexOf('"detail":');
  if (!line.trim() || progress !== -1 && (detail === -1 || progress < detail)) return null;
  return JSON.parse(line);
}

// Keeps the events and snapshot this process has read of dir until the
// returned function is called, so later reads take only what is new. `long`
// marks a process that reads and writes for as long as it runs, such as a
// supervisor: it reads whole task rows (lazyMode).
function retainEvents(dir, { long = false } = {}) {
  dir = path.resolve(dir);
  let entry = entries.get(dir);
  if (!entry) {
    entry = { uid: null, events: [], positions: [], pos: 0, parts: null, users: 0, long: 0 };
    entries.set(dir, entry);
  }
  entry.users++;
  if (long) entry.long++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (long) entry.long--;
    if (--entry.users === 0) entries.delete(dir);
  };
}

// How a read leaves the task bulks (readState): a one-shot command reads
// only those it uses; a long-running process would hold a view of every
// commit it read, so it reads whole rows.
function lazyMode(dir, mode) {
  return entries.get(path.resolve(dir))?.long ? null : mode;
}

// What the role checks read of the log (authority.js isOrchestrator): the
// roles a spawned agent was started as, by index, without reading every event.
function roles(dir) {
  open(dir);
  return { spawnRoles: (agent) => Db.spawnRoles(dir, agent) };
}

// Every event committed so far.
function readEvents(dir) {
  open(dir);
  return eventsThrough(dir, Db.end(dir));
}

const progressFile = (dir, agent) => path.join(dir, 'progress', `${agent}.jsonl`);

// Tool activity is frequent and only shows an agent is alive, so it goes to
// the agent's own file without the state lock. One append per line keeps
// lines whole; a lost line costs nothing.
function appendProgress(dir, agent, task, detail) {
  const file = progressFile(dir, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    id: `E${crypto.randomUUID()}`, at: nowIso(), agent, cmd: 'hook progress', type: 'hook progress', task, detail: Secrets.redact(detail),
  }) + '\n');
}

function renderSafely(st) {
  try {
    require('./render').renderFiles(st);
  } catch (e) {
    process.stderr.write(`tower-crane: state written, but rendering the sketch failed: ${e.message}\n`);
  }
}

// The broker runs an agent's command with TOWER_CRANE_VIA=broker after
// checking who sent it; records it writes say so. That is provenance, not
// proof: any unsandboxed process can set the variable or write the files.
// The broker variable only narrows what a command may do. Automation is
// recorded only for verified engine work (ctx.automation), since it binds
// orchestrator writes to the lease holder.
function via(ctx) {
  if (ctx.automation === true) return { via: 'automation' };
  return ctx.env?.TOWER_CRANE_VIA === 'broker' ? { via: 'broker' } : {};
}

// Reading and parsing the state is most of a write's reading, and none of
// it needs the lock. A writer does it while it waits; under the lock it reads
// only the documents and rows committed since, by the commit counter. A
// writer leaves the task bulks unread (`lazy`) and reads those it needs.
function prepare(dir, lazy) {
  try {
    return readState(dir, true, lazy).parts;
  } catch {
    // The locked read reports whatever is wrong with the state.
    return null;
  }
}

function lockedSnapshot(dir, prepared, lazy) {
  let p;
  const changes = prepared && prepared.uid === Db.uid(dir) ? Db.since(dir, prepared.rev, { bulk: !lazy }) : null;
  if (changes && changes.rev >= prepared.rev) {
    p = changes.rev === prepared.rev ? prepared : catchUp(dir, prepared, changes);
  } else {
    // The read before the lock is discarded, and with it its rows.
    if (prepared) for (const task of prepared.tasks.tasks) forgetRow(dir, rowsOf.get(task));
    p = readState(dir, true, lazy).parts;
  }
  return { st: snapshotOf(dir, p), p };
}

// A read that must see the state as the last commit left it, after any
// interrupted file layout commit is recovered and migrated.
function lockedLoad(dir, label) {
  const release = retainEvents(dir);
  try {
    open(dir);
    const prepared = prepare(dir, null);
    return withLock(dir, () => lockedSnapshot(dir, prepared, null).st, lockWaitMs(), label);
  } finally {
    release();
  }
}

// Every write: take the lock, catch up, let fn change the in-memory state,
// validate, commit the documents and task rows that changed with the events
// in one transaction, re-render. A refused command writes nothing unless fn
// committed an earlier checkpoint.
function mutate(ctx, cmd, fn, waitMs = lockWaitMs()) {
  const dir = ctx.stateDir;
  if (ctx.automation !== true && (ctx.agent === 'orchestrator' || ctx.orchestratorSession)) require('./orchestrator').identity(ctx);
  let rerender = false;
  let result;
  const release = retainEvents(dir);
  const lazy = lazyMode(dir, 'lock');
  try {
    open(dir);
    const prepared = prepare(dir, lazy);
    result = withLock(dir, () => Commands.mutation(() => {
    releaseViews(dir);
    // Readers share validated snapshots; a mutation must own its writable copy.
    const { st, p } = lockedSnapshot(dir, prepared, lazy);
    const texts = p.texts;
    const openAtStart = new Set(st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status)).map((t) => t.id));
    if (!['orchestrator release', 'orchestrator takeover'].includes(cmd)) require('./orchestrator').guard(ctx, st, true, false);
    const events = [];
    let changed = false;
    // A spawn takes its worker's lease in that worker's name, as the worker's own claim would.
    const emit = (task, detail, name, agent = ctx.agent) => {
      events.push({ at: nowIso(), agent, ...via(ctx), cmd: name || cmd, task: task || null, detail: detail || {} });
    };
    // The settings audit names the command it records.
    emit.cmd = cmd;
    // A spawn can checkpoint a claim while retaining the lock, so the child
    // sees its holder before it tries to claim the task itself.
    const commit = () => {
      assertSchema(st.project);
      checkOrRefuse('project.json', validateProject(st.project));
      // Tasks whose rows hold them as read were checked when read; ids are
      // checked across all of them.
      const touched = [];
      st.tasks.tasks.forEach((task, ord) => {
        if (!unchanged(task, ord)) touched.push([task, ord]);
      });
      const ids = new Set();
      const duplicates = st.tasks.tasks.filter((t) => t && t.id && (ids.has(t.id) || !ids.add(t.id))).map((t) => `${t.id}: duplicate id`);
      checkOrRefuse('tasks.json', validateTasks({ ...st.tasks, tasks: touched.map(([task]) => task) }).concat(duplicates));
      checkOrRefuse('decisions.json', validateDecisions(st.decisions));
      sealEvents(events);
      const last = events.length ? events.at(-1).id : null;
      const rows = [];
      for (const [task, ord] of touched) {
        const row = changedRow(dir, task, ord);
        if (row) rows.push(row);
      }
      const kept = new Set(st.tasks.tasks.map((t) => t.id));
      const drop = [...texts.ords.keys()].filter((id) => !kept.has(id));
      // The envelope names the last event of the commit that last changed a
      // task, as tasks.json did, so an export reads the same to 0.1 tools.
      if (rows.length && last) st.tasks.last_event = last;
      const { tasks: _, ...envelope } = st.tasks;
      const docs = {};
      const candidates = { project: JSON.stringify(st.project), tasks: JSON.stringify(envelope), decisions: JSON.stringify(st.decisions) };
      for (const [name, text] of Object.entries(candidates)) if (text !== texts.docs[name]) docs[name] = text;
      if (rows.length || drop.length || Object.keys(docs).length || events.length) {
        keepBulk(dir, new Set([...rows.map((r) => r.id), ...drop]));
        const counters = Db.commit(dir, { docs, tasks: rows, events, drop });
        knowParsed(dir, events, counters.positions);
        p.rev = counters.rev;
        p.end = counters.end;
        Object.assign(texts.docs, docs);
        for (const id of drop) texts.ords.delete(id);
        const byId = new Map(st.tasks.tasks.map((t) => [t.id, t]));
        for (const r of rows) {
          texts.ords.set(r.id, r.ord);
          // The task now matches its row, so the next checkpoint compares against it.
          rowsOf.set(byId.get(r.id), { id: r.id, ord: r.ord, rev: counters.rev, head: r.head, bulk: r.bulk, value: null });
        }
        if (rows.length || drop.length || Object.keys(docs).length) changed = true;
      }
      // Rendering must see the receipts just committed, so a completed gate appears immediately.
      if (events.length) st[ADD_EVENTS](events.splice(0));
    };
    let result;
    let finished = false;
    try {
      result = fn(st, emit, commit);
      // Every write that closes a task also closes the decisions it made moot.
      require('./decisions').closeMoot(st, emit, openAtStart);
      commit();
      finished = true;
    } finally {
      // What the command did not read stays readable after the lock is released.
      bindRows(dir);
      // The sketch's gate report reads the repository with git, which a
      // brokered command does not run; the next write outside it renders.
      rerender = (changed || (finished && st.rerender)) && via(ctx).via !== 'broker';
    }
    return result;
  }), waitMs, cmd);
  } finally {
    // A renderer process draws the sketch from the database once the lock is free.
    if (rerender) require('./render').later(ctx);
    release();
  }
  return result;
}

const NEWLINE = Buffer.from('\n');

// Writes the file layout of 0.1 tools into `out`: project.json at schema 1,
// tasks.json, decisions.json, events.jsonl and events.cuts.jsonl, plus the
// briefs and evidence files the tasks name. Every byte cursor handed out
// from the database names the same place in the exported log.
function exportState(dir, out) {
  open(dir);
  fs.mkdirSync(out, { recursive: true });
  const taken = ['project.json', ...LEGACY_FILES, Db.FILE].filter((name) => fileExists(path.join(out, name)));
  if (taken.length) throw refuse(`${out} already holds ${taken.join(', ')}; export into an empty directory`);
  const fd = fs.openSync(path.join(out, 'events.jsonl'), 'w');
  let pending = [];
  let bytes = 0;
  const flush = () => {
    if (!pending.length) return;
    fs.writeSync(fd, Buffer.concat(pending));
    pending = [];
    bytes = 0;
  };
  let docs;
  let rows;
  let cuts = '';
  let counted;
  try {
    counted = Db.exportTo(dir, {
      docs(d, tasks) {
        docs = d;
        rows = tasks;
      },
      line(buf) {
        pending.push(buf, NEWLINE);
        bytes += buf.length + 1;
        if (bytes >= 1 << 20) flush();
      },
      cuts(text) {
        cuts = text;
      },
    });
    flush();
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const envelope = JSON.parse(docs.tasks);
  const head = envelope.last_event === undefined ? {} : { version: envelope.version, next: envelope.next, last_event: envelope.last_event };
  writeAtomic(path.join(out, 'tasks.json'), JSON.stringify({ ...head, ...envelope, tasks: rows }, null, 2) + '\n');
  writeAtomic(path.join(out, 'decisions.json'), json(JSON.parse(docs.decisions)));
  writeAtomic(path.join(out, 'events.cuts.jsonl'), cuts);
  for (const sub of ['briefs', 'evidence']) {
    if (fs.existsSync(path.join(dir, sub))) fs.cpSync(path.join(dir, sub), path.join(out, sub), { recursive: true });
  }
  // project.json last: a 0.1 tool reads the directory as a state only once it is there.
  writeAtomic(path.join(out, 'project.json'), json({ ...JSON.parse(docs.project), schema_version: 1 }));
  return { dir: out, events_bytes: counted.end };
}

module.exports = {
  KINDS, DECISION_KINDS, NEEDS, SIZES, STATUSES, EVIDENCE_TYPES, HARNESSES, TIERS, SCHEMA_VERSION, LOCK_WAIT_MS, LOCK_STALE_MS, lockWaitMs,
  git, gitLocation, repoAt, locateStateDir, findRepo, pidAlive, acquireLock, releaseLock, withLock, tryMarkedLock, mkdirMarkedLock, refreshMarkedLock, keepMarkedLockFresh, releaseMarkedLock, clearStaleLock: clearStale, markedLockHolder, processCreated, ownCreated, stageAtomic, renameRetry, writeAtomic, syncDir, readJson, sharingRetry, fileExists, SHARING_BUSY, REPAIR_HINT,
  validateProject, validateTasks, validateDecisions, loadState, lockedLoad, mutate, via, appendEvents, readEvents, retainEvents, progressFile, appendProgress, eventType, json, renderSafely,
  open, create, writeTasksEnvelope, taskCommitted, exportState, roles, docsView, taskView, undelivered, hasUndelivered, agentEvents,
};
