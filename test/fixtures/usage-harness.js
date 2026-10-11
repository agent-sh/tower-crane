'use strict';

const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');

if (process.env.USAGE_CLAIM) {
  const result = cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', process.env.TOWER_CRANE_TASK,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}
// A relative session path lands where codex writes: under the CODEX_HOME
// spawn gave this process.
if (process.env.USAGE_SESSION) {
  const file = path.resolve(process.env.CODEX_HOME || '', process.env.USAGE_SESSION);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(process.env.USAGE_SESSION_FIXTURE, file);
}
setTimeout(() => { // wait-allow: fixture simulates delayed harness exit and telemetry emission
  process.stdout.write(fs.readFileSync(process.argv[2]));
  process.exitCode = Number(process.env.USAGE_EXIT || 0);
}, Number(process.env.USAGE_DELAY || 0));
