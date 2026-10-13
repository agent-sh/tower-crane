'use strict';

// Stands in for a real harness CLI (claude, codex, opencode, pi, agy) first on
// the PATH of every test process that has not opted in to a live run. A call
// here means a fixture reached the host's harness instead of a stub: it records
// the call for test/helpers.js to fail the test with, and fails loudly.

const fs = require('node:fs');

const [hits, name, ...args] = process.argv.slice(2);
// The first arguments name the route (a prompt can run to pages).
const hit = {
  name,
  agent: process.env.TOWER_CRANE_AGENT || null,
  args: args.slice(0, 4).map((a) => (a.length > 80 ? `${a.slice(0, 80)}...` : a)),
  cwd: process.cwd(),
  state: process.env.TOWER_CRANE_STATE || null,
};
fs.appendFileSync(hits, `${JSON.stringify(hit)}\n`);
process.stderr.write(`tower-crane test guard: a non-live test started the real ${name}; pin a stub or set its TOWER_CRANE_LIVE_* opt-in\n`);
process.exit(97);
