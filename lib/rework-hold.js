'use strict';

// Automatic refill dispatches a reworked task in the same wait pass that sent
// it back, so an orchestrator who sees a gate fail for an environment cause
// gets no chance to restore it (gates retry --from-rework) before a paid
// worker round starts. Refill waits this many minutes after an automatic gate
// rework that can still be restored. Five minutes covers reading the inbox
// item, fixing a setting such as the gate temporary root, and starting the
// restore. It is a small delay next to a worker round on a real code failure,
// and spawn --ready by hand dispatches the task at once. Zero disables it.
const DEFAULT_MINUTES = 5;
const FIELDS = ['rework_hold_min'];
const MAX_TIMER_MS = 2 ** 31 - 1;

function valid(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value * 60000 <= MAX_TIMER_MS;
}

function errors(gates) {
  return gates?.rework_hold_min != null && !valid(gates.rework_hold_min)
    ? ['project.json gates.rework_hold_min must be a non-negative number of minutes within Node\'s timer range or null'] : [];
}

function minutes(project) {
  return project.gates?.rework_hold_min ?? DEFAULT_MINUTES;
}

// When refill may dispatch task again, as an ISO time, or null when it is not held.
function until(st, task, now = Date.now()) {
  const hold = minutes(st.project);
  if (!hold || task.status !== 'rework' || require('./automation').unrestorable(st, task)) return null;
  const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id);
  const end = Date.parse(rework.at) + hold * 60000;
  return end > now ? new Date(end).toISOString() : null;
}

module.exports = { DEFAULT_MINUTES, FIELDS, errors, minutes, until };
