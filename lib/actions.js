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
        ...(e.governorDeferred ? { governor_deferred: true } : {}) });
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
  return batch(ids, (id) => require('./spawn').spawn({ ...ctx, readyBatch: true,
    flags: { task: id, 'dry-run': !!ctx.flags['dry-run'] } }), slots, ctx.automationSignal);
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
    throw refuse(`${task.id}: edit the false PR-body claim or the PR title, then run accept ${task.id} for a light check; no rework revision is needed. For code changes, run rework ${task.id} --reason R`);
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
  if (reviewRetry(ctx, task, review)) return null;
  // PR-body findings are corrected in place and rechecked by accept's light review.
  if (require('./review-findings').bodyOnly(review.findings)) return null;
  const result = await rework({ ...ctx, pos: [], flags: { 'from-review': task.id } });
  return { ...result, code: 1, text: `${task.id}: current review FAIL; ${result.text}` };
}

function reviewRetry(ctx, task, review) {
  if (!ctx.reviewRetry) return false;
  if (ctx.reviewRetry.sha !== task.sha || ctx.reviewRetry.revision !== task.revision
    || !require('node:util').isDeepStrictEqual(ctx.reviewRetry.review, review)) {
    throw refuse(`${task.id}: failed review changed while retrying; retry accept`);
  }
  return true;
}

function acceptFailure(st, task) {
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (review?.ok !== false || require('./review-findings').bodyOnly(review.findings)) return null;
  const items = I.local(st);
  const inbox = items.find((i) => i.task === task.id && i.kind === 'review_held')
    || items.find((i) => i.task === task.id && i.kind === 'review_failed') || null;
  return { data: { ...task, review_failed: true, review, inbox }, code: 1,
    text: `${task.id}: current review FAIL at ${task.sha}, revision ${task.revision}; full review already failed. ${inbox?.action.command || review.ref || review.summary}` };
}

function pendingRetry(st, task, review) {
  const request = st.events.findLast((e) => e.task === task.id
    && (e.cmd === 'spawn' && e.detail.role === 'reviewer'
      || ['review dispatch deferred', 'review dispatch context'].includes(e.cmd))
    && e.detail.revision === task.revision && require('./util').shaMatch(e.detail.sha, task.sha));
  return !!request?.detail.review_retry
    && require('node:util').isDeepStrictEqual(request.detail.review_retry.review, review);
}

module.exports = { spawn, merge, release, rework, failedReview, reviewRetry, acceptFailure, pendingRetry };
