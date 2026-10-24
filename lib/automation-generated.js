'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Runtime = require('./runtime');
const Sessions = require('./spawn-session');
const C = require('./gates/common');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const { refuse } = require('./util');
const { createHash, randomUUID } = require('node:crypto');
const { current, live, merged, ownerWaits } = require('./automation-common');
const { unhold } = require('./automation-schedule');

async function pr(ctx, st, task) {
  if (!task.pr || !st.project.repo) return null;
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const result = await C.gh({ root: repo?.root, signal: ctx.gateSignal, exec: ctx.inboxExec }, ['pr', 'view', String(task.pr), '-R', st.project.repo,
    '--json', 'state,headRefOid,headRefName,headRepository,url,mergeable,mergeStateStatus']);
  if (!result.ok) throw require('./inbox-github').failure(result, `inspect PR #${task.pr}`);
  try { return JSON.parse(result.stdout); }
  catch { throw refuse(`cannot read PR #${task.pr} mergeability`); }
}

// `onto` names the base explicitly; without it the task's PR base is used,
// which for a stacked task is its lower task's branch.
async function baseTip(ctx, st, task, fetch, onto) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse(`${task.id}: no repository for conflict detection`);
  const base = (onto || require('./stack').targetBase(st, task)).replace(/^origin\//, '');
  const gc = { root: repo.root, signal: ctx.gateSignal };
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

async function conflicts(ctx, task, fetch, onto, { generatedOnly = false, detectOnly = false } = {}) {
  ctx.automationSignal?.throwIfAborted();
  const { st } = current(ctx, task.id);
  const { repo, base, tip } = await baseTip(ctx, st, task, fetch, onto);
  ctx.automationSignal?.throwIfAborted();
  const gc = { root: repo.root, stateDir: ctx.stateDir, project: st.project, signal: ctx.gateSignal, tmpEnv: ctx.env };
  const G = require('./generated-conflicts');
  const config = await G.configuration(gc, repo.root, tip);
  ctx.automationSignal?.throwIfAborted();
  const result = await C.withWorktree(gc, repo.root, task.sha, async (dir, env) => {
    ctx.automationSignal?.throwIfAborted();
    const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
      { timeout: 60000, env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
    ctx.automationSignal?.throwIfAborted();
    if (trial.ok) return { files: [] };
    const diff = await C.git(gc, dir, ['diff', '--name-only', '--diff-filter=U', '-z'], { env });
    if (!diff.ok) throw refuse(`cannot list ${task.id} conflicting files: ${C.errText(diff)}`);
    const files = diff.stdout.split('\0').filter(Boolean);
    if (!files.length) throw refuse(`${task.id}: trial merge failed without conflicting files: ${C.errText(trial)}`);
    const resolved = await G.resolve(gc, dir, config, env);
    return { files, ...resolved };
  });
  ctx.automationSignal?.throwIfAborted();
  if (!result.files) throw refuse(result.summary);
  if (!result.files.length) return false;
  if (generatedOnly && !result.generated?.length) return false;
  if (detectOnly) return 'generated';
  if (result.generated?.length) {
    // A trial merge can find conflicts before GitHub has caught up. Only a
    // matching remote conflict authorizes changing the task branch.
    const remote = await pr(ctx, st, task);
    ctx.automationSignal?.throwIfAborted();
    if (remote?.state === 'OPEN' && C.sameSha(remote.headRefOid, task.sha)
      && (remote.mergeable === 'CONFLICTING' || remote.mergeStateStatus === 'DIRTY')) {
      const source = `generated:${randomUUID()}`;
      const held = S.mutate(ctx, 'automation', (now, emit) => {
        unchangedGenerated(now, st, task);
        const last = now.events.findLast((e) => e.cmd === 'automation' && e.task === task.id);
        if (live(last?.detail)) {
          if (last.detail.pid === process.pid && last.detail.host === os.hostname()) return null;
          throw refuse(`${task.id}: generated-file repair waits for the task's executor`);
        }
        emit(task.id, { source, phase: 'running', pid: process.pid, ...P.identity(process.pid) });
        return task.id;
      });
      let error;
      try { await repairGenerated(ctx, st, task, { repo, base, tip, config, remote }); }
      catch (e) { error = e; throw e; }
      finally { unhold(ctx, held, source, error); }
      return true;
    }
    return 'deferred';
  }
  const expectedBase = onto ? {} : { base: require('./stack').targetBase(st, task) };
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision, ...expectedBase },
    flags: { reason: `PR #${task.pr} conflicts with ${base}: ${result.files.join(', ')}. Merge the base, resolve these files and submit a new head.` } });
  return true;
}

// A stack synchronizer can request rework before the ordinary conflict sweep.
// Retire completed lower dependencies and give generated conflicts to repair
// first; unaffected stacks retain their existing synchronization behavior.
async function refreshStacks(ctx) {
  // Returning leaves the completed merge's worktree retirement to its caller.
  if (ctx.automationSignal?.aborted) return;
  const Stack = require('./stack');
  const st = S.loadState(ctx.stateDir);
  const deferred = new Set();
  for (const task of st.tasks.tasks) {
    if (ctx.automationSignal?.aborted) return;
    if (!task.stack?.linked || !['submitted', 'accepted'].includes(task.status) || merged(st, task)) continue;
    const lineage = Stack.chain(st, task);
    try {
      if (!await conflicts(ctx, task, true, st.project.base, { generatedOnly: true, detectOnly: true })) continue;
      deferred.add(task.id);
      deferred.add(lineage[0].id);
      if (!lineage.slice(0, -1).every((lower) => merged(st, lower))) continue;
      await Stack.link({ ...ctx, pos: [task.id], retireLinked: true });
      const now = current(ctx, task.id);
      await conflicts(ctx, now.task, true);
    } catch (error) {
      if (Runtime.missing(error)) throw error;
      if (ctx.automationSignal?.aborted) return;
      deferred.add(task.id);
      deferred.add(lineage[0].id);
      S.mutate(ctx, 'stack sync deferred', (_, emit) => emit(task.id, { reason: error.message }));
    }
  }
  if (ctx.automationSignal?.aborted) return;
  await Stack.refresh(ctx, deferred);
}

function unchangedGenerated(st, before, task) {
  const now = T.getTask(st, task.id);
  if (!isDeepStrictEqual(st.project, before.project) || now.sha !== task.sha || now.revision !== task.revision
    || now.status !== task.status || now.pr !== task.pr || now.branch !== task.branch
    || !isDeepStrictEqual(now.stack, task.stack)) throw refuse(`${task.id} changed during generated-file repair; retry`);
  return now;
}

async function generatedDestination(gc, dir, st, task, remote) {
  const urls = await C.git(gc, dir, ['remote', 'get-url', '--push', '--all', 'origin']);
  const destinations = urls.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!urls.ok || destinations.length !== 1) throw refuse(`${task.id}: generated-file repair needs one origin push destination`);
  const destination = destinations[0];
  const slug = remote.headRepository?.nameWithOwner;
  if (!slug || slug.toLowerCase() !== st.project.repo.toLowerCase()) {
    throw refuse(`${task.id}: PR head repository does not match the project; generated-file repair will not push`);
  }
  const query = destination.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://');
  const view = await C.gh(gc, ['pr', 'view', String(task.pr), '-R', query, '--json', 'url,headRepository']);
  let actual;
  try { actual = JSON.parse(view.stdout); } catch {}
  if (!view.ok || !remote.url || actual?.url !== remote.url || actual?.headRepository?.nameWithOwner !== slug) {
    throw refuse(`${task.id}: origin push destination does not match the PR repository`);
  }
  return destination;
}

// Keep a prepared receipt before pushing. A failed push or an executor death
// after the push can then retry without regenerating or losing the new head.
async function finishGenerated(ctx, st, task, prepared, remote) {
  const { repo } = await baseTip(ctx, st, task, false);
  const gc = { root: repo.root, signal: ctx.gateSignal };
  unchangedGenerated(S.loadState(ctx.stateDir), st, task);
  if (!remote || remote.state !== 'OPEN' || remote.headRefName !== prepared.branch
    || ![task.sha, prepared.sha].some((sha) => C.sameSha(remote.headRefOid, sha))) {
    throw refuse(`${task.id}: PR moved during generated-file repair`);
  }
  // Where the push runs: a worktree's config.worktree can name its own push URL.
  const destination = await generatedDestination(gc, prepared.path, st, task, remote);
  if (createHash('sha256').update(destination).digest('hex') !== prepared.destination_sha) {
    throw refuse(`${task.id}: origin push destination changed during generated-file repair`);
  }
  if ((await C.resolveCommit(gc, prepared.path, 'HEAD')) !== prepared.sha
    || !(await C.git(gc, prepared.path, ['diff', '--quiet'])).ok
    || !(await C.git(gc, prepared.path, ['diff', '--cached', '--quiet'])).ok) {
    throw refuse(`${task.id}: prepared generated-file merge was changed; inspect ${prepared.path}`);
  }
  // By name, git pushes to the URLs `remote get-url --push` listed. A URL on
  // the command line is rewritten again by pushInsteadOf, which a worker can
  // point at a repository whose hooks it wrote.
  const push = await C.git(gc, prepared.path, ['push', 'origin', `${prepared.sha}:refs/heads/${prepared.branch}`],
    { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!push.ok) throw refuse(`${task.id}: generated-file push failed: ${C.errText(push)}`);
  S.mutate(ctx, 'submit', (now, emit) => {
    const t = unchangedGenerated(now, st, task);
    // The latest submit decides who owns the PR, so the repaired head names
    // the owner that waits on it, which keeps waiting.
    const owner = require('./ownership').state(now, t);
    t.status = 'submitted';
    t.sha = prepared.sha;
    t.branch = prepared.branch;
    emit(t.id, { previous_sha: task.sha, sha: t.sha, branch: t.branch, pr: t.pr,
      generated: prepared.generated, base_sha: prepared.base_sha, summary: 'merged base and regenerated outputs',
      ...(owner?.phase === 'waiting' ? { owner: owner.agent } : {}) });
    emit(t.id, { ...prepared, phase: 'pushed' }, 'generated merge');
  });
}

async function resumeGenerated(ctx, st, task, remote) {
  const receipt = st.events.findLast((e) => e.cmd === 'generated merge' && e.task === task.id
    && e.detail.phase === 'prepared' && e.detail.previous_sha === task.sha && e.detail.revision === task.revision);
  if (!receipt) return false;
  await finishGenerated(ctx, st, task, receipt.detail, remote);
  return true;
}

async function repairGenerated(ctx, st, task, { repo, base, tip, config, remote }) {
  const G = require('./generated-conflicts');
  const W = require('./worktree');
  const gc = { root: repo.root, signal: ctx.gateSignal };
  const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker');
  // A waiting owner edits nothing until a handback, and finds the repair on its branch then.
  if (worker && !Sessions.exitedAttempt(worker, st.events) && !ownerWaits(st, task)) throw refuse(`${task.id}: worker is still running; generated-file repair waits for its exit`);
  const branch = remote.headRefName;
  if (!branch || task.branch && task.branch !== branch) throw refuse(`${task.id}: PR branch does not match the task`);
  const destination = await generatedDestination(gc, repo.root, st, task, remote);
  W.relinkAdmins(repo.root, repo.commonDir, { stateDir: repo.stateDir });
  const planned = W.plan(repo, { ...task, branch });
  const head = await C.resolveCommit(gc, repo.root, `refs/heads/${branch}`);
  if (head && !C.sameSha(head, task.sha)) throw refuse(`${task.id}: local branch moved; generated-file repair needs the submitted head`);
  if (planned.exists) {
    const dirty = await C.git(gc, planned.path, ['status', '--porcelain']);
    if (!dirty.ok || dirty.stdout.trim()) throw refuse(`${task.id}: dirty worktree; generated-file repair waits for a clean checkout`);
  }
  unchangedGenerated(S.loadState(ctx.stateDir), st, task);
  const wt = W.create(repo, st, { ...task, branch }, task.sha);
  const dir = wt.path;
  const trial = await C.git(gc, dir, ['merge', '--no-commit', '--no-ff', tip],
    { timeout: 60000, env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' } });
  if (trial.ok || !(await G.files(gc, dir)).length) {
    await C.git(gc, dir, ['merge', '--abort']);
    throw refuse(`${task.id}: conflicts changed before generated-file repair; retry`);
  }
  let prepared = false;
  let mixed = false;
  try {
    const { generated, remaining } = await G.resolve(gc, dir, config);
    mixed = remaining.length > 0;
    const timeout = require('./gate-timeouts').minutes(st.project, 'clean') * 60000;
    const regenerated = await G.regenerate(gc, dir, config, generated, remaining, timeout);
    if (mixed) {
      unchangedGenerated(S.loadState(ctx.stateDir), st, task);
      const reason = `PR #${task.pr} conflicts with ${base}: ${remaining.join(', ')}. The merge is prepared at ${dir}; generated files are pre-resolved: ${generated.join(', ')}. Resolve the hand-written files, rerun ${[...new Set(generated.map((file) => `npm run ${config[file].script}`))].join(', ')}, commit and submit a new head.`;
      const reworked = T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision },
        expect: (now) => { unchangedGenerated(now, st, task); return null; }, flags: { reason } }).data;
      S.mutate(ctx, 'generated merge', (now, emit) => {
        const t = T.getTask(now, task.id);
        // A waiting owner got the rework back in the same write, under its handover claim.
        const handed = reworked.status === 'in_progress' && require('./ownership').handover(now, t, reworked.claim.agent);
        if (!(t.status === 'rework' || handed) || t.sha !== task.sha || t.revision !== reworked.revision) throw refuse(`${task.id} changed during mixed-conflict repair`);
        t.branch = branch;
        emit(t.id, { phase: 'mixed', sha: task.sha, revision: reworked.revision, base_sha: tip,
          branch, path: dir, generated, remaining, regenerated: regenerated.ok, commands: regenerated.commands });
      });
      return;
    }
    if (!regenerated.ok) throw refuse(`${task.id}: generation failed: ${regenerated.error || regenerated.commands.at(-1)?.summary}`);
    const clean = await C.git(gc, dir, ['diff', '--quiet']);
    if (!clean.ok) throw refuse(`${task.id}: generator changed files outside its declared outputs`);
    unchangedGenerated(S.loadState(ctx.stateDir), st, task);
    const commit = await C.git(gc, dir, ['commit', '-m', `Merge ${base} and regenerate outputs`],
      { timeout: 60000, env: { ...process.env, GIT_EDITOR: 'true' } });
    if (!commit.ok) throw refuse(`${task.id}: cannot commit generated-file merge: ${C.errText(commit)}`);
    const sha = await C.resolveCommit(gc, dir, 'HEAD');
    const detail = { phase: 'prepared', previous_sha: task.sha, sha, revision: task.revision,
      destination_sha: createHash('sha256').update(destination).digest('hex'),
      base_sha: tip, branch, path: dir, generated, commands: regenerated.commands };
    S.mutate(ctx, 'generated merge', (now, emit) => {
      unchangedGenerated(now, st, task);
      emit(task.id, detail);
    });
    prepared = true;
    await finishGenerated(ctx, st, task, detail, await pr(ctx, st, task));
  } catch (error) {
    if (!prepared && !mixed) {
      // The checkout was clean and idle before this merge. Discard only this
      // failed automation attempt, including files a generator left unstaged.
      const reset = await C.git(gc, dir, ['reset', '--hard', task.sha]);
      const clean = reset.ok && await C.git(gc, dir, ['clean', '-fd']);
      if (!reset.ok || !clean.ok) throw refuse(`${task.id}: failed generation cleanup needs retry: ${C.errText(reset.ok ? clean : reset)}`);
    }
    throw error;
  }
}

// GitHub computes mergeability after a base moves, so the first read after a
// submit can be UNKNOWN. Re-reading briefly finds a conflict before a suite
// run is spent on it; a suite takes minutes, so these seconds cost little.
// The pause is read at each retry so tests can shorten it without changing
// the number of reads (test/fixtures/mergeability-pause.js).
const MERGEABILITY = { retries: 3, retry_ms: 2000 };

async function settledPr(ctx, st, task) {
  for (let retry = 0; ; retry++) {
    const remote = await pr(ctx, st, task);
    const unknown = remote?.state === 'OPEN' && (remote.mergeable === 'UNKNOWN' || remote.mergeStateStatus === 'UNKNOWN');
    if (!unknown || retry === MERGEABILITY.retries) return remote;
    await new Promise((resolve) => setTimeout(resolve, MERGEABILITY.retry_ms));
  }
}

async function sweep(ctx) {
  ctx.automationSignal?.throwIfAborted();
  const st = S.loadState(ctx.stateDir);
  for (const task of st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status) && !merged(st, t))) {
    ctx.automationSignal?.throwIfAborted();
    try {
      const remote = await pr(ctx, st, task);
      ctx.automationSignal?.throwIfAborted();
      if (!remote || remote.state !== 'OPEN' || !C.sameSha(remote.headRefOid, task.sha)) continue;
      await conflicts(ctx, task, true);
    } catch (e) {
      if (Runtime.missing(e)) throw e;
      ctx.automationSignal?.throwIfAborted();
      T.taskNote({ ...ctx, pos: [task.id, `automation conflict check: ${e.message}`] });
    }
  }
}

module.exports = { pr, baseTip, conflicts, refreshStacks, unchangedGenerated, generatedDestination, finishGenerated, resumeGenerated, repairGenerated, MERGEABILITY, settledPr, sweep };
