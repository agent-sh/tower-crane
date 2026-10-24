'use strict';

// Test files and every fixture CLI load this (test/run.js, fixtures/account-home.js).
// Fixture state lives in throwaway directories that no test powers off, so a
// flush to disk proves nothing there and makes each state write wait on the
// disk of a busy host. The call still happens and still checks its descriptor:
// fixtures/hooks.js wraps it after this, so tests that trace, fail or delay a
// sync see every one.
const fs = require('node:fs');

fs.fsyncSync = (fd) => { fs.fstatSync(fd); };
