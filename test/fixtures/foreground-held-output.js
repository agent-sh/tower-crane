'use strict';

const { fakeAgentEnv } = require('../agent-env');

const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

const [cli, readyFile, releaseFile, writerPidFile] = process.argv.slice(2);
cp.execFileSync(process.execPath, [cli, 'claim', 'T1', '--lease', '1'], { env: fakeAgentEnv(process.env) });

const writerScript = `
const fs = require('node:fs');
const ready = process.argv[1];
const release = process.argv[2];
// write-atomic: readiness only; the test takes the writer's pid from the harness's file.
fs.writeFileSync(ready, String(process.pid));
const deadline = Date.now() + 300000;
while (!fs.existsSync(release) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
if (!fs.existsSync(release)) process.exit(91);
fs.writeSync(1, JSON.stringify({ type: 'foreground-output', value: 'final foreground output' }) + '\\n');
process.exit(0);
`;

// A separate process group keeps stdout open after this harness exits.
const writer = cp.spawn(process.execPath, ['-e', writerScript, readyFile, releaseFile], {
  detached: true,
  stdio: ['ignore', 1, 'ignore'],
  windowsHide: true,
});
if (!writer.pid) process.exit(92);
writer.unref();
writeAtomic(writerPidFile, String(writer.pid));
process.exit(2);
