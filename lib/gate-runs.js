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
// Gate metadata queries (git, the merge tree) each have a 60 s deadline, and a
// run makes a few around each timed command, so each planned budget, and a run
// that plans none, gets this much beyond its timeout.
const GRACE_MS = 60000;
const POLL_MS = [100, 2000];

// Leases this process holds while its gate runs, and those whose release
// write failed; the next acquire in this process records their end.
const active = new Set();
const unreleased = new Map();
let me = null;

// Tests, clean, final review and local CI run commands here. Hosted CI and
// sources only read remote state in seconds, so a second read costs no runner
// time. A final review asks the external reviewer once per head.
function leased(st, task, name) {
  if (name === 'tests' || name === 'clean' || name === 'docs' || name === 'final-review') return true;
  return name === 'ci' && !task.hotfix && st.project.ci?.local != null;
}

// The longest a healthy run takes: each timeout budget it may use, plus GRACE_MS for each.
// A gate module with more than one exports plan(project, root, task) with their count,
// as the tests gate does; commands sharing a timeout count once. Clean uses one. Local CI
// counts its command and, unless ci.local.rerun is false, one rerun on the same pinned merge.
// Counting the tests gate's host-only files reads git, so this runs before the lease's write.
function budgetMs(ctx, project, root, task, name) {
  if (name === 'ci') {
    const local = require('./ci-local').resolve(project.ci.local, task);
    const commands = local.rerun ? 2 : 1;
    return local.error ? GRACE_MS : commands * (local.timeout * 1000 + GRACE_MS);
  }
  if (name === 'final-review') {
    const config = require('./final-review').settings(project);
    return (config ? Math.round(config.timeout * 1000) : 0) + GRACE_MS;
  }
  const timeouts = require('./gate-timeouts');
  const flag = ctx.flags?.timeout;
  const minutes = flag == null ? timeouts.minutes(project, name) : Number(flag);
  if (!timeouts.valid(minutes)) return GRACE_MS;
  const gate = require(`./gates/${name}`);
  const budgets = typeof gate.plan === 'function' ? gate.plan(project, root, task) : 1;
  const probes = name === 'tests' && Array.isArray(task.host_probes) ? task.host_probes.length : 0;
  const probeMinutes = timeouts.minutes(project, 'host_probe');
  const probeBudget = probes && timeouts.valid(probeMinutes) ? probes * (Math.round(probeMinutes * 60000) + GRACE_MS) : 0;
  return Math.max(1, budgets) * GRACE_MS + Math.round(minutes * 60000) * budgets + probeBudget;
}

function matches(e, task, name) {
  return e.cmd === CMD && e.task === task.id && e.detail.type === name
    && sameSha(e.detail.sha, task.sha) && e.detail.revision === task.revision;
}

function lease(st, source) {
  return st.events.findLast((e) => e.cmd === CMD && e.detail.source === source);
}

// 'proven' for a holder whose process is seen alive, 'live' for one that cannot
// be observed and is inside its deadline, 'expired' past it, or 'dead'. A holder proven alive by its pid and Linux start ticks is live
// however long it runs. Without that proof (another host, macOS or Windows
// with no start ticks, no permission to signal) the deadline stands in for it.
// It covers every timed command the run may start, so a healthy run is not
// taken over; past it the run counts as ended.
function holderState(d, now = Date.now()) {
  me ??= { pid: process.pid, ...P.identity(process.pid) };
  if (d.pid === me.pid && d.host === me.host && d.start_ticks === me.start_ticks) return active.has(d.source) ? 'proven' : 'dead';
  const state = P.processState(d);
  if (state === 'exited') return 'dead';
  if (state === 'running' && d.start_ticks !== undefined) return 'proven';
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

// A holder that cannot be observed is waited for until its deadline, which can be hours away.
function until(deadline) {
  const minutes = Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 60000));
  return `; it cannot be observed, so it counts as ended at its deadline ${deadline}, in ${minutes} min`;
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
// gate to this caller. budget is budgetMs for this run.
async function acquire(ctx, task, name, budget) {
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
      const holder = found.findLast((h) => h.state === 'proven' || h.state === 'live');
      if (holder) return { holder: holder.e, proven: holder.state === 'proven' };
      const expired = found.filter((h) => h.state === 'expired').map((h) => h.e);
      const source = `gate:${randomUUID()}`;
      const deadline = new Date(Date.now() + budget).toISOString();
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
    note(name, `joining the ${name} run at ${short(task.sha)} (revision ${task.revision}) by ${owner(holder)}${got.proven ? '' : until(holder.detail.deadline)}`);
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

module.exports = { CMD, leased, budgetMs, acquire, release, abandon };
