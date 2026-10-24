'use strict';

// Preloaded to hold a write halfway, as a loaded machine can: a write to
// PARTIAL_WRITE_TARGET, or to a file staged beside it for a rename, writes the
// first half of its data, creates `<target>.half` and waits for
// `<target>.finish` before writing all of it. A test then sees what a reader
// polling the target finds in the middle of the write.

const fs = require('node:fs');
const path = require('node:path');

const target = process.env.PARTIAL_WRITE_TARGET && path.resolve(process.env.PARTIAL_WRITE_TARGET);
if (target) {
  const write = fs.writeFileSync;
  const exists = fs.existsSync;
  const staged = (file) => path.dirname(file) === path.dirname(target)
    && path.basename(file).startsWith(`.${path.basename(target)}.`);
  let held = false;
  fs.writeFileSync = function partialWrite(file, data, ...args) {
    if (held || typeof file !== 'string' || typeof data !== 'string'
      || (path.resolve(file) !== target && !staged(path.resolve(file)))) return write.call(this, file, data, ...args);
    held = true;
    write.call(this, file, data.slice(0, Math.floor(data.length / 2)), ...args);
    write.call(this, `${target}.half`, '');
    const deadline = Date.now() + 300000;
    while (!exists.call(fs, `${target}.finish`) && Date.now() < deadline) { // spin-allow: preloaded into the CLI under test, which can be a detached supervisor whose dispatcher exits by design; the deadline bounds it
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // wait-allow: probe cadence; the finish file and the hung-test timeout bound it
    }
    return write.call(this, file, data, ...args);
  };
}
