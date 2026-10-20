'use strict';

const path = require('node:path');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

const root = process.env.RUNTIME_COPY;
if (root) {
  const spawn = cp.spawn;
  cp.spawn = (command, args, options) => {
    const monitor = args?.findIndex(arg => path.basename(arg) === 'spawn-monitor.js');
    if (monitor >= 0) {
      args = [...args];
      args[monitor] = path.join(root, 'lib', 'spawn-monitor.js');
    }
    return spawn(command, args, options);
  };
  if (path.basename(process.argv[1]) === 'spawn-monitor.js') {
    const automation = require(path.join(root, 'lib', 'automation.js'));
    const consume = automation.consume;
    automation.consume = async (...args) => {
      writeAtomic(process.env.RUNTIME_READY, 'ready');
      await require('../signals').fileWritten(process.env.RUNTIME_RELEASE, { check: () => true });
      return consume(...args);
    };
  }
}
