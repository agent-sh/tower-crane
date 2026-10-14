'use strict';

// Files that fixtures and stubs write for a test to poll. fs.writeFileSync
// creates or truncates the file before it writes, so a reader polling under
// load can find it empty or half written. writeAtomic writes a hidden file
// beside the target and renames it over the target, so a reader sees either
// no file or all of it. readWritten is the reader's side: a missing file, and
// with `json` an empty or unparsable one, is not written yet.
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

// The file's text, or its parsed value with `json`; undefined while it is
// not written yet.
function readWritten(file, { json = false, impl = fs } = {}) {
  let text;
  try {
    text = impl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!json) return text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

module.exports = { writeAtomic, readWritten };
