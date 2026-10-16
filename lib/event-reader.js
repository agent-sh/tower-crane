'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The log's last line through `size`: a torn fragment, or the last whole line
// with its newline.
function lastLine(bytes) {
  return bytes.subarray(bytes.lastIndexOf(10, Math.max(0, bytes.length - 2)) + 1);
}

// Linux filesystems whose file times come from this machine's clock and move
// on every write and truncate: ext2/3/4, xfs, btrfs, tmpfs, ramfs, f2fs, zfs,
// bcachefs and overlayfs. NFS, SMB, 9p (WSL2 drives), virtiofs and FUSE may
// stamp times with another machine's clock or not move them at all.
const LOCAL_FS = new Set([0xEF53, 0x58465342, 0x9123683E, 0x01021994, 0x858458F6, 0xF2F52010, 0x2FC12FC1, 0xCA451A4E, 0x794C7630]);
// macOS names a filesystem type (statfs f_fstypename) rather than numbering
// it stably; APFS and HFS+ are its local disk formats. smbfs, nfs, afpfs,
// webdav and FUSE mounts are not.
const LOCAL_MAC = new Set(['apfs', 'hfs']);
const localDirs = new Map();

// `mount` prints each filesystem as `DEVICE on POINT (TYPE, FLAGS...)`, TYPE
// being f_fstypename. Node's statfs reports only the numeric f_type.
function parseMounts(text) {
  const mounts = [];
  for (const line of String(text).split('\n')) {
    const m = /^.+? on (.+) \(([^,()]+)[,)]/.exec(line);
    if (m) mounts.push({ point: m[1], type: m[2].trim() });
  }
  return mounts;
}

// The mount that holds an absolute path: the longest mount point it is under.
function mountOf(mounts, dir) {
  let found = null;
  for (const m of mounts) {
    const under = dir === m.point || dir.startsWith(m.point.endsWith('/') ? m.point : `${m.point}/`);
    if (under && (!found || m.point.length > found.point.length)) found = m;
  }
  return found;
}

// What the platform says about a directory. Tests pass their own.
const PROBE = {
  platform: process.platform,
  statfsType: (dir) => fs.statfsSync(dir).type,
  realpath: (dir) => fs.realpathSync.native(dir),
  mounts: () => parseMounts(require('node:child_process').execFileSync('/sbin/mount', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })),
};

// Whether files in dir carry times from this machine's clock. Linux numbers
// the filesystem type; macOS names it. Windows reports no type, so a path that
// resolves to a UNC share (\\server\share, which a mapped network drive also
// resolves to) is remote and any drive path is local. Other platforms, and
// any probe that fails, count as not local.
function localDir(dir, probe = PROBE) {
  try {
    if (probe.platform === 'linux') return LOCAL_FS.has(probe.statfsType(dir));
    if (probe.platform === 'win32') return !/^[\\/]{2}/.test(probe.realpath(dir));
    if (probe.platform === 'darwin') return LOCAL_MAC.has(mountOf(probe.mounts(), probe.realpath(dir))?.type);
  } catch {
    // An unknown filesystem only costs the last-line read.
  }
  return false;
}

// Whether a file's times can be compared with Date.now().
function localTimes(file) {
  const dir = path.dirname(path.resolve(file));
  let local = localDirs.get(dir);
  if (local === undefined) {
    local = localDir(dir);
    localDirs.set(dir, local);
  }
  return local;
}

// When and how a log was read: its times, and whether its last change was at
// least one timestamp step before the read began. A change after that read
// then always gets a later time. Steps are at most 15.6 ms on NTFS (the
// Windows clock tick) and 10 ms on Linux (a jiffy at HZ=100); a time in whole
// seconds may come from HFS+ (1 s) or FAT (2 s) steps. A log on a filesystem
// whose times do not follow this machine's clock is never settled.
function readStamp(file, stat, startedAt) {
  const step = stat.ctimeMs % 1000 ? 20 : 2000;
  return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, settled: startedAt - stat.ctimeMs >= step && localTimes(file) };
}

// Times unchanged since a settled read prove the log did not change, so a
// quiet log costs no read.
function quietSince(stamp, stat) {
  return !!stamp?.settled && stamp.mtimeMs === stat.mtimeMs && stamp.ctimeMs === stat.ctimeMs;
}

// Whether the log, at the same size and inode as when it was read, still ends
// with the last line read. Recovery that cuts a torn tail off the same file,
// then an append of the same length, keeps both; the last line tells them
// apart, since every append ends with a new event's id and a newline.
function tailMatches(fd, size, tail) {
  if (!tail?.length) return true;
  const now = Buffer.allocUnsafe(tail.length);
  return fs.readSync(fd, now, 0, tail.length, size - tail.length) === tail.length && now.equals(tail);
}

// Watch the directory in the caller: a file watch stays on the old inode after rename.
class EventReader {
  constructor(file, { after = 0, parse = JSON.parse } = {}) {
    this.file = file;
    this.position = after;
    this.offset = after;
    this.partial = Buffer.alloc(0);
    this.identity = null;
    // The last line read through `position` and the log's times then, for
    // read({ verify }).
    this.tail = null;
    this.stamp = null;
    this.parse = parse;
  }

  reset() {
    this.position = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.identity = null;
    this.tail = null;
    this.stamp = null;
  }

  // `verify` also checks that the bytes already read are still the log's,
  // for a reader that must not miss a cut followed by an equal-size append.
  read({ verify = false } = {}) {
    let fd;
    let reset = false;
    const rows = [];
    try {
      const startedAt = Date.now();
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      const quiet = quietSince(this.stamp, stat);
      if (this.identity !== null && this.identity !== identity || stat.size < this.position || verify && !quiet && !tailMatches(fd, this.position, this.tail)) {
        this.reset();
        reset = true;
      }
      this.identity = identity;
      // A read that did not check the bytes it already had must not vouch
      // for them: changed times leave the next verified read to compare.
      if (!quiet) this.stamp = verify ? readStamp(this.file, stat, startedAt) : null;
      let last = null;
      while (this.position < stat.size) {
        const chunk = Buffer.alloc(Math.min(65536, stat.size - this.position));
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.position);
        if (!n) break;
        this.position += n;
        let pending = Buffer.concat([this.partial, chunk.subarray(0, n)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          this.offset += end + 1;
          last = pending.subarray(0, end + 1);
          const line = pending.subarray(0, end).toString('utf8');
          pending = pending.subarray(end + 1);
          try {
            const row = this.parse(line, this.offset);
            if (row) rows.push(row);
          } catch {
            // A torn record must not consume the receipts after it.
          }
        }
        // Copy the suffix so a short partial line does not retain a whole chunk.
        this.partial = Buffer.from(pending);
      }
      if (this.partial.length) this.tail = this.partial;
      else if (last) this.tail = Buffer.from(last);
      return { rows, offset: this.offset, reset };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      reset = this.identity !== null || this.position !== 0;
      this.reset();
      return { rows, offset: 0, reset };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

module.exports = { EventReader, lastLine, localDir, parseMounts, quietSince, readStamp, tailMatches };
