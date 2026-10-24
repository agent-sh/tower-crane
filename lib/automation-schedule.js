'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Runtime = require('./runtime');
const C = require('./gates/common');
const { isDeepStrictEqual } = require('node:util');
const { refuse, usage } = require('./util');
const { randomUUID } = require('node:crypto');
const { GOVERNOR_RETRY_MS, current, eligible, live, merged, reactionContext, sourceOf, trusted } = require('./automation-common');
const { cap, executors } = require('./automation-executors');

// The reaction waiting for an executor that ranks ahead of this event, if any.
function outranked(st, event) {
  const latest = requests(st);
  const accepted = acceptances(st);
  const position = (s) => {
    const i = st.events.findIndex((e) => sourceOf(e) === s);
    return i < 0 ? Infinity : i;
  };
  const rank = (e) => turn(latest, accepted, e, position(sourceOf(e)));
  const own = sourceOf(event);
  const first = executorWaiters(st).find((e) => sourceOf(e) !== own);
  return first && order(rank(first), rank(event)) < 0 ? first : null;
}

// Owed reactions that stopped for a full cap, in drain order, whose tasks no
// live reaction holds. A reaction that died running keeps its place too: a
// drain that passed over it while it was alive must not hand the slot it
// freed to newer work.
function executorWaiters(st) {
  if (infrastructureHeld(st)) return [];
  const last = receipts(st);
  return waiting(st).filter((e) => {
    const receipt = last.get(sourceOf(e));
    return receipt?.phase === 'executor' || (receipt?.phase === 'running' && !live(receipt));
  });
}

// Priority belongs to the task across heads and revisions. Acceptance and
// cancellation end it even if the task later reopens.
function requests(st) {
  const latest = new Map();
  let nextRank = 1;
  st.events.forEach((e, index) => {
    if (e.cmd === 'accept' || e.cmd === 'hotfix rework' || e.detail?.status === 'cancelled'
      || e.cmd === 'gates prioritize' && e.detail.clear) {
      latest.delete(e.task);
    } else if (e.cmd === 'gates prioritize') {
      const previous = latest.get(e.task);
      const rank = e.detail.rank ?? previous?.rank ?? nextRank;
      nextRank = Math.max(nextRank, rank + 1);
      latest.set(e.task, { index: previous?.index ?? index, rank, event: e });
    }
  });
  return latest;
}

// An accepted task's older notifications also run its merge, so rank them by
// the current acceptance rather than the notification's submission time.
function acceptances(st) {
  const tasks = new Map(st.tasks.tasks.filter((t) => t.status === 'accepted' && t.pr && !merged(st, t))
    .map((t) => [t.id, t]));
  const accepted = new Map([...tasks.keys()].map((id) => [id, -1]));
  st.events.forEach((e, index) => {
    const task = tasks.get(e.task);
    if (task && e.cmd === 'accept' && C.sameSha(e.detail.sha, task.sha) && e.detail.revision === task.revision) {
      accepted.set(task.id, index);
    }
  });
  return accepted;
}

// Merges go first in acceptance order. Task priorities follow in rank and
// first-request order, then ordinary submission order.
function turn(latest, accepted, event, index) {
  if (accepted.has(event.task)) return [0, accepted.get(event.task), 0, index];
  const request = latest.get(event.task);
  return request ? [1, request.rank, request.index, index] : [2, 0, 0, index];
}

function order(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

// Tasks whose latest reaction receipt is live, so an executor holds them.
function busy(st) {
  const held = new Set();
  for (const e of st.events) {
    if (e.cmd !== 'automation') continue;
    if (live(e.detail)) held.add(e.task);
    else held.delete(e.task);
  }
  return held;
}

function receipts(st) {
  const out = new Map();
  for (const e of st.events) if (e.cmd === 'automation') out.set(e.detail.source, { ...e.detail, at: e.at, task: e.task });
  return out;
}

function governorDeferral(receipt) {
  if (receipt?.phase !== 'deferred') return null;
  if (receipt.governor) return receipt.governor;
  // Older receipts have only the governor's error text, and direct reactions
  // did not emit a queue entry. Keep those sources in their original turn too.
  const match = /^([^:]+): (.+) (?:deferred|stopped) by the host governor: (.+)$/.exec(receipt.error || '');
  const kind = match && Object.entries(require('./governor').KIND_TEXT).find(([, text]) => text === match[2])?.[0];
  const locked = /^the host governor's registry is locked \(.+\); retry$/.test(receipt.error || '');
  if (!kind && !locked) return null;
  return { task: kind ? match[1] : receipt.task, kind: kind || 'tests', reason: kind ? match[3] : receipt.error,
    until: Date.parse(receipt.at) + GOVERNOR_RETRY_MS, since: receipt.at, at: receipt.at };
}

// A damaged runtime's own receipt wakes its watcher. Delay that root's
// retries across sources and processes; another code copy can drain at once.
function infrastructureHeld(st) {
  return st.events.some(e => e.cmd === 'automation' && e.detail.phase === 'infrastructure'
    && e.detail.infrastructure?.root === Runtime.ROOT && e.detail.infrastructure.until > Date.now());
}

// Queued notifications still owed a run, in drain order. A notification whose
// own reaction is running has been taken, so it is not owed; a dead reaction's
// notification, a governor deferral or a wait for an executor is owed again
// for its retry.
function pending(st) {
  const queued = new Set(st.events.filter((e) => e.cmd === 'automation queued').map((e) => e.detail.source));
  for (const e of st.events) if (e.cmd === 'automation reconcile' && e.detail.gates) queued.add(sourceOf(e));
  const last = receipts(st);
  for (const [source, receipt] of last) if (governorDeferral(receipt)) queued.add(source);
  if (!queued.size) return [];
  const latest = requests(st);
  const accepted = acceptances(st);
  const found = [];
  st.events.forEach((e, index) => {
    const source = sourceOf(e);
    const receipt = last.get(source);
    const owed = !receipt || ['infrastructure', 'executor'].includes(receipt.phase)
      || (receipt.phase === 'running' && !live(receipt)) || governorDeferral(receipt);
    if (queued.has(source) && owed && eligible(st, e)) {
      found.push({ e, turn: turn(latest, accepted, e, index) });
    }
  });
  return found.sort((a, b) => order(a.turn, b.turn)).map(({ e }) => e);
}

// pending() under a name the drain loop does not shadow.
function owed(st) {
  return pending(st);
}

// Persistent deferrals outlive the host registry's short-lived admission hints.
function governorDeferred(st) {
  const last = receipts(st);
  return pending(st).flatMap((e) => {
    const deferred = governorDeferral(last.get(sourceOf(e)));
    return deferred ? [{ ...deferred, source: sourceOf(e) }] : [];
  });
}

// Queued notifications whose task no live reaction holds, in drain order.
// Governor deferrals keep their place while waiting for their retry admission.
function waiting(st) {
  const held = busy(st);
  return pending(st).filter((e) => !held.has(e.task));
}

// One task reaction runs at a time, outside the state lock. A dead reaction
// leaves a retryable start receipt; another host's unobservable PID stays
// busy. Returns 'behind' when a slot is free but an older waiter owns it.
function reserve(ctx, event, snapshot) {
  const { admissible } = require('./automation-refill');
  const source = sourceOf(event);
  // Governor probes can touch its registry, so run them outside the state lock.
  // Held debt retains its rank but cannot own the next executor.
  const admitted = new Map();
  for (const { source, ...deferred } of governorDeferred(snapshot)) {
    if (Date.now() >= deferred.until && admissible(ctx, snapshot, deferred)) admitted.set(source, deferred);
  }
  return S.mutate(ctx, 'automation', (st, emit) => {
    if (!eligible(st, event)) return false;
    const own = st.events.findLast((e) => e.cmd === 'automation' && e.detail.source === source);
    if (own?.detail.phase === 'done') return false;
    const queue = (detail) => {
      if (!st.events.some((e) => e.cmd === 'automation queued' && e.detail.source === source)) {
        emit(event.task, { source, ...detail }, 'automation queued');
      }
      return false;
    };
    const lastReceipts = receipts(st);
    const runtimeHeld = infrastructureHeld(st);
    const runnable = (e) => {
      if (runtimeHeld) return false;
      const source = sourceOf(e);
      const deferred = governorDeferral(lastReceipts.get(source));
      // A new or changed deferral waits for a fresh probe on the next pass.
      return !deferred || (Date.now() >= deferred.until && isDeepStrictEqual(admitted.get(source), deferred));
    };
    if (!runnable(event)) return queue({});
    const last = st.events.findLast((e) => e.cmd === 'automation' && e.task === event.task);
    if (live(last?.detail)) return queue({});
    // A reaction that stopped for a full cap is retried only once a slot is
    // free and no older waiter owns it, so a retry spends no GitHub read
    // while every executor is busy. Any other reaction starts at once.
    if (own?.detail.phase === 'executor') {
      const limit = cap(st);
      if (executors(st) >= limit) return queue({ executors: limit });
      if (outranked(st, event)) {
        queue({ executors: limit });
        return 'behind';
      }
    }
    emit(event.task, { source, phase: 'running', pid: process.pid, ...P.identity(process.pid) });
    return true;
  });
}

// Merges outside a task's own reaction take its reservation, waiting while
// another observable executor holds it. A holder in this process is already
// serialized, so it is reused. Returns the canonical id, or null when reused.
async function hold(ctx, id, source, check = () => {}) {
  for (;;) {
    ctx.automationSignal?.throwIfAborted();
    const held = S.mutate(ctx, 'automation', (st, emit) => {
      const task = T.getTask(st, id);
      check(task);
      const last = st.events.findLast((e) => e.cmd === 'automation' && e.task === task.id);
      if (last?.detail.phase === 'running') {
        if (last.detail.pid === process.pid && last.detail.host === P.identity(process.pid).host) return { id: null };
        const holder = P.processState(last.detail);
        if (holder === 'running') return null;
        if (holder === 'unknown') {
          throw refuse(`${task.id}: automation pid ${last.detail.pid} on ${last.detail.host || 'an unknown host'} holds the task and cannot be observed; rerun merge after it finishes`);
        }
      }
      emit(task.id, { source, phase: 'running', pid: process.pid, ...P.identity(process.pid) });
      return { id: task.id };
    });
    if (held) return held.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function unhold(ctx, id, source, error) {
  if (!id) return;
  S.mutate(ctx, 'automation', (st, emit) => {
    emit(id, { source, phase: error ? 'error' : 'done', error: error?.message ?? null });
  });
}

function queuedFor(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  return st.events.filter((e) => e.cmd === 'automation queued' && e.task === id)
    .flatMap((e) => {
      const last = st.events.findLast((x) => x.cmd === 'automation' && x.detail.source === e.detail.source);
      const source = st.events.find((x) => sourceOf(x) === e.detail.source);
      return source && (!last || ['running', 'infrastructure'].includes(last.detail.phase)) && eligible(st, source) ? [source] : [];
    });
}

// Tasks a scheduled CI recheck would only queue behind: one whose reaction is
// running, or one with a queued reconcile still owed a run. A reconcile that
// waits only for an executor already read GitHub, so the next minute's recheck
// still runs.
function owedReconcile(st) {
  const last = receipts(st);
  return new Set([...busy(st), ...pending(st).filter((e) => e.cmd === 'automation reconcile'
    && last.get(sourceOf(e))?.phase !== 'executor').map((e) => e.task)]);
}

// pendingCIOnly is the scheduled recheck: only tasks whose CI is pending and not
// stalled, and not one whose earlier recheck is still owed.
function backlog(ctx, pendingCIOnly = false) {
  if (!trusted(ctx)) return [];
  const due = (st, t) => {
    const ci = T.latestGateEvidence(t, 'ci', st.events);
    return ci?.pending && !ci.stalled;
  };
  const active = (st) => {
    const owed = pendingCIOnly ? owedReconcile(st) : new Set();
    return st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t)
      && (!pendingCIOnly || (due(st, t) && !owed.has(t.id))));
  };
  if (!active(S.loadState(ctx.stateDir)).length) return [];
  const startup = randomUUID();
  // GitHub can change while no watcher runs. A fresh request bypasses old
  // event receipts while keeping the same task reservation and gate evidence.
  try {
    S.mutate(reactionContext(ctx), 'automation reconcile', (st, emit) => {
      for (const task of active(st)) emit(task.id, { sha: task.sha, revision: task.revision, startup });
    }, 0);
  } catch (e) {
    if (e.code === 3) return null;
    throw e;
  }
  return S.readEvents(ctx.stateDir).filter((e) => e.cmd === 'automation reconcile' && e.detail.startup === startup);
}

// Operational: the orchestrator or the owner moves a task's queued gate work
// ahead of other submitted work. Accepted merges keep acceptance order.
// New priorities require queued work; clearing also works during rework.
function prioritize(ctx) {
  const reason = (ctx.flags.reason || '').trim();
  const clear = !!ctx.flags.clear;
  const rank = ctx.flags.rank;
  if (clear && (ctx.flags.reason !== undefined || rank !== undefined)) throw usage('--clear cannot be combined with --reason or --rank');
  if (!clear && !reason) throw usage('gates prioritize needs --reason so the queue shows why');
  if (rank !== undefined && (!Number.isSafeInteger(rank) || rank < 0)) {
    throw usage('--rank must be a nonnegative safe integer; lower ranks run first');
  }
  S.mutate(ctx, 'gates prioritize', (st, emit) => {
    const who = require('./authority').enforce(ctx, st, ['gates.priority'], { emit });
    const task = T.getTask(st, ctx.pos[0]);
    if (clear) {
      emit(task.id, { clear: true, authority: who });
      return;
    }
    if (task.status === 'accepted') {
      throw refuse(`${task.id} is accepted; its merge already runs ahead of submitted gate work, in acceptance order`);
    }
    const sources = [...new Set(pending(st).filter((e) => e.task === task.id).map(sourceOf))];
    if (!sources.length) throw refuse(`${task.id} has no queued gate work to prioritize`);
    emit(task.id, { reason, ...(rank !== undefined ? { rank } : {}), queued: sources.length, sources, authority: who });
  });
  const { st, task } = current(ctx, ctx.pos[0]);
  return { data: T.describeTask(st, task, Date.now()), text: clear ? `${task.id} gate priority cleared` : `${task.id} prioritized in the gate queue: ${reason}` };
}

// The gate queue: the tasks whose reactions run now, the queued tasks in the
// order a free executor takes them, and the queued tasks whose next reaction
// waits behind their own running one. Each task carries the request that moved
// it, if any. An accepted task's place comes from its acceptance, so a request
// made before it does not show.
function gateQueue(st) {
  const executing = new Map();
  for (const e of st.events) if (e.cmd === 'automation') executing.set(e.task, e.detail);
  const running = [...executing].filter(([, d]) => live(d)).map(([id]) => id);
  const latest = requests(st);
  const accepted = acceptances(st);
  const held = busy(st);
  const last = receipts(st);
  const tasks = (events) => {
    const out = [];
    for (const e of events) {
      if (out.some((q) => q.id === e.task)) continue;
      const moved = accepted.has(e.task) ? null : latest.get(e.task);
      const request = moved?.event;
      out.push({ id: e.task, prioritized: request ? { reason: request.detail.reason, agent: request.agent, at: request.at, rank: moved.rank } : null });
    }
    return out;
  };
  return { running, queued: tasks(waiting(st)), blocked: tasks(pending(st).filter((e) => held.has(e.task))),
    deferred: tasks(pending(st).filter((e) => governorDeferral(last.get(sourceOf(e))))) };
}

// One line for `status` and `inbox`: the queued tasks in the order executors
// take them, each with its prioritized reason, or `none`; then the tasks blocked
// behind their running reactions, then the governor deferrals still owed.
function describeQueue({ queued, blocked, deferred = [] }) {
  const item = ({ id, prioritized }) => (prioritized ? `${id} (prioritized: ${prioritized.reason})` : id);
  const parts = [queued.length ? queued.map(item).join(', ') : 'none'];
  if (blocked.length) parts.push(`blocked behind their running reactions: ${blocked.map(item).join(', ')}`);
  if (deferred.length) parts.push(`deferred by the governor: ${deferred.map(item).join(', ')}`);
  return parts.join('; ');
}

module.exports = { outranked, executorWaiters, requests, acceptances, turn, order, busy, receipts, governorDeferral, infrastructureHeld, pending, owed, governorDeferred, waiting, reserve, hold, unhold, queuedFor, owedReconcile, backlog, prioritize, gateQueue, describeQueue };
