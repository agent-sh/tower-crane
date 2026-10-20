'use strict';

// A spawned worker that submits owns its PR until the task is done. It waits
// on its own task (wait --own), and a rework at its head hands the claim back
// to it with the evidence instead of dispatching a fresh worker, which would
// rebuild the context from the brief. The audit trail is unchanged: the
// rework, its revision and its note are recorded as for any rework.

const S = require('./state');
const Sessions = require('./spawn-session');

const IDLE_MINUTES = 180;

function limits(project) {
  return {
    owners: project.limits.owners ?? 2 * project.limits.workers,
    idle_minutes: project.limits.owner_idle_minutes ?? IDLE_MINUTES,
  };
}

// The worker spawn of agent on task while it has not exited. probe false
// reads the event log alone, as a sandboxed caller must.
function liveSpawn(st, task, agent, probe = true) {
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker'
    && e.detail.agent === agent);
  if (!spawn || spawn.detail.body_fix || Sessions.exitedAttempt(spawn, st.events, probe)) return null;
  return spawn;
}

// The claim event that handed task back to agent, while that claim holds.
function handover(st, task, agent) {
  if (task.status !== 'in_progress' || task.claim?.agent !== agent) return null;
  const e = st.events.findLast((x) => x.task === task.id && x.cmd === 'claim' && !x.detail.renewed);
  return e?.detail.handover && e.agent === agent && e.detail.since === task.claim.since ? e : null;
}

// Who owns task's PR and what it is doing, or why its ownership ended:
// { agent, phase: 'waiting' | 'fixing', spawn } while it holds, { agent,
// ended } once it ended, and null when the latest submit took none.
function state(st, task, { now = Date.now(), probe = true } = {}) {
  const events = st.events;
  const from = events.findLastIndex((e) => e.task === task.id && e.cmd === 'submit');
  const submit = events[from];
  if (!submit?.detail.own) return null;
  const agent = submit.agent;
  const end = (ended) => ({ agent, ended });
  const idle = limits(st.project).idle_minutes * 60000;
  let last = Date.parse(submit.at);
  let owed = false;
  let fixing = null;
  // Bookkeeping that arrives with every tool call or usage sample, the
  // waiting worker's own included, is no event for the task.
  const { QUIET } = require('./events');
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.task !== task.id || QUIET.has(e.type || S.eventType(e))) continue;
    const at = Date.parse(e.at);
    // A waiting owner exits once its task had no event for the idle limit; a
    // later event cannot bring it back.
    if (!fixing && at - last >= idle) return end('idle');
    last = at;
    if (e.cmd === 'rework') owed = true;
    else if (e.cmd === 'claim' && !e.detail.renewed) {
      if (!(owed && e.detail.handover && e.agent === agent)) return end(`claimed by ${e.agent}`);
      owed = false;
      fixing = e;
    } else if (e.cmd === 'release') return end('released');
    else if (e.cmd === 'interrupt') return end('interrupted');
  }
  if (owed) return end('sent back to rework for a new worker');
  if (!fixing && now - last >= idle) return end('idle');
  const spawn = liveSpawn(st, task, agent, probe);
  if (!spawn) return end('its worker exited');
  if (task.status === 'cancelled') return end('cancelled');
  if (task.status === 'accepted' && (!task.pr || require('./stack').merged(st, task))) return end(task.pr ? 'merged' : 'accepted');
  if (fixing) return handover(st, task, agent) ? { agent, phase: 'fixing', spawn } : end('its claim ended');
  return ['submitted', 'accepted'].includes(task.status) ? { agent, phase: 'waiting', spawn } : end(task.status);
}

// The owners waiting on their submitted heads, apart from task except.
function waiting(st, except = null, now = Date.now()) {
  return st.tasks.tasks.filter((t) => t.id !== except && ['submitted', 'accepted'].includes(t.status))
    .map((t) => ({ task: t.id, ...state(st, t, { now }) }))
    .filter((o) => o.phase === 'waiting');
}

// Whether a submit by agent takes ownership, and why not: only a live worker
// spawn owns, and only while the waiting owners stay under limits.owners.
function claimable(st, task, agent, now = Date.now()) {
  if (!liveSpawn(st, task, agent)) return { own: false };
  const cap = limits(st.project).owners;
  const others = waiting(st, task.id, now);
  if (others.length >= cap) {
    return { own: false, refused: `owner limit reached (${others.length} of ${cap} waiting: ${others.map((o) => o.task).join(', ')})` };
  }
  return { own: true };
}

// Inside rework's write: gives task back to its waiting owner, in progress
// under a new lease whatever the worker limit says, since it holds the
// context, and tells it why with the rework's full reason.
function handBack(st, emit, task, owner, reason) {
  const now = Date.now();
  const since = new Date(now).toISOString();
  const until = new Date(now + st.project.limits.lease_minutes * 60000).toISOString();
  task.claim = { agent: owner, since, until, from: 'rework' };
  task.status = 'in_progress';
  emit(task.id, { until, from: 'rework', since, handover: true }, 'claim', owner);
  emit(task.id, { to: owner, handover: true, revision: task.revision, text: [
    `${task.id} came back to you at revision ${task.revision}: ${reason}`,
    'You still own it: fix it in this session, push, submit again, then run tower-crane wait --own again.',
  ].join('\n') }, 'msg');
}

// What wait --own reports to agent, or null while it keeps waiting.
function outcome(st, task, agent, now = Date.now()) {
  // The waiter runs in the agent's sandbox, where its own pid is hidden.
  const o = state(st, task, { now, probe: false });
  if (!o || o.agent !== agent) {
    const submit = st.events.findLast((e) => e.task === task.id && e.cmd === 'submit');
    const why = submit?.agent === agent && submit.detail.own_refused ? submit.detail.own_refused
      : `you do not own ${task.id}'s current submission`;
    return { outcome: 'exit', task: task.id, reason: why };
  }
  if (o.ended) return { outcome: 'exit', task: task.id, reason: o.ended };
  if (o.phase === 'waiting') return null;
  const message = st.events.findLast((e) => e.task === task.id && e.cmd === 'msg' && e.detail.to === agent && e.detail.handover);
  return { outcome: 'fix', task: task.id, revision: task.revision, message: message?.detail.text || null };
}

function outcomeText(o) {
  if (o.outcome === 'fix') return o.message || `${o.task} came back to you at revision ${o.revision}.`;
  if (o.outcome === 'wait') return `${o.task}: you still own it and nothing needs you yet; run tower-crane wait --own again.`;
  return `${o.task}: your ownership ended (${o.reason}); exit now. A later failure dispatches a new worker.`;
}

module.exports = { IDLE_MINUTES, limits, liveSpawn, handover, state, waiting, claimable, handBack, outcome, outcomeText };
