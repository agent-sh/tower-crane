'use strict';

// Intervals the CLI, its supervisors and the governor wait out, in ms.
// TOWER_CRANE_INTERVALS, a JSON object of name to positive milliseconds,
// replaces them, so a test drives a timeout path in short real time instead of
// the production interval. Production leaves it unset. It is read on each call,
// from the environment the caller names or this process's, so a value set in a
// test applies to modules it already loaded.
const DEFAULTS = {
  // How long a writer waits for the state lock (lib/state.js).
  lock_wait: 60000,
  // How long a supervisor gets to report ready, to see its spawn recorded and,
  // without the lease gate, to see its lease (lib/spawn.js, lib/spawn-monitor.js).
  startup: 10000,
  // How often a marked lock kept fresh while held, such as the dispatch lock, touches its marker (lib/state.js).
  lock_refresh: 10000,
  // How long the governor waits for its registry lock, and how much longer a bind keeps trying (lib/governor.js).
  governor_lock_wait: 5000,
  governor_bind_wait: 10000,
};

let parsedFrom;
let parsed = {};
function overrides(env) {
  const raw = env.TOWER_CRANE_INTERVALS || '';
  if (raw === parsedFrom) return parsed;
  let value = {};
  if (raw) {
    try { value = JSON.parse(raw); } catch { throw new Error(`TOWER_CRANE_INTERVALS is not JSON: ${raw}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TOWER_CRANE_INTERVALS must be a JSON object');
    for (const [name, ms] of Object.entries(value)) {
      if (!Object.hasOwn(DEFAULTS, name)) throw new Error(`TOWER_CRANE_INTERVALS names an unknown interval: ${name}; known: ${Object.keys(DEFAULTS).join(', ')}`);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`TOWER_CRANE_INTERVALS.${name} must be a positive number of ms`);
    }
  }
  parsedFrom = raw;
  parsed = value;
  return parsed;
}

function ms(name, env = process.env) {
  if (!Object.hasOwn(DEFAULTS, name)) throw new Error(`unknown interval: ${name}`);
  return overrides(env)[name] ?? DEFAULTS[name];
}

module.exports = { DEFAULTS, ms };
