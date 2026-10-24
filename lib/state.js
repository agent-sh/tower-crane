'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Commands = require('./commands');
const { execFileSync } = Commands;
const { TowerCraneError, refuse, nowIso, sleepSync, sleepHooks } = require('./util');
const L = require('./ladder');
const Secrets = require('./secrets');
const EvidenceStore = require('./evidence-store');
const Intervals = require('./intervals');
const { EventReader, fileStat, lastLine, quietSince, readStamp, tailMatches, cutsFile, readCuts } = require('./event-reader');
// A lock-free reader, such as the supervisor's periodic state read, waits a
// sharing refusal out as the writer's rename does, instead of failing the
// command or stopping a worker over another process's commit or a scanner.
const Sharing = require('./sharing');
const { SHARING_RETRY_MS, SHARING_BUSY } = Sharing;

const KINDS = ['code', 'docs', 'research', 'design', 'ops'];
const NEEDS = ['browser'];
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['todo', 'in_progress', 'submitted', 'accepted', 'rework', 'cancelled'];
const EVIDENCE_TYPES = ['tests', 'clean', 'sources', 'review', 'ci', 'merge', 'note', 'final-review', 'verb'];
// What the asker says a decision is. Only technical is the orchestrator's to answer.
const DECISION_KINDS = ['technical', 'spend', 'credential', 'setting', 'crisis'];
const { HARNESSES, TIERS } = L;
// Additive fields and enum members keep this version. Changes that old
// readers cannot safely ignore must publish a higher version first.
const SCHEMA_VERSION = 1;

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
  const deadline = Date.now() + SHARING_RETRY_MS;
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

// fs.existsSync reports false for a file Windows refuses mid-rename, which
// would read as a removed state directory. A refusal that outlasts the wait
// is thrown: the file may well be there.
function fileExists(file) {
  try {
    Sharing.stat(file);
    return true;
  } catch (e) {
    if (Sharing.refused(e)) throw e;
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
    const cut = JSON.parse(Sharing.readFile(cutFile(dir, id), 'utf8'));
    return Number.isSafeInteger(cut.size) && Number.isSafeInteger(cut.from) ? cut : null;
  } catch (e) {
    // Recovery must not take a file it could not read for one that is not there.
    if (Sharing.refused(e)) throw e;
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
    const m = JSON.parse(Sharing.readFile(manifestFile(dir, id), 'utf8'));
    return Number.isSafeInteger(m.size) && Array.isArray(m.ids) ? m : null;
  } catch (e) {
    if (Sharing.refused(e)) throw e;
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
  const fd = Sharing.open(path.join(dir, 'events.jsonl'), 'r+');
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
  const fd = Sharing.open(file, 'a+');
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
  const fd = Sharing.open(path.join(dir, 'events.jsonl'), 'r+');
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
    fd = Sharing.open(file, 'r');
  } catch (e) {
    // Recovery takes a missing last event for a torn commit and cuts it, so a
    // log it could not open must stop it, not read as one without that event.
    if (Sharing.refused(e)) throw e;
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
    project = JSON.parse(Sharing.readFile(path.join(dir, 'project.json'), 'utf8'));
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
const REPAIR_HINT = 'fix it by hand (events.jsonl beside it records every change) or restore it from your own backup of the state directory; git does not track it';

function readJson(file) {
  let raw;
  try {
    raw = Sharing.readFile(file, 'utf8');
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
  errs.push(...require('./archive').errors(p.archive));
  errs.push(...require('./gate-commands').errors(p.gates));
  errs.push(...require('./governor').errors(p.governor));
  errs.push(...require('./verbs').errors(p.broker));
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
  if (l.owners !== undefined && (!isInt(l.owners) || l.owners < 0)) errs.push('limits.owners must be a whole number');
  if (l.owner_idle_minutes !== undefined && !(typeof l.owner_idle_minutes === 'number' && l.owner_idle_minutes > 0 && Number.isFinite(l.owner_idle_minutes))) {
    errs.push('limits.owner_idle_minutes must be a positive number');
  }
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
  if (t.broker_verbs !== undefined && (!Array.isArray(t.broker_verbs) || !t.broker_verbs.length || !t.broker_verbs.every(isNonEmpty) || new Set(t.broker_verbs).size !== t.broker_verbs.length)) {
    bad('broker_verbs must be a non-empty array of distinct verb names');
  }
  if (!isNullOr(t.needs_owner, isNonEmpty)) bad('needs_owner must be null or a reason');
  if (t.needs_owner_by !== undefined && (!t.needs_owner || !t.needs_owner_by || !isNonEmpty(t.needs_owner_by.agent) || !isNonEmpty(t.needs_owner_by.role))) {
    bad('needs_owner_by must record the agent and role that set needs_owner');
  }
  if (!isNonEmpty(t.size)) bad('size must be a non-empty string');
  if (!isNonEmpty(t.tier)) bad('tier must be a non-empty string');
  // Like tier and status, an unfamiliar value from a newer tool loads and orders as normal.
  if (t.priority !== undefined && !isNonEmpty(t.priority)) bad('priority must be a non-empty string when set');
  if (t.tier_reason !== undefined && !isNonEmpty(t.tier_reason)) bad('tier_reason must be a non-empty string when set');
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
  if (!Array.isArray(t.evidence)) bad('evidence must be an array');
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
  if (!t.spend || !isNonNegNum(t.spend.minutes) || !Number.isSafeInteger(t.spend.tokens) || t.spend.tokens < 0) bad('spend must be { minutes, tokens }, with non-negative safe integer tokens');
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
  if (!Array.isArray(t.notes)) bad('notes must be an array');
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
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = Array.isArray(v) ? [] : v;
  if (t.tier === undefined) t.tier = L.defaultTier(t.kind, t.size);
  // tier replaced role; a stale role would read as if it still chose the model.
  delete t.role;
  if (!t.spend) t.spend = { minutes: 0, tokens: 0 };
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

function snapshotKey(dir) {
  return ['project.json', 'tasks.json', 'decisions.json'].map((name) => {
    const stat = Sharing.stat(path.join(dir, name), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }).join('|');
}

function snapshotKeyOrNull(dir) {
  try {
    return snapshotKey(dir);
  } catch {
    return null;
  }
}

// The three state files, parsed and validated. `staged` holds the text of a
// logged commit's staged files, read in place of the files they replace.
function readSnapshot(dir, staged = {}) {
  const read = (key) => (staged[key] === undefined
    ? readJson(path.join(dir, `${key}.json`))
    : parseJson(path.join(dir, `${key}.json`), staged[key]));
  const project = read('project');
  assertSchema(project);
  try {
    checkOrRefuse('project.json', validateProject(project));
    const tasks = read('tasks');
    if (tasks && Array.isArray(tasks.tasks)) tasks.tasks.forEach(normalizeTask);
    checkOrRefuse('tasks.json', validateTasks(tasks));
    for (const task of tasks.tasks) for (const entry of task.evidence) EvidenceStore.hydrate(entry, dir, task.id);
    const decisions = read('decisions');
    if (decisions && Array.isArray(decisions.decisions)) decisions.decisions.forEach(normalizeDecision);
    checkOrRefuse('decisions.json', validateDecisions(decisions));
    // Lock-free readers may straddle the marker and payload writes of a
    // migration. Do not return a mixed snapshot or misreport it as corruption.
    assertSchema(readJson(path.join(dir, 'project.json')));
    return { dir, project, tasks, decisions };
  } catch (error) {
    assertSchema(readJson(path.join(dir, 'project.json')));
    throw error;
  }
}

// The staged files of a commit that reached its commit point and is not yet
// renamed into place: its last event is the last line of the log, and of the
// events this reader holds. That is the window between a commit's append and
// its renames, and, after its holder died, the time until the next lock
// holder renames them. Staged files of any other id belong to a commit whose
// append has not happened or never completed, and are never read.
// Returns null when there is none, and { files: null } when a staged file
// could not be read and the reader should look again.
function pendingCommit(dir, events) {
  const id = events.at(-1)?.id;
  if (typeof id !== 'string' || !/^E[0-9a-f-]{36}$/.test(id)) return null;
  // One listing: a read costs every reader, so it looks only when one is there.
  const staged = fs.readdirSync(dir).map((name) => COMMIT_RE.exec(name)).filter((m) => m?.[2] === id);
  if (!staged.length) return null;
  const files = {};
  let unreadable = false;
  for (const m of staged) {
    try {
      files[m[1]] = Sharing.readFile(path.join(dir, m[0]), 'utf8');
    } catch (e) {
      // Gone: renamed into place since, so the file on disk is this one.
      // Windows can refuse a file in the middle of a rename.
      if (e.code !== 'ENOENT') unreadable = true;
    }
  }
  if (!unreadable && !Object.keys(files).length) return null;
  // A torn final fragment is not a commit point, whatever a reader parsed.
  if (lastLogged(dir)?.id !== id) return null;
  return { files: unreadable ? null : files };
}

// An append landing while a reader reads makes it read again. Each retry needs
// another commit during that read; a reader that loses this many in a row
// reads once under the lock instead, where nothing is appended.
const READ_ATTEMPTS = 5;
// How long that reader waits for the lock. It lost five reads in a row to
// commits, so writers are active; a commit holds the lock for a few syncs, and
// this covers a short queue of them on a slow disk. Past it the reader returns
// its last read, as every lock-free read did before, rather than stall a hook
// behind a long holder.
const READ_LOCK_WAIT_MS = 500;

// The snapshot and whether it came partly from a logged commit's staged files.
// `locked` is a read under the lock, where the files cannot change under it.
function readState(dir, fresh, locked = false) {
  if (!fileExists(path.join(dir, 'project.json'))) {
    throw refuse(`no tower-crane state at ${dir}; run tower-crane init --name N --goal G (or point --state at the right directory)`);
  }
  const retained = !fresh && eventReaders.get(path.resolve(dir));
  let last;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    // The events first, then the files: the reader keeps the result only if
    // the log has not grown meanwhile. A commit appends before it renames, so
    // with no append since, no rename landed but the renames of the commit
    // the events end with, and those files are read either renamed into
    // place or still staged. Either way the files are that commit's state.
    const { events, log } = readEventsAt(dir);
    // A commit whose last event ends the log and whose files are still
    // staged: they are complete and synced, and read in place of their targets.
    const pending = pendingCommit(dir, events);
    if (pending && !pending.files) {
      last = null;
      continue;
    }
    let snapshot;
    let keep = null;
    if (pending) snapshot = readSnapshot(dir, pending.files);
    else {
      const key = retained ? snapshotKeyOrNull(dir) : null;
      // The key alone is not proof: a commit can replace a file with one that
      // reuses its inode, size and coarse times. The log then has its events,
      // so a snapshot is kept for the log as it was read with it.
      const tag = logTag(log, events);
      snapshot = retained?.snapshot && key !== null && retained.key === key && retained.tag === tag ? retained.snapshot : null;
      if (!snapshot) {
        snapshot = readSnapshot(dir);
        if (retained && key !== null) keep = { key, tag };
      }
    }
    if (logUnchanged(dir, log)) {
      if (keep) Object.assign(retained, { snapshot }, keep);
      return { st: { ...snapshot, events }, pending: !!pending, log };
    }
    last = pending ? null : snapshot;
  }
  // Inside a lock this process holds, nothing is appended under the reader.
  // A lock it cannot take (held throughout, or a sandbox that cannot write
  // the state directory) leaves it its last files, returned with events read
  // after them, which are never older than the files, as readers had before.
  if (!locked && !heldLocks) {
    try {
      return withLock(dir, () => readState(dir, true, true), READ_LOCK_WAIT_MS, 'state read', { unwritableFails: true });
    } catch {
      // The lock-free reads above already met whatever else is wrong.
    }
  }
  const files = last || readSnapshot(dir);
  return { st: { ...files, events: readEvents(dir) }, pending: false };
}

function loadState(dir, { fresh = false } = {}) {
  return readState(dir, fresh).st;
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
// survives a power loss.
function appendEvents(dir, events) {
  if (!events.length) return;
  sealEvents(events);
  const fd = Sharing.open(path.join(dir, 'events.jsonl'), 'a+');
  let size;
  try {
    size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      // A torn final line must not consume the next receipt when the log is read again.
      if (last[0] !== 10) prefix = '\n';
    }
    fs.appendFileSync(fd, prefix + events.map((e) => JSON.stringify(e) + '\n').join(''));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // The first append may have created the log.
  if (!size) syncDir(dir);
}

// tasks.json names the last event of the commit that last changed it, so
// validate can tell a task change whose events are missing. tasksJson writes
// the field right after `next`; the text is patched rather than serialized
// again, which costs as much as the write itself on a large plan.
function withLastEvent(st, text, id, dir) {
  st.tasks.last_event = id;
  const head = /^\{\n {2}"version": [^\n]*\n {2}"next": [^\n]*\n( {2}"last_event": [^\n]*\n)?/.exec(text.slice(0, 512));
  if (!head) return EvidenceStore.tasksJson(st.tasks, dir, true);
  const line = `  "last_event": ${JSON.stringify(id)},\n`;
  return head[0].slice(0, head[0].length - (head[1] || '').length) + line + text.slice(head[0].length);
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

const eventReaders = new Map();
// Event log bytes this process has read, so the lock trace can show what a
// holder read under the lock.
let eventBytesRead = 0;

function parseEvent(line) {
  // Old progress stays on disk so byte cursors hold, but state decisions skip it.
  const progress = line.indexOf('"cmd":"hook progress"');
  const detail = line.indexOf('"detail":');
  if (!line.trim() || progress !== -1 && (detail === -1 || progress < detail)) return null;
  return JSON.parse(line);
}

function retainEvents(dir) {
  dir = path.resolve(dir);
  let entry = eventReaders.get(dir);
  if (!entry) {
    entry = { reader: new EventReader(path.join(dir, 'events.jsonl'), { parse: parseEvent }), events: [], users: 0 };
    eventReaders.set(dir, entry);
  }
  entry.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.users === 0) eventReaders.delete(dir);
  };
}

function readEvents(dir) {
  const entry = eventReaders.get(path.resolve(dir));
  if (entry) {
    const from = entry.reader.position;
    // Every caller shares this history, so each read checks that the bytes
    // already read are still the log's (see tailMatches).
    let batch = entry.reader.read({ verify: true });
    // The history holds no offsets to drop the cut events by, so it is read
    // again; a cut follows only a crash or a failed append.
    if (batch.cut !== undefined) {
      entry.reader.reset();
      batch = { ...entry.reader.read({ verify: true }), reset: true };
    }
    eventBytesRead += entry.reader.position - (batch.reset ? 0 : from);
    if (batch.reset) entry.events = [];
    // Snapshots already handed to an async caller must keep their own history.
    if (batch.rows.length) entry.events = entry.events.concat(batch.rows);
    return entry.events;
  }
  let raw;
  try {
    raw = Sharing.readFile(path.join(dir, 'events.jsonl'));
  } catch (e) {
    // A log Windows still refuses is not an empty history.
    if (Sharing.refused(e)) throw e;
    return [];
  }
  return parseLog(raw);
}

function parseLog(raw) {
  eventBytesRead += raw.length;
  const out = [];
  for (const line of raw.toString('utf8').split('\n')) {
    try {
      const event = parseEvent(line);
      if (event) out.push(event);
    } catch {
      // A torn final line from a crash; the rest of the log still counts.
    }
  }
  return out;
}

// The events and the log's size, identity, last line and times they were read at.
function readEventsAt(dir) {
  const entry = eventReaders.get(path.resolve(dir));
  if (entry) {
    const events = readEvents(dir);
    const { position, identity, tail, stamp } = entry.reader;
    return { events, log: { size: position, identity, tail, stamp } };
  }
  // One descriptor for the identity and the bytes, so they are the same file's.
  const startedAt = Date.now();
  let fd;
  try {
    fd = Sharing.open(path.join(dir, 'events.jsonl'), 'r');
  } catch (e) {
    if (Sharing.refused(e)) throw e;
    return { events: [], log: { size: 0, identity: null, tail: null, stamp: null } };
  }
  let raw;
  let stat;
  try {
    stat = fileStat(fd);
    raw = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { events: parseLog(raw), log: { size: raw.length, identity: stat.id, tail: lastLine(raw), stamp: readStamp(path.join(dir, 'events.jsonl'), stat, startedAt) } };
}

// Which log a snapshot was read with: its file and size, and how many events
// it held and the last one's id, which a cut and an append of the same size
// change.
function logTag(log, events) {
  return `${log.identity}:${log.size}:${events.length}:${events.at(-1)?.id ?? ''}`;
}

// Nothing was appended to, cut from or put in place of the log since it was
// read: the same size and inode, and the same last line (see tailMatches).
function logUnchanged(dir, log) {
  const now = logStat(dir);
  if (now.dev === null) return log.identity === null && log.size === 0;
  if (now.size !== log.size || log.identity !== `${now.dev}:${now.ino_exact}`) return false;
  if (quietSince(log.stamp, now)) return true;
  let fd;
  try {
    fd = Sharing.open(path.join(dir, 'events.jsonl'), 'r');
  } catch {
    return false;
  }
  try {
    const st = fileStat(fd);
    return st.size === log.size && log.identity === st.id && tailMatches(fd, log.size, log.tail);
  } finally {
    fs.closeSync(fd);
  }
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

function snapshotTexts(st, dir) {
  return { project: json(st.project), tasks: EvidenceStore.tasksJson(st.tasks, dir), decisions: json(st.decisions) };
}

// Parsing the log and the snapshot files is most of a write's reading, and
// none of it needs the lock. A writer does it while it waits, keyed by the
// files' identities. Under the lock it reads only the events appended since
// and keeps the parsed files when none was replaced in between.
function prepare(dir, texts = true) {
  try {
    const key = snapshotKey(dir);
    const { st, pending, log } = readState(dir, true);
    // A logged commit still staged is renamed into place before the lock is
    // free, so its files will have changed by then. A read that fell back to
    // the lock returns no log to compare against.
    if (pending || !log) return null;
    return snapshotKey(dir) === key ? { key, tag: logTag(log, st.events), st, before: texts ? snapshotTexts(st, dir) : null } : null;
  } catch {
    // The locked read reports whatever is wrong with the files.
    return null;
  }
}

function lockedSnapshot(dir, prepared, texts = true) {
  let key = null;
  try {
    key = snapshotKey(dir);
  } catch {
    // A missing file: loadState below refuses with the right message.
  }
  if (prepared && key === prepared.key) {
    // Equal keys can hide a file replaced since (see logTag); any commit that
    // replaced one logged its events first.
    const { events, log } = readEventsAt(dir);
    if (logTag(log, events) === prepared.tag) {
      prepared.st.events = events;
      return prepared;
    }
  }
  const st = loadState(dir, { fresh: true });
  return { st, before: texts ? snapshotTexts(st, dir) : null };
}

// A read that must see the files and the log as one commit left them, after
// any interrupted commit is recovered. It parses outside the lock as a write
// does and holds the lock only to catch up.
function lockedLoad(dir, label) {
  const release = retainEvents(dir);
  try {
    const prepared = prepare(dir, false);
    return withLock(dir, () => lockedSnapshot(dir, prepared, false).st, lockWaitMs(), label);
  } finally {
    release();
  }
}

// Every write: take the lock, re-read, let fn change the in-memory state,
// validate, write changed files atomically, log events, re-render. A refused
// command writes nothing unless fn committed an earlier checkpoint.
function mutate(ctx, cmd, fn, waitMs = lockWaitMs()) {
  const dir = ctx.stateDir;
  if (ctx.automation !== true && (ctx.agent === 'orchestrator' || ctx.orchestratorSession)) require('./orchestrator').identity(ctx);
  let rerender = false;
  let rendered = null;
  let result;
  const release = retainEvents(dir);
  try {
    const prepared = prepare(dir);
    result = withLock(dir, () => Commands.mutation(() => {
    // Readers share validated snapshots; a mutation must own its writable copy.
    const { st, before } = lockedSnapshot(dir, prepared);
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
    // sees its holder before it tries to claim the task itself. The events go
    // to disk before the files they describe are renamed into place, so a
    // crash never leaves a state change without its events.
    const commit = () => {
      assertSchema(st.project);
      checkOrRefuse('project.json', validateProject(st.project));
      checkOrRefuse('tasks.json', validateTasks(st.tasks));
      checkOrRefuse('decisions.json', validateDecisions(st.decisions));
      sealEvents(events);
      const last = events.length ? events.at(-1).id : null;
      const writes = [];
      for (const key of ['project', 'tasks', 'decisions']) {
        let text = key === 'tasks' ? EvidenceStore.tasksJson(st.tasks, dir, true) : json(st[key]);
        if (text === before[key]) continue;
        if (key === 'tasks' && last) text = withLastEvent(st, text, last, dir);
        writes.push({ key, text, file: path.join(dir, `${key}.json`) });
      }
      if (writes.length) {
        const manifest = last ? { ...logStat(dir), ids: events.map((e) => e.id) } : null;
        // Synced, so after a power cut it cannot come back empty and leave a
        // torn append's first lines without their change.
        if (last) writeSynced(manifestFile(dir, last), JSON.stringify(manifest));
        for (const w of writes) {
          w.staged = last ? commitFile(dir, w.key, last) : stageAtomic(w.file, w.text);
          if (last) writeSynced(w.staged, w.text);
        }
        if (last) {
          try {
            syncDir(dir);
            appendEvents(dir, events);
          } catch (e) {
            try {
              abortCommit(dir, writes.map((w) => w.staged), manifest);
            } catch {
              // The next lock holder finishes or discards what is left, and
              // stops before it appends if it cannot.
            }
            throw e;
          }
        }
        for (const w of writes) renameRetry(w.staged, w.file, !!last);
        syncDir(dir);
        // The command is durable now; a manifest left behind is harmless.
        if (last) unlinkRetry(manifestFile(dir, last));
        for (const w of writes) before[w.key] = w.text;
        changed = true;
      } else if (events.length) {
        appendEvents(dir, events);
      }
      if (events.length) {
        // Rendering must see the receipts just appended, so a completed gate appears immediately.
        st.events = st.events.concat(events.splice(0));
      }
    };
    let result;
    let finished = false;
    try {
      result = fn(st, emit, commit);
      // Every write that closes a task also closes the decisions it made moot.
      require('./decisions').closeMoot(st, emit, openAtStart);
      commit();
      finished = true;
      // What was just committed is the current state. The sketch is drawn
      // from it after the lock is released, stamped with this holding.
      rendered = { st, stamp: require('./render').stampNow(dir) };
    } finally {
      // The sketch's gate report reads the repository with git, which a
      // brokered command does not run; the next write outside it renders.
      rerender = (changed || (finished && st.rerender)) && via(ctx).via !== 'broker';
    }
    return result;
  }), waitMs, cmd);
  } finally {
    if (rerender) {
      // A refused command may have changed its copy past its last checkpoint,
      // so the sketch then comes from the files.
      try { require('./render').render(ctx, rendered); }
      catch (e) { process.stderr.write(`tower-crane: state written, but rendering the sketch failed: ${e.message}\n`); }
    }
    release();
  }
  return result;
}

module.exports = {
  KINDS, DECISION_KINDS, NEEDS, SIZES, STATUSES, EVIDENCE_TYPES, HARNESSES, TIERS, SCHEMA_VERSION, LOCK_WAIT_MS, LOCK_STALE_MS, lockWaitMs,
  git, gitLocation, repoAt, locateStateDir, findRepo, pidAlive, acquireLock, releaseLock, withLock, tryMarkedLock, mkdirMarkedLock, refreshMarkedLock, keepMarkedLockFresh, releaseMarkedLock, clearStaleLock: clearStale, markedLockHolder, processCreated, ownCreated, stageAtomic, renameRetry, writeAtomic, syncDir, readJson, fileExists, REPAIR_HINT,
  validateProject, validateTasks, validateDecisions, loadState, lockedLoad, mutate, via, appendEvents, lastLogged, stagedCommits, readEvents, retainEvents, progressFile, appendProgress, eventType, json, renderSafely,
};
