'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const { shortTime } = require('./util');
const { createHash } = require('node:crypto');
const { reactionContext, sourceOf, trusted } = require('./automation-common');
const { busy } = require('./automation-schedule');

async function refillWorkers(ctx, attempt) {
  if (ctx.automationSignal?.aborted || !trusted(ctx)) return;
  const engine = reactionContext(ctx);
  let st = S.loadState(ctx.stateDir);
  // Observation alone keeps dead leases. The automation host recovers them
  // before counting capacity, including exits recorded before its cursor.
  if (P.exitedClaims(st, st.events, { includeTail: false }).length) {
    await require('./actions').release({ ...engine, pos: [], flags: { dead: true }, requireExitCleanup: true });
    st = S.loadState(ctx.stateDir);
  }
  if (require('./spawn').clearDeadReservations(engine)) st = S.loadState(ctx.stateDir);
  if (require('./ownership').resumeHeld(engine, busy(st)).length) st = S.loadState(ctx.stateDir);
  // The wait host sets its hold timer from this.
  attempt.hold = require('./rework-hold').nextEnd(st);
  const holders = T.workerHolders(st, Date.now());
  const R = require('./reviewer');
  const reacting = busy(st);
  const debts = new Map((st.project.limits.paused ? [] : R.deferredDispatches(st)).map((d) => [d.id, d]));
  const reviews = [...debts.keys()].map((id) => T.getTask(st, id))
    .filter((task) => !reacting.has(task.id) && R.softwareReport(st, task).ok);
  const workers = holders.length < st.project.limits.workers ? require('./inbox').dispatchable(st, true) : [];
  const counts = T.unblockCounts(st);
  const ready = [...workers, ...reviews].sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent')
    || counts.get(b.id) - counts.get(a.id) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (!ready.length) return;
  const routing = st.events.findLast((e) => e.cmd === 'ladder set');
  const common = JSON.stringify({ project: st.project, holders, routing: routing ? sourceOf(routing) : null });
  const orders = new Map([false, true].map((review) => [review,
    createHash('sha256').update(common).update(JSON.stringify(
      ready.filter((task) => debts.has(task.id) === review).map((task) => [task.id, task.priority, counts.get(task.id)])
    )).digest('hex'),
  ]));
  const keys = new Map(ready.map(({ notes, spend, ...task }) => {
    const changed = st.events.findLast((e) => e.task === task.id && ['brief set', 'task update'].includes(e.cmd));
    const review = debts.has(task.id);
    return [task.id, createHash('sha256').update(orders.get(review)).update(JSON.stringify({
      task: { ...task, spend: { tokens: spend.tokens, minutes: spend.minutes }, changed: changed ? sourceOf(changed) : null },
      body_recheck: debts.get(task.id)?.body_recheck,
      review_retry: debts.get(task.id)?.review_retry,
    })).digest('hex')];
  }));
  // An ordinary refusal belongs to its task. Governor debt remains eligible
  // even while another task waits for the reconciliation minute.
  const refusals = attempt.refusals ||= new Map();
  const runnable = ready.filter((task) => {
    const cached = refusals.get(task.id);
    return !cached || cached.key !== keys.get(task.id) || Date.now() >= cached.until;
  });
  if (!runnable.length) return;
  if (ctx.automationSignal?.aborted) return;
  // Another dispatch still running defers the refill to the next pass before
  // the stack reads and fetches a dispatch makes ahead of the lock.
  const Spawn = require('./spawn');
  const seen = Spawn.dispatchSeen(engine);
  if (seen.holder || seen.stuck) {
    // A marker that cannot be removed stays until a person acts: say so once
    // per wait, not on every pass.
    const stuck = seen.stuck && `${seen.stuck.holder?.nonce}:${seen.stuck.code}`;
    if (stuck && attempt.stuck !== stuck) {
      process.stderr.write(`tower-crane: automation refill: ${Spawn.dispatchLocked(Spawn.dispatchLockPath(engine), seen).message}\n`);
    }
    attempt.stuck = stuck || null;
    return;
  }
  attempt.stuck = null;
  // Each kind reserves a different amount of memory. A deferral holds its
  // own kind while other kinds can still fit, in their priority order.
  const checkedKinds = new Set();
  const deferredKinds = new Set();
  for (const task of runnable) {
    const kind = reviews.includes(task) ? 'reviewer' : 'worker';
    if (checkedKinds.has(kind)) continue;
    checkedKinds.add(kind);
    try {
      R.admission(engine, { job: kind, task }, () => require('./governor').check(engine, { kind, task: task.id, project: st.project }));
    } catch (e) {
      if (!e.governorDeferred) throw e;
      deferredKinds.add(kind);
      if (!attempt.governor?.includes(kind)) process.stderr.write(`tower-crane: automation refill: ${e.message}\n`);
    }
  }
  attempt.governor = [...deferredKinds];
  if (deferredKinds.size === checkedKinds.size) {
    return;
  }
  const results = [];
  for (const task of runnable) {
    if (ctx.automationSignal?.aborted) break;
    const now = S.loadState(ctx.stateDir);
    const review = reviews.includes(task);
    const kind = review ? 'reviewer' : 'worker';
    if (deferredKinds.has(kind)) continue;
    const debt = review ? R.deferredDispatches(now).find((d) => d.id === task.id) : null;
    if (review) {
      if (busy(now).has(task.id) || !debt) continue;
    } else if (T.workerHolders(now, Date.now()).length >= now.project.limits.workers
      || !require('./inbox').dispatchable(now, true).some((t) => t.id === task.id)) continue;
    let result;
    try {
      const started = await Spawn.spawn({ ...engine, pos: [], readyBatch: !review,
        ...(debt?.body_recheck ? { bodyRecheck: debt.body_recheck } : {}),
        ...(debt?.review_retry ? { reviewRetry: debt.review_retry } : {}),
        flags: { task: task.id, ...(review ? { role: 'review' } : {}) } });
      result = { task: task.id, ok: !started.code, ...started };
    } catch (e) {
      result = { task: task.id, ok: false, error: e.message,
        dispatch_locked: !!e.dispatchLocked, governor_deferred: !!e.governorDeferred };
    }
    results.push(result);
    if (!result.ok && !result.dispatch_locked && !result.governor_deferred) {
      refusals.set(task.id, { key: keys.get(task.id), until: Date.now() + 60000 });
    } else refusals.delete(task.id);
    if (result.dispatch_locked) break;
    if (result.governor_deferred) deferredKinds.add(kind);
  }
  attempt.governor = [...deferredKinds];
  if (results.some((r) => !r.ok)) {
    process.stderr.write(`tower-crane: automation refill: ${results.map((r) => `${r.task}: ${r.error || r.text || 'done'}`).join('\n')}\n`);
  }
}

// Why automatic refill leaves each ready task undispatched now, for status:
// the checks refillWorkers and spawn make, read without a lock or a write. A
// task with no reason here goes to the next refill pass. governor is the
// host governor's view; refill rechecks a worker deferral on every pass, so
// the latest one stands until it lifts.
function refillBlockers(ctx, st, governor = null, now = Date.now()) {
  const Hold = require('./rework-hold');
  const { liveWorker } = require('./inbox');
  const reacting = busy(st);
  const holders = T.workerHolders(st, now);
  const limit = st.project.limits.workers;
  const lock = S.markedLockHolder(require('./spawn').dispatchLockPath(ctx), true);
  const deferred = governor?.deferred.findLast((d) => d.kind === 'worker');
  let free = limit - holders.length;
  const out = [];
  for (const { task } of T.readyTasks(st, now)) {
    if (!['todo', 'rework'].includes(task.status) || liveWorker(st, task)) continue;
    const until = Hold.holdEnd(st, task, now);
    let reason = null;
    if (!T.hasBrief(st, task)) reason = 'no brief';
    else if (reacting.has(task.id)) reason = 'its gate reaction is running';
    else if (until) reason = `rework hold until ${shortTime(until)}`;
    else if (holders.length >= limit) reason = `worker limit reached (${holders.length} of ${limit}: ${holders.map((h) => h.task).join(', ')})`;
    else if (free <= 0) reason = `waits behind higher-ranked tasks for the ${limit - holders.length} free worker slot${limit - holders.length === 1 ? '' : 's'}`;
    else {
      free -= 1;
      if (lock) reason = `dispatch lock held by pid ${lock.pid ?? 'unknown'}${lock.at ? ` since ${lock.at}` : ''}`;
      else if (deferred) reason = `host governor deferred workers since ${deferred.since}: ${deferred.reason}`;
    }
    if (reason) out.push({ id: task.id, reason, ...(until ? { until } : {}) });
  }
  return out;
}

function admissible(ctx, st, { task, kind }) {
  try {
    require('./governor').check(ctx, { kind, task, project: st.project });
    return true;
  } catch (e) {
    if (e.governorDeferred) return false;
    throw e;
  }
}

module.exports = { refillWorkers, refillBlockers, admissible };
