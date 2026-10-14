'use strict';

const fs = require('node:fs');

// The log's last line through `size`: a torn fragment, or the last whole line
// with its newline.
function lastLine(bytes) {
  return bytes.subarray(bytes.lastIndexOf(10, Math.max(0, bytes.length - 2)) + 1);
}

// Whether the bytes before `size` still end with `tail`. A recovery that cuts
// a torn tail off the same file, followed by an append of the same length,
// keeps the size and the inode; the last line read is what tells them apart,
// since every append ends with a new event's own id and a newline.
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
    // The last line read through `position`, for read({ verify }).
    this.tail = null;
    this.parse = parse;
  }

  reset() {
    this.position = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.identity = null;
    this.tail = null;
  }

  // `verify` also checks that the bytes already read are still the log's,
  // for a reader that must not miss a cut followed by an equal-size append.
  read({ verify = false } = {}) {
    let fd;
    let reset = false;
    const rows = [];
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== null && this.identity !== identity || stat.size < this.position || verify && !tailMatches(fd, this.position, this.tail)) {
        this.reset();
        reset = true;
      }
      this.identity = identity;
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

module.exports = { EventReader, lastLine, tailMatches };
