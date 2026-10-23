'use strict';

// The test-thread grant client (docs/state.md#test-threads). Tower Crane sets
// TOWER_CRANE_TEST_GRANT on its gate commands and in every agent it spawns,
// so a test run started there asks the host governor for its threads instead
// of choosing them. The value is a JSON label: the state directory as
// `project`, `task`, `agent` and `kind`. A run on the host holds its lease in
// the governor's registry itself; a sandboxed agent cannot write that
// registry, so its run asks its spawn monitor through the state broker
// (TOWER_CRANE_BROKER), which holds the lease while the connection is open.

const path = require('node:path');

const MARK = 'TOWER_CRANE_TEST_GRANT';

function label(env) {
  try {
    const v = JSON.parse(env[MARK]);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const text = (v) => (typeof v === 'string' && v ? v : null);

// The label Tower Crane sets for one test run's environment.
function mark({ stateDir = null, task = null, agent = null, kind = null } = {}) {
  return JSON.stringify({ project: stateDir ? path.resolve(stateDir) : null, task, agent, kind });
}

// The project as the state database holds it. A test run is no CLI command,
// so it closes its connection again.
function readProject(stateDir) {
  if (!stateDir) return null;
  const Db = require('./db');
  try { return JSON.parse(Db.doc(stateDir, 'project')); } catch { return null; } finally { Db.close(stateDir); }
}

// Opens a lease of up to `requested` threads, or returns null outside Tower
// Crane. The handle's `state` is the grant now ({grant, requested, budget,
// cap, cores, runs, granted, ...}); recheck() resolves to the grant at that
// moment; close() releases the lease. Throws when the governor cannot be
// reached, which the caller treats as no governor.
async function open(env, requested) {
  if (!env[MARK]) return null;
  if (env.TOWER_CRANE_BROKER) {
    const s = await require('./broker').testGrantSession(env.TOWER_CRANE_BROKER, requested);
    return { via: 'broker', get state() { return s.state; }, recheck: () => s.recheck(), close: () => s.close() };
  }
  const info = label(env);
  const stateDir = text(info.project);
  const lease = require('./governor').testLease({ env, stateDir }, {
    requested, task: text(info.task), agent: text(info.agent), kind: text(info.kind), project: readProject(stateDir),
  });
  return {
    via: 'registry',
    get state() { return lease.last(); },
    // A registry that stays busy keeps the last grant until the next recheck.
    recheck: async () => {
      try { return lease.refresh(); } catch (e) { if (e.governorDeferred) return lease.last(); throw e; }
    },
    close: () => lease.release(),
  };
}

module.exports = { MARK, open, mark, label };
