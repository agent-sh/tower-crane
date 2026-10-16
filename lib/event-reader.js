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
const localDirs = new Map();

// What the platform says about a directory. Tests pass their own.
const PROBE = {
  platform: process.platform,
  statfsType: (dir) => fs.statfsSync(dir).type,
  realpath: (dir) => fs.realpathSync.native(dir),
};

// Whether files in dir carry times from this machine's clock. Linux numbers
// each filesystem type the same on every machine. macOS numbers them as it
// registers them (statfs f_type; only f_fstypename names them, which Node does
// not report), so a directory counts as local when its filesystem has the
// root's number: the root is APFS on every macOS Node runs on, and SMB, NFS,
// AFP, WebDAV and FUSE mounts have numbers of their own. Windows reports no
// type, so a path that resolves to a UNC share (\\server\share, which a
// mapped network drive also resolves to) is remote and any drive path is
// local. Other platforms, and any probe that fails, count as not local.
function localDir(dir, probe = PROBE) {
  try {
    if (probe.platform === 'linux') return LOCAL_FS.has(probe.statfsType(dir));
    if (probe.platform === 'darwin') return probe.statfsType(dir) === probe.statfsType('/');
    if (probe.platform === 'win32') return !/^[\\/]{2}/.test(probe.realpath(dir));
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

// Lock recovery cuts a torn append off events.jsonl and then records the cut
// here, one JSON line each: `id`, the last event id of the commit it cut,
// `size`, the length it cut the log back to, `from`, the length before, and
// `ends`, the offsets where the lines it removed ended. `late` marks a cut an
// older tool made and a later holder recorded after that tool may have
// appended. The file only grows, so its length is the log's generation: a
// reader that saw it grow knows the bytes from `size` on were replaced, even
// when the log has since grown past where it stopped reading.
function cutsFile(log) {
  return path.join(path.dirname(log), 'events.cuts.jsonl');
}

function cutsSize(log) {
  return fs.statSync(cutsFile(log), { throwIfNoEntry: false })?.size ?? 0;
}

// The cuts recorded from byte `from` of the cuts file on, and where the last
// whole record read ends: a record still being appended is read again next time.
function readCuts(log, from = 0) {
  let fd;
  try {
    fd = fs.openSync(cutsFile(log), 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= from) return { cuts: [], end: from };
    const bytes = Buffer.alloc(size - from);
    const n = fs.readSync(fd, bytes, 0, bytes.length, from);
    const whole = bytes.subarray(0, bytes.subarray(0, n).lastIndexOf(10) + 1);
    const cuts = [];
    for (const line of whole.toString('utf8').split('\n')) {
      try {
        const cut = JSON.parse(line);
        if (Number.isSafeInteger(cut.size) && Number.isSafeInteger(cut.from)) cuts.push(cut);
      } catch {
        // A record torn by a crash. The holder that cut the log died before
        // its commit's files were removed, so the next one records it again.
      }
    }
    return { cuts, end: from + whole.length };
  } catch (e) {
    if (e.code === 'ENOENT') return { cuts: [], end: from };
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Whether a line of the log ends right before offset.
function endsLine(log, offset) {
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    const byte = Buffer.alloc(1);
    return fs.readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === 10;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Whether offset, inside cut's range, ended one of the lines it removed and
// ends no line of the log now: every cursor handed out after a cut ends a
// line of the log as it is then.
function removedEnd(log, cut, offset) {
  return cut.size < offset && offset <= cut.from && (!Array.isArray(cut.ends) || cut.ends.includes(offset)) && !endsLine(log, offset);
}

// A byte cursor taken before a cut, at the end of a line the cut removed,
// moves back to where the cut left the log, so the events appended since are
// read and none is skipped. With `since`, the cuts file's length when the
// cursor was taken, every cut recorded after it applies, exactly. A plain
// number does not say when it was taken, so it moves only for a cut whose
// removed line it ended and that leaves it ending no line now; a cursor from
// before the cut whose offset a new line happens to end at too stays. A late
// record may come after an older tool appended, so it moves any cursor only
// that way.
function cutBack(log, offset, since = null) {
  if (!offset || cutsSize(log) <= (since ?? 0)) return offset;
  for (const cut of readCuts(log, since ?? 0).cuts) {
    if (!(cut.size < offset && offset <= cut.from)) continue;
    if ((since === null || cut.late) && !removedEnd(log, cut, offset)) continue;
    offset = cut.size;
  }
  return offset;
}

// A byte cursor as wait and serve return it, `OFFSET:CUTS` with the cuts
// file's length when it was taken, or a plain OFFSET (cuts null); null when
// value is neither.
function parseCursor(value) {
  const m = /^(\d+)(?::(\d+))?$/.exec(String(value));
  if (!m) return null;
  const offset = Number(m[1]);
  const cuts = m[2] === undefined ? null : Number(m[2]);
  if (!Number.isSafeInteger(offset) || cuts !== null && !Number.isSafeInteger(cuts)) return null;
  return { offset, cuts };
}

const formatCursor = (offset, cuts) => `${offset}:${cuts}`;

// Watch the directory in the caller: a file watch stays on the old inode after rename.
class EventReader {
  // `cuts` is the cuts file's length when `after` was taken (cutsSize), so
  // a cut recorded since moves the reader back too.
  constructor(file, { after = 0, parse = JSON.parse, cuts = null } = {}) {
    this.file = file;
    this.position = after;
    this.offset = after;
    this.partial = Buffer.alloc(0);
    this.identity = null;
    // The last whole line read and the bytes after it through `position`,
    // and the log's times then, for read({ verify }).
    this.line = null;
    this.tail = null;
    this.stamp = null;
    this.parse = parse;
    // Where the cuts file had been read to: cuts recorded before the reader
    // started are already in its starting cursor (cutBack).
    this.cuts = cuts ?? cutsSize(file);
  }

  reset() {
    this.resume(0);
    this.identity = null;
  }

  resume(at) {
    this.position = at;
    this.offset = at;
    this.partial = Buffer.alloc(0);
    this.line = null;
    this.tail = null;
    this.stamp = null;
  }

  // `verify` also checks that the bytes already read are still the log's,
  // for a reader that must not miss a cut followed by an equal-size append
  // that no cut record explains (a tool that records no cuts made it).
  // A recorded cut inside what was read resumes reading where the cut left
  // the log and returns that offset as `cut`; the rows read before it past
  // that offset were never committed. Any other change starts over (`reset`).
  read({ verify = false } = {}) {
    let fd;
    let reset = false;
    let cut;
    const rows = [];
    try {
      const startedAt = Date.now();
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      const quiet = quietSince(this.stamp, stat);
      if (this.identity !== null && this.identity !== identity) {
        this.reset();
        // Cuts recorded so far describe the log that was replaced.
        this.cuts = cutsSize(this.file);
        reset = true;
      } else if (!quiet) {
        // Recovery truncates before it records the cut, so a record read
        // after the log's stat describes bytes already gone from it.
        if (cutsSize(this.file) > this.cuts) {
          const recorded = readCuts(this.file, this.cuts);
          for (const c of recorded.cuts) {
            if (c.size >= this.position) continue;
            // A late record can come after an older tool appended past the
            // cut: bytes read that are still the log's were not cut.
            if (c.late && (this.tail ? tailMatches(fd, this.position, this.tail) : !removedEnd(this.file, c, this.position))) continue;
            cut = Math.min(cut ?? c.size, c.size);
          }
          this.cuts = recorded.end;
        }
        if (cut !== undefined) this.resume(cut);
        else if (stat.size < this.position || verify && !tailMatches(fd, this.position, this.tail)) {
          this.reset();
          reset = true;
        }
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
      // The whole line before a fragment carries an event id, so a cut that
      // removed it never compares equal, even when the fragment alone would.
      if (last) this.line = Buffer.from(last);
      if (last || this.partial.length) this.tail = this.line ? Buffer.concat([this.line, this.partial]) : this.partial;
      return { rows, offset: this.offset, reset, ...(cut === undefined ? {} : { cut }) };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      reset = this.identity !== null || this.position !== 0;
      this.reset();
      this.cuts = cutsSize(this.file);
      return { rows, offset: 0, reset };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

module.exports = { EventReader, lastLine, localDir, quietSince, readStamp, tailMatches, cutsFile, cutsSize, readCuts, cutBack, parseCursor, formatCursor };
