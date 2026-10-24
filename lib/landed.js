'use strict';

const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const Authority = require('./authority');
const { refuse, usage, nowIso } = require('./util');

// A PR the orchestrator merged on GitHub outside Tower Crane's merge path,
// after its own review and checks. Recording it runs no gate and dispatches no
// review: the task is accepted with merge evidence that names this record, so
// dependents unblock and nothing redispatches merged work.
const SOURCE = 'task landed';
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FIELDS = 'number,state,mergeCommit,baseRefName,headRefName,headRefOid,url,mergedAt,mergedBy,statusCheckRollup';

// The PR's checks at its head, read once when the landing is recorded: check
// runs by name (and workflow), commit statuses by context.
function checksOf(rollup) {
  return (Array.isArray(rollup) ? rollup : []).map((c) => {
    if (c.__typename === 'StatusContext' || (c.context !== undefined && c.name === undefined)) {
      return { name: String(c.context || ''), conclusion: String(c.state || 'unknown').toLowerCase() };
    }
    return { name: String(c.name || ''), ...(c.workflowName ? { workflow: String(c.workflowName) } : {}),
      conclusion: String(c.conclusion || c.status || 'unknown').toLowerCase() };
  }).sort((a, b) => a.name.localeCompare(b.name) || String(a.workflow || '').localeCompare(String(b.workflow || '')));
}

function checksText(checks) {
  if (!checks.length) return 'no checks';
  const by = new Map();
  for (const c of checks) by.set(c.conclusion, (by.get(c.conclusion) || 0) + 1);
  return [...by].map(([k, n]) => `${n} ${k}`).join(', ');
}

const live = (t) => t.status !== 'cancelled';

// The landing that accepted the task's current head and revision. A rework
// moves the task to a new revision, so its old `landed` record stays as
// history but no longer describes the task, even once the task is accepted again.
// A merge gate run that later confirms the same merge at that head and revision,
// such as a queued automation merge, adds its own merge evidence; the task was
// still accepted by the landing, so any landing entry there counts, not only the latest.
function current(task) {
  if (task.status !== 'accepted' || !task.landed) return null;
  return task.evidence.some((e) => e.type === 'merge' && e.ok === true && e.source === SOURCE && e.revision === task.revision
    && C.sameSha(e.sha, task.sha) && e.pr === task.landed.pr && e.merge_sha === task.landed.merge_sha) ? task.landed : null;
}

// A PR or merge commit a landing of this task already consumed: a rework after
// it asked for a change that PR does not hold, so landing it again would accept
// the task without the fix.
function consumed(st, task, prNumber, mergeSha = null) {
  return T.taskEvents(st.events, task.id).findLast((e) => e.cmd === SOURCE
    && (e.detail?.pr === prNumber || (mergeSha && e.detail?.merge_sha === mergeSha))) || null;
}

function consumedRefusal(task, e) {
  return refuse(`${task.id}: PR #${e.detail.pr} (merge ${String(e.detail.merge_sha).slice(0, 7)}) already landed this task at revision ${e.detail.revision}, which was sent back since; the rework needs a new PR`);
}

// The task this PR or branch is recorded on, other than `task`.
function otherOwner(st, task, prNumber, branch) {
  return st.tasks.tasks.find((o) => o.id !== task.id && live(o) && (o.pr === prNumber || o.landed?.pr === prNumber
    || (branch && (o.branch === branch || o.worktree?.branch === branch))));
}

function refusals(st, task) {
  if (task.status === 'accepted') throw refuse(`${task.id} is already accepted${current(task) ? ` (native, PR #${task.landed.pr})` : task.hotfix ? ' (hotfix)' : ''}`);
  if (task.status === 'cancelled') throw refuse(`${task.id} is cancelled; a cancelled task is not recorded as landed`);
  if (task.hotfix) throw refuse(`${task.id} is a recorded hotfix; its gates run through tower-crane accept ${task.id}`);
  if (task.needs_owner) throw refuse(`${task.id} waits on the owner (${task.needs_owner}); the owner clears it with owner-done before the landing is recorded`);
  if (T.isRetiring(task)) throw refuse(`${task.id}: its worktree is being removed; retry after retirement`);
  if (require('./inbox').liveWorker(st, task)) throw refuse(`${task.id} has a worker running; stop it with tower-crane interrupt ${task.id} first`);
}

function sameRecord(task, prNumber, given) {
  const landing = current(task);
  return !!landing && landing.pr === prNumber && (!given || given === landing.merge_sha);
}

async function record(ctx) {
  const st = S.loadState(ctx.stateDir);
  if (!Authority.role(ctx, st.events)) throw refuse('task landed requires the orchestrator or owner identity');
  const task = T.getTask(st, ctx.pos[0]);
  T.requireSupportedTask(task, st);
  const prNumber = ctx.flags.pr;
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw usage('task landed needs --pr with a positive PR number');
  const reason = String(ctx.flags.reason ?? '').trim();
  if (!reason) throw usage('task landed needs --reason: how the change was reviewed and checked before it merged');
  const given = ctx.flags.sha === undefined ? null : String(ctx.flags.sha).toLowerCase();
  if (given !== null && !FULL_SHA.test(given)) throw usage(`--sha must be the full merge commit hash, got "${ctx.flags.sha}"`);
  // Recording the same landing again changes nothing, so a loop over many tasks can be rerun.
  if (sameRecord(task, prNumber, given)) {
    return { data: task, text: `${task.id}: already landed with PR #${prNumber} at ${task.landed.merge_sha.slice(0, 7)}` };
  }
  refusals(st, task);
  const used = consumed(st, task, prNumber, given);
  if (used) throw consumedRefusal(task, used);
  if (!st.project.repo) throw refuse('task landed needs project.repo');
  const repo = require('./worktree').needRepo(ctx);
  const r = await C.gh({ root: repo.root }, ['pr', 'view', String(prNumber), '-R', st.project.repo, '--json', FIELDS]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh pr view ${prNumber}`));
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { throw refuse(`could not read PR #${prNumber}`); }
  const merged = String(pr.mergeCommit?.oid || '').toLowerCase();
  if (pr.state !== 'MERGED' || !FULL_SHA.test(merged)) throw refuse(`PR #${prNumber} is not merged (${pr.state || 'unknown state'})`);
  if (pr.baseRefName !== st.project.base) throw refuse(`PR #${prNumber} merged into ${pr.baseRefName}, not the project base ${st.project.base}`);
  if (given && given !== merged) throw refuse(`--sha ${given.slice(0, 7)} is not PR #${prNumber}'s merge commit ${merged.slice(0, 7)}`);
  const head = String(pr.headRefOid || '').toLowerCase();
  if (!FULL_SHA.test(head)) throw refuse(`PR #${prNumber} has no head commit`);
  const branch = pr.headRefName || null;
  const branches = [task.branch, task.worktree?.branch].filter(Boolean);
  if (task.pr !== prNumber && !branches.includes(branch)) {
    const recorded = [task.pr ? `PR #${task.pr}` : null, ...branches.map((b) => `branch ${b}`)].filter(Boolean);
    throw refuse(`PR #${prNumber} (branch ${branch || 'unknown'}) is not ${task.id}'s: ${recorded.length ? `it records ${[...new Set(recorded)].join(' and ')}` : 'it records no PR or branch'}`);
  }
  const other = otherOwner(st, task, prNumber, branch);
  if (other) throw refuse(`PR #${prNumber} (branch ${branch}) is also recorded on ${other.id}`);
  const usedMerge = consumed(st, task, prNumber, merged);
  if (usedMerge) throw consumedRefusal(task, usedMerge);
  const landing = { pr: prNumber, merge_sha: merged, head_sha: head, base: pr.baseRefName, branch, url: pr.url || null,
    merged_at: pr.mergedAt || null, merged_by: pr.mergedBy?.login || null, checks: checksOf(pr.statusCheckRollup), reason };
  const data = S.mutate(ctx, SOURCE, (now, emit) => {
    if (!Authority.role(ctx, now.events)) throw refuse('task landed requires the orchestrator or owner identity');
    const t = T.getTask(now, task.id);
    if (t.status !== task.status || t.sha !== task.sha || t.revision !== task.revision || t.pr !== task.pr
      || t.branch !== task.branch || now.project.base !== st.project.base) {
      throw refuse(`${task.id}: task or project changed while reading PR #${prNumber}; retry`);
    }
    refusals(now, t);
    const used = consumed(now, t, prNumber, merged);
    if (used) throw consumedRefusal(t, used);
    const other = otherOwner(now, t, prNumber, branch);
    if (other) throw refuse(`PR #${prNumber} (branch ${branch}) is also recorded on ${other.id}`);
    const previous = t.status;
    const released = t.claim ? { agent: t.claim.agent, until: t.claim.until } : null;
    const at = nowIso();
    t.status = 'accepted';
    t.claim = null;
    t.sha = head;
    t.pr = prNumber;
    if (!t.branch && branch) t.branch = branch;
    t.landed = { ...landing, recorded_at: at, recorded_by: ctx.agent };
    t.notes.push({ at, agent: ctx.agent, text: `Landed outside Tower Crane: PR #${prNumber} merged at ${merged.slice(0, 7)}. ${reason}` });
    // Merge evidence lets every reader that asks whether the task merged see it,
    // and it counts only with the matching event below.
    t.evidence.push({ type: 'merge', ok: true, sha: t.sha, revision: t.revision, agent: ctx.agent, ...S.via(ctx), at,
      summary: `PR #${prNumber} merged outside Tower Crane at ${merged.slice(0, 7)}${landing.merged_by ? ` by ${landing.merged_by}` : ''}: ${reason}`,
      ref: landing.url, source: SOURCE, pr: prNumber, merge_sha: merged, commands: [] });
    emit(t.id, { ...landing, sha: t.sha, revision: t.revision, previous_status: previous, ...(released ? { released } : {}) });
    return t;
  });
  const retired = require('./worktree').retireTask(ctx, [{ id: data.id, sha: data.sha, revision: data.revision }]);
  const kept = retired.find((o) => !o.removed);
  const result = T.getTask(S.loadState(ctx.stateDir), data.id);
  return { data: result,
    text: `${data.id}: accepted (native), PR #${prNumber} merged at ${merged.slice(0, 7)}${landing.merged_by ? ` by ${landing.merged_by}` : ''}; checks at head: ${checksText(landing.checks)}${retired.some((o) => o.removed) ? '; worktree removed' : ''}${kept ? `; worktree kept: ${kept.reason}` : ''}` };
}

// Landing merge evidence counts only with the orchestrator's or owner's
// `task landed` event for the same head, revision, PR and merge commit.
function recordedEvidence(task, entry, events) {
  return entry.type === 'merge' && entry.ok === true && T.taskEvents(events, task.id).some((e) => e.cmd === SOURCE
    && e.agent === entry.agent && (e.agent === 'owner' || Authority.isOrchestrator(e.agent, events))
    && e.detail?.sha === entry.sha && e.detail.revision === entry.revision
    && e.detail.pr === entry.pr && e.detail.merge_sha === entry.merge_sha);
}

module.exports = { record, recordedEvidence, current, checksOf, SOURCE };
