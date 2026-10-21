'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { HUNG_TEST_MS } = require('../signals');

// A supervisor launches a rerun inside the mutation that records it, so the
// harness can run ahead of its commit on a loaded machine. Holding the named
// mutation after its callback, until the harness leaves a file, makes that
// order certain.
if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.TOWER_CRANE_TEST_HOLD_COMMIT) {
  const [cmd, file] = JSON.parse(process.env.TOWER_CRANE_TEST_HOLD_COMMIT);
  const S = require(path.join(path.dirname(process.argv[1]), 'state.js'));
  const mutate = S.mutate;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  S.mutate = function heldMutate(ctx, name, fn, ...rest) {
    if (name !== cmd) return mutate.call(this, ctx, name, fn, ...rest);
    return mutate.call(this, ctx, name, (...args) => {
      const result = fn(...args);
      const until = Date.now() + HUNG_TEST_MS;
      while (!fs.existsSync(file)) {
        if (Date.now() >= until) throw new Error(`the harness never wrote ${file} while ${cmd} was held`);
        Atomics.wait(delay, 0, 0, 10);
      }
      return result;
    }, ...rest);
  };
}
