'use strict';

const S = require('./state');
const L = require('./ladder');
const T = require('./tasks');
const P = require('./processes');
const Sessions = require('./spawn-session');
const { nowIso, shaMatch, refuse } = require('./util');

function spendByRung(task) {
  const result = {};
  for (const entry of task.spend.entries || []) {
    if (!entry.rung) continue;
    const total = result[entry.rung] ||= { tokens: 0, cost_usd: 0 };
    total.tokens = total.tokens === null || entry.tokens === null ? null : total.tokens + entry.tokens;
    total.cost_usd = total.cost_usd === null || entry.cost_usd == null ? null : total.cost_usd + entry.cost_usd;
  }
  return result;
}

function exitBlocker(ctx, st, worker) {
  const after = st.events.slice(st.events.indexOf(worker) + 1);
  const latest = after.findLast((e) => e.task === worker.task && ['spawn retry', 'spawn fallback'].includes(e.cmd)
    && e.detail.agent === worker.detail.agent && e.detail.attempt === worker.detail.attempt) || worker;
  if (after.some((e) => e.cmd === 'spawn exit' && e.detail.active === false
    && P.exitSpawn(e, st.events) === latest)) return null;
  // A submitted parent's exit does not prove its monitor finished group cleanup.
  const canProbe = worker.detail.monitor_pid === process.pid || require('./events').canObserve(ctx, st.events, worker);
  if (worker.detail.monitor_pid && (!canProbe || P.processState(P.monitorProcess(worker.detail)) !== 'exited')) return 'previous worker monitor has no verified terminal cleanup receipt';
  // A sandbox's hidden pid is not proof that a peer worker stopped.
  if (!canProbe) return 'previous worker cleanup is unverified';
  const exited = after.some((e) => e.task === worker.task && ['spawn exit', 'worker-exited'].includes(e.cmd)
    && P.exitSpawn(e, st.events) === latest) || Sessions.exitedAttempt(worker, st.events);
  if (!exited) return 'previous worker exit is unverified';
  // A lost monitor cannot attest that its orphan descendants stopped.
  const group = P.processGroupState(latest.detail);
  if (group === 'exited') return null;
  const pgid = latest.detail.pgid || latest.detail.pid;
  return group === 'running' ? `previous process group ${pgid} is still running`
    : `previous process group ${pgid} cleanup cannot be verified on this host`;
}

function failure(st, task, worker) {
  if (task.status === 'submitted') {
    const submission = st.events.findLast((e) => e.task === task.id && e.cmd === 'submit');
    const failures = ['review', 'tests', 'clean', 'ci'].flatMap((type) => {
      const entry = T.latestGateEvidence(task, type, st.events);
      if (!entry || entry.ok || type !== 'review' && !entry.confirmed_failure) return [];
      if (type === 'review' && require('./review-findings').proseOnly(entry.findings)) return [];
      const event = st.events.findLast((e) => e.task === task.id
        && e.cmd === (type === 'review' ? 'evidence' : `check ${type}`)
        && e.detail.type === type && !e.detail.ok && shaMatch(e.detail.sha, entry.sha)
        && e.agent === entry.agent);
      if (!event || st.events.indexOf(event) < st.events.indexOf(submission)) return [];
      return [{ trigger: type, reason: `failed ${type}: ${entry.summary || 'no summary'}`, source: event.id }];
    });
    return failures.sort((a, b) => st.events.findIndex((e) => e.id === b.source)
      - st.events.findIndex((e) => e.id === a.source))[0] || null;
  }
  if (!worker || !['todo', 'in_progress', 'rework'].includes(task.status)) return null;
  if (task.claim && task.claim.agent !== worker.detail.agent) return null;
  const after = st.events.slice(st.events.indexOf(worker) + 1);
  // A deliberate release or lifecycle change ends the dispatch's authority.
  if (after.some((e) => e.task === task.id && ['release', 'rework', 'submit'].includes(e.cmd))) return null;
  // A budget stop waits for the owner instead of promoting a quality rung.
  if (after.some((e) => e.task === task.id && e.cmd === 'budget stop' && e.detail.agent === worker.detail.agent)) return null;
  const exit = after.findLast((e) => e.task === task.id && ['spawn exit', 'worker-exited'].includes(e.cmd)
    && e.detail.agent === worker.detail.agent);
  if (!exit || after.some((e) => e.task === task.id && e.cmd === 'spawn exit'
    && e.detail.agent === worker.detail.agent && e.detail.availability_failure)) return null;
  const stall = after.findLast((e) => e.task === task.id && e.cmd === 'stall' && e.detail.agent === worker.detail.agent);
  return {
    trigger: stall ? 'stall' : 'exit',
    reason: stall ? `stall: ${stall.detail.reason || 'no progress'}` : `worker exit without submit (code ${exit.detail.code ?? 'unknown'})`,
    source: worker.id,
  };
}

function candidates(st) {
  return st.tasks.tasks.filter((task) => {
    if (!task.tier_range || ['accepted', 'cancelled'].includes(task.status)) return false;
    if (task.escalation_pending) return true;
    const worker = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn' && e.detail.role === 'worker');
    const failed = failure(st, task, worker);
    return failed && !(task.escalations || []).some((e) => e.source === failed.source);
  }).map((task) => task.id);
}

function recordFailure(st, emit, task, agent, failed, sendBack = true) {
  if (!task.tier_range || !failed || (task.escalations || []).some((e) => e.source === failed.source)) return;
  T.requireSupportedTask(task, st);
  const from = task.tier;
  const to = from === task.tier_range.max ? null : L.TIERS[L.TIERS.indexOf(from) + 1];
  const record = { at: nowIso(), agent, from, to, ...failed, spend_by_rung: spendByRung(task) };
  task.escalations ||= [];
  task.escalations.push(record);
  // Further quality failures during rework retain the rejected review context.
  const pendingRework = task.status === 'rework' || task.claim?.from === 'rework';
  const previousRevision = sendBack && pendingRework
    ? st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id).detail.previous_revision
    : task.revision;
  task.status = 'rework';
  task.claim = null;
  task.notes.push({ at: record.at, agent, text: `escalation ${from} -> ${to || 'owner'}: ${failed.reason}` });
  if (sendBack) {
    task.revision = T.nextRevision(st, task);
    emit(task.id, { reason: failed.reason, sha: task.sha, previous_revision: previousRevision, revision: task.revision }, 'rework');
  }
  if (to) {
    task.tier = to;
    task.escalation_pending = true;
  } else {
    task.escalation_pending = false;
    const decision = require('./decisions').create(st, emit, agent, {
      question: `${task.id} exhausted ${task.tier_range.min}..${task.tier_range.max} at ${from}: ${failed.reason}. Choose the next approach.`,
      blocks: [task.id],
      why: 'The planned quality escalation range is exhausted.',
      owner_required: 'the planned quality range is exhausted, so the owner chooses the next step',
    });
    record.decision = decision.id;
  }
  emit(task.id, record, 'escalate');
}

async function recover(ctx) {
  const result = S.mutate(ctx, 'recover', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    if (!task.tier_range || ['accepted', 'cancelled'].includes(task.status)) return { id: task.id };
    // Recovery also runs after recording evidence and during event polling;
    // preserve the verdict and let unrelated tasks continue while this waits.
    const unsupported = T.unsupportedTaskValues(task, st);
    if (unsupported.length) return { id: task.id, waiting: unsupported.join('; ') };
    const worker = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn' && e.detail.role === 'worker');
    const failed = failure(st, task, worker);
    const blocker = worker && (exitBlocker(ctx, st, worker)
      || (P.supervised(st, task) ? 'previous worker is still supervised' : null));
    if (blocker) {
      if (failed && !(task.escalations || []).some((e) => e.source === failed.source)) {
        const previous = st.events.findLast((e) => e.task === task.id && e.cmd === 'recover waiting'
          && e.detail.failure_source === failed.source);
        if (previous?.detail.reason !== blocker) {
          task.notes.push({ at: nowIso(), agent: ctx.agent, text: `recovery waiting: ${blocker}` });
          emit(task.id, { failure_source: failed.source, worker: worker.detail.agent, reason: blocker }, 'recover waiting');
        }
      }
      return { id: task.id, waiting: blocker };
    }
    if (worker && (task.escalation_pending || failed)) T.collectSpawn(st, emit, worker);
    // Review findings must reach the brief before its quality climb changes the revision.
    if (failed?.trigger === 'review') return { id: task.id, review: true };
    recordFailure(st, emit, task, ctx.agent, failed);
    return { id: task.id, pending: task.escalation_pending === true };
  });
  if (result.waiting) return { data: result, text: `${result.id}: recovery waiting: ${result.waiting}` };
  if (result.review) {
    if (!require('./authority').role(ctx, S.readEvents(ctx.stateDir))) {
      return { data: { id: result.id, waiting: 'full review findings await the host' },
        text: `${result.id}: full review findings await the host` };
    }
    await require('./actions').rework({ ...ctx, pos: [], flags: { 'from-review': result.id } });
    return recover({ ...ctx, pos: [result.id], flags: {} });
  }
  if (result.pending && ctx.env.TOWER_CRANE_VIA === 'broker') {
    return { data: result, text: `${result.id}: climb pending for the host observer` };
  }
  if (result.pending) {
    try {
      const started = await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: result.id }, escalationOnly: true });
      return { data: started.data, text: `${result.id}: re-dispatched at ${started.data.rung}` };
    } catch (error) {
      // Keep the pending climb so configuration or capacity recovery can retry it.
      if (![1, 2, 3, 'EACCES', 'EPERM'].includes(error.code)) throw error;
      return { data: { ...result, error: error.message }, text: `${result.id}: climb pending: ${error.message}` };
    }
  }
  return { data: result, text: `${result.id}: no pending climb` };
}

function guard(ctx, st, task) {
  if (!task.tier_range) return;
  if (ctx.escalationOnly && !task.escalation_pending) throw refuse(`${task.id}: climb already dispatched`);
  const reasons = T.blockReasons(st, task);
  if (reasons.length) throw refuse(`${task.id} is blocked: ${reasons.join('; ')}`);
  if (!['todo', 'rework', 'in_progress'].includes(task.status)) throw refuse(`${task.id}: worker dispatch needs todo or rework`);
  const last = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn' && e.detail.role === 'worker');
  const blocker = last && (exitBlocker(ctx, st, last)
    || (P.supervised(st, task) ? 'previous worker is still supervised' : null));
  if (blocker) throw refuse(`${task.id}: ${blocker}`);
}

function releaseBlocker(ctx, st, task) {
  const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
    && e.detail.agent === task.claim?.agent && e.detail.role === 'worker');
  if (!worker) return null;
  // An exit not recorded yet still belongs to ranged recovery.
  const availability = st.events.slice(st.events.indexOf(worker) + 1).some((e) => e.cmd === 'spawn exit'
    && e.task === task.id && e.detail.agent === worker.detail.agent && e.detail.availability_failure === true);
  if (task.tier_range && (!availability || task.escalation_pending || failure(st, task, worker))) return 'ranged recovery owns this claim';
  return exitBlocker(ctx, st, worker);
}

// Worker exits without a submit that one revision of a task may cost before
// dispatch parks it for the owner. The supervisor already retries transient
// exits inside one dispatch, and outages, login failures, interrupts and
// budget stops are not counted, so each counted exit is a whole session that
// ended without a submission. A session that released the task for an open
// decision did what the work skill asks, so it does not count either. The first relaunch resumes that session, which
// covers a run cut short by a turn limit; a second identical end at the same
// brief is a pattern; a third is a loop that only spends.
const RESPAWN_CAP = 3;

// The counted exits since the task's last submit or cleared owner ask, at
// its current revision, oldest first. A revision change resets the count, so
// a rewritten brief or a rework starts again.
function fruitlessExits(st, task, events = st.events) {
  const from = events.findLastIndex((e) => e.task === task.id && (['submit', 'owner-done'].includes(e.cmd)
    || e.cmd === 'task update' && 'needs_owner' in e.detail && !e.detail.needs_owner));
  const out = [];
  for (let i = from + 1; i < events.length; i++) {
    const spawn = events[i];
    if (spawn.cmd !== 'spawn' || spawn.task !== task.id || spawn.detail.role !== 'worker' || spawn.detail.revision !== task.revision) continue;
    const next = events.findIndex((e, j) => j > i && e.cmd === 'spawn' && e.task === task.id && e.detail.agent === spawn.detail.agent);
    const run = events.slice(i + 1, next < 0 ? events.length : next).filter((e) => e.task === task.id);
    // A monitor that died records no exit of its own; the observer's
    // worker-exited stands in for it, with no outage verdict to exclude.
    const exit = run.find((e) => e.cmd === 'spawn exit' && e.detail.agent === spawn.detail.agent && 'code' in e.detail)
      || run.find((e) => e.cmd === 'worker-exited' && e.detail.agent === spawn.detail.agent);
    if (!exit || exit.detail.availability_failure === true) continue;
    // An observer can see the harness gone while its monitor is still
    // recording the exit; that monitor's spawn exit decides the run.
    if (exit.cmd === 'worker-exited' && spawn.detail.monitor_pid
      && P.processState(P.monitorProcess(spawn.detail)) === 'running') continue;
    if (run.some((e) => ['budget stop', 'interrupt'].includes(e.cmd) && e.detail.agent === spawn.detail.agent)) continue;
    if (run.some((e) => e.cmd === 'release' && e.detail.holder === spawn.detail.agent && e.detail.decisions?.length)) continue;
    out.push({ agent: spawn.detail.agent, code: exit.detail.code ?? null, signal: exit.detail.signal || null, log: exit.detail.log || spawn.detail.log || null });
  }
  return out;
}

// Called in the write that records a worker's exit (the supervisor's spawn
// exit, or the observer's worker-exited for a monitor that died), so no dispatch can see
// the exit before the park. The log tail stays in the log: state never holds
// agent output, so task show reads the tail from the file.
function capRespawns(st, emit, id, exitEvent, agent) {
  const task = st.tasks.tasks.find((t) => t.id === id);
  if (!task || task.needs_owner || !['todo', 'rework', 'in_progress'].includes(task.status)) return null;
  const exits = fruitlessExits(st, task, [...st.events, exitEvent]);
  if (exits.length < RESPAWN_CAP) return null;
  const last = exits.at(-1);
  const how = last.signal ? `signal ${last.signal}` : `code ${last.code ?? 'unknown'}`;
  task.needs_owner = `worker exited without submitting ${exits.length} times at revision ${task.revision} (last ${last.agent}, ${how}); `
    + `read tower-crane task show ${task.id} for the log tail, fix the cause, then tower-crane owner-done ${task.id}`;
  task.needs_owner_by = { agent, role: 'engine' };
  task.notes.push({ at: nowIso(), agent, text: `respawn cap: ${task.needs_owner}` });
  emit(task.id, { cap: RESPAWN_CAP, exits: exits.length, revision: task.revision, agents: exits.map((e) => e.agent), log: last.log, needs_owner: task.needs_owner }, 'respawn cap');
  return task;
}

// The latest park that still holds the task, for task show.
function respawnCapped(st, task) {
  if (!task.needs_owner) return null;
  const park = st.events.findLast((e) => e.task === task.id && e.cmd === 'respawn cap');
  return park && park.detail.needs_owner === task.needs_owner ? park.detail : null;
}

module.exports = { recover, guard, releaseBlocker, spendByRung, candidates, failure, recordFailure, fruitlessExits, capRespawns, respawnCapped, RESPAWN_CAP };
