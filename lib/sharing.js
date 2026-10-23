'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { sleepSync } = require('./util');

// How long a caller waits for another process to close a file Windows
// refuses to open, replace or remove while that process holds it.
const SHARING_RETRY_MS = 2000;
// Windows refuses to open or stat a state file while a writer renames a new
// copy over it, or while a scanner or the indexer holds it, with EPERM and
// sometimes EACCES or EBUSY, until those handles close. Elsewhere these codes
// are a permission failure that no wait ends, so they fail at once. Exported
// so tests can inject the Windows refusal.
const SHARING_BUSY = process.platform === 'win32' ? ['EPERM', 'EACCES', 'EBUSY'] : [];
// First and longest pause between attempts: a rename clears in milliseconds,
// a scanner's scan in tens of them.
const FIRST_PAUSE_MS = 5;
const MAX_PAUSE_MS = 100;

// Runs fn, waiting a sharing refusal out with backoff for up to ms. A refusal
// that outlasts it is thrown with its code and path, and the wait it outlasted.
function sharingRetry(fn, ms = SHARING_RETRY_MS) {
  const deadline = performance.now() + ms;
  let pause = FIRST_PAUSE_MS;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!SHARING_BUSY.includes(e.code)) throw e;
      const left = deadline - performance.now();
      if (left <= 0) {
        e.message = `${e.message} (still refused after ${ms} ms; another process holds the file)`;
        throw e;
      }
      sleepSync(Math.min(pause, left));
      pause = Math.min(pause * 2, MAX_PAUSE_MS);
    }
  }
}

// Whether a caller that treats a failed open or stat as "no file" must throw
// instead: a refusal that outlasted the wait says nothing about the file.
const refused = (e) => SHARING_BUSY.includes(e.code);

// The calls that open a state file or a log by name, which is where Windows
// refuses. Each looks fs up when called, so a test's fs hooks still apply.
const stat = (...args) => sharingRetry(() => fs.statSync(...args));
const lstat = (...args) => sharingRetry(() => fs.lstatSync(...args));
const open = (...args) => sharingRetry(() => fs.openSync(...args));
const readFile = (...args) => sharingRetry(() => fs.readFileSync(...args));

module.exports = { SHARING_RETRY_MS, SHARING_BUSY, sharingRetry, refused, stat, lstat, open, readFile };
