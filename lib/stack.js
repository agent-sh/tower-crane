'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');
const { isDeepStrictEqual, stripVTControlCharacters } = require('node:util');
const S = require('./state');
const { refuse, usage, nowIso, readStdin, shaMatch: sameSha } = require('./util');

// Stack commands can fetch and push; unattended calls have a bounded lifetime.
const TIMEOUT = 60000;
const RESERVATION = ['automation', 'automation queued', 'automation reconcile', 'gates prioritize', 'merge pause', 'merge pause end', 'gate run', 'executor', 'ci poll'];
// Hook traffic and spawn startup receipts land while a worker runs, including
// during a merge's head checks. They change no task state a stack publishes.
const BOOKKEEPING = (e) => e.cmd.startsWith('hook ') || ['startup', 'spawn session'].includes(e.cmd);
// A stop receipt and the orchestrator notice it generates are appended in one batch,
// so the notice is the event right after its receipt. Ordinary messages are not.
const STOP_NOTICE = (prev, e) => e.cmd === 'msg' && prev?.cmd === 'hook stop' && prev.task === e.task && prev.agent === e.agent;

function ghEnv() {
  const { shellQuote } = require('./gates/common');
  const editor = `${shellQuote(process.execPath)} -e "process.exit(1)"`;
  return { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: editor, GIT_SEQUENCE_EDITOR: editor };
}

function run(root, args) {
  const r = cp.spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT,
    detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: ghEnv() });
  if (r.error?.code === 'ETIMEDOUT' && process.platform !== 'win32' && r.pid) {
    try { process.kill(-r.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  return r;
}

// Link, sync and refresh run inside wait, so their GitHub calls must not block
// signal delivery. A drained wait (ctx.automationSignal) starts no further step;
// a forced stop (ctx.gateSignal) kills the running command's process tree.
// Outside wait no signal can reach the call, so it keeps the blocking run: a
// process-tree run costs tens of milliseconds more per call. Inside wait the
// longer unlocked window is safe because link compares only what it read
// (linkInputs), so unrelated task events during its calls do not refuse it.
function runAsync(ctx, root, args) {
  ctx.automationSignal?.throwIfAborted();
  if (!ctx.gateSignal) return Promise.resolve(run(root, args));
  return require('./gates/common').treeExec('gh', args, { cwd: root, timeout: TIMEOUT, env: ghEnv(), signal: ctx.gateSignal });
}

function error(r) {
  return String(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim();
}

function syncFailure(r) {
  if (r.status === 0) return null;
  const text = stripVTControlCharacters([r.stdout, r.stderr, r.error?.message].filter(Boolean).join('\n')).trim();
  const lines = text.split(/\r?\n/);
  // gh-stack prints its abort banner separately from the reason, sometimes on stderr.
  const reason = lines.findLast((line) => /^\s*(?:Reason|Error):\s*/i.test(line))
    ?.replace(/^\s*(?:Reason|Error):\s*/i, '').trim();
  const conflict = lines.find((line) => /^\s*(?:[✗✘×!]\s*)?(?:Conflict detected\b|CONFLICT \([^)]+\):)/i.test(line));
  const detail = lines.filter((line) => !/^\s*(?:[✗✘×!]\s*)?(?:Sync aborted\b|Your current checkout is unchanged\b)/i.test(line)).join('\n').trim();
  return { failure: conflict ? 'conflict' : 'tool', reason: reason || conflict?.trim() || detail || error(r) };
}

function merged(st, task) {
  if (task.hotfix) return task.status === 'accepted' && require('./hotfix').recorded(st, task);
  const e = require('./tasks').latestGateEvidence(task, 'merge', st.events);
  return !!(e?.ok && !e.waived);
}

function baseTip(repo, base) {
  const local = S.git(['rev-parse', '--verify', `refs/heads/${base}^{commit}`], repo.root);
  const remote = S.git(['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`], repo.root);
  return remote && (!local || S.git(['merge-base', '--is-ancestor', local, remote], repo.root) !== null) ? remote : local;
}

function chain(st, task) {
  const out = [];
  const seen = new Set();
  let cur = task;
  while (cur) {
    if (seen.has(cur.id)) throw refuse('stack dependency cycle');
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.stack?.parent ? require('./tasks').getTask(st, cur.stack.parent) : null;
  }
  return out;
}

function membersOf(st, task) {
  const bottom = chain(st, task)[0].id;
  return st.tasks.tasks.filter((t) => chain(st, t)[0].id === bottom && t.status !== 'cancelled');
}

// Every stack decision depends on the project settings and on each chain it
// touches: members, their stack metadata and their events. Network work runs
// unlocked, so each stack mutation snapshots this scope first and applies only
// when the scope under the lock still matches.
function scopeOf(st, ids) {
  const keep = new Set();
  for (const id of ids) {
    const task = st.tasks.tasks.find((t) => t.id === id);
    if (task) for (const t of membersOf(st, task)) keep.add(t.id);
    else keep.add(id);
  }
  // Reservation, priority and merge pause receipts change no task state. A
  // reaction queued behind a merge, a request to move one, or the end of a
  // pause the merge itself ended must not invalidate the merge's stack head
  // checks.
  return { project: st.project, members: st.tasks.tasks.filter((t) => keep.has(t.id)),
    events: st.events.filter((e, i) => keep.has(e.task) && !RESERVATION.includes(e.cmd) && !BOOKKEEPING(e) && !STOP_NOTICE(st.events[i - 1], e)) };
}

function capture(st, ids) {
  return { ids: [...ids], scope: structuredClone(scopeOf(st, ids)) };
}

function unchanged(snapshot, current) {
  return isDeepStrictEqual(scopeOf(current, snapshot.ids), snapshot.scope);
}

function stale(id, operation) {
  return Object.assign(refuse(`${id}: state changed during stack ${operation}; no stack state was applied; inspect the PRs and branches before retrying`), { staleState: true });
}

function compare(snapshot, current, operation) {
  if (!unchanged(snapshot, current)) throw stale(snapshot.ids[0], operation);
}

// What a link reads: the project settings and, for each member of the chain,
// its status, head, branch, PR, stack record and whether it merged. A link
// writes only stack records, so other writes to the members (gate evidence,
// notes, usage, reviewer dispatches and exits) cannot make it stale. Under a
// slow GitHub those land during every link attempt.
function linkInputs(st, id) {
  const task = st.tasks.tasks.find((t) => t.id === id);
  return { project: st.project, members: (task ? membersOf(st, task) : []).map((t) => ({ id: t.id, status: t.status,
    sha: t.sha ?? null, branch: t.branch ?? null, pr: t.pr ?? null, hotfix: !!t.hotfix, stack: t.stack ?? null,
    stack_disabled: !!t.stack_disabled, merged: merged(st, t) })) };
}

function snapshotOf(ctx) {
  return S.withLock(ctx.stateDir, () => {
    const state = S.loadState(ctx.stateDir);
    const task = require('./tasks').getTask(state, ctx.pos[0]);
    return { state, task, ...capture(state, [task.id]) };
  });
}

function completed(st, task) {
  return !!task.stack && chain(st, task).slice(0, -1).every((t) => merged(st, t));
}

function retirable(st, task) {
  return completed(st, task) && membersOf(st, task).every((t) => t.id === task.id || merged(st, t));
}

function effectiveStack(st, task) {
  return retirable(st, task) ? undefined : task.stack;
}

function targetBase(st, task) {
  return completed(st, task) ? st.project.base : (task.stack?.base || st.project.base);
}

function numbers(data, pr) {
  const stacks = Array.isArray(data) ? data : (data.stacks || [data]);
  const found = stacks.find((s) => s.pull_requests?.some((p) => Number(p.number ?? p) === pr));
  return found?.pull_requests.map((p) => Number(p.number ?? p)) || null;
}

// allowBusy tolerates a live worker or dirty checkout but still refuses a
// stopped Git operation, whose detached HEAD no refresh may record.
function idle(repo, st, members, { allowBusy = false } = {}) {
  const W = require('./worktree');
  let detached;
  const busy = (message, kind) => {
    if (!allowBusy) throw Object.assign(refuse(message), { stackBusy: kind });
  };
  for (const t of members) {
    const branch = W.branchFor(t);
    const wt = W.findWorktree(repo, branch) || (detached ??= W.operationWorktrees(repo)).get(branch)?.path;
    if (t.status === 'in_progress' && !require('./tasks').leaseExpired(t, Date.now())) {
      busy(`${t.id}: stack operation waits for the live worker`, 'live');
    }
    const jobs = new Map(st.events.filter((e) => e.cmd === 'spawn' && e.task === t.id)
      .map((e) => [e.detail.agent, e]));
    if (require('./processes').supervised(st, t, st.events)
      || [...jobs.values()].some((e) => !require('./spawn-session').exitedAttempt(e, st.events))) {
      busy(`${t.id}: stack operation waits for the spawned agent to exit`, 'live');
    }
    const pending = wt && W.operationInProgress(wt);
    if (pending) throw W.operationRefusal(t.id, wt, pending);
    if (wt && S.git(['status', '--porcelain'], wt)) {
      busy(`${t.id}: stack operation needs a clean worktree`, 'dirty');
    }
  }
}

function parent(st, task) {
  if (task.stack_disabled) return null;
  const deps = task.depends_on.map((id) => st.tasks.tasks.find((t) => t.id === id));
  if (deps.some((t) => !t || !['submitted', 'accepted'].includes(t.status))) return null;
  if (deps.some((t) => t.status === 'submitted' && (!t.pr || !t.branch || !t.sha || t.stack_disabled))) return null;
  if (deps.some((t) => t.status === 'submitted' && t.stack && !t.stack.linked)) return null;
  const open = deps.filter((t) => t.pr && t.branch && t.sha && !merged(st, t));
  if (!open.length) return null;
  const tip = open.find((t) => open.every((d) => chain(st, t).some((x) => x.id === d.id)));
  if (!tip || tip.stack_disabled) return null;
  if (st.tasks.tasks.some((t) => t.id !== task.id && t.stack?.parent === tip.id
    && t.status !== 'cancelled' && !merged(st, t))) return null;
  return tip;
}

// gh without the extension exits 1 and points at the official extension; its wording varies by version.
function missingExtension(r) {
  const text = error(r);
  const installHint = /\binstall\b|\bnot installed\b|\bunknown extension\b|\bavailable as an official extension\b/i.test(text);
  return r.status !== 0 && /\bstack\b/i.test(text) && /\bextension\b/i.test(text) && installHint;
}

function unavailable(r) {
  const text = error(r);
  const stacksDisabled = /\b(?:stacks?|stacked pull requests?)\s+(?:(?:are|is)\s+)?(?:disabled|not\s+(?:currently\s+)?enabled)\b/i.test(text)
    || /\b(?:disabled|not\s+(?:currently\s+)?enabled)\b[\s\S]{0,80}\b(?:stacks?|stacked pull requests?)\b/i.test(text);
  return r.status === 9 || missingExtension(r)
    || /\bunknown command\b[\s:]*["'`]?stack\b/i.test(text) || stacksDisabled;
}

function readinessMembers(st, task) {
  const members = new Map();
  const add = (candidate) => {
    if (!candidate) return;
    for (const member of chain(st, candidate)) members.set(member.id, member);
  };
  add(task);
  for (const id of task.depends_on) add(st.tasks.tasks.find((t) => t.id === id));
  return [...members.values()];
}

function remoteStacks(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.stacks)) return data.stacks;
  if (Array.isArray(data?.pull_requests)) return [data];
  if (data && typeof data === 'object' && Object.keys(data).length === 0) return [];
  throw refuse('cannot read stack membership from GitHub stacks response');
}

function stackPullRequests(stack) {
  if (!Array.isArray(stack?.pull_requests)) return [];
  return stack.pull_requests.map((pull) => Number(pull.number ?? pull));
}

function includesChain(stack, expected) {
  const actual = stackPullRequests(stack);
  return actual.some((_, index) => expected.every((number, offset) => actual[index + offset] === number));
}

function readinessUpdate(updates, id, values) {
  updates.set(id, { ...(updates.get(id) || {}), ...values });
}

function applyReadiness(ctx, snapshot, updates) {
  let changed = false;
  for (const [id, update] of updates) {
    const task = require('./tasks').getTask(snapshot.state, id);
    if (update.linked !== undefined && task.stack?.linked !== update.linked) changed = true;
    if (update.stack_disabled === true && !task.stack_disabled) changed = true;
    if (update.stack_disabled === false && task.stack_disabled) changed = true;
  }
  if (!changed) return false;
  S.mutate(ctx, 'stack readiness', (st, emit) => {
    compare(snapshot, st, 'readiness');
    for (const [id, update] of updates) {
      const task = require('./tasks').getTask(st, id);
      let touched = false;
      if (update.linked !== undefined && task.stack && task.stack.linked !== update.linked) {
        task.stack.linked = update.linked;
        touched = true;
      }
      if (update.stack_disabled === true && !task.stack_disabled) {
        task.stack_disabled = true;
        touched = true;
      } else if (update.stack_disabled === false && task.stack_disabled) {
        delete task.stack_disabled;
        touched = true;
      }
      if (touched) emit(task.id, { linked: task.stack?.linked ?? null, stack_disabled: !!task.stack_disabled });
    }
  });
  return true;
}

function refreshReadiness(ctx, taskId) {
  const st = S.loadState(ctx.stateDir);
  const T = require('./tasks');
  const task = T.getTask(st, taskId);
  if (!['todo', 'rework'].includes(T.effectiveStatus(task, Date.now()))) return false;
  const members = readinessMembers(st, task);
  const submittedDependency = task.depends_on.some((id) => T.getTask(st, id).status === 'submitted');
  const tracked = members.filter((member) => member.stack && member.pr);
  const staleLink = tracked.some((member) => !member.stack.linked || member.stack_disabled);
  // A dependent without a stack record has no chain to confirm. A flag left there by an
  // earlier outage is cleared once GitHub confirms the chain of its submitted dependency.
  const orphaned = !task.stack && !!task.stack_disabled && submittedDependency;
  if (!st.project.repo || (!orphaned && (!tracked.length || (!submittedDependency && !staleLink)))) return false;
  // Only a chain with two or more unmerged PRs can be confirmed; a merged dependency leaves nothing to check.
  const confirmable = members.some((member) => member.stack && member.pr
    && chain(st, member).filter((m) => m.pr && !merged(st, m)).length >= 2);
  if (!confirmable) return false;

  const snapshot = { ...capture(st, [task.id, ...task.depends_on]), state: structuredClone(st) };
  const result = run(ctx.cwd || st.dir, ['api', `repos/${st.project.repo}/stacks`]);
  const updates = new Map();
  if (result.status !== 0) {
    if (!unavailable(result)) {
      throw refuse(`stack availability check failed: ${error(result)}; retry the operation`);
    }
    // Only a record with a PR is disabled here; a task without a stack record dispatches on its own PR.
    for (const member of tracked) readinessUpdate(updates, member.id, { linked: false, stack_disabled: true });
    applyReadiness(ctx, snapshot, updates);
    return false;
  }

  let stacks;
  try {
    stacks = remoteStacks(JSON.parse(result.stdout));
  } catch (e) {
    if (e.lockedCommand) throw e;
    throw refuse(`cannot read GitHub stacks response: ${e.message}`);
  }
  const confirmed = new Set();
  for (const candidate of members) {
    if (!candidate.stack || !candidate.pr) continue;
    const expectedMembers = chain(st, candidate).filter((member) => member.pr && !merged(st, member));
    const expected = expectedMembers.map((member) => Number(member.pr));
    if (expected.length < 2) continue;
    if (stacks.some((stack) => includesChain(stack, expected))) {
      for (const member of expectedMembers) {
        confirmed.add(member.id);
        readinessUpdate(updates, member.id, {
          stack_disabled: false,
          ...(member.stack ? { linked: true } : {}),
        });
      }
    } else {
      // Only the candidate's own link is unconfirmed; the shorter chain below it is judged by its own pass.
      readinessUpdate(updates, candidate.id, { linked: false });
    }
  }
  if (orphaned && task.depends_on.some((id) => confirmed.has(id))) readinessUpdate(updates, task.id, { stack_disabled: false });
  applyReadiness(ctx, snapshot, updates);
  return false;
}

function prepare(repo, st, task) {
  const snapshot = capture(st, [task.id, ...task.depends_on]);
  const dep = parent(st, task);
  if (!dep) {
    if (task.depends_on.some((id) => require('./tasks').getTask(st, id).status === 'submitted')) {
      throw refuse(`${task.id}: submitted dependencies need one available stack chain`);
    }
    return null;
  }
  const extension = run(repo.root, ['stack', '--version']);
  const version = extension.stdout?.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  const supported = version && (Number(version[1]) > 0 || Number(version[2]) >= 2);
  if (extension.status !== 0 || !supported) {
    if (extension.status === 0 && !version) throw refuse('cannot read gh-stack version; v0.2.0 or newer is required');
    if (extension.status !== 0 && !unavailable(extension)) throw refuse(`gh stack is unavailable: ${error(extension)}`);
    if (dep.status !== 'accepted') throw refuse(`${task.id}: stacks unavailable; wait for ${dep.id} to be accepted`);
    return { disabled: true, snapshot };
  }
  // The endpoint is read-only and also checks the repository's stacks setting.
  const capability = run(repo.root, ['api', `repos/${st.project.repo}/stacks?per_page=1`]);
  if (capability.status !== 0) {
    if (!unavailable(capability)) throw refuse(`stack availability check failed: ${error(capability)}; retry the operation`);
    if (dep.status !== 'accepted') throw refuse(`${task.id}: stacks unavailable; wait for ${dep.id} to be accepted`);
    return { disabled: true, snapshot };
  }
  const view = run(repo.root, ['pr', 'view', String(dep.pr), '-R', st.project.repo,
    '--json', 'state,headRefOid,headRefName,isCrossRepository,autoMergeRequest']);
  if (view.status !== 0) throw refuse(`cannot read dependency PR: ${error(view)}`);
  const pr = JSON.parse(view.stdout);
  if (pr.isCrossRepository || pr.autoMergeRequest) throw refuse('stacks require same-repository PRs without auto-merge');
  if (pr.state === 'MERGED') return null;
  if (pr.state !== 'OPEN' || !sameSha(pr.headRefOid, dep.sha) || pr.headRefName !== dep.branch) {
    throw refuse(`${dep.id}: dependency PR moved or closed; submit its current head before dispatch`);
  }
  const base = require('./worktree').resolveBase(repo, dep.branch);
  if (!sameSha(base, pr.headRefOid)) throw refuse(`${dep.id}: fetched branch differs from dependency PR head`);
  return { base, snapshot, stack: { parent: dep.id, base: dep.branch, parent_sha: base,
    repo: st.project.repo, linked: false, synced_base: require('./worktree').resolveBase(repo, st.project.base) } };
}

async function retireBeforeDispatch(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  const task = require('./tasks').getTask(st, id);
  if (!task.stack) return;
  const inputs = linkInputs(st, id);
  const parents = chain(st, task).slice(0, -1);
  const root = require('./worktree').needRepo(ctx).root;
  for (const parent of parents) {
    if (merged(st, parent)) continue;
    const r = await runAsync(ctx, root, ['pr', 'view', String(parent.pr), '-R', st.project.repo,
      '--json', 'state,headRefOid,headRefName,baseRefName,isCrossRepository']);
    if (r.status !== 0) throw refuse(`cannot recheck stack parent: ${error(r)}`);
    const pr = JSON.parse(r.stdout);
    if (pr.state !== 'MERGED') return;
    if (pr.isCrossRepository || !sameSha(pr.headRefOid, parent.sha) || pr.headRefName !== parent.branch
      || ![parent.stack?.base || st.project.base, st.project.base].includes(pr.baseRefName)) {
      throw refuse(`${parent.id}: merged stack parent differs from its recorded head, branch, repository or base`);
    }
  }
  // A remote merge can precede its local gate receipt. It authorizes retirement,
  // not merge evidence; keep the observation bound to the inputs it checked.
  const result = await link({ ...ctx, pos: [id], retireLinked: true, mergedParents: parents.map((t) => t.id), parentInputs: inputs });
  if (result.data.stack && result.data.stack.base !== st.project.base) {
    throw refuse(`${id}: completed dependency still targets ${result.data.stack.base}; finish its active worker before dispatch`);
  }
  return true;
}

// A conflict receipt permits worker dispatch on the unchanged branch. It never
// permits a gate at that head, and stops counting when either branch advances.
function parentConflict(st, task, head) {
  if (!task.stack) return false;
  const dep = require('./tasks').getTask(st, task.stack.parent);
  const event = st.events.findLast((e) => e.task === task.id && e.cmd === 'stack sync');
  return event?.detail.failure === 'conflict' && sameSha(event.detail.parent_sha, dep.sha)
    && sameSha(event.detail.head, head);
}

function parentDeferred(st, task) {
  if (!task.stack) return false;
  const dep = require('./tasks').getTask(st, task.stack.parent);
  return st.events.some((e) => e.task === task.id && e.cmd === 'stack sync deferred'
    && ['dirty', 'live'].includes(e.detail.failure) && sameSha(e.detail.parent_sha, dep.sha));
}

function deferParent(ctx, snapshot, task, dep, failure, message) {
  const reason = `${message}; parent ${dep.id} submitted ${dep.sha}. Continue the existing work and include that parent head before resubmitting.`;
  S.mutate(ctx, 'stack sync deferred', (fresh, emit) => {
    compare(snapshot, fresh, 'sync');
    const child = require('./tasks').getTask(fresh, task.id);
    const reworked = failure === 'dirty' && ['submitted', 'accepted'].includes(child.status);
    if (reworked) sendBack(fresh, child, reason, ctx.agent, emit);
    if (parentDeferred(fresh, child)) return;
    // sendBack already wrote the reason to the notes and the brief.
    if (!reworked) {
      child.notes.push({ agent: ctx.agent, at: nowIso(), text: reason });
      appendReworkNote(fresh.dir, task.id, reason);
    }
    emit(task.id, { parent: dep.id, parent_sha: dep.sha, failure, reason });
  });
  return { deferred: true };
}

function parentRefreshNeeded(st, task) {
  if (!task.stack || merged(st, task) || task.status === 'cancelled') return false;
  const T = require('./tasks');
  const dep = T.getTask(st, task.stack.parent);
  return ['submitted', 'accepted'].includes(dep.status) && !!dep.sha && !!dep.branch
    && !merged(st, dep) && !T.retirementHolder(st, dep) && !sameSha(dep.sha, task.stack.parent_sha);
}

async function refreshParent(ctx, id) {
  const W = require('./worktree');
  const T = require('./tasks');
  let st = S.loadState(ctx.stateDir);
  let task = T.getTask(st, id);
  // Existing lifecycle checks own merged, retiring and blocked parents.
  if (!parentRefreshNeeded(st, task)) return;
  // Retirement must run before a fetch: GitHub can delete a merged parent's branch.
  if (await retireBeforeDispatch(ctx, id) === true) return { applied: true };
  st = S.loadState(ctx.stateDir);
  task = T.getTask(st, id);
  if (!parentRefreshNeeded(st, task)) return;
  if (task.stack.repo !== st.project.repo) throw refuse('stack repository differs from project repo');
  const dep = T.getTask(st, task.stack.parent);
  const repo = W.needRepo(ctx);
  const branch = W.branchFor(task);
  const C = require('./gates/common');
  const gitCtx = { stateDir: ctx.stateDir, signal: ctx.gateSignal };
  const git = async (cwd, args, cleanup = false) => {
    const r = await C.git(gitCtx, cwd, args, { timeout: TIMEOUT, env: ghEnv(), cleanup });
    if (!r.ok) throw refuse(`stack parent refresh: git ${args[0]} failed: ${C.errText(r)}`);
    return r.stdout.trim();
  };
  const result = await C.underWorktreeLock(gitCtx, repo.root, async () => {
    ctx.automationSignal?.throwIfAborted();
    const current = S.loadState(ctx.stateDir);
    const snapshot = capture(current, [id]);
    compare(capture(st, [id]), current, 'sync');
    let head = S.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], repo.root);
    // A branch that already holds the parent head needs no merge, so a busy
    // checkout does not defer it; recording parent_sha below ends the cycle.
    const holds = head && S.git(['merge-base', '--is-ancestor', dep.sha, head], repo.root) !== null;
    try { idle(repo, current, [task], { allowBusy: !!holds }); }
    catch (e) {
      if (!e.stackBusy) throw e;
      return deferParent(ctx, snapshot, task, dep, e.stackBusy, e.message);
    }
    if (!head) {
      const ref = `refs/remotes/origin/${branch}`;
      const fetched = await C.git(gitCtx, repo.root,
        ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:${ref}`],
        { timeout: TIMEOUT, env: ghEnv() });
      if (!fetched.ok && !String(fetched.stderr).includes(`couldn't find remote ref refs/heads/${branch}`)) {
        throw refuse(`stack parent refresh: child fetch failed: ${C.errText(fetched)}`);
      }
      head = fetched.ok ? S.git(['rev-parse', `${ref}^{commit}`], repo.root) : task.sha;
      if (head) await git(repo.root, ['branch', branch, head]);
    }
    if (!head) return; // Preparation creates a missing child from the current parent.
    if (parentConflict(current, task, head)) return { conflict: true, applied: true };
    const parentHead = await W.resolveBaseAsync(repo, dep.branch, ctx.gateSignal);
    if (!sameSha(parentHead, dep.sha)) throw refuse(`${dep.id}: fetched branch differs from its submitted head`);
    const wt = W.findWorktree(repo, branch);
    let next = head;
    let conflict = null;
    const defer = (reason, failure) => {
      S.mutate(ctx, 'stack sync deferred', (fresh, emit) => {
        compare(snapshot, fresh, 'sync');
        const child = T.getTask(fresh, id);
        if (child.notes.some((n) => n.text === reason)) return;
        child.notes.push({ agent: ctx.agent, at: nowIso(), text: reason });
        appendReworkNote(fresh.dir, id, reason);
        emit(id, { reason, failure, head, parent_sha: parentHead });
      });
      return Object.assign(refuse(reason), { noted: true, needsRestack: failure === 'rewrite', stopRefresh: failure === 'lease' });
    };
    const publish = async (cwd, lease = false) => {
      compare(snapshot, S.loadState(ctx.stateDir), 'sync');
      try { idle(repo, S.loadState(ctx.stateDir), [task]); }
      catch (e) {
        if (!e.stackBusy) throw e;
        deferParent(ctx, snapshot, task, dep, e.stackBusy, e.message);
        return false;
      }
      if (S.git(['rev-parse', `refs/heads/${branch}`], repo.root) !== head) throw stale(id, 'sync');
      // Publish before moving the local branch, so a failed push is retryable.
      let pushed = await C.git(gitCtx, cwd, ['push', 'origin', `${next}:refs/heads/${branch}`],
        { timeout: TIMEOUT, env: ghEnv() });
      if (!pushed.ok && lease) {
        // The exact lease preserves remote work published after our snapshot.
        pushed = await C.git(gitCtx, cwd,
          ['push', `--force-with-lease=refs/heads/${branch}:${head}`, 'origin', `${next}:refs/heads/${branch}`],
          { timeout: TIMEOUT, env: ghEnv() });
        if (!pushed.ok) throw defer(`${id}: guarded lease expected ${head} on ${branch} and could not publish ${parentHead}: ${C.errText(pushed)}. Preserve remote work and have the orchestrator refresh the branch before retrying.`, 'lease');
      }
      if (!pushed.ok) throw refuse(`stack parent refresh: git push failed: ${C.errText(pushed)}`);
      if (wt) await git(wt, ['reset', '--keep', next]);
      else await git(repo.root, ['update-ref', `refs/heads/${branch}`, next, head]);
      return true;
    };
    const parentIncluded = S.git(['merge-base', '--is-ancestor', parentHead, head], repo.root) !== null;
    const rewritten = S.git(['merge-base', '--is-ancestor', task.stack.parent_sha, parentHead], repo.root) === null;
    const untouched = sameSha(head, task.stack.parent_sha)
      || S.git(['merge-base', '--is-ancestor', head, parentHead], repo.root) !== null;
    if (rewritten && !untouched && (!parentIncluded
      || S.git(['merge-base', '--is-ancestor', task.stack.parent_sha, head], repo.root) !== null)) {
      throw defer(`${id}: ${dep.id} rewrote ${task.stack.parent_sha} to ${parentHead}; the child has its own commits. Restack them onto ${parentHead} without merging the old parent history. Use stack sync ${id} while idle for a linked stack; otherwise have the orchestrator link its recorded PR before syncing, or arrange a restack if it has no PR. Then submit the restacked head.`, 'rewrite');
    }
    if (!parentIncluded) {
      if (untouched) {
        // Joining rewritten parent histories would restore commits it dropped.
        next = parentHead;
        if (!await publish(repo.root, rewritten && head === task.stack.parent_sha)) return { deferred: true };
      } else {
        const tmp = require('./gate-tmp').root(current.project, ctx.env);
        fs.mkdirSync(tmp, { recursive: true });
        const scratch = fs.mkdtempSync(path.join(tmp, 'stack-parent-'));
        const dir = path.join(scratch, 'wt');
        try {
          await git(repo.root, ['worktree', 'add', '--detach', dir, head]);
          const merge = await C.git(gitCtx, dir, ['merge', '--no-ff', '--no-edit', '-m',
            `Merge ${dep.id}'s resubmitted head into ${id}`, parentHead], { timeout: TIMEOUT, env: ghEnv() });
          if (!merge.ok) {
            const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
            if (!files.length) throw refuse(`stack parent refresh merge failed: ${C.errText(merge)}`);
            conflict = `Merge ${dep.id}'s resubmitted head ${parentHead} into ${id}; resolve conflicts in: ${files.join(', ')}. Preserve the child commits, push and resubmit.`;
            await git(dir, ['merge', '--abort'], true);
          } else {
            next = await git(dir, ['rev-parse', 'HEAD']);
          }
          if (!conflict && !await publish(dir)) return { deferred: true };
        } finally {
          await git(repo.root, ['worktree', 'remove', '--force', dir], true);
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
    const submittedHasParent = task.sha
      && S.git(['merge-base', '--is-ancestor', parentHead, task.sha], repo.root) !== null;
    S.mutate(ctx, 'stack sync', (fresh, emit) => {
      compare(snapshot, fresh, 'sync');
      const child = T.getTask(fresh, id);
      if (conflict) {
        if (['submitted', 'accepted'].includes(child.status)) sendBack(fresh, child, conflict, ctx.agent, emit);
        else {
          child.notes.push({ agent: ctx.agent, at: nowIso(), text: `rework: ${conflict}` });
          // An absent brief stays absent, as it does in ordinary stack rework.
          appendReworkNote(fresh.dir, id, conflict);
        }
      } else {
        child.stack.parent_sha = parentHead;
        if (child.worktree) child.worktree.head = next;
        if (child.sha && ['submitted', 'accepted'].includes(child.status) && !submittedHasParent) {
          sendBack(fresh, child, `stack sync merged ${dep.id} at ${parentHead}; submit ${next} and rerun gates`, ctx.agent, emit);
        }
      }
      emit(id, { ok: !conflict, parent: dep.id, parent_sha: parentHead, head: next,
        failure: conflict ? 'conflict' : null, reason: conflict });
    });
    return { conflict: !!conflict, applied: true };
  });
  if (result?.ok === false) throw refuse(result.summary);
  return result;
}

async function replacementPr(st, task, pr, root, ctx) {
  const fields = 'number,state,headRefOid,headRefName,baseRefName,isCrossRepository,autoMergeRequest';
  const list = await runAsync(ctx, root, ['pr', 'list', '-R', st.project.repo, '--head', task.branch,
    '--base', st.project.base, '--state', 'open', '--json', fields]);
  if (list.status !== 0) throw refuse(`cannot find replacement dependent PR: ${error(list)}`);
  const candidates = JSON.parse(list.stdout);
  const valid = (candidate) => candidate.state === 'OPEN' && !candidate.isCrossRepository && !candidate.autoMergeRequest
    && sameSha(candidate.headRefOid, task.sha) && candidate.headRefName === task.branch && candidate.baseRefName === st.project.base;
  if (candidates.length) {
    if (candidates.length !== 1 || !valid(candidates[0])) throw refuse(`${task.id}: replacement PR differs from its submitted head or target base`);
    return Number(candidates[0].number);
  }
  const created = await runAsync(ctx, root, ['pr', 'create', '-R', st.project.repo, '--head', task.branch,
    '--base', st.project.base, '--title', pr.title || task.title, '--body', pr.body || '']);
  if (created.status !== 0) throw refuse(`cannot replace closed dependent PR: ${error(created)}`);
  const number = Number(created.stdout.trim().match(/\/pull\/(\d+)\/?$/)?.[1]);
  if (!Number.isSafeInteger(number) || number < 1) throw refuse('cannot read replacement dependent PR number');
  const view = await runAsync(ctx, root, ['pr', 'view', String(number), '-R', st.project.repo, '--json', fields]);
  if (view.status !== 0) throw refuse(`cannot verify replacement dependent PR: ${error(view)}`);
  if (!valid(JSON.parse(view.stdout))) throw refuse(`${task.id}: replacement PR differs from its submitted head or target base`);
  return number;
}

async function linkTask(st, task, root, emit, retireLinked = false, ctx = {}) {
  if (!task.stack || task.status === 'cancelled' || merged(st, task)) return;
  if (task.pr && !['submitted', 'accepted'].includes(task.status) && !(retireLinked && task.status === 'rework')) return;
  const lineage = chain(st, task);
  const lowerMerged = lineage.slice(0, -1).every((t) => merged(st, t) || ctx.mergedParents?.includes(t.id));
  const retiring = lowerMerged && (!task.pr || membersOf(st, task).every((t) => t.id === task.id
    || merged(st, t) || ctx.mergedParents?.includes(t.id)));
  const members = lowerMerged ? [task] : lineage.filter((t) => !merged(st, t));
  if (members.some((t) => t.stack && t.stack.repo !== st.project.repo)) throw refuse('stack repository differs from project repo');
  if (!lowerMerged && (task.stack.linked || !task.pr || !['submitted', 'accepted'].includes(task.status))) return;
  if (retireLinked && !lowerMerged) return;
  if (members.length < 2 && !lowerMerged) return;
  const complete = () => {
    const parent = task.stack.parent;
    delete task.stack;
    delete task.stack_disabled;
    emit(task.id, { parent, base: st.project.base, pr: task.pr || null }, 'stack complete');
  };
  if (retiring && !task.pr) {
    complete();
    return;
  }
  for (const t of members) {
    const r = await runAsync(ctx, root, ['pr', 'view', String(t.pr), '-R', st.project.repo,
      '--json', 'state,headRefOid,headRefName,baseRefName,isCrossRepository,autoMergeRequest,title,body']);
    if (r.status !== 0) throw refuse(`cannot read stack PR: ${error(r)}`);
    const pr = JSON.parse(r.stdout);
    const expectedBase = t.stack?.base || st.project.base;
    const validBase = pr.baseRefName === expectedBase || (lowerMerged && pr.baseRefName === st.project.base);
    const closedDependent = lowerMerged && pr.state === 'CLOSED' && pr.baseRefName === task.stack.base
      && task.stack.base !== st.project.base;
    if (pr.state !== 'OPEN' && !closedDependent || pr.isCrossRepository || pr.autoMergeRequest || !sameSha(pr.headRefOid, t.sha)
      || pr.headRefName !== t.branch || !validBase) {
      throw refuse(`${t.id}: stack PR must target ${t.stack?.base || st.project.base}, match its submitted head, use the same repository and have auto-merge disabled`);
    }
    if (lowerMerged) {
      const previousBase = task.stack.base;
      const previousPr = task.pr;
      if (closedDependent) {
        task.pr = await replacementPr(st, task, pr, root, ctx);
        for (const member of membersOf(st, task)) {
          if (member.stack && chain(st, member).some((lower) => lower.id === task.id)) member.stack.linked = false;
        }
      } else if (pr.baseRefName !== st.project.base) {
        const edit = await runAsync(ctx, root, ['pr', 'edit', String(t.pr), '-R', st.project.repo, '--base', st.project.base]);
        if (edit.status !== 0) throw refuse(`cannot retarget dependent PR: ${error(edit)}`);
      }
      if (retiring) complete();
      else {
        task.stack.base = st.project.base;
        if (previousPr !== task.pr) task.stack_disabled = true;
        if (previousBase !== task.stack.base || previousPr !== task.pr) {
          emit(task.id, { parent: task.stack.parent, previous_base: previousBase, base: st.project.base, pr: task.pr }, 'stack base');
        }
      }
      return;
    }
  }
  const r = await runAsync(ctx, root, ['stack', 'link', ...members.map((t) => String(t.pr)), '--base', st.project.base]);
  if (r.status !== 0) {
    if (unavailable(r)) {
      // Existing dependent commits must land below this PR before retargeting.
      task.stack_disabled = true;
      task.stack.linked = false;
      emit(task.id, { reason: 'stacks unavailable; merge lower tasks separately, then sync and retarget this PR' }, 'stack unavailable');
      return;
    }
    throw refuse(`gh stack link failed: ${error(r)}`);
  }
  for (const t of members) {
    delete t.stack_disabled;
    if (t.stack) t.stack.linked = true;
  }
  emit(task.id, { parent: task.stack.parent, prs: members.map((t) => t.pr) }, 'stack link');
}

async function link(ctx) {
  const root = require('./worktree').needRepo(ctx).root;
  const snapshot = snapshotOf(ctx);
  const inputs = linkInputs(snapshot.state, snapshot.task.id);
  if (ctx.parentInputs && !isDeepStrictEqual(inputs, ctx.parentInputs)) throw stale(snapshot.task.id, 'parent recheck');
  const desired = structuredClone(snapshot.state);
  const events = [];
  await linkTask(desired, require('./tasks').getTask(desired, snapshot.task.id), root,
    (id, detail, name) => events.push({ id, detail, name }), ctx.retireLinked === true, ctx);
  const task = S.mutate(ctx, 'stack link', (st, emit) => {
    if (!isDeepStrictEqual(linkInputs(st, snapshot.task.id), inputs)) throw stale(snapshot.task.id, 'link');
    const t = require('./tasks').getTask(st, ctx.pos[0]);
    for (const previous of snapshot.scope.members) {
      const member = require('./tasks').getTask(st, previous.id);
      const next = require('./tasks').getTask(desired, previous.id);
      if (member.pr !== next.pr) {
        const previousPr = member.pr;
        member.revision = require('./tasks').nextRevision(st, member);
        if (member.status === 'accepted') member.status = 'submitted';
        emit(member.id, { previous_pr: previousPr, pr: next.pr, sha: member.sha, revision: member.revision }, 'stack pr replaced');
      }
      for (const field of ['stack', 'stack_disabled', 'pr']) {
        if (Object.hasOwn(next, field)) member[field] = next[field];
        else delete member[field];
      }
    }
    for (const e of events) {
      if (e.name === 'stack complete' || e.name === 'stack base') {
        const member = require('./tasks').getTask(st, e.id);
        const text = `Stack parent ${e.detail.parent} merged. Merge ${st.project.base} into the task branch before continuing work or opening its PR; preserve the child commits and resolve any conflicts.`;
        member.notes.push({ agent: ctx.agent, at: nowIso(), text });
      }
      emit(e.id, e.detail, e.name);
    }
    return t;
  });
  return { data: task, text: `${task.id}: ${task.stack ? `stack ${task.stack.linked ? 'linked' : 'unavailable or pending'}` : 'ordinary PR on the project base'}` };
}

const linkable = (t) => !!t.stack && !t.stack.linked && !t.stack_disabled && !!t.pr && t.status === 'submitted';

// A change to what the link read (linkInputs) during its GitHub calls
// refuses it. A refused link is retried at once from a fresh snapshot; each
// attempt re-reads state, so no sleep is needed. After LINK_ATTEMPTS the next
// observer pass is the fallback.
const LINK_ATTEMPTS = 5;

async function linkFresh(ctx, t) {
  for (let attempt = 1; ; attempt++) {
    try { return await link({ ...ctx, pos: [t.id] }); }
    catch (e) {
      if (!e.staleState || attempt >= LINK_ATTEMPTS || ctx.automationSignal?.aborted) throw e;
      const now = require('./tasks').getTask(S.loadState(ctx.stateDir), t.id);
      // Whatever changed may have linked, disabled or replaced the submission.
      if (!linkable(now) || now.sha !== t.sha) return null;
    }
  }
}

async function observe(ctx) {
  const st = S.loadState(ctx.stateDir);
  for (const t of st.tasks.tasks) {
    if (ctx.automationSignal?.aborted) return;
    const retiring = t.stack && t.status !== 'cancelled' && !merged(st, t)
      && completed(st, t) && (!t.pr || retirable(st, t) || t.stack.base !== st.project.base);
    if (!retiring && !linkable(t)) continue;
    try {
      if (retiring) await link({ ...ctx, pos: [t.id], retireLinked: true });
      else await linkFresh(ctx, t);
    }
    catch (e) {
      if (e.lockedCommand) throw e;
      // An interrupted link is retried by the next observer pass.
      if (ctx.automationSignal?.aborted) return;
      S.mutate(ctx, 'stack link failed', (current, emit) => {
        const task = require('./tasks').getTask(current, t.id);
        if (task.sha !== t.sha || task.status !== t.status) return;
        if (!current.events.some((x) => x.cmd === 'stack link failed' && x.task === t.id && x.detail.reason === e.message)) {
          emit(t.id, { reason: e.message });
        }
      });
    }
  }
}

function sendBack(st, task, reason, agent, emit) {
  if (task.status === 'cancelled' || merged(st, task)) return;
  // Refresh retries must retain the rejected review context until resubmission.
  const pendingRework = task.status === 'rework' || task.claim?.from === 'rework';
  const previousRevision = pendingRework
    ? st.events.findLast(e => e.cmd === 'rework' && e.task === task.id).detail.previous_revision
    : task.revision;
  task.status = 'rework';
  task.claim = null;
  task.revision = require('./tasks').nextRevision(st, task);
  task.notes.push({ agent, at: nowIso(), text: `rework: ${reason}` });
  appendReworkNote(st.dir, task.id, reason);
  emit(task.id, { reason, sha: task.sha, previous_revision: previousRevision, revision: task.revision }, 'rework');
}

function appendReworkNote(dir, id, reason) {
  const file = require('./tasks').briefPath(dir, id);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.appendFileSync(fd, `\n## Rework notes\n\n- ${reason}\n`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function sync(ctx) {
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const snapshot = snapshotOf(ctx);
  const { task, state, scope } = snapshot;
  if (retirable(state, task)) {
    idle(repo, state, scope.members);
    return await link({ ...ctx, retireLinked: true });
  }
  if (!task.stack?.linked) throw refuse(`${task.id}: no linked stack to sync`);
  if (task.stack.repo !== state.project.repo) throw refuse('stack repository differs from project repo');
  const { members, project } = scope;
  idle(repo, state, members);
  const cwd = W.findWorktree(repo, W.branchFor(task));
  if (!cwd) throw refuse(`${task.id}: prepare its worktree before stack sync`);
  W.prune(repo);
  const before = new Map(members.map((t) => [t.id, S.git(['rev-parse', t.branch], repo.root)]));
  // Network commands can outlast the lock lease, so only snapshots and application hold it.
  const remote = await runAsync(ctx, cwd, ['api', `repos/${project.repo}/stacks?pull_request=${task.pr}`]);
  if (remote.status !== 0 && !unavailable(remote)) throw refuse(`cannot verify stack before sync: ${error(remote)}`);
  if (remote.status === 0) {
    const prs = numbers(JSON.parse(remote.stdout), task.pr);
    if (!prs || prs.some((pr) => !members.some((t) => t.pr === pr))) {
      throw refuse('remote stack has untracked PRs; record its tasks before sync');
    }
  }
  // link has no local tracking; checkout imports the remote stack before sync.
  let r = remote.status === 0 ? await runAsync(ctx, cwd, ['stack', 'checkout', String(task.pr), '--print-path']) : remote;
  // Once gh stack sync has run, its outcome is recorded even when it was stopped.
  if (r.status === 0) r = await runAsync(ctx, cwd, ['stack', 'sync']);
  const failure = syncFailure(r);
  const base = r.status === 0 ? baseTip(repo, project.base) : null;
  const heads = new Map(members.map((t) => [t.id, S.git(['rev-parse', t.branch], repo.root)]));
  const result = S.mutate(ctx, 'stack sync', (current, emit) => {
    compare(snapshot, current, 'sync');
    const rework = [];
    for (const previous of members) {
      const t = require('./tasks').getTask(current, previous.id);
      const head = heads.get(t.id);
      if (head && before.get(t.id) && head !== before.get(t.id)) {
        sendBack(current, t, `stack sync moved branch to ${head}; submit it and rerun gates`, ctx.agent, emit);
        if (t.status === 'rework') rework.push(t.id);
      } else if (failure?.failure === 'conflict') {
        sendBack(current, t, `gh stack sync aborted: ${failure.reason}`, ctx.agent, emit);
        if (t.status === 'rework') rework.push(t.id);
      }
      if (!failure) {
        if (t.stack) {
          const dep = require('./tasks').getTask(current, t.stack.parent);
          t.stack.synced_base = base || t.stack.synced_base;
          t.stack.base = merged(current, dep) || t.stack.base === current.project.base ? current.project.base : dep.branch;
          t.stack.parent_sha = heads.get(dep.id) || dep.sha;
        }
      }
      emit(t.id, { ok: !failure, head, reason: failure?.reason || null, failure: failure?.failure || null });
    }
    return { task: task.id, ok: !failure, rework };
  });
  const outcome = result.ok ? 'ok' : result.rework.length ? 'aborted; changed or conflicting tasks sent to rework' : 'aborted; retry on the next pass';
  return { data: result, code: result.ok ? 0 : 1, text: `${result.task}: stack sync ${outcome}` };
}

async function unstack(ctx) {
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const snapshot = snapshotOf(ctx);
  const { state: st, task } = snapshot;
  const members = membersOf(st, task);
  if (retirable(st, task)) {
    idle(repo, st, members);
    return await link({ ...ctx, retireLinked: true });
  }
  if (!task.stack?.linked || task.stack.repo !== st.project.repo) throw refuse('task needs a linked stack in this project repository');
  idle(repo, st, members);
  const cwd = W.findWorktree(repo, W.branchFor(task));
  if (!cwd) throw refuse('prepare the task worktree before unstacking');
  let r = await runAsync(ctx, cwd, ['stack', 'checkout', String(task.pr), '--print-path']);
  if (r.status === 0) r = await runAsync(ctx, cwd, ['stack', 'unstack']);
  if (r.status !== 0 && !unavailable(r)) throw refuse(`gh stack unstack failed: ${error(r)}`);
  if (r.status === 0) {
    for (const t of members.filter((t) => t.pr)) {
      const view = await runAsync(ctx, cwd, ['api', `repos/${st.project.repo}/stacks?pull_request=${t.pr}`]);
      if (view.status !== 0) throw refuse(`cannot confirm unstack: ${error(view)}`);
      const data = JSON.parse(view.stdout);
      const stacks = Array.isArray(data) ? data : data.stacks;
      if (!Array.isArray(stacks) || stacks.length) throw refuse(`PR #${t.pr} remains stacked; queued or auto-merge PRs cannot be unstacked`);
    }
  }
  S.mutate(ctx, 'stack unstack', (current, emit) => {
    compare(snapshot, current, 'unstack');
    for (const old of members) {
      const t = require('./tasks').getTask(current, old.id);
      t.stack_disabled = true;
      if (t.stack) t.stack.linked = false;
      emit(t.id, { reason: 'merge lower tasks individually before retargeting upper PRs' });
    }
  });
  return { data: { tasks: members.map((t) => t.id) }, text: 'stack disabled; merge lower tasks individually before upper tasks' };
}

async function refresh(ctx, deferred = new Set()) {
  const st = S.loadState(ctx.stateDir);
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const done = new Set();
  // A drained wait finishes the step in flight, then starts no further stack
  // work and records no deferral for it; the next refresh retries.
  const stopping = () => ctx.automationSignal?.aborted;
  for (const task of st.tasks.tasks) {
    if (stopping()) return;
    if (!task.stack || merged(st, task) || task.status === 'cancelled') continue;
    const dep = require('./tasks').getTask(st, task.stack.parent);
    if (!merged(st, dep) && !sameSha(dep.sha, task.stack.parent_sha)) {
      try {
        const refreshed = await refreshParent(ctx, task.id);
        if (refreshed?.applied || refreshed?.deferred) continue;
      }
      catch (e) {
        if (stopping()) return;
        if (!e.noted) S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: e.message }));
        if (e.stopRefresh) continue;
      }
    }
    const bottom = chain(st, task)[0].id;
    if (done.has(bottom)) continue;
    if (chain(st, task).some((member) => deferred.has(member.id))) {
      done.add(bottom);
      S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: 'generated conflict classification or repair is pending' }));
      continue;
    }
    if (completed(st, task)) {
      try { await link({ ...ctx, pos: [task.id], retireLinked: true }); }
      catch (e) {
        if (stopping()) return;
        S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: e.message }));
      }
      continue;
    }
    if (!task.stack.linked) continue;
    let base;
    try { base = await W.resolveBaseAsync(repo, st.project.base, ctx.gateSignal); }
    catch (e) {
      if (stopping()) return;
      throw e;
    }
    const expectedBase = merged(st, dep) || task.stack.base === st.project.base ? st.project.base : dep.branch;
    const depHead = S.git(['rev-parse', `refs/heads/${dep.branch}`], repo.root) || dep.sha;
    if (base === task.stack.synced_base && sameSha(depHead, task.stack.parent_sha) && task.stack.base === expectedBase) continue;
    done.add(bottom);
    try { await sync({ ...ctx, pos: [task.id] }); }
    catch (e) {
      if (stopping()) return;
      S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: e.message }));
    }
  }
}

function webhook(ctx) {
  let payload;
  try { payload = JSON.parse(ctx.pos[0] === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, ctx.pos[0]), 'utf8')); }
  catch (e) { throw usage(`cannot read pull_request webhook JSON: ${e.message}`); }
  const pr = payload.pull_request;
  if (!pr || !Number.isInteger(pr.number) || !payload.repository?.full_name) throw usage('expected a pull_request webhook payload');
  const metadata = Object.hasOwn(pr, 'stack') ? pr.stack : payload.stack ?? null;
  if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw usage('webhook stack must be an object or null');
  const task = S.mutate(ctx, 'stack webhook', (st, emit) => {
    if (payload.repository.full_name !== st.project.repo) throw refuse('webhook repository differs from project repo');
    const t = st.tasks.tasks.find((x) => x.pr === pr.number);
    if (!t) throw refuse(`no task for PR #${pr.number}`);
    t.github_stack = metadata;
    emit(t.id, { stack: t.github_stack, action: payload.action || null });
    return t;
  });
  return { data: task, text: `${task.id}: GitHub stack metadata updated` };
}

module.exports = { capture, unchanged, compare, parent, prepare, chain, merged, completed, effectiveStack, targetBase, numbers, run, error, unavailable, refreshReadiness, retireBeforeDispatch, parentRefreshNeeded, refreshParent, parentConflict, parentDeferred, link, linkTask, observe, sync, refresh, unstack, webhook, sendBack };
