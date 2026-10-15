'use strict';
// Gate `check ci ID`: GitHub check runs and check suites on the exact submitted commit. A run
// or suite that never started, was cancelled or is still going is not a pass. Review caps
// need an explicit project policy because the independent review can satisfy that requirement.
// `submitReport` makes the same judgment when a worker submits, so a red head is refused before it
// is recorded and the open inline findings reach the worker. A head whose checks are still running
// is recorded: the gate waits for them on the host, so the worker does not spend turns polling.
const { fail, short, gh, ghFailure, sameSha, listSome } = require('./common');
const Hosted = require('../ci-hosted');
const { cleanLog } = require('../ci-log-text');
const Workflow = require('../workflow-if');
const MainRed = require('./main-red');

const GOOD = new Set(['success', 'neutral', 'skipped']);
// Runs that ended on the runner's side: they never judged the change, so automation retries them once.
const INFRASTRUCTURE = new Set(['timed_out', 'cancelled', 'startup_failure']);
// A failing run that ended on the runner's side is infrastructure; a failed run is a verdict on the change; any other
// failing conclusion, such as action_required, needs the worker or the owner to act on the change.
function classify(failing) {
  if (!failing.length) return {};
  if (failing.every((c) => INFRASTRUCTURE.has(c.conclusion))) return { infrastructure_failure: true };
  if (failing.some((c) => c.conclusion === 'failure')) return { confirmed_failure: true };
  return { worker_failure: true };
}
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';
// The review app's logins carry an app suffix, so match the name within the login.
const REVUTO = /revuto/i;
// The first line of a reply that closes a finding.
const RESOLVED = /^\[resolved\]$/i;
// Where a failing job's log starts: a TAP `not ok`, a spec-reporter cross or an assertion.
const FAILURE_LINE = /\bnot ok\b|\bFAIL\b|✖|✗|AssertionError/;
// Bounds on what a refusal prints: the first failing lines of each job, and the log tail when
// no failure marker shows up.
const LOG_LINES = 8;
const LOG_TAIL = 6;
const LOG_JOBS = 3;
// A shimmed agent's gh policy (lib/shim.js) refuses gh api, which these reads need.
const POLICY_REFUSAL = /is not allowed by this agent's agent file/;
const POLICY_NOTE = "this agent's gh policy refuses gh api, so submit did not read it. The orchestrator's check ci judges the head before merge.";

function refusedByPolicy(text) {
  return POLICY_REFUSAL.test(String(text));
}

function greenRun(run) {
  return run.status === 'completed' && GOOD.has(run.conclusion);
}

// Feedback and the gate use the same exceptions; pending reviews never count as capped.
function nonblockingReason(policy, run) {
  if (policy.ignore_apps.includes(run.app)) return `ci.ignore_apps: ${run.app}`;
  if (run.status !== 'completed' || run.conclusion !== 'failure') return null;
  const output = [run.output?.title, run.output?.summary].filter((s) => typeof s === 'string').join('\n');
  const rule = policy.capped_review.find((r) => r.app === run.app && new RegExp(r.pattern, 'i').test(output));
  return rule ? `ci.capped_review: ${rule.app} /${rule.pattern}/i` : null;
}

// Every page of a list endpoint, one JSON object per element (gh prints one per line with --jq).
async function ghList(ctx, endpoint, filter) {
  const r = await gh(ctx, ['api', endpoint, '--paginate', '--jq', filter]);
  if (!r.ok) return { error: `${ghFailure(r, `gh api ${endpoint}`)}. ${CHECK_HINT}` };
  try {
    return { items: r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  } catch (e) {
    return { error: `could not read gh api ${endpoint} output: ${e.message}` };
  }
}

// A rerun or a reopened PR adds a run under the same name and app, and the older run stays listed.
// The run that started last (then the higher id) is the current one; the others are superseded.
// A run that has not started has no started_at. GitHub assigns ids in creation order, so it is current
// when its id is above the latest started run's. Each name is judged as a set, not pair by pair, so the
// order GitHub lists the runs cannot change the result.
function startedAt(c, field = 'started_at') {
  const t = Date.parse(c[field]);
  return Number.isNaN(t) ? null : t;
}

function startedIsNewer(a, b, field = 'started_at') {
  if (startedAt(a, field) !== startedAt(b, field)) return startedAt(a, field) > startedAt(b, field);
  return a.id > b.id;
}

function newest(runs, isNewer) {
  return runs.reduce((best, c) => (best == null || isNewer(c, best) ? c : best), null);
}

function currentRun(group, field = 'started_at') {
  const started = newest(group.filter((c) => startedAt(c, field) != null), (a, b) => startedIsNewer(a, b, field));
  const unstarted = newest(group.filter((c) => startedAt(c, field) == null), (a, b) => a.id > b.id);
  if (unstarted && (!started || unstarted.id > started.id)) return unstarted;
  return started;
}

function latestRuns(runs) {
  const groups = new Map();
  for (const c of runs) {
    const key = `${c.app}\n${c.name}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const latest = [];
  const superseded = [];
  for (const group of groups.values()) {
    const current = currentRun(group);
    latest.push(current);
    superseded.push(...group.filter((c) => c !== current));
  }
  return { latest, superseded };
}

// Check suites do not identify their workflow. Actions runs supply that identity even when
// the commit's check-run endpoint no longer lists the old suite's jobs.
function latestWorkflows(runs) {
  const groups = new Map();
  for (const w of runs) {
    const workflow = w.path || w.name;
    // Missing identity cannot prove that another run replaced this workflow.
    const key = workflow && w.event ? JSON.stringify([workflow, w.event]) : w;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  const latest = [];
  const superseded = [];
  for (const group of groups.values()) {
    const current = currentRun(group, 'created_at');
    latest.push(current);
    superseded.push(...group.filter((w) => w !== current).map((w) => ({ run: w, replacement: current })));
  }
  return { latest, superseded };
}

function supersededText(replaced) {
  if (!replaced.length) return '';
  return `Superseded workflow runs: ${listSome(replaced.map((w) => `${w.path || w.name} (${w.event}, run ${w.id}, ${w.status === 'completed' ? w.conclusion : w.status}, suite ${w.check_suite_id})`), 20)}`;
}

// The check runs, check suites and, when Actions reports a suite, the workflow runs at one commit.
async function fetchChecks(ctx, repo, sha, policy, { all = false, workflows: needWorkflows = false } = {}) {
  const ignore = new Set(policy.ignore_apps);
  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?${all ? 'filter=all&' : ''}per_page=100`, '.check_runs[] | {id, started_at, name, status, conclusion, app: .app.slug, suite: .check_suite.id, url: .details_url, output: {title: .output.title, summary: .output.summary, annotations_count: .output.annotations_count}}');
  if (runs.error) return { error: runs.error };
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {id, app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return { error: suites.error };
  let workflows = [];
  if (needWorkflows || !ignore.has('github-actions') && suites.items.some((s) => s.app === 'github-actions')) {
    const w = await ghList(ctx, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '.workflow_runs[] | {id, name, path, workflow_id, event, created_at, head_sha, head_branch, check_suite_id, status, conclusion, run_attempt}');
    if (w.error) return { error: w.error };
    workflows = w.items.filter((x) => sameSha(x.head_sha, sha));
  }
  return { runs: runs.items, suites: suites.items, workflows };
}

const { FULL_EVENTS } = MainRed;
const RUN_FIELDS = '{id, name, path, workflow_id, event, created_at, head_sha, head_branch, check_suite_id, status, conclusion, run_attempt}';

// The check runs and suites of the chosen workflow runs at one commit.
function suiteChecks(checks, chosen) {
  const ids = new Set(chosen.map((w) => w.check_suite_id));
  return {
    runs: checks.runs.filter((c) => c.app === 'github-actions' && ids.has(c.suite)),
    suites: checks.suites.filter((x) => x.app === 'github-actions' && ids.has(x.id)),
    workflows: chosen,
  };
}

// A required job skipped in a base run does not apply to a merged hotfix only when the skip says
// nothing about its change: the job also skipped at the merge commit itself, or its own `if:` is
// false for the run's event (a pull-request-only job). A job skipped by a path filter or another
// job's output on a later commit stays required, so a docs-only commit cannot vouch for code it never
// tested. A required job that ran must still succeed, and one that never appears is still missing.
async function hotfixPolicy(ctx, repo, policy, judged, at, mergeRuns) {
  const skipped = [];
  const files = new Map();
  const workflowText = async (w) => {
    const key = w.path;
    if (!files.has(key)) {
      const r = !w.path || w.path.startsWith('dynamic/') ? { ok: false }
        : await gh(ctx, ['api', `repos/${repo}/contents/${w.path}?ref=${at}`, '--jq', '.content']);
      files.set(key, r.ok ? Buffer.from(r.stdout.replace(/\s/g, ''), 'base64').toString('utf8') : null);
    }
    return files.get(key);
  };
  for (const name of policy.required) {
    const matches = (c) => typeof c.name === 'string' && c.name.startsWith(name);
    const matching = judged.runs.filter(matches);
    if (!matching.length || !matching.every((c) => c.status === 'completed' && c.conclusion === 'skipped')) continue;
    const atMerge = mergeRuns.filter((c) => c.app === 'github-actions' && matches(c));
    if (atMerge.length && atMerge.every((c) => c.status === 'completed' && c.conclusion === 'skipped')) {
      skipped.push({ name, why: 'skipped at the merge commit too' });
      continue;
    }
    let events = new Set();
    let byCondition = true;
    for (const c of matching) {
      const w = judged.workflows.find((x) => x.check_suite_id === c.suite);
      const text = w && await workflowText(w);
      const conditions = text ? Workflow.jobConditions(text, c.name) : null;
      if (!conditions || !conditions.every((condition) => Workflow.falseForEvent(condition, w.event))) {
        byCondition = false;
        break;
      }
      events.add(w.event);
    }
    if (byCondition) skipped.push({ name, why: `its job condition is false for ${[...events].join(', ')} runs` });
  }
  const names = new Set(skipped.map((x) => x.name));
  return { policy: { ...policy, required: policy.required.filter((name) => !names.has(name)) }, skipped };
}

// The same green that judgeHead reports: nothing failing, pending, missing or unsuccessful, and one real run.
function green(j) {
  return !j.missing.length && !j.unsuccessful.length && !j.failing.length && !j.pending.length && !j.badSuites.length
    && j.ciRuns.some((c) => !j.capped.has(c));
}

const { workflowKey } = MainRed;

// Where `head` stands against `base` in the repository's history: ahead, identical, behind or diverged.
async function compareStatus(ctx, repo, base, head) {
  const r = await gh(ctx, ['api', `repos/${repo}/compare/${base}...${head}?per_page=1`, '--jq', '.status']);
  if (!r.ok) return { error: `${ghFailure(r, `gh api compare ${short(base)}...${short(head)}`)}. ${CHECK_HINT}` };
  return { status: r.stdout.trim() };
}

// A merged hotfix is judged by the full workflow runs on its base. At the merge commit, the latest
// push workflows decide as before: a failure is a verdict on the landed change and a running one is
// pending. When those runs were cancelled (main pushes share one concurrency group, so a newer push
// replaces a pending run) or never ran, the first successful push, scheduled or manual run of the same
// workflows at the merge commit or a later commit on the base that contains it stands for them. A
// failed run or job at the merge commit itself still fails, unless every failure there is one the base
// already had (main_red, lib/gates/main-red.js): such a run is treated like a cancelled one.
async function hotfixChecks(ctx, repo, sha, base, policy, checks) {
  const onBase = checks.workflows.filter((w) => w.head_branch === base && FULL_EVENTS.has(w.event));
  const { latest } = latestWorkflows(onBase.filter((w) => w.event === 'push'));
  if (latest.length && latest.every((w) => w.check_suite_id != null && w.status === 'completed' && w.conclusion === 'success')) {
    const judged = suiteChecks(checks, latest);
    return { checks: judged, ...(await hotfixPolicy(ctx, repo, policy, judged, sha, checks.runs)) };
  }
  // A scheduled or manual run at the merge commit, or a job that failed before its run was cancelled, judged the commit too.
  const { latest: others } = latestWorkflows(onBase.filter((w) => w.event !== 'push'));
  // Every job that did not pass is compared, a timed out or cancelled one included: it is never the base's known failure.
  const failedJobs = (w) => (w.check_suite_id == null ? [] : checks.runs.filter((c) => c.app === 'github-actions'
    && c.suite === w.check_suite_id && c.status === 'completed' && !GOOD.has(c.conclusion)));
  const failed = [...latest, ...others].filter((w) => w.status === 'completed'
    && (w.conclusion === 'failure' || (w.event === 'push' && w.conclusion === 'cancelled' && failedJobs(w).some((c) => c.conclusion === 'failure'))))
    .map((run) => ({ run, jobs: failedJobs(run) }));
  let failure = null;
  if (failed.length) {
    const merge = String(sha).toLowerCase();
    failure = MainRed.recorded(ctx.task, sha, failed);
    if (!failure) {
      const c = await MainRed.classify(ctx, repo, sha, base, failed);
      if (c.error) return { error: c.error, extra: { infrastructure_failure: true } };
      failure = c.failure;
    }
    if (failure.classification !== 'main_red') {
      const what = latest.some((w) => w.status === 'completed' && w.conclusion === 'failure') ? 'push workflow not successful' : 'a full workflow run at the merge commit failed';
      return { error: `${what}\n${MainRed.describe(failure, base)}`, extra: { confirmed_failure: true, hotfix_ci: { merge_sha: merge, failure } } };
    }
  }
  const mainRed = failure ? { hotfix_ci: { merge_sha: String(sha).toLowerCase(), failure } } : {};
  if (latest.some((w) => w.status !== 'completed')) return { error: 'push workflow still running', extra: { pending: true, ...mainRed } };
  if (!latest.every((w) => w.conclusion === 'cancelled' || w.conclusion === 'failure' || (w.conclusion === 'success' && w.check_suite_id != null))) {
    return { error: 'push workflow not successful', extra: mainRed };
  }
  const later = await laterRun(ctx, repo, sha, base, policy, latest, checks.runs, failure);
  if (!failure) return later;
  return later.error ? { ...later, error: `${later.error}\n${MainRed.describe(failure, base)}` } : { ...later, failure };
}

// Each candidate commit costs two compares and three paginated listings. Five per check bounds a
// recheck of a pending hotfix to about 25 GitHub calls; the commits it rejected go into the CI
// evidence, so the next check goes on with the rest instead of repeating them.
const LATER_CANDIDATES = 5;

// Commits an earlier check of this merge commit rejected, by sha: not containing it or off the base
// for good, or not green with the listed green runs (a new green run there is looked at again).
function earlierRejections(task, sha) {
  const entry = (task?.evidence || []).findLast((e) => e.type === 'ci' && sameSha(e.sha, sha)
    && sameSha(e.hotfix_ci?.merge_sha, sha) && Array.isArray(e.hotfix_ci.rejected));
  const rejected = new Map();
  for (const r of entry?.hotfix_ci.rejected || []) {
    if (r && typeof r.sha === 'string' && Array.isArray(r.runs)) rejected.set(r.sha.toLowerCase(), r);
  }
  return rejected;
}

// The first commit at or after the merge commit on the base, oldest run first, whose full workflow
// runs are green. Each listed workflow at the merge commit must be green there; with none listed,
// every full workflow that judged that commit must be.
async function laterRun(ctx, repo, sha, base, policy, atMerge, mergeRuns, failure) {
  const workflows = [...new Set(atMerge.map(workflowKey))];
  const merge = String(sha).toLowerCase();
  const rejected = earlierRejections(ctx.task, sha);
  const record = () => ({ hotfix_ci: { merge_sha: merge, ...(failure ? { failure } : {}), rejected: [...rejected.values()] } });
  const why = failure ? `its push workflow run failed only where ${base} was already red (main_red)` : 'its push workflow run was cancelled or never ran';
  const infrastructure = (error) => ({ error, extra: { infrastructure_failure: true, ...record() } });
  let since = atMerge.map((w) => w.created_at).filter(Boolean).sort()[0];
  if (!since) {
    const c = await gh(ctx, ['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.committer.date']);
    if (!c.ok || !c.stdout.trim()) return infrastructure(`${ghFailure(c, `gh api commits/${short(sha)}`)}. ${CHECK_HINT}`);
    since = c.stdout.trim();
  }
  const listed = await ghList(ctx, `repos/${repo}/actions/runs?branch=${encodeURIComponent(base)}&created=${encodeURIComponent(`>=${since}`)}&per_page=100`, `.workflow_runs[] | ${RUN_FIELDS}`);
  if (listed.error) return infrastructure(listed.error);
  const full = listed.items.filter((w) => w.head_branch === base && FULL_EVENTS.has(w.event)
    && (!workflows.length || workflows.includes(workflowKey(w))));
  // Commits with a green run, oldest first, each with the ids of its green runs.
  const commits = new Map();
  for (const w of [...full].sort((a, b) => (startedIsNewer(a, b, 'created_at') ? 1 : -1))) {
    if (w.status !== 'completed' || w.conclusion !== 'success' || typeof w.head_sha !== 'string') continue;
    const key = w.head_sha.toLowerCase();
    commits.set(key, [...(commits.get(key) ?? []), w.id]);
  }
  let examined = 0;
  let left = 0;
  for (const [later, greenRuns] of commits) {
    const before = rejected.get(later);
    if (before && (before.reason !== 'not green' || greenRuns.every((id) => before.runs.includes(id)))) continue;
    if (examined === LATER_CANDIDATES) {
      left += 1;
      continue;
    }
    examined += 1;
    const reject = (reason) => rejected.set(later, { sha: later, runs: greenRuns, reason });
    if (later !== merge) {
      const contains = await compareStatus(ctx, repo, sha, later);
      if (contains.error) return infrastructure(contains.error);
      if (contains.status !== 'ahead') {
        reject('does not contain the merge commit');
        continue;
      }
      const kept = await compareStatus(ctx, repo, later, base);
      if (kept.error) return infrastructure(kept.error);
      if (kept.status !== 'ahead' && kept.status !== 'identical') {
        reject(`not on ${base}`);
        continue;
      }
    }
    // Every check run, not only the latest of each name: a newer cancelled run must not hide a green suite.
    const at = await fetchChecks(ctx, repo, later, policy, { all: true, workflows: true });
    if (at.error) return infrastructure(at.error);
    // The newest run of each workflow that judged the commit decides; a cancelled run judged nothing.
    const groups = new Map();
    for (const w of at.workflows.filter((x) => x.head_branch === base && FULL_EVENTS.has(x.event) && x.conclusion !== 'cancelled')) {
      groups.set(workflowKey(w), [...(groups.get(workflowKey(w)) ?? []), w]);
    }
    const chosen = (workflows.length ? workflows : [...groups.keys()]).map((key) => groups.get(key) && currentRun(groups.get(key), 'created_at'));
    if (!chosen.length || chosen.some((w) => !w || w.check_suite_id == null || w.status !== 'completed' || w.conclusion !== 'success')) {
      reject('not green');
      continue;
    }
    const judgedChecks = suiteChecks(at, chosen);
    const adjusted = await hotfixPolicy(ctx, repo, policy, judgedChecks, later, mergeRuns);
    if (!green(judge(adjusted.policy, judgedChecks))) {
      reject('not green');
      continue;
    }
    return { checks: judgedChecks, ...adjusted, satisfied: { sha: later,
      runs: chosen.map((w) => ({ id: w.id, workflow: workflowKey(w), event: w.event, url: `https://github.com/${repo}/actions/runs/${w.id}` })) } };
  }
  const running = full.some((w) => w.status !== 'completed');
  const count = rejected.size ? ` ${rejected.size} later commit${rejected.size === 1 ? '' : 's'} with a green run cannot stand for it (recorded in hotfix_ci.rejected).` : '';
  if (left) {
    return { error: `${why}; ${left} more commit${left === 1 ? '' : 's'} with a green run on ${base} wait for the next check, which goes on after the ${LATER_CANDIDATES} looked at now.${count}`,
      extra: { pending: true, ...record() } };
  }
  return { error: `${why}, and no successful push, scheduled or manual run of ${workflows.length ? listSome(workflows, 10) : 'a workflow'} on ${base} at it or a later commit that contains it ${running ? 'has finished yet' : 'exists; nothing is running on the base, so push or start a manual run'}.${count}`,
    extra: { pending: true, ...(running ? {} : { not_running: true }), ...record() } };
}

// The judgment `check ci` and submit both make on one commit's checks. Ignored apps, superseded
// runs and capped reviews are set aside here; what is left is pending, failing or green.
function judge(policy, { runs, suites, workflows }) {
  const ignore = new Set(policy.ignore_apps);
  const required = policy.required;
  // A reopened PR reruns its workflows in a new suite; an old Actions suite whose workflow run was
  // replaced by a newer one no longer counts.
  const { latest: currentWorkflows, superseded: oldWorkflows } = latestWorkflows(workflows);
  const currentActionsSuites = new Set(currentWorkflows.map((w) => w.check_suite_id));
  const knownSuites = new Set(suites.filter((s) => s.app === 'github-actions').map((s) => s.id));
  const replaced = oldWorkflows.filter(({ run: w, replacement }) => w.check_suite_id != null
    && replacement.check_suite_id != null && knownSuites.has(replacement.check_suite_id)
    && !currentActionsSuites.has(w.check_suite_id)).map(({ run: w }) => w);
  const supersededSuites = new Set(replaced.map((w) => w.check_suite_id));
  const isSuperseded = (app, suite) => app === 'github-actions' && supersededSuites.has(suite);
  const considered = runs.filter((c) => !ignore.has(c.app) && !isSuperseded(c.app, c.suite));
  const { latest: ciRuns, superseded } = latestRuns(considered);
  const ciSuites = suites.filter((x) => !ignore.has(x.app) && !isSuperseded(x.app, x.id));
  const capped = new Set(ciRuns.filter((c) => nonblockingReason(policy, c)));
  function cappedSuite(s) {
    if (s.id == null || s.status !== 'completed' || s.conclusion !== 'failure') return false;
    const linked = ciRuns.filter((c) => c.suite === s.id && c.app === s.app);
    // Require the complete suite so one cap cannot hide another workflow or an unseen failure.
    return linked.length === s.runs && linked.some((c) => capped.has(c))
      && linked.every((c) => capped.has(c) || (c.status === 'completed' && GOOD.has(c.conclusion)));
  }
  // A reopened PR reruns the workflows in a new suite; the old suite keeps its failure with no current run. Only a
  // completed failed suite counts, and only when every run it reports was read and superseded.
  const replacedSuite = (x) => {
    if (x.id == null || x.status !== 'completed' || x.conclusion !== 'failure') return false;
    if (x.app === 'github-actions' && currentActionsSuites.has(x.id)) return false;
    const linked = considered.filter((c) => c.suite === x.id && c.app === x.app);
    return linked.length > 0 && linked.length === x.runs && linked.every((c) => superseded.includes(c));
  };
  const requiredRuns = ciRuns.filter((c) => typeof c.name === 'string' && required.some((name) => c.name.startsWith(name)));
  return {
    ciRuns,
    ciSuites,
    capped,
    replaced,
    superseded: [...superseded, ...runs.filter((c) => isSuperseded(c.app, c.suite))],
    failing: ciRuns.filter((c) => c.status === 'completed' && !GOOD.has(c.conclusion) && !capped.has(c)),
    pending: ciRuns.filter((c) => c.status !== 'completed'),
    missing: required.filter((name) => !ciRuns.some((c) => typeof c.name === 'string' && c.name.startsWith(name))),
    // Required jobs must actually run; skipped jobs and review caps cannot prove CI ran.
    unsuccessful: requiredRuns.filter((c) => c.status !== 'completed' || c.conclusion !== 'success'),
    badSuites: ciSuites.filter((x) => (x.status !== 'completed' || !GOOD.has(x.conclusion)) && !cappedSuite(x) && !replacedSuite(x)),
  };
}

// CI that has nothing queued or running at a head is waiting on GitHub: a
// workflow that did not trigger, required names that never appear, a suite with
// no runs, or mergeability that stays UNKNOWN. GitHub creates check runs within
// a minute or two of a push and computes mergeability in seconds, so 30 minutes
// without a run is about 15 times the normal delay and still covers a slow
// GitHub incident. Past it the head is stalled: automation stops its per-minute
// recheck (at most 30 rechecks per head) and the orchestrator inbox shows it.
const STALL_MS = 30 * 60000;

// When the current run of pending CI with nothing running at this head and
// revision began, from the recorded evidence; null when this is the first.
// A recorded stall ends the run, so checking a stalled head starts a new window.
function idleSince(task, sha) {
  let since = null;
  const evidence = task.evidence || [];
  for (let i = evidence.length - 1; i >= 0; i--) {
    const e = evidence[i];
    if (e.type !== 'ci') continue;
    if (!sameSha(e.sha, sha) || e.revision !== task.revision || !e.pending || !e.not_running || e.stalled) break;
    since = e.at;
  }
  return since;
}

// Since when checks have been queued or running at this head and revision with
// nothing changing, or null. A recheck that reads the same pending summary
// records no evidence (lib/check.js), so the latest entry with that summary is
// when the checks last moved.
function unchangedSince(task, sha, summary) {
  const e = (task.evidence || []).findLast((x) => x.type === 'ci');
  if (!e || !sameSha(e.sha, sha) || e.revision !== task.revision || !e.pending || e.not_running || e.stalled || e.summary !== summary) return null;
  return e.at;
}

async function run(ctx) {
  const result = await judgeHead(ctx);
  if (!result.pending || result.stalled) return result;
  const late = (since) => since && Date.now() - Date.parse(since) >= STALL_MS;
  if (result.not_running) {
    const since = idleSince(ctx.task, ctx.task.sha);
    if (!late(since)) return result;
    return { ...result, stalled: true, summary: `${result.summary}\nStalled: no CI run has been queued or running at this head since ${since}. Automation stopped rechecking it. Fix the workflow trigger or push a new head, then run tower-crane check ci ${ctx.task.id}.` };
  }
  // A check an app opened and never finished, or a job no runner picks up, stays queued or
  // in progress with nothing changing; GitHub times out neither soon.
  const since = unchangedSince(ctx.task, ctx.task.sha, result.summary);
  if (!late(since)) return result;
  return { ...result, stalled: true, summary: `${result.summary}\nStalled: the checks above have been queued or running unchanged at this head since ${since}, such as an app run that crashed or a job no runner picked up. Automation stopped rechecking it. Re-run or cancel the stuck check, or push a new head, then run tower-crane check ci ${ctx.task.id}.` };
}

async function judgeHead(ctx) {
  const { task, project } = ctx;
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (!task.hotfix && project.ci?.local != null) return require('./local-ci').run(ctx);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  const { policy, error } = Hosted.resolve(project);
  if (error) return fail(error);
  const ignore = new Set(policy.ignore_apps);
  const { repo } = project;
  const sha = task.sha;
  const ref = `https://github.com/${repo}/commit/${sha}/checks`;
  // Capped review runs are recorded by name: an orchestrator may waive review only for such a reviewer.
  let cappedNames = [];
  let supersededNote = '';
  // A hotfix judged at a later commit names it, and the run that stood for the merge commit's, in its evidence.
  let hotfixExtra = {};
  let hotfixNote = '';
  const res = (ok, summary, extra = {}) => ({ ok, summary: [summary, hotfixNote, supersededNote].filter(Boolean).join('\n'), sha, ref, ...(cappedNames.length ? { capped_review: cappedNames } : {}), ...hotfixExtra, ...extra });
  // Observation errors did not judge the change, so they share the infrastructure retry.
  const observation = (summary) => res(false, summary, { infrastructure_failure: true });

  let unknownMergeability = '';
  if (task.hotfix) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'state,mergeCommit,baseRefName']);
    if (!v.ok) return observation(`${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let pr;
    try { pr = JSON.parse(v.stdout); } catch { return observation('could not read merged hotfix PR'); }
    if (pr.state !== 'MERGED' || !sameSha(pr.mergeCommit?.oid, sha) || pr.baseRefName !== task.hotfix.base) {
      return res(false, `PR #${task.pr} no longer matches the recorded hotfix merge into ${task.hotfix.base} at ${short(sha)}`);
    }
  } else if (task.pr) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'state,headRefOid,mergeable,mergeStateStatus']);
    if (!v.ok) return observation(`${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let pr;
    try {
      pr = JSON.parse(v.stdout);
    } catch (e) {
      return observation(`could not read gh pr view ${task.pr} output: ${e.message}`);
    }
    // A closed PR runs no more pull_request workflows, so its pending CI cannot finish.
    if (pr?.state === 'CLOSED') {
      return res(false, `PR #${task.pr} is closed without merging; its CI will not run. Reopen it or submit a new PR, then run tower-crane check ci ${task.id}.`, { pending: true, not_running: true, stalled: true });
    }
    const head = pr?.headRefOid;
    if (!sameSha(head, sha)) {
      return res(false, `PR head moved: PR #${task.pr} head is ${short(head)}, the task's submitted sha is ${short(sha)}. Submit the new head (tower-crane submit ${task.id} --sha ${head}) or push ${short(sha)} back, then check again.`);
    }
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      return res(false, `PR #${task.pr} is CONFLICTING (${pr.mergeStateStatus || 'unknown merge state'}): resolve merge conflicts with the base branch and submit the new head. GitHub does not run pull_request workflows on a conflicting PR.`);
    }
    if (pr.mergeable !== 'MERGEABLE' || !pr.mergeStateStatus || pr.mergeStateStatus === 'UNKNOWN') {
      unknownMergeability = `PR #${task.pr} mergeability is unknown or unavailable (${pr.mergeable || 'missing'}, ${pr.mergeStateStatus || 'missing'}); wait for GitHub to compute it, then retry tower-crane check ci ${task.id}.`;
    }
  }

  // The checks are read even while mergeability is unknown, so a completed failure still wins over pending.
  let checks = await fetchChecks(ctx, repo, sha, policy, { workflows: !!task.hotfix });
  if (checks.error) return unknownMergeability ? res(false, unknownMergeability, { pending: true, not_running: true }) : observation(checks.error);
  let judgedSha = sha;
  let judgePolicy = policy;
  if (task.hotfix) {
    // A merged hotfix is judged by the full workflows on its base at the merge commit, or a later commit when the merge commit's run was cancelled; not by PR runs.
    const pushed = await hotfixChecks(ctx, repo, sha, task.hotfix.base, policy, checks);
    if (pushed.error) return res(false, `hotfix needs successful push CI on ${task.hotfix.base} at ${short(sha)}; ${pushed.error}`, pushed.extra);
    checks = pushed.checks;
    judgePolicy = pushed.policy;
    const notes = [];
    if (pushed.satisfied) {
      judgedSha = pushed.satisfied.sha;
      hotfixExtra = { hotfix_ci: { merge_sha: String(sha).toLowerCase(), ...(pushed.failure ? { failure: pushed.failure } : {}), satisfied_by: pushed.satisfied } };
      if (pushed.failure) notes.push(MainRed.describe(pushed.failure, task.hotfix.base));
      notes.push(`The push workflow run at merge commit ${short(sha)} ${pushed.failure ? `failed only where ${task.hotfix.base} was already red (main_red)` : 'was cancelled or never ran'}; ${sameSha(judgedSha, sha) ? 'judged by' : `judged at ${short(judgedSha)} on ${task.hotfix.base}, which contains it, by`} ${pushed.satisfied.runs.map((w) => `${w.workflow} ${w.event} run ${w.id} (${w.url})`).join(', ')}`);
    }
    if (pushed.skipped.length) notes.push(`ci.required skipped in the base run and not applied: ${listSome(pushed.skipped.map((x) => `${x.name} (${x.why})`), 20)}`);
    hotfixNote = notes.join('\n');
  }
  const { ciRuns, ciSuites, capped, failing, missing, unsuccessful, pending, badSuites, replaced } = judge(judgePolicy, checks);
  // Pending CI with nothing queued or running at the head waits on GitHub, not on a runner.
  const waiting = { pending: true, ...(pending.length ? {} : { not_running: true }) };
  const judged = (result) => {
    if (!unknownMergeability || !result.ok) return result;
    return res(false, unknownMergeability, waiting);
  };
  const failedSuites = badSuites.filter((s) => s.status === 'completed');
  const failedSuiteNote = failedSuites.length
    ? `failed check suites: ${listSome(failedSuites.map((s) => `${s.app || 'unknown app'} (${s.conclusion})`), 20)}` : '';
  supersededNote = supersededText(replaced);
  cappedNames = [...capped].map((c) => `${c.name} (${c.app})`);
  const cappedNote = capped.size ? `Nonblocking capped reviews as listed in project.json ci.capped_review: ${listSome(cappedNames, 20)}` : '';
  const skipped = [...ignore].map((app) => {
    const n = checks.suites.filter((x) => x.app === app).length;
    const m = checks.runs.filter((c) => c.app === app).length;
    return n || m ? `${app} (${n} suite${n === 1 ? '' : 's'}, ${m} run${m === 1 ? '' : 's'})` : null;
  }).filter(Boolean);
  const skippedNote = skipped.length ? `Ignored as listed in project.json ci.ignore_apps: ${skipped.join(', ')}` : '';

  if (missing.length || unsuccessful.length) {
    const lines = [`CI not green at ${short(judgedSha)} in ${repo}:`];
    if (missing.length) lines.push(`missing required check runs (ci.required): ${listSome(missing, 20)}`);
    if (unsuccessful.length) lines.push(`required check runs not successful: ${listSome(unsuccessful.map((c) => `${c.name} (${c.status === 'completed' ? c.conclusion : c.status})`), 20)}`);
    if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
    lines.push(...await logSection(ctx, repo, project, [...failing, ...unsuccessful.filter((c) => c.status === 'completed' && !failing.includes(c))]));
    if (failedSuiteNote) lines.push(failedSuiteNote);
    if (skippedNote) lines.push(skippedNote);
    if (cappedNote) lines.push(cappedNote);
    lines.push(`Every ci.required name or prefix needs matching completed, successful runs at the submitted head. Fix or wait for the required workflows, then run tower-crane check ci ${task.id} again.`);
    // A required run that completed without success is a verdict on the change; missing or unfinished runs are pending.
    const verdict = failing.length ? classify(failing)
      : unsuccessful.some((c) => c.status === 'completed') || failedSuites.length
        ? { worker_failure: true } : waiting;
    return { ...res(false, lines.join('\n')), ...verdict };
  }

  if (!ciRuns.some((c) => !capped.has(c))) {
    return res(false, [`no check runs on ${short(judgedSha)} in ${repo} outside ignored apps and capped reviews; push the commit and wait for CI to start, or check that the workflows run on this branch`, failedSuiteNote, skippedNote, cappedNote].filter(Boolean).join('\n'),
      failedSuites.length ? { worker_failure: true } : waiting);
  }

  if (!failing.length && !pending.length && !badSuites.length) {
    const counts = {};
    for (const c of ciRuns) {
      const outcome = capped.has(c) ? 'capped review' : c.conclusion;
      counts[outcome] = (counts[outcome] || 0) + 1;
    }
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    return judged(res(true, [`CI green at ${short(judgedSha)} in ${repo}: ${ciRuns.length} check runs (${tally}), ${ciSuites.length} check suites completed`, skippedNote, cappedNote].filter(Boolean).join('\n')));
  }
  const lines = [`CI not green at ${short(judgedSha)} in ${repo}:`];
  if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
  lines.push(...await logSection(ctx, repo, project, failing));
  if (pending.length) lines.push(`not completed: ${listSome(pending.map((c) => `${c.name} (${c.status})`), 20)}`);
  if (badSuites.length) {
    lines.push(`check suites not green: ${listSome(badSuites.map((x) => `${x.app || 'unknown app'} (${x.status === 'completed' ? x.conclusion : x.status}, ${x.runs ?? '?'} runs)`), 20)}`);
    if (badSuites.some((x) => x.status !== 'completed' && !x.runs)) {
      lines.push('A suite with no runs is CI that has not started, or an app that never reports checks here; the owner can set ci.ignore_apps to skip such an app with tower-crane project set --ci-ignore-apps \'["APP-SLUG"]\'.');
    }
  }
  if (skippedNote) lines.push(skippedNote);
  if (cappedNote) lines.push(cappedNote);
  lines.push(`Fix or re-run what failed, wait for what is still running, then run tower-crane check ci ${task.id} again.`);
  // Unfinished runs or suites are pending; a completed suite that is not green without a failed run is a verdict on the change.
  const verdict = failing.length ? classify(failing)
    : failedSuites.length ? { worker_failure: true } : waiting;
  return { ...res(false, lines.join('\n')), ...verdict };
}

function jobId(url) {
  return /\/job\/(\d+)/.exec(url || '')?.[1] ?? null;
}

// The first failing lines of one job's log, from its failed steps. gh prefixes each line with
// the job and step names and a timestamp; those are dropped.
async function failedLines(ctx, repo, job) {
  const r = await gh(ctx, ['run', 'view', '--job', job, '-R', repo, '--log-failed']);
  if (!r.ok) return [`(log unavailable: ${cleanLog(ghFailure(r, 'gh run view'))})`];
  const lines = cleanLog(r.stdout).split('\n').map((line) => {
    const parts = line.split('\t');
    return (parts.length >= 3 ? parts.slice(2).join('\t') : line).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').trimEnd();
  }).filter((line) => line.trim());
  const at = lines.findIndex((line) => FAILURE_LINE.test(line));
  return at < 0 ? lines.slice(-LOG_TAIL) : lines.slice(at, at + LOG_LINES);
}

// The first failing lines of the first failing jobs that link a job log, and the command that reads
// each other one. Submit's refusal and the gate's summary, which rework carries to the worker, print the same section.
// A required run that was skipped or neutral has no failed step to show. The lines go into evidence, events,
// notes and the brief, so they pass the redactor the tests, clean and local CI gates use.
async function logSection(ctx, repo, project, failed) {
  const lines = [];
  const logged = failed.filter((x) => !GOOD.has(x.conclusion) && jobId(x.url));
  const redact = logged.length ? require('./tests').diagnosticRedactor(project, ctx.root) : null;
  for (const f of logged.slice(0, LOG_JOBS)) {
    lines.push(`${f.name} log:`, ...(await failedLines(ctx, repo, jobId(f.url))).map((l) => `  ${redact(l)}`));
  }
  for (const f of logged.slice(LOG_JOBS)) {
    lines.push(`${f.name} log not shown; read it with gh run view --job ${jobId(f.url)} --log-failed -R ${repo}`);
  }
  return lines;
}

// The PR's mergeability as GitHub computes it, read the way `check ci` reads it.
async function prMergeability(ctx, repo, pr) {
  const r = await gh(ctx, ['pr', 'view', String(pr), '-R', repo, '--json', 'mergeable,mergeStateStatus']);
  if (!r.ok) return { error: `${ghFailure(r, `gh pr view ${pr}`)}. ${CHECK_HINT}` };
  try {
    return JSON.parse(r.stdout) || {};
  } catch (e) {
    return { error: `could not read gh pr view ${pr} output: ${e.message}` };
  }
}

// The review app's open inline findings on the PR: its top-level comments on a line still in the
// diff. A reply closes one only when the latest reply from anyone else starts with `[resolved]` on
// its own line, so a question or a new objection after a resolution keeps the finding open.
async function revutoFindings(ctx, repo, pr) {
  const comments = await ghList(ctx, `repos/${repo}/pulls/${pr}/comments?per_page=100`, '.[] | {id, in_reply_to_id, path, line, body, user: .user.login, original_commit_id}');
  if (comments.error) return { error: comments.error };
  const latest = new Map();
  for (const c of comments.items) {
    if (c.in_reply_to_id == null || REVUTO.test(c.user || '')) continue;
    if (!latest.has(c.in_reply_to_id) || c.id > latest.get(c.in_reply_to_id).id) latest.set(c.in_reply_to_id, c);
  }
  const resolved = (id) => RESOLVED.test(String(latest.get(id)?.body || '').split(/\r?\n/)[0].trim());
  const findings = comments.items
    .filter((c) => c.in_reply_to_id == null && REVUTO.test(c.user || '') && c.path && c.line != null && !resolved(c.id))
    .map((c) => ({ id: c.id, path: c.path, line: c.line, body: String(c.body || '').trimEnd(),
      severity: require('../reviewer').SEVERITY.exec(c.body || '')?.[1] || null, commit: c.original_commit_id || null, resolved: false, changed: false }));
  return { findings };
}

// Submit's check of the PR's CI at the head being submitted, before the head is recorded.
// Failing checks refuse, with the first failing lines of each failing job. Pending checks do not:
// the head is recorded, `pending` names them, and `check ci` waits for them on the host. A worker
// that polled CI before submitting re-read its whole context on every poll. `report` lists the
// pending checks, the capped reviews and the open inline findings and is printed whether or not the
// submit is refused. A project with no repo or local CI has no GitHub checks to read here.
async function submitReport(ctx, project, { sha, pr, taskId }) {
  if (!pr || !project.repo || project.ci?.local != null) return { refusal: null, report: '' };
  const { policy, error } = Hosted.resolve(project);
  if (error) return { refusal: error, report: '' };
  const repo = project.repo;
  const feedbackHint = `Read check output, annotations and code-scanning alerts with tower-crane ci checks ${taskId || '--task ID'} before asking the orchestrator.`;
  // A conflicting PR gets no pull_request checks, so waiting for them would never end, and a head
  // that cannot be checked is not submitted. This is the same read `check ci` makes before it reads
  // the checks.
  const mergeability = await prMergeability(ctx, repo, pr);
  if (mergeability.error && !refusedByPolicy(mergeability.error)) return { refusal: mergeability.error, report: '' };
  if (mergeability.error) return { refusal: null, report: `CI at ${short(sha)} in ${repo} was not checked: ${POLICY_NOTE}` };
  if (mergeability.mergeable === 'CONFLICTING' || mergeability.mergeStateStatus === 'DIRTY') {
    return { refusal: `PR #${pr} is CONFLICTING (${mergeability.mergeStateStatus || 'unknown merge state'}): resolve merge conflicts with the base branch and submit the new head. GitHub does not run pull_request workflows on a conflicting PR.`, report: '' };
  }
  const checks = await fetchChecks(ctx, repo, sha, policy);
  if (checks.error && !refusedByPolicy(checks.error)) return { refusal: checks.error, report: '' };
  if (checks.error) return { refusal: null, report: `CI at ${short(sha)} in ${repo} was not checked: ${POLICY_NOTE}` };
  const j = judge(policy, checks);

  const mergeabilityPending = mergeability.mergeable !== 'MERGEABLE' || !mergeability.mergeStateStatus || mergeability.mergeStateStatus === 'UNKNOWN'
    ? [`PR #${pr} mergeability (${mergeability.mergeable || 'missing'}, ${mergeability.mergeStateStatus || 'missing'})`] : [];
  const pending = [
    ...mergeabilityPending,
    ...j.pending.map((c) => `${c.name} (${c.status})`),
    ...j.missing.map((name) => `${name} (not started)`),
    ...j.badSuites.filter((x) => x.status !== 'completed').map((x) => `${x.app || 'unknown app'} suite (${x.status})`),
  ];
  if (!pending.length && !j.ciRuns.some((c) => !j.capped.has(c))) pending.push(`no check runs on ${short(sha)} outside ignored apps and capped reviews yet`);
  const failed = [
    ...j.failing.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    ...j.unsuccessful.filter((c) => c.status === 'completed' && !j.failing.includes(c)).map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url })),
    ...j.badSuites.filter((x) => x.status === 'completed').map((x) => ({ name: `${x.app || 'unknown app'} suite`, conclusion: x.conclusion })),
  ];

  const found = await revutoFindings(ctx, repo, pr);
  if (found.error && !refusedByPolicy(found.error)) return { refusal: found.error, report: '' };
  const report = [];
  if (found.error) report.push(`revuto's inline findings on PR #${pr} were not read: ${POLICY_NOTE}`);
  if (j.capped.size) report.push(`Nonblocking capped reviews as listed in project.json ci.capped_review: ${listSome([...j.capped].map((c) => `${c.name} (${c.app})`), 20)}`);
  if (j.replaced.length) report.push(supersededText(j.replaced));
  if (found.findings?.length) {
    const n = found.findings.length;
    report.push(`revuto left ${n} open inline finding${n === 1 ? '' : 's'} on PR #${pr} (listed for you; a [P1]/[P2] one blocks the submit until its path changes after the comment or it has a [resolved] reply):`);
    for (const f of found.findings) report.push(`  ${f.path}:${f.line}`, ...f.body.split(/\r?\n/).map((l) => `    ${l}`));
  }
  const reportText = report.join('\n');

  if (failed.length) {
    const lines = [`CI failed at ${short(sha)} in ${repo}: fix the failing checks, push, and submit again.`,
      `failing: ${listSome(failed.map((f) => `${f.name} (${f.conclusion})`), 20)}`];
    lines.push(...await logSection(ctx, repo, project, failed));
    if (pending.length) lines.push(`not completed: ${listSome(pending, 20)}`);
    lines.push(feedbackHint);
    return { refusal: lines.join('\n'), report: reportText };
  }
  if (pending.length) {
    const waiting = `CI still running at ${short(sha)} in ${repo}: ${listSome(pending, 20)}. The head is submitted and tower-crane check ci waits for these checks on the host; a failure comes back as rework with the failing jobs and their first failing lines. Do not wait for CI.`;
    return { refusal: null, report: [waiting, reportText].filter(Boolean).join('\n'), pending, findings: found.findings || [] };
  }
  return { refusal: null, report: reportText, findings: found.findings || [] };
}

module.exports = { run, submitReport, greenRun, nonblockingReason, fetchChecks, judge };
