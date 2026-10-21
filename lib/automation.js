'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Runtime = require('./runtime');
const Sessions = require('./spawn-session');
const C = require('./gates/common');
const { refuse, usage, readStdin, shortTime } = require('./util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function sourceOf(event) {
  const { at, cmd, agent, task, detail } = event;
  return event.id || `legacy:${createHash('sha256').update(JSON.stringify({ at, cmd, agent, task, detail })).digest('hex')}`;
}

// Only the owner or the orchestrator acts on the event reactions; a worker
// that names its own identity is verified as a worker and refused here.
function trusted(ctx) {
  return !!require('./authority').role(ctx, S.readEvents(ctx.stateDir));
}

function reactionContext(ctx) {
  const env = { ...ctx.env, TOWER_CRANE_AGENT: 'orchestrator' };
  delete env.TOWER_CRANE_BROKER;
  delete env.TOWER_CRANE_VIA;
  const st = S.loadState(ctx.stateDir);
  const holder = require('./orchestrator').holder(st);
  return { ...ctx, agent: 'orchestrator', agentExplicit: true, automation: true, env, flags: {},
    orchestratorSession: Object.hasOwn(ctx, 'orchestratorSession') ? ctx.orchestratorSession : holder };
}

function current(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  return { st, task: T.getTask(st, id) };
}

function merged(st, task) {
  return require('./stack').merged(st, task);
}

// A software gate run by hand settles its failure the same way a CI check does.
const GATE_CHECKS = ['check tests', 'check clean', 'check ci'];

function eligible(st, event) {
  if (!['submit', 'hotfix', 'accept', 'ci completed', 'ci resolve', 'spawn exit', 'worker-exited', 'merge', 'automation reconcile', ...GATE_CHECKS].includes(event.cmd)
    && !(event.cmd === 'evidence' && event.detail.type === 'review')) return false;
  const task = st.tasks.tasks.find((t) => t.id === event.task);
  if (!task || !['submitted', 'accepted'].includes(task.status)) return false;
  // A result carried to a base-only head wakes that head's reaction.
  const carried = C.sameSha(event.detail?.carried_to, task.sha);
  if (event.detail?.sha && !C.sameSha(event.detail.sha, task.sha) && !carried) return false;
  if (event.detail?.revision && event.detail.revision !== task.revision && !carried) return false;
  if (event.cmd === 'merge') return event.detail.ok === true;
  if (merged(st, task)) return false;
  return ['submit', 'hotfix', 'accept', 'ci completed', 'ci resolve', 'spawn exit', 'worker-exited', 'automation reconcile'].includes(event.cmd)
    || GATE_CHECKS.includes(event.cmd) || event.cmd === 'evidence' && event.detail.type === 'review';
}

const EXECUTORS = 2;

function live(detail) {
  return detail?.phase === 'running' && P.processState(detail) !== 'exited';
}

// Each reaction's running receipt is its executor lease: a done receipt
// releases it on exit and the PID identity releases it on death. Only this
// host's executors count against the cap, since the cap protects its cores.
function executors(st) {
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'automation') last.set(e.task, e.detail);
  return [...last.values()].filter((d) => live(d) && (!d.host || d.host === os.hostname())).length;
}

// Each task's latest `gates prioritize` event, with the sources it moved: the
// notifications queued at the moment of the request.
function requests(st) {
  const latest = new Map();
  st.events.forEach((e, index) => {
    if (e.cmd === 'gates prioritize') latest.set(e.task, { index, sources: new Set(e.detail.sources) });
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

// Merges go first in acceptance order. Submitted work follows, with the most
// recent explicit request first, then ordinary submission order.
function turn(latest, accepted, event, index) {
  if (accepted.has(event.task)) return [0, accepted.get(event.task), index];
  const request = latest.get(event.task);
  return request?.sources.has(sourceOf(event)) ? [1, -request.index, index] : [2, 0, index];
}

function order(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
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
// own reaction is running has been taken, so it is not owed; a dead executor's
// notification or a governor deferral is owed again for its retry.
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
    const owed = !receipt || receipt.phase === 'infrastructure' || (receipt.phase === 'running' && !live(receipt)) || governorDeferral(receipt);
    if (queued.has(source) && owed && eligible(st, e)) {
      found.push({ e, turn: turn(latest, accepted, e, index) });
    }
  });
  return found.sort((a, b) => order(a.turn, b.turn)).map(({ e }) => e);
}

// Persistent deferrals outlive the host registry's short-lived admission hints.
function governorDeferred(st) {
  const last = receipts(st);
  return pending(st).flatMap((e) => {
    const deferred = governorDeferral(last.get(sourceOf(e)));
    return deferred ? [{ ...deferred, source: sourceOf(e) }] : [];
  });
}

// Queued notifications without a live executor, in drain order. Governor
// deferrals keep their place while waiting for their retry admission.
function waiting(st) {
  const held = busy(st);
  return pending(st).filter((e) => !held.has(e.task));
}

// One task reaction runs at a time, outside the state lock, and at most
// gates.executors reactions run on this host. A dead executor leaves a
// retryable start receipt; another host's unobservable PID stays busy.
// Returns 'behind' when a slot is free but older queued work owns it.
function reserve(ctx, event, snapshot) {
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
    const cap = st.project.gates?.executors ?? EXECUTORS;
    if (executors(st) >= cap) return queue({ executors: cap });
    // The caller's event object comes from an earlier read, so locate both
    // events in this reload by their stable source.
    const position = (s) => {
      const i = st.events.findIndex((e) => sourceOf(e) === s);
      return i < 0 ? Infinity : i;
    };
    const latest = requests(st);
    const accepted = acceptances(st);
    const rank = (e) => turn(latest, accepted, e, position(sourceOf(e)));
    const first = waiting(st).find(runnable);
    if (first && sourceOf(first) !== source && order(rank(first), rank(event)) < 0) {
      queue({ executors: cap });
      return 'behind';
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

// A manual merge holds the same task reservation as reactions, so a concurrent
// automatic merge finishes first and this merge confirms its head, or the
// reaction starts after this merge and finds the task merged.
async function merge(ctx) {
  if (ctx.flags.accepted) return require('./actions').merge(ctx);
  if (!ctx.pos.length) throw usage('merge needs ID or --accepted');
  // Refusals the gate makes before reading state come first, as without a reservation.
  require('./check').gatePath('merge');
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

// Missing or unaudited evidence leaves a gate due. Passing evidence whose
// inputs no longer match runs again. A failure is settled by software() instead.
function gateDue(st, task, type, refreshCI = false, mergeabilityPending = false) {
  const latest = T.latestGateEvidence(task, type, st.events);
  // A missing pin is not a verdict; changing it supplies the gate's next runnable inputs.
  if (latest?.config_failure && ['tests', 'clean'].includes(type)
    && !isDeepStrictEqual(latest.gate_policy, require('./gate-commands').resolve(st.project, type).policy)) return true;
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
  return latest.pending || latest.config_failure ? null : latest;
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
    && !e.ok && C.sameSha(e.sha, task.sha) && !e.pending && !e.config_failure);
  return failures.length === 1;
}

async function software(ctx) {
  ctx.automationSignal?.throwIfAborted();
  let { st, task } = current(ctx, ctx.pos[0]);
  const snapshot = { sha: task.sha, revision: task.revision };
  const status = task.status;
  const unchanged = () => ['submitted', 'accepted'].includes(status) && task.status === status
    && task.sha === snapshot.sha && task.revision === snapshot.revision;
  const run = async (type) => {
    await require('./check').runGate({ ...ctx, flags: {} }, type);
    // Evidence finishes during a drain; retry and rework wait for another reaction.
    ctx.automationSignal?.throwIfAborted();
  };
  for (const type of T.requiredGates(task).filter((g) => g !== 'review')) {
    if (!unchanged()) return;
    // Review runs first; its passing evidence wakes this reaction to run the suite.
    if (type === 'tests' && require('./reviewer').testsDeferred(st, task)) continue;
    if (type === 'ci' && ctx.refreshLocalCI
      || gateDue(st, task, type, ctx.refreshCI, ctx.mergeabilityPending) || await baseMoved(ctx, st, task, type)) await run(type);
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
    return;
  }
}

// The operational retry: each failed software gate runs again at the submitted
// head with its current inputs, for a failure a later fix made obsolete, such as
// a timeout. Automation leaves failures at unchanged inputs alone.
async function gatesRetry(ctx) {
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

// Why a task in rework cannot go back to submitted at its head, or null. Only
// a rework automation made for a failed software gate qualifies, while the
// task is exactly as that rework left it: the same head and revision (so the
// same acceptance, dependencies and brief), and no worker has taken it since.
function unrestorable(st, task) {
  if (task.claim) return `${task.id} is claimed by ${task.claim.agent}; let that worker finish`;
  if (task.status !== 'rework') return `${task.id} is ${task.status}; gates retry --from-rework needs a task in rework`;
  const own = T.taskEvents(st.events, task.id);
  const at = own.findLastIndex((e) => e.cmd === 'rework');
  const rework = own[at];
  if (!rework?.detail.gate) {
    const from = !rework ? 'no recorded rework' : rework.detail.from_review ? 'a failed review' : `${rework.agent}: ${rework.detail.reason}`;
    return `${task.id} was sent back by ${from}, not by an automatic gate failure; it needs a worker round`;
  }
  if (rework.detail.revision !== task.revision) {
    return `${task.id} moved from revision ${rework.detail.revision} to ${task.revision} after its rework (acceptance, dependencies or brief changed); it needs a worker round`;
  }
  if (!C.sameSha(rework.detail.sha, task.sha)) return `${task.id} head changed after its rework`;
  const taken = own.slice(at + 1).find((e) => ['claim', 'submit'].includes(e.cmd)
    || e.cmd === 'spawn' && e.detail?.role === 'worker');
  if (taken) return `${task.id} was taken by ${taken.agent} (${taken.cmd}) after its rework; let that round finish`;
  // A kind change sets which gates and review apply without a new revision, so it is a judgment change too.
  const kind = own.slice(at + 1).find((e) => e.cmd === 'task update' && e.detail?.kind !== undefined);
  if (kind) return `${task.id} kind was changed to ${kind.detail.kind} after its rework; it needs a worker round`;
  if (task.escalation_pending) return `${task.id} has a pending quality climb; recover it instead`;
  return null;
}

// The pushed and local heads must still be the reworked head: a moved head is
// new work that needs its own submission.
async function headMoved(ctx, st, task) {
  const remote = await pr(ctx, st, task);
  if (remote && remote.state !== 'OPEN') return `PR #${task.pr} is ${remote.state}`;
  if (remote && !C.sameSha(remote.headRefOid, task.sha)) return `PR #${task.pr} head moved to ${C.short(remote.headRefOid)}`;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const branch = task.branch || remote?.headRefName;
  if (repo && branch) {
    const local = await C.resolveCommit({ root: repo.root, signal: ctx.gateSignal }, repo.root, `refs/heads/${branch}`);
    if (local && !C.sameSha(local, task.sha)) return `branch ${branch} moved to ${C.short(local)}`;
  }
  return null;
}

// Undo an automatic gate rework once the cause outside the code is fixed, such
// as the gate temporary root. The rework's revision bump opened a new round of
// work, but no worker took it and nothing about the task changed, so the task
// returns to the revision it was submitted at: its evidence there (passing
// gates, any review) still describes this head and counts again, and the
// abandoned revision is retired. The failed gates then run again; any other
// gate whose inputs changed reruns as automation would. A gate that still
// fails sends the task back to rework at a new revision.
async function restore(ctx) {
  const { st, task } = current(ctx, ctx.pos[0]);
  const reason = unrestorable(st, task) || await headMoved(ctx, st, task);
  if (reason) throw refuse(reason);
  const plan = { sha: task.sha, revision: task.revision };
  const source = `restore:${randomUUID()}`;
  // The task's reaction slot is held throughout, so no reaction settles the
  // old failure at the restored revision before the gate runs again.
  const id = await hold(ctx, task.id, source, (t) => {
    if (t.status !== 'rework' || t.sha !== plan.sha || t.revision !== plan.revision) throw refuse(`${t.id} changed; run gates retry --from-rework again`);
  });
  let result;
  let error = null;
  try {
    // A push between the first check and the hold would otherwise go unnoticed until merge.
    const moved = await headMoved(ctx, S.loadState(ctx.stateDir), task);
    if (moved) throw refuse(moved);
    result = await restoreHeld(ctx, plan);
  } catch (e) {
    error = e;
  } finally {
    unhold(ctx, id, source, error);
  }
  const queued = queuedFor(ctx, id || task.id);
  if (queued.length) await consume(ctx, queued);
  if (error) throw error;
  return result;
}

async function restoreHeld(ctx, plan) {
  const restored = S.mutate(ctx, 'restore', (st, emit) => {
    const t = T.getTask(st, ctx.pos[0]);
    const reason = unrestorable(st, t);
    if (reason) throw refuse(reason);
    if (t.sha !== plan.sha || t.revision !== plan.revision) throw refuse(`${t.id} changed; run gates retry --from-rework again`);
    const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === t.id);
    t.status = 'submitted';
    t.revision = rework.detail.previous_revision;
    const text = `restored to submitted at revision ${t.revision}: the ${rework.detail.gate} failure at ${C.short(t.sha)} is rerun after its cause was fixed; revision ${plan.revision} is retired`;
    T.note(t, ctx.agent, text);
    T.appendBriefNote(st.dir, t, `${ctx.agent}: ${text}`);
    emit(t.id, { sha: t.sha, gate: rework.detail.gate, rework: rework.id, from_revision: plan.revision, revision: t.revision });
    return { sha: t.sha, revision: t.revision };
  });
  let { st, task } = current(ctx, ctx.pos[0]);
  const same = (t) => t.status === 'submitted' && t.sha === restored.sha && t.revision === restored.revision;
  const unchanged = () => same(task);
  const failed = T.requiredGates(task).filter((g) => g !== 'review' && T.latestGateEvidence(task, g, st.events)?.ok === false);
  for (const type of failed) {
    if (!unchanged()) break;
    await require('./check').runGate({ ...ctx, flags: {},
      expect: (now) => (same(T.getTask(now, task.id)) ? null : `${task.id} changed after its restore`) }, type);
    ({ st, task } = current(ctx, task.id));
  }
  // Settle as a reaction would: rerun passing gates whose inputs changed, and
  // send a gate that still fails back to rework.
  if (unchanged()) await software({ ...ctx, flags: {} });
  ({ st, task } = current(ctx, task.id));
  // A tests gate deferred to the review is not a failure; review dispatch comes next.
  const ok = unchanged() && require('./reviewer').dispatchReport(st, task).ok;
  const ran = failed.length ? `reran ${failed.join(', ')}` : 'no failed gate to rerun';
  const text = ok ? `${task.id}: restored to submitted at revision ${task.revision}; ${ran} at ${C.short(task.sha)}; run accept to continue`
    : `${task.id}: restored at revision ${restored.revision}, ${ran} at ${C.short(restored.sha)}; now ${task.status} at revision ${task.revision}: ${T.gateReport(task, st.events, st).missing.join('; ')}`;
  return { code: ok ? 0 : 1, data: T.describeTask(st, task, Date.now()), text };
}

async function pr(ctx, st, task) {
  if (!task.pr || !st.project.repo) return null;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const result = await C.gh({ root: repo?.root, signal: ctx.gateSignal, exec: ctx.inboxExec }, ['pr', 'view', String(task.pr), '-R', st.project.repo,
    '--json', 'state,headRefOid,headRefName,headRepository,url,mergeable,mergeStateStatus']);
  if (!result.ok) throw require('./inbox-github').failure(result, `inspect PR #${task.pr}`);
  try { return JSON.parse(result.stdout); }
  catch { throw refuse(`cannot read PR #${task.pr} mergeability`); }
}

// `onto` names the base explicitly; without it the task's PR base is used,
// which for a stacked task is its lower task's branch.
async function baseTip(ctx, st, task, fetch, onto) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse(`${task.id}: no repository for conflict detection`);
  const base = (onto || require('./stack').targetBase(st, task)).replace(/^origin\//, '');
  const gc = { root: repo.root, signal: ctx.gateSignal };
  const remote = await C.git(gc, repo.root, ['remote', 'get-url', 'origin']);
  let ref = base;
  if (remote.ok) {
    ref = `refs/remotes/origin/${base}`;
    if (fetch) {
      const result = await C.git(gc, repo.root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
        `+refs/heads/${base}:${ref}`], { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (!result.ok) throw refuse(`cannot fetch ${base} for conflict detection: ${C.errText(result)}`);
    }
  }
  const tip = await C.resolveCommit(gc, repo.root, ref);
  if (!tip) throw refuse(`cannot resolve ${base} for conflict detection`);
  return { repo, base, tip };
}

async function conflicts(ctx, task, fetch, onto, { generatedOnly = false, detectOnly = false } = {}) {
  ctx.automationSignal?.throwIfAborted();
  const { st } = current(ctx, task.id);
  const { repo, base, tip } = await baseTip(ctx, st, task, fetch, onto);
  ctx.automationSignal?.throwIfAborted();
  const gc = { root: repo.root, stateDir: ctx.stateDir, project: st.project, signal: ctx.gateSignal, tmpEnv: ctx.env };
  const G = require('./generated-conflicts');
  const config = await G.configuration(gc, repo.root, tip);
  ctx.automationSignal?.throwIfAborted();
  const result = await C.withWorktree(gc, repo.root, task.sha, async (dir, env) => {
    ctx.automationSignal?.throwIfAborted();
    const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
      { timeout: 60000, env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
    ctx.automationSignal?.throwIfAborted();
    if (trial.ok) return { files: [] };
    const diff = await C.git(gc, dir, ['diff', '--name-only', '--diff-filter=U', '-z'], { env });
    if (!diff.ok) throw refuse(`cannot list ${task.id} conflicting files: ${C.errText(diff)}`);
    const files = diff.stdout.split('\0').filter(Boolean);
    if (!files.length) throw refuse(`${task.id}: trial merge failed without conflicting files: ${C.errText(trial)}`);
    const resolved = await G.resolve(gc, dir, config, env);
    return { files, ...resolved };
  });
  ctx.automationSignal?.throwIfAborted();
  if (!result.files) throw refuse(result.summary);
  if (!result.files.length) return false;
  if (generatedOnly && !result.generated?.length) return false;
  if (detectOnly) return 'generated';
  if (result.generated?.length) {
    // A trial merge can find conflicts before GitHub has caught up. Only a
    // matching remote conflict authorizes changing the task branch.
    const remote = await pr(ctx, st, task);
    ctx.automationSignal?.throwIfAborted();
    if (remote?.state === 'OPEN' && C.sameSha(remote.headRefOid, task.sha)
      && (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY')) {
      const source = `generated:${randomUUID()}`;
      const held = S.mutate(ctx, 'automation', (now, emit) => {
        unchangedGenerated(now, st, task);
        const last = now.events.findLast((e) => e.cmd === 'automation' && e.task === task.id);
        if (live(last?.detail)) {
          if (last.detail.pid === process.pid && last.detail.host === os.hostname()) return null;
          throw refuse(`${task.id}: generated-file repair waits for the task's executor`);
        }
        emit(task.id, { source, phase: 'running', pid: process.pid, ...P.identity(process.pid) });
        return task.id;
      });
      let error;
      try { await repairGenerated(ctx, st, task, { repo, base, tip, config, remote }); }
      catch (e) { error = e; throw e; }
      finally { unhold(ctx, held, source, error); }
      return true;
    }
    return 'deferred';
  }
  const expectedBase = onto ? {} : { base: require('./stack').targetBase(st, task) };
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision, ...expectedBase }, conflictRework: true,
    flags: { reason: `PR #${task.pr} conflicts with ${base}: ${result.files.join(', ')}. Merge the base, resolve these files and submit a new head.` } });
  return true;
}

// A stack synchronizer can request rework before the ordinary conflict sweep.
// Retire completed lower dependencies and give generated conflicts to repair
// first; unaffected stacks retain their existing synchronization behavior.
async function refreshStacks(ctx) {
  // Returning leaves the completed merge's worktree retirement to its caller.
  if (ctx.automationSignal?.aborted) return;
  const Stack = require('./stack');
  const st = S.loadState(ctx.stateDir);
  const deferred = new Set();
  for (const task of st.tasks.tasks) {
    if (ctx.automationSignal?.aborted) return;
    if (!task.stack?.linked || !['submitted', 'accepted'].includes(task.status) || merged(st, task)) continue;
    const lineage = Stack.chain(st, task);
    try {
      if (!await conflicts(ctx, task, true, st.project.base, { generatedOnly: true, detectOnly: true })) continue;
      deferred.add(task.id);
      deferred.add(lineage[0].id);
      if (!lineage.slice(0, -1).every((lower) => merged(st, lower))) continue;
      await Stack.link({ ...ctx, pos: [task.id], retireLinked: true });
      const now = current(ctx, task.id);
      await conflicts(ctx, now.task, true);
    } catch (error) {
      if (Runtime.missing(error)) throw error;
      if (ctx.automationSignal?.aborted) return;
      deferred.add(task.id);
      deferred.add(lineage[0].id);
      S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: error.message }));
    }
  }
  if (ctx.automationSignal?.aborted) return;
  await Stack.refresh(ctx, deferred);
}

function unchangedGenerated(st, before, task) {
  const now = T.getTask(st, task.id);
  if (!isDeepStrictEqual(st.project, before.project) || now.sha !== task.sha || now.revision !== task.revision
    || now.status !== task.status || now.pr !== task.pr || now.branch !== task.branch
    || !isDeepStrictEqual(now.stack, task.stack)) throw refuse(`${task.id} changed during generated-file repair; retry`);
  return now;
}

async function generatedDestination(gc, dir, st, task, remote) {
  const urls = await C.git(gc, dir, ['remote', 'get-url', '--push', '--all', 'origin']);
  const destinations = urls.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!urls.ok || destinations.length !== 1) throw refuse(`${task.id}: generated-file repair needs one origin push destination`);
  const destination = destinations[0];
  const slug = remote.headRepository?.nameWithOwner;
  if (!slug || slug.toLowerCase() !== st.project.repo.toLowerCase()) {
    throw refuse(`${task.id}: PR head repository does not match the project; generated-file repair will not push`);
  }
  const query = destination.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://');
  const view = await C.gh(gc, ['pr', 'view', String(task.pr), '-R', query, '--json', 'url,headRepository']);
  let actual;
  try { actual = JSON.parse(view.stdout); } catch {}
  if (!view.ok || !remote.url || actual?.url !== remote.url || actual?.headRepository?.nameWithOwner !== slug) {
    throw refuse(`${task.id}: origin push destination does not match the PR repository`);
  }
  return destination;
}

// Keep a prepared receipt before pushing. A failed push or an executor death
// after the push can then retry without regenerating or losing the new head.
async function finishGenerated(ctx, st, task, prepared, remote) {
  const { repo } = await baseTip(ctx, st, task, false);
  const gc = { root: repo.root, signal: ctx.gateSignal };
  unchangedGenerated(S.loadState(ctx.stateDir), st, task);
  if (!remote || remote.state !== 'OPEN' || remote.headRefName !== prepared.branch
    || ![task.sha, prepared.sha].some((sha) => C.sameSha(remote.headRefOid, sha))) {
    throw refuse(`${task.id}: PR moved during generated-file repair`);
  }
  // Where the push runs: a worktree's config.worktree can name its own push URL.
  const destination = await generatedDestination(gc, prepared.path, st, task, remote);
  if (createHash('sha256').update(destination).digest('hex') !== prepared.destination_sha) {
    throw refuse(`${task.id}: origin push destination changed during generated-file repair`);
  }
  if ((await C.resolveCommit(gc, prepared.path, 'HEAD')) !== prepared.sha
    || !(await C.git(gc, prepared.path, ['diff', '--quiet'])).ok
    || !(await C.git(gc, prepared.path, ['diff', '--cached', '--quiet'])).ok) {
    throw refuse(`${task.id}: prepared generated-file merge was changed; inspect ${prepared.path}`);
  }
  // By name, git pushes to the URLs `remote get-url --push` listed. A URL on
  // the command line is rewritten again by pushInsteadOf, which a worker can
  // point at a repository whose hooks it wrote.
  const push = await C.git(gc, prepared.path, ['push', 'origin', `${prepared.sha}:refs/heads/${prepared.branch}`],
    { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!push.ok) throw refuse(`${task.id}: generated-file push failed: ${C.errText(push)}`);
  S.mutate(ctx, 'submit', (now, emit) => {
    const t = unchangedGenerated(now, st, task);
    t.status = 'submitted';
    t.sha = prepared.sha;
    t.branch = prepared.branch;
    emit(t.id, { previous_sha: task.sha, sha: t.sha, branch: t.branch, pr: t.pr,
      generated: prepared.generated, base_sha: prepared.base_sha, summary: 'merged base and regenerated outputs' });
    emit(t.id, { ...prepared, phase: 'pushed' }, 'generated merge');
  });
}

async function resumeGenerated(ctx, st, task, remote) {
  const receipt = st.events.findLast((e) => e.cmd === 'generated merge' && e.task === task.id
    && e.detail.phase === 'prepared' && e.detail.previous_sha === task.sha && e.detail.revision === task.revision);
  if (!receipt) return false;
  await finishGenerated(ctx, st, task, receipt.detail, remote);
  return true;
}

async function repairGenerated(ctx, st, task, { repo, base, tip, config, remote }) {
  const G = require('./generated-conflicts');
  const W = require('./worktree');
  const gc = { root: repo.root, signal: ctx.gateSignal };
  const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker');
  if (worker && !Sessions.exitedAttempt(worker, st.events)) throw refuse(`${task.id}: worker is still running; generated-file repair waits for its exit`);
  const branch = remote.headRefName;
  if (!branch || task.branch && task.branch !== branch) throw refuse(`${task.id}: PR branch does not match the task`);
  const destination = await generatedDestination(gc, repo.root, st, task, remote);
  W.relinkAdmins(repo.root, repo.commonDir, { stateDir: repo.stateDir });
  const planned = W.plan(repo, { ...task, branch });
  const head = await C.resolveCommit(gc, repo.root, `refs/heads/${branch}`);
  if (head && !C.sameSha(head, task.sha)) throw refuse(`${task.id}: local branch moved; generated-file repair needs the submitted head`);
  if (planned.exists) {
    const dirty = await C.git(gc, planned.path, ['status', '--porcelain']);
    if (!dirty.ok || dirty.stdout.trim()) throw refuse(`${task.id}: dirty worktree; generated-file repair waits for a clean checkout`);
  }
  unchangedGenerated(S.loadState(ctx.stateDir), st, task);
  const wt = W.create(repo, st, { ...task, branch }, task.sha);
  const dir = wt.path;
  const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
    { timeout: 60000, env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' } });
  if (trial.ok || !(await G.files(gc, dir)).length) {
    await C.git(gc, dir, ['merge', '--abort']);
    throw refuse(`${task.id}: conflicts changed before generated-file repair; retry`);
  }
  let prepared = false;
  let mixed = false;
  try {
    const { generated, remaining } = await G.resolve(gc, dir, config);
    mixed = remaining.length > 0;
    const timeout = require('./gate-timeouts').minutes(st.project, 'clean') * 60000;
    const regenerated = await G.regenerate(gc, dir, config, generated, remaining, timeout);
    if (mixed) {
      unchangedGenerated(S.loadState(ctx.stateDir), st, task);
      const reason = `PR #${task.pr} conflicts with ${base}: ${remaining.join(', ')}. The merge is prepared at ${dir}; generated files are pre-resolved: ${generated.join(', ')}. Resolve the hand-written files, rerun ${[...new Set(generated.map((file) => `npm run ${config[file].script}`))].join(', ')}, commit and submit a new head.`;
      const reworked = T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision }, conflictRework: true,
        expect: (now) => { unchangedGenerated(now, st, task); return null; }, flags: { reason } }).data;
      S.mutate(ctx, 'generated merge', (now, emit) => {
        const t = T.getTask(now, task.id);
        if (t.status !== 'rework' || t.sha !== task.sha || t.revision !== reworked.revision) throw refuse(`${task.id} changed during mixed-conflict repair`);
        t.branch = branch;
        emit(t.id, { phase: 'mixed', sha: task.sha, revision: reworked.revision, base_sha: tip,
          branch, path: dir, generated, remaining, regenerated: regenerated.ok, commands: regenerated.commands });
      });
      return;
    }
    if (!regenerated.ok) throw refuse(`${task.id}: generation failed: ${regenerated.error || regenerated.commands.at(-1)?.summary}`);
    const clean = await C.git(gc, dir, ['diff', '--quiet']);
    if (!clean.ok) throw refuse(`${task.id}: generator changed files outside its declared outputs`);
    unchangedGenerated(S.loadState(ctx.stateDir), st, task);
    const commit = await C.git(gc, dir, ['commit', '-m', `Merge ${base} and regenerate outputs`],
      { timeout: 60000, env: { ...process.env, GIT_EDITOR: 'true' } });
    if (!commit.ok) throw refuse(`${task.id}: cannot commit generated-file merge: ${C.errText(commit)}`);
    const sha = await C.resolveCommit(gc, dir, 'HEAD');
    const detail = { phase: 'prepared', previous_sha: task.sha, sha, revision: task.revision,
      destination_sha: createHash('sha256').update(destination).digest('hex'),
      base_sha: tip, branch, path: dir, generated, commands: regenerated.commands };
    S.mutate(ctx, 'generated merge', (now, emit) => {
      unchangedGenerated(now, st, task);
      emit(task.id, detail);
    });
    prepared = true;
    await finishGenerated(ctx, st, task, detail, await pr(ctx, st, task));
  } catch (error) {
    if (!prepared && !mixed) {
      // The checkout was clean and idle before this merge. Discard only this
      // failed automation attempt, including files a generator left unstaged.
      const reset = await C.git(gc, dir, ['reset', '--hard', task.sha]);
      const clean = reset.ok && await C.git(gc, dir, ['clean', '-fd']);
      if (!reset.ok || !clean.ok) throw refuse(`${task.id}: failed generation cleanup needs retry: ${C.errText(reset.ok ? clean : reset)}`);
    }
    throw error;
  }
}

// GitHub computes mergeability after a base moves, so the first read after a
// submit can be UNKNOWN. Re-reading briefly finds a conflict before a suite
// run is spent on it; a suite takes minutes, so these seconds cost little.
// The pause is read at each retry so tests can shorten it without changing
// the number of reads (test/fixtures/mergeability-pause.js).
const MERGEABILITY = { retries: 3, retry_ms: 2000 };

async function settledPr(ctx, st, task) {
  for (let retry = 0; ; retry++) {
    const remote = await pr(ctx, st, task);
    const unknown = remote?.state === 'OPEN' && (remote.mergeable === 'UNKNOWN' || remote.mergeStateStatus === 'UNKNOWN');
    if (!unknown || retry === MERGEABILITY.retries) return remote;
    await new Promise((resolve) => setTimeout(resolve, MERGEABILITY.retry_ms));
  }
}

// A reviewer that exited cleanly at this head and revision without a verdict
// would exit the same way again on the same inputs. Automation holds review
// dispatch until the head, the revision or a revuto thread changes, or the
// orchestrator runs accept itself, and tells the orchestrator once per
// reviewer why it stopped. Until the reviewer's exit receipt is written, the
// reaction to that receipt decides; a receipt that never comes is reported
// once and the reviewer is replaced.
async function reviewHeld(ctx, st, task) {
  const R = require('./reviewer');
  const exit = R.reviewExit(st, task);
  if (exit?.state === 'pending') return true;
  // A missing receipt at the crash cap is reported and then held like any other.
  if (exit?.state === 'missing' || exit?.missing) {
    S.mutate(ctx, 'review exit missing', (now, emit) => {
      if (now.events.some((e) => e.cmd === 'review exit missing' && e.task === task.id && e.detail.agent === exit.spawn.detail.agent)) return;
      emit(task.id, { agent: exit.spawn.detail.agent, sha: task.sha, revision: task.revision, monitor: exit.monitor,
        monitor_pid: exit.spawn.detail.monitor_pid, reason: 'reviewer monitor did not record its exit' });
    });
    if (exit.state === 'missing') return false;
  }
  const spawn = exit?.state === 'held' ? exit.spawn : null;
  if (!spawn || await R.threadsMoved(ctx, st, task, spawn)) return false;
  S.mutate(ctx, 'review held', (now, emit) => {
    const t = T.getTask(now, task.id);
    if (t.sha !== task.sha || t.revision !== task.revision) return;
    if (now.events.some((e) => e.cmd === 'review held' && e.task === t.id && e.detail.agent === spawn.detail.agent)) return;
    emit(t.id, R.holdNotice(now, t, spawn));
  });
  return true;
}

async function advance(ctx, inspect = true) {
  ctx.automationSignal?.throwIfAborted();
  let { st, task } = current(ctx, ctx.pos[0]);
  let mergeable = true;
  if (!['submitted', 'accepted'].includes(task.status) || merged(st, task)) return 'done';
  if (task.hotfix) {
    const dispatched = st.events.some((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'reviewer' && e.detail.revision === task.revision && C.sameSha(e.detail.sha, task.sha));
    // An exited reviewer without a verdict needs an explicit retry, not a spawn loop.
    if (dispatched && !T.latestGateEvidence(task, 'review', st.events)) return 'done';
    await T.accept({ ...ctx, flags: {} });
    return 'done';
  }
  // A failed independent review is actionable even while CI is pending.
  // The batch action fetches findings and rechecks the head under the lock.
  const verdict = T.latestGateEvidence(task, 'review', st.events);
  if (verdict?.ok === false && require('./review-findings').bodyOnly(verdict.findings)) {
    return require('./review-body').react(ctx, st, task, verdict);
  }
  if (verdict?.ok === false) {
    await require('./actions').rework({ ...ctx, pos: [], flags: { 'from-review': task.id } });
    await require('./escalation').recover({ ...ctx, pos: [task.id], flags: {} });
    return 'done';
  }
  if (inspect && task.pr) {
    const remote = await settledPr(ctx, st, task);
    ctx.automationSignal?.throwIfAborted();
    // A remote merge can precede its local receipt if the executor died.
    // The merge gate confirms the accepted head without issuing another merge.
    if (remote?.state !== 'MERGED' || task.status !== 'accepted') {
      if (!remote || remote.state !== 'OPEN') {
        // Pending CI on a PR closed without merging can never finish; the ci gate
        // records it as stalled, which ends the scheduled recheck.
        const ci = T.latestGateEvidence(task, 'ci', st.events);
        if (remote?.state === 'CLOSED' && ci?.pending && !ci.stalled) await require('./check').runGate({ ...ctx, flags: {} }, 'ci');
        return 'deferred';
      }
      if (await resumeGenerated(ctx, st, task, remote)) return advance(ctx, inspect);
      if (!C.sameSha(remote.headRefOid, task.sha)) return 'deferred';
      if (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY') {
        const conflict = await conflicts(ctx, task, true);
        if (!conflict || conflict === 'deferred') return 'deferred';
        const repaired = current(ctx, task.id).task;
        if (repaired.status === 'submitted' && repaired.sha !== task.sha) return advance(ctx, inspect);
        // An accepted task that leaves the line may have been stopping it.
        if (task.status === 'accepted') await queue(ctx);
        return 'done';
      }
      mergeable = remote.mergeable === 'MERGEABLE' && !!remote.mergeStateStatus && remote.mergeStateStatus !== 'UNKNOWN';
    }
  }
  if (task.status === 'submitted') {
    // The CI gate records pending while GitHub computes mergeability, so the
    // next scheduled reconciliation can observe it without a notification.
    await software({ ...ctx, mergeabilityPending: !mergeable });
    ctx.automationSignal?.throwIfAborted();
    ({ st, task } = current(ctx, task.id));
    if (!mergeable) return 'deferred';
    if (task.status !== 'submitted' || !require('./reviewer').dispatchReport(st, task).ok) return 'done';
    const report = T.gateReport(task, st.events, st);
    // Native workers without an exit receipt use explicit accept for review
    // dispatch. A tracked worker must have exited before a model reads its diff.
    const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'worker' && e.detail.agent === task.submitted_by);
    if (!report.ok && (!worker || !Sessions.exitedAttempt(worker, st.events))) return 'done';
    if (!report.ok && await reviewHeld(ctx, st, task)) return 'done';
    await T.accept({ ...ctx, flags: {}, automatic: true });
    ({ st, task } = current(ctx, task.id));
  }
  if (!mergeable) {
    const ci = T.latestGateEvidence(task, 'ci', st.events);
    if (task.status === 'accepted' && !ci?.pending && !ci?.waived) {
      await require('./check').runGate({ ...ctx, flags: {} }, 'ci');
    }
    return 'deferred';
  }
  if (task.status === 'accepted' && task.pr) {
    await queue(ctx);
    ({ st, task } = current(ctx, task.id));
    // A task still waiting in line stays retryable at startup.
    if (task.status === 'accepted' && !merged(st, task)) return 'deferred';
  }
  return 'done';
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

// Gate evidence belongs to the PR's own diff and survives a base move. Before
// merging, the head of the line runs the full suite once on its merge with
// the current project base, unless its head already contains that base or an
// earlier check covered the same head, revision, base and command. A stack
// runs it once at its top task, whose head carries every lower task.
async function headCheck(ctx, st, { members, target: task }, passed) {
  const bound = binding(st, passed);
  const tested = members.find((m) => T.requiredGates(m).includes('tests')
    && require('./tests-policy').resolve(st.project, m.kind).mode !== 'none');
  if (!tested) return { status: 'ok' };
  const mode = require('./tests-policy').resolve(st.project, tested.kind).mode;
  const selected = require('./gate-commands').select(st.project, 'tests', {}, mode);
  if (selected.error) throw refuse(`${task.id}: ${selected.error}`);
  const onto = st.project.base;
  const { repo, base, tip } = await baseTip(ctx, st, task, true, onto);
  const commands = [];
  // The suite's host governor place, taken once the suite will run; until then
  // its commands take the wait's signal alone.
  let unit = null;
  let signal = ctx.gateSignal;
  const gc = { root: repo.root, stateDir: ctx.stateDir, project: st.project, signal, tmpEnv: ctx.env, exec: async (command, args, opts = {}) => {
    const tree = ctx.gateSignal || opts.shell;
    const run = tree ? C.treeExec : require('./commands').spawnSync;
    const r = await run(command, args, { windowsHide: true, ...opts, signal: !tree || (opts.cleanup && signal?.aborted) ? undefined : signal,
      ...(tree && unit ? { onSpawn: (pid, scope) => unit.attach(pid, scope) } : {}) });
    Runtime.throwIfMissing(r.error);
    Runtime.throwIfMissing(r.stderr);
    commands.push({ command, args: [...args], cwd: opts.cwd || null, status: r.status ?? null, signal: r.signal || null });
    return r;
  } };
  const contains = async (m) => (await C.git(gc, repo.root, ['merge-base', '--is-ancestor', tip, m.sha])).ok;
  if ((await Promise.all(members.map(contains))).every(Boolean)) return { status: 'ok', tip };
  // Bottom first, so the rework goes to the lowest task that conflicts.
  for (const m of members) {
    const conflict = await conflicts({ ...ctx, pos: [m.id] }, m, false, onto);
    if (conflict === 'deferred') return { status: 'deferred', summary: `${m.id}: generated conflicts await matching GitHub confirmation` };
    if (conflict) return { status: 'rework' };
  }
  if (await contains(task)) return { status: 'ok', tip };
  const ids = members.map((m) => m.id);
  const done = st.events.findLast((e) => e.cmd === 'head check' && e.task === task.id && C.sameSha(e.detail.sha, task.sha)
    && e.detail.revision === task.revision && e.detail.base_sha === tip && e.detail.command === selected.command);
  const minutes = require('./gate-timeouts').minutes(st.project, 'tests');
  const retry = done?.detail.infrastructure_failure && done.detail.timeout?.minutes === minutes ? done : null;
  // The queue reservation serializes the rerun. Its receipt also serves later
  // passes, even if it times out, so queued notifications cannot multiply suites.
  if (done?.detail.rerun_of && (done.detail.ok || retry)) {
    const source = sourceOf(done);
    const summary = `Shared head-check rerun ${source}: ${done.detail.summary}`;
    S.mutate(ctx, 'head check shared', (st2, emit) => {
      if (st2.events.some((e) => e.cmd === 'head check shared' && e.task === task.id && e.detail.source === source)) return;
      emit(task.id, { sha: task.sha, revision: task.revision, base_sha: tip, command: selected.command,
        source, ok: done.detail.ok, summary, ...(retry ? { infrastructure_failure: true } : {}) });
    });
    return done.detail.ok ? { status: 'ok', tip } : { status: 'infrastructure', summary };
  }
  if (done?.detail.ok) return { status: 'ok', tip };
  const cmd = selected.command;
  const what = `${C.short(task.sha)}${ids.length > 1 ? ` (stack ${ids.join(', ')})` : ''} merged with ${base} at ${C.short(tip)}`;
  // The suite runs on a clean checkout of a commit of the merge: a suite that requires a clean
  // tree fails when HEAD names the head while the index holds the merge. attr.tree reads
  // .gitattributes from the head, as the merge in a checkout of the head did, so its merge drivers apply.
  const head = await C.resolveCommit(gc, repo.root, task.sha);
  if (!head) throw refuse(`${task.id}: commit ${C.short(task.sha)} is not in ${repo.root} for the head check`);
  const tree = await C.git(gc, repo.root, ['-c', `attr.tree=${head}`, 'merge-tree', '--write-tree', tip, head], { timeout: 60000 });
  if (!tree.ok) throw refuse(`${task.id}: cannot merge ${base} at ${C.short(tip)} for the head check: ${C.errText(tree)}`);
  const merged = await C.mergeCommit(gc, repo.root, { base: tip, head, tree: tree.stdout.trim().split('\n')[0] });
  if (merged.error) throw refuse(`${task.id}: head check ${merged.error}`);
  // A deferral or a stop leaves the line to the reaction's retry, with no head check recorded.
  unit = require('./governor').admit(ctx, { kind: 'suite', task: task.id, project: st.project });
  let outcome;
  try {
    signal = gc.signal = AbortSignal.any([ctx.gateSignal, unit.signal].filter(Boolean));
    outcome = await suite(ctx, st, gc, repo, merged, cmd, what);
    const stopped = !ctx.gateSignal?.aborted && unit.stopped();
    if (stopped) throw stopped;
  } catch (e) {
    throw (!e.governorDeferred && !ctx.gateSignal?.aborted && unit.stopped()) || e;
  } finally {
    unit.release();
  }
  if (!outcome.ran) throw refuse(`${task.id}: ${outcome.summary}`);
  Runtime.throwIfMissing(outcome.summary);
  S.mutate(ctx, 'head check', (st2, emit) => {
    emit(task.id, { sha: task.sha, revision: task.revision, base_sha: tip, command: cmd, members: ids, ok: outcome.ok, summary: outcome.summary, commands,
      ...(retry ? { rerun_of: sourceOf(retry) } : {}),
      ...(outcome.infrastructure_failure ? { infrastructure_failure: true, timeout: outcome.timeout } : {}) });
  });
  if (ctx.waitShutdown && ctx.automationSignal?.aborted && !ctx.gateSignal?.aborted) ctx.waitShutdown.drained += 1;
  ctx.automationSignal?.throwIfAborted();
  if (outcome.ok) return { status: 'ok', tip };
  if (outcome.infrastructure_failure) return { status: 'infrastructure', summary: outcome.summary };
  // The top task goes back; the line then checks the tasks below it alone.
  // A failure under a command, base or head that changed while the suite ran
  // says nothing about the current one, so the line checks again instead.
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision },
    expect: (now) => (isDeepStrictEqual(binding(now, passed), bound) ? null : 'head of the line changed during its check'),
    flags: { reason: `full suite fails on PR #${task.pr} merged with ${base}. ${outcome.summary}` } });
  return { status: 'rework' };
}

// The full suite on a clean checkout of the merge commit.
function suite(ctx, st, gc, repo, merged, cmd, what) {
  return C.withWorktree(gc, repo.root, merged.sha, async (dir, env) => {
    const timeouts = require('./gate-timeouts');
    const minutes = timeouts.minutes(st.project, 'tests');
    const timeout = Math.round(minutes * 60 * 1000);
    ctx.automationSignal?.throwIfAborted();
    const run = await C.shell(gc, cmd, { cwd: dir, env, timeout, keep: 1 << 20 });
    if (run.timedOut) return { ran: true, ...timeouts.failure(run, minutes, cmd, `on ${what}`) };
    const out = run.output ?? [run.stdout, run.stderr].filter(Boolean).join('\n');
    return run.ok ? { ran: true, ok: true, summary: `\`${cmd}\` on ${what}: exit 0` }
      : { ran: true, ok: false, summary: `\`${cmd}\` on ${what}: ${C.how(run)}. Last 40 lines:\n${C.tailLines(out, 40)}` };
  });
}

async function sweep(ctx) {
  ctx.automationSignal?.throwIfAborted();
  const st = S.loadState(ctx.stateDir);
  for (const task of st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t))) {
    ctx.automationSignal?.throwIfAborted();
    try {
      const remote = await pr(ctx, st, task);
      ctx.automationSignal?.throwIfAborted();
      if (!remote || remote.state !== 'OPEN' || !C.sameSha(remote.headRefOid, task.sha)) continue;
      await conflicts(ctx, task, true);
    } catch (e) {
      if (Runtime.missing(e)) throw e;
      ctx.automationSignal?.throwIfAborted();
      T.taskNote({ ...ctx, pos: [task.id, `automation conflict check: ${e.message}`] });
    }
  }
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
  // The wait host sets its hold timer from this.
  attempt.hold = require('./rework-hold').nextEnd(st);
  const holders = T.workerHolders(st, Date.now());
  const R = require('./reviewer');
  const reacting = busy(st);
  const debts = new Map((st.project.limits.paused ? [] : R.deferredDispatches(st)).map((d) => [d.id, d]));
  const reviews = [...debts.keys()].map((id) => T.getTask(st, id))
    .filter((task) => !reacting.has(task.id) && R.dispatchReport(st, task).ok);
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

const GOVERNOR_RETRY_MS = 5000;

function admissible(ctx, st, { task, kind }) {
  try {
    require('./governor').check(ctx, { kind, task, project: st.project });
    return true;
  } catch (e) {
    if (e.governorDeferred) return false;
    throw e;
  }
}

// Recursive drains share seen sources: a held older source must not send a
// later source repeatedly through the same queue while neither can run.
async function consume(ctx, events, supervisor = false, seen = new Set()) {
  if (!supervisor && !trusted(ctx)) return [];
  if (!Runtime.present()) return events;
  const pending = [];
  const engine = reactionContext(ctx);
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
    try {
      const action = { ...engine, pos: [event.task], refreshCI: event.cmd === 'automation reconcile' };
      if (event.cmd === 'merge') {
        await sweep(action);
        await queue(action);
      } else {
        const now = current(action, event.task);
        const ci = T.latestGateEvidence(now.task, 'ci', now.st.events);
        const pendingAcceptedCI = action.refreshCI && now.task.status === 'accepted' && ci?.pending && !ci.stalled;
        if (event.cmd === 'ci completed' || pendingAcceptedCI) await require('./check').runGate(action, 'ci');
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
      if (!ctx.automationSignal?.aborted) report = `tower-crane: automation ${event.task}: ${error}\n`;
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
          if ((governor || infrastructure) && !st.events.some((e) => e.cmd === 'automation queued' && e.detail.source === source)) {
            emit(event.task, { source }, 'automation queued');
          }
          emit(event.task, { source, phase, error, ...(held ? { governor: held } : {}),
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
    if (governor) {
      pending.push(event);
    }
    // A reviewer can finish while its dispatch reaction still owns this task,
    // and other tasks may wait for this executor slot. Drain them in
    // drain order after releasing it, even without a live waiter.
    const queued = waiting(S.loadState(ctx.stateDir));
    if (queued.length) pending.push(...await consume(engine, queued, true, seen));
    snapshot = S.loadState(ctx.stateDir);
  }
  return pending;
}

async function ciCompleted(ctx) {
  if (!trusted(ctx)) throw refuse('ci completed is an orchestrator or owner command');
  if (!/^[a-f\d]{7,64}$/i.test(ctx.flags.sha || '')) throw usage('ci completed needs --sha with the completed commit');
  S.mutate(ctx, 'ci completed', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    if (!['submitted', 'accepted'].includes(task.status) || !C.sameSha(task.sha, ctx.flags.sha)) {
      throw refuse(`${task.id}: CI completion does not match an active submitted head`);
    }
    emit(task.id, { sha: task.sha, revision: task.revision });
  });
  // emit's event ID is assigned by mutate when it appends the audit record.
  const latest = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'ci completed' && e.task === ctx.pos[0]);
  await consume(ctx, [latest]);
  const { st, task } = current(ctx, ctx.pos[0]);
  return { data: T.describeTask(st, task, Date.now()), text: `${task.id}: CI completion handled at ${task.sha.slice(0, 7)}` };
}

async function ciWebhook(ctx) {
  if (!trusted(ctx)) throw refuse('ci webhook is an orchestrator or owner command');
  let payload;
  try {
    const raw = ctx.pos[0] === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, ctx.pos[0]), 'utf8');
    payload = JSON.parse(raw);
  } catch (e) { throw usage(`cannot read CI webhook JSON: ${e.message}`); }
  const st = S.loadState(ctx.stateDir);
  if (payload.repository?.full_name !== st.project.repo) throw refuse('webhook repository differs from project repo');
  const check = payload.check_run || payload.check_suite || payload.workflow_run;
  if (!check || typeof check.head_sha !== 'string') throw usage('expected a check_run, check_suite or workflow_run webhook');
  if (payload.action !== 'completed' || check.status !== 'completed') {
    return { data: { ignored: true }, text: 'CI notification ignored: check is not completed' };
  }
  const tasks = st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status)
    && C.sameSha(t.sha, check.head_sha) && !merged(st, t));
  const handled = [];
  for (const task of tasks) {
    await ciCompleted({ ...ctx, pos: [task.id], flags: { sha: check.head_sha } });
    handled.push(task.id);
  }
  return { data: { tasks: handled }, text: `CI completion handled for ${handled.join(', ') || 'no active submitted heads'}` };
}

// Tasks a scheduled CI recheck would only queue behind: one whose executor is
// running, or one with a queued reconcile still owed a run.
function owedReconcile(st) {
  return new Set([...busy(st), ...pending(st).filter((e) => e.cmd === 'automation reconcile').map((e) => e.task)]);
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
// Only work already queued moves: a notification queued later keeps its place.
// A request with nothing queued is refused rather than left to apply later.
function prioritize(ctx) {
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('gates prioritize needs --reason so the queue shows why');
  S.mutate(ctx, 'gates prioritize', (st, emit) => {
    const who = require('./authority').enforce(ctx, st, ['gates.priority'], { emit });
    const task = T.getTask(st, ctx.pos[0]);
    if (acceptances(st).has(task.id)) {
      throw refuse(`${task.id} is accepted; its merge already runs ahead of submitted gate work, in acceptance order`);
    }
    const sources = [...new Set(pending(st).filter((e) => e.task === task.id).map(sourceOf))];
    if (!sources.length) throw refuse(`${task.id} has no queued gate work to prioritize`);
    emit(task.id, { reason, queued: sources.length, sources, authority: who });
  });
  const { st, task } = current(ctx, ctx.pos[0]);
  return { data: T.describeTask(st, task, Date.now()), text: `${task.id} prioritized in the gate queue: ${reason}` };
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
      const request = moved?.sources.has(sourceOf(e)) ? st.events[moved.index] : null;
      out.push({ id: e.task, prioritized: request ? { reason: request.detail.reason, agent: request.agent, at: request.at } : null });
    }
    return out;
  };
  return { running, queued: tasks(waiting(st)), blocked: tasks(pending(st).filter((e) => held.has(e.task))),
    deferred: tasks(pending(st).filter((e) => governorDeferral(last.get(sourceOf(e))))) };
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

module.exports = { consume, refillWorkers, refillBlockers, busy, governorDeferred, ciCompleted, ciWebhook, backlog, merge, queue, prioritize, gateQueue, mergeBlockers, describeQueue, gatesRetry, unrestorable, headMoved, refreshStacks, reviewHeld, MERGEABILITY };
