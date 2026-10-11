'use strict';

// Stands in for claude or codex in the secret canary test. It reports a hash
// of each canary variable it received, never the value, and which of those
// values any process listing shows while it and its supervisor run. ROUTE
// (from the route's env) and CANARY_MODE pick a crash, a provider outage on
// the primary route, or a hold until the test stops it.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { processListing } = require('../canary');

module.exports = function canaryHarness(harness) {
  const names = process.env.CANARY_VARS.split(',');
  const hashes = Object.fromEntries(names.map((n) => [n, process.env[n] ? crypto.createHash('sha256').update(process.env[n]).digest('hex') : null]));
  const listing = processListing();
  const listed = names.filter((n) => process.env[n] && listing.includes(process.env[n]));
  fs.appendFileSync(process.env.CANARY_OUT, `${JSON.stringify({ harness, route: process.env.ROUTE || null, hashes, listed })}\n`);
  const mode = process.env.CANARY_MODE;
  if (mode === 'crash') throw new Error('canary harness crashed');
  if (mode === 'fallback' && process.env.ROUTE === 'primary') {
    const message = 'service unavailable';
    console.log(JSON.stringify(harness === 'claude' ? { type: 'result', is_error: true, result: message } : { type: 'turn.failed', error: { message } }));
    process.exit(1);
  }
  if (mode === 'hold') {
    fs.writeFileSync(`${process.env.CANARY_OUT}.ready`, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify(harness === 'claude'
    ? { type: 'result', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }
    : { type: 'thread.started', thread_id: crypto.randomUUID() }));
};
