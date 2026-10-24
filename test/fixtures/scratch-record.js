'use strict';

// Cleanup can hide a temporary allocation, so record its location when it is made.
const fs = require('node:fs');
const make = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const dir = make.apply(this, args);
  if (process.env.TC_SCRATCH_LOG) fs.appendFileSync(process.env.TC_SCRATCH_LOG, JSON.stringify(dir) + '\n');
  return dir;
};
