'use strict';

// Files that fixtures and stubs write for a test to poll. fs.writeFileSync
// creates or truncates the file before it writes, so a reader polling under
// load can find it empty or half written. writeAtomic writes a hidden file
// beside the target and renames it over the target, so a reader sees either
// no file or all of it. The reader's side is fileWritten(file, { json: true })
// in test/signals.js, which waits through a file that is not written yet.
//
// Fixtures that wrap fs pass their unwrapped functions as `impl`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Windows refuses a rename onto a file another process holds open without
// delete sharing; the holder closes it shortly.
const BUSY = ['EPERM', 'EACCES', 'EBUSY'];
const RENAME_RETRY_MS = 2000;

// The hidden name keeps the staged file out of prefix and suffix listings
// (`suite-started-*`, `*.json`) of the directory it lands in.
function stagedName(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

function writeAtomic(file, data, options, impl = fs) {
  const staged = stagedName(file);
  impl.writeFileSync(staged, data, options);
  const deadline = Date.now() + RENAME_RETRY_MS; // wait-allow: bounds a Windows sharing retry, not a readiness wait
  for (;;) {
    try {
      impl.renameSync(staged, file);
      return;
    } catch (error) {
      if (!BUSY.includes(error.code) || Date.now() > deadline) {
        try { impl.unlinkSync(staged); } catch { /* Nothing staged to remove. */ }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // wait-allow: retry cadence of a refused rename
    }
  }
}

module.exports = { writeAtomic };
