'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Commands = require('./commands');
const { execFileSync } = Commands;
const { refuse, slugify, sleepSync, shaMatch, nowIso } = require('./util');
const S = require('./state');
const T = require('./tasks');
const Sessions = require('./spawn-session');
const P = require('./processes');
const { clearPlaceholders } = require('./git-placeholders');
const { setTimeout: delay } = require('node:timers/promises');

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

// Sandboxes can recreate read-only config mount points after a tree is removed,
// and leave empty read-only lock files in the git directory. Both go before git
// runs. Git prunes entries without gitdir and preserves locked, initializing checkouts.
function prune(repo) {
  clearPlaceholders(repo.commonDir);
  relinkAdmins(repo.root, repo.commonDir);
  gitOrRefuse(['worktree', 'prune'], repo.root, 'git worktree prune');
  sweepAdmin(repo);
}

// The lock gate preparation takes in the common directory around its
// relink, prune and add (lib/gates/common.js underWorktreeLock). Moving a
// new task worktree's admin directory and every relink take it too: a
// relink that ran between relocateAdmin's move and its link would make the
// link first, and the creation would then fail with the worktree left
// locked. Both hold it for a few file operations and run no git, so a
// process killed inside it is unlikely; a lock left by one is not taken
// over, and the wait ends with a refusal that names the directory to remove.
const WORKTREE_LOCK_MS = 60000;

function underWorktreeLock(commonDir, fn) {
  const lock = path.join(commonDir, 'tower-crane-worktree.lock');
  const deadline = Date.now() + WORKTREE_LOCK_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw refuse(`could not take the worktree lock ${lock}: ${e.message}`);
    }
    if (Date.now() > deadline) throw refuse(`another worktree operation holds ${lock}; if no gate or dispatch is running, remove that directory`);
    sleepSync(10 + Math.floor(Math.random() * 40));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// A task worktree's admin directory (HEAD, index, commondir) lives beside the
// worktrees, in `.git-admin/<name>` under the worktrees root. The worktree's
// .git file names it, and a link at `worktrees/<name>` in the repository's
// git directory keeps it registered for git worktree list, prune and remove.
// A sandboxed agent writes the git directory but not its worktrees/, so no
// agent can write another worktree's admin directory, including one added
// after it started; its own is granted by its real path
// (docs/ladder.md#shared-git-directory). The .git file names the directory
// itself, not the link: codex refuses to keep a path read-only through a link
// it considers writable. Windows links need privileges an agent may lack, so
// there the directory stays where git put it, as it does when the worktrees
// root is on another filesystem.
const ADMIN = '.git-admin';

function relocateAdmin(repo, wtPath) {
  if (process.platform === 'win32') return null;
  const dotGit = path.join(wtPath, '.git');
  const before = fs.readFileSync(dotGit, 'utf8');
  const m = /^gitdir: (.+?)\r?\n?$/.exec(before);
  if (!m) return null;
  const entry = path.resolve(wtPath, m[1]);
  if (!fs.lstatSync(entry, { throwIfNoEntry: false })?.isDirectory()) return null;
  const target = path.join(worktreesRoot(repo), ADMIN, path.basename(entry));
  // An empty directory is what git's remove or prune leaves of an earlier
  // one. Anything else there is kept, and this worktree's stays in place.
  try { fs.rmdirSync(target); } catch (e) {
    if (e.code !== 'ENOENT') {
      process.stderr.write(`tower-crane: ${target} is not empty; the admin directory of ${wtPath} stays in the git directory's worktrees/\n`);
      return null;
    }
  }
  // A sweep can remove the empty parent between the two steps; once is enough to retry.
  for (let tries = 0; ; tries++) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(entry, target);
      break;
    } catch (e) {
      if (e.code === 'EXDEV') return null;
      if (e.code !== 'ENOENT' || tries || fs.existsSync(path.dirname(target))) throw e;
    }
  }
  try {
    linkAdmin(repo.commonDir, target, wtPath);
  } catch (e) {
    fs.rmSync(entry, { force: true });
    fs.renameSync(target, entry);
    fs.writeFileSync(dotGit, before);
    throw e;
  }
  return target;
}

// Writes what joins a worktree, its admin directory and the repository.
// The worktree's .git file, commondir and the link in worktrees/ are
// relative, so moving the project directory, which holds the repository
// and the worktrees root side by side, keeps them working. git resolves
// commondir from the directory the .git file names, so it is relative to
// the admin directory itself. The admin directory's gitdir is git's own
// absolute back-pointer, which git worktree prune trusts, so relinkAdmins
// writes it again after a move, before any prune. Each file is written only
// when it changes.
function linkAdmin(commonDir, admin, wtPath) {
  const real = (p) => fs.realpathSync.native(p);
  const [common, dir, wt] = [real(commonDir), real(admin), real(wtPath)];
  const put = (file, text) => {
    let now = null;
    try { now = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (now !== text) fs.writeFileSync(file, text);
  };
  const entry = path.join(common, 'worktrees', path.basename(dir));
  const target = path.relative(path.dirname(entry), dir);
  const st = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) throw refuse(`${entry} is not a link; inspect it before preparing worktrees`);
  put(path.join(dir, 'commondir'), `${path.relative(dir, common)}\n`);
  put(path.join(dir, 'gitdir'), `${path.join(wt, '.git')}\n`);
  put(path.join(wt, '.git'), `gitdir: ${path.relative(wt, dir)}\n`);
  if (st && fs.readlinkSync(entry) === target) return;
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  if (st) fs.unlinkSync(entry);
  fs.symlinkSync(target, entry, 'dir');
}

// Joins each relocated admin directory to its worktree again: after the
// project directory moved, its gitdir still names the old place, and git
// worktree prune would empty it. The worktree is found by name under the
// worktrees root, from that gitdir, since git can name the admin directory
// apart from it. One whose worktree is gone is left to prune. Two
// repositories can share a worktrees root (`p/r` and `p/r.git` both use
// `p/r-worktrees`), so only an admin directory whose commondir, resolved
// from the admin directory as git does, is this repository's is relinked.
// A caller that already holds the worktree lock passes `locked`.
function relinkAdmins(root, commonDir, { locked = false } = {}) {
  if (!locked) return underWorktreeLock(commonDir, () => relinkAdmins(root, commonDir, { locked: true }));
  const wtRoot = worktreesRoot({ root });
  const dir = path.join(wtRoot, ADMIN);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
  const common = real(commonDir);
  for (const name of names) {
    const admin = path.join(dir, name);
    let named;
    try { named = fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim(); } catch { continue; }
    if (!common || real(path.resolve(admin, named)) !== common) continue;
    let gitdir;
    try { gitdir = fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim(); } catch { continue; }
    const wt = path.join(wtRoot, path.basename(path.dirname(gitdir)));
    // Only a worktree whose .git file names this admin directory, here or
    // where the project was before.
    let dotGit;
    try { dotGit = /^gitdir: (.+?)\r?\n?$/.exec(fs.readFileSync(path.join(wt, '.git'), 'utf8'))?.[1]; } catch { continue; }
    if (!dotGit || path.basename(dotGit) !== name || path.basename(path.dirname(dotGit)) !== ADMIN) continue;
    linkAdmin(commonDir, admin, wt);
  }
}

// Removes the admin directories git emptied when it removed or pruned their worktree.
function sweepAdmin(repo) {
  const dir = path.join(worktreesRoot(repo), ADMIN);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    try { fs.rmdirSync(path.join(dir, n)); } catch { /* still in use, or not emptied */ }
  }
  try { fs.rmdirSync(dir); } catch { /* other admin directories remain */ }
}

// Base resolution as steps: each yield names a network git command or a pause, so
// dispatch runs it blocking and wait's stack refresh runs it cancellable.
function* fetchSteps(repo, base, remote, localSha) {
  const what = `git fetch origin ${base}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    // FETCH_HEAD is shared too; callers resolve the explicit destination instead.
    const fetched = yield { args: ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${remote}`], env: { LC_ALL: 'C' } };
    if (fetched.ok) return null;
    const error = gitFailure(fetched, what, FETCH_TIMEOUT_MS);
    const stderr = String(fetched.stderr || '');
    if (fetched.code === 'ETIMEDOUT') throw error;
    const refRace = stderr.includes('cannot lock ref') || stderr.includes('incorrect old value');
    if (refRace && attempt === 0) {
      yield { sleep: REF_RETRY_MS };
      continue;
    }
    const missing = stderr.includes(`couldn't find remote ref refs/heads/${base}`);
    const unpackRace = stderr.includes('fatal: unpack-objects failed');
    if (!missing && !unpackRace) throw error;
    // Confirm a missing branch or an import completed by another caller.
    const listed = yield { args: ['ls-remote', '--heads', 'origin', `refs/heads/${base}`] };
    if (!listed.ok) throw gitFailure(listed, `git ls-remote origin ${base}`, FETCH_TIMEOUT_MS);
    const tip = String(listed.stdout).trim().split(/\r?\n/).map((line) => line.split(/\s+/))
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

function* baseSteps(repo, base) {
  const local = `refs/heads/${base}`;
  const remote = `refs/remotes/origin/${base}`;
  const localSha = S.git(['rev-parse', '--verify', '--quiet', `${local}^{commit}`], repo.root);
  if (S.git(['remote', 'get-url', 'origin'], repo.root)) {
    // An explicit destination refreshes the base even with a narrow origin fetch config.
    const fallback = yield* fetchSteps(repo, base, remote, localSha);
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

function resolveBase(repo, base) {
  const steps = baseSteps(repo, base);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step.sleep) {
      sleepSync(step.sleep);
      next = steps.next();
      continue;
    }
    Commands.assertUnlocked('git');
    let result;
    try {
      const stdout = execFileSync('git', step.args, { cwd: repo.root, env: { ...process.env, ...step.env }, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity, timeout: FETCH_TIMEOUT_MS });
      result = { ok: true, stdout };
    } catch (e) {
      result = { ok: false, stdout: e.stdout, stderr: e.stderr, code: e.code, message: e.message };
    }
    next = steps.next(result);
  }
  return next.value;
}

// The same resolution without blocking signal delivery. `signal` stops a running
// fetch or retry pause; the resulting failure leaves the base unresolved.
async function resolveBaseAsync(repo, base, signal) {
  const { treeExec } = require('./gates/common');
  const steps = baseSteps(repo, base);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step.sleep) {
      await delay(step.sleep, undefined, { signal });
      next = steps.next();
      continue;
    }
    const r = await treeExec('git', step.args, { cwd: repo.root, env: { ...process.env, ...step.env },
      timeout: FETCH_TIMEOUT_MS, signal });
    next = steps.next({ ok: !r.error && r.status === 0, stdout: r.stdout, stderr: r.stderr,
      code: r.error?.code, message: r.error?.message || `git exited with ${r.status}` });
  }
  return next.value;
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
// A task linked to a PR continues that PR's head on origin, even before any submission.
function ownHead(repo, task, branch) {
  // A claimed rework is in_progress with claim.from set; its submitted commits still belong to it.
  const rework = task.status === 'rework' || task.claim?.from === 'rework';
  if (!task.pr && (!rework || !task.sha)) return null;
  const tip = S.git(['remote', 'get-url', 'origin'], repo.root) ? fetchOwn(repo, branch) : null;
  if (!rework || !task.sha) return tip;
  if (tip && S.git(['merge-base', '--is-ancestor', task.sha, tip], repo.root) !== null) return tip;
  return task.sha;
}

// What a prefetch read depends on: the project base, the task's branch and
// what ownHead reads from the task. A prefetch counts only while it is unchanged.
const prefetchKey = (st, task) => JSON.stringify([st.project.base, branchFor(task), task.depends_on.length,
  task.status, task.claim?.from || null, task.pr || null, task.sha || null]);

// The network reads a new worktree needs, done before a dispatch takes its
// lock: the task's own head on origin and the base. Best effort: a failure
// here leaves create to fetch, and refuse, as it always has. A worktree being
// created right now by another dispatch is not refused here either; the
// dispatch sees it once it holds the lock. A task with dependencies is not
// prefetched: one can merge while the dispatch waits, and only a base read
// after Stack.prepare under the lock holds it.
function prefetch(repo, st, task) {
  if (task.depends_on.length) return null;
  try {
    const p = plan(repo, task);
    if (p.exists || S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`], repo.root)) return null;
    const own = ownHead(repo, task, p.branch);
    return { key: prefetchKey(st, task), own, base: own ? null : resolveBase(repo, st.project.base) };
  } catch {
    return null;
  }
}

// Creates the task's worktree (and branch) if missing, touching only git.
// `fetched` is prefetch's result for this task, or null.
function create(repo, st, task, baseSha, fetched = null) {
  try {
    return createOnce(repo, st, task, baseSha, fetched);
  } catch (error) {
    // Git can read a gate's administrative directory halfway through removal.
    // Replanning preserves refusal of an interrupted, locked preparation.
    if (!/git worktree add .*failed:.*failed to read .*[/\\]commondir:/.test(error.message)) throw error;
    sleepSync(REF_RETRY_MS);
    return createOnce(repo, st, task, baseSha, fetched);
  }
}

function createOnce(repo, st, task, baseSha, fetched) {
  if (staleReason(st, task)) throw refuse(`${task.id} is stale; its worktree cannot be prepared`);
  const wt = createTree(repo, st, task, baseSha, fetched);
  track(repo, wt.branch);
  return wt;
}

// A sandboxed worker cannot write the repository config, so `git push -u`
// cannot record an upstream there: the branch tracks its namesake on origin
// from the start and a plain `git push` publishes it. An upstream already
// set is kept. A config git cannot lock right now (a sandbox can hold a mount
// point on config.lock) leaves the worker `git push origin HEAD`.
function track(repo, branch) {
  if (!S.git(['remote', 'get-url', 'origin'], repo.root)) return;
  const key = `branch.${branch}`;
  if (S.git(['config', '--get', `${key}.remote`], repo.root) || S.git(['config', '--get', `${key}.merge`], repo.root)) return;
  if (S.git(['config', `${key}.remote`, 'origin'], repo.root) === null) return;
  S.git(['config', `${key}.merge`, `refs/heads/${branch}`], repo.root);
}

function createTree(repo, st, task, baseSha, fetched) {
  prune(repo);
  const p = plan(repo, task);
  const retiring = T.retirementHolder(st, task, { path: p.path, branch: p.branch });
  if (retiring) throw refuse(`${p.path} is being removed for ${retiring.id}; prepare it after retirement`);
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
  const reuse = !task.depends_on.length && fetched && fetched.key === prefetchKey(st, task);
  const own = branch ? null : reuse ? fetched.own : ownHead(repo, task, p.branch);
  if (own) gitOrRefuse(['branch', p.branch, own], repo.root, `git branch for ${p.branch}`);
  if (branch || own) {
    if (stack?.base) adopt(repo, p, task, stack);
    gitOrRefuse(['worktree', 'add', '--lock', '--reason', INITIALIZING, p.path, p.branch], repo.root, `git worktree add for ${p.branch}`);
  } else {
    const base = stack?.base || baseSha || (reuse && fetched.base) || resolveBase(repo, st.project.base);
    gitOrRefuse(['worktree', 'add', '--lock', '--reason', INITIALIZING, '-b', p.branch, p.path, base], repo.root, `git worktree add for ${p.branch}`);
  }
  // Still locked: prune leaves an initializing checkout alone while its admin
  // directory moves, and a relink waits for the move (underWorktreeLock).
  underWorktreeLock(repo.commonDir, () => relocateAdmin(repo, p.path));
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
  const retiring = T.retirementHolder(st, t, { path: wt.path, branch: wt.branch });
  if (retiring) throw refuse(`${wt.path} is being removed for ${retiring.id}; retry after retirement`);
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

// A sandboxed agent cannot write the state, so it reads the worktree its spawn
// made. Dispatch prepares a worktree, and the orchestrator's stack sync refreshes stacks.
function existing(repo, task) {
  const p = plan(repo, task);
  if (!p.exists) throw refuse(`${task.id} has no worktree yet; dispatch prepares it, and a sandboxed agent cannot`);
  return { id: task.id, branch: p.branch, path: p.path, created: false };
}

async function worktree(ctx) {
  // The broker sets TOWER_CRANE_BROKER only in a sandboxed agent, whose state is read-only.
  // The variable is inherited, so it counts only for the broker's own state directory.
  const sandboxed = !!ctx.env?.TOWER_CRANE_BROKER && require('./broker').serves(ctx.env.TOWER_CRANE_BROKER, ctx.stateDir);
  if (!sandboxed && S.loadState(ctx.stateDir).tasks.tasks.some((t) => t.stack?.linked)) await require('./automation').refreshStacks(ctx);
  const repo = needRepo(ctx);
  clearPlaceholders(repo.commonDir);
  // Before plan() reads git's registrations, which a project move leaves stale.
  if (!sandboxed) relinkAdmins(repo.root, repo.commonDir);
  const st = S.loadState(ctx.stateDir);
  const tasks = [...new Set(ctx.pos)].map((id) => T.getTask(st, id));
  // One caller prepares the dispatch before workers start. Checkout is serial,
  // so Git never reads another add's partially initialized metadata.
  const needsBase = !sandboxed && tasks.some((task) => !plan(repo, task).exists
    && !S.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branchFor(task)}`], repo.root));
  const base = needsBase ? resolveBase(repo, st.project.base) : null;
  const results = tasks.map((task) => {
    if (sandboxed && staleReason(st, task)) throw refuse(`${task.id} is stale; exit so its supervisor can remove the worktree`);
    const r = sandboxed ? existing(repo, task) : ensure(ctx, task.id, base);
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
function markRetiring(ctx, head, wt) {
  let reason = null;
  try {
    S.mutate(ctx, 'worktree retiring', (st) => {
      const task = st.tasks.tasks.find((t) => t.id === head.id);
      const owner = taskForWorktree(st, wt);
      const holder = task && T.retirementHolder(st, task, wt);
      // A claim sets the task in progress, so the status covers it.
      if (!task || !['accepted', 'cancelled'].includes(task.status) || !sameHead(task, head)) reason = CHANGED;
      else if (holder) reason = `its worktree is already being removed for ${holder.id}`;
      else if (owner && owner.id !== task.id) reason = `its worktree belongs to ${owner.id}`;
      else reason = !staleReason(st, task) ? CHANGED : agentRunning(task, st.events) ? 'an agent is still running on the task' : null;
      if (!reason) task.retiring = { since: nowIso(), pid: process.pid, ...P.identity(process.pid), path: wt.path, branch: wt.branch };
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

function taskForWorktree(st, wt) {
  // A retired record cannot reclaim a checkout that a live task reused.
  // A current branch assignment owns its checkout before preparation updates metadata.
  const candidates = st.tasks.tasks.filter((t) => t.worktree?.state !== 'removed'
    && (t.worktree ? t.worktree.path === wt.path || wt.branch && t.worktree.branch === wt.branch
      : wt.branch && t.branch === wt.branch)
    || wt.branch && t.branch === wt.branch && !staleReason(st, t));
  return candidates.find((t) => !staleReason(st, t)) || candidates.at(-1);
}

function markOrphanRetiring(ctx, wt, reservationId) {
  S.mutate(ctx, 'worktree orphan retiring', (st, emit) => {
    const owner = taskForWorktree(st, wt);
    if (owner) throw refuse(`worktree acquired a task record for ${owner.id}; refresh the prune plan`);
    const holder = T.retirementHolder(st, {}, wt);
    if (holder) throw refuse(`worktree is already being removed for ${holder.id}`);
    const reservation = { reservation_id: reservationId, path: wt.path, branch: wt.branch,
      since: nowIso(), pid: process.pid, ...P.identity(process.pid) };
    st.tasks.orphan_retirements = (st.tasks.orphan_retirements || [])
      .filter((entry) => T.isRetiring({ retiring: entry }));
    st.tasks.orphan_retirements.push(reservation);
    emit(null, reservation);
  });
}

// Older task branches are adopted by branch identity when listing or pruning.
function inventory(st, repo = S.findRepo(st.dir, process.cwd())) {
  if (!repo) return [];
  const admin = path.join(repo.commonDir, 'worktrees');
  // Most state writes have no task checkouts; Git has no linked registrations then.
  const trees = fs.existsSync(admin) && fs.readdirSync(admin).length ? listWorktrees(repo) : [];
  const rows = trees.filter((w) => isWithin(w.path, worktreesRoot(repo))).map((w) => {
    const task = taskForWorktree(st, w);
    return { ...w, task: task?.id || null, status: task?.status || null,
      state: task ? staleReason(st, task) ? 'stale' : 'live' : 'orphan',
      reason: task?.worktree?.reason || (task && staleReason(st, task)) || null };
  });
  // A branch deletion can fail after Git removed the checkout; it still needs an action.
  for (const task of st.tasks.tasks) {
    if (task.worktree?.state === 'stale' && !rows.some((w) => w.task === task.id || w.path === task.worktree.path)) {
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
function saveWork(repo, ctx, hit, id, ignoreMask, allCommits = false, previous = null) {
  const status = gitOrRefuse(['status', '--porcelain', '--untracked-files=all'], hit.path, 'git status');
  const files = execFileSync('git', ['ls-files', '--others', '-z'], { cwd: hit.path, encoding: 'utf8', maxBuffer: Infinity }).split('\0').filter(Boolean);
  const base = S.loadState(ctx.stateDir).project.base;
  const baseHead = S.git(['rev-parse', '--verify', `${base}^{commit}`], repo.root);
  const commits = hit.head && (allCommits || !baseHead || S.git(['merge-base', '--is-ancestor', hit.head, baseHead], repo.root) === null);
  const index = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: hit.path, encoding: 'utf8', maxBuffer: Infinity });
  const links = [...new Set(index.split('\0').filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1)))];
  if (!status && !files.length && !commits && !links.length) return null;
  const root = path.join(ctx.stateDir, 'worktree-saves');
  fs.mkdirSync(root, { recursive: true });
  const saved = fs.mkdtempSync(path.join(root, `${id}-`));
  if (commits) gitOrRefuse(['bundle', 'create', path.join(saved, 'commits.bundle'), ...(allCommits ? ['--all'] : []), 'HEAD'], hit.path, 'save worktree commits');
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
  const submodules = [];
  for (const [i, file] of links.entries()) {
    const child = path.join(hit.path, file);
    if (!isWithin(child, hit.path)) throw refuse('unsafe submodule path in worktree save');
    if (!fs.existsSync(child)) continue;
    if (fs.lstatSync(child).isSymbolicLink() || !fs.existsSync(path.join(child, '.git'))) {
      const target = path.join(saved, 'files', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(child, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      continue;
    }
    const head = gitOrRefuse(['rev-parse', 'HEAD'], child, 'read submodule head');
    const branch = S.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], child);
    const recovery = saveWork({ root: child }, ctx, { path: child, head, branch }, `${id}-module-${i}`, false, true);
    submodules.push({ path: file, saved: recovery });
  }
  fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify({ path: hit.path, branch: hit.branch, head: hit.head, status, files, submodules, bundle: commits ? 'commits.bundle' : null, previous }, null, 2) + '\n');
  process.stderr.write(`saved worktree changes: ${saved}\n`);
  return saved;
}

// A missing checkout still has a branch whose local commits must remain recoverable.
function saveMissingCommits(repo, ctx, branch, id, saved) {
  if (!branch) return saved;
  const head = S.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], repo.root);
  const base = S.loadState(ctx.stateDir).project.base;
  const baseHead = S.git(['rev-parse', '--verify', `${base}^{commit}`], repo.root);
  if (!head || baseHead && S.git(['merge-base', '--is-ancestor', head, baseHead], repo.root) !== null) return saved;
  if (saved) {
    const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json'), 'utf8'));
    const bundle = manifest.bundle && path.join(saved, manifest.bundle);
    if (bundle && !isWithin(bundle, saved)) throw refuse('unsafe bundle path in worktree save');
    if (bundle && fs.existsSync(bundle)) {
      const heads = gitOrRefuse(['bundle', 'list-heads', bundle], repo.root, 'read saved worktree heads');
      if (heads.split(/\r?\n/).some((line) => line.split(' ')[0] === head)) return saved;
    }
  }
  // Earlier patches keep their original base and remain linked from the new generation.
  const previous = saved || null;
  const root = path.join(ctx.stateDir, 'worktree-saves');
  fs.mkdirSync(root, { recursive: true });
  saved = fs.mkdtempSync(path.join(root, `${id}-`));
  gitOrRefuse(['bundle', 'create', path.join(saved, 'commits.bundle'), `refs/heads/${branch}`], repo.root, 'save missing worktree commits');
  fs.writeFileSync(path.join(saved, 'manifest.json'), JSON.stringify({ branch, head, bundle: 'commits.bundle', previous }, null, 2) + '\n');
  process.stderr.write(`saved worktree commits: ${saved}\n`);
  return saved;
}

function removeTree(repo, ctx, hit, id, previous = null) {
  if (hit.locked !== null) throw refuse('worktree is locked');
  if (fs.existsSync(hit.path) && !realWithin(hit.path, worktreesRoot(repo))) throw refuse('its real location is not under the worktrees root');
  let saved = null;
  if (fs.existsSync(hit.path)) {
    // A sandbox masks this tracked config with an absent read-only mount point.
    const mask = execFileSync('git', ['status', '--porcelain', '--', '.mcp.json'], { cwd: hit.path, encoding: 'utf8' });
    if (mask.trimEnd() === ' D .mcp.json') {
      try { gitOrRefuse(['restore', '--worktree', '--', '.mcp.json'], hit.path, 'restore sandbox mask'); } catch { /* The patch excludes only the absent mask. */ }
    }
    saved = saveWork(repo, ctx, hit, id, mask.trimEnd() === ' D .mcp.json', false, previous);
  }
  if (standsIn(hit.path)) process.chdir(repo.root);
  // Force is permitted only after all dirty contents have been saved successfully.
  try {
    gitOrRefuse(['worktree', 'remove', ...(saved ? ['--force'] : []), hit.path], repo.root, `git worktree remove ${hit.path}`);
  } catch (e) { e.saved = saved; throw e; }
  sweepAdmin(repo);
  return saved;
}

function retire(repo, ctx, task, head) {
  const trees = listWorktrees(repo);
  const hit = trees.find((w) => w.path === task.worktree?.path)
    || trees.find((w) => w.branch === (task.worktree?.branch || branchFor(task)));
  const expected = pathFor(repo, branchFor(task));
  const target = hit?.path || task.worktree?.path || (task.scratch && !fs.existsSync(expected) ? expected : null);
  if (!target || !isWithin(target, worktreesRoot(repo))) return null;
  if (hit) {
    const owner = inventory(S.loadState(ctx.stateDir), repo).find((w) => w.path === hit.path);
    if (owner?.task && owner.task !== task.id) return null;
  }
  const outcome = { path: target, branch: hit?.branch || task.worktree?.branch || branchFor(task), head: hit?.head || task.worktree?.head, saved: task.worktree?.saved || null, removed: false };
  if (!sameHead(task, head)) return { ...outcome, reason: CHANGED };
  // Read the checkout before reserving it, then compare the task again under the lock.
  if (hit && fs.existsSync(hit.path)) {
    try { gitOrRefuse(['status', '--porcelain'], hit.path, 'git status'); }
    catch (e) { return { ...outcome, reason: e.message }; }
  }
  const late = markRetiring(ctx, head, outcome);
  if (late) return { ...outcome, reason: late };
  try {
    if (hit) outcome.saved = removeTree(repo, ctx, hit, task.id, outcome.saved) || outcome.saved;
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
    if (outcome.removed) require('./agents').removeTaskCache(task);
    S.mutate(ctx, outcome.removed ? 'worktree removed' : 'worktree kept', (st2, emit) => {
      const t = st2.tasks.tasks.find((x) => x.id === task.id);
      if (outcome.removed && t) delete t.scratch;
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
    const outcome = { path: hit.path, branch: hit.branch, reservation_id: randomUUID(), removed: false };
    try {
      const current = inventory(S.loadState(ctx.stateDir), repo).find((w) => w.path === hit.path);
      if (!current || current.state !== 'orphan') throw refuse('worktree acquired a task record; refresh the prune plan');
      const observed = listWorktrees(repo).find((w) => w.path === hit.path);
      // Git can block, so only ownership and the reservation share the state lock.
      if (observed && fs.existsSync(observed.path)) gitOrRefuse(['status', '--porcelain'], observed.path, 'git status');
      markOrphanRetiring(ctx, hit, outcome.reservation_id);
      const registered = listWorktrees(repo).find((w) => w.path === hit.path);
      if (registered && registered.branch !== hit.branch) throw refuse('worktree branch changed; refresh the prune plan');
      outcome.saved = registered ? removeTree(repo, ctx, registered, 'orphan') : current.saved || null;
      outcome.saved = saveMissingCommits(repo, ctx, hit.branch, 'orphan', outcome.saved);
      if (hit.branch) gitOrRefuse(['branch', '-D', hit.branch], repo.root, `delete orphan branch ${hit.branch}`);
      outcome.removed = true;
    } catch (e) { outcome.reason = e.message; if (e.saved) outcome.saved = e.saved; }
    outcomes.push(outcome);
    S.mutate(ctx, 'worktree orphan cleanup', (st2, emit) => {
      const remaining = (st2.tasks.orphan_retirements || []).filter((entry) => entry.reservation_id !== outcome.reservation_id);
      if (remaining.length) st2.tasks.orphan_retirements = remaining;
      else delete st2.tasks.orphan_retirements;
      emit(null, outcome);
    });
  }
  return { data: { outcomes, orphans }, text: [...outcomes.map((w) => `${w.removed ? 'removed' : 'stale'} ${w.path}${w.reason ? `: ${w.reason}` : ''}`), ...orphans.map((w) => `orphan ${w.path}`)].join('\n') || 'no stale or orphan worktrees' };
}

module.exports = { worktree, worktreeList, worktreePrune, inventory, counts, staleReason, ensure, create, prefetch, record, plan, WORKTREE_LOCK_MS, findWorktree, needRepo, branchFor, pathFor, resolveBase, resolveBaseAsync, retireTask, prune, relinkAdmins };
