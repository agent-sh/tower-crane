'use strict';

// CI runs on the project base branch. Some jobs run only on pushes to the base, the schedule and
// manual dispatch, so a regression they catch shows after merge. The newest concluded run of each
// workflow decides that workflow: a run that failed or was cancelled stays red until a later run
// of the same workflow is green. A cancelled run with a newer run of its workflow was superseded
// by that run and decides nothing.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const C = require('./gates/common');
const { stripEscapes, cleanOutput } = require('./ci-log-text');
const { failingTests } = require('./ci-feedback');
const { refuse } = require('./util');

const WATCHED = new Set(['push', 'schedule', 'workflow_dispatch']);
const GREEN = new Set(['success', 'neutral', 'skipped']);
// The follower refreshes inbox once a minute; a read in between reuses the last one.
const REUSE_MS = 60000;
// Workflow files change rarely; the active list is reread hourly and only while something is red.
const WORKFLOWS_MS = 3600000;
// The base's newest runs. Superseded queued runs pile up between deciding runs, so 30 covers several
// pushes of every workflow, and GitHub answers 30 runs about as fast as 10.
const RUNS = 30;

// gh runs as a child process the event loop waits on, so these reads overlap each other and the
// synchronous per-PR reads of the same inbox.
function ghContext(ctx) {
  return { root: ctx.cwd, exec: C.treeExec };
}

async function lines(ctx, endpoint, filter, paginate = false) {
  const r = await C.gh(ghContext(ctx), ['api', endpoint, ...(paginate ? ['--paginate'] : []), '--jq', filter]);
  if (!r.ok) throw refuse(stripEscapes(C.ghFailure(r, `gh api ${endpoint}`)));
  try {
    return r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw refuse(`invalid GitHub response for gh api ${endpoint}`);
  }
}

function summary(run) {
  return { workflow: run.name, workflow_id: run.workflow_id, path: run.path || null, id: run.id, attempt: run.run_attempt || 1,
    number: run.run_number, event: run.event, sha: run.head_sha, conclusion: run.conclusion || 'unknown', url: run.html_url || null };
}

// The red run of each workflow. A workflow with no deciding run in the listing keeps its recorded
// red run: it fell out of the window, or its red run is being rerun.
function decide(runs, previous) {
  const byWorkflow = new Map();
  for (const run of runs) {
    if (!Number.isInteger(run?.workflow_id) || !Number.isInteger(run.run_number)) continue;
    if (!byWorkflow.has(run.workflow_id)) byWorkflow.set(run.workflow_id, []);
    byWorkflow.get(run.workflow_id).push(run);
  }
  const red = [];
  for (const before of previous) if (!byWorkflow.has(before.workflow_id)) red.push(before);
  for (const [workflow, list] of byWorkflow) {
    list.sort((a, b) => b.run_number - a.run_number);
    const before = previous.find((r) => r.workflow_id === workflow);
    let decided = null;
    for (const [i, run] of list.entries()) {
      // A rerun of the recorded red run is still red until its new attempt concludes.
      if (run.status !== 'completed') {
        if (before && run.id === before.id) { decided = before; break; }
        continue;
      }
      if (!WATCHED.has(run.event) || (run.conclusion === 'cancelled' && i > 0)) continue;
      decided = summary(run);
      break;
    }
    if (!decided) decided = before || null;
    if (decided && !GREEN.has(decided.conclusion)) red.push(decided);
  }
  return red.sort((a, b) => a.workflow_id - b.workflow_id);
}

function key(run) {
  return `${run.workflow_id}:${run.id}:${run.attempt}:${run.conclusion}`;
}

function keys(red) {
  return red.map(key);
}

// Failing jobs of one run attempt, each with the failing tests its log names.
async function jobs(ctx, repo, run) {
  const all = await lines(ctx, `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`, '.jobs[]', true);
  return Promise.all(all.filter((j) => j.status === 'completed' && !GREEN.has(j.conclusion)).map(async (job) => {
    const endpoint = `repos/${repo}/actions/jobs/${job.id}/logs`;
    // Runner logs echo each step command in color; gh refuses them without this flag.
    const r = await C.gh(ghContext(ctx), ['api', endpoint, '--allow-escape-sequences']);
    return { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url || null,
      ...(r.ok ? { tests: failingTests(stripEscapes(r.stdout)) } : { tests: [], log_error: stripEscapes(C.ghFailure(r, `gh api ${endpoint}`)) }) };
  }));
}

// `events` is the log, or a snapshot's indexed reads of it (st.log).
function recorded(events, base) {
  return require('./tasks').select(events, { cmds: ['main ci'] }).filter((e) => e.cmd === 'main ci' && e.detail.base === base);
}

function cacheFile(ctx) {
  return path.join(ctx.stateDir, 'main-ci-cache.json');
}

function readCache(ctx) {
  try { return JSON.parse(fs.readFileSync(cacheFile(ctx), 'utf8')) || {}; }
  catch { return {}; }
}

// A stamp from the future is not fresh, so a bad clock or a planted file cannot stop the reads.
function fresh(at, ms, now) {
  const t = Date.parse(at);
  return Number.isFinite(t) && t <= now && now - t < ms;
}

// Reads the base branch runs and records `main ci` when its red runs change. A read younger than a
// minute is reused. Returns true when it wrote an event.
async function refresh(ctx, st) {
  const { repo, base } = st.project;
  if (!repo || !base) return false;
  const now = Date.now();
  const cache = readCache(ctx);
  const same = cache.repo === repo && cache.base === base;
  if (same && fresh(cache.read_at, REUSE_MS, now)) return false;
  const started = new Date(now).toISOString();
  const before = recorded(st.log || st.events, base).at(-1)?.detail.red || [];
  const runs = await lines(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&per_page=${RUNS}`, '.workflow_runs[]');
  let red = decide(runs, before);
  let workflows = same && fresh(cache.workflows_at, WORKFLOWS_MS, now) && Array.isArray(cache.workflows) ? cache.workflows : null;
  let workflowsAt = workflows ? cache.workflows_at : null;
  // Jobs and logs of new red runs are read while the workflow list loads.
  const known = new Map(before.map((r) => [key(r), r]));
  const details = Promise.all(red.map(async (run) => known.get(key(run)) || cleanOutput({ ...run, jobs: await jobs(ctx, repo, run) })));
  details.catch(() => {});
  // A workflow whose file was removed or disabled keeps its last run forever.
  if (red.length && !workflows) {
    workflows = (await lines(ctx, `repos/${repo}/actions/workflows?per_page=100`, '.workflows[]', true))
      .filter((w) => w.state === 'active').map((w) => w.id);
    workflowsAt = started;
  }
  const kept = red.map((r) => !workflows || workflows.includes(r.workflow_id));
  red = red.filter((r, i) => kept[i]);
  let wrote = false;
  if (!isDeepStrictEqual(keys(before), keys(red))) {
    const detail = { base, read_at: started, red: (await details).filter((r, i) => kept[i]) };
    wrote = S.mutate(ctx, 'main ci', (current, emit) => {
      const last = recorded(current.log || current.events, base).at(-1);
      // A reader that started later already recorded a newer observation.
      if (last && (last.detail.read_at || last.at) > started) return false;
      if (isDeepStrictEqual(keys(last?.detail.red || []), keys(red))) return false;
      emit(null, detail);
      return true;
    });
  }
  S.writeAtomic(cacheFile(ctx), JSON.stringify({ repo, base, read_at: started, workflows, workflows_at: workflowsAt }));
  return wrote;
}

function testNames(run) {
  return run.jobs.flatMap((j) => j.tests.map((t) => t.name));
}

// A test is flaky when it failed in an earlier red run of the workflow and a green run lies between
// that failure and this one. Attempts of one run count as one run.
function flaky(events, run) {
  const history = [];
  for (const e of events) {
    const r = e.detail.red.find((x) => x.workflow_id === run.workflow_id);
    const last = history.at(-1);
    if (!r) {
      if (last?.red) history.push({ green: true });
    } else if (last?.red && last.id === r.id) {
      for (const name of testNames(r)) last.tests.add(name);
    } else history.push({ red: true, id: r.id, tests: new Set(testNames(r)) });
  }
  const current = history.at(-1);
  const out = [];
  for (const test of current?.tests || []) {
    const earlier = [];
    let green = false;
    for (const h of history.slice(0, -1).reverse()) {
      if (h.green) green = true;
      else if (green && h.tests.has(test)) earlier.unshift(h.id);
    }
    if (earlier.length) out.push({ test, runs: earlier });
  }
  return out;
}

// The recorded red runs on the current base, each with its flaky tests.
function red(st) {
  const events = recorded(st.log || st.events, st.project.base);
  const last = events.at(-1);
  if (!last?.detail.red?.length) return [];
  return last.detail.red.map((run) => ({ ...run, at: last.at, repeats: flaky(events, run) }));
}

function open(st) {
  return st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status));
}

function runTitle(base, run) {
  return `Fix ${base} CI: ${run.workflow} (workflow ${run.workflow_id}), red since run ${run.id}`;
}

// The fix task names its base and workflow id, so later red runs of that workflow refer to it.
function fixTask(st, run) {
  const prefix = `Fix ${st.project.base} CI: `;
  const token = new RegExp(`(?<![\\w])workflow ${run.workflow_id}(?![\\w])`);
  return open(st).find((t) => t.title.startsWith(prefix) && token.test(t.title)) || null;
}

function flakyTitle(base, test) {
  return `Flaky test on ${base} CI: ${test}`;
}

function flakyTask(st, test) {
  const title = flakyTitle(st.project.base, test);
  return open(st).find((t) => t.title === title) || null;
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

module.exports = { refresh, red, runTitle, fixTask, flakyTitle, flakyTask, describe };
