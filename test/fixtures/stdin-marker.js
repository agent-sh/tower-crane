'use strict';

// Loaded with --require before the hook bridge. It replaces fd 0 with the
// non-blocking FIFO named by STDIN_FIFO, as a hook runner's stdin is, and
// records the first read of fd 0, so a test can deliver hook input after the
// bridge is already reading.
const fs = require('node:fs');

fs.closeSync(0);
if (fs.openSync(process.env.STDIN_FIFO, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK) !== 0) {
  throw new Error('stdin-marker: the FIFO did not open on fd 0');
}

for (const name of ['readFileSync', 'readSync']) {
  const read = fs[name];
  fs[name] = function readWithMarker(fd, ...args) {
    if (fd === 0) fs.writeFileSync(process.env.STDIN_MARKER, '');
    return read.call(this, fd, ...args);
  };
}
