'use strict';

// CI runs on the project base branch. Some jobs run only on pushes to the base and on the
// schedule, so a regression they catch shows after merge. The newest concluded push or schedule
// run of each workflow decides that workflow: a run that failed or was cancelled stays red until a
// later run of the same workflow is green. A cancelled run with a newer run of its workflow was
// superseded by that run and decides nothing.
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const C = require('./gates/common');
const { cleanLog, cleanOutput } = require('./ci-log-text');
const { failingTests } = require('./ci-feedback');
const { refuse } = require('./util');

const WATCHED = new Set(['push', 'schedule']);
const GREEN = new Set(['success', 'neutral', 'skipped']);

async function lines(ctx, endpoint, filter, paginate = false) {
  const r = await C.gh({ root: ctx.cwd }, ['api', endpoint, ...(paginate ? ['--paginate'] : []), '--jq', filter]);
  if (!r.ok) throw refuse(cleanLog(C.ghFailure(r, `gh api ${endpoint}`)));
  try {
    return r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw refuse(`invalid GitHub response for gh api ${endpoint}`);
  }
}

function deciding(runs) {
  const byWorkflow = new Map();
  for (const run of runs) {
    if (!Number.isInteger(run?.workflow_id) || !Number.isInteger(run.run_number)) continue;
    if (!byWorkflow.has(run.workflow_id)) byWorkflow.set(run.workflow_id, []);
    byWorkflow.get(run.workflow_id).push(run);
  }
  const out = [];
  for (const list of byWorkflow.values()) {
    list.sort((a, b) => b.run_number - a.run_number);
    // Any newer run of the workflow on the base supersedes a cancelled one, whatever its event.
    const run = list.find((r, i) => WATCHED.has(r.event) && r.status === 'completed' && !(r.conclusion === 'cancelled' && i > 0));
    if (run) out.push(run);
  }
  return out.sort((a, b) => a.workflow_id - b.workflow_id).map((run) => ({
    workflow: run.name, workflow_id: run.workflow_id, path: run.path || null, id: run.id, attempt: run.run_attempt || 1,
    number: run.run_number, event: run.event, sha: run.head_sha, conclusion: run.conclusion || 'unknown', url: run.html_url || null,
  }));
}

function key(run) {
  return `${run.workflow_id}:${run.id}:${run.attempt}:${run.conclusion}`;
}

// Failing jobs of one run attempt, each with the failing tests its log names.
async function jobs(ctx, repo, run) {
  const all = await lines(ctx, `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`, '.jobs[]', true);
  const out = [];
  for (const job of all.filter((j) => j.status === 'completed' && !GREEN.has(j.conclusion))) {
    const endpoint = `repos/${repo}/actions/jobs/${job.id}/logs`;
    const r = await C.gh({ root: ctx.cwd }, ['api', endpoint]);
    out.push({ id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url || null,
      ...(r.ok ? { tests: failingTests(cleanLog(r.stdout)) } : { tests: [], log_error: cleanLog(C.ghFailure(r, `gh api ${endpoint}`)) }) });
  }
  return out;
}

function latest(events) {
  return events.findLast((e) => e.cmd === 'main ci') || null;
}

// Reads the base branch runs and records `main ci` when its red runs change.
// Returns true when it wrote an event.
async function refresh(ctx, st) {
  const { repo, base } = st.project;
  if (!repo || !base) return false;
  const runs = await lines(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&per_page=100`, '.workflow_runs[]');
  let red = deciding(runs).filter((r) => !GREEN.has(r.conclusion));
  // A workflow whose file was removed or disabled keeps its last run forever.
  if (red.length) {
    const active = new Set((await lines(ctx, `repos/${repo}/actions/workflows?per_page=100`, '.workflows[]', true))
      .filter((w) => w.state === 'active').map((w) => w.id));
    red = red.filter((r) => active.has(r.workflow_id));
  }
  const last = latest(st.events);
  const before = last?.detail.red || [];
  if (isDeepStrictEqual(before.map(key), red.map(key))) return false;
  const known = new Map(before.map((r) => [key(r), r]));
  const detail = { base, red: [] };
  for (const run of red) detail.red.push(known.get(key(run)) || cleanOutput({ ...run, jobs: await jobs(ctx, repo, run) }));
  return S.mutate(ctx, 'main ci', (current, emit) => {
    // A concurrent reader may have recorded the same observation.
    if (isDeepStrictEqual((latest(current.events)?.detail.red || []).map(key), red.map(key))) return false;
    emit(null, detail);
    return true;
  });
}

// The recorded red runs, each with the failing tests that also failed in an earlier red run on the base.
function red(st) {
  const last = latest(st.events);
  if (!last?.detail.red?.length) return [];
  const earlier = st.events.filter((e) => e.cmd === 'main ci' && e !== last).flatMap((e) => e.detail.red || []);
  return last.detail.red.map((run) => {
    const names = [...new Set(run.jobs.flatMap((j) => j.tests.map((t) => t.name)))];
    const repeats = names.map((name) => ({ test: name, runs: [...new Set(earlier
      .filter((r) => r.id !== run.id || r.attempt !== run.attempt)
      .filter((r) => r.jobs.some((j) => j.tests.some((t) => t.name === name))).map((r) => r.id))] }))
      .filter((r) => r.runs.length);
    return { ...run, at: last.at, repeats };
  });
}

function openTask(st, text) {
  return st.tasks.tasks.find((t) => !['accepted', 'cancelled'].includes(t.status) && t.title.includes(text)) || null;
}

function runTitle(base, run) {
  return `Fix ${base} CI: ${run.workflow} run ${run.id}`;
}

function flakyTitle(base, test) {
  return `Flaky test on ${base} CI: ${test}`;
}

function describe(run) {
  const out = [`${run.workflow} run ${run.id} attempt ${run.attempt} (${run.event} at ${C.short(run.sha)}): ${run.conclusion} ${run.url || ''}`.trimEnd()];
  if (!run.jobs.length) out.push('  no failed jobs listed');
  for (const job of run.jobs) {
    const tests = job.tests.map((t) => t.name);
    out.push(`  ${job.name}: ${job.conclusion}${tests.length ? `; failing tests: ${tests.join('; ')}` : job.log_error ? `; log unavailable: ${job.log_error}` : '; no failing test names in the log'}`);
  }
  return out;
}

module.exports = { refresh, red, openTask, runTitle, flakyTitle, describe };
