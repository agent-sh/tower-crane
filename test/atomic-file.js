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

// An append has no atomic rename; its newline publishes the complete record.
function readJsonLines(file, impl = fs) {
  const text = readPublished(file, 'utf8', impl);
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((line) => line.trim()).map(JSON.parse);
}

// A JSON file that several processes read, change and write back, such as a
// gh stub's state, loses a change when one process writes a copy it read
// before another process's write. updateJson runs fn on the current value
// under an exclusive lock file and publishes its result with writeAtomic.
// fn must not start a process that updates the same file. A file that a
// fixture creates on its first write passes `missing`, the value fn gets
// while the file does not exist yet.
const LOCK_WAIT_MS = 30000;

function alive(pid) {
  try { require('./signals').killPid(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// The holder's pid, or null while the file is missing or, on Windows, pending deletion.
function holderOf(file) {
  // read-published: a lock is linked into place and removed, never replaced, so a refusal is its removal.
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || BUSY.includes(error.code)) return null; throw error; }
}

// Creates `file` already holding this pid: link() of a filled staged file is
// atomic, so no holder, even one killed at once, leaves a lock without a pid.
function create(file) {
  const staged = stagedName(file);
  fs.writeFileSync(staged, String(process.pid));
  try {
    fs.linkSync(staged, file);
    return true;
  } catch (error) {
    // Windows refuses a link over a lock that is still pending deletion.
    if (error.code === 'EEXIST' || BUSY.includes(error.code)) return false;
    throw error;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

// Removes `file` only while it still names the dead `pid`: it is renamed
// aside first, and put back when the rename took a file that replaced it.
function removeDead(file, pid) {
  const aside = stagedName(file);
  try { fs.renameSync(file, aside); }
  catch (error) { if (error.code === 'ENOENT' || BUSY.includes(error.code)) return; throw error; }
  try {
    if (holderOf(aside) !== pid) fs.linkSync(aside, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

// A test can kill a holder inside its hold. One waiter at a time, the one
// that creates the takeover lock, removes a lock whose holder is dead, so a
// second waiter never removes the lock the first then took.
function lock(file) {
  const lockFile = path.join(path.dirname(file), `.${path.basename(file)}.lock`);
  const takeover = `${lockFile}.takeover`;
  const deadline = Date.now() + LOCK_WAIT_MS; // wait-allow: bounds a lock held by a stuck process, not a readiness wait
  for (;;) {
    if (create(lockFile)) return () => fs.rmSync(lockFile, { force: true });
    const holder = holderOf(lockFile);
    if (holder && !alive(Number(holder))) {
      if (create(takeover)) {
        try { if (holderOf(lockFile) === holder) removeDead(lockFile, holder); }
        finally { fs.rmSync(takeover, { force: true }); }
        continue;
      }
      // A takeover lock outlives its holder only when a test kills that holder in these few calls.
      const taker = holderOf(takeover);
      if (taker && !alive(Number(taker))) removeDead(takeover, taker);
    }
    if (Date.now() > deadline) throw new Error(`${lockFile} is still held by pid ${holder || 'unknown'}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); // wait-allow: retry cadence of a held lock
  }
}

function updateJson(file, fn, missing) {
  const release = lock(file);
  try {
    let current;
    try { current = JSON.parse(readPublished(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT' || missing === undefined) throw error;
      current = structuredClone(missing);
    }
    const value = fn(current);
    writeAtomic(file, JSON.stringify(value));
    return value;
  } finally {
    release();
  }
}

module.exports = { writeAtomic, readPublished, readJsonLines, updateJson };
