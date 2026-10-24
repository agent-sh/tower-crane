'use strict';

const S = require('./state');
const T = require('./tasks');
const Runtime = require('./runtime');
const { advance, reviewHeld } = require('./automation-advance');
const { GOVERNOR_RETRY_MS, current, eligible, reactionContext, sourceOf, trusted } = require('./automation-common');
const { runAutomated, gatesRetry, CI_POLL } = require('./automation-gates');
const { sweep, refreshStacks, MERGEABILITY } = require('./automation-generated');
const { queue, merge, mergeBlockers } = require('./automation-merge');
const { admissible, refillWorkers, refillBlockers } = require('./automation-refill');
const { acceptances, governorDeferral, order, owed, receipts, requests, reserve, turn, waiting, busy, outranked, governorDeferred, backlog, prioritize, gateQueue, describeQueue } = require('./automation-schedule');
const { describeExecutors, gateWaits, cpuLeases } = require('./automation-executors');
const { unrestorable, headMoved } = require('./automation-restore');
const { ciCompleted, ciWebhook } = require('./automation-ci');

// Recursive drains share seen sources: a held older source must not send a
// later source repeatedly through the same queue while neither can run.
async function consume(ctx, events, supervisor = false, seen = new Set()) {
  if (!supervisor && !trusted(ctx)) return [];
  if (!Runtime.present()) return events;
  const pending = [];
  const engine = reactionContext(ctx);
  if (!supervisor) await refreshTestsMap(ctx);
  let snapshot = S.loadState(ctx.stateDir);
  // Every caller drains state, including callers that cannot retain a retry list.
  const latest = requests(snapshot);
  const accepted = acceptances(snapshot);
  const positions = new Map(snapshot.events.map((e, i) => [sourceOf(e), i]));
  const rank = (e) => turn(latest, accepted, e, positions.get(sourceOf(e)) ?? Infinity);
  const batch = [...waiting(snapshot), ...events].sort((a, b) => order(rank(a), rank(b)));
  for (const event of batch) {
    if (!Runtime.present()) {
      pending.push(...batch.slice(batch.indexOf(event)));
      break;
    }
    if (ctx.automationSignal?.aborted) break;
    const source = sourceOf(event);
    if (seen.has(source)) continue;
    seen.add(source);
    if (!eligible(snapshot, event)) continue;
    // Probe without taking an executor or writing another receipt while the
    // same governor deferral still holds.
    snapshot = S.loadState(ctx.stateDir);
    const deferred = governorDeferral(receipts(snapshot).get(source));
    if (deferred && (Date.now() < deferred.until || !admissible(engine, snapshot, deferred))) {
      pending.push(event);
      continue;
    }
    const reserved = reserve(engine, event, snapshot);
    // Queued work that drains first takes the free slot; this event is queued
    // behind it, so the drain reaches it in drain order.
    if (reserved === 'behind') pending.push(...await consume(engine, waiting(S.loadState(ctx.stateDir)), true, seen));
    if (reserved !== true) {
      const last = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'automation' && e.detail.source === sourceOf(event));
      if (last?.detail.phase !== 'done') pending.push(event);
      continue;
    }
    let error = null;
    let phase = 'done';
    let governor = null;
    let report = null;
    let infrastructure = false;
    let executor = null;
    // The executor this reaction holds for its CPU work, shared by every
    // context derived from the action below.
    const slot = { event, source, lease: null, task: null, kind: null };
    try {
      const action = { ...engine, pos: [event.task], refreshCI: event.cmd === 'automation reconcile', executor: slot };
      if (event.cmd === 'merge') {
        await sweep(action);
        await queue(action);
      } else {
        const now = current(action, event.task);
        const ci = T.latestGateEvidence(now.task, 'ci', now.st.events);
        const pendingAcceptedCI = action.refreshCI && now.task.status === 'accepted' && ci?.pending && !ci.stalled;
        if (event.cmd === 'ci completed' || pendingAcceptedCI) await runAutomated(action, 'ci', { notified: event.cmd === 'ci completed' });
        phase = await advance(action);
      }
    } catch (e) {
      error = e.message;
      phase = 'error';
      if (Runtime.missing(e)) {
        phase = 'infrastructure';
        infrastructure = true;
      }
      if (e.governorDeferred) {
        phase = 'deferred';
        governor = e;
      }
      if (e.executorDeferred) {
        phase = 'executor';
        executor = e.executorDeferred;
      }
      if (!ctx.automationSignal?.aborted && !executor) report = `tower-crane: automation ${event.task}: ${error}\n`;
    } finally {
      if (ctx.automationSignal?.aborted && !infrastructure) {
        phase = 'deferred';
        error = ctx.automationSignal.reason.message;
      }
      // The event lands before the message, so whoever reads the message finds the phase recorded.
      try {
        S.mutate(engine, 'automation', (st, emit) => {
          let held = null;
          if (governor) {
            const at = new Date().toISOString();
            held = { until: Date.now() + GOVERNOR_RETRY_MS, task: governor.task || event.task,
              kind: governor.kind || 'tests', reason: governor.reason || error, since: deferred?.since || at, at };
          }
          if (slot.lease) emit(slot.task, { lease: slot.lease, phase: 'done' }, 'executor');
          // One waiter per task holds its place in line: the reaction it
          // resumes advances the task from its current state, so a later
          // notification that reached the same CPU work is covered by it.
          if (phase === 'executor') {
            const last = receipts(st);
            if (owed(st).some((e) => e.task === event.task && sourceOf(e) !== source
              && last.get(sourceOf(e))?.phase === 'executor')) phase = 'done';
          }
          if ((governor || infrastructure || phase === 'executor')
            && !st.events.some((e) => e.cmd === 'automation queued' && e.detail.source === source)) {
            emit(event.task, { source, ...(phase === 'executor' ? { executors: executor.executors } : {}) }, 'automation queued');
          }
          emit(event.task, { source, phase, error, ...(phase === 'executor' ? { kind: executor.kind } : {}), ...(held ? { governor: held } : {}),
            ...(infrastructure ? { infrastructure_failure: true,
              infrastructure: { root: Runtime.ROOT, until: Date.now() + GOVERNOR_RETRY_MS } } : {}) });
        });
      } finally {
        if (report) process.stderr.write(report);
      }
    }
    if (ctx.automationSignal?.aborted) break;
    if (infrastructure) {
      pending.push(event);
      break;
    }
    if (governor || phase === 'executor') {
      pending.push(event);
    }
    // A reviewer can finish while its dispatch reaction still owns this task,
    // and other reactions may wait for the executor it released. Drain them in
    // drain order, even without a live waiter.
    const queued = waiting(S.loadState(ctx.stateDir));
    if (queued.length) pending.push(...await consume(engine, queued, true, seen));
    snapshot = S.loadState(ctx.stateDir);
  }
  return pending;
}

async function refreshTestsMap(ctx) {
  if (!trusted(ctx)) return false;
  try { return await require('./tests-map-refresh').automatic(reactionContext(ctx)); }
  catch (e) {
    if (!ctx.automationSignal?.aborted) process.stderr.write(`tower-crane: tests.map refresh: ${e.message}\n`);
    return false;
  }
}

module.exports = { consume, refreshTestsMap, refillWorkers, refillBlockers, busy, outranked, governorDeferred, ciCompleted, ciWebhook, backlog, merge, queue, prioritize, gateQueue, mergeBlockers, describeQueue, describeExecutors, gateWaits, cpuLeases, gatesRetry, unrestorable, headMoved, refreshStacks, reviewHeld, MERGEABILITY, CI_POLL };
