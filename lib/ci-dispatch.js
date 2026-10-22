'use strict';

// A manual run of the repository's CI workflow on a task's own branch. PR CI runs only the shared-file
// checks; the full matrix runs on main pushes, the daily schedule and workflow_dispatch. A sandboxed
// worker holds no GitHub credential, so it dispatches through the state broker, for its own task only.
// The run is recorded on the task, ci checks reads its jobs and failing tests, and the CI gate sets
// such runs aside (withoutDispatched in lib/gates/ci.js), so they never count for or against the PR.
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const CI = require('./gates/ci');
const MainRed = require('./gates/main-red');
const F = require('./ci-feedback');
const { stripEscapes, cleanOutput } = require('./ci-log-text');
const { refuse, usage, nowIso } = require('./util');

const PER_HOUR = 4;
const HOUR_MS = 60 * 60000;
// A GitHub without run details in the dispatch answer lists the new run within a few seconds. One
// that takes longer stays recorded without its id; ci checks and the next dispatch look it up again.
const LOOKUP_TRIES = 5;
const LOOKUP_MS = 2000;
// This host's clock and GitHub's differ: a run created this long before the dispatch call still counts as its run.
const SKEW_MS = 60000;
const RUN_FIELDS = '{id, name, path, event, head_sha, head_branch, status, conclusion, created_at, html_url}';
const HINT = 'project.json ci.dispatch must be an object with optional "workflow" (a workflow file name such as "ci.yml", or its numeric id) and "per_hour" (a positive integer); set it with tower-crane project set --ci-dispatch JSON';

function settings(project) {
  const d = project.ci?.dispatch ?? {};
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((k) => !['workflow', 'per_hour'].includes(k))) return { error: HINT };
  const file = typeof d.workflow === 'string' && /^[\w.-]+\.ya?ml$/.test(d.workflow);
  if (d.workflow !== undefined && !file && !(Number.isSafeInteger(d.workflow) && d.workflow > 0)) return { error: HINT };
  if (d.per_hour !== undefined && !(Number.isSafeInteger(d.per_hour) && d.per_hour > 0)) return { error: HINT };
  return { policy: { workflow: d.workflow ?? null, per_hour: d.per_hour ?? PER_HOUR } };
}

// The broker already holds a sandboxed worker to its own task. Outside it, an agent that is neither the
// orchestrator nor the owner dispatches only for a task it claimed or submitted.
function ownedTask(ctx, st) {
  const id = ctx.pos[0] || ctx.flags.task || ctx.env.TOWER_CRANE_TASK;
  if (!id) throw usage('ci dispatch needs a task ID outside a task process');
  const task = T.getTask(st, id);
  if (require('./authority').role(ctx, S.roles(ctx.stateDir))) return task;
  if (task.claim?.agent === ctx.agent || (task.status === 'submitted' && task.submitted_by === ctx.agent)) return task;
  throw refuse(`${ctx.agent} dispatches CI only on a task it claimed or submitted, and ${task.id} is ${task.claim ? `claimed by ${task.claim.agent}` : task.submitted_by ? `submitted by ${task.submitted_by}` : 'not claimed'}`);
}

async function branchHead(ctx, repo, branch) {
  const ref = await F.json(ctx, `repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
  const sha = ref.object?.sha;
  if (!/^[a-f0-9]{40,64}$/i.test(sha || '')) throw refuse(`GitHub names no commit at the head of ${branch} in ${repo}; push the branch first`);
  return sha.toLowerCase();
}

// The configured workflow, else the one workflow that runs on the task's PR.
async function workflowOf(ctx, repo, branch, policy) {
  if (policy.workflow != null) return String(policy.workflow);
  const runs = await F.pages(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=pull_request&per_page=100`, '.workflow_runs[] | {workflow_id, path}');
  const found = [...new Map(runs.filter((w) => w.workflow_id != null).map((w) => [w.workflow_id, w])).values()];
  if (found.length === 1) return String(found[0].workflow_id);
  const set = 'tower-crane project set --ci-dispatch \'{"workflow":"FILE.yml"}\'';
  throw refuse(found.length
    ? `the PR runs on ${branch} come from ${found.length} workflows (${found.map((w) => w.path || w.workflow_id).join(', ')}); the orchestrator names the one to dispatch with ${set}`
    : `no pull_request workflow run on ${branch} names the CI workflow yet; push the PR first, or the orchestrator names it with ${set}`);
}

function runOf(ctx, repo, id) {
  return F.json(ctx, `repos/${repo}/actions/runs/${id}`);
}

// A recorded dispatch without its run id: the earliest manual run of its workflow at its head and
// branch, created since the dispatch, that no other record names.
async function findRun(ctx, repo, entry, taken) {
  const since = Date.parse(entry.at) - SKEW_MS;
  const query = `event=workflow_dispatch&branch=${encodeURIComponent(entry.branch)}&head_sha=${entry.sha}&per_page=100`;
  const runs = await F.pages(ctx, `repos/${repo}/actions/workflows/${encodeURIComponent(entry.workflow)}/runs?${query}`, `.workflow_runs[] | ${RUN_FIELDS}`);
  return runs.filter((w) => w.event === 'workflow_dispatch' && C.sameSha(w.head_sha, entry.sha) && w.head_branch === entry.branch
    && Date.parse(w.created_at) >= since && !taken.has(w.id)).sort((a, b) => a.id - b.id)[0] || null;
}

// The recorded dispatches at this head that have not finished: a run not completed, or a dispatch
// whose run GitHub has not listed yet, until the CI gate's stall window says it never will.
async function unfinished(ctx, repo, list, sha) {
  const taken = new Set(list.map((d) => d.run).filter(Boolean));
  const resolved = new Map();
  const done = new Set();
  for (const d of list.filter((x) => C.sameSha(x.sha, sha))) {
    const run = d.run ? await runOf(ctx, repo, d.run) : await findRun(ctx, repo, d, taken);
    if (run && !d.run) {
      resolved.set(d.at, run.id);
      taken.add(run.id);
    }
    if (run ? run.status !== 'completed' : Date.now() - Date.parse(d.at) < CI.STALL_MS) return { live: { entry: d, run }, resolved, done };
    done.add(d.at);
  }
  return { live: null, resolved, done };
}

function limitRefusal(task, list, policy, now) {
  const recent = list.filter((d) => now - Date.parse(d.at) < HOUR_MS);
  if (recent.length < policy.per_hour) return null;
  const next = new Date(Math.min(...recent.map((d) => Date.parse(d.at))) + HOUR_MS).toISOString();
  return `${task.id} dispatched ${recent.length} CI runs in the last hour, the ci.dispatch.per_hour limit of ${policy.per_hour}; the next can start at ${next}`;
}

function liveRefusal(task, sha, live) {
  return live.run
    ? `${task.id} already has dispatched run ${live.run.id} at ${C.short(sha)}, ${live.run.status}; read it with tower-crane ci checks ${task.id}, or push a new head to dispatch again`
    : `${task.id} dispatched CI at ${C.short(sha)} at ${live.entry.at} and GitHub lists no run for it yet; read it with tower-crane ci checks ${task.id}`;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(ctx, repo, workflow, branch) {
  const endpoint = `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const args = ['api', '--method', 'POST', endpoint, '-f', `ref=${branch}`];
  let r = await C.gh(F.ghContext(ctx), [...args, '-F', 'return_run_details=true']);
  // An API version without run details refuses the key; without it the dispatch answers with no body.
  if (!r.ok && /return_run_details/.test(`${r.stderr}${r.stdout}`)) r = await C.gh(F.ghContext(ctx), args);
  if (!r.ok) return { error: stripEscapes(C.ghFailure(r, `gh api ${endpoint}`)) };
  try {
    const id = JSON.parse(r.stdout || '{}').workflow_run_id;
    return { run: Number.isSafeInteger(id) && id > 0 ? id : null };
  } catch {
    return { run: null };
  }
}

function update(ctx, taskId, fn, cmd, detail) {
  S.mutate(ctx, cmd, (now, emit) => {
    const t = T.getTask(now, taskId);
    t.ci_dispatches = fn(t.ci_dispatches || []);
    if (!t.ci_dispatches.length) delete t.ci_dispatches;
    emit(t.id, detail);
  });
}

async function dispatch(ctx) {
  const st = S.loadState(ctx.stateDir);
  const task = ownedTask(ctx, st);
  const repo = st.project.repo;
  if (!repo) throw refuse('project.json has no repo; set "repo" to "owner/name"');
  if (!task.branch) throw refuse(`${task.id} has no branch yet; its worktree records one`);
  const { policy, error } = settings(st.project);
  if (error) throw refuse(error);
  const list = task.ci_dispatches || [];
  const limited = limitRefusal(task, list, policy, Date.now());
  if (limited) throw refuse(limited);
  const sha = await branchHead(ctx, repo, task.branch);
  const { live, resolved, done } = await unfinished(ctx, repo, list, sha);
  // The lookup may have found the run an entry was missing; keep it whether this dispatch goes ahead or not.
  if (resolved.size) {
    update(ctx, task.id, (now) => now.map((d) => (resolved.has(d.at) && !d.run ? { ...d, run: resolved.get(d.at) } : d)),
      'ci dispatch run', { sha, runs: [...resolved.values()] });
  }
  if (live) throw refuse(liveRefusal(task, sha, live));
  const workflow = await workflowOf(ctx, repo, task.branch, policy);
  const entry = { sha, branch: task.branch, workflow, at: nowIso(), agent: ctx.agent, run: null };
  const same = (d) => d.at === entry.at && d.agent === entry.agent;
  // GitHub was read outside the state lock; the limit and the head are judged again under it, so two
  // dispatches at once cannot both start.
  update(ctx, task.id, (now) => {
    const limit = limitRefusal(task, now, policy, Date.parse(entry.at));
    if (limit) throw refuse(limit);
    const other = now.find((d) => C.sameSha(d.sha, sha) && !done.has(d.at));
    if (other) throw refuse(liveRefusal(task, sha, { entry: other, run: other.run ? { id: other.run, status: 'not completed' } : null }));
    return [...now, entry];
  }, 'ci dispatch', { sha, branch: task.branch, workflow });
  const sent = await post(ctx, repo, workflow, task.branch);
  if (sent.error) {
    update(ctx, task.id, (now) => now.filter((d) => !same(d)), 'ci dispatch failed', { sha, workflow, error: sent.error });
    throw refuse(sent.error);
  }
  let run = sent.run ? await runOf(ctx, repo, sent.run) : null;
  for (let i = 0; !run && i < LOOKUP_TRIES; i++) {
    if (i) await pause(LOOKUP_MS);
    run = await findRun(ctx, repo, entry, new Set([...list.map((d) => d.run), ...resolved.values()].filter(Boolean)));
  }
  if (run) {
    // The branch can move between the read and the dispatch; the run says which head it tests.
    const head = /^[a-f0-9]{40,64}$/i.test(run.head_sha || '') ? run.head_sha.toLowerCase() : sha;
    update(ctx, task.id, (now) => now.map((d) => (same(d) ? { ...d, run: run.id, sha: head } : d)), 'ci dispatch run', { run: run.id, sha: head });
  }
  const data = { task: task.id, sha: run?.head_sha?.toLowerCase() || sha, workflow, run: run?.id ?? null, url: run?.html_url ?? null };
  const text = run
    ? `${task.id}: dispatched ${workflow} run ${run.id} on ${task.branch} at ${C.short(data.sha)}${run.html_url ? ` ${run.html_url}` : ''}; read its jobs and failing tests with tower-crane ci checks ${task.id}`
    : `${task.id}: dispatched ${workflow} on ${task.branch} at ${C.short(sha)}; GitHub lists no run for it yet, and tower-crane ci checks ${task.id} looks it up again`;
  return { data, text };
}

// The latest dispatched run for ci checks: its jobs and, once it completed, each failing job's
// failing tests, named by the parser the CI gate's main_red judgment uses.
async function report(ctx, repo, task, head) {
  const list = task.ci_dispatches || [];
  const entry = list.at(-1);
  if (!entry) return { data: null, lines: [] };
  const run = entry.run ? await runOf(ctx, repo, entry.run)
    : await findRun(ctx, repo, entry, new Set(list.map((d) => d.run).filter(Boolean)));
  const current = C.sameSha(entry.sha, head);
  const at = `${C.short(entry.sha)}${current ? '' : ` (an older head; the PR head is ${C.short(head)})`}`;
  if (!run) {
    return { data: cleanOutput({ ...entry, current, status: null, conclusion: null, jobs: [] }),
      lines: [`dispatched ${entry.workflow} at ${at} at ${entry.at}: GitHub lists no run for it yet`] };
  }
  const jobs = await F.pages(ctx, `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, '.jobs[] | {id, name, status, conclusion, url: .html_url}');
  for (const job of jobs) {
    if (run.status !== 'completed' || job.status !== 'completed' || CI.GOOD.has(job.conclusion)) continue;
    const r = await C.gh(F.ghContext(ctx), ['api', `repos/${repo}/actions/jobs/${job.id}/logs`, '--allow-escape-sequences']);
    if (r.ok) job.failed_tests = MainRed.parseLog(r.stdout).map(({ name, error }) => ({ name, error }));
    else job.log_error = stripEscapes(C.ghFailure(r, `gh api repos/${repo}/actions/jobs/${job.id}/logs`));
  }
  const state = (x) => (x.status === 'completed' ? x.conclusion : x.status);
  const data = cleanOutput({ ...entry, run: run.id, current, status: run.status, conclusion: run.conclusion, url: run.html_url ?? null, jobs });
  const lines = [`dispatched run ${run.id} (${entry.workflow}) at ${at}: ${state(run)}${run.html_url ? ` ${run.html_url}` : ''}`];
  for (const job of data.jobs) {
    lines.push(`  ${job.name}: ${state(job)}${job.status === 'completed' && !CI.GOOD.has(job.conclusion) ? ` (job ${job.id})` : ''}`);
    if (job.log_error) lines.push(`    log unavailable: ${job.log_error}`);
    if (job.failed_tests?.length) lines.push(`    failing tests (${job.failed_tests.length}):`);
    else if (job.failed_tests) lines.push(`    no failing test names in the log; read it with tower-crane ci log ${job.id}`);
    for (const t of job.failed_tests || []) lines.push(`      ${t.name}`, ...(t.error ? [`        ${t.error}`] : []));
  }
  return { data, lines };
}

module.exports = { dispatch, report, settings, PER_HOUR };
