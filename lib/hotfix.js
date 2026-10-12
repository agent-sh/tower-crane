'use strict';

const fs = require('node:fs');
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const { refuse, usage, nowIso } = require('./util');

// Recording a merge is operational work; it does not waive any gate.
async function record(ctx) {
  const st = S.loadState(ctx.stateDir);
  require('./inbox').authorized(ctx, st);
  const task = T.getTask(st, ctx.pos[0]);
  T.requireSupportedTask(task, st);
  if (!Number.isSafeInteger(ctx.flags.pr) || ctx.flags.pr < 1) throw usage('hotfix needs --pr with a positive PR number');
  const sha = T.resolveSubmitSha(ctx, ctx.flags.sha);
  if (!st.project.repo) throw refuse('hotfix needs project.repo');
  if (task.claim || T.isRetiring(task)) throw refuse(`${task.id}: release its claim and wait for worktree removal before recording a hotfix`);
  if (task.status === 'accepted' && !task.hotfix) throw refuse(`${task.id}: already accepted through the normal gates`);
  if (task.stack) throw refuse(`${task.id}: unstack before recording a hotfix`);
  if (task.hotfix && (task.hotfix.merge_sha !== sha || task.hotfix.pr !== ctx.flags.pr)) {
    throw refuse(`${task.id}: a different hotfix is already recorded`);
  }
  const repo = require('./worktree').needRepo(ctx);
  const gateCtx = { root: repo.root };
  const r = await C.gh(gateCtx, ['pr', 'view', String(ctx.flags.pr), '-R', st.project.repo,
    '--json', 'state,mergeCommit,baseRefName,headRefOid,url']);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh pr view ${ctx.flags.pr}`));
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { throw refuse('could not read the merged PR'); }
  if (pr.state !== 'MERGED' || pr.mergeCommit?.oid !== sha || pr.baseRefName !== st.project.base) {
    throw refuse(`PR #${ctx.flags.pr} must be merged into ${st.project.base} at ${sha}`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pr.headRefOid || '')) throw refuse('merged PR has no head commit');
  const baseSha = await C.resolveCommit(gateCtx, repo.root, `${sha}^1`);
  if (!baseSha) throw refuse(`fetch merge commit ${sha} and its first parent before recording a hotfix`);
  const data = S.mutate(ctx, 'hotfix', (current, emit) => {
    require('./inbox').authorized(ctx, current);
    const t = T.getTask(current, task.id);
    if (t.sha !== task.sha || t.status !== task.status || t.revision !== task.revision
      || t.claim || current.project.repo !== st.project.repo || current.project.base !== st.project.base) {
      throw refuse(`${task.id}: task or project changed while checking the merged PR`);
    }
    if (t.hotfix) return t;
    const previousStatus = t.status;
    // Earlier submission receipts describe the PR head, not the merge tree.
    t.revision += 1;
    t.status = 'submitted';
    t.sha = sha;
    t.pr = ctx.flags.pr;
    t.submitted_by = ctx.agent;
    t.hotfix = { pr: t.pr, merge_sha: sha, head_sha: pr.headRefOid.toLowerCase(), base_sha: baseSha,
      base: st.project.base, recorded_at: nowIso(), recorded_by: ctx.agent };
    emit(t.id, { ...t.hotfix, revision: t.revision, previous_status: previousStatus,
      reason: 'merged before its gates; software gates and independent review are required' });
    return t;
  });
  return { data, text: `${data.id}: hotfix PR #${data.pr} recorded at ${sha.slice(0, 7)}; run tower-crane accept ${data.id}` };
}

function recorded(st, task) {
  return !!task.hotfix && st.events.some((e) => e.cmd === 'hotfix' && e.task === task.id
    && e.detail.pr === task.pr && e.detail.merge_sha === task.sha
    && e.detail.base_sha === task.hotfix.base_sha && e.detail.head_sha === task.hotfix.head_sha);
}

// A landed change cannot be repaired by resubmitting its old branch.
function followUp(st, emit, task, reason, agent) {
  if (task.hotfix.follow_up) return T.getTask(st, task.hotfix.follow_up);
  const next = T.newTask(st, { title: `Rework hotfix ${task.id}: ${task.title}`, kind: task.kind,
    acceptance: [...task.acceptance], needs: [...task.needs], size: task.size, tier: task.tier,
    locks: [...task.locks], environment: task.environment, needs_owner: task.needs_owner });
  next.status = 'rework';
  next.hotfix_of = task.id;
  next.notes.push({ at: nowIso(), agent, text: reason });
  let brief;
  try { brief = fs.readFileSync(T.briefPath(st.dir, task.id), 'utf8'); }
  catch { brief = task.acceptance.join('\n'); }
  S.writeAtomic(T.briefPath(st.dir, next.id), `# ${next.id}: rework hotfix ${task.id}\n\nBuild a follow-up PR against ${st.project.base}. PR #${task.pr} already merged at ${task.sha}; keep that merge and repair the finding.\n\n${reason}\n\n## Original brief\n\n${brief}`);
  task.hotfix.follow_up = next.id;
  task.status = 'cancelled';
  task.claim = null;
  emit(next.id, { title: next.title, hotfix_of: task.id, base: st.project.base, reason }, 'task add');
  emit(task.id, { follow_up: next.id, sha: task.sha, revision: task.revision,
    base: st.project.base, reason }, 'hotfix rework');
  return next;
}

function failed(st, emit, task, agent) {
  if (!task.hotfix || task.status !== 'submitted') return null;
  const entry = ['tests', 'clean', 'sources', 'ci', 'review']
    .map((type) => T.latestGateEvidence(task, type, st.events)).find((e) => e?.ok === false);
  return entry ? followUp(st, emit, task, `${entry.type} failed at ${task.sha}: ${entry.summary || 'no summary'}${entry.ref ? `\n${entry.ref}` : ''}`, agent) : null;
}

function rework(ctx) {
  const data = S.mutate(ctx, 'hotfix rework', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    require('./inbox').authorized(ctx, st);
    return followUp(st, emit, task, ctx.flags.reason || ctx.fromReview?.reason || 'hotfix requires rework', ctx.agent);
  });
  return { data, text: `${ctx.pos[0]}: follow-up ${data.id} sent back for rework against the project base` };
}

function settle(ctx) {
  return S.mutate(ctx, 'hotfix rework', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    return failed(st, emit, task, ctx.agent);
  });
}

module.exports = { record, recorded, followUp, failed, rework, settle };
