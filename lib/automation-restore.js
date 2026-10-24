'use strict';

const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const { refuse } = require('./util');
const { randomUUID } = require('node:crypto');
const { current } = require('./automation-common');
const { cpuGate, releaseExecutor, takeExecutor } = require('./automation-executors');
const { software } = require('./automation-gates');
const { pr } = require('./automation-generated');
const { hold, queuedFor, unhold } = require('./automation-schedule');

// Why a task in rework cannot go back to submitted at its head, or null. Only
// a rework automation made for a failed software gate qualifies, while the
// task is exactly as that rework left it: the same head and revision (so the
// same acceptance, dependencies and brief), and no worker has taken it since.
function unrestorable(st, task) {
  if (task.claim) return `${task.id} is claimed by ${task.claim.agent}; let that worker finish`;
  if (task.status !== 'rework') return `${task.id} is ${task.status}; gates retry --from-rework needs a task in rework`;
  const own = T.taskEvents(st.events, task.id);
  const at = own.findLastIndex((e) => e.cmd === 'rework');
  const rework = own[at];
  if (!rework?.detail.gate) {
    const from = !rework ? 'no recorded rework' : rework.detail.from_review ? 'a failed review' : `${rework.agent}: ${rework.detail.reason}`;
    return `${task.id} was sent back by ${from}, not by an automatic gate failure; it needs a worker round`;
  }
  if (rework.detail.revision !== task.revision) {
    return `${task.id} moved from revision ${rework.detail.revision} to ${task.revision} after its rework (acceptance, dependencies or brief changed); it needs a worker round`;
  }
  if (!C.sameSha(rework.detail.sha, task.sha)) return `${task.id} head changed after its rework`;
  const taken = own.slice(at + 1).find((e) => ['claim', 'submit'].includes(e.cmd)
    || e.cmd === 'spawn' && e.detail?.role === 'worker');
  if (taken) return `${task.id} was taken by ${taken.agent} (${taken.cmd}) after its rework; let that round finish`;
  // A kind change sets which gates and review apply without a new revision, so it is a judgment change too.
  const kind = own.slice(at + 1).find((e) => e.cmd === 'task update' && e.detail?.kind !== undefined);
  if (kind) return `${task.id} kind was changed to ${kind.detail.kind} after its rework; it needs a worker round`;
  if (task.escalation_pending) return `${task.id} has a pending quality climb; recover it instead`;
  return null;
}

// The pushed and local heads must still be the reworked head: a moved head is
// new work that needs its own submission.
async function headMoved(ctx, st, task) {
  const remote = await pr(ctx, st, task);
  if (remote && remote.state !== 'OPEN') return `PR #${task.pr} is ${remote.state}`;
  if (remote && !C.sameSha(remote.headRefOid, task.sha)) return `PR #${task.pr} head moved to ${C.short(remote.headRefOid)}`;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const branch = task.branch || remote?.headRefName;
  if (repo && branch) {
    const local = await C.resolveCommit({ root: repo.root, signal: ctx.gateSignal }, repo.root, `refs/heads/${branch}`);
    if (local && !C.sameSha(local, task.sha)) return `branch ${branch} moved to ${C.short(local)}`;
  }
  return null;
}

// Undo an automatic gate rework once the cause outside the code is fixed, such
// as the gate temporary root. The rework's revision bump opened a new round of
// work, but no worker took it and nothing about the task changed, so the task
// returns to the revision it was submitted at: its evidence there (passing
// gates, any review) still describes this head and counts again, and the
// abandoned revision is retired. The failed gates then run again; any other
// gate whose inputs changed reruns as automation would. A gate that still
// fails sends the task back to rework at a new revision.
async function restore(ctx) {
  const { consume } = require('./automation');
  const { st, task } = current(ctx, ctx.pos[0]);
  const reason = unrestorable(st, task) || await headMoved(ctx, st, task);
  if (reason) throw refuse(reason);
  const plan = { sha: task.sha, revision: task.revision };
  const source = `restore:${randomUUID()}`;
  // The task's reaction slot is held throughout, so no reaction settles the
  // old failure at the restored revision before the gate runs again.
  const id = await hold(ctx, task.id, source, (t) => {
    if (t.status !== 'rework' || t.sha !== plan.sha || t.revision !== plan.revision) throw refuse(`${t.id} changed; run gates retry --from-rework again`);
  });
  let result;
  let error = null;
  try {
    // A push between the first check and the hold would otherwise go unnoticed until merge.
    const moved = await headMoved(ctx, S.loadState(ctx.stateDir), task);
    if (moved) throw refuse(moved);
    result = await restoreHeld(ctx, plan);
  } catch (e) {
    error = e;
  } finally {
    unhold(ctx, id, source, error);
  }
  const queued = queuedFor(ctx, id || task.id);
  if (queued.length) await consume(ctx, queued);
  if (error) throw error;
  return result;
}

async function restoreHeld(ctx, plan) {
  const restored = S.mutate(ctx, 'restore', (st, emit) => {
    const t = T.getTask(st, ctx.pos[0]);
    const reason = unrestorable(st, t);
    if (reason) throw refuse(reason);
    if (t.sha !== plan.sha || t.revision !== plan.revision) throw refuse(`${t.id} changed; run gates retry --from-rework again`);
    const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === t.id);
    t.status = 'submitted';
    t.revision = rework.detail.previous_revision;
    // Named in the event, so a rerun stopped before it records evidence leaves these due, not settled.
    const rerun = T.requiredGates(t).filter((g) => g !== 'review').map((g) => T.latestGateEvidence(t, g, st.events))
      .filter((e) => e?.ok === false).map((e) => ({ type: e.type, at: e.at }));
    const text = `restored to submitted at revision ${t.revision}: the ${rework.detail.gate} failure at ${C.short(t.sha)} is rerun after its cause was fixed; revision ${plan.revision} is retired`;
    T.note(t, ctx.agent, text);
    T.appendBriefNote(st.dir, t, `${ctx.agent}: ${text}`);
    emit(t.id, { sha: t.sha, gate: rework.detail.gate, rework: rework.id, from_revision: plan.revision, revision: t.revision, rerun });
    return { sha: t.sha, revision: t.revision, failed: rerun.map((r) => r.type) };
  });
  let { st, task } = current(ctx, ctx.pos[0]);
  const same = (t) => t.status === 'submitted' && t.sha === restored.sha && t.revision === restored.revision;
  const unchanged = () => same(task);
  const { failed } = restored;
  // The reruns hold one executor for their CPU gates, released before the
  // settling pass takes its own.
  const runs = { ...ctx, flags: {}, expect: (now) => (same(T.getTask(now, task.id)) ? null : `${task.id} changed after its restore`) };
  try {
    for (const type of failed) {
      if (!unchanged()) break;
      if (cpuGate(st, task, type)) await takeExecutor(runs, task, type);
      else releaseExecutor(runs);
      await require('./check').runGate(runs, type);
      ({ st, task } = current(ctx, task.id));
    }
  } finally {
    releaseExecutor(runs);
  }
  // Settle as a reaction would: rerun passing gates whose inputs changed, and
  // send a gate that still fails back to rework.
  if (unchanged()) await software({ ...ctx, flags: {} });
  ({ st, task } = current(ctx, task.id));
  const ok = unchanged() && require('./reviewer').softwareReport(st, task).ok;
  const ran = failed.length ? `reran ${failed.join(', ')}` : 'no failed gate to rerun';
  const text = ok ? `${task.id}: restored to submitted at revision ${task.revision}; ${ran} at ${C.short(task.sha)}; run accept to continue`
    : `${task.id}: restored at revision ${restored.revision}, ${ran} at ${C.short(restored.sha)}; now ${task.status} at revision ${task.revision}: ${T.gateReport(task, st.events, st).missing.join('; ')}`;
  return { code: ok ? 0 : 1, data: T.describeTask(st, task, Date.now()), text };
}

module.exports = { unrestorable, headMoved, restore, restoreHeld };
