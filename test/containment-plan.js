'use strict';

const path = require('node:path');

// Force scope planning only for the dry-run CLI, without starting a user unit.
function scopeEnv(h) {
  if (process.platform !== 'linux') return {};
  return {
    NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(__dirname, 'fixtures', 'containment-manager.js'))}`,
    TC_FAKE_MANAGER_LOG: path.join(h.base, 'dry-run-manager.log'),
  };
}

// Harness assertions ignore only the launcher's known prefix, keeping all harness arguments.
function harnessArgv(argv) {
  if (argv[0] === 'nice' && argv[1] === '-n') argv = argv.slice(3);
  const runner = argv[0] === 'systemd-run' ? argv.indexOf('--') + 2 : 1;
  return path.basename(argv[runner] || '') === 'containment-runner.js' ? argv.slice(runner + 4) : argv;
}

module.exports = { scopeEnv, harnessArgv };
