'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');
const { isDeepStrictEqual, stripVTControlCharacters } = require('node:util');
const S = require('./state');
const { refuse, usage, nowIso, readStdin, shaMatch: sameSha } = require('./util');

// Stack commands can fetch and push; unattended calls have a bounded lifetime.
const TIMEOUT = 60000;
const RESERVATION = ['automation', 'automation queued', 'automation reconcile', 'gates prioritize'];
// Hook traffic and spawn startup receipts land while a worker runs, including
// during a merge's head checks. They change no task state a stack publishes.
const BOOKKEEPING = (e) => e.cmd.startsWith('hook ') || ['startup', 'spawn session'].includes(e.cmd);
// A stop receipt and the orchestrator notice it generates are appended in one batch,
// so the notice is the event right after its receipt. Ordinary messages are not.
const STOP_NOTICE = (prev, e) => e.cmd === 'msg' && prev?.cmd === 'hook stop' && prev.task === e.task && prev.agent === e.agent;

function run(root, args) {
  const { shellQuote } = require('./gates/common');
  const editor = `${shellQuote(process.execPath)} -e "process.exit(1)"`;
  const r = cp.spawnSync('gh', args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT,
    detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: editor, GIT_SEQUENCE_EDITOR: editor } });
  if (r.error?.code === 'ETIMEDOUT' && process.platform !== 'win32' && r.pid) {
    try { process.kill(-r.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  return r;
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
  // Reservation and priority receipts change no task state. A reaction queued
  // behind a merge, or a request to move one, must not invalidate the merge's
  // stack head checks.
  return { project: st.project, members: st.tasks.tasks.filter((t) => keep.has(t.id)),
    events: st.events.filter((e, i) => keep.has(e.task) && !RESERVATION.includes(e.cmd) && !BOOKKEEPING(e) && !STOP_NOTICE(st.events[i - 1], e)) };
}

function capture(st, ids) {
  return { ids: [...ids], scope: structuredClone(scopeOf(st, ids)) };
}

function unchanged(snapshot, current) {
  return isDeepStrictEqual(scopeOf(current, snapshot.ids), snapshot.scope);
}

function compare(snapshot, current, operation) {
  if (!unchanged(snapshot, current)) {
    throw refuse(`${snapshot.ids[0]}: state changed during stack ${operation}; no stack state was applied; inspect the PRs and branches before retrying`);
  }
}

function snapshotOf(ctx) {
  return S.withLock(ctx.stateDir, () => {
    const state = S.loadState(ctx.stateDir);
    const task = require('./tasks').getTask(state, ctx.pos[0]);
    return { state, task, ...capture(state, [task.id]) };
  });
}

function targetBase(st, task) {
  if (task.stack_disabled && task.stack && chain(st, task).slice(0, -1).every((t) => merged(st, t))) return st.project.base;
  return task.stack?.base || st.project.base;
}

function numbers(data, pr) {
  const stacks = Array.isArray(data) ? data : (data.stacks || [data]);
  const found = stacks.find((s) => s.pull_requests?.some((p) => Number(p.number ?? p) === pr));
  return found?.pull_requests.map((p) => Number(p.number ?? p)) || null;
}

function idle(repo, st, members) {
  const W = require('./worktree');
  for (const t of members) {
    const wt = W.findWorktree(repo, W.branchFor(t));
    if (t.status === 'in_progress' && !require('./tasks').leaseExpired(t, Date.now())) {
      throw refuse(`${t.id}: stack operation waits for the live worker`);
    }
    const jobs = new Map(st.events.filter((e) => e.cmd === 'spawn' && e.task === t.id)
      .map((e) => [e.detail.agent, e]));
    if (require('./processes').supervised(st, t, st.events)
      || [...jobs.values()].some((e) => !require('./spawn-session').exitedAttempt(e, st.events))) {
      throw refuse(`${t.id}: stack operation waits for the spawned agent to exit`);
    }
    if (wt && S.git(['status', '--porcelain'], wt)) throw refuse(`${t.id}: stack operation needs a clean worktree`);
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

function linkTask(st, task, root, emit, retireLinked = false) {
  if (!task.stack || task.stack.linked && !retireLinked || !task.pr || !['submitted', 'accepted'].includes(task.status)) return;
  const lineage = chain(st, task);
  const members = lineage.filter((t) => !merged(st, t));
  if (members.some((t) => t.stack && t.stack.repo !== st.project.repo)) throw refuse('stack repository differs from project repo');
  const retiring = members.length === 1 && members[0].id === task.id
    && lineage.slice(0, -1).every((t) => merged(st, t));
  if (retireLinked && !retiring) return;
  if (members.length < 2 && !retiring) return;
  for (const t of members) {
    const r = run(root, ['pr', 'view', String(t.pr), '-R', st.project.repo,
      '--json', 'state,headRefOid,headRefName,baseRefName,isCrossRepository,autoMergeRequest']);
    if (r.status !== 0) throw refuse(`cannot read stack PR: ${error(r)}`);
    const pr = JSON.parse(r.stdout);
    const expectedBase = t.stack?.base || st.project.base;
    const validBase = pr.baseRefName === expectedBase || (retiring && pr.baseRefName === st.project.base);
    if (pr.state !== 'OPEN' || pr.isCrossRepository || pr.autoMergeRequest || !sameSha(pr.headRefOid, t.sha)
      || pr.headRefName !== t.branch || !validBase) {
      throw refuse(`${t.id}: stack PR must target ${t.stack?.base || st.project.base}, match its submitted head, use the same repository and have auto-merge disabled`);
    }
    if (retiring) {
      if (pr.baseRefName !== st.project.base) {
        const edit = run(root, ['pr', 'edit', String(t.pr), '-R', st.project.repo, '--base', st.project.base]);
        if (edit.status !== 0) throw refuse(`cannot retarget dependent PR: ${error(edit)}`);
      }
      const parent = task.stack.parent;
      delete task.stack;
      delete task.stack_disabled;
      emit(task.id, { parent, base: st.project.base, pr: task.pr }, 'stack complete');
      return;
    }
  }
  const r = run(root, ['stack', 'link', ...members.map((t) => String(t.pr)), '--base', st.project.base]);
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

function link(ctx) {
  const root = require('./worktree').needRepo(ctx).root;
  const snapshot = snapshotOf(ctx);
  const desired = structuredClone(snapshot.state);
  const events = [];
  linkTask(desired, require('./tasks').getTask(desired, snapshot.task.id), root,
    (id, detail, name) => events.push({ id, detail, name }), ctx.retireLinked === true);
  const task = S.mutate(ctx, 'stack link', (st, emit) => {
    compare(snapshot, st, 'link');
    const t = require('./tasks').getTask(st, ctx.pos[0]);
    for (const previous of snapshot.scope.members) {
      const member = require('./tasks').getTask(st, previous.id);
      const next = require('./tasks').getTask(desired, previous.id);
      for (const field of ['stack', 'stack_disabled']) {
        if (Object.hasOwn(next, field)) member[field] = next[field];
        else delete member[field];
      }
    }
    for (const e of events) emit(e.id, e.detail, e.name);
    return t;
  });
  return { data: task, text: `${task.id}: ${task.stack ? `stack ${task.stack.linked ? 'linked' : 'unavailable or pending'}` : 'ordinary PR on the project base'}` };
}

function observe(ctx) {
  const st = S.loadState(ctx.stateDir);
  for (const t of st.tasks.tasks) {
    if (!t.stack || t.stack.linked || t.stack_disabled || !t.pr || t.status !== 'submitted') continue;
    try { link({ ...ctx, pos: [t.id] }); }
    catch (e) {
      if (e.lockedCommand) throw e;
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
  task.revision += 1;
  task.notes.push({ agent, at: nowIso(), text: `rework: ${reason}` });
  const file = require('./tasks').briefPath(st.dir, task.id);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.appendFileSync(fd, `\n## Rework notes\n\n- ${reason}\n`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  emit(task.id, { reason, sha: task.sha, previous_revision: previousRevision, revision: task.revision }, 'rework');
}

function sync(ctx) {
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const snapshot = snapshotOf(ctx);
  const { task, state, scope } = snapshot;
  if (!task.stack?.linked) throw refuse(`${task.id}: no linked stack to sync`);
  if (task.stack.repo !== state.project.repo) throw refuse('stack repository differs from project repo');
  const { members, project } = scope;
  idle(repo, state, members);
  const cwd = W.findWorktree(repo, W.branchFor(task));
  if (!cwd) throw refuse(`${task.id}: prepare its worktree before stack sync`);
  W.prune(repo);
  const before = new Map(members.map((t) => [t.id, S.git(['rev-parse', t.branch], repo.root)]));
  // Network commands can outlast the lock lease, so only snapshots and application hold it.
  const remote = run(cwd, ['api', `repos/${project.repo}/stacks?pull_request=${task.pr}`]);
  if (remote.status !== 0 && !unavailable(remote)) throw refuse(`cannot verify stack before sync: ${error(remote)}`);
  if (remote.status === 0) {
    const prs = numbers(JSON.parse(remote.stdout), task.pr);
    if (!prs || prs.some((pr) => !members.some((t) => t.pr === pr))) {
      throw refuse('remote stack has untracked PRs; record its tasks before sync');
    }
  }
  // link has no local tracking; checkout imports the remote stack before sync.
  let r = remote.status === 0 ? run(cwd, ['stack', 'checkout', String(task.pr), '--print-path']) : remote;
  if (r.status === 0) r = run(cwd, ['stack', 'sync']);
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
          t.stack.base = merged(current, dep) ? current.project.base : dep.branch;
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

function unstack(ctx) {
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const snapshot = snapshotOf(ctx);
  const { state: st, task } = snapshot;
  if (!task.stack?.linked || task.stack.repo !== st.project.repo) throw refuse('task needs a linked stack in this project repository');
  const members = membersOf(st, task);
  idle(repo, st, members);
  const cwd = W.findWorktree(repo, W.branchFor(task));
  if (!cwd) throw refuse('prepare the task worktree before unstacking');
  let r = run(cwd, ['stack', 'checkout', String(task.pr), '--print-path']);
  if (r.status === 0) r = run(cwd, ['stack', 'unstack']);
  if (r.status !== 0 && !unavailable(r)) throw refuse(`gh stack unstack failed: ${error(r)}`);
  if (r.status === 0) {
    for (const t of members.filter((t) => t.pr)) {
      const view = run(cwd, ['api', `repos/${st.project.repo}/stacks?pull_request=${t.pr}`]);
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

function refresh(ctx, deferred = new Set()) {
  const st = S.loadState(ctx.stateDir);
  const W = require('./worktree');
  const repo = W.needRepo(ctx);
  const done = new Set();
  for (const task of st.tasks.tasks) {
    if (!task.stack?.linked || merged(st, task) || task.status === 'cancelled') continue;
    const bottom = chain(st, task)[0].id;
    if (done.has(bottom)) continue;
    if (chain(st, task).some((member) => deferred.has(member.id))) {
      done.add(bottom);
      S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: 'generated conflict classification or repair is pending' }));
      continue;
    }
    const dep = require('./tasks').getTask(st, task.stack.parent);
    const base = W.resolveBase(repo, st.project.base);
    const expectedBase = merged(st, dep) ? st.project.base : dep.branch;
    const depHead = S.git(['rev-parse', `refs/heads/${dep.branch}`], repo.root) || dep.sha;
    if (base === task.stack.synced_base && sameSha(depHead, task.stack.parent_sha) && task.stack.base === expectedBase) continue;
    done.add(bottom);
    try { sync({ ...ctx, pos: [task.id] }); }
    catch (e) {
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

module.exports = { capture, unchanged, compare, parent, prepare, chain, merged, targetBase, numbers, run, error, unavailable, refreshReadiness, link, linkTask, observe, sync, refresh, unstack, webhook };
