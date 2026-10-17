'use strict';

// Automation re-reads a PR whose mergeability is UNKNOWN three times, two
// seconds apart, as GitHub needs seconds to compute it. The offline GitHub
// answers at once, so tests keep the three reads and drop the pauses:
// HOOK_MERGEABILITY_PAUSE_MS replaces the two seconds in this process.
const Module = require('node:module');

const pause = Number(process.env.HOOK_MERGEABILITY_PAUSE_MS);
if (Number.isFinite(pause) && pause >= 0) {
  const load = Module._load;
  Module._load = function loadAutomation(request, parent, isMain) {
    const exported = load.apply(this, arguments);
    // Only lib/automation.js exports this setting.
    if (exported?.MERGEABILITY) exported.MERGEABILITY.retry_ms = pause;
    return exported;
  };
}
