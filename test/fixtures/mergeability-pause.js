'use strict';

// Automation re-reads a PR whose mergeability is UNKNOWN three times, two
// seconds apart, as GitHub needs seconds to compute it. The offline GitHub
// answers at once, so tests keep the three reads and drop the pauses:
// HOOK_MERGEABILITY_PAUSE_MS replaces the two seconds in this process.
// Rechecks of pending CI read GitHub once a minute per task; a test that
// rechecks within seconds sets HOOK_CI_POLL_MS to replace the minute.
const Module = require('node:module');

const setting = (name) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const pause = setting('HOOK_MERGEABILITY_PAUSE_MS');
const poll = setting('HOOK_CI_POLL_MS');
if (pause !== null || poll !== null) {
  const load = Module._load;
  Module._load = function loadAutomation(request, parent, isMain) {
    const exported = load.apply(this, arguments);
    // Only lib/automation.js exports these settings.
    if (exported?.MERGEABILITY && pause !== null) exported.MERGEABILITY.retry_ms = pause;
    if (exported?.CI_POLL && poll !== null) exported.CI_POLL.ms = poll;
    return exported;
  };
}
