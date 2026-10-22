'use strict';

const S = require('./state');
const T = require('./tasks');
const I = require('./inbox');
const { usage, refuse } = require('./util');

async function batch(ids, action, limit = Infinity, signal = null) {
  const results = [];
  let completed = 0;
  for (const id of ids) {
    if (completed >= limit) break;
    // A drained wait leaves the rest of its refill to the next wait.
    if (signal?.aborted) break;
    try {
      const result = await action(id);
      results.push({ task: id, ok: !result.code, ...result });
      if (!result.code) completed += 1;
    } catch (e) {
      results.push({ task: id, ok: false, error: e.message, ...(e.dispatchLocked ? { dispatch_locked: true } : {}),
        ...(e.governorDeferred ? { governor_deferred: true } : {}), ...(e.refusalCached ? { refusal_cached: true } : {}) });
      // Another dispatch still holds the slot decisions: skipping to the next
      // task would hand a lower-ranked task the slot and wait once more for each.
      // A host governor deferral holds for every task behind it as well.
      if (e.dispatchLocked || e.governorDeferred) break;
    }
  }
  return { data: { results }, text: results.map((r) => `${r.task}: ${r.error || r.text || 'done'}`).join('\n') || 'nothing to do',
    code: results.some((r) => !r.ok) ? 1 : 0 };
}

async function spawn(ctx) {
  if (!ctx.flags.ready) return require('./spawn').spawn(ctx);
  if (ctx.flags.task || ctx.flags.role || ctx.flags.wait) throw usage('spawn --ready cannot combine with --task, --role or --wait');
  let st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  // Dead reservations hold slots until a spawn clears them, so the batch clears them before it counts.
  if (!ctx.flags['dry-run'] && require('./spawn').clearDeadReservations(ctx)) st = S.loadState(ctx.stateDir);
  const slots = Math.max(0, st.project.limits.workers - T.workerHolders(st, Date.now()).length);
  const ids = I.dispatchable(st, ctx.automation === true).map((t) => t.id);
  return batch(ids, (id) => spawnReadyTask({ ...ctx,
    flags: { task: id, 'dry-run': !!ctx.flags['dry-run'] } }), slots, ctx.automationSignal);
}

// The wait host also dispatches ready workers individually beside reviewer debt.
async function spawnReadyTask(ctx) {
  const id = ctx.flags.task;
  const Spawn = require('./spawn');
  const current = S.loadState(ctx.stateDir);
  const task = T.getTask(current, id);
  if (!ctx.flags['dry-run']) {
    if (!T.hasBrief(current, task)) return { code: 1, error: `${id} has no brief`, refusal_cached: true, skipped: true };
    const reason = Spawn.readyRefusal(ctx, current, task, true);
    if (reason) return { code: 1, error: reason, refusal_cached: true, skipped: true };
  }
  const inputs = !ctx.flags['dry-run'] && task.depends_on.length ? Spawn.readyRefusalKey(ctx, current, task) : null;
  const record = (error) => {
    if (ctx.flags['dry-run'] || error.dispatchLocked || error.governorDeferred
      || error.dispatch_locked || error.governor_deferred || ctx.automationSignal?.aborted) return false;
    const latest = S.loadState(ctx.stateDir);
    const stateInputs = Spawn.readyRefusalStateKey(ctx, latest, T.getTask(latest, id));
    const lasting = !!inputs && Spawn.lastingReadyRefusal(error);
    S.mutate(ctx, 'spawn refused', (_, emit) => emit(id, {
      inputs: lasting ? inputs : null, state_inputs: stateInputs, reason: error.message,
      ...(lasting ? {} : { until: Date.now() + 60000 }),
    }));
    return lasting;
  };
  let result;
  try {
    result = await Spawn.spawn({ ...ctx, readyBatch: true });
  } catch (e) {
    e.refusalCached = record(e);
    throw e;
  }
  if (result.code && record({ ...result, message: result.error || result.text || 'worker dispatch refused' })) {
    return { ...result, refusal_cached: true };
  }
  return result;
}

async function merge(ctx) {
  if (!ctx.flags.accepted) {
    if (!ctx.pos.length) throw usage('merge needs ID or --accepted');
    return require('./automation').merge(ctx);
  }
  if (ctx.pos.length || Object.keys(ctx.flags).some((k) => k !== 'accepted')) throw usage('merge --accepted takes no ID or merge overrides');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  const Stack = require('./stack');
  const accepted = st.tasks.tasks.filter((t) => t.status === 'accepted' && !Stack.merged(st, t));
  // Keep one executor and current-base checks while leaving refused
  // entries for the next batch, so independent mergeable PRs can land.
  const pass = await require('./automation').queue({ ...ctx, acceptedBatch: true });
  const current = S.loadState(ctx.stateDir);
  const skipped = new Map((pass?.refusals || []).map((entry) => [entry.task, entry.reason]));
  const results = accepted.map((before) => {
    const task = T.getTask(current, before.id);
    const evidence = T.latestGateEvidence(task, 'merge', current.events);
    const ok = Stack.merged(current, task);
    const rework = current.events.findLast((e) => e.cmd === 'rework' && e.task === task.id);
    const summary = ok ? evidence.summary : skipped.get(task.id)
      || (task.status !== 'accepted' ? `${task.status}: ${rework?.detail.reason || 'task changed during the queue run'}`
        : !task.pr ? 'accepted task has no PR'
          : 'waiting for lower stack tasks to be accepted and merged');
    return { task: task.id, ok, summary };
  });
  const remaining = results.filter((r) => !r.ok).map((r) => ({ task: r.task, reason: r.summary }));
  return { data: { results, remaining }, text: results.map((r) => `${r.task}: ${r.summary}`).join('\n') || 'accepted merge queue drained',
    code: remaining.length ? 1 : 0 };
}

function release(ctx) {
  if (!ctx.flags.dead) {
    if (!ctx.pos.length) throw usage('release needs ID or --dead');
    return T.release(ctx);
  }
  if (ctx.pos.length || ctx.flags.reason) throw usage('release --dead takes no ID or reason');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  const exited = require('./processes').exitedClaims(st, st.events, { includeTail: false }).filter(({ id }) => {
    if (!ctx.requireExitCleanup) return true;
    return !require('./escalation').releaseBlocker(ctx, st, T.getTask(st, id));
  });
  return batch(exited.map((t) => t.id),
    (id) => T.release({ ...ctx, deadOnly: true, pos: [id], flags: { reason: 'spawned process exited without submit' } }));
}

async function rework(ctx) {
  if (!ctx.flags['from-review']) return T.rework(ctx);
  if (ctx.pos.length || ctx.flags.reason) throw usage('rework --from-review ID takes no positional ID or reason');
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, ctx.flags['from-review']);
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (!review || review.ok !== false) throw refuse(`${task.id}: no current failed review`);
  if (require('./review-findings').bodyOnly(review.findings)) {
    throw refuse(`${task.id}: edit the false PR-body claim, then run accept ${task.id} for a light check; no rework revision is needed. If the body cannot be corrected, run rework ${task.id} --reason R`);
  }
  const findings = await require('./review-findings').resolve(ctx, st, task, review);
  const reason = [`review FAIL by ${review.agent} at ${task.sha}:`, findings.body, findings.ref].filter(Boolean).join('\n');
  return T.rework({ ...ctx, pos: [task.id], fromReview: {
    sha: task.sha, revision: task.revision, pr: task.pr, repo: st.project.repo, review, reason,
  } });
}

async function failedReview(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, id);
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (task.status !== 'submitted' || review?.ok !== false) return null;
  // PR-body findings are corrected in place and rechecked by accept's light review.
  if (require('./review-findings').bodyOnly(review.findings)) return null;
  const result = await rework({ ...ctx, pos: [], flags: { 'from-review': task.id } });
  return { ...result, code: 1, text: `${task.id}: current review FAIL; ${result.text}` };
}

module.exports = { spawn, spawnReadyTask, merge, release, rework, failedReview };
