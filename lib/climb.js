'use strict';

// A single-tier task climbs the code ladder on its own: urgent work runs on
// the top code rung, and the second rework its own work earns at one rung
// moves it up one. A ranged task climbs within its range instead
// (lib/escalation.js), and task update --tier overrides either climb.

const { nowIso } = require('./util');

const CODE = ['easy', 'medium', 'hard'];
const TOP = 'hard';
const REWORKS = 2;
const OWN_GATES = ['tests', 'clean', 'ci'];

function open(task) {
  return !['accepted', 'cancelled'].includes(task.status);
}

// Below the top code rung, with no range and no recorded reason for staying
// there. Research is its own rung, not a step on the code ladder.
function belowTop(task) {
  return !task.tier_range && CODE.includes(task.tier) && task.tier !== TOP;
}

function step(task, emit, agent, to, detail) {
  const from = task.tier;
  const kept = task.tier_reason ? { tier_reason: task.tier_reason } : {};
  task.tier = to;
  // The reason described the rung the task left; the event keeps it for a restore.
  delete task.tier_reason;
  task.notes.push({ at: nowIso(), agent, text: `climb ${from} -> ${to}: ${detail.reason}` });
  emit(task.id, { from, to, ...detail, ...kept }, 'climb');
}

// Refuses an urgent task a lower single tier that has no recorded reason.
function lowerReason(task, priority, tier, reason) {
  if (priority !== 'urgent' || !CODE.includes(tier) || tier === TOP || reason) return null;
  return `${task.id} is urgent, so it runs on ${TOP}; pass --tier-reason R to keep it on ${tier}`;
}

function urgent(task, emit, agent) {
  if (task.priority !== 'urgent' || !open(task) || !belowTop(task) || task.tier_reason) return false;
  step(task, emit, agent, TOP, { reason: 'urgent' });
  return true;
}

// Whether a rework comes from the task's own work: a failed review with a
// finding beyond prose, or a tests, clean or ci failure the gate confirmed as
// the change's verdict, as the ranged ladder counts them, plus a tests failure
// the worker must fix such as a failed host probe. Runner, timeout and
// cancelled failures, and those main also fails or whose base rerun could not
// tell, are not. Conflicts, stack syncs and manual reworks name no gate.
function ownWork(failed, review) {
  if (review) return !require('./review-findings').proseOnly(review.findings);
  if (!failed || !OWN_GATES.includes(failed.type) || failed.ok !== false) return false;
  if (failed.main_failure || failed.infrastructure_failure) return false;
  return failed.confirmed_failure === true || failed.type === 'tests' && failed.worker_failure === true;
}

// The own-work reworks at the task's current tier since its tier was last
// set, leaving out those a gates retry --from-rework undid, with any climb
// they triggered.
function counted(events, task) {
  const own = require('./tasks').taskEvents(events, task.id);
  const restores = own.filter((e) => e.cmd === 'restore');
  const reverted = new Set(restores.map((e) => e.detail.climb).filter(Boolean));
  const set = own.findLastIndex((e) => e.cmd === 'climb' && !reverted.has(e.id)
    || e.cmd === 'task update' && e.detail.tier !== undefined);
  const restored = new Set(restores.map((e) => e.detail.rework));
  return own.slice(set + 1).filter((e) => e.cmd === 'rework' && e.detail.own_work && e.detail.tier === task.tier
    && !restored.has(e.id));
}

// Inside rework's write, after it recorded detail: the rework event is not
// in st.events yet, so it is counted from detail.
function afterRework(st, emit, task, agent, detail) {
  if (!detail.own_work || task.hotfix || !open(task) || !belowTop(task)) return false;
  const reworks = [...counted(st.events, task).map((e) => e.detail.revision), detail.revision];
  if (reworks.length < REWORKS) return false;
  const from = task.tier;
  step(task, emit, agent, CODE[CODE.indexOf(from) + 1], {
    reason: `${reworks.length} reworks from its own work at ${from}`, reworks, revision: detail.revision,
  });
  return true;
}

// The climb a restore undoes: the one the restored rework triggered, while
// the task still stands on the rung it reached.
function undone(events, task, rework) {
  const climb = events.findLast((e) => e.task === task.id && e.cmd === 'climb');
  if (!climb || events.indexOf(climb) < events.indexOf(rework)) return null;
  return climb.detail.revision === rework.detail.revision && task.tier === climb.detail.to ? climb : null;
}

// The climb that set an open task's current tier, while no tier change since replaced it.
function current(st, task) {
  if (!open(task)) return null;
  const own = require('./tasks').taskEvents(st.events, task.id);
  const last = own.findLast((e) => ['climb', 'escalate'].includes(e.cmd) || e.cmd === 'restore' && e.detail.climb
    || e.cmd === 'task update' && e.detail.tier !== undefined);
  return last?.cmd === 'climb' && task.tier === last.detail.to ? { at: last.at, ...last.detail } : null;
}

function text(climb) {
  return `${climb.from} -> ${climb.to} (${climb.reason})`;
}

module.exports = { CODE, TOP, REWORKS, lowerReason, urgent, ownWork, afterRework, undone, current, text };
