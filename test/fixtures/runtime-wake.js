'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file');
const root = process.env.RUNTIME_WAKE_ROOT;

if (root) {
  // Prime the dispatch imports before removing the gate, as in a live watcher
  // whose snapshot loses code after startup.
  require(path.join(root, 'lib', 'tests-host-only.js'));
  const automation = require(path.join(root, 'lib', 'automation.js'));
  fs.rmSync(path.join(root, 'lib', 'gates', 'tests.js'));
  const consume = automation.consume;
  let passes = 0;
  automation.consume = async (...args) => {
    const pending = await consume(...args);
    writeAtomic(process.env.RUNTIME_WAKE_COUNTER, String(++passes));
    return pending;
  };
}
