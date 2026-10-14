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

// A JSON file that several processes read, change and write back, such as a
// gh stub's state, loses a change when one process writes a copy it read
// before another process's write. updateJson runs fn on the current value
// under an exclusive lock file and publishes its result with writeAtomic.
// fn must not start a process that updates the same file.
const LOCK_WAIT_MS = 30000;

function alive(pid) {
  try { require('./signals').killPid(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function lock(file) {
  const lockFile = path.join(path.dirname(file), `.${path.basename(file)}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS; // wait-allow: bounds a lock held by a stuck process, not a readiness wait
  for (;;) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let holder = '';
    try { holder = fs.readFileSync(lockFile, 'utf8'); } catch { /* Released meanwhile. */ }
    // A test can kill a holder. An empty file is a holder between its create and its pid write.
    if (/^\d+$/.test(holder) && !alive(Number(holder))) fs.rmSync(lockFile, { force: true });
    else if (Date.now() > deadline) throw new Error(`${lockFile} is still held by pid ${holder || 'unknown'}`);
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); // wait-allow: retry cadence of a held lock
  }
}

function updateJson(file, fn) {
  const release = lock(file);
  try {
    const value = fn(JSON.parse(fs.readFileSync(file, 'utf8')));
    writeAtomic(file, JSON.stringify(value));
    return value;
  } finally {
    release();
  }
}

module.exports = { writeAtomic, updateJson };
