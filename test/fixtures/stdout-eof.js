'use strict';

const path = require('node:path');

// A write to a pipe whose reader is gone fails with EOF on Windows, not EPIPE.
// The CLI's first stdout write reports that error here, on any platform.
if (path.basename(process.argv[1] || '') === 'tower-crane.js') {
  const write = process.stdout.write;
  process.stdout.write = function closedReader(...args) {
    process.stdout.write = write;
    process.nextTick(() => process.stdout.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF', syscall: 'write' })));
    return true;
  };
}
