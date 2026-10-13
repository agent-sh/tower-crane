'use strict';
// Gate `check ci ID`: GitHub check runs and check suites on the exact submitted commit. A run
// or suite that never started, was cancelled or is still going is not a pass. Review caps
// need an explicit project policy because the independent review can satisfy that requirement.
// `submitReport` makes the same judgment when a worker submits, so a head that is still running
// or red is refused before it is recorded, and the open inline findings reach the worker.
const { fail, short, gh, ghFailure, sameSha, listSome } = require('./common');
const Hosted = require('../ci-hosted');

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
// The orchestrator allows a submit with CI still running by writing this line in the brief. A fenced
// code block opens with a run of three or more backticks or tildes; only a bare run of the same kind closes it.
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const FORCE_PENDING = /^[ \t]*(?:[-*][ \t]+)?force-ci-pending:[ \t]*allowed[ \t]*$/im;
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
async function fetchChecks(ctx, repo, sha, policy, { all = false } = {}) {
  const ignore = new Set(policy.ignore_apps);
  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?${all ? 'filter=all&' : ''}per_page=100`, '.check_runs[] | {id, started_at, name, status, conclusion, app: .app.slug, suite: .check_suite.id, url: .details_url, output: {title: .output.title, summary: .output.summary, annotations_count: .output.annotations_count}}');
  if (runs.error) return { error: runs.error };
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {id, app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return { error: suites.error };
  let workflows = [];
  if (!ignore.has('github-actions') && suites.items.some((s) => s.app === 'github-actions')) {
    const w = await ghList(ctx, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '.workflow_runs[] | {id, name, path, event, created_at, head_sha, check_suite_id, status, conclusion}');
    if (w.error) return { error: w.error };
    workflows = w.items.filter((x) => sameSha(x.head_sha, sha));
  }
  return { runs: runs.items, suites: suites.items, workflows };
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

async function run(ctx) {
  const { task, project } = ctx;
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (project.ci?.local != null) return require('./local-ci').run(ctx);
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
  const res = (ok, summary, extra = {}) => ({ ok, summary: [summary, supersededNote].filter(Boolean).join('\n'), sha, ref, ...(cappedNames.length ? { capped_review: cappedNames } : {}), ...extra });
  // Observation errors did not judge the change, so they share the infrastructure retry.
  const observation = (summary) => res(false, summary, { infrastructure_failure: true });

  if (task.pr) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'headRefOid,mergeable,mergeStateStatus']);
    if (!v.ok) return observation(`${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let pr;
    try {
      pr = JSON.parse(v.stdout);
    } catch (e) {
      return observation(`could not read gh pr view ${task.pr} output: ${e.message}`);
    }
    const head = pr?.headRefOid;
    if (!sameSha(head, sha)) {
      return res(false, `PR head moved: PR #${task.pr} head is ${short(head)}, the task's submitted sha is ${short(sha)}. Submit the new head (tower-crane submit ${task.id} --sha ${head}) or push ${short(sha)} back, then check again.`);
    }
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      return res(false, `PR #${task.pr} is CONFLICTING (${pr.mergeStateStatus || 'unknown merge state'}): resolve merge conflicts with the base branch and submit the new head. GitHub does not run pull_request workflows on a conflicting PR.`);
    }
    if (pr.mergeable !== 'MERGEABLE' || !pr.mergeStateStatus || pr.mergeStateStatus === 'UNKNOWN') {
      return observation(`PR #${task.pr} mergeability is unknown or unavailable (${pr.mergeable || 'missing'}, ${pr.mergeStateStatus || 'missing'}); wait for GitHub to compute it, then retry tower-crane check ci ${task.id}.`);
    }
  }

  const checks = await fetchChecks(ctx, repo, sha, policy);
  if (checks.error) return observation(checks.error);
  const { ciRuns, ciSuites, capped, failing, missing, unsuccessful, pending, badSuites, replaced } = judge(policy, checks);
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
    const lines = [`CI not green at ${short(sha)} in ${repo}:`];
    if (missing.length) lines.push(`missing required check runs (ci.required): ${listSome(missing, 20)}`);
    if (unsuccessful.length) lines.push(`required check runs not successful: ${listSome(unsuccessful.map((c) => `${c.name} (${c.status === 'completed' ? c.conclusion : c.status})`), 20)}`);
    if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
    if (skippedNote) lines.push(skippedNote);
    if (cappedNote) lines.push(cappedNote);
    lines.push(`Every ci.required name or prefix needs matching completed, successful runs at the submitted head. Fix or wait for the required workflows, then run tower-crane check ci ${task.id} again.`);
    // A required run that completed without success is a verdict on the change; missing or unfinished runs are pending.
    const verdict = failing.length ? classify(failing) : unsuccessful.some((c) => c.status === 'completed') ? { worker_failure: true } : { pending: true };
    return { ...res(false, lines.join('\n')), ...verdict };
  }

  if (!ciRuns.some((c) => !capped.has(c))) {
    return { ...res(false, [`no check runs on ${short(sha)} in ${repo} outside ignored apps and capped reviews; push the commit and wait for CI to start, or check that the workflows run on this branch`, skippedNote, cappedNote].filter(Boolean).join('\n')), pending: true };
  }

  if (!failing.length && !pending.length && !badSuites.length) {
    const counts = {};
    for (const c of ciRuns) {
      const outcome = capped.has(c) ? 'capped review' : c.conclusion;
      counts[outcome] = (counts[outcome] || 0) + 1;
    }
    const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    return res(true, [`CI green at ${short(sha)} in ${repo}: ${ciRuns.length} check runs (${tally}), ${ciSuites.length} check suites completed`, skippedNote, cappedNote].filter(Boolean).join('\n'));
  }
  const lines = [`CI not green at ${short(sha)} in ${repo}:`];
  if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
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
  const verdict = failing.length ? classify(failing) : pending.length || badSuites.some((x) => x.status !== 'completed') ? { pending: true } : { worker_failure: true };
  return { ...res(false, lines.join('\n')), ...verdict };
}

function jobId(url) {
  return /\/job\/(\d+)/.exec(url || '')?.[1] ?? null;
}

// The first failing lines of one job's log, from its failed steps. gh prefixes each line with
// the job and step names and a timestamp; those are dropped.
async function failedLines(ctx, repo, job) {
  const r = await gh(ctx, ['run', 'view', '--job', job, '-R', repo, '--log-failed']);
  if (!r.ok) return [`(log unavailable: ${ghFailure(r, 'gh run view')})`];
  const lines = r.stdout.split(/\r?\n/).map((line) => {
    const parts = line.split('\t');
    return (parts.length >= 3 ? parts.slice(2).join('\t') : line).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').trimEnd();
  }).filter((line) => line.trim());
  const at = lines.findIndex((line) => FAILURE_LINE.test(line));
  return at < 0 ? lines.slice(-LOG_TAIL) : lines.slice(at, at + LOG_LINES);
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
  const comments = await ghList(ctx, `repos/${repo}/pulls/${pr}/comments?per_page=100`, '.[] | {id, in_reply_to_id, path, line, body, user: .user.login}');
  if (comments.error) return { error: comments.error };
  const latest = new Map();
  for (const c of comments.items) {
    if (c.in_reply_to_id == null || REVUTO.test(c.user || '')) continue;
    if (!latest.has(c.in_reply_to_id) || c.id > latest.get(c.in_reply_to_id).id) latest.set(c.in_reply_to_id, c);
  }
  const resolved = (id) => RESOLVED.test(String(latest.get(id)?.body || '').split(/\r?\n/)[0].trim());
  const findings = comments.items
    .filter((c) => c.in_reply_to_id == null && REVUTO.test(c.user || '') && c.path && c.line != null && !resolved(c.id))
    .map((c) => ({ path: c.path, line: c.line, body: String(c.body || '').trimEnd() }));
  return { findings };
}

// Submit's check of the PR's CI at the head being submitted, before the head is recorded.
// Failing checks always refuse, with the first failing lines of each failing job. Pending checks
// refuse unless `forcePending` is set (the caller checks the brief allows it); a forced submit
// reports the pending names in `forcedPending`. `report` lists the capped reviews and the open
// inline findings and is printed whether or not the submit is refused. A project with no repo or local
// CI has no GitHub checks to read here.
async function submitReport(ctx, project, { sha, pr, forcePending, taskId }) {
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
    report.push(`revuto left ${n} open inline finding${n === 1 ? '' : 's'} on PR #${pr} (listed for you; they do not block the submit):`);
    for (const f of found.findings) report.push(`  ${f.path}:${f.line}`, ...f.body.split(/\r?\n/).map((l) => `    ${l}`));
  }
  const reportText = report.join('\n');

  if (failed.length) {
    const lines = [`CI failed at ${short(sha)} in ${repo}: fix the failing checks, push, and submit again.`,
      `failing: ${listSome(failed.map((f) => `${f.name} (${f.conclusion})`), 20)}`];
    const logged = failed.filter((x) => jobId(x.url));
    for (const f of logged.slice(0, LOG_JOBS)) {
      lines.push(`${f.name} log:`, ...(await failedLines(ctx, repo, jobId(f.url))).map((l) => `  ${l}`));
    }
    for (const f of logged.slice(LOG_JOBS)) {
      lines.push(`${f.name} log not shown; read it with gh run view --job ${jobId(f.url)} --log-failed -R ${repo}`);
    }
    if (pending.length) lines.push(`not completed: ${listSome(pending, 20)}`);
    lines.push(feedbackHint);
    return { refusal: lines.join('\n'), report: reportText };
  }
  if (pending.length && !forcePending) {
    return { refusal: `CI is still running at ${short(sha)} in ${repo}: wait for CI to finish, then submit again.\npending: ${listSome(pending, 20)}\n${feedbackHint}`, report: reportText };
  }
  if (pending.length) {
    return { refusal: null, report: [`CI still pending at ${short(sha)}, submitted with --force-ci-pending (the brief allows it): ${listSome(pending, 20)}`, reportText].filter(Boolean).join('\n'), forcedPending: pending };
  }
  return { refusal: null, report: reportText };
}

// The brief without its fenced code blocks and HTML comments: a quoted or hidden example of the
// permission line is not approval. A fence or comment that never closes runs to the end of the
// brief, so nothing after it counts.
function activeText(briefText) {
  let fence = null;
  return String(briefText || '').split(/\r?\n/).filter((line) => {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
      return false;
    }
    if (m) {
      fence = m[1];
      return false;
    }
    return true;
  }).join('\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

// Whether the brief lets a worker submit with CI still pending.
function forcePendingAllowed(briefText) {
  return FORCE_PENDING.test(activeText(briefText));
}

module.exports = { run, submitReport, forcePendingAllowed, greenRun, nonblockingReason, fetchChecks, judge };
