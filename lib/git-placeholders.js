'use strict';

// A sandbox that masks a path the host does not have leaves an empty read-only
// file there, such as .git/config.lock, and git then cannot take that lock.
// Git creates its locks writable, so an empty file without write bits, named
// like a lock in the git directory and held by no process, is a placeholder.
const fs = require('node:fs');
const path = require('node:path');
const { sleepSync } = require('./util');

// Cleanups take turns through this directory in the git directory. Git takes a
// lock only by creating its name, and a placeholder keeps that name taken, so
// one cleanup at a time means no other cleanup removes a placeholder while this
// one looks at it.
const REAP_DIR = 'tower-crane-reap';
// A holder works for a few directory operations; the wait covers contention only.
const REAP_WAIT_MS = 5000;
// A cleanup killed while it holds the directory leaves it behind.
const REAP_STALE_MS = 60000;

// Removes the placeholders in a git directory and logs each one. Nothing is
// removed where /proc cannot show who holds a file, or while another cleanup
// holds the directory.
function clearPlaceholders(commonDir) {
  const dir = path.join(commonDir, REAP_DIR);
  if (!take(dir)) return [];
  try {
    return clear(commonDir);
  } finally {
    release(dir);
  }
}

function clear(commonDir) {
  let names;
  try {
    names = fs.readdirSync(commonDir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(commonDir, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!placeholder(st) || held(st) !== false || !reap(file, st)) continue;
    process.stderr.write(`tower-crane: removed empty read-only placeholder ${file}\n`);
    removed.push(file);
  }
  return removed;
}

// Takes the directory, waiting while another cleanup holds it. False when it
// cannot be taken: the git directory is missing or read-only, or the wait ends.
function take(dir) {
  const deadline = Date.now() + REAP_WAIT_MS;
  let pause = 10;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
    }
    if (breakStale(dir)) continue;
    if (Date.now() >= deadline) {
      process.stderr.write(`tower-crane: kept placeholders in ${path.dirname(dir)}, another cleanup holds ${REAP_DIR}\n`);
      return false;
    }
    sleepSync(pause);
    pause = Math.min(pause * 2, 100);
  }
}

function release(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {
    // A cleanup that found the directory stale removed it.
  }
}

// Removes a directory left by a cleanup that died holding it. The directory is
// moved aside first and the moved one is checked: a directory another cleanup
// took since goes back. True when a stale directory was removed.
function breakStale(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return false;
  }
  if (Date.now() - st.mtimeMs <= REAP_STALE_MS) return false;
  const aside = `${dir}-stale-${process.pid}`;
  try {
    fs.renameSync(dir, aside);
    const moved = fs.statSync(aside);
    if (moved.ino === st.ino && moved.dev === st.dev) {
      fs.rmdirSync(aside);
      return true;
    }
    fs.renameSync(aside, dir);
  } catch {
    // Another breaker or a cleanup got there first; the caller waits and retries.
  }
  return false;
}

function placeholder(st) {
  return st.isFile() && st.size === 0 && !(st.mode & 0o222);
}

// Called only while this cleanup holds the directory. A placeholder keeps its
// name taken, so no other cleanup removes it and Git cannot take the name; a
// process outside the cleanup still can remove it in the moment before the
// rename. The file is therefore moved aside and checked there. A file that is
// no longer the placeholder goes back, and a link fails rather than replace a
// lock that git has taken at the name since.
function reap(file, st) {
  const aside = `${file}.reap-${process.pid}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false;
  }
  let now;
  try {
    now = fs.lstatSync(aside);
  } catch {
    return false;
  }
  if (now.ino === st.ino && now.dev === st.dev && placeholder(now) && held(st) === false) {
    try {
      fs.unlinkSync(aside);
      return true;
    } catch {
      // Put it back below.
    }
  }
  try {
    fs.linkSync(aside, file);
    fs.unlinkSync(aside);
  } catch {
    process.stderr.write(`tower-crane: kept ${aside}, ${file} was taken while it was moved aside\n`);
  }
  return false;
}

// Whether a process has the inode open. Matching by device and inode keeps the
// answer independent of how the git directory's path is spelled. Null means a
// process running as this user has a descriptor table that cannot be read, so
// the answer is unknown and the caller keeps the file.
function held(st) {
  const proc = procRoot();
  let pids;
  try {
    pids = fs.readdirSync(proc);
  } catch {
    return null;
  }
  let unknown = false;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const table = `${proc}/${pid}/fd`;
    let fds;
    try {
      fds = fs.readdirSync(table);
    } catch (e) {
      if (!gone(e) && ours(proc, pid)) unknown = true;
      continue;
    }
    for (const fd of fds) {
      try {
        const open = fs.statSync(`${table}/${fd}`);
        if (open.ino === st.ino && open.dev === st.dev) return true;
      } catch (e) {
        if (!gone(e) && ours(proc, pid)) unknown = true;
      }
    }
  }
  return unknown ? null : false;
}

// The process table the holder check reads. A test points TOWER_CRANE_PROC at a
// table of its own, so a process elsewhere on the host cannot decide its answer.
function procRoot() {
  return process.env.TOWER_CRANE_PROC || '/proc';
}

function gone(e) {
  return e.code === 'ENOENT' || e.code === 'ESRCH';
}

// Whether a process runs as this user and may still hold descriptors. A
// same-user process can be non-dumpable, which hides its descriptors while its
// status stays readable, so its table counts as unknown. A zombie has closed
// its descriptors, though its table is unreadable too. Another user's processes
// are not counted: their tables are never readable here, and counting them
// would keep every placeholder on a host that runs root daemons.
function ours(proc, pid) {
  let status;
  try {
    status = fs.readFileSync(`${proc}/${pid}/status`, 'utf8');
  } catch (e) {
    return !gone(e);
  }
  if (/^State:\s+Z\b/m.test(status)) return false;
  const uid = /^Uid:\s+\d+\s+(\d+)/m.exec(status);
  return !uid || Number(uid[1]) === process.geteuid();
}

module.exports = { clearPlaceholders, REAP_DIR, REAP_STALE_MS };
