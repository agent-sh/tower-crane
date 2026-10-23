#!/usr/bin/env node
'use strict';

// Full suites run per accepted task in a time window, read from a state's
// event log, to compare gate orders (docs/state/gates.md#gate-order).
//
//   node scripts/suites-per-accept.js EVENTS_JSONL FROM_ISO TO_ISO
//
// A suite is one `check tests` event; an accepted task is one with an `accept`
// event in the window. `suites_before_failed_review` counts the suites run at
// the head and revision of each failed review in the window, before it.

const fs = require('node:fs');

const [file, from, to] = process.argv.slice(2);
if (!file || !from || !to) {
  process.stderr.write('usage: node scripts/suites-per-accept.js EVENTS_JSONL FROM_ISO TO_ISO\n');
  process.exit(2);
}
const events = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  // A writer can be mid-append on the last line.
  try { events.push(JSON.parse(line)); } catch {}
}
const inWindow = (e) => e.at >= from && e.at < to;
const suites = events.filter((e) => inWindow(e) && e.cmd === 'check tests');
const accepted = new Set(events.filter((e) => inWindow(e) && e.cmd === 'accept').map((e) => e.task));
const failed = events.filter((e) => inWindow(e) && e.cmd === 'evidence' && e.detail?.type === 'review' && e.detail.ok === false);
const sameHead = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const before = failed.reduce((n, r) => n + events.filter((e) => e.cmd === 'check tests' && e.task === r.task && e.at <= r.at
  && e.detail?.revision === r.detail.revision && sameHead(String(e.detail?.sha || ''), String(r.detail.sha || ''))).length, 0);
process.stdout.write(`${JSON.stringify({
  from, to, suites: suites.length, accepted: accepted.size,
  suites_per_accepted: accepted.size ? Number((suites.length / accepted.size).toFixed(2)) : null,
  failed_reviews: failed.length, suites_before_failed_review: before,
})}\n`);
