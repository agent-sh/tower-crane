'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Sessions = require('./spawn-session');
const C = require('./gates/common');
const { refuse, usage, readStdin } = require('./util');
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
  const env = { ...ctx.env, TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_VIA: 'automation' };
  delete env.TOWER_CRANE_BROKER;
  return { ...ctx, agent: 'orchestrator', agentExplicit: true, env, flags: {} };
}

function current(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  return { st, task: T.getTask(st, id) };
}

function merged(st, task) {
  return require('./stack').merged(st, task);
}

function eligible(st, event) {
  if (!['submit', 'accept', 'ci completed', 'spawn exit', 'worker-exited', 'check ci', 'merge', 'automation reconcile'].includes(event.cmd)
    && !(event.cmd === 'evidence' && event.detail.type === 'review')) return false;
  const task = st.tasks.tasks.find((t) => t.id === event.task);
  if (!task || !['submitted', 'accepted'].includes(task.status)) return false;
  if (event.detail?.sha && !C.sameSha(event.detail.sha, task.sha)) return false;
  if (event.detail?.revision && event.detail.revision !== task.revision) return false;
  if (event.cmd === 'merge') return event.detail.ok === true;
  if (merged(st, task)) return false;
  return ['submit', 'accept', 'ci completed', 'spawn exit', 'worker-exited', 'automation reconcile'].includes(event.cmd)
    || event.cmd === 'check ci' || event.cmd === 'evidence' && event.detail.type === 'review';
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

// Queued notifications still owed a run, in submission order. A task with a
// live executor drains its own notifications, so it holds no one back.
function waiting(st) {
  const queued = new Set(st.events.filter((e) => e.cmd === 'automation queued').map((e) => e.detail.source));
  if (!queued.size) return [];
  const receipts = new Map();
  const busy = new Set();
  for (const e of st.events) {
    if (e.cmd !== 'automation') continue;
    receipts.set(e.detail.source, e.detail);
    if (live(e.detail)) busy.add(e.task);
    else busy.delete(e.task);
  }
  return st.events.filter((e) => {
    const source = sourceOf(e);
    const receipt = receipts.get(source);
    return queued.has(source) && !busy.has(e.task) && (!receipt || receipt.phase === 'running') && eligible(st, e);
  });
}

// One task reaction runs at a time, outside the state lock, and at most
// gates.executors reactions run on this host. A dead executor leaves a
// retryable start receipt; another host's unobservable PID stays busy.
// Returns 'behind' when a slot is free but older queued work owns it.
function reserve(ctx, event) {
  const source = sourceOf(event);
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
    const first = waiting(st)[0];
    if (first && sourceOf(first) !== source && position(sourceOf(first)) < position(source)) {
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
  const queued = queuedFor(ctx, id || T.getTask(S.loadState(ctx.stateDir), ctx.pos[0]).id);
  if (queued.length) await consume(ctx, queued);
  if (error) throw error;
  return result;
}

// Passing evidence whose inputs no longer match, such as the pinned command or
// tests policy, runs again. A failure waits for an explicit retry, `gates
// retry`; a CI completion is such a retry for the CI gate.
function gateDue(st, task, type) {
  const latest = T.latestGateEvidence(task, type, st.events);
  if (latest) return latest.ok && !T.gateReport(task, st.events, st).gates.find((g) => g.type === type)?.ok;
  return !task.evidence.some((e) => e.type === type && e.revision === task.revision && C.sameSha(e.sha, task.sha));
}

async function software(ctx, includeCI = true) {
  let { st, task } = current(ctx, ctx.pos[0]);
  const snapshot = { sha: task.sha, revision: task.revision };
  for (const type of T.requiredGates(task).filter((g) => g !== 'review' && (includeCI || g !== 'ci'))) {
    if (task.status !== 'submitted' || task.sha !== snapshot.sha || task.revision !== snapshot.revision) return;
    if (gateDue(st, task, type)) await require('./check').runGate({ ...ctx, flags: {} }, type);
    ({ st, task } = current(ctx, task.id));
    if (!T.gateReport(task, st.events, st).gates.find((g) => g.type === type)?.ok) return;
  }
}

// The operational retry: each failed software gate runs again at the submitted
// head with its current inputs, for a failure a later fix made obsolete, such as
// a timeout. Automation leaves failures at unchanged inputs alone.
async function gatesRetry(ctx) {
  if (!trusted(ctx)) throw refuse('gates retry is an orchestrator or owner command');
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

async function pr(ctx, st, task) {
  if (!task.pr || !st.project.repo) return null;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const result = await C.gh({ root: repo?.root }, ['pr', 'view', String(task.pr), '-R', st.project.repo,
    '--json', 'state,headRefOid,mergeable,mergeStateStatus']);
  if (!result.ok) throw refuse(C.ghFailure(result, `inspect PR #${task.pr}`));
  try { return JSON.parse(result.stdout); }
  catch { throw refuse(`cannot read PR #${task.pr} mergeability`); }
}

// `onto` names the base explicitly; without it the task's PR base is used,
// which for a stacked task is its lower task's branch.
async function baseTip(ctx, st, task, fetch, onto) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse(`${task.id}: no repository for conflict detection`);
  const base = (onto || require('./stack').targetBase(st, task)).replace(/^origin\//, '');
  const gc = { root: repo.root };
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

async function conflicts(ctx, task, fetch, onto) {
  const { st } = current(ctx, task.id);
  const { repo, base, tip } = await baseTip(ctx, st, task, fetch, onto);
  const gc = { root: repo.root };
  const result = await C.withWorktree(gc, repo.root, task.sha, async (dir, env) => {
    const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
      { timeout: 60000, env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
    if (trial.ok) return { files: [] };
    const diff = await C.git(gc, dir, ['diff', '--name-only', '--diff-filter=U', '-z'], { env });
    if (!diff.ok) throw refuse(`cannot list ${task.id} conflicting files: ${C.errText(diff)}`);
    const files = diff.stdout.split('\0').filter(Boolean);
    if (!files.length) throw refuse(`${task.id}: trial merge failed without conflicting files: ${C.errText(trial)}`);
    return { files };
  });
  if (!result.files) throw refuse(result.summary);
  if (!result.files.length) return false;
  const expectedBase = onto ? {} : { base: require('./stack').targetBase(st, task) };
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision, ...expectedBase },
    flags: { reason: `PR #${task.pr} conflicts with ${base}: ${result.files.join(', ')}. Merge the base, resolve these files and submit a new head.` } });
  return true;
}

// GitHub computes mergeability after a base moves, so the first read after a
// submit can be UNKNOWN. Re-reading briefly finds a conflict before a suite
// run is spent on it; a suite takes minutes, so these seconds cost little.
const MERGEABILITY_RETRIES = 3;
const MERGEABILITY_RETRY_MS = 2000;

async function settledPr(ctx, st, task) {
  for (let retry = 0; ; retry++) {
    const remote = await pr(ctx, st, task);
    const unknown = remote?.state === 'OPEN' && (remote.mergeable === 'UNKNOWN' || remote.mergeStateStatus === 'UNKNOWN');
    if (!unknown || retry === MERGEABILITY_RETRIES) return remote;
    await new Promise((resolve) => setTimeout(resolve, MERGEABILITY_RETRY_MS));
  }
}

async function advance(ctx, inspect = true) {
  let { st, task } = current(ctx, ctx.pos[0]);
  let mergeable = true;
  if (!['submitted', 'accepted'].includes(task.status) || merged(st, task)) return 'done';
  if (inspect && task.pr) {
    const remote = await settledPr(ctx, st, task);
    // A remote merge can precede its local receipt if the executor died.
    // The merge gate confirms the accepted head without issuing another merge.
    if (remote?.state !== 'MERGED' || task.status !== 'accepted') {
      if (!remote || remote.state !== 'OPEN') return 'deferred';
      if (!C.sameSha(remote.headRefOid, task.sha)) return 'deferred';
      if (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY') {
        if (!await conflicts(ctx, task, true)) return 'deferred';
        // An accepted task that leaves the line may have been stopping it.
        if (task.status === 'accepted') await queue(ctx);
        return 'done';
      }
      mergeable = remote.mergeable === 'MERGEABLE' && !!remote.mergeStateStatus && remote.mergeStateStatus !== 'UNKNOWN';
    }
  }
  if (task.status === 'submitted') {
    // Tests, cleanup and source verification need the matched head. CI and
    // model dispatch still require GitHub's mergeability result.
    await software(ctx, mergeable);
    ({ st, task } = current(ctx, task.id));
    if (!mergeable) return 'deferred';
    if (task.status !== 'submitted' || !require('./reviewer').softwareReport(st, task).ok) return 'done';
    const report = T.gateReport(task, st.events, st);
    // Native workers without an exit receipt use explicit accept for review
    // dispatch. A tracked worker must have exited before a model reads its diff.
    const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
      && e.detail.role === 'worker' && e.detail.agent === task.submitted_by);
    if (!report.ok && (!worker || !Sessions.exitedAttempt(worker, st.events))) return 'done';
    await T.accept({ ...ctx, flags: {} });
    ({ st, task } = current(ctx, task.id));
  }
  if (!mergeable) return 'deferred';
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
function claimQueue(ctx) {
  return S.mutate(ctx, 'merge queue', (st, emit) => {
    const last = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.phase !== 'requested');
    if (last?.detail.phase === 'running' && P.processState(last.detail) !== 'exited') {
      emit(null, { phase: 'requested' });
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
  if (!claimQueue(ctx)) return;
  const at = {};
  try {
    let pass;
    do pass = await drain(ctx, at);
    while (releaseQueue(ctx, null, pass));
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
// (null when the line drained), and `skipped`, the heads passed over.
async function drain(ctx, at) {
  // A requested pass retries heads whose evidence changed during the last pass.
  const passed = at.passed = new Map();
  const done = (blocked) => ({ blocked: blocked || [...passed.values()][0] || null, skipped: [...passed.values()] });
  for (;;) {
    const st = S.loadState(ctx.stateDir);
    const entry = head(st, passed);
    if (!entry) return done(null);
    at.task = entry.target.id;
    let step;
    try { step = await attempt(ctx, st, entry, passed); }
    catch (e) {
      // A task refusal, including an unreadable PR, must not strand later entries.
      if (e.code !== 1) throw e;
      step = { skip: e.message };
    }
    at.task = null;
    // Automatic reactions wait for GitHub to compute mergeability. An
    // explicit batch leaves pending entries for its next invocation.
    if (step.wait && !ctx.acceptedBatch) return done({ task: entry.target.id, reason: step.wait });
    if (step.skip || step.wait) pass(ctx, passed, entry.target, step.skip || step.wait);
  }
}

// One turn of the head of the line: `{}` when the line should be read again,
// `{wait}` when it must wait or `{skip}` when the head cannot advance.
async function attempt(ctx, st, entry, passed) {
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
        if (await conflicts({ ...action, pos: [m.id] }, m, true)) return {};
        return { skip: `${m.id}: GitHub reports PR #${m.pr} conflicting, but a trial merge with its base is clean` };
      }
      if (view.mergeable !== 'MERGEABLE' || !view.mergeStateStatus || view.mergeStateStatus === 'UNKNOWN') {
        return { wait: `${m.id}: GitHub mergeability of PR #${m.pr} is ${view.mergeable || 'unknown'}/${view.mergeStateStatus || 'unknown'}` };
      }
      const report = T.gateReport(m, st.events, st);
      if (!report.ok) return { skip: `${m.id}: gates no longer pass: ${report.missing.join('; ')}` };
    }
    let check;
    try { check = await headCheck(action, st, entry, passed); }
    catch (e) { if (e.code !== 1) throw e; return { skip: e.message }; }
    if (check.status === 'rework') return {};
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
  const source = `queue:${randomUUID()}`;
  const held = await hold(ctx, target.id, source);
  let result;
  try {
    result = await require('./check').runGate({ ...action,
      expect: (now) => (isDeepStrictEqual(binding(now, passed), bound) ? null : 'head of the line changed during its check') }, 'merge');
  } catch (e) {
    unhold(ctx, held, source, e);
    if (e.code !== 1) throw e;
    return { skip: e.message };
  }
  unhold(ctx, held, source, null);
  if (result.stale) return {};
  if (!result.data.ok) return { skip: `merge refused: ${result.data.summary}` };
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
  const gc = { root: repo.root, exec: async (command, args, opts = {}) => {
    const run = opts.shell ? C.treeExec : require('./commands').spawnSync;
    const r = await run(command, args, { windowsHide: true, ...opts });
    commands.push({ command, args: [...args], cwd: opts.cwd || null, status: r.status ?? null, signal: r.signal || null });
    return r;
  } };
  const contains = async (m) => (await C.git(gc, repo.root, ['merge-base', '--is-ancestor', tip, m.sha])).ok;
  if ((await Promise.all(members.map(contains))).every(Boolean)) return { status: 'ok', tip };
  // Bottom first, so the rework goes to the lowest task that conflicts.
  for (const m of members) if (await conflicts({ ...ctx, pos: [m.id] }, m, false, onto)) return { status: 'rework' };
  if (await contains(task)) return { status: 'ok', tip };
  const ids = members.map((m) => m.id);
  const done = st.events.findLast((e) => e.cmd === 'head check' && e.task === task.id && C.sameSha(e.detail.sha, task.sha)
    && e.detail.revision === task.revision && e.detail.base_sha === tip && e.detail.command === selected.command);
  if (done?.detail.ok) return { status: 'ok', tip };
  const cmd = selected.command;
  const what = `${C.short(task.sha)}${ids.length > 1 ? ` (stack ${ids.join(', ')})` : ''} merged with ${base} at ${C.short(tip)}`;
  const outcome = await C.withWorktree(gc, repo.root, task.sha, async (dir, env) => {
    const merge = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
      { timeout: 60000, env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
    if (!merge.ok) throw refuse(`${task.id}: cannot merge ${base} at ${C.short(tip)} for the head check: ${C.errText(merge)}`);
    const timeouts = require('./gate-timeouts');
    const minutes = timeouts.minutes(st.project, 'tests');
    const timeout = Math.round(minutes * 60 * 1000);
    const run = await C.shell(gc, cmd, { cwd: dir, env, timeout, keep: 1 << 20 });
    if (run.timedOut) return { ran: true, ...timeouts.failure(run, minutes, cmd, `on ${what}`) };
    const out = run.output ?? [run.stdout, run.stderr].filter(Boolean).join('\n');
    return run.ok ? { ran: true, ok: true, summary: `\`${cmd}\` on ${what}: exit 0` }
      : { ran: true, ok: false, summary: `\`${cmd}\` on ${what}: ${C.how(run)}. Last 40 lines:\n${C.tailLines(out, 40)}` };
  });
  if (!outcome.ran) throw refuse(`${task.id}: ${outcome.summary}`);
  S.mutate(ctx, 'head check', (st2, emit) => {
    emit(task.id, { sha: task.sha, revision: task.revision, base_sha: tip, command: cmd, members: ids, ok: outcome.ok, summary: outcome.summary, commands,
      ...(outcome.infrastructure_failure ? { infrastructure_failure: true, timeout: outcome.timeout } : {}) });
  });
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

async function sweep(ctx) {
  const st = S.loadState(ctx.stateDir);
  for (const task of st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t))) {
    try {
      const remote = await pr(ctx, st, task);
      if (!remote || remote.state !== 'OPEN' || !C.sameSha(remote.headRefOid, task.sha)) continue;
      await conflicts(ctx, task, true);
    } catch (e) {
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
      return source && (!last || last.detail.phase === 'running') && eligible(st, source) ? [source] : [];
    });
}

async function consume(ctx, events, supervisor = false) {
  if (!supervisor && !trusted(ctx)) return [];
  const pending = [];
  const engine = reactionContext(ctx);
  let snapshot = S.loadState(ctx.stateDir);
  const seen = new Set();
  for (const event of events) {
    const source = sourceOf(event);
    if (seen.has(source)) continue;
    seen.add(source);
    if (!eligible(snapshot, event)) continue;
    const reserved = reserve(engine, event);
    // Older queued work takes the free slot first; this event is queued
    // behind it, so the drain reaches it in submission order.
    if (reserved === 'behind') await consume(engine, waiting(S.loadState(ctx.stateDir)), true);
    if (reserved !== true) {
      const last = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'automation' && e.detail.source === sourceOf(event));
      if (last?.detail.phase !== 'done') pending.push(event);
      continue;
    }
    let error = null;
    let phase = 'done';
    try {
      const action = { ...engine, pos: [event.task] };
      if (event.cmd === 'merge') {
        await sweep(action);
        await queue(action);
      } else {
        if (event.cmd === 'ci completed') await require('./check').runGate(action, 'ci');
        phase = await advance(action);
      }
    } catch (e) {
      error = e.message;
      phase = 'error';
      process.stderr.write(`tower-crane: automation ${event.task}: ${error}\n`);
    } finally {
      S.mutate(engine, 'automation', (st, emit) => {
        emit(event.task, { source, phase, error });
      });
    }
    // A reviewer can finish while its dispatch reaction still owns this task,
    // and other tasks may wait for this executor slot. Drain them in
    // submission order after releasing it, even without a live waiter.
    const queued = waiting(S.loadState(ctx.stateDir));
    if (queued.length) await consume(engine, queued, true);
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

function backlog(ctx) {
  if (!trusted(ctx)) return [];
  const active = (st) => st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t));
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

module.exports = { consume, ciCompleted, ciWebhook, backlog, merge, queue, gatesRetry };
