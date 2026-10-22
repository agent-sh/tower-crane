'use strict';

const fs = require('node:fs');
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const { refuse, usage, nowIso } = require('./util');

// A review posted on the PR by a clean-context reviewer outside Tower Crane: its first line names
// it, `SHA:` names the head it read, and a `Verdict:` line or a `Blocking findings` section decides it.
const REVIEW_TITLE = /^#*\s*Review \((?:native|Tower Crane), clean context\)\s*$/i;
// Labels may be written in markdown bold: **SHA:** and **Verdict:** pass.
const REVIEW_SHA = /^\**SHA:\**\s*`?([0-9a-f]{40}|[0-9a-f]{64})`?\s*$/im;
const VERDICT = /^\**Verdict:\**\s*\**\s*(pass|fail)\b/im;
const BLOCKING = /^#+\s*Blocking findings[^\n]*\n([\s\S]*?)(?=^#+\s|(?![\s\S]))/im;
const SUMMARY_CHARS = 4000;
// Anyone can comment on a public repository; only these accounts can stand for a review.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const titled = (body) => REVIEW_TITLE.test(String(body || '').split(/\r?\n/).find((line) => line.trim()) || '');

// Workers and reviewers can post as the same login, so the orchestrator names the exact comment.
async function reviewComment(gateCtx, repo, ref) {
  const id = String(ref).match(/(?:#issuecomment-|^)(\d+)$/)?.[1];
  if (!id) throw usage('--review must be a PR comment URL ending in #issuecomment-N, or the comment id');
  const r = await C.gh(gateCtx, ['api', `repos/${repo}/issues/comments/${id}`]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh api comment ${id}`));
  try { return { id, comment: JSON.parse(r.stdout) }; } catch { throw refuse(`could not read review comment ${id}`); }
}

async function postedReview(gateCtx, repo, prNumber, ref, headSha) {
  const { id, comment } = await reviewComment(gateCtx, repo, ref);
  if (!String(comment.issue_url || '').endsWith(`/issues/${prNumber}`)) throw refuse(`review comment ${id} is not on PR #${prNumber}`);
  const association = String(comment.author_association || 'NONE').toUpperCase();
  if (!TRUSTED.has(association)) {
    throw refuse(`review comment ${id} by ${comment.user?.login || 'unknown'} has author_association ${association}; only an OWNER, MEMBER or COLLABORATOR review counts`);
  }
  const body = String(comment.body || '').replace(/\r\n/g, '\n');
  if (!titled(body)) throw refuse(`review comment ${id} is not a clean-context review: its first line must be "Review (native, clean context)" or "Review (Tower Crane, clean context)"`);
  const reviewed = body.match(REVIEW_SHA)?.[1]?.toLowerCase();
  if (!reviewed || !C.sameSha(reviewed, headSha)) {
    throw refuse(`review comment ${id} reviewed ${reviewed ? reviewed.slice(0, 7) : 'no SHA'}, but PR #${prNumber} merged head ${headSha.slice(0, 7)}; omit --review so accept dispatches an independent review of the landed diff`);
  }
  const verdict = body.match(VERDICT)?.[1]?.toLowerCase();
  const blocking = body.match(BLOCKING)?.[1]?.trim();
  if (!verdict && blocking === undefined) throw refuse(`review comment ${id} has no verdict: it needs a "Verdict: pass|fail" line or a "Blocking findings" section`);
  const ok = verdict ? verdict === 'pass' : /^none\.?$/i.test(blocking);
  const author = comment.user?.login || 'unknown';
  const url = comment.html_url || ref;
  const findings = ok ? '' : `\n${(blocking || body).slice(0, SUMMARY_CHARS)}`;
  return { ok, url, author, author_association: association, reviewed_sha: reviewed,
    summary: `posted review by ${author} (${association}) of PR #${prNumber} head ${reviewed.slice(0, 7)}: ${ok ? 'pass' : 'fail'}${findings}` };
}

// Tests, cleanup and review read the merge against its first parent, so that parent must precede the
// whole PR: a merge commit whose second parent is the PR head, or a single commit (squash, or a one-commit
// rebase). A rebase merge of several commits leaves an earlier PR commit, same subject and author time, as
// the first parent.
async function requireWholeMerge(gateCtx, root, sha, pr, prNumber) {
  const r = await C.git(gateCtx, root, ['rev-list', '--parents', '-n', '1', sha]);
  if (!r.ok) throw refuse(`cannot read the parents of ${sha}`);
  const parents = r.stdout.trim().split(/\s+/).slice(1);
  if (parents.length > 2) throw refuse(`merge commit ${sha} has ${parents.length} parents; record a squash or two-parent merge only`);
  if (parents.length === 2) {
    if (!C.sameSha(parents[1], pr.headRefOid)) throw refuse(`merge commit ${sha} does not merge PR #${prNumber} head ${pr.headRefOid.slice(0, 7)}`);
    return;
  }
  const commits = Array.isArray(pr.commits) ? pr.commits : [];
  if (commits.length <= 1) return;
  const previous = commits[commits.length - 2];
  const parent = await C.git(gateCtx, root, ['log', '-1', '--no-show-signature', '--format=%at%x00%s', `${sha}^1`]);
  if (!parent.ok) throw refuse(`cannot read the first parent of ${sha}`);
  const [at, subject] = parent.stdout.trim().split('\0');
  if (subject === previous.messageHeadline && Number(at) === Math.floor(Date.parse(previous.authoredDate) / 1000)) {
    throw refuse(`PR #${prNumber} was a rebase merge of ${commits.length} commits: the first parent of ${sha.slice(0, 7)} is its commit "${subject}", so the gates would see only the last commit; record squash or merge-commit merges only`);
  }
}

// The merge commit and its first parent must be local for the gates; one fetch of the base brings both.
async function localCommit(gateCtx, root, base, rev) {
  const found = await C.resolveCommit(gateCtx, root, rev);
  if (found) return found;
  await C.git(gateCtx, root, ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`],
    { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return C.resolveCommit(gateCtx, root, rev);
}

// A follow-up opened by a failure that was not the change's, such as main red at the merge commit, is
// superseded by recording the same merge again. Only a follow-up nobody worked on can go: once a worker
// holds it or it has a branch, PR or commit, that work is the record and the follow-up stays.
function supersedable(st, task) {
  const next = T.getTask(st, task.hotfix.follow_up);
  if (next.claim || T.isRetiring(next)) throw refuse(`${task.id}: follow-up ${next.id} is claimed; release it before re-recording the hotfix`);
  if (next.branch || next.pr || next.sha || next.worktree || ['submitted', 'accepted'].includes(next.status)) {
    throw refuse(`${task.id}: follow-up ${next.id} has its own work (${next.status}${next.pr ? `, PR #${next.pr}` : ''}${next.branch ? `, branch ${next.branch}` : ''}); finish or cancel it instead of re-recording the hotfix`);
  }
  return next;
}

const rerecordable = (task) => task.status === 'cancelled' && !!task.hotfix?.follow_up;
const GATE = /^(tests|clean|sources|ci|review) failed at /;

// What opened the follow-up: the gate whose failure did, or `rework` for an explicit send-back.
// Follow-ups opened before the gate was recorded are read from their event's reason; null when unknown.
function followUpGate(st, task) {
  if (task.hotfix.follow_up_gate) return task.hotfix.follow_up_gate;
  const opened = st.events.findLast((e) => e.cmd === 'hotfix rework' && e.task === task.id && e.detail?.follow_up === task.hotfix.follow_up);
  return opened?.detail.gate || String(opened?.detail.reason || '').match(GATE)?.[1] || null;
}
const SUPERSEDED = 'the failure that opened it was not the change\'s; the hotfix was recorded again for its gates';

// Recording a merge is operational work; it does not waive any gate.
async function record(ctx) {
  const st = S.loadState(ctx.stateDir);
  require('./inbox').authorized(ctx, st);
  const task = T.getTask(st, ctx.pos[0]);
  T.requireSupportedTask(task, st);
  if (!Number.isSafeInteger(ctx.flags.pr) || ctx.flags.pr < 1) throw usage('hotfix needs --pr with a positive PR number');
  const given = ctx.flags.sha === undefined ? null : T.resolveSubmitSha(ctx, ctx.flags.sha);
  if (!st.project.repo) throw refuse('hotfix needs project.repo');
  if (task.claim || T.isRetiring(task)) throw refuse(`${task.id}: release its claim and wait for worktree removal before recording a hotfix`);
  if (task.status === 'accepted' && !task.hotfix) throw refuse(`${task.id}: already accepted through the normal gates`);
  if (task.stack) throw refuse(`${task.id}: unstack before recording a hotfix`);
  const repo = require('./worktree').needRepo(ctx);
  const gateCtx = { root: repo.root };
  const r = await C.gh(gateCtx, ['pr', 'view', String(ctx.flags.pr), '-R', st.project.repo,
    '--json', 'state,mergeCommit,baseRefName,headRefOid,url,commits']);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh pr view ${ctx.flags.pr}`));
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { throw refuse('could not read the merged PR'); }
  const merged = String(pr.mergeCommit?.oid || '').toLowerCase();
  const sha = given ?? merged;
  if (pr.state !== 'MERGED' || !merged || merged !== sha || pr.baseRefName !== st.project.base) {
    throw refuse(`PR #${ctx.flags.pr} must be merged into ${st.project.base}${given ? ` at ${given}` : ''}`);
  }
  if (task.hotfix && (task.hotfix.merge_sha !== sha || task.hotfix.pr !== ctx.flags.pr)) {
    throw refuse(`${task.id}: a different hotfix is already recorded`);
  }
  if (ctx.flags.reason !== undefined && !rerecordable(task)) {
    throw refuse(`${task.id}: --reason applies only to re-recording a cancelled hotfix whose follow-up was a false failure`);
  }
  if (rerecordable(task)) supersedable(st, task);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(pr.headRefOid || '')) throw refuse('merged PR has no head commit');
  const baseSha = await localCommit(gateCtx, repo.root, st.project.base, `${sha}^1`);
  if (!baseSha) throw refuse(`fetch merge commit ${sha} and its first parent before recording a hotfix`);
  await requireWholeMerge(gateCtx, repo.root, sha, pr, ctx.flags.pr);
  const review = ctx.flags.review === undefined ? null
    : await postedReview(gateCtx, st.project.repo, ctx.flags.pr, ctx.flags.review, pr.headRefOid.toLowerCase());
  const data = S.mutate(ctx, 'hotfix', (current, emit, commit) => {
    require('./inbox').authorized(ctx, current);
    const t = T.getTask(current, task.id);
    if (t.sha !== task.sha || t.status !== task.status || t.revision !== task.revision
      || t.claim || current.project.repo !== st.project.repo || current.project.base !== st.project.base
      || t.hotfix?.follow_up !== task.hotfix?.follow_up) {
      throw refuse(`${task.id}: task or project changed while checking the merged PR`);
    }
    const fresh = !t.hotfix;
    const rerecord = rerecordable(t);
    const previousStatus = t.status;
    let superseded = null;
    if (rerecord) {
      const next = supersedable(current, t);
      const reason = String(ctx.flags.reason || '').trim() || SUPERSEDED;
      const gate = followUpGate(current, t);
      // An owner ask on the follow-up is the owner's to drop, as task update --status cancelled would require.
      // A failed review is an independent verdict: setting it aside is the owner's too, and so is a
      // follow-up whose failure is not known.
      const settings = [
        ...(next.needs_owner && next.status !== 'cancelled' ? [require('./authority').holdSetting(current, next)] : []),
        ...(gate === 'review' || !gate ? ['task.rerecord_review'] : []),
      ];
      if (settings.length) {
        require('./authority').enforce(ctx, current, settings,
          { change: { task: next.id, status: 'cancelled', superseded_by: t.id }, emit, commit });
      }
      superseded = { follow_up: next.id, gate, at: nowIso(), by: ctx.agent, reason };
      if (next.status !== 'cancelled') {
        next.status = 'cancelled';
        next.superseded_by = t.id;
        next.claim = null;
        next.notes.push({ at: nowIso(), agent: ctx.agent, text: `Superseded by ${t.id}: ${reason}` });
        emit(next.id, { status: 'cancelled', superseded_by: t.id, hotfix_of: t.id, reason }, 'hotfix supersede');
      }
      delete t.hotfix.follow_up;
      delete t.hotfix.follow_up_gate;
      t.hotfix.superseded = [...(t.hotfix.superseded || []), superseded];
    }
    if (fresh || rerecord) {
      // Earlier submission receipts describe the PR head, not the merge tree; a re-record's earlier
      // receipts hold the failure it supersedes. Both start the gates over at a new revision.
      t.revision = T.nextRevision(current, t);
      t.status = 'submitted';
      t.submitted_by = ctx.agent;
    }
    if (fresh) {
      t.sha = sha;
      t.pr = ctx.flags.pr;
      t.hotfix = { pr: t.pr, merge_sha: sha, head_sha: pr.headRefOid.toLowerCase(), base_sha: baseSha,
        base: st.project.base, recorded_at: nowIso(), recorded_by: ctx.agent };
    }
    const reviewed = review && t.status === 'submitted' && !t.evidence.some((e) => e.type === 'review'
      && e.source === POSTED && e.ref === review.url && e.revision === t.revision);
    if (!fresh && !rerecord && !reviewed) return t;
    if (reviewed) {
      t.evidence.push({ type: 'review', ok: review.ok, sha: t.sha, agent: ctx.agent, ...S.via(ctx), at: nowIso(),
        summary: review.summary, ref: review.url, revision: t.revision, source: POSTED,
        reviewed_sha: review.reviewed_sha, author: review.author, author_association: review.author_association });
    }
    // The hotfix event is the audit that lets the posted review stand for independent review.
    emit(t.id, { pr: t.hotfix.pr, merge_sha: t.hotfix.merge_sha, head_sha: t.hotfix.head_sha, base_sha: t.hotfix.base_sha,
      base: t.hotfix.base, recorded_at: t.hotfix.recorded_at, recorded_by: t.hotfix.recorded_by, revision: t.revision,
      ...(fresh || rerecord ? { previous_status: previousStatus } : {}),
      ...(superseded ? { superseded: { follow_up: superseded.follow_up, gate: superseded.gate, reason: superseded.reason } } : {}),
      ...(reviewed ? { review: { url: review.url, ok: review.ok, reviewed_sha: review.reviewed_sha, author: review.author,
        author_association: review.author_association } } : {}),
      reason: 'merged before its gates; software gates and independent review are required' });
    return t;
  });
  const followUp = review && !review.ok ? settle(ctx) : null;
  if (followUp) {
    return { data: T.getTask(S.loadState(ctx.stateDir), data.id), code: 1,
      text: `${data.id}: posted review failed; follow-up ${followUp.id} requires rework against ${st.project.base}` };
  }
  const replaced = rerecordable(task) ? `; follow-up ${task.hotfix.follow_up} cancelled as superseded, revision ${data.revision}` : '';
  return { data, text: `${data.id}: hotfix PR #${data.pr} ${replaced ? 're-recorded' : 'recorded'} at ${sha.slice(0, 7)}${review ? ` with posted review ${review.url}` : ''}${replaced}; run tower-crane accept ${data.id}` };
}

const POSTED = 'hotfix review';

// Posted review evidence counts only with the orchestrator's or owner's hotfix record naming it.
function postedReviewRecorded(task, entry, events) {
  const Authority = require('./authority');
  return entry.source === POSTED && !!task.hotfix && events.some((e) => e && e.cmd === 'hotfix' && e.task === task.id
    && (e.agent === 'owner' || Authority.isOrchestrator(e.agent, events))
    && e.detail?.merge_sha === entry.sha && e.detail.revision === entry.revision
    && e.detail.review?.url === entry.ref && e.detail.review.ok === entry.ok);
}

// A hotfix tests failure whose every failing name also failed at the merge's first parent. Both commits are
// fixed, so a deterministic failure that predates the merge never clears; this is what the owner can waive.
function baseFailure(task, events) {
  const latest = task.hotfix && T.latestGateEvidence(task, 'tests', events);
  const base = task.hotfix?.base_sha;
  if (!latest || latest.ok || latest.waived || !latest.main_failure || !base) return null;
  if (!C.sameSha(latest.sha, task.sha) || latest.revision !== task.revision
    || !base.toLowerCase().startsWith(String(latest.main_failure.base).toLowerCase())) return null;
  return { base_sha: base, names: [...latest.main_failure.names] };
}

function recorded(st, task) {
  return !!task.hotfix && T.taskEvents(st.events, task.id).some((e) => e.cmd === 'hotfix'
    && e.detail.pr === task.pr && e.detail.merge_sha === task.sha
    && e.detail.base_sha === task.hotfix.base_sha && e.detail.head_sha === task.hotfix.head_sha);
}

// A landed change cannot be repaired by resubmitting its old branch.
function followUp(st, emit, task, reason, agent, gate) {
  if (task.hotfix.follow_up) return T.getTask(st, task.hotfix.follow_up);
  const next = T.newTask(st, { title: `Rework hotfix ${task.id}: ${task.title}`, kind: task.kind,
    acceptance: [...task.acceptance], needs: [...task.needs], size: task.size, tier: task.tier,
    locks: [...task.locks], environment: task.environment, needs_owner: task.needs_owner,
    needs_owner_by: require('./authority').holdSetter(st, task) });
  next.status = 'rework';
  next.hotfix_of = task.id;
  next.notes.push({ at: nowIso(), agent, text: reason });
  let brief;
  try { brief = fs.readFileSync(T.briefPath(st.dir, task.id), 'utf8'); }
  catch { brief = task.acceptance.join('\n'); }
  S.writeAtomic(T.briefPath(st.dir, next.id), `# ${next.id}: rework hotfix ${task.id}\n\nBuild a follow-up PR against ${st.project.base}. PR #${task.pr} already merged at ${task.sha}; keep that merge and repair the finding.\n\n${reason}\n\n## Original brief\n\n${brief}`);
  task.hotfix.follow_up = next.id;
  task.hotfix.follow_up_gate = gate;
  task.status = 'cancelled';
  task.claim = null;
  emit(next.id, { title: next.title, hotfix_of: task.id, base: st.project.base, reason }, 'task add');
  emit(task.id, { follow_up: next.id, gate, sha: task.sha, revision: task.revision,
    base: st.project.base, reason }, 'hotfix rework');
  return next;
}

function failed(st, emit, task, agent) {
  if (!task.hotfix || task.status !== 'submitted') return null;
  const entry = ['tests', 'clean', 'sources', 'ci', 'review']
    .map((type) => T.latestGateEvidence(task, type, st.events))
    .find((e) => e?.ok === false && (e.type === 'review' || e.confirmed_failure === true && !e.infrastructure_failure));
  return entry ? followUp(st, emit, task, `${entry.type} failed at ${task.sha}: ${entry.summary || 'no summary'}${entry.ref ? `\n${entry.ref}` : ''}`, agent, entry.type) : null;
}

function rework(ctx) {
  const data = S.mutate(ctx, 'hotfix rework', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    require('./inbox').authorized(ctx, st);
    // The merge already landed; an accepted hotfix stays accepted and later findings get their own task.
    if (task.status === 'accepted') throw refuse(`${task.id} is an accepted hotfix; its merge stands, so add a new task for the finding`);
    if (task.status !== 'submitted' && !task.hotfix.follow_up) throw refuse(`${task.id} is ${task.status}; only a submitted hotfix can be sent back`);
    return followUp(st, emit, task, ctx.flags.reason || ctx.fromReview?.reason || 'hotfix requires rework', ctx.agent,
      ctx.fromReview ? 'review' : 'rework');
  });
  return { data, text: `${ctx.pos[0]}: follow-up ${data.id} sent back for rework against the project base` };
}

function settle(ctx) {
  return S.mutate(ctx, 'hotfix rework', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    return failed(st, emit, task, ctx.agent);
  });
}

module.exports = { record, recorded, baseFailure, postedReviewRecorded, followUp, failed, rework, settle };
