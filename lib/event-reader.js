'use strict';

const fs = require('node:fs');

// Watch the directory in the caller: a file watch stays on the old inode after rename.
class EventReader {
  constructor(file, { after = 0, parse = JSON.parse } = {}) {
    this.file = file;
    this.position = after;
    this.offset = after;
    this.partial = Buffer.alloc(0);
    this.identity = null;
    this.parse = parse;
  }

  reset() {
    this.position = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.identity = null;
  }

  read() {
    let fd;
    let reset = false;
    const rows = [];
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this.identity !== null && this.identity !== identity || stat.size < this.position) {
        this.reset();
        reset = true;
      }
      this.identity = identity;
      while (this.position < stat.size) {
        const chunk = Buffer.alloc(Math.min(65536, stat.size - this.position));
        const n = fs.readSync(fd, chunk, 0, chunk.length, this.position);
        if (!n) break;
        this.position += n;
        let pending = Buffer.concat([this.partial, chunk.subarray(0, n)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          this.offset += end + 1;
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

module.exports = { EventReader };
