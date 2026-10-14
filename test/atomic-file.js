'use strict';

// Files that fixtures and stubs write for a test to poll. fs.writeFileSync
// creates or truncates the file before it writes, so a reader polling under
// load can find it empty or half written. writeAtomic writes a hidden file
// beside the target and renames it over the target, so a reader sees either
// no file or all of it. The reader's side is fileWritten(file, { json: true })
// in test/signals.js, which waits through a file that is not written yet, and
// every test reader of such a file opens it with readPublished.
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

// Windows refuses to open a file while a rename replaces it or while its
// removal is pending, with EPERM and sometimes EACCES or EBUSY. Both end as
// soon as the writer's handles close. A reader that took the refusal for a
// missing file would drop a record that exists, so the read waits it out and
// throws only when the refusal outlasts the writer's own retry budget. ENOENT
// still reaches the caller, which decides what an absent file means.
function readPublished(file, options, impl = fs) {
  const deadline = Date.now() + RENAME_RETRY_MS; // wait-allow: bounds a Windows sharing retry, not a readiness wait
  for (;;) {
    try {
      return impl.readFileSync(file, options);
    } catch (error) {
      if (process.platform !== 'win32' || !BUSY.includes(error.code) || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // wait-allow: retry cadence of a refused open
    }
  }
}

module.exports = { writeAtomic, readPublished };
