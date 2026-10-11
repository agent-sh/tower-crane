'use strict';

const { spawnSync } = require('node:child_process');
const { HUNG_TEST_MS } = require('../signals');
const [bin, cwd] = process.argv.slice(2);

// Keep the calling process alive across CLI commands, as a harness does.
process.on('message', (args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env: process.env, encoding: 'utf8', timeout: HUNG_TEST_MS });
  process.send({ code: result.status, stdout: result.stdout, stderr: result.stderr });
});
