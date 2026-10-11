'use strict';

const S = require('./state');
const T = require('./tasks');
const I = require('./inbox');
const { usage, refuse } = require('./util');

async function batch(ids, action, limit = Infinity) {
  const results = [];
  let completed = 0;
  for (const id of ids) {
    if (completed >= limit) break;
    try {
      const result = await action(id);
      results.push({ task: id, ok: !result.code, ...result });
      if (!result.code) completed += 1;
    } catch (e) { results.push({ task: id, ok: false, error: e.message }); }
  }
  return { data: { results }, text: results.map((r) => `${r.task}: ${r.error || r.text || 'done'}`).join('\n') || 'nothing to do',
    code: results.some((r) => !r.ok) ? 1 : 0 };
}

async function spawn(ctx) {
  if (!ctx.flags.ready) return require('./spawn').spawn(ctx);
  if (ctx.flags.task || ctx.flags.role || ctx.flags.wait) throw usage('spawn --ready cannot combine with --task, --role or --wait');
  const st = S.loadState(ctx.stateDir);
  I.authorized(ctx, st);
  const slots = Math.max(0, st.project.limits.workers - T.workerHolders(st, Date.now()).length);
  const ids = I.dispatchable(st).map((t) => t.id);
  return batch(ids, (id) => require('./spawn').spawn({ ...ctx, readyBatch: true,
    flags: { task: id, 'dry-run': !!ctx.flags['dry-run'] } }), slots);
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
  return batch(require('./processes').exitedClaims(st, st.events, { includeTail: false }).map((t) => t.id),
    (id) => T.release({ ...ctx, deadOnly: true, pos: [id], flags: { reason: 'spawned process exited without submit' } }));
}

async function rework(ctx) {
  if (!ctx.flags['from-review']) return T.rework(ctx);
  if (ctx.pos.length || ctx.flags.reason) throw usage('rework --from-review ID takes no positional ID or reason');
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, ctx.flags['from-review']);
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (!review || review.ok !== false) throw refuse(`${task.id}: no current failed review`);
  const findings = await require('./review-findings').resolve(ctx, st, task, review);
  const reason = [`review FAIL by ${review.agent} at ${task.sha}:`, findings.body, findings.ref].filter(Boolean).join('\n');
  return T.rework({ ...ctx, pos: [task.id], fromReview: {
    sha: task.sha, revision: task.revision, pr: task.pr, repo: st.project.repo, review, reason,
  } });
}

module.exports = { spawn, merge, release, rework };
