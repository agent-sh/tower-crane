'use strict';

// A gate that runs a command on this host holds a lease for its task, gate,
// head and revision while it runs. A second accept, check, gates retry or
// automation reaction at the same head and revision joins that run and uses
// its evidence instead of starting another copy, whose result could be
// discarded once the first copy's verdict changes the task.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const { EventReader } = require('./event-reader');
const { sameSha, short } = require('./gates/common');

const CMD = 'gate run';
// Gate metadata queries (git, the merge tree) each have a 60 s deadline, so a
// run can record its evidence up to that long after its command's timeout.
const GRACE_MS = 60000;
const POLL_MS = [100, 2000];

// Leases this process holds while its gate runs, and those whose release
// write failed; the next acquire in this process records their end.
const active = new Set();
const unreleased = new Map();
let me = null;

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

// 'live', 'dead', or 'expired' for a holder that cannot be observed and is past
// its deadline. A holder proven alive by its pid and Linux start ticks is live
// however long it runs: a prove-mode tests gate runs several timed commands.
// Without that proof (another host, no start ticks, no permission to signal)
// the deadline stands in for it, and past the deadline the run counts as ended.
function holderState(d, now = Date.now()) {
  me ??= { pid: process.pid, ...P.identity(process.pid) };
  if (d.pid === me.pid && d.host === me.host && d.start_ticks === me.start_ticks) return active.has(d.source) ? 'live' : 'dead';
  const state = P.processState(d);
  if (state === 'exited') return 'dead';
  if (state === 'running' && d.start_ticks !== undefined) return 'live';
  return now < Date.parse(d.deadline) ? 'live' : 'expired';
}

// Running leases of this gate at the task's head and revision, as start events.
function holders(st, task, name) {
  return st.events.filter((e) => matches(e, task, name) && e.detail.phase === 'running'
    && lease(st, e.detail.source).detail.phase === 'running');
}

function owner(e) {
  return `${e.agent}${e.via ? ` via ${e.via}` : ''}, pid ${e.detail.pid} on ${e.detail.host || 'an unknown host'}, started ${e.at}`;
}

function aborted(ctx) {
  ctx.automationSignal?.throwIfAborted();
  ctx.gateSignal?.throwIfAborted();
}

function note(name, text) {
  process.stderr.write(`[${name}] ${text}\n`);
}

function end(held, phase, extra) {
  const { task, type, sha, revision, source } = held;
  return [task, { type, sha, revision, source, phase, ...extra }, CMD];
}

// Takes the lease, or waits for the live run that holds it and returns that
// run's evidence as { joined: { holder, entry } }. A holder that dies, ends
// without usable evidence, or cannot be observed past its deadline leaves the
// gate to this caller.
async function acquire(ctx, task, name) {
  const file = path.join(ctx.stateDir, 'events.jsonl');
  for (;;) {
    aborted(ctx);
    // Taken before the write, so the tail below cannot miss the holder's release.
    let after = 0;
    try { after = fs.statSync(file).size; } catch { /* No log yet; read it whole. */ }
    const got = S.mutate(ctx, CMD, (st, emit) => {
      for (const held of unreleased.values()) {
        if (lease(st, held.source)?.detail.phase === 'running') emit(...end(held, 'error', { error: 'released after a refused write' }));
      }
      const found = holders(st, task, name).map((e) => ({ e, state: holderState(e.detail) }));
      const holder = found.findLast((h) => h.state === 'live');
      if (holder) return { holder: holder.e };
      const expired = found.filter((h) => h.state === 'expired').map((h) => h.e);
      const source = `gate:${randomUUID()}`;
      const deadline = new Date(Date.now() + budgetMs(st, task, name) + GRACE_MS).toISOString();
      const detail = { type: name, sha: task.sha, revision: task.revision, source, phase: 'running', deadline,
        pid: process.pid, ...P.identity(process.pid), ...(expired.length ? { replaces: expired.map((e) => e.detail.source) } : {}) };
      emit(task.id, detail, CMD);
      return { lease: { task: task.id, ...detail }, expired };
    });
    unreleased.clear();
    if (got.lease) {
      for (const e of got.expired) {
        note(name, `the ${name} run by ${owner(e)} cannot be observed and passed its deadline ${e.detail.deadline}; treating it as ended and running the gate here`);
      }
      active.add(got.lease.source);
      return got;
    }
    const { holder } = got;
    const { source } = holder.detail;
    note(name, `joining the ${name} run at ${short(task.sha)} (revision ${task.revision}) by ${owner(holder)}`);
    const reader = new EventReader(file, { after, parse: (line) => (line.includes(source) ? JSON.parse(line) : null) });
    for (let wait = POLL_MS[0]; ; wait = Math.min(wait * 2, POLL_MS[1])) {
      aborted(ctx);
      const batch = reader.read();
      let finished = batch.rows.findLast((e) => e.cmd === CMD && e.detail.source === source && e.detail.phase !== 'running');
      // A replaced log is read once in full rather than tailed.
      if (!finished && batch.reset) {
        const now = lease(S.loadState(ctx.stateDir), source);
        if (now.detail.phase !== 'running') finished = now;
      }
      if (finished) {
        const entry = !finished.detail.interrupted && finished.detail.evidence_at && evidence(ctx, task, name, finished.detail.evidence_at);
        if (entry) return { joined: { holder, entry } };
        note(name, `the joined ${name} run ended without usable evidence${finished.detail.interrupted ? ' (interrupted by wait shutdown)' : ''}; running the gate here`);
        break;
      }
      const state = holderState(holder.detail);
      if (state === 'dead') {
        note(name, `the joined ${name} run's process ended without recording evidence; running the gate here`);
        break;
      }
      if (state === 'expired') break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// The lease's end is logged before tasks.json is replaced; the lock covers both.
function evidence(ctx, task, name, at) {
  const t = T.getTask(S.withLock(ctx.stateDir, () => S.loadState(ctx.stateDir)), task.id);
  const e = t.evidence.findLast((v) => v.type === name && v.at === at && sameSha(v.sha, task.sha) && v.revision === task.revision);
  return e ? { task: t.id, ...e } : null;
}

// Recorded in the same write as the evidence, so a joiner that sees the lease
// end also sees what the run recorded. An interrupted run's evidence is not a
// verdict, so a joiner runs the gate itself.
function release(emit, held, evidenceAt, interrupted = false) {
  active.delete(held.source);
  emit(...end(held, 'done', { evidence_at: evidenceAt, ...(interrupted ? { interrupted: true } : {}) }));
}

function abandon(ctx, held, error) {
  active.delete(held.source);
  const write = (c) => S.mutate(c, CMD, (st, emit) => emit(...end(held, 'error', { error: error?.message ?? null })));
  try {
    write(ctx);
    return;
  } catch {
    // The orchestrator guard refuses a command whose lease changed meanwhile.
  }
  try {
    // Ending this process's own lease is engine bookkeeping, as automation's receipts are.
    write({ ...ctx, automation: true, orchestratorSession: require('./orchestrator').holder(S.loadState(ctx.stateDir)) });
  } catch {
    unreleased.set(held.source, held);
  }
}

module.exports = { CMD, leased, acquire, release, abandon };
