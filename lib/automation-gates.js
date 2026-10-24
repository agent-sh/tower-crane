'use strict';

const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { refuse } = require('./util');
const { current, trusted } = require('./automation-common');
const { cpuGate, releaseExecutor, takeExecutor } = require('./automation-executors');

// Missing or unaudited evidence leaves a gate due. Passing evidence whose
// inputs no longer match runs again. A failure is settled by software() instead.
function gateDue(st, task, type, refreshCI = false, mergeabilityPending = false) {
  const latest = T.latestGateEvidence(task, type, st.events);
  // A missing pin is not a verdict; changing it supplies the gate's next runnable inputs.
  if (latest?.config_failure && ['tests', 'clean'].includes(type)
    && !isDeepStrictEqual(latest.gate_policy, require('./gate-commands').resolve(st.project, type).policy)) return true;
  // A void checked nothing, and a failure a restore set out to rerun was ruled out by that
  // restore; both run again instead of settling as rework.
  if (latest?.voided || restoredFailure(st, task, latest)) return true;
  // Stalled CI waits for a person: a new head, a manual check or a CI notification.
  if (type === 'ci' && latest?.pending) return refreshCI && !latest.stalled;
  if (type === 'ci' && mergeabilityPending && latest?.ok && !latest.waived) return true;
  if (latest) return latest.ok && !T.gateReport(task, st.events, st).gates.find((g) => g.type === type)?.ok;
  return true;
}

// Gates whose failure at the submitted head is settled here: an infrastructure
// failure runs once more, and any other failure sends the task to rework.
const SETTLED = ['tests', 'clean', 'ci'];

function passes(st, task, type) {
  return !!T.gateReport(task, st.events, st).gates.find((g) => g.type === type)?.ok;
}

// The latest failure of a settled gate at the current head and revision, or
// null. Every failed verdict counts, so a failure that no flag names still
// reworks. Two kinds stay submitted: a pending CI run waits for CI, and a missing
// pinned command is project configuration for the orchestrator, shown in the inbox.
function failedGate(st, task, type) {
  const latest = T.latestGateEvidence(task, type, st.events);
  if (!latest || latest.ok) return null;
  return latest.pending || latest.config_failure || latest.voided || restoredFailure(st, task, latest) ? null : latest;
}

// The failure a restore at this revision named for its rerun, while no later evidence of the
// gate replaced it: the rerun was stopped (a governor stop, missing engine code) before it
// recorded anything, so the failure it was to replace is still the latest.
function restoredFailure(st, task, latest) {
  if (!latest || latest.ok) return false;
  return T.taskEvents(st.events, task.id).some((e) => e.cmd === 'restore' && e.detail?.revision === task.revision
    && e.detail.rerun?.some((r) => r.type === latest.type && r.at === latest.at));
}

// A host-only test the base fails with the same error, which the tests gate
// records as infrastructure with main_failure. After its one retry, which a
// flaky host test can pass, it keeps the task submitted: no change of the
// task's can fix it, and the inbox gate_failed item names it.
function baseInfrastructure(evidence) {
  return !!(evidence?.main_failure && evidence.infrastructure_failure);
}

// Such a failure waits for main's fix, so it reruns once the base tip moves
// past the base it failed at: the one event that can change the base's
// verdict without a person. A fix in the host environment instead needs
// gates retry, which the inbox item names. The rerun counts as the gate's
// next failure, so a failure main no longer shares reworks then.
async function baseMoved(ctx, st, task, type) {
  const latest = T.latestGateEvidence(task, type, st.events);
  if (type !== 'tests' || task.hotfix || !baseInfrastructure(latest) || !st.project.base) return false;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) return false;
  const tip = await C.baseTip({ root: repo.root, signal: ctx.gateSignal }, repo.root, st.project.base);
  return !!tip && !tip.toLowerCase().startsWith(String(latest.main_failure.base).toLowerCase());
}

// A timeout, a runner killed by a signal, a failure that also fails on main, or
// one whose base rerun was killed or timed out before it could tell, retries
// once at its head. A second failure there, or any other failure, is settled by rework. A
// pending check or a configuration failure is not a verdict, so it does not use
// up the retry.
function retryable(task, failed) {
  if (!failed.infrastructure_failure && !failed.runner_crash && !failed.main_failure
    && !failed.base_rerun_killed && !failed.base_rerun_timed_out) return false;
  const failures = task.evidence.filter((e) => e.type === failed.type && e.revision === task.revision
    && !e.ok && C.sameSha(e.sha, task.sha) && !e.pending && !e.config_failure && !e.voided);
  return failures.length === 1;
}

// Rechecks of pending CI at a head share one GitHub read per task per minute
// across every process. A first read at a head and a completion notification
// read at once; each read still counts against the next recheck. The minute
// runs between the events that scheduled the reads, not the reads themselves:
// a reaction reaches its ci gate some time after the backlog emitted it, and
// measuring from that delay would skip a single watcher's own next minute.
// The interval is read at each recheck so tests can shorten it
// (test/fixtures/mergeability-pause.js).
const CI_POLL = { ms: 60000 };

function ciPoll(ctx, task, notified) {
  const scheduled = Date.parse(ctx.executor?.event?.at) || Date.now();
  return S.mutate(ctx, 'ci poll', (st, emit) => {
    const t = T.getTask(st, task.id);
    const latest = T.latestGateEvidence(t, 'ci', st.events);
    const recheck = !notified && latest?.pending && C.sameSha(latest.sha, t.sha) && latest.revision === t.revision;
    const last = st.events.findLast((e) => e.cmd === 'ci poll' && e.task === t.id);
    const prior = last && Date.parse(last.detail.scheduled ?? last.at);
    if (recheck && last && C.sameSha(last.detail.sha, t.sha) && scheduled - prior < CI_POLL.ms) return false;
    emit(t.id, { sha: t.sha, revision: t.revision, scheduled: new Date(scheduled).toISOString() });
    return true;
  });
}

// Every gate automation runs: CPU gates hold the reaction's executor, and a
// GitHub read releases it first. Returns false when the poll budget skipped
// the read.
async function runAutomated(ctx, type, { notified = false } = {}) {
  const { st, task } = current(ctx, ctx.pos[0]);
  if (cpuGate(st, task, type)) await takeExecutor(ctx, task, type);
  else {
    releaseExecutor(ctx);
    if (type === 'ci' && !ciPoll(ctx, task, notified)) return false;
  }
  await require('./check').runGate({ ...ctx, flags: {} }, type);
  return true;
}

async function software(ctx) {
  try {
    await softwareGates(ctx);
  } finally {
    releaseExecutor(ctx);
  }
}

async function softwareGates(ctx) {
  ctx.automationSignal?.throwIfAborted();
  let { st, task } = current(ctx, ctx.pos[0]);
  const snapshot = { sha: task.sha, revision: task.revision };
  const status = task.status;
  const unchanged = () => ['submitted', 'accepted'].includes(status) && task.status === status
    && task.sha === snapshot.sha && task.revision === snapshot.revision;
  const run = async (type) => {
    await runAutomated(ctx, type);
    // Evidence finishes during a drain; retry and rework wait for another reaction.
    ctx.automationSignal?.throwIfAborted();
  };
  // CPU gates the cap deferred. The GitHub read does not depend on them, so
  // it goes on, and a CI failure sends the task back before its suite runs.
  let deferred = null;
  for (const type of T.requiredGates(task).filter((g) => g !== 'review')) {
    if (!unchanged()) return;
    if (deferred && cpuGate(st, task, type)) continue;
    if (type === 'ci' && ctx.refreshLocalCI
      || gateDue(st, task, type, ctx.refreshCI, ctx.mergeabilityPending) || await baseMoved(ctx, st, task, type)) {
      try { await run(type); }
      catch (e) {
        if (!e.executorDeferred) throw e;
        deferred = e;
        continue;
      }
    }
    ({ st, task } = current(ctx, task.id));
    if (!unchanged()) return;
    if (passes(st, task, type)) continue;
    let failed = SETTLED.includes(type) ? failedGate(st, task, type) : null;
    // Submitted ranged tasks defer to escalation; accepted tasks bypass that recovery path.
    if (failed?.confirmed_failure && task.tier_range && task.status === 'submitted') return;
    if (failed && retryable(task, failed)) {
      await run(type);
      ({ st, task } = current(ctx, task.id));
      if (!unchanged()) return;
      if (passes(st, task, type)) continue;
      failed = failedGate(st, task, type);
    }
    if (baseInfrastructure(failed)) failed = null;
    if (failed) {
      T.rework({ ...ctx, pos: [task.id], expected: snapshot, gateRework: type,
        flags: { reason: `${type} failed at ${C.short(task.sha)}: ${failed.summary || 'no summary'}` } });
      return;
    }
    // A missing pin, or a failure main shares, waits without hiding failures of later gates.
    const waiting = T.latestGateEvidence(task, type, st.events);
    if (waiting?.config_failure || baseInfrastructure(waiting)) continue;
    break;
  }
  if (deferred && unchanged()) throw deferred;
}

// The operational retry: each failed software gate runs again at the submitted
// head with its current inputs, for a failure a later fix made obsolete, such as
// a timeout. Automation leaves failures at unchanged inputs alone.
async function gatesRetry(ctx) {
  const { restore } = require('./automation-restore');
  if (!trusted(ctx)) throw refuse('gates retry is an orchestrator or owner command');
  if (ctx.flags['from-rework']) return restore(ctx);
  let { st, task } = current(ctx, ctx.pos[0]);
  if (task.status !== 'submitted') throw refuse(`${task.id} is ${task.status}; gates retry needs a submitted task`);
  const failed = T.requiredGates(task).filter((g) => g !== 'review' && T.latestGateEvidence(task, g, st.events)?.ok === false);
  if (!failed.length) throw refuse(`${task.id}: no failed software gate at ${task.sha.slice(0, 7)} to retry`);
  const snapshot = { sha: task.sha, revision: task.revision };
  const codes = [];
  for (const type of failed) {
    if (task.status !== 'submitted' || task.sha !== snapshot.sha || task.revision !== snapshot.revision) break;
    codes.push((await require('./check').runGate({ ...ctx, flags: {} }, type)).code);
    ({ st, task } = current(ctx, task.id));
  }
  const report = T.gateReport(task, st.events, st);
  const next = report.ok ? 'run accept to continue' : report.missing.join('; ');
  return { code: codes.some((code) => code) ? 1 : 0, data: T.describeTask(st, task, Date.now()), text: `${task.id}: retried ${failed.join(', ')} at ${task.sha.slice(0, 7)}; ${next}` };
}

module.exports = { gateDue, SETTLED, passes, failedGate, restoredFailure, baseInfrastructure, baseMoved, retryable, CI_POLL, ciPoll, runAutomated, software, softwareGates, gatesRetry };
