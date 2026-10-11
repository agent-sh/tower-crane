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
  const out = S.git(['worktree', 'list', '--porcelain', '-z'], repo.root) || '';
  const list = [];
  let cur = null;
  for (const line of out.split('\0')) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), branch: null, locked: null };
      list.push(cur);
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
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
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity, timeout }).trim();
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
  if (staleReason(st, task)) throw refuse(`${task.id} is stale; its worktree cannot be prepared`);
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
  if (staleReason(st, t)) throw refuse(`${t.id} became stale during worktree preparation`);
  t.branch = wt.branch;
  const previous = st.events.find((e) => e.task === t.id && e.cmd === 'worktree' && e.detail?.path === wt.path);
  t.worktree = { path: wt.path, branch: wt.branch, base: wt.stack?.base || (!wt.created && t.worktree?.base) || st.project.base,
    created_at: wt.created ? nowIso() : t.worktree?.created_at || previous?.at || nowIso(), head: wt.head };
  emit(t.id, { ...t.worktree }, 'worktree');
}

function ensure(ctx, taskId, baseSha) {
  const repo = needRepo(ctx);
  const st = S.loadState(ctx.stateDir);
  const task = T.getTask(st, taskId);
  if (staleReason(st, task)) throw refuse(`${task.id} is stale; its worktree cannot be prepared`);
  const wt = create(repo, st, task, baseSha);
  wt.head = S.git(['rev-parse', 'HEAD'], wt.path);
  S.mutate(ctx, 'worktree', (st2, emit) => record(st2, T.getTask(st2, task.id), wt, emit));
  return { id: task.id, branch: wt.branch, path: wt.path, created: wt.created, repo };
}

async function worktree(ctx) {
  if (ctx.env?.TOWER_CRANE_BROKER) {
    const repo = needRepo(ctx);
    const st = S.loadState(ctx.stateDir);
    const results = [...new Set(ctx.pos)].map((id) => {
      const task = T.getTask(st, id);
      if (staleReason(st, task)) throw refuse(`${task.id} is stale; exit so its supervisor can remove the worktree`);
      const wt = plan(repo, task);
      if (!wt.exists) throw refuse(`${id} has no prepared worktree; ask the orchestrator to prepare it`);
      return { id: task.id, branch: wt.branch, path: wt.path, created: false };
    });
    return { data: ctx.pos.length === 1 ? results[0] : results, text: results.map((w) => w.path).join('\n') };
  }
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
      else reason = !staleReason(st, task) ? CHANGED : agentRunning(task, st.events) ? 'an agent is still running on the task' : null;
      if (!reason) task.retiring = { since: nowIso(), pid: process.pid, ...P.identity(process.pid) };
    });
  } catch (e) {
    return e.message;
  }
  return reason;
}

// Only a confirmed merge receipt makes an accepted task stale.
function staleReason(st, task) {
  if (task.superseded_by || task.folded_into) return `superseded by ${task.superseded_by || task.folded_into}`;
  if (task.status === 'cancelled') return 'task cancelled';
  if (require('./stack').merged(st, task)) return 'PR merged';
  return null;
}

// Older task branches are adopted by branch identity when listing or pruning.
function inventory(st, repo = S.findRepo(st.dir, process.cwd())) {
  if (!repo) return [];
  const admin = path.join(repo.commonDir, 'worktrees');
  // Most state writes have no task checkouts; Git has no linked registrations then.
  const trees = fs.existsSync(admin) && fs.readdirSync(admin).length ? listWorktrees(repo) : [];
  const rows = trees.filter((w) => isWithin(w.path, worktreesRoot(repo))).map((w) => {
    const task = st.tasks.tasks.find((t) => t.worktree?.path === w.path || t.branch && t.branch === w.branch);
    return { ...w, task: task?.id || null, status: task?.status || null,
      state: task ? staleReason(st, task) ? 'stale' : 'live' : 'orphan',
      reason: task?.worktree?.reason || (task && staleReason(st, task)) || null };
  });
  // A branch deletion can fail after Git removed the checkout; it still needs an action.
  for (const task of st.tasks.tasks) {
    if (task.worktree?.state === 'stale' && !rows.some((w) => w.task === task.id)) {
      rows.push({ ...task.worktree, task: task.id, status: task.status, state: 'stale' });
    }
  }
  const orphanAttempts = new Map();
  for (const e of st.events || []) if (e.cmd === 'worktree orphan cleanup') orphanAttempts.set(e.detail.path, e.detail);
  for (const attempt of orphanAttempts.values()) {
    if (!attempt.removed && isWithin(attempt.path, worktreesRoot(repo)) && !rows.some((w) => w.path === attempt.path)
      && attempt.branch && S.git(['show-ref', '--verify', `refs/heads/${attempt.branch}`], repo.root)) {
      rows.push({ ...attempt, task: null, status: null, state: 'orphan', locked: null });
    }
  }
  return rows;
}

function counts(rows) {
  return Object.fromEntries(['live', 'stale', 'orphan'].map((state) => [state, rows.filter((w) => w.state === state).length]));
}

function worktreeList(ctx) {
  const st = S.loadState(ctx.stateDir);
  const rows = inventory(st, needRepo(ctx));
  return { data: { counts: counts(rows), worktrees: rows },
    text: `${counts(rows).stale} stale, ${counts(rows).orphan} orphan\n` + rows.map((w) => `${w.state} ${w.task || '-'} ${w.status || '-'} ${w.path}${w.reason ? `: ${w.reason}` : ''}`).join('\n') };
}

// Preserve local commits and edits before deleting the checkout or its branch.
function saveWork(repo, ctx, hit, id, ignoreMask) {
  const status = gitOrRefuse(['status', '--porcelain', '--untracked-files=all'], hit.path, 'git status');
  const files = execFileSync('git', ['ls-files', '--others', '-z'], { cwd: hit.path, encoding: 'utf8', maxBuffer: Infinity }).split('\0').filter(Boolean);
  const base = S.loadState(ctx.stateDir).project.base;
  const baseHead = S.git(['rev-parse', '--verify', `${base}^{commit}`], repo.root);
  const commits = hit.head && (!baseHead || S.git(['merge-base', '--is-ancestor', hit.head, baseHead], repo.root) === null);
  if (!status && !files.length && !commits) return null;
  const root = path.join(ctx.stateDir, 'worktree-saves');
  fs.mkdirSync(root, { recursive: true });
  const saved = fs.mkdtempSync(path.join(root, `${id}-`));
  if (commits) gitOrRefuse(['bundle', 'create', path.join(saved, 'commits.bundle'), 'HEAD'], hit.path, 'save worktree commits');
  const paths = ['--', '.', ...(ignoreMask ? [':(exclude).mcp.json'] : [])];
  for (const [file, args] of [['tracked.patch', ['HEAD']], ['staged.patch', ['--cached', 'HEAD']], ['unstaged.patch', []]]) {
    const fd = fs.openSync(path.join(saved, file), 'wx');
    try {
      execFileSync('git', ['diff', '--binary', '--no-ext-diff', '--no-textconv', ...args, ...paths],
        { cwd: hit.path, stdio: ['ignore', fd, 'pipe'], maxBuffer: Infinity });
    } finally { fs.closeSync(fd); }
  }
  for (const file of files) {
    const source = path.join(hit.path, file);
    const target = path.join(saved, 'files', file);
    if (!isWithin(source, hit.path) || !isWithin(target, saved)) throw refuse('unsafe file path in worktree save');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify({ path: hit.path, branch: hit.branch, head: hit.head, status, files, bundle: commits ? 'commits.bundle' : null }, null, 2) + '\n');
  process.stderr.write(`saved worktree changes: ${saved}\n`);
  return saved;
}

// A missing checkout still has a branch whose local commits must remain recoverable.
function saveMissingCommits(repo, ctx, branch, id, saved) {
  if (saved || !branch) return saved;
  const head = S.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], repo.root);
  const base = S.loadState(ctx.stateDir).project.base;
  const baseHead = S.git(['rev-parse', '--verify', `${base}^{commit}`], repo.root);
  if (!head || baseHead && S.git(['merge-base', '--is-ancestor', head, baseHead], repo.root) !== null) return saved;
  const root = path.join(ctx.stateDir, 'worktree-saves');
  fs.mkdirSync(root, { recursive: true });
  saved = fs.mkdtempSync(path.join(root, `${id}-`));
  gitOrRefuse(['bundle', 'create', path.join(saved, 'commits.bundle'), `refs/heads/${branch}`], repo.root, 'save missing worktree commits');
  fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify({ branch, head, bundle: 'commits.bundle' }, null, 2) + '\n');
  process.stderr.write(`saved worktree commits: ${saved}\n`);
  return saved;
}

function removeTree(repo, ctx, hit, id) {
  if (hit.locked !== null) throw refuse('worktree is locked');
  if (fs.existsSync(hit.path) && !realWithin(hit.path, worktreesRoot(repo))) throw refuse('its real location is not under the worktrees root');
  let saved = null;
  if (fs.existsSync(hit.path)) {
    // A sandbox masks this tracked config with an absent read-only mount point.
    const mask = execFileSync('git', ['status', '--porcelain', '--', '.mcp.json'], { cwd: hit.path, encoding: 'utf8' });
    if (mask.trimEnd() === ' D .mcp.json') {
      try { gitOrRefuse(['restore', '--worktree', '--', '.mcp.json'], hit.path, 'restore sandbox mask'); } catch { /* The patch excludes only the absent mask. */ }
    }
    saved = saveWork(repo, ctx, hit, id, mask.trimEnd() === ' D .mcp.json');
  }
  if (standsIn(hit.path)) process.chdir(repo.root);
  // Force is permitted only after all dirty contents have been saved successfully.
  try {
    gitOrRefuse(['worktree', 'remove', ...(saved ? ['--force'] : []), hit.path], repo.root, `git worktree remove ${hit.path}`);
  } catch (e) { e.saved = saved; throw e; }
  return saved;
}

function retire(repo, ctx, task, head) {
  const hit = listWorktrees(repo).find((w) => w.branch === branchFor(task) || w.path === task.worktree?.path);
  const target = hit?.path || task.worktree?.path;
  if (!target || !isWithin(target, worktreesRoot(repo))) return null;
  const outcome = { path: target, branch: hit?.branch || task.worktree.branch, head: hit?.head || task.worktree?.head, saved: task.worktree?.saved || null, removed: false };
  if (!sameHead(task, head)) return { ...outcome, reason: CHANGED };
  // Read the checkout before reserving it, then compare the task again under the lock.
  if (hit && fs.existsSync(hit.path)) {
    try { gitOrRefuse(['status', '--porcelain'], hit.path, 'git status'); }
    catch (e) { return { ...outcome, reason: e.message }; }
  }
  const late = markRetiring(ctx, head);
  if (late) return { ...outcome, reason: late };
  try {
    if (hit) outcome.saved = removeTree(repo, ctx, hit, task.id) || outcome.saved;
    if (outcome.branch) outcome.head = S.git(['rev-parse', '--verify', `refs/heads/${outcome.branch}^{commit}`], repo.root) || outcome.head;
    outcome.saved = saveMissingCommits(repo, ctx, outcome.branch, task.id, outcome.saved);
    if (outcome.branch && S.git(['show-ref', '--verify', `refs/heads/${outcome.branch}`], repo.root)) {
      gitOrRefuse(['branch', '-D', outcome.branch], repo.root, `delete local branch ${outcome.branch}`);
    }
    outcome.removed = true;
  } catch (e) { outcome.reason = e.message; if (e.saved) outcome.saved = e.saved; }
  return outcome;
}

function retireTask(ctx, heads) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) return [];
  const outcomes = [];
  for (const head of new Map(heads.map((h) => [h.id, h])).values()) {
    const st = S.loadState(ctx.stateDir);
    const task = st.tasks.tasks.find((t) => t.id === head.id);
    if (!task || !staleReason(st, task)) continue;
    const outcome = retire(repo, ctx, task, head);
    if (!outcome) continue;
    outcomes.push({ task: task.id, ...outcome });
    S.mutate(ctx, outcome.removed ? 'worktree removed' : 'worktree kept', (st2, emit) => {
      const t = st2.tasks.tasks.find((x) => x.id === task.id);
      if (t?.retiring?.pid === process.pid) delete t.retiring;
      if (t && sameHead(t, head)) {
        t.worktree = { path: outcome.path, branch: outcome.branch, base: t.worktree?.base || st2.project.base,
          created_at: t.worktree?.created_at || st.events.find((e) => e.task === t.id && e.cmd === 'worktree')?.at || nowIso(),
          head: outcome.head, state: outcome.removed ? 'removed' : 'stale',
          ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.saved ? { saved: outcome.saved } : {}) };
      }
      emit(task.id, outcome);
    });
    if (!outcome.removed) process.stderr.write(`stale worktree ${outcome.path}: ${outcome.reason}; run tower-crane worktree prune\n`);
  }
  return outcomes;
}

function worktreePrune(ctx) {
  const st = S.loadState(ctx.stateDir);
  require('./inbox').authorized(ctx, st);
  const repo = needRepo(ctx);
  const rows = inventory(st, repo);
  const plan = rows.filter((w) => w.state === 'stale' || w.state === 'orphan');
  if (ctx.flags['dry-run']) return { data: { dry_run: true, worktrees: plan }, text: plan.map((w) => `${w.state === 'orphan' && !ctx.flags.orphans ? 'list orphan' : 'remove'} ${w.path}`).join('\n') || 'no stale or orphan worktrees' };
  const outcomes = retireTask(ctx, rows.filter((w) => w.state === 'stale').map((w) => {
    const t = T.getTask(st, w.task);
    return { id: t.id, sha: t.sha, revision: t.revision };
  }));
  const orphans = rows.filter((w) => w.state === 'orphan');
  if (ctx.flags.orphans) for (const hit of orphans) {
    const outcome = { path: hit.path, branch: hit.branch, removed: false };
    try {
      const current = inventory(S.loadState(ctx.stateDir), repo).find((w) => w.path === hit.path);
      if (!current || current.state !== 'orphan') throw refuse('worktree acquired a task record; refresh the prune plan');
      const registered = listWorktrees(repo).find((w) => w.path === hit.path);
      outcome.saved = registered ? removeTree(repo, ctx, registered, 'orphan') : current.saved || null;
      outcome.saved = saveMissingCommits(repo, ctx, hit.branch, 'orphan', outcome.saved);
      if (hit.branch) gitOrRefuse(['branch', '-D', hit.branch], repo.root, `delete orphan branch ${hit.branch}`);
      outcome.removed = true;
    } catch (e) { outcome.reason = e.message; if (e.saved) outcome.saved = e.saved; }
    outcomes.push(outcome);
    S.mutate(ctx, 'worktree orphan cleanup', (_st, emit) => emit(null, outcome));
  }
  return { data: { outcomes, orphans }, text: [...outcomes.map((w) => `${w.removed ? 'removed' : 'stale'} ${w.path}${w.reason ? `: ${w.reason}` : ''}`), ...orphans.map((w) => `orphan ${w.path}`)].join('\n') || 'no stale or orphan worktrees' };
}

module.exports = { worktree, worktreeList, worktreePrune, inventory, counts, staleReason, ensure, create, record, plan, findWorktree, needRepo, branchFor, pathFor, resolveBase, retireTask, prune };
