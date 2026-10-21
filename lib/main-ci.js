'use strict';

// CI runs on the project base branch. Some jobs run only on pushes to the base, the schedule and
// manual dispatch, so a regression they catch shows after merge. The newest concluded run decides
// each workflow's full runs (schedule and manual) and, apart from them, its push runs: a run that
// failed or was cancelled stays red until a later run of the same kind is green. Push runs keep
// their last completed verdict even while a newer push runs, so a pending run cannot erase a failure.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const C = require('./gates/common');
const { stripEscapes, cleanOutput } = require('./ci-log-text');
const { failingTests } = require('./ci-feedback');
const { refuse } = require('./util');

const WATCHED = new Set(['push', 'schedule', 'workflow_dispatch']);
// The events that run a workflow's full test matrix on the base. Main pushes run only a thin check
// (.github/workflows/ci.yml), so a release reads these instead.
const FULL = ['schedule', 'workflow_dispatch'];
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
  return { root: ctx.cwd || ctx.root, exec: ctx.exec || C.treeExec };
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

// A workflow's full runs (schedule and manual) and its push runs decide apart: main pushes run a
// thin check, so a green push says nothing about a red daily full run.
function lane(run) {
  return `${run.workflow_id}:${FULL.includes(run.event) ? 'full' : 'push'}`;
}

// The red run of each workflow lane. A lane with no deciding run in the listing keeps its recorded
// red run: it fell out of the window, or its red run is being rerun.
function decide(runs, previous) {
  const byLane = new Map();
  for (const run of runs) {
    if (!Number.isInteger(run?.workflow_id) || !Number.isInteger(run.run_number)) continue;
    if (!byLane.has(lane(run))) byLane.set(lane(run), []);
    byLane.get(lane(run)).push(run);
  }
  const red = [];
  for (const before of previous) if (!byLane.has(lane(before))) red.push(before);
  for (const [key, list] of byLane) {
    list.sort((a, b) => b.run_number - a.run_number);
    const before = previous.find((r) => lane(r) === key);
    let decided = null;
    for (const [i, run] of list.entries()) {
      // A rerun of the recorded red run is still red until its new attempt concludes.
      if (run.status !== 'completed') {
        if (before && run.id === before.id) { decided = before; break; }
        continue;
      }
      if (!WATCHED.has(run.event) || (run.event !== 'push' && run.conclusion === 'cancelled' && i > 0)) continue;
      decided = summary(run);
      break;
    }
    if (!decided) decided = before || null;
    if (decided && !GREEN.has(decided.conclusion)) red.push(decided);
  }
  return red.sort((a, b) => a.workflow_id - b.workflow_id || (lane(a) < lane(b) ? -1 : 1));
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

function recorded(events, base) {
  return events.filter((e) => e.cmd === 'main ci' && e.detail.base === base);
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
  const prior = recorded(st.events, base).at(-1)?.detail;
  const before = prior?.red || [];
  const [runs, branch] = await Promise.all([
    lines(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&per_page=${RUNS}`, '.workflow_runs[]'),
    lines(ctx, `repos/${repo}/branches/${encodeURIComponent(base)}`, '.commit'),
  ]);
  const head = branch[0]?.sha;
  if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/i.test(head)) throw refuse(`could not read ${base}'s current head`);
  let push = latestPush(runs, prior?.push || before.filter((r) => r.event === 'push'));
  let red = decide(runs, before).filter((r) => r.event !== 'push' || !push.some((p) => p.workflow_id === r.workflow_id
    && GREEN.has(p.conclusion) && (p.number > r.number || (p.number === r.number && p.attempt > r.attempt))));
  let workflows = same && fresh(cache.workflows_at, WORKFLOWS_MS, now) && Array.isArray(cache.workflows) ? cache.workflows : null;
  let workflowsAt = workflows ? cache.workflows_at : null;
  // Jobs and logs of new red runs are read while the workflow list loads.
  const known = new Map(before.map((r) => [key(r), r]));
  const details = Promise.all(red.map(async (run) => known.get(key(run)) || cleanOutput({ ...run, jobs: await jobs(ctx, repo, run) })));
  details.catch(() => {});
  // A workflow whose file was removed or disabled keeps its last run forever.
  if ((red.length || push.some((r) => !GREEN.has(r.conclusion))) && !workflows) {
    workflows = (await lines(ctx, `repos/${repo}/actions/workflows?per_page=100`, '.workflows[]', true))
      .filter((w) => w.state === 'active').map((w) => w.id);
    workflowsAt = started;
  }
  const kept = red.map((r) => !workflows || workflows.includes(r.workflow_id));
  red = red.filter((r, i) => kept[i]);
  push = push.filter((r) => !workflows || workflows.includes(r.workflow_id));
  const detailedRed = (await details).filter((r, i) => kept[i]);
  const detailedByKey = new Map(detailedRed.map((r) => [key(r), r]));
  let wrote = false;
  const pushDetails = Promise.all(push.map(async (run) => {
    if (GREEN.has(run.conclusion)) return run;
    return detailedByKey.get(key(run)) || known.get(key(run)) || prior?.push?.find((r) => key(r) === key(run))
      || cleanOutput({ ...run, jobs: await jobs(ctx, repo, run) });
  }));
  pushDetails.catch(() => {});
  if (!isDeepStrictEqual(keys(before), keys(red)) || prior?.head !== head
    || !isDeepStrictEqual(keys(prior?.push || []), keys(push))) {
    const detail = { base, head, read_at: started, red: detailedRed, push: await pushDetails };
    wrote = S.mutate(ctx, 'main ci', (current, emit) => {
      const last = recorded(current.events, base).at(-1);
      // A reader that started later already recorded a newer observation.
      if (last && (last.detail.read_at || last.at) > started) return false;
      if (last?.detail.head === head && isDeepStrictEqual(keys(last?.detail.red || []), keys(red))
        && isDeepStrictEqual(keys(last?.detail.push || []), keys(push))) return false;
      emit(null, detail);
      return true;
    });
  }
  await pushDetails;
  S.writeAtomic(cacheFile(ctx), JSON.stringify({ repo, base, read_at: started, workflows, workflows_at: workflowsAt }));
  return wrote;
}

// A pending newer push does not turn the latest completed push green.
function latestPush(runs, previous = []) {
  const selected = new Map(previous.map((r) => [r.workflow_id, r]));
  const completed = runs.filter((r) => r.event === 'push' && r.status === 'completed'
    && Number.isInteger(r.workflow_id) && Number.isInteger(r.run_number) && Number.isInteger(r.id))
    .sort((a, b) => a.run_number - b.run_number);
  for (const r of completed) {
    const before = selected.get(r.workflow_id);
    if (!before || r.run_number > before.number
      || (r.run_number === before.number && (r.run_attempt || 1) >= before.attempt)) selected.set(r.workflow_id, summary(r));
  }
  return [...selected.values()].sort((a, b) => a.workflow_id - b.workflow_id);
}

function pushFailures(st) {
  const detail = recorded(st.events, st.project.base).at(-1)?.detail;
  return (detail?.push || detail?.red?.filter((r) => r.event === 'push') || []).filter((r) => !GREEN.has(r.conclusion));
}

// The run that decides a workflow's full verdict: its newest completed full run, by run number and
// attempt. A cancelled run checked nothing, so an older one decides past it.
function newestFull(runs, workflow) {
  return runs.filter((r) => r.workflow_id === workflow && FULL.includes(r.event) && r.status === 'completed'
    && r.conclusion !== 'cancelled' && Number.isInteger(r.run_number))
    .sort((a, b) => b.run_number - a.run_number || (b.run_attempt || 1) - (a.run_attempt || 1))[0] || null;
}

// Whether sha is commit or a descendant of it, by GitHub's compare of the two.
async function atOrAfter(ctx, repo, commit, sha) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha)) return false;
  if (C.sameSha(sha, commit)) return true;
  const [status] = await lines(ctx, `repos/${repo}/compare/${commit}...${sha}`, '.status');
  return status === 'ahead' || status === 'identical';
}

// Releases always read CI again, even when inbox has a fresh cache. A workflow with full runs on the
// base (schedule or manual dispatch) is judged by its newest completed one: it must be green, and at
// or after the base head this read finds, the commit the release ships or merges onto. Any other
// workflow keeps the push rule: its latest completed base push must be green.
async function releaseFailure(ctx, project) {
  const { repo, base } = project;
  if (!repo) return null;
  try {
    const observation = ctx.stateDir ? recorded(S.loadState(ctx.stateDir).events, base).at(-1)?.detail : null;
    const completed = observation?.push || observation?.red?.filter((r) => r.event === 'push') || [];
    const branch = encodeURIComponent(base);
    const [runs, workflows, tip, ...listed] = await Promise.all([
      lines(ctx, `repos/${repo}/actions/runs?branch=${branch}&event=push&status=completed&per_page=100`, '.workflow_runs[]'),
      lines(ctx, `repos/${repo}/actions/workflows?per_page=100`, '.workflows[]', true),
      lines(ctx, `repos/${repo}/branches/${branch}`, '.commit'),
      ...FULL.map((event) => lines(ctx, `repos/${repo}/actions/runs?branch=${branch}&event=${event}&status=completed&per_page=100`, '.workflow_runs[]')),
    ]);
    if (workflows.some((w) => !Number.isInteger(w?.id) || typeof w.state !== 'string')) throw refuse('invalid GitHub workflow response');
    const head = tip[0]?.sha;
    if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/i.test(head)) throw refuse(`could not read ${base}'s current head`);
    const active = workflows.filter((w) => w.state === 'active');
    const selected = latestPush(runs);
    const full = listed.flat();
    const fullFailed = [];
    const pushWorkflows = [];
    await Promise.all(active.map(async (w) => {
      let decided = newestFull(full, w.id);
      // Workflows can fall outside the shared run window; their own history answers for them.
      if (!decided) {
        decided = newestFull((await Promise.all(FULL.map((event) => lines(ctx,
          `repos/${repo}/actions/workflows/${w.id}/runs?branch=${branch}&event=${event}&status=completed&per_page=20`, '.workflow_runs[]')))).flat(), w.id);
      }
      if (!decided) {
        pushWorkflows.push(w);
        return;
      }
      const run = summary(decided);
      const where = `${run.workflow} ${run.event} run ${run.id}${run.url ? ` (${run.url})` : ''}`;
      if (!GREEN.has(run.conclusion)) fullFailed.push(`${where}: ${run.conclusion}`);
      else if (!(await atOrAfter(ctx, repo, head, run.sha))) {
        fullFailed.push(`${where} is at ${C.short(run.sha || 'unknown')}, before ${base} head ${C.short(head)}; run it on ${base} (gh workflow run ${path.basename(w.path || String(w.id))} --ref ${base} -R ${repo})`);
      }
    }));
    const push = (await Promise.all(pushWorkflows.map(async (w) => {
      let run = selected.find((r) => r.workflow_id === w.id);
      if (!run) {
        const older = await lines(ctx, `repos/${repo}/actions/workflows/${w.id}/runs?branch=${branch}&event=push&status=completed&per_page=1`, '.workflow_runs[]');
        run = latestPush(older).find((r) => r.workflow_id === w.id);
      }
      // A rerun temporarily removes its run from the completed listing.
      // Its recorded completed attempt still decides until a newer one ends.
      const before = completed.find((r) => r.workflow_id === w.id);
      return before && (!run || before.number > run.number
        || (before.number === run.number && before.attempt > run.attempt)) ? before : run || null;
    }))).filter(Boolean);
    const failed = push.filter((r) => !GREEN.has(r.conclusion));
    const reasons = [
      ...(failed.length ? [`${base} push CI is not green: ${failed.map((r) => `${r.workflow} run ${r.id}: ${r.conclusion}${r.url ? ` (${r.url})` : ''}`).join('; ')}`] : []),
      ...(fullFailed.length ? [`${base} full CI has no green run at or after ${C.short(head)}: ${fullFailed.sort().join('; ')}`] : []),
    ];
    return reasons.length ? `${reasons.join('; ')}; release refused` : null;
  } catch (e) {
    return `${base} CI could not be read: ${e.message}; release refused`;
  }
}

function testNames(run) {
  return run.jobs.flatMap((j) => j.tests.map((t) => t.name));
}

// A test is flaky when it failed in an earlier red run of the workflow and a green run lies between
// that failure and this one. Attempts of one run count as one run.
function flaky(events, run) {
  const history = [];
  for (const e of events) {
    const r = e.detail.red.find((x) => lane(x) === lane(run));
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
  const events = recorded(st.events, st.project.base);
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

module.exports = { refresh, red, runTitle, fixTask, flakyTitle, flakyTask, describe, latestPush, pushFailures, releaseFailure };
