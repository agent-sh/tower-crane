'use strict';

const S = require('./state');
const T = require('./tasks');
const Sessions = require('./spawn-session');
const C = require('./gates/common');
const { current, merged, ownerWaits } = require('./automation-common');
const { runAutomated, software } = require('./automation-gates');
const { conflicts, resumeGenerated, settledPr } = require('./automation-generated');
const { queue } = require('./automation-merge');

// A reviewer that exited cleanly at this head and revision without a verdict
// would exit the same way again on the same inputs. Automation holds review
// dispatch until the head, the revision or a revuto thread changes, or the
// orchestrator runs accept itself, and tells the orchestrator once per
// reviewer why it stopped. Until the reviewer's exit receipt is written, the
// reaction to that receipt decides; a receipt that never comes is reported
// once and the reviewer is replaced.
async function reviewHeld(ctx, st, task) {
  const R = require('./reviewer');
  const exit = R.reviewExit(st, task);
  if (exit?.state === 'pending') return true;
  // A missing receipt at the crash cap is reported and then held like any other.
  if (exit?.state === 'missing' || exit?.missing) {
    S.mutate(ctx, 'review exit missing', (now, emit) => {
      if (now.events.some((e) => e.cmd === 'review exit missing' && e.task === task.id && e.detail.agent === exit.spawn.detail.agent)) return;
      emit(task.id, { agent: exit.spawn.detail.agent, sha: task.sha, revision: task.revision, monitor: exit.monitor,
        monitor_pid: exit.spawn.detail.monitor_pid, reason: 'reviewer monitor did not record its exit' });
    });
    if (exit.state === 'missing') return false;
  }
  const spawn = exit?.state === 'held' ? exit.spawn : null;
  if (!spawn || await R.threadsMoved(ctx, st, task, spawn)) return false;
  S.mutate(ctx, 'review held', (now, emit) => {
    const t = T.getTask(now, task.id);
    if (t.sha !== task.sha || t.revision !== task.revision) return;
    if (now.events.some((e) => e.cmd === 'review held' && e.task === t.id && e.detail.agent === spawn.detail.agent)) return;
    emit(t.id, R.holdNotice(now, t, spawn));
  });
  return true;
}

async function advance(ctx, inspect = true) {
  ctx.automationSignal?.throwIfAborted();
  let { st, task } = current(ctx, ctx.pos[0]);
  let mergeable = true;
  if (!['submitted', 'accepted'].includes(task.status) || merged(st, task)) return 'done';
  if (task.hotfix) {
    const dispatched = st.events.some((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'reviewer' && e.detail.revision === task.revision && C.sameSha(e.detail.sha, task.sha));
    // An exited reviewer without a verdict needs an explicit retry, not a spawn loop.
    if (dispatched && !T.latestGateEvidence(task, 'review', st.events)) return 'done';
    await T.accept({ ...ctx, flags: {} });
    return 'done';
  }
  // A failed independent review is actionable even while CI is pending.
  // The batch action fetches findings and rechecks the head under the lock.
  const verdict = T.latestGateEvidence(task, 'review', st.events);
  if (verdict?.ok === false && require('./review-findings').bodyOnly(verdict.findings)) {
    return require('./review-body').react(ctx, st, task, verdict);
  }
  if (verdict?.ok === false) {
    if (require('./actions').pendingRetry(st, task, verdict)) {
      await reviewHeld(ctx, st, task);
      return 'done';
    }
    await require('./actions').rework({ ...ctx, pos: [], flags: { 'from-review': task.id } });
    await require('./escalation').recover({ ...ctx, pos: [task.id], flags: {} });
    return 'done';
  }
  if (inspect && task.pr) {
    const remote = await settledPr(ctx, st, task);
    ctx.automationSignal?.throwIfAborted();
    // A remote merge can precede its local receipt if the executor died.
    // The merge gate confirms the accepted head without issuing another merge.
    if (remote?.state !== 'MERGED' || task.status !== 'accepted') {
      if (!remote || remote.state !== 'OPEN') {
        // Pending CI on a PR closed without merging can never finish; the ci gate
        // records it as stalled, which ends the scheduled recheck.
        const ci = T.latestGateEvidence(task, 'ci', st.events);
        if (remote?.state === 'CLOSED' && ci?.pending && !ci.stalled) await runAutomated(ctx, 'ci');
        return 'deferred';
      }
      if (await resumeGenerated(ctx, st, task, remote)) return advance(ctx, inspect);
      if (!C.sameSha(remote.headRefOid, task.sha)) return 'deferred';
      if (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY') {
        const conflict = await conflicts(ctx, task, true);
        if (!conflict || conflict === 'deferred') return 'deferred';
        const repaired = current(ctx, task.id).task;
        if (repaired.status === 'submitted' && repaired.sha !== task.sha) return advance(ctx, inspect);
        // An accepted task that leaves the line may have been stopping it.
        if (task.status === 'accepted') await queue(ctx);
        return 'done';
      }
      mergeable = remote.mergeable === 'MERGEABLE' && !!remote.mergeStateStatus && remote.mergeStateStatus !== 'UNKNOWN';
    }
  }
  if (task.status === 'submitted') {
    // The CI gate records pending while GitHub computes mergeability, so the
    // next scheduled reconciliation can observe it without a notification.
    await software({ ...ctx, mergeabilityPending: !mergeable });
    ctx.automationSignal?.throwIfAborted();
    ({ st, task } = current(ctx, task.id));
    if (!mergeable) return 'deferred';
    if (task.status !== 'submitted' || !require('./reviewer').softwareReport(st, task).ok) return 'done';
    const report = T.gateReport(task, st.events, st);
    // Native workers without an exit receipt use explicit accept for review
    // dispatch. A tracked worker must have exited, or be waiting as the PR's
    // owner, before a model reads its diff: either way it no longer edits it.
    const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'worker' && e.detail.agent === task.submitted_by);
    if (!report.ok && (!worker || !Sessions.exitedAttempt(worker, st.events)) && !ownerWaits(st, task)) return 'done';
    if (!report.ok && await reviewHeld(ctx, st, task)) return 'done';
    await T.accept({ ...ctx, flags: {}, automatic: true });
    ({ st, task } = current(ctx, task.id));
  }
  if (!mergeable) {
    const ci = T.latestGateEvidence(task, 'ci', st.events);
    if (task.status === 'accepted' && !ci?.pending && !ci?.waived) {
      await runAutomated(ctx, 'ci');
    }
    return 'deferred';
  }
  if (task.status === 'accepted' && task.pr) {
    await queue(ctx);
    ({ st, task } = current(ctx, task.id));
    // A task still waiting in line stays retryable at startup.
    if (task.status === 'accepted' && !merged(st, task)) return 'deferred';
  }
  return 'done';
}

module.exports = { reviewHeld, advance };
