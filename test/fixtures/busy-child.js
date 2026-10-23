'use strict';

// A CPU-bound child for the supervision tests: `node busy-child.js READY FINISH [MS]` writes
// READY, then spins until FINISH exists. A test cut off before it writes FINISH used to leave
// this loop running: on 2026-10-23 one spun for four hours after its gate ended. So it also ends
// when the process that started it is gone or MS (the hung-test timeout by default) has passed.
const fs = require('node:fs');

const [ready, finish, ms] = process.argv.slice(2);
const parent = process.ppid;
const deadline = Date.now() + (Number(ms) || 300000); // wait-allow: a test passes a short MS to prove the deadline holds
fs.writeFileSync(ready, 'ready');
while (!fs.existsSync(finish)) {
  if (process.ppid !== parent || Date.now() > deadline) process.exit(1);
  Math.sqrt(Math.random());
}
