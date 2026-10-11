'use strict';
// Gate `check ci ID`: GitHub check runs and check suites on the exact submitted commit. A run
// or suite that never started, was cancelled or is still going is not a pass. Review caps
// need an explicit project policy because the independent review can satisfy that requirement.
const { fail, short, gh, ghFailure, sameSha, listSome } = require('./common');
const Hosted = require('../ci-hosted');

const GOOD = new Set(['success', 'neutral', 'skipped']);
const CHECK_HINT = 'Check project.repo, that the commit is pushed, and gh auth status.';

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
function startedAt(c) {
  const t = Date.parse(c.started_at);
  return Number.isNaN(t) ? null : t;
}

function startedIsNewer(a, b) {
  if (startedAt(a) !== startedAt(b)) return startedAt(a) > startedAt(b);
  return a.id > b.id;
}

function newest(runs, isNewer) {
  return runs.reduce((best, c) => (best == null || isNewer(c, best) ? c : best), null);
}

function currentRun(group) {
  const started = newest(group.filter((c) => startedAt(c) != null), startedIsNewer);
  const unstarted = newest(group.filter((c) => startedAt(c) == null), (a, b) => a.id > b.id);
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

async function run(ctx) {
  const { task, project } = ctx;
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (project.ci?.local != null) return require('./local-ci').run(ctx);
  if (!project.repo) return fail('project.json has no repo; set "repo" to "owner/name"');
  const { policy, error } = Hosted.resolve(project);
  if (error) return fail(error);
  const ignore = new Set(policy.ignore_apps);
  const caps = policy.capped_review.map((rule) => ({ app: rule.app, pattern: new RegExp(rule.pattern, 'i') }));
  const required = policy.required;
  const { repo } = project;
  const sha = task.sha;
  const ref = `https://github.com/${repo}/commit/${sha}/checks`;
  // Capped review runs are recorded by name: an orchestrator may waive review only for such a reviewer.
  let cappedNames = [];
  const res = (ok, summary) => ({ ok, summary, sha, ref, ...(cappedNames.length ? { capped_review: cappedNames } : {}) });

  if (task.pr) {
    const v = await gh(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'headRefOid,mergeable,mergeStateStatus']);
    if (!v.ok) return res(false, `${ghFailure(v, `gh pr view ${task.pr}`)}. ${CHECK_HINT}`);
    let pr;
    try {
      pr = JSON.parse(v.stdout);
    } catch (e) {
      return res(false, `could not read gh pr view ${task.pr} output: ${e.message}`);
    }
    const head = pr?.headRefOid;
    if (!sameSha(head, sha)) {
      return res(false, `PR head moved: PR #${task.pr} head is ${short(head)}, the task's submitted sha is ${short(sha)}. Submit the new head (tower-crane submit ${task.id} --sha ${head}) or push ${short(sha)} back, then check again.`);
    }
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      return res(false, `PR #${task.pr} is CONFLICTING (${pr.mergeStateStatus || 'unknown merge state'}): resolve merge conflicts with the base branch and submit the new head. GitHub does not run pull_request workflows on a conflicting PR.`);
    }
    if (pr.mergeable !== 'MERGEABLE' || !pr.mergeStateStatus || pr.mergeStateStatus === 'UNKNOWN') {
      return res(false, `PR #${task.pr} mergeability is unknown or unavailable (${pr.mergeable || 'missing'}, ${pr.mergeStateStatus || 'missing'}); wait for GitHub to compute it, then retry tower-crane check ci ${task.id}.`);
    }
  }

  const runs = await ghList(ctx, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '.check_runs[] | {id, started_at, name, status, conclusion, app: .app.slug, suite: .check_suite.id, output: {title: .output.title, summary: .output.summary}}');
  if (runs.error) return res(false, runs.error);
  const suites = await ghList(ctx, `repos/${repo}/commits/${sha}/check-suites?per_page=100`, '.check_suites[] | {id, app: .app.slug, status, conclusion, runs: .latest_check_runs_count}');
  if (suites.error) return res(false, suites.error);

  const considered = runs.items.filter((c) => !ignore.has(c.app));
  const { latest: ciRuns, superseded } = latestRuns(considered);
  const ciSuites = suites.items.filter((x) => !ignore.has(x.app));
  const capped = new Set(ciRuns.filter((c) => {
    if (c.status !== 'completed' || c.conclusion !== 'failure') return false;
    const output = [c.output?.title, c.output?.summary].filter((s) => typeof s === 'string').join('\n');
    return caps.some((r) => r.app === c.app && r.pattern.test(output));
  }));
  cappedNames = [...capped].map((c) => `${c.name} (${c.app})`);
  const cappedNote = capped.size ? `Nonblocking capped reviews as listed in project.json ci.capped_review: ${listSome(cappedNames, 20)}` : '';
  function cappedSuite(s) {
    if (s.id == null || s.status !== 'completed' || s.conclusion !== 'failure') return false;
    const linked = ciRuns.filter((c) => c.suite === s.id && c.app === s.app);
    // Require the complete suite so one cap cannot hide another workflow or an unseen failure.
    return linked.length === s.runs && linked.some((c) => capped.has(c))
      && linked.every((c) => capped.has(c) || (c.status === 'completed' && GOOD.has(c.conclusion)));
  }
  const skipped = [...ignore].map((app) => {
    const n = suites.items.filter((x) => x.app === app).length;
    const m = runs.items.filter((c) => c.app === app).length;
    return n || m ? `${app} (${n} suite${n === 1 ? '' : 's'}, ${m} run${m === 1 ? '' : 's'})` : null;
  }).filter(Boolean);
  const skippedNote = skipped.length ? `Ignored as listed in project.json ci.ignore_apps: ${skipped.join(', ')}` : '';

  const failing = ciRuns.filter((c) => c.status === 'completed' && !GOOD.has(c.conclusion) && !capped.has(c));
  const confirmedFailure = failing.some((c) => c.conclusion === 'failure') ? { confirmed_failure: true } : {};
  const missing = required.filter((name) => !ciRuns.some((c) => typeof c.name === 'string' && c.name.startsWith(name)));
  const requiredRuns = ciRuns.filter((c) => typeof c.name === 'string' && required.some((name) => c.name.startsWith(name)));
  // Required jobs must actually run; skipped jobs and review caps cannot prove CI ran.
  const unsuccessful = requiredRuns.filter((c) => c.status !== 'completed' || c.conclusion !== 'success');
  if (missing.length || unsuccessful.length) {
    const lines = [`CI not green at ${short(sha)} in ${repo}:`];
    if (missing.length) lines.push(`missing required check runs (ci.required): ${listSome(missing, 20)}`);
    if (unsuccessful.length) lines.push(`required check runs not successful: ${listSome(unsuccessful.map((c) => `${c.name} (${c.status === 'completed' ? c.conclusion : c.status})`), 20)}`);
    if (failing.length) lines.push(`failing: ${listSome(failing.map((c) => `${c.name} (${c.conclusion})`), 20)}`);
    if (skippedNote) lines.push(skippedNote);
    if (cappedNote) lines.push(cappedNote);
    lines.push(`Every ci.required name or prefix needs matching completed, successful runs at the submitted head. Fix or wait for the required workflows, then run tower-crane check ci ${task.id} again.`);
    return { ...res(false, lines.join('\n')), ...confirmedFailure };
  }

  if (!ciRuns.some((c) => !capped.has(c))) {
    return res(false, [`no check runs on ${short(sha)} in ${repo} outside ignored apps and capped reviews; push the commit and wait for CI to start, or check that the workflows run on this branch`, skippedNote, cappedNote].filter(Boolean).join('\n'));
  }
  const pending = ciRuns.filter((c) => c.status !== 'completed');
  // A reopened PR reruns the workflows in a new suite; the old suite keeps its failure with no current run. Only a
  // completed failed suite counts, and only when every run it reports was read and superseded.
  const replacedSuite = (x) => {
    if (x.id == null || x.status !== 'completed' || x.conclusion !== 'failure') return false;
    const linked = considered.filter((c) => c.suite === x.id && c.app === x.app);
    return linked.length > 0 && linked.length === x.runs && linked.every((c) => superseded.includes(c));
  };
  const badSuites = ciSuites.filter((x) => (x.status !== 'completed' || !GOOD.has(x.conclusion)) && !cappedSuite(x) && !replacedSuite(x));

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
  return { ...res(false, lines.join('\n')), ...confirmedFailure };
}

module.exports = { run };
