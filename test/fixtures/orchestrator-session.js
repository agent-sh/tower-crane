'use strict';

const { spawnSync } = require('node:child_process');
const { HUNG_TEST_MS } = require('../signals');
const [bin, cwd] = process.argv.slice(2);

// Keep the calling process alive across CLI commands, as a harness does.
process.title = 'claude';
process.on('message', (message) => {
  const args = Array.isArray(message) ? message : message.args;
  const script = message.script;
  const command = script ? process.platform === 'win32' ? 'powershell.exe' : 'bash' : process.execPath;
  const prefix = script ? process.platform === 'win32'
    ? ['-NoProfile', '-File', script, process.execPath] : [script, process.execPath] : [];
  const result = spawnSync(command, [...prefix, bin, ...args], { cwd, env: process.env, encoding: 'utf8', timeout: HUNG_TEST_MS });
  process.send({ code: result.status, stdout: result.stdout, stderr: result.stderr });
});
