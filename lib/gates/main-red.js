'use strict';
// A merged hotfix's full workflow run can fail at its merge commit because the base was already
// red there: a test or proof job that fails on the base with or without the change. Such a failure
// is `main_red`, not a verdict on the change, when every failing job failed the same way in an
// earlier run of the same workflow on the base, at a commit the merge commit contains. The nearest
// such run (the first parent's, or the nearest earlier one when the base's concurrency group
// cancelled that) is the parent run; a failure seen only in another of the last WINDOW runs is a
// known flaky job. The same way means the same failing test names when the job's log names any,
// in any job of the earlier run, since a test moves between shards when files are added; a job whose
// log names none needs a failed job of the same name. A failure new at the merge commit stays
// confirmed. The CI gate waits for a later green run that contains the merge commit, as it does for
// a cancelled run, so main_red never passes a hotfix on its own.
const { gh, ghFailure, short, sameSha, listSome } = require('./common');
const { cleanLog } = require('../ci-log-text');

// Events whose runs on the base run the whole workflow: base pushes, the daily schedule and manual runs.
const FULL_EVENTS = new Set(['push', 'schedule', 'workflow_dispatch']);
const GOOD = new Set(['success', 'neutral', 'skipped']);
// The inbox judges the base's CI from the same number of newest runs (lib/main-ci.js).
const WINDOW = 30;
// Commits read back from the merge commit to tell which earlier runs it contains: one page. A busy
// base cancels about every other push run, so WINDOW completed runs fit in it.
const ANCESTORS = 100;
// Test names kept per job in the evidence, as many as a summary lists.
const NAMES = 20;
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';

function workflowKey(w) {
  return w.path || w.name;
}

// The Actions API takes a workflow's numeric id or its file name.
function workflowRef(w) {
  return w.workflow_id ?? String(w.path || '').split('/').pop();
}

function runUrl(repo, id) {
  return `https://github.com/${repo}/actions/runs/${id}`;
}

async function jsonLines(ctx, args, what) {
  const r = await gh(ctx, args);
  if (!r.ok) return { error: `${ghFailure(r, what)}. ${CHECK_HINT}` };
  try {
    return { items: r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  } catch (e) {
    return { error: `could not read ${what} output: ${e.message}` };
  }
}

// A failing job is explained by an earlier run when that run failed the same tests, or, for a job
// whose log names no test, failed a job of the same name.
function explains(job, earlierJobs) {
  if (job.tests?.length) {
    const seen = new Set(earlierJobs.flatMap((j) => j.tests || []));
    return job.tests.every((t) => seen.has(t));
  }
  return earlierJobs.some((j) => j.name === job.name);
}

// Reads GitHub once per run, job and workflow listing, and only what a decision still needs.
function reader(ctx, repo) {
  const logs = new Map();
  const runJobs = new Map();
  const failingTests = () => require('../ci-feedback').failingTests;
  // The failing test names of one job's log; null when the log cannot be read.
  const tests = (id) => {
    if (!logs.has(id)) {
      logs.set(id, gh(ctx, ['api', `repos/${repo}/actions/jobs/${id}/logs`, '--allow-escape-sequences'])
        .then((r) => (r.ok ? failingTests()(cleanLog(r.stdout)).map((t) => t.name) : null)));
    }
    return logs.get(id);
  };
  const jobs = async (run, withTests) => {
    if (!runJobs.has(run.id)) {
      runJobs.set(run.id, jsonLines(ctx, ['api', `repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, '--paginate', '--jq', '.jobs[] | {id, name, conclusion}'], `gh api actions/runs/${run.id}/jobs`));
    }
    const listed = await runJobs.get(run.id);
    if (listed.error) return listed;
    const failed = listed.items.filter((j) => j.conclusion === 'failure');
    if (!withTests) return { items: failed.map((j) => ({ ...j, tests: null })) };
    return { items: await Promise.all(failed.map(async (j) => ({ ...j, tests: await tests(j.id) }))) };
  };
  return { tests, jobs };
}

// The merge commit's ancestors, newest first, without the merge commit itself.
async function ancestors(ctx, repo, sha) {
  const r = await jsonLines(ctx, ['api', `repos/${repo}/commits?sha=${sha}&per_page=${ANCESTORS}`, '--jq', '.[].sha | ascii_downcase | tojson'], `gh api commits?sha=${short(sha)}`);
  if (r.error) return r;
  return { shas: new Set(r.items.filter((s) => !sameSha(s, sha))) };
}

// The last WINDOW completed, not cancelled full runs of the workflow on the base at commits the merge
// commit contains, newest first. A cancelled run judged nothing.
async function earlierRuns(ctx, repo, base, run, contained) {
  const created = encodeURIComponent(`<=${run.created_at}`);
  const r = await jsonLines(ctx, ['api', `repos/${repo}/actions/workflows/${encodeURIComponent(workflowRef(run))}/runs?branch=${encodeURIComponent(base)}&created=${created}&per_page=100`,
    '--jq', '.workflow_runs[] | {id, name, path, event, created_at, head_sha, head_branch, status, conclusion, run_attempt}'], `gh api workflow runs of ${workflowKey(run)}`);
  if (r.error) return r;
  const runs = r.items.filter((w) => w.head_branch === base && FULL_EVENTS.has(w.event) && w.status === 'completed'
    && w.conclusion !== 'cancelled' && typeof w.head_sha === 'string' && contained.has(w.head_sha.toLowerCase())
    && workflowKey(w) === workflowKey(run))
    .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1));
  return { runs: runs.slice(0, WINDOW) };
}

// Classifies the failed full runs at the merge commit. `failed` are workflow runs with their failing
// check runs at the merge commit as `jobs` (an Actions check run id is its job id).
async function classify(ctx, repo, sha, base, failed) {
  const read = reader(ctx, repo);
  const contained = await ancestors(ctx, repo, sha);
  if (contained.error) return contained;
  const windows = new Map();
  const records = [];
  for (const { run, jobs } of failed) {
    const key = workflowKey(run);
    if (!windows.has(key)) windows.set(key, await earlierRuns(ctx, repo, base, run, contained.shas));
    const window = windows.get(key);
    if (window.error) return window;
    const parent = window.runs[0] || null;
    const merged = await Promise.all(jobs.map(async (c) => {
      const tests = await read.tests(c.id);
      return { name: c.name, id: c.id, tests: tests || [], ...(tests ? {} : { log_error: true }) };
    }));
    let open = merged;
    const seenAt = new Map();
    for (const earlier of window.runs) {
      if (!open.length) break;
      if (GOOD.has(earlier.conclusion)) continue;
      const listed = await read.jobs(earlier, open.some((j) => j.tests.length));
      if (listed.error) return listed;
      for (const j of open) {
        if (explains(j, listed.items)) seenAt.set(j, { run: earlier.id, sha: earlier.head_sha.toLowerCase(), url: runUrl(repo, earlier.id) });
      }
      open = open.filter((j) => !seenAt.has(j));
    }
    records.push({
      id: run.id, workflow: key, event: run.event, attempt: run.run_attempt || 1, conclusion: run.conclusion, url: runUrl(repo, run.id),
      parent_run: parent && { id: parent.id, sha: parent.head_sha.toLowerCase(), event: parent.event, conclusion: parent.conclusion, url: runUrl(repo, parent.id) },
      earlier_runs: window.runs.length,
      jobs: merged.map((j) => ({ name: j.name, id: j.id, tests: j.tests.slice(0, NAMES),
        ...(j.tests.length > NAMES ? { tests_total: j.tests.length } : {}), ...(j.log_error ? { log_error: true } : {}),
        failed_before: seenAt.get(j) || null })),
    });
  }
  // A failed run with no failed job (only timed out or cancelled ones) cannot be compared, and stays confirmed.
  const main = records.every((r) => r.jobs.length && r.jobs.every((j) => j.failed_before));
  return { failure: { classification: main ? 'main_red' : 'confirmed', runs: records } };
}

// The classification an earlier check recorded for the same failed run attempts at this merge commit.
// Only main_red is reused: the earlier runs it found failing stay failed.
function recorded(task, sha, failed) {
  const entry = (task?.evidence || []).findLast((e) => e.type === 'ci' && sameSha(e.sha, sha)
    && sameSha(e.hotfix_ci?.merge_sha, sha) && e.hotfix_ci.failure);
  const before = entry?.hotfix_ci.failure;
  if (before?.classification !== 'main_red' || !Array.isArray(before.runs)) return null;
  const ids = (list) => list.map((r) => `${r.id}:${r.attempt}`).sort().join(',');
  return ids(before.runs) === ids(failed.map(({ run }) => ({ id: run.id, attempt: run.run_attempt || 1 }))) ? before : null;
}

// One line for the summary: which failures are main_red or new, and the parent run.
function describe(failure, base) {
  return failure.runs.map((r) => {
    const parent = r.parent_run ? `parent run ${r.parent_run.id} at ${short(r.parent_run.sha)} ${r.parent_run.conclusion}` : `no earlier ${base} run read`;
    const label = (j) => `${j.name}${j.tests.length ? ` [${listSome(j.tests, 3)}]` : ''}`;
    const fresh = r.jobs.filter((j) => !j.failed_before);
    if (!r.jobs.length) return `${r.workflow} ${r.event} run ${r.id} failed with no failed job to compare (${parent})`;
    if (!fresh.length) {
      return `${r.workflow} ${r.event} run ${r.id} failed only as ${base} already failed (${parent}): ${listSome(r.jobs.map((j) => `${label(j)} in run ${j.failed_before.run}`), 20)}`;
    }
    return `${r.workflow} ${r.event} run ${r.id} has failures new at the merge commit, not in the ${r.earlier_runs} earlier ${base} run${r.earlier_runs === 1 ? '' : 's'} read (${parent}): ${listSome(fresh.map(label), 20)}`;
  }).join('\n');
}

module.exports = { FULL_EVENTS, WINDOW, classify, recorded, describe, explains, workflowKey };
