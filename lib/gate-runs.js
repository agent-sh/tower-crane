'use strict';

// A gate that runs a command on this host holds a lease for its task, gate,
// head and revision while it runs. A second accept, check, gates retry or
// automation reaction at the same head and revision joins that run and uses
// its evidence instead of starting another copy, whose result could be
// discarded once the first copy's verdict changes the task.

const { randomUUID } = require('node:crypto');
const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const { sameSha, short } = require('./gates/common');
const { refuse } = require('./util');

const CMD = 'gate run';
// Gate metadata queries (git, the merge tree) each have a 60 s deadline, so a
// run can record its evidence up to that long after its command's timeout.
const GRACE_MS = 60000;
const POLL_MS = [100, 2000];

// Tests, clean and local CI run commands here. Hosted CI and sources only read
// remote state in seconds, so a second read costs no runner time.
function leased(st, task, name) {
  if (name === 'tests' || name === 'clean') return true;
  return name === 'ci' && !task.hotfix && st.project.ci?.local != null;
}

function budgetMs(st, task, name) {
  if (name === 'ci') {
    const local = require('./ci-local').resolve(st.project.ci.local, task);
    return local.error ? 0 : local.timeout * 1000;
  }
  const timeouts = require('./gate-timeouts');
  const minutes = timeouts.minutes(st.project, name);
  return timeouts.valid(minutes) ? minutes * 60000 : 0;
}

function matches(e, task, name) {
  return e.cmd === CMD && e.task === task.id && e.detail.type === name
    && sameSha(e.detail.sha, task.sha) && e.detail.revision === task.revision;
}

function lease(st, source) {
  return st.events.findLast((e) => e.cmd === CMD && e.detail.source === source);
}

// The live run of this gate at the task's head and revision, as its start event.
function running(st, task, name) {
  const starts = st.events.filter((e) => matches(e, task, name) && e.detail.phase === 'running');
  return starts.findLast((e) => lease(st, e.detail.source).detail.phase === 'running' && P.processState(e.detail) !== 'exited') || null;
}

function owner(e) {
  return `${e.agent}${e.via ? ` via ${e.via}` : ''}, pid ${e.detail.pid} on ${e.detail.host || 'an unknown host'}, started ${e.at}`;
}

function aborted(ctx) {
  ctx.automationSignal?.throwIfAborted();
  ctx.gateSignal?.throwIfAborted();
}

// Takes the lease, or waits for the live run that holds it and returns that
// run's evidence as { joined: { holder, entry } }. A holder that dies or ends
// without evidence leaves the gate to this caller. A holder still running past
// its own deadline (its timeout plus GRACE_MS) is refused, not duplicated.
async function acquire(ctx, task, name) {
  for (;;) {
    aborted(ctx);
    const got = S.mutate(ctx, CMD, (st, emit) => {
      const holder = running(st, task, name);
      if (holder) return { holder };
      const source = `gate:${randomUUID()}`;
      const deadline = new Date(Date.now() + budgetMs(st, task, name) + GRACE_MS).toISOString();
      const detail = { type: name, sha: task.sha, revision: task.revision, source, phase: 'running', deadline,
        pid: process.pid, ...P.identity(process.pid) };
      emit(task.id, detail, CMD);
      return { lease: { task: task.id, ...detail } };
    });
    if (got.lease) return got;
    const { holder } = got;
    process.stderr.write(`[${name}] joining the ${name} run at ${short(task.sha)} (revision ${task.revision}) by ${owner(holder)}; waiting until ${holder.detail.deadline}\n`);
    for (let wait = POLL_MS[0]; ; wait = Math.min(wait * 2, POLL_MS[1])) {
      aborted(ctx);
      const st = S.loadState(ctx.stateDir);
      const now = lease(st, holder.detail.source);
      if (now.detail.phase !== 'running') {
        // The lease's end is logged before tasks.json is replaced; the lock covers both.
        const t = T.getTask(S.withLock(ctx.stateDir, () => S.loadState(ctx.stateDir)), task.id);
        const entry = now.detail.evidence_at && t.evidence.findLast((e) => e.type === name && e.at === now.detail.evidence_at
          && sameSha(e.sha, task.sha) && e.revision === task.revision);
        if (entry) return { joined: { holder, entry: { task: t.id, ...entry } } };
        break;
      }
      if (P.processState(now.detail) === 'exited') break;
      if (Date.now() >= Date.parse(holder.detail.deadline)) {
        throw refuse(`${task.id}: ${name} is already running at ${short(task.sha)} (revision ${task.revision}) by ${owner(holder)}, and passed its deadline ${holder.detail.deadline}; rerun after it finishes or its process ends`);
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// Recorded in the same write as the evidence, so a joiner that sees the lease
// end also sees what the run recorded.
function release(emit, held, evidenceAt) {
  const { task, type, sha, revision, source } = held;
  emit(task, { type, sha, revision, source, phase: 'done', evidence_at: evidenceAt }, CMD);
}

function abandon(ctx, held, error) {
  const { task, type, sha, revision, source } = held;
  try {
    S.mutate(ctx, CMD, (st, emit) => emit(task, { type, sha, revision, source, phase: 'error', error: error?.message ?? null }, CMD));
  } catch {
    // The lease ends with this process; a joiner sees its pid exit.
  }
}

module.exports = { CMD, leased, acquire, release, abandon };
