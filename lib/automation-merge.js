'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Runtime = require('./runtime');
const C = require('./gates/common');
const { isDeepStrictEqual } = require('node:util');
const { refuse, usage } = require('./util');
const { randomUUID } = require('node:crypto');
const { GATE_CHECKS, current, merged } = require('./automation-common');
const { SETTLED, software } = require('./automation-gates');
const { baseTip, conflicts, pr, sweep } = require('./automation-generated');
const { hold, queuedFor, unhold } = require('./automation-schedule');

// A manual merge holds the same task reservation as reactions, so a concurrent
// automatic merge finishes first and this merge confirms its head, or the
// reaction starts after this merge and finds the task merged.
async function merge(ctx) {
  const { consume } = require('./automation');
  if (ctx.flags.accepted) return require('./actions').merge(ctx);
  if (!ctx.pos.length) throw usage('merge needs ID or --accepted');
  // Refusals the gate makes before reading state come first, as without a reservation.
  require('./check').gatePath('merge');
  const recorded = S.mutate(ctx, 'automation', (st) => require('./check').recordedMerge(st, T.getTask(st, ctx.pos[0])));
  if (recorded) return recorded;
  const source = `merge:${randomUUID()}`;
  const id = await hold(ctx, ctx.pos[0], source, (task) => {
    if (task.status !== 'accepted') throw refuse(`${task.id} is ${task.status}; merge needs an accepted task`);
  });
  let result;
  let error = null;
  try {
    result = await require('./check').runGate(ctx, 'merge');
  } catch (e) {
    error = e;
  } finally {
    unhold(ctx, id, source, error);
  }
  // Reactions queued behind this merge are drained here, as an executor would.
  const queued = ctx.queueMerge ? [] : queuedFor(ctx, id || T.getTask(S.loadState(ctx.stateDir), ctx.pos[0]).id);
  if (queued.length) await consume(ctx, queued);
  if (error) throw error;
  return result;
}

// Accepted PRs merge in the order they were accepted. A stack is one entry,
// ordered by its lowest unmerged task, and reaches up through the accepted,
// linked tasks above it: the line checks and merges that chain as a whole, so
// an upper task never heads the line ahead of its lower task.
function line(st) {
  const Stack = require('./stack');
  const order = (t) => st.events.findLastIndex((e) => e.cmd === 'accept' && e.task === t.id
    && C.sameSha(e.detail.sha, t.sha) && e.detail.revision === t.revision);
  const ready = (t) => t?.status === 'accepted' && !!t.pr && !merged(st, t);
  const above = (t) => st.tasks.tasks.find((x) => x.stack?.parent === t.id && x.status !== 'cancelled');
  const entries = [];
  for (const bottom of st.tasks.tasks.filter(ready)) {
    if (Stack.chain(st, bottom).some((m) => m.id !== bottom.id && !merged(st, m))) continue;
    const members = [bottom];
    if (!bottom.stack_disabled) {
      for (let up = above(bottom); ready(up) && up.stack?.linked && !up.stack_disabled; up = above(up)) members.push(up);
    }
    entries.push({ members, target: members.at(-1) });
  }
  return entries.sort((a, b) => order(a.members[0]) - order(b.members[0])
    || a.members[0].id.localeCompare(b.members[0].id, undefined, { numeric: true }));
}

// A head passed over in this pass is keyed by what was refused, so a new
// head or revision of the same task takes its turn again.
function key(task) {
  return `${task.id}@${task.sha}#${task.revision}`;
}

// The head of the line is its first entry not passed over in this pass.
function head(st, passed) {
  return line(st).find((e) => !passed.has(key(e.target)));
}

// What a merge of the head of the line depends on: the project settings and
// each entry member's head, revision, status, PR and stack metadata.
function binding(st, passed) {
  const entry = head(st, passed);
  return { project: st.project, members: (entry?.members || []).map((t) => ({ id: t.id, sha: t.sha,
    revision: t.revision, status: t.status, pr: t.pr, stack: t.stack || null, stack_disabled: !!t.stack_disabled })) };
}

// One executor drains the queue. A request made while it runs is recorded so
// the executor makes another pass before releasing.
function claimQueue(ctx, request = true) {
  return S.mutate(ctx, 'merge queue', (st, emit) => {
    const last = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested');
    if (last?.detail.phase === 'running' && P.processState(last.detail) !== 'exited') {
      if (request) emit(null, { phase: 'requested' });
      return false;
    }
    emit(null, { phase: 'running', pid: process.pid, ...P.identity(process.pid) });
    return true;
  });
}

function releaseQueue(ctx, error, pass) {
  return S.mutate(ctx, 'merge queue', (st, emit) => {
    const own = st.events.findLastIndex((e) => e.cmd === 'merge queue' && e.detail.phase === 'running');
    if (!error && st.events.slice(own + 1).some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested')) {
      emit(null, { phase: 'running', pid: process.pid, ...P.identity(process.pid) });
      return true;
    }
    emit(null, { phase: error ? 'error' : 'done', error: error || null, blocked: pass?.blocked || null, skipped: pass?.skipped || [] });
    return false;
  });
}

async function queue(ctx) {
  ctx.automationSignal?.throwIfAborted();
  const budget = require('./gate-timeouts').minutes(S.loadState(ctx.stateDir).project, 'tests');
  const deadline = Date.now() + budget * 60000;
  let requested = false;
  while (!claimQueue(ctx, !requested)) {
    requested = true;
    if (!ctx.acceptedBatch) return;
    const st = S.loadState(ctx.stateDir);
    const holder = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested');
    if (holder?.detail.phase === 'running' && P.processState(holder.detail) === 'unknown') {
      throw refuse(`merge queue pid ${holder.detail.pid} on ${holder.detail.host || 'an unknown host'} holds the queue and cannot be observed; rerun merge --accepted after it finishes`);
    }
    if (Date.now() >= deadline) throw refuse(`merge queue remained busy for ${budget} min; rerun merge --accepted after its executor finishes`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const at = {};
  try {
    let pass;
    do pass = await drain(ctx, at);
    while (releaseQueue(ctx, null, pass));
    return pass;
  } catch (e) {
    const skipped = [...at.passed.values()];
    releaseQueue(ctx, e.message, { blocked: at.task ? { task: at.task, reason: e.message } : skipped[0], skipped });
    throw e;
  }
}

// A head refused for a reason the queue cannot fix is passed over for the
// rest of the pass and reported once per head and revision, so the tasks
// behind it merge instead of waiting on it at every reaction.
function pass(ctx, passed, task, reason) {
  passed.set(key(task), { task: task.id, reason });
  S.mutate(ctx, 'queue skipped', (st, emit) => {
    if (st.events.some((e) => e.cmd === 'queue skipped' && e.task === task.id
      && C.sameSha(e.detail.sha, task.sha) && e.detail.revision === task.revision)) return;
    emit(task.id, { sha: task.sha, revision: task.revision, reason });
  });
}

// Returns `blocked`, the first head of this pass that did not merge and why
// (null when the line drained), `skipped`, the heads passed over, and
// `refusals`, the reason each unmerged member of those entries cannot land.
async function drain(ctx, at) {
  // A requested pass retries heads whose evidence changed during the last pass.
  const passed = at.passed = new Map();
  const refusals = new Map();
  const done = (blocked) => ({ blocked: blocked || [...passed.values()][0] || null, skipped: [...passed.values()],
    refusals: [...refusals].map(([task, reason]) => ({ task, reason })) });
  for (;;) {
    ctx.automationSignal?.throwIfAborted();
    const st = S.loadState(ctx.stateDir);
    const entry = head(st, passed);
    if (!entry) return done(null);
    at.task = entry.target.id;
    let step;
    try { step = await attempt(ctx, st, entry, passed); }
    catch (e) {
      // A task refusal, including an unreadable PR, must not strand later entries.
      if (Runtime.missing(e) || e.code !== 1) throw e;
      step = { skip: e.message };
    }
    at.task = null;
    // Automatic reactions wait for GitHub to compute mergeability. An
    // explicit batch leaves pending entries for its next invocation.
    if (step.wait && !ctx.acceptedBatch) return done({ task: entry.target.id, reason: step.wait });
    if (step.skip || step.wait) {
      const reason = step.skip || step.wait;
      for (const member of entry.members) refusals.set(member.id, reason);
      pass(ctx, passed, entry.target, reason);
    }
  }
}

// One turn of the head of the line: `{}` when the line should be read again,
// `{wait}` when it must wait or `{skip}` when the head cannot advance.
async function attempt(ctx, st, entry, passed) {
  const { headCheck } = require('./automation-head-check');
  ctx.automationSignal?.throwIfAborted();
  const { members, target } = entry;
  const action = { ...ctx, pos: [target.id], flags: {} };
  const remote = await pr(action, st, target);
  // A PR that already landed goes to the merge gate's confirmation path,
  // which needs no current gate evidence and merges nothing.
  if (remote?.state !== 'MERGED') {
    for (const m of members) {
      const view = m === target ? remote : await pr(action, st, m);
      // A stack merge confirms a lower PR that already landed at its head.
      if (m !== target && view?.state === 'MERGED' && C.sameSha(view.headRefOid, m.sha)) continue;
      if (!view || view.state !== 'OPEN') return { skip: `${m.id}: PR #${m.pr} is ${view?.state || 'unreadable'}` };
      if (!C.sameSha(view.headRefOid, m.sha)) return { skip: `${m.id}: PR #${m.pr} head ${C.short(view.headRefOid)} is not the accepted ${C.short(m.sha)}` };
      if (view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY') {
        const conflict = await conflicts({ ...action, pos: [m.id] }, m, true);
        if (conflict === 'deferred') return { wait: `${m.id}: generated conflicts await matching GitHub confirmation` };
        if (conflict) return {};
        return { skip: `${m.id}: GitHub reports PR #${m.pr} conflicting, but a trial merge with its base is clean` };
      }
      if (view.mergeable !== 'MERGEABLE' || !view.mergeStateStatus || view.mergeStateStatus === 'UNKNOWN') {
        return { wait: `${m.id}: GitHub mergeability of PR #${m.pr} is ${view.mergeable || 'unknown'}/${view.mergeStateStatus || 'unknown'}` };
      }
      // Reports bind the merged result; merge also pins origin's base commit.
      const receipt = T.latestGateEvidence(m, 'ci', st.events)?.receipt;
      const mergeBase = receipt ? (await baseTip(action, st, m, true)).tip : null;
      const refreshLocalCI = !!receipt && mergeBase !== receipt.base_sha;
      const report = T.gateReport(m, st.events, st);
      if (refreshLocalCI || !report.ok && report.gates.some((g) => SETTLED.includes(g.type) && !g.ok)) {
        const source = `refresh:${randomUUID()}`;
        const held = await hold(action, m.id, source, (t) => {
          if (t.status !== 'accepted' || t.sha !== m.sha || t.revision !== m.revision) {
            throw refuse(`${m.id} changed before refreshing its software gates`);
          }
        });
        let error;
        try { await software({ ...action, pos: [m.id], refreshLocalCI }); }
        catch (e) { error = e; throw e; }
        finally { unhold(action, held, source, error); }
        const now = current(action, m.id);
        if (now.task.status !== 'accepted' || now.task.sha !== m.sha || now.task.revision !== m.revision) return {};
        const refreshed = T.gateReport(now.task, now.st.events, now.st);
        const ci = T.latestGateEvidence(now.task, 'ci', now.st.events);
        if (refreshed.ok && refreshLocalCI && ci?.receipt && ci.receipt.base_sha !== mergeBase) {
          return { skip: `${m.id}: local CI selected base ${C.short(ci.receipt.base_sha)} does not match fetched base ${C.short(mergeBase)}; synchronize the base before merging` };
        }
        if (refreshed.ok) return {};
        return { skip: `${m.id}: gates no longer pass: ${refreshed.missing.join('; ')}` };
      }
      if (!report.ok) return { skip: `${m.id}: gates no longer pass: ${report.missing.join('; ')}` };
    }
    let check;
    try { check = await headCheck(action, st, entry, passed); }
    catch (e) { if (Runtime.missing(e) || e.code !== 1) throw e; return { skip: e.message }; }
    ctx.automationSignal?.throwIfAborted();
    if (check.status === 'rework') return {};
    if (check.status === 'deferred') return { wait: check.summary };
    if (check.status === 'infrastructure') return { skip: check.summary };
    // gh pr merge matches the head but cannot match the base. Reading the
    // base again sends a base that moved during the suite to a new check;
    // the seconds between this read and the merge call stay unguarded.
    if (check.tip && (await baseTip(action, st, target, true, st.project.base)).tip !== check.tip) return {};
  }
  // The merge gate reads state again. A head that was reworked, resubmitted
  // or reaccepted, a changed entry or changed settings while the suite ran
  // were never checked, so the line starts over on the current state.
  const bound = binding(st, passed);
  // The line can run under another task's reaction; a manual merge of the
  // target then waits, or this merge finds the line changed.
  let result;
  try {
    result = await merge({ ...action, queueMerge: true,
      expect: (now) => (isDeepStrictEqual(binding(now, passed), bound) ? null : 'head of the line changed during its check') });
  } catch (e) {
    if (Runtime.missing(e) || e.code !== 1) throw e;
    return { skip: e.message };
  }
  if (result.stale) return {};
  if (!result.data.ok) return { skip: `merge refused: ${result.data.summary}` };
  ctx.automationSignal?.throwIfAborted();
  await sweep(ctx);
  return {};
}

// Status stays offline: current evidence wins over a queue refusal recorded before a rerun.
function mergeBlockers(st) {
  return st.tasks.tasks.filter((t) => t.status === 'accepted' && t.pr && !merged(st, t)).flatMap((t) => {
    const report = T.gateReport(t, st.events, st);
    const skipped = st.events.findLast((e) => e.cmd === 'queue skipped' && e.task === t.id
      && C.sameSha(e.detail.sha, t.sha) && e.detail.revision === t.revision);
    const queue = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested');
    const refusal = queue?.detail.blocked?.task === t.id ? queue.detail.blocked : queue?.detail.skipped?.find((b) => b.task === t.id);
    const checked = st.events.findLast((e) => e.task === t.id && [...GATE_CHECKS, 'accept'].includes(e.cmd));
    const newer = (event) => event && (!checked || st.events.indexOf(event) > st.events.indexOf(checked));
    const recorded = refusal && newer(queue) ? refusal : newer(skipped) ? skipped.detail : null;
    const reason = !report.ok ? report.missing.join('; ') : recorded?.reason;
    return reason ? [{ id: t.id, reason }] : [];
  });
}

module.exports = { merge, line, key, head, binding, claimQueue, releaseQueue, queue, pass, drain, attempt, mergeBlockers };
