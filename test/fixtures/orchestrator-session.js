'use strict';

const { spawnSync } = require('node:child_process');
const [bin, cwd] = process.argv.slice(2);

// Keep the calling process alive across CLI commands, as a harness does.
process.on('message', (args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env: process.env, encoding: 'utf8', timeout: 60000 });
  process.send({ code: result.status, stdout: result.stdout, stderr: result.stderr });
});
