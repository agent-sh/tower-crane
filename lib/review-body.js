'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const Sessions = require('./spawn-session');
const P = require('./processes');
const { refuse } = require('./util');

const hash = (body) => createHash('sha256').update(body).digest('hex');
const here = (task, detail) => detail.revision === task.revision && C.sameSha(detail.sha, task.sha);

function failures(st, task) {
  const log = st.log || st.events;
  let count = 0;
  const seen = new Set();
  for (const review of task.evidence || []) {
    if (review.type !== 'review' || !here(task, review) || !T.eligibleGateEvidence(task, review, log)) continue;
    if (review.ok === false && require('./review-findings').bodyOnly(review.findings)) {
      if (review.body_recheck && !seen.has(review.agent)) {
        seen.add(review.agent);
        count++;
      }
    } else {
      count = 0;
      seen.clear();
    }
  }
  return count;
}

function state(st, task) {
  if (task.status !== 'submitted') return null;
  const log = st.log || st.events;
  const review = T.latestGateEvidence(task, 'review', log);
  if (review?.ok !== false || !require('./review-findings').bodyOnly(review.findings)) return null;
  // Only the task's own events decide its repair, so status and inbox read those alone.
  const events = T.taskEvents(log, task.id);
  const stopped = events.findLast((e) => e.cmd === 'review body stuck' && e.task === task.id
    && here(task, e.detail) && isDeepStrictEqual(e.detail.review, review));
  if (stopped) return { stuck: true, ...stopped.detail };
  if (failures(st, task) >= 2) return { stuck: true, sha: task.sha, revision: task.revision, review,
    reason: 'two consecutive PR-body re-check failures at this head' };
  const fix = events.findLast((e) => e.cmd === 'spawn' && e.task === task.id
    && e.detail.body_fix && here(task, e.detail) && isDeepStrictEqual(e.detail.body_fix.review, review));
  if (!fix) return null;
  const after = events.indexOf(fix);
  // Explicit accept can replace a held light check without the automatic marker.
  const recheck = events.findLast((e, i) => i > after && e.cmd === 'spawn' && e.task === task.id
    && e.detail.role === 'reviewer' && here(task, e.detail));
  const exit = recheck && require('./reviewer').reviewExit(st, task);
  return { fix, recheck, held: exit?.state === 'held' ? exit.spawn : null,
    fixing: !Sessions.exitedAttempt(fix, events) || !recheck
      || !Sessions.exitedAttempt(recheck, events) || exit?.state === 'pending' };
}

function check(st, task, fix) {
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (task.status !== 'submitted' || !here(task, fix) || task.pr !== fix.pr || task.branch !== fix.branch
    || !isDeepStrictEqual(review, fix.review)
    || state(st, task)?.stuck) throw refuse(`${task.id}: PR-body repair inputs changed; retry reaction`);
}

async function remote(ctx, st, task) {
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const result = await C.gh({ root: repo?.root, signal: ctx.gateSignal },
    ['pr', 'view', String(task.pr), '-R', st.project.repo, '--json', 'state,headRefOid,headRefName,body,title,baseRefName']);
  if (!result.ok) throw refuse(C.ghFailure(result, `read PR body for ${task.id}`));
  let pr;
  try { pr = JSON.parse(result.stdout); } catch { throw refuse(`${task.id}: cannot read PR body`); }
  if (typeof pr.body !== 'string') throw refuse(`${task.id}: PR body is missing from GitHub response`);
  if (typeof pr.title !== 'string' || typeof pr.baseRefName !== 'string') {
    throw refuse(`${task.id}: PR title or base is missing from GitHub response`);
  }
  return pr;
}

function stuck(ctx, task, review, reason) {
  S.mutate(ctx, 'review body stuck', (st, emit) => {
    const t = T.getTask(st, task.id);
    if (!here(t, task) || t.status !== 'submitted'
      || !isDeepStrictEqual(T.latestGateEvidence(t, 'review', st.events), review)) return;
    if (state(st, t)?.reason === reason && st.events.some((e) => e.cmd === 'review body stuck'
      && e.task === t.id && isDeepStrictEqual(e.detail.review, review))) return;
    emit(t.id, { sha: t.sha, revision: t.revision, review, reason });
  });
}

async function react(ctx, st, task, review) {
  if (task.status !== 'submitted') return 'done';
  const current = state(st, task);
  if (current?.stuck) {
    stuck(ctx, task, review, current.reason);
    return 'done';
  }
  // A body correction needs an existing PR. Native submissions without one
  // retain the explicit accept path.
  if (!task.pr || !st.project.repo || !task.branch) return 'done';
  const fix = current?.fix;
  if (fix && !Sessions.exitedAttempt(fix, st.events)) return 'done';
  if (current?.recheck) {
    if (!Sessions.exitedAttempt(current.recheck, st.events)) return 'done';
    if (await require('./automation').reviewHeld(ctx, st, task)) return 'done';
  }
  const pr = await remote(ctx, st, task);
  if (pr.state !== 'OPEN') return 'done';
  if (!C.sameSha(pr.headRefOid, task.sha) || pr.headRefName !== task.branch) {
    if (fix) {
      const now = S.loadState(ctx.stateDir);
      check(now, T.getTask(now, task.id), fix.detail.body_fix);
      T.rework({ ...ctx, expected: task, expect: (st) => check(st, T.getTask(st, task.id), fix.detail.body_fix),
        flags: { reason: 'PR-body fix changed the PR head; submit the changed code through normal rework.' } });
    }
    return 'done';
  }
  if (!fix) {
    const worker = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker');
    // A waiting owner does not edit the PR, so the body fixer need not wait out its idle limit.
    const owner = require('./ownership').state(st, task);
    if (worker && !Sessions.exitedAttempt(worker, st.events) && !(owner?.phase === 'waiting' && owner.spawn === worker)) return 'done';
    const bodyFix = { sha: task.sha, revision: task.revision, pr: task.pr, branch: task.branch, review,
      body_hash: hash(pr.body), title: pr.title, base: pr.baseRefName };
    await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: task.id }, bodyFix });
    return 'done';
  }
  // Stack retirement can retarget the PR while a repair is running.
  const metadataState = S.loadState(ctx.stateDir);
  const metadataTask = T.getTask(metadataState, task.id);
  check(metadataState, metadataTask, fix.detail.body_fix);
  const expectedBase = require('./stack').targetBase(metadataState, metadataTask);
  if (pr.title !== fix.detail.body_fix.title
    || pr.baseRefName !== fix.detail.body_fix.base && pr.baseRefName !== expectedBase) {
    T.rework({ ...ctx, expected: task, expect: (st) => check(st, T.getTask(st, task.id), fix.detail.body_fix),
      flags: { reason: 'PR-body fix changed the PR title or base; submit through normal rework.' } });
    return 'done';
  }
  const dir = task.worktree?.path || fix.detail.cwd;
  const head = await C.resolveCommit({ root: dir }, dir, 'HEAD');
  const clean = await C.git({ root: dir }, dir, ['status', '--porcelain', '--untracked-files=no']);
  if (!C.sameSha(head, task.sha) || !clean.ok || clean.stdout.trim()) {
    T.rework({ ...ctx, expected: task, expect: (st) => check(st, T.getTask(st, task.id), fix.detail.body_fix),
      flags: { reason: 'PR-body fix changed the checkout; submit code changes through normal rework.' } });
    return 'done';
  }
  if (hash(pr.body) === fix.detail.body_fix.body_hash) {
    const exit = st.events.findLast((e) => ['spawn exit', 'worker-exited'].includes(e.cmd)
      && e.task === task.id && e.detail.agent === fix.detail.agent
      && P.exitSpawn(e, st.events)?.detail.attempt === fix.detail.attempt);
    if (exit?.detail.availability_failure && !fix.detail.body_fix.availability_retry) {
      await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: task.id },
        bodyFix: { ...fix.detail.body_fix, availability_retry: true } });
      return 'done';
    }
    stuck(ctx, task, review, 'PR-body fixer exited without changing the body');
    return 'done';
  }
  const now = S.loadState(ctx.stateDir);
  check(now, T.getTask(now, task.id), fix.detail.body_fix);
  await T.accept({ ...ctx, flags: {}, automatic: true, bodyRecheck: fix.detail.body_fix });
  return 'done';
}

function instructions(task, fix) {
  return [
    '## PR-body repair',
    `Correct only the body of PR #${task.pr} at ${fix.sha}, revision ${fix.revision}.`,
    'This assignment replaces the normal worker workflow. Do not claim, submit, edit repository files, commit or push.',
    'Read the current PR body with gh pr view, verify each finding against the submitted code, and edit the body with gh pr edit --body-file.',
    'Keep the PR title and base unchanged.',
    'Preserve accurate claims and remove or correct every false claim. Exit after the edit. The engine requests the light check automatically.',
    fix.review.ref || '',
    fix.review.summary || '',
    JSON.stringify(fix.review.findings, null, 2),
  ].filter(Boolean).join('\n\n');
}

module.exports = { state, check, react, instructions, failures };
