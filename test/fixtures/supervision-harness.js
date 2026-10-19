'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const { updateJson } = require('../atomic-file');

if (path.resolve(process.argv[1] || '') !== __filename) {
  const spawn = cp.spawn;
  cp.spawn = function offlineHarness(file, args, options) {
    // The supervisor's lease gate starts its harness after `tower-crane-gate`.
    const gated = file === '/bin/sh' && args[2] === 'tower-crane-gate';
    const harness = gated ? args[3] : file;
    if (['codex', 'claude'].includes(harness) && process.env.TOWER_CRANE_TEST_SUPERVISION_FILE) {
      if (gated) return spawn.call(this, file, [...args.slice(0, 3), process.execPath, __filename, ...args.slice(3)], options);
      return spawn.call(this, process.execPath, [__filename, file, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const file = process.env.TOWER_CRANE_TEST_SUPERVISION_FILE;
  // The claim runs under the lock: it starts no harness, and a concurrent first attempt then sees this one.
  const attempts = updateJson(file, (list) => {
    if (!list.length) {
      cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', process.env.TOWER_CRANE_TASK], { env: require('../agent-env').fakeAgentEnv(process.env), stdio: 'ignore' });
    }
    return [...list, { harness, args, agent: process.env.TOWER_CRANE_AGENT }];
  }, []);
  if (harness === 'codex') console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a11297-1067-7831-a3bc-2c04eac9aaef' }));
  if (attempts.length === 1) {
    if (harness === 'claude' && process.platform !== 'win32') process.kill(process.pid, 'SIGTERM');
    else process.exit(75);
  } else process.exit(0);
}
