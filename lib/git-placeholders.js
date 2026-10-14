'use strict';

// A sandbox that masks a path the host does not have leaves an empty read-only
// file there, such as .git/config.lock, and git then cannot take that lock.
// Git creates its locks writable, so an empty file without write bits, named
// like a lock in the git directory and held by no process, is a placeholder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { sleepSync } = require('./util');

// Cleanups take turns through this directory in the git directory. Git takes a
// lock only by creating its name, and a placeholder keeps that name taken, so
// one cleanup at a time means no other cleanup removes a placeholder while this
// one looks at it. The directory holds one marker file, named by its holder's
// random nonce, with the holder's pid, host, pid namespace and Linux start
// identity. A cleanup prepares a directory with its marker and renames it into
// place, so a held directory is never empty, and the rename fails while another
// holder's marker is there. An agent's git runs through a shim that cleans up
// first, so a stopped agent can be killed while it holds the directory; its
// marker then names a process that is gone, and the next cleanup removes that
// marker by its own name. A holder that is alive, even paused, keeps the
// directory whatever its age, and so does one this host cannot judge.
const REAP_DIR = 'tower-crane-reap';
// A holder works for a few directory operations; the wait covers contention only.
const REAP_WAIT_MS = 5000;
// What a rename onto a held directory gives. Windows refuses a rename onto any
// existing directory.
const BUSY = process.platform === 'win32'
  ? ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY']
  : ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'];
// A taker killed between preparing its directory and the rename leaves it in
// the git directory, named with its pid and nonce.
const STAGING_RE = new RegExp(`^${REAP_DIR}\\.\\d+\\.([0-9a-f]{16})\\.new$`);

// Removes the placeholders in a git directory and logs each one. Nothing is
// removed where /proc cannot show who holds a file, or while another cleanup
// holds the directory.
function clearPlaceholders(commonDir) {
  const dir = path.join(commonDir, REAP_DIR);
  const marker = take(dir);
  if (!marker) return [];
  try {
    return clear(commonDir);
  } finally {
    release(dir, marker);
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
    const staging = STAGING_RE.exec(name);
    if (staging && holderGone(path.join(commonDir, name, staging[1]))) dropStaging(path.join(commonDir, name), staging[1]);
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

// Takes the directory, waiting while another cleanup holds it, and returns the
// path of this cleanup's marker. Null when it cannot be taken: the git
// directory is missing or read-only, or the wait ends.
function take(dir) {
  const deadline = Date.now() + REAP_WAIT_MS;
  const holder = JSON.stringify({ pid: process.pid, host: os.hostname(), pidns: pidNamespace(), start_ticks: linuxStat(process.pid)?.start_ticks ?? null });
  let pause = 10;
  for (;;) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const staging = `${dir}.${process.pid}.${nonce}.new`;
    let prepared = false;
    try {
      fs.mkdirSync(staging);
      prepared = true;
      fs.writeFileSync(path.join(staging, nonce), holder);
    } catch {
      if (prepared) dropStaging(staging, nonce);
      return null;
    }
    try {
      fs.renameSync(staging, dir);
      // The rename can land on an empty directory, which no holder names.
      return path.join(dir, nonce);
    } catch (e) {
      dropStaging(staging, nonce);
      if (!BUSY.includes(e.code)) return null;
    }
    if (breakGone(dir)) continue;
    if (Date.now() >= deadline) {
      process.stderr.write(`tower-crane: kept placeholders in ${path.dirname(dir)}, another cleanup holds ${REAP_DIR}; remove ${dir} if no cleanup is running\n`);
      return null;
    }
    sleepSync(pause);
    pause = Math.min(pause * 2, 100);
  }
}

// Removes the markers of holders that are gone, each by its own name, so a
// cleanup that took the directory since keeps its marker; then the directory,
// only if it is empty. An empty directory names no holder: a release in
// progress, or a directory left by a version without markers. True when
// something was removed, so the caller tries again at once.
function breakGone(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return e.code === 'ENOENT';
  }
  let progress = false;
  let kept = false;
  for (const name of names) {
    const file = path.join(dir, name);
    if (!holderGone(file)) {
      kept = true;
      continue;
    }
    try {
      fs.unlinkSync(file);
      progress = true;
    } catch (e) {
      if (e.code === 'ENOENT') progress = true;
      else kept = true;
    }
  }
  if (!kept) {
    try {
      fs.rmdirSync(dir);
      progress = true;
    } catch (e) {
      if (e.code === 'ENOENT') progress = true;
    }
  }
  return progress;
}

// Whether a marker names a process that is gone. A pid is judged only on this
// host and in this pid namespace, where a missing pid, or a live one with
// another Linux start time, cannot be the holder.
function holderGone(file) {
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Not a marker this version wrote: nothing to judge it by.
    return false;
  }
  const { pid, host, pidns, start_ticks } = holder || {};
  if (host !== os.hostname() || (pidns ?? null) !== pidNamespace() || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'ESRCH';
  }
  if (typeof start_ticks !== 'string') return false;
  const now = linuxStat(pid);
  // A zombie has exited, and a process started at another time reuses the pid.
  return !!now && (['Z', 'X'].includes(now.state) || now.start_ticks !== start_ticks);
}

// A Linux process's state and its start time in clock ticks since boot, which
// tells a reused pid from its earlier holder. Null where /proc does not show it.
function linuxStat(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], start_ticks: fields[19] };
  } catch {
    return null;
  }
}

// A pid means something only inside its pid namespace: a sandboxed agent's
// shim runs in one of its own, where a live holder outside looks gone.
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

// A prepared directory that was not renamed into place: this cleanup's own, or
// one whose marker names a taker that is gone.
function dropStaging(staging, nonce) {
  try { fs.unlinkSync(path.join(staging, nonce)); } catch { /* Not written, or gone. */ }
  try { fs.rmdirSync(staging); } catch { /* Gone, or another file is there. */ }
}

// The marker is removed by its own name, then the directory only if empty, so
// a cleanup that broke this one's marker and took the directory keeps it.
function release(dir, marker) {
  try { fs.unlinkSync(marker); } catch { /* Broken by a cleanup that judged this one gone. */ }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Taken by another cleanup, or removed by hand while held.
  }
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

module.exports = { clearPlaceholders, REAP_DIR };
