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
  if (worker.detail.monitor_pid && (!canProbe || P.processState({
    pid: worker.detail.monitor_pid, host: worker.detail.host, start_ticks: worker.detail.monitor_start_ticks,
  }) !== 'exited')) return 'previous worker monitor has no verified terminal cleanup receipt';
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
  task.status = 'rework';
  task.claim = null;
  task.notes.push({ at: record.at, agent, text: `escalation ${from} -> ${to || 'owner'}: ${failed.reason}` });
  if (sendBack) emit(task.id, { reason: failed.reason, sha: task.sha }, 'rework');
  if (to) {
    task.tier = to;
    task.escalation_pending = true;
  } else {
    task.escalation_pending = false;
    const decision = require('./decisions').create(st, emit, agent, {
      question: `${task.id} exhausted ${task.tier_range.min}..${task.tier_range.max} at ${from}: ${failed.reason}. Choose the next approach.`,
      blocks: [task.id],
      why: 'The planned quality escalation range is exhausted.',
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
    recordFailure(st, emit, task, ctx.agent, failed);
    return { id: task.id, pending: task.escalation_pending === true };
  });
  if (result.waiting) return { data: result, text: `${result.id}: recovery waiting: ${result.waiting}` };
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

module.exports = { recover, guard, spendByRung, candidates, failure, recordFailure };
