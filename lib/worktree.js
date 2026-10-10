'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Commands = require('./commands');
const { execFileSync } = Commands;
const { refuse, slugify, sleepSync, shaMatch, nowIso } = require('./util');
const S = require('./state');
const T = require('./tasks');
const Sessions = require('./spawn-session');
const P = require('./processes');

// Bound dispatch stalls when origin is unreachable; fetching one base gets a minute.
const FETCH_TIMEOUT_MS = 60 * 1000;
const REF_RETRY_MS = 100;
const INITIALIZING = 'tower-crane: creating worktree';

function needRepo(ctx) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse('this needs a git repository; run tower-crane from inside the repo');
  return repo;
}

function branchFor(task) {
  return task.branch || `tower-crane/${task.id}-${slugify(task.title)}`;
}

// Every task worktree lives under this root; cleanup never removes anything outside it.
function worktreesRoot(repo) {
  const name = path.basename(repo.root).replace(/\.git$/, '');
  return path.join(path.dirname(repo.root), `${name}-worktrees`);
}

// The directory comes from the branch, not the title, so renaming a task
// after its worktree exists still finds the same worktree.
function pathFor(repo, branch) {
  const leaf = branch.replace(/^tower-crane\//, '').replace(/[\\/]+/g, '-');
  return path.join(worktreesRoot(repo), leaf);
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

// A registered path can run through a symlink to somewhere else, so the real
// location decides whether removal stays under the root.
function realWithin(dir, root) {
  try {
    return isWithin(fs.realpathSync.native(dir), fs.realpathSync.native(root));
  } catch {
    return false;
  }
}

function listWorktrees(repo) {
  const out = S.git(['worktree', 'list', '--porcelain'], repo.root) || '';
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), branch: null, locked: null };
      list.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (cur && line.startsWith('locked')) {
      cur.locked = line.slice(7) || '';
    }
  }
  return list;
}

function findWorktree(repo, branch) {
  const hit = listWorktrees(repo).find((w) => w.branch === branch);
  return hit ? hit.path : null;
}

// Where the task's worktree is or would be, without touching anything.
function plan(repo, task) {
  const branch = branchFor(task);
  const target = pathFor(repo, branch);
  const existing = listWorktrees(repo).find((w) => w.branch === branch || w.path === target);
  if (existing && (existing.locked === 'initializing' || existing.locked === INITIALIZING)) {
    throw refuse(`worktree for ${branch} is unfinished at ${existing.path}; wait for Git and its children to finish, inspect it, then run git worktree unlock <path> for a complete checkout or git worktree remove --force <path> for an incomplete one`);
  }
  if (existing && (existing.branch !== branch || !fs.existsSync(existing.path))) {
    throw refuse(`worktree for ${branch} has an incomplete registration at ${existing.path}; inspect it before retrying`);
  }
  return { branch, path: existing ? existing.path : target, exists: !!existing };
}

function gitFailure(e, what, timeout) {
  if (e.code === 'ETIMEDOUT' && timeout) return refuse(`${what} timed out after ${timeout / 1000} s`);
  const msg = String(e.stderr || e.message).trim().split('\n').pop();
  return refuse(`${what} failed: ${msg}`);
}

function gitOrRefuse(args, cwd, what, timeout) {
  Commands.assertUnlocked('git');
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
  } catch (e) {
    throw gitFailure(e, what, timeout);
  }
}

// Sandboxes can recreate read-only config mount points after a tree is removed.
// Git prunes entries without gitdir and preserves locked, initializing checkouts.
function prune(repo) {
  gitOrRefuse(['worktree', 'prune'], repo.root, 'git worktree prune');
}

function fetchBase(repo, base, remote, localSha) {
  Commands.assertUnlocked('git');
  const what = `git fetch origin ${base}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // FETCH_HEAD is shared too; callers resolve the explicit destination instead.
      execFileSync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${remote}`],
        { cwd: repo.root, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS });
      return null;
    } catch (e) {
      const error = gitFailure(e, what, FETCH_TIMEOUT_MS);
      const stderr = String(e.stderr || '');
      if (e.code === 'ETIMEDOUT') throw error;
      const refRace = stderr.includes('cannot lock ref') || stderr.includes('incorrect old value');
      if (refRace && attempt === 0) {
        sleepSync(REF_RETRY_MS);
        continue;
      }
      const missing = stderr.includes(`couldn't find remote ref refs/heads/${base}`);
      const unpackRace = stderr.includes('fatal: unpack-objects failed');
      if (!missing && !unpackRace) throw error;
      // Confirm a missing branch or an import completed by another caller.
      const refs = gitOrRefuse(['ls-remote', '--heads', 'origin', `refs/heads/${base}`],
        repo.root, `git ls-remote origin ${base}`, FETCH_TIMEOUT_MS);
      const tip = refs.split(/\r?\n/).map((line) => line.split(/\s+/))
        .find(([, ref]) => ref === `refs/heads/${base}`);
      if (tip) {
        if (unpackRace && S.git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], repo.root) === tip[0]) return null;
        throw error;
      }
      if (!localSha) throw refuse(`base branch ${base} is not in this repository; fetch it or change it with tower-crane project set --base B`);
      process.stderr.write(`origin has no base branch ${base}; using local base at ${localSha}\n`);
      return localSha;
    }
  }
}

function resolveBase(repo, base) {
  const local = `refs/heads/${base}`;
  const remote = `refs/remotes/origin/${base}`;
  const localSha = S.git(['rev-parse', '--verify', '--quiet', `${local}^{commit}`], repo.root);
  if (S.git(['remote', 'get-url', 'origin'], repo.root)) {
    // An explicit destination refreshes the base even with a narrow origin fetch config.
    const fallback = fetchBase(repo, base, remote, localSha);
    if (fallback) return fallback;
  }
  const remoteSha = S.git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], repo.root);
  if (remoteSha && (!localSha || S.git(['merge-base', '--is-ancestor', localSha, remoteSha], repo.root) !== null)) {
    return remoteSha;
  }
  // Keep local commits when the fetched branch is behind or has diverged.
  if (localSha) {
    if (remoteSha) process.stderr.write(`using local base ${base} at ${localSha}; origin/${base} is at ${remoteSha}\n`);
    return localSha;
  }
  throw refuse(`base branch ${base} is not in this repository; fetch it or change it with tower-crane project set --base B`);
}

// A branch made before its dependency was submitted, or on an older submission
// of it, starts from the older base. Move it onto the dependency head only when
// it holds no work of its own.
function adopt(repo, p, task, stack) {
  const head = S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}^{commit}`], repo.root);
  if (head === stack.base) return;
  // A branch that already holds its dependency's head is built on it, whatever work it adds.
  if (head && S.git(['merge-base', '--is-ancestor', stack.base, head], repo.root) !== null) return;
  const dirty = p.exists && S.git(['status', '--porcelain'], p.path) !== '';
  const parent = stack.stack.parent;
  // An older submission can be rewritten, so a branch still at it is replaced.
  const unchanged = !!task.stack && shaMatch(head, task.stack.parent_sha);
  if (!head || dirty || (!unchanged && S.git(['merge-base', '--is-ancestor', head, stack.base], repo.root) === null)) {
    if (task.stack) throw refuse(`${task.id}: ${p.branch} holds its own changes on ${parent} at ${task.stack.parent_sha}, which was resubmitted at ${stack.base}; merge ${stack.stack.base} into it, or remove that worktree and branch, before dispatch`);
    throw refuse(`${task.id}: ${p.branch} was prepared before ${parent} was submitted and holds its own changes; remove that worktree and branch, or wait for ${parent} to merge`);
  }
  const what = `move ${p.branch} onto ${parent}`;
  if (p.exists) gitOrRefuse(unchanged ? ['reset', '--keep', '--quiet', stack.base] : ['merge', '--ff-only', '--quiet', stack.base], p.path, what);
  else gitOrRefuse(['branch', '-f', p.branch, stack.base], repo.root, what);
}

// A prepared stack that is not linked yet records the dependency head it was
// built on; the dependency can be resubmitted before this task's dispatch.
function stale(repo, st, task, branch) {
  if (!task.stack || task.stack.linked) return false;
  const dep = st.tasks.tasks.find((t) => t.id === task.stack.parent);
  const head = S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repo.root);
  if (!head || !dep?.sha) return true;
  return S.git(['merge-base', '--is-ancestor', dep.sha, head], repo.root) === null;
}

function prepared(stack) {
  return stack ? { stack: stack.stack, stack_disabled: stack.disabled, snapshot: stack.snapshot } : {};
}

// Fetches the branch from origin so a head pushed from another checkout is known here; null when origin lacks it.
function fetchOwn(repo, branch) {
  Commands.assertUnlocked('git');
  const remote = `refs/remotes/origin/${branch}`;
  try {
    execFileSync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:${remote}`],
      { cwd: repo.root, env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: FETCH_TIMEOUT_MS });
  } catch (e) {
    if (String(e.stderr || '').includes(`couldn't find remote ref refs/heads/${branch}`)) return null;
    throw gitFailure(e, `git fetch origin ${branch}`, FETCH_TIMEOUT_MS);
  }
  return S.git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], repo.root);
}

// A rework continues from the newest head on origin that holds its submission. A
// tracking ref behind the submission is stale, so the submitted head is kept.
function ownHead(repo, task, branch) {
  // A claimed rework is in_progress with claim.from set; its submitted commits still belong to it.
  const rework = task.status === 'rework' || task.claim?.from === 'rework';
  if (!rework || !task.sha) return null;
  const tip = S.git(['remote', 'get-url', 'origin'], repo.root) ? fetchOwn(repo, branch) : null;
  if (tip && S.git(['merge-base', '--is-ancestor', task.sha, tip], repo.root) !== null) return tip;
  return task.sha;
}

// Creates the task's worktree (and branch) if missing, touching only git.
function create(repo, st, task, baseSha) {
  prune(repo);
  const p = plan(repo, task);
  const Stack = require('./stack');
  const dispatchable = ['todo', 'rework'].includes(task.status) && !task.stack_disabled;
  const outdated = (stack) => {
    if (stack?.base) return;
    const dep = T.getTask(st, task.stack.parent);
    throw refuse(`${task.id}: ${p.branch} was prepared on ${dep.id} at ${task.stack.parent_sha}, which is not its current ${dep.status} head ${dep.sha || '(none)'}; merge that head into ${p.branch}, or remove that worktree and branch, before dispatch`);
  };
  if (p.exists) {
    // Dependencies can become ready, or be resubmitted, after the worktree was made; dispatch revalidates it.
    if (!dispatchable || (task.stack && !stale(repo, st, task, p.branch))) return { ...p, created: false };
    const stack = Stack.prepare(repo, st, task);
    if (task.stack) outdated(stack);
    if (stack?.base) adopt(repo, p, task, stack);
    return { ...p, created: false, ...prepared(stack) };
  }
  const branch = S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], repo.root);
  const recheck = dispatchable && branch && stale(repo, st, task, p.branch);
  // A prepared stack whose branch is gone starts again from what is current now.
  const snapshot = dispatchable && task.stack && !task.stack.linked && !branch ? Stack.capture(st, [task.id, ...task.depends_on]) : null;
  const stack = Stack.prepare(repo, st, task);
  if (recheck) outdated(stack);
  if (fs.existsSync(p.path) && fs.readdirSync(p.path).length) {
    throw refuse(`${p.path} exists and is not a worktree for ${p.branch}; inspect its Git registration before retrying`);
  }
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  // A rework's commits can exist only on its own branch, so a start from the base or the dependency would drop them.
  const own = branch ? null : ownHead(repo, task, p.branch);
  if (own) gitOrRefuse(['branch', p.branch, own], repo.root, `git branch for ${p.branch}`);
  if (branch || own) {
    if (stack?.base) adopt(repo, p, task, stack);
    gitOrRefuse(['worktree', 'add', '--lock', '--reason', INITIALIZING, p.path, p.branch], repo.root, `git worktree add for ${p.branch}`);
  } else {
    const base = stack?.base || baseSha || resolveBase(repo, st.project.base);
    gitOrRefuse(['worktree', 'add', '--lock', '--reason', INITIALIZING, '-b', p.branch, p.path, base], repo.root, `git worktree add for ${p.branch}`);
  }
  gitOrRefuse(['worktree', 'unlock', p.path], repo.root, `git worktree unlock for ${p.branch}`);
  const unstacked = snapshot && !stack?.stack ? { unstack: true, snapshot } : {};
  return { ...p, created: true, ...unstacked, ...prepared(stack) };
}

// Records the branch on the task inside the caller's write. Stack metadata
// applies only while the dependency chain matches what preparation read.
function record(st, t, wt, emit) {
  if (wt.snapshot) {
    const Stack = require('./stack');
    Stack.compare(wt.snapshot, st, 'dispatch');
    const dep = wt.stack && Stack.parent(st, t);
    if (wt.stack && (dep?.id !== wt.stack.parent || !shaMatch(dep.sha, wt.stack.parent_sha))) {
      throw refuse(`${t.id}: ${wt.stack.parent} is no longer an available stack parent; retry dispatch`);
    }
  }
  if (wt.unstack && t.stack) {
    emit(t.id, { parent: t.stack.parent, reason: 'branch recreated on the project base' }, 'stack cleared');
    delete t.stack;
  }
  if (wt.stack) {
    t.stack = wt.stack;
    emit(t.id, { stack: wt.stack }, 'stack dispatch');
  }
  if (wt.stack_disabled) t.stack_disabled = true;
  if (t.branch) return;
  t.branch = wt.branch;
  emit(t.id, { branch: wt.branch, path: wt.path }, 'worktree');
}

function ensure(ctx, taskId, baseSha) {
  const repo = needRepo(ctx);
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, taskId);
  const wt = create(repo, st, task, baseSha);
  if (!task.branch || wt.stack || wt.stack_disabled || wt.unstack) S.mutate(ctx, 'worktree', (st2, emit) => record(st2, T.getTask(st2, task.id), wt, emit));
  return { id: task.id, branch: wt.branch, path: wt.path, created: wt.created, repo };
}

async function worktree(ctx) {
  if (S.loadState(ctx.stateDir).tasks.tasks.some((t) => t.stack?.linked)) await require('./automation').refreshStacks(ctx);
  const repo = needRepo(ctx);
  const st = S.loadState(ctx.stateDir);
  const tasks = [...new Set(ctx.pos)].map((id) => T.getTask(st, id));
  // One caller prepares the dispatch before workers start. Checkout is serial,
  // so Git never reads another add's partially initialized metadata.
  const needsBase = tasks.some((task) => !plan(repo, task).exists
    && !S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchFor(task)}`], repo.root));
  const base = needsBase ? resolveBase(repo, st.project.base) : null;
  const results = tasks.map((task) => {
    const r = ensure(ctx, task.id, base);
    return { id: r.id, branch: r.branch, path: r.path, created: r.created };
  });
  return { data: ctx.pos.length === 1 ? results[0] : results, text: results.map((r) => r.path).join('\n') };
}

// A worker or reviewer still runs in the worktree while its process, or the
// monitor that supervises it, has not exited. This process does not count: it
// is the cleanup, and it leaves the worktree before removing it. An attempt
// without a pid never started a process.
function agentRunning(task, events) {
  const agent = (e) => e.task === task.id && ['worker', 'reviewer'].includes(e.detail?.role);
  return events.some((e) => e.cmd === 'spawn' && agent(e) && Number.isInteger(e.detail.pid) && e.detail.pid > 0
    && !Sessions.exitedAttempt(e, events))
    || events.some((e) => agent(e) && Number.isInteger(e.detail.monitor_pid) && e.detail.monitor_pid !== process.pid
      && P.processState({ pid: e.detail.monitor_pid, host: e.detail.host, start_ticks: e.detail.monitor_start_ticks }) !== 'exited');
}

// Whether this process stands in dir or below it. A cwd that is already gone has no path to compare.
function standsIn(dir) {
  let here;
  try { here = process.cwd(); } catch { return false; }
  return here === dir || isWithin(here, dir);
}

const CHANGED = 'the task changed before its worktree was removed';

// The head a merge or cancel acted on. A newer head of the same task, even an
// accepted one, has its own worktree and its own merge, so it is not removed here.
function sameHead(task, head) {
  const sha = (value) => (value ? String(value).toLowerCase() : null);
  return sha(task.sha) === sha(head.sha) && task.revision === head.revision;
}

// Re-reads the task under the state lock right before the delete, and marks it
// as retiring with this process. Claim, rework and spawn refuse a task marked
// that way, so nothing can take the worktree between this check and the delete,
// which runs outside the lock. Returns why the task no longer qualifies, or
// null. A lock that cannot be taken keeps the worktree.
function markRetiring(ctx, head) {
  let reason = null;
  try {
    S.mutate(ctx, 'worktree retiring', (st) => {
      const task = st.tasks.tasks.find((t) => t.id === head.id);
      // A claim sets the task in progress, so the status covers it.
      if (!task || !['accepted', 'cancelled'].includes(task.status) || !sameHead(task, head)) reason = CHANGED;
      else if (T.isRetiring(task)) reason = 'its worktree is already being removed';
      else reason = agentRunning(task, st.events) ? 'an agent is still running on the task' : null;
      if (!reason) task.retiring = { since: nowIso(), pid: process.pid, ...P.identity(process.pid) };
    });
  } catch (e) {
    return e.message;
  }
  return reason;
}

// Removes the task's worktree, or says why it stays. A worktree with uncommitted
// changes or an agent still running in it is kept, and so is every worktree
// while merge.keep_branch is set. Returns null when the task has no worktree
// under the worktrees root.
function retire(repo, ctx, task, head, keepBranch, events) {
  const hit = listWorktrees(repo).find((w) => w.branch === branchFor(task));
  if (!hit || !isWithin(hit.path, worktreesRoot(repo))) return null;
  if (!sameHead(task, head)) return { path: hit.path, removed: false, reason: CHANGED };
  if (keepBranch) return { path: hit.path, removed: false, reason: 'merge.keep_branch is set' };
  // Git's native initialization lock, or any lock, belongs to whoever set it; prune skips it too.
  if (hit.locked !== null) return { path: hit.path, removed: false, reason: 'worktree is locked' };
  // A registration whose directory is gone is what prune clears.
  if (!fs.existsSync(hit.path)) return { path: hit.path, removed: true };
  if (!realWithin(hit.path, worktreesRoot(repo))) return { path: hit.path, removed: false, reason: 'its real location is not under the worktrees root' };
  if (agentRunning(task, events)) return { path: hit.path, removed: false, reason: 'an agent is still running on the task' };
  const status = S.git(['status', '--porcelain'], hit.path);
  if (status === null) return { path: hit.path, removed: false, reason: 'git status failed in the worktree' };
  if (status) return { path: hit.path, removed: false, reason: 'uncommitted changes' };
  // The first look above may be stale by now; a rework or claim that landed since keeps the worktree.
  const late = markRetiring(ctx, head);
  if (late) return { path: hit.path, removed: false, reason: late };
  try {
    // A monitor runs the merge from its worktree, so the cleanup it does must not leave it in a deleted directory.
    if (standsIn(hit.path)) process.chdir(repo.root);
    gitOrRefuse(['worktree', 'remove', hit.path], repo.root, `git worktree remove ${hit.path}`);
  } catch (e) {
    return { path: hit.path, removed: false, reason: e.message };
  }
  return { path: hit.path, removed: true };
}

// Runs after a merge is recorded or a task is cancelled. Each head is the
// {id, sha, revision} that merge or cancel acted on. Only accepted (merged) and
// cancelled tasks qualify, and only while they still hold that head, so an
// in-progress, submitted or rework task, or a newer head, keeps its worktree.
// Git runs outside the state lock; each task is checked under it right before
// its removal and marked as retiring until the removal ends. Each outcome is an
// event, and prune runs last. Callers have already written the state change this follows.
function retireTask(ctx, heads) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) return;
  const st = S.loadState(ctx.stateDir);
  const keepBranch = !!st.project.merge?.keep_branch;
  for (const head of new Map(heads.map((h) => [h.id, h])).values()) {
    const id = head.id;
    const task = st.tasks.tasks.find((t) => t.id === id);
    if (!task || !['accepted', 'cancelled'].includes(task.status)) continue;
    const outcome = retire(repo, ctx, task, head, keepBranch, st.events);
    if (!outcome) continue;
    S.mutate(ctx, outcome.removed ? 'worktree removed' : 'worktree kept', (st2, emit) => {
      // Only the process that marked the task clears the marker; another removal's marker is its own.
      const t = st2.tasks.tasks.find((x) => x.id === id);
      if (t?.retiring?.pid === process.pid) delete t.retiring;
      emit(id, outcome);
    });
  }
  S.git(['worktree', 'prune'], repo.root);
}

module.exports = { worktree, ensure, create, record, plan, findWorktree, needRepo, branchFor, pathFor, resolveBase, retireTask, prune };
