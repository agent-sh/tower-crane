'use strict';

const fs = require('node:fs');
const path = require('node:path');
const write = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...args) {
  if (typeof file === 'string' && /^started-\d+\.json(?:\.tmp)?$/.test(path.basename(file))) {
    // Expose premature readiness publication by slowing the write.
    write.call(this, file, '', ...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // wait-allow: the slow write is the fixture's behaviour
  }
  return write.call(this, file, data, ...args);
};
