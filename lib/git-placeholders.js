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
// identity, with its time namespace's boottime offset. A cleanup prepares a
// directory with its marker and renames it into place, so a held directory is
// never empty, and the rename fails while another holder's marker is there. An agent's git runs through a shim that cleans up
// first, so a stopped agent can be killed while it holds the directory; its
// marker then names a process that is gone, and the next cleanup removes that
// marker by its own name. A holder that is alive, even paused, keeps the
// directory whatever its age, and so does one this host cannot judge.
const REAP_DIR = 'tower-crane-reap';
// The initial pid namespace has this fixed inode on every Linux kernel. Only a
// cleanup in it sees every process the kernel runs.
const INIT_PIDNS = 'pid:[4026531836]';
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
// holds the directory. Without a readable process table no placeholder can be
// shown unheld, so the directory is not taken at all. waitMs bounds the wait on
// another holder; quiet leaves out the message when the wait ends, for a caller
// to which a live holder is no news.
function clearPlaceholders(commonDir, { waitMs = REAP_WAIT_MS, quiet = false } = {}) {
  try {
    fs.readdirSync(procRoot());
  } catch {
    return [];
  }
  const dir = path.join(commonDir, REAP_DIR);
  const marker = take(dir, waitMs, quiet);
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
    if (staging && takerGone(path.join(commonDir, name), staging[1])) dropStaging(path.join(commonDir, name), staging[1]);
    if (!name.endsWith('.lock')) continue;
    const file = path.join(commonDir, name);
    let st;
    try {
      // bigint stats keep the inode exact: Windows file ids run past 2^53,
      // where a Number rounds neighbouring files to one id.
      st = fs.lstatSync(file, { bigint: true });
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
function take(dir, waitMs, quiet) {
  const deadline = Date.now() + waitMs;
  // Read through /proc/self: a sandbox's /proc can belong to another pid
  // namespace than the one process.pid is counted in.
  const holder = JSON.stringify({
    pid: process.pid, host: os.hostname(), boot_id: bootId(), pidns: pidNamespace(), start_ticks: linuxStat('self')?.start_ticks ?? null,
    boottime_offset_ns: boottimeOffset(),
  });
  let pause = 10;
  let lastTry = false;
  for (;;) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const staging = `${dir}.${process.pid}.${nonce}.new`;
    let prepared = false;
    try {
      fs.mkdirSync(staging);
      prepared = true;
      writeSynced(path.join(staging, nonce), holder);
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
    // A removal is retried at once, but within the same wait: a rename that
    // keeps failing while the directory is gone must still end.
    // A removal at the deadline still earns one more try, so a caller that does
    // not wait takes a directory whose holder is gone.
    const progress = breakGone(dir);
    const late = Date.now() >= deadline;
    if (progress && !lastTry) {
      lastTry = late;
      continue;
    }
    if (late) {
      if (!quiet) process.stderr.write(`tower-crane: kept placeholders in ${path.dirname(dir)}, another cleanup holds ${REAP_DIR}; remove ${dir} if no cleanup is running\n`);
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

// A marker is written whole and synced before its directory is renamed into
// place, so its contents survive anything short of a crash of the machine.
function writeSynced(file, data) {
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Whether a cleanup runs inside a command sandbox, which shows none of the
// host's processes: Tower Crane marks its sandboxed agents, and claude's and
// codex's sandboxes mark the commands they confine.
function insideSandbox() {
  const env = process.env;
  return env.TOWER_CRANE_SANDBOX === '1' || env.SANDBOX_RUNTIME === '1' || !!env.CODEX_SANDBOX;
}

// Whether a marker names a process that is gone. The boot id tells this
// machine's current boot from another machine or an earlier boot, whose
// holders are all gone; without one on either side, the host name stands in.
// Another host name on this boot is another UTS namespace on this kernel: a
// container sharing the repository, or a sandbox that names its own host.
// Only a cleanup in the initial pid namespace sees every process there.
// A pid is judged in this pid namespace, where a missing pid, or a live one
// with another Linux start time, cannot be the holder. A holder in another
// namespace, such as a shim in an agent's command sandbox, is judged by its
// identity there.
function holderGone(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let holder;
  try {
    holder = JSON.parse(text);
  } catch {
    // Cut short by a crash of the machine, which ended its holder too, or
    // not a marker this version wrote: gone only if it predates this boot.
    return predatesBoot(file);
  }
  const { pid, host, boot_id, pidns, start_ticks, boottime_offset_ns: offset } = holder || {};
  const boot = bootId();
  if (boot_id && boot && boot_id !== boot) return host === os.hostname();
  if (host !== os.hostname() && !(boot_id && boot && pidNamespace() === INIT_PIDNS)) return false;
  if ((pidns ?? null) !== pidNamespace()) return typeof pidns === 'string' && foreignHolderGone(pidns, pid, start_ticks, offset);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'ESRCH';
  }
  if (typeof start_ticks !== 'string') return false;
  const now = linuxStat(pid);
  // A zombie has exited, and a process started at another time reuses the pid.
  return !!now && (['Z', 'X'].includes(now.state) || !sameStart(start_ticks, offset, now.start_ticks, `/proc/${pid}`));
}

// Whether a start time read here is the one a marker recorded. /proc counts
// start times from a boot that the reader's time namespace shifts by its
// boottime offset, so a holder under `unshare -T --boottime N` records a start
// that a cleanup outside reads N seconds earlier. The recorded start is moved
// by the difference of the two offsets; a shift by part of a tick can round
// either way. A marker without an offset, from a version that did not record
// one, matches unless the process runs in this cleanup's time namespace.
// What cannot be compared matches, so a live holder is never judged gone.
function sameStart(recorded, offset, now, procDir) {
  if (now === recorded) return true;
  try {
    if (offset === undefined) return timeNamespace(`${procDir}/ns/time`) !== timeNamespace('/proc/self/ns/time');
    const own = boottimeOffset();
    if (typeof offset === 'string' && offset === own) return false;
    const hz = clockTicks();
    if (typeof offset !== 'string' || own === null || !hz) return true;
    const shifted = (BigInt(offset) - BigInt(own)) * BigInt(hz);
    const diff = BigInt(now) - BigInt(recorded) + shifted / 1000000000n;
    return shifted % 1000000000n === 0n ? diff === 0n : diff >= -1n && diff <= 1n;
  } catch {
    return true;
  }
}

// A kernel without time namespaces has no link, and every process shares one clock.
function timeNamespace(link) {
  try {
    return fs.readlinkSync(link);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// This process's time namespace boottime offset in nanoseconds, as a decimal
// string; '0' on a kernel without time namespaces, null where it cannot be read.
// The file shows the namespace for children, which is this process's own
// unless it left its namespace without an exec since.
let ownBoottimeOffset;
function boottimeOffset() {
  if (ownBoottimeOffset === undefined) {
    try {
      if (timeNamespace('/proc/self/ns/time') !== timeNamespace('/proc/self/ns/time_for_children')) throw new Error('time namespace for children');
      const m = /^boottime\s+(-?\d+)\s+(\d+)\s*$/m.exec(fs.readFileSync('/proc/self/timens_offsets', 'utf8'));
      ownBoottimeOffset = m ? String(BigInt(m[1]) * 1000000000n + BigInt(m[2])) : null;
    } catch (e) {
      ownBoottimeOffset = e.code === 'ENOENT' ? '0' : null;
    }
  }
  return ownBoottimeOffset;
}

// The clock ticks per second /proc counts start times in: AT_CLKTCK in this
// process's auxiliary vector. Null where it cannot be read.
let ownClockTicks;
function clockTicks() {
  if (ownClockTicks === undefined) {
    ownClockTicks = null;
    try {
      const auxv = fs.readFileSync('/proc/self/auxv');
      const size = ['arm', 'ia32', 'mips', 'mipsel', 'ppc'].includes(process.arch) ? 4 : 8;
      const le = os.endianness() === 'LE';
      const word = (at) => (size === 8
        ? Number(le ? auxv.readBigUInt64LE(at) : auxv.readBigUInt64BE(at))
        : (le ? auxv.readUInt32LE(at) : auxv.readUInt32BE(at)));
      const AT_CLKTCK = 17;
      for (let at = 0; at + 2 * size <= auxv.length && word(at) !== 0; at += 2 * size) {
        if (word(at) === AT_CLKTCK) {
          ownClockTicks = word(at + size) || null;
          break;
        }
      }
    } catch {
      // No auxiliary vector to read.
    }
  }
  return ownClockTicks;
}

// A file last written before this boot began.
function predatesBoot(file) {
  try {
    return fs.statSync(file).mtimeMs < Date.now() - os.uptime() * 1000;
  } catch {
    return false;
  }
}

// A prepared directory whose taker is gone. A taker writes its marker right
// after it creates the directory; one with no marker after the wait a cleanup
// gives a holder was killed in between, and if it still runs, its take fails
// and nothing else.
function takerGone(staging, nonce) {
  const marker = path.join(staging, nonce);
  if (fs.existsSync(marker)) return holderGone(marker);
  try {
    return Date.now() - fs.lstatSync(staging).mtimeMs > REAP_WAIT_MS;
  } catch {
    return false;
  }
}

// Whether no process left is the holder: one in that pid namespace whose
// innermost pid is the marker's and whose start time matches. Only a cleanup
// outside every command sandbox judges this: inside one, the processes of the
// host and of other sandboxes are not visible, and would all look gone. Pid
// namespace inodes are reused, and a namespace outlives a shim killed alone,
// so a namespace with processes left does not keep a holder that is gone.
// A process whose namespace link cannot be read (a non-dumpable one, or
// another user's) counts when its NSpid shows it nested and the rest of its
// identity matches.
function foreignHolderGone(pidns, pid, startTicks, offset) {
  if (process.platform !== 'linux' || insideSandbox()) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const proc = procRoot();
  let pids;
  try {
    pids = fs.readdirSync(proc);
  } catch {
    return false;
  }
  for (const each of pids) {
    if (!/^\d+$/.test(each)) continue;
    let link = null;
    try {
      link = fs.readlinkSync(`${proc}/${each}/ns/pid`);
    } catch (e) {
      if (gone(e)) continue;
    }
    if (link !== null && link !== pidns) continue;
    let status;
    try {
      status = fs.readFileSync(`${proc}/${each}/status`, 'utf8');
    } catch (e) {
      if (gone(e) || link === null) continue;
      return false;
    }
    const nspid = /^NSpid:\s+(.*)$/m.exec(status)?.[1].trim().split(/\s+/);
    // A kernel without NSpid cannot name the pid in the namespace.
    if (!nspid) {
      if (link !== null) return false;
      continue;
    }
    if (link === null && nspid.length < 2) continue;
    if (Number(nspid.at(-1)) !== pid) continue;
    if (typeof startTicks !== 'string') return false;
    const now = linuxStat(each, proc);
    if (!now) {
      if (fs.existsSync(`${proc}/${each}`)) return false;
      continue;
    }
    if (['Z', 'X'].includes(now.state)) continue;
    // A process whose namespace cannot be read is anyone's with that innermost
    // pid, such as a root container's, so only a start the marker's offset
    // places, or the exact start, keeps the marker for it.
    const alive = link === null && typeof offset !== 'string'
      ? now.start_ticks === startTicks
      : sameStart(startTicks, offset, now.start_ticks, `${proc}/${each}`);
    if (alive) return false;
  }
  return true;
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

// A Linux process's state and its start time in clock ticks since boot, which
// tells a reused pid from its earlier holder. Null where /proc does not show it.
function linuxStat(pid, proc = '/proc') {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`${proc}/${pid}/stat`, 'utf8');
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
  return st.isFile() && Number(st.size) === 0 && !(Number(st.mode) & 0o222);
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
    now = fs.lstatSync(aside, { bigint: true });
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
        const open = fs.statSync(`${table}/${fd}`, { bigint: true });
        if (open.ino === st.ino && open.dev === st.dev) return true;
      } catch (e) {
        if (!gone(e) && ours(proc, pid)) unknown = true;
      }
    }
  }
  return unknown ? null : false;
}

// Whether a live process has a mount at one of paths, which are absolute.
// A command sandbox binds over a name in the host's tree from its own mount
// namespace, and unlinking that name on the host detaches the bind there, so
// the sandboxed command could then write the name. Each namespace's table is
// read once. Mount points are relative to each process's root, which a
// sandbox that binds the host's paths at their own places keeps equal to
// them. Null where a table of this user's cannot be read; off Linux no sandbox
// binds over a name, and false.
function mountedOver(paths) {
  if (process.platform !== 'linux') return false;
  const want = new Set(paths);
  const proc = procRoot();
  let pids;
  try {
    pids = fs.readdirSync(proc);
  } catch {
    return null;
  }
  const seen = new Set();
  let unknown = false;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let ns = null;
    try {
      ns = fs.readlinkSync(`${proc}/${pid}/ns/mnt`);
    } catch (e) {
      // Another user's processes cannot bind in this user's tree.
      if (gone(e) || !ours(proc, pid)) continue;
    }
    if (ns !== null && seen.has(ns)) continue;
    let table;
    try {
      table = fs.readFileSync(`${proc}/${pid}/mountinfo`, 'utf8');
    } catch (e) {
      if (!gone(e) && ours(proc, pid)) unknown = true;
      continue;
    }
    if (ns !== null) seen.add(ns);
    for (const line of table.split('\n')) {
      const point = line.split(' ')[4];
      // The kernel escapes space, tab, newline and backslash as octal.
      if (point && want.has(point.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))) return true;
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

module.exports = { clearPlaceholders, mountedOver, REAP_DIR, REAP_WAIT_MS };
