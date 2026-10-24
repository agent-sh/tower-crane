'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const C = require('./gates/common');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { live, merged } = require('./automation-common');

const EXECUTORS = 2;

// A reaction's running receipt holds its task, not an executor. Executors
// count CPU work on this host only: automation's tests, clean and local CI
// runs, with the host probes the tests gate runs, and the merge line's head
// check. Review dispatch and GitHub reads take none, so a reaction waiting on
// a reviewer or on CI never holds one. A done event releases a lease and the
// PID identity releases it on death; only this host's leases count, since the
// cap protects its cores.
function cpuLeases(st) {
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'executor') last.set(e.detail.lease, e);
  return [...last.values()].filter((e) => live(e.detail) && (!e.detail.host || e.detail.host === os.hostname()))
    .map((e) => ({ task: e.task, at: e.at, ...e.detail }));
}

function executors(st) {
  return cpuLeases(st).length;
}

function cap(st) {
  return st.project.gates?.executors ?? EXECUTORS;
}

// The gates that run the project's commands on this host. A tests gate in
// mode none runs nothing.
function cpuGate(st, task, type) {
  if (type === 'tests') return require('./tests-policy').resolve(st.project, task.kind).mode !== 'none';
  return require('./gate-runs').leased(st, task, type);
}

// Not a refusal: the merge line passes over refused heads, but a deferred
// head check stops the line until the reaction resumes.
function executorBusy(st, task, kind, behind = null) {
  const e = new Error(behind ? `${task.id}: ${kind} waits behind ${behind} for a gate executor`
    : `${task.id}: ${kind} waits for a gate executor (${cap(st)} of ${cap(st)} in use)`);
  e.executorDeferred = { executors: cap(st), kind };
  return e;
}

// A reaction takes one executor for its CPU work and keeps it until its next
// GitHub read or its end. A full cap, or an older reaction already waiting for
// a slot, defers the reaction: it ends owed, and a freed slot resumes it in
// queue order. A command run by hand has no reaction to defer, so it waits.
async function takeExecutor(ctx, task, kind) {
  const { outranked } = require('./automation-schedule');
  const slot = ctx.executor;
  const held = slot || (ctx.manualExecutor ||= { lease: null, task: null, kind: null });
  if (held.lease) {
    if (held.task !== task.id || held.kind !== kind) {
      S.mutate(ctx, 'executor', (st, emit) => emit(task.id, { lease: held.lease, phase: 'running', kind, pid: process.pid, ...P.identity(process.pid) }));
      Object.assign(held, { task: task.id, kind });
    }
    return;
  }
  let noted = false;
  for (let wait = 100; ; wait = Math.min(wait * 2, 2000)) {
    ctx.automationSignal?.throwIfAborted();
    ctx.gateSignal?.throwIfAborted();
    const lease = `cpu:${randomUUID()}`;
    const taken = S.mutate(ctx, 'executor', (st, emit) => {
      if (executors(st) >= cap(st)) {
        if (slot) throw executorBusy(st, task, kind);
        return cap(st);
      }
      const ahead = slot && outranked(st, slot.event);
      if (ahead) throw executorBusy(st, task, kind, ahead.task);
      emit(task.id, { lease, phase: 'running', kind, ...(slot ? { source: slot.source } : {}), pid: process.pid, ...P.identity(process.pid) });
      return true;
    });
    if (taken === true) {
      Object.assign(held, { lease, task: task.id, kind });
      return;
    }
    if (!noted) process.stderr.write(`[${kind}] ${task.id} waits for a free gate executor (${taken} of ${taken} in use)\n`);
    noted = true;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function releaseExecutor(ctx) {
  const held = ctx.executor || ctx.manualExecutor;
  if (!held?.lease) return;
  S.mutate(ctx, 'executor', (st, emit) => emit(held.task, { lease: held.lease, phase: 'done' }));
  Object.assign(held, { lease: null, task: null, kind: null });
}

// CPU executors in use on this host, apart from the tasks that hold none:
// those waiting on GitHub checks at their head, and submitted tasks whose
// software gates pass and whose review is still missing.
function gateWaits(st) {
  const open = st.tasks.tasks.filter((t) => ['submitted', 'accepted'].includes(t.status) && !merged(st, t));
  const github = open.filter((t) => {
    const ci = T.latestGateEvidence(t, 'ci', st.events);
    return ci?.pending && !ci.stalled && C.sameSha(ci.sha, t.sha) && ci.revision === t.revision;
  }).map((t) => t.id);
  const review = open.filter((t) => t.status === 'submitted' && require('./reviewer').softwareReport(st, t).ok
    && !T.gateReport(t, st.events, st).gates.find((g) => g.type === 'review')?.ok).map((t) => t.id);
  return { executors: { cap: cap(st), in_use: cpuLeases(st).map(({ task, kind }) => ({ task, kind })) }, github, review };
}

// The status line for CPU executors: how many of the cap are in use and for what.
function describeExecutors({ cap: limit, in_use: used }) {
  return `${used.length} of ${limit} in use${used.length ? `: ${used.map((u) => `${u.task} ${u.kind}`).join(', ')}` : ''}`;
}

module.exports = { EXECUTORS, cpuLeases, executors, cap, cpuGate, executorBusy, takeExecutor, releaseExecutor, gateWaits, describeExecutors };
