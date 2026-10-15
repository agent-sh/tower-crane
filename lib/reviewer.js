'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const cp = require('./commands');
const L = require('./ladder');
const { refuse, shaMatch } = require('./util');

// One short patch and a handful of files can be checked without a repository tour.
const DEFAULTS = { small_lines: 100, small_files: 5, risk_paths: [], churn_after: 3, min_rung: null };
// The lowest rung a review starts on. 'review' starts on the review rung itself.
const MIN_RUNGS = [...L.TIERS, 'review'];
const REVIEW_FLOOR = L.TIERS.indexOf('hard');
const RATE_KEYS = ['input', 'cache_write', 'cache_read', 'output'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

function errors(config) {
  if (config === undefined) return [];
  if (!object(config)) return ['review must be an object'];
  const errs = [];
  for (const key of Object.keys(config)) if (![...Object.keys(DEFAULTS), 'prices'].includes(key)) errs.push(`unknown review field ${key}`);
  for (const key of ['small_lines', 'small_files']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) errs.push(`review.${key} must be a non-negative safe integer`);
  }
  if (config.churn_after !== undefined && (!Number.isSafeInteger(config.churn_after) || config.churn_after < 1)) {
    errs.push('review.churn_after must be a positive safe integer');
  }
  if (config.risk_paths !== undefined && (!Array.isArray(config.risk_paths) || !config.risk_paths.every((s) => typeof s === 'string' && s.trim()))) {
    errs.push('review.risk_paths must be an array of non-blank globs');
  }
  if (config.min_rung !== undefined && !MIN_RUNGS.includes(config.min_rung)) {
    errs.push(`review.min_rung must be one of ${MIN_RUNGS.join(', ')}`);
  }
  if (config.prices !== undefined) {
    if (!object(config.prices)) errs.push('review.prices must be a model price table');
    else {
      const identities = new Set();
      for (const [model, rates] of Object.entries(config.prices)) {
        const identity = L.routeIdentity(model);
        if (!model.trim() || !object(rates) || RATE_KEYS.some((key) => !Number.isFinite(rates[key]) || rates[key] < 0)
          || Object.keys(rates).some((key) => !RATE_KEYS.includes(key))) {
          errs.push(`review.prices.${model} needs non-negative input, cache_write, cache_read and output rates per million tokens`);
          continue;
        }
        if (identities.has(identity)) errs.push(`review.prices has more than one entry for model ${identity}`);
        identities.add(identity);
      }
    }
  }
  return errs;
}

function canonicalPolicy(config) {
  if (!object(config) || !object(config.prices)) return config;
  const prices = Object.fromEntries(Object.entries(config.prices)
    .map(([model, rates]) => [L.routeIdentity(model), rates]));
  return { ...config, prices };
}

function modelOf(rung, env = process.env) {
  if (rung.harness === 'command') return L.routeIdentity(L.identity(rung));
  if (rung.model) {
    const model = L.routeIdentity(rung.model);
    const provider = require('./claude-provider');
    if (provider.selected(rung)) return L.routeIdentity(provider.model(rung.provider, model));
    return L.routeIdentity(rung.harness === 'claude' ? provider.release(model) : model);
  }
  if (rung.harness === 'codex' && rung.profile) {
    const home = require('./agents').origin(env).codex;
    const TOML = require('./toml');
    let standalone = false;
    for (const file of [`${rung.profile}.config.toml`, 'config.toml']) {
      try {
        const doc = TOML.parse(fs.readFileSync(path.join(home, file), 'utf8'));
        if (file !== 'config.toml') standalone = true;
        const profile = doc.profiles?.[rung.profile];
        const model = file === 'config.toml'
          ? (profile || standalone) && (profile?.model || doc.model)
          : doc.model;
        if (typeof model === 'string' && model) return L.routeIdentity(model);
      } catch {
        // Profiles without a readable model keep their configured identity.
      }
    }
  }
  return L.routeIdentity(rung.profile || '');
}

function builderOf(st, task, layers, env) {
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === task.submitted_by && e.detail.role === 'worker');
  return modelOf(spawn?.detail.route || L.rungOf(layers, task.tier), env);
}

function reReview(st, task) {
  const T = require('./tasks');
  const eligible = (e) => e.type === 'review' && T.eligibleGateEvidence(task, e, st.events);
  let review = task.evidence.findLast((e) => e.revision === task.revision && eligible(e));
  let rework;
  if (!review) {
    rework = st.events.findLast((e) => e.task === task.id && e.cmd === 'rework');
    if (!rework || rework.detail.revision !== task.revision) return null;
    review = task.evidence.findLast((e) => e.revision === rework.detail.previous_revision
      && shaMatch(e.sha, rework.detail.sha) && eligible(e));
  }
  if (!review || review.ok || review.waived) return null;
  // A requirements edit starts a full review even when it does not bump revision.
  const recorded = st.events.findLastIndex((e) => e.task === task.id && e.cmd === 'evidence'
    && e.agent === review.agent && e.at >= review.at && e.detail.type === 'review' && e.detail.ok === review.ok
    && e.detail.revision === review.revision && shaMatch(e.detail.sha, review.sha));
  if (recorded < 0 || rework && recorded > st.events.indexOf(rework)) return null;
  if (st.events.slice(recorded + 1).some((e) => e.task === task.id
    && (e.cmd === 'brief set' || e.cmd === 'task update'
      && ['acceptance', 'depends_on', 'needs', 'kind'].some((key) => Object.hasOwn(e.detail, key))))) return null;
  return { sha: review.sha, revision: review.revision, agent: review.agent,
    summary: review.summary, ref: review.ref, reason: rework?.detail.reason || null };
}

function diffOf(repo, project, task, reviewScope = null) {
  const reviewInput = reviewScope;
  const git = (args, allowNonAncestor = false) => {
    try {
      return cp.execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (allowNonAncestor && error.status === 1) return null;
      throw refuse(`${task.id}: cannot read the submitted diff; fetch ${project.base} and ${task.sha} before review`);
    }
  };
  const sha = git(['rev-parse', '--verify', `${task.sha}^{commit}`]).trim();
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const stat = (from) => {
    const files = git([...args, '--name-only', '-z', from, sha]).split('\0').filter(Boolean);
    const stats = git([...args, '--numstat', '-z', from, sha]).split('\0').filter(Boolean);
    const lines = stats.reduce((n, line) => {
      const [add, del] = line.split('\t');
      return n + (Number(add) || 0) + (Number(del) || 0);
    }, 0);
    return { files, lines, binary: stats.some((line) => line.startsWith('-\t')) };
  };
  const refs = project.base.startsWith('origin/') ? [project.base] : [project.base, `origin/${project.base}`];
  let base = task.hotfix ? git(['rev-parse', '--verify', `${task.hotfix.base_sha}^{commit}`]).trim() : null;
  for (const ref of task.hotfix ? [] : refs) {
    let candidate;
    try { candidate = git(['merge-base', ref, sha]).trim(); } catch { continue; }
    if (!base) base = candidate;
    else if (candidate !== base) {
      try {
        git(['merge-base', '--is-ancestor', base, candidate]);
        base = candidate;
      } catch {
        // Keep the nearer base already found on a different history.
      }
    }
  }
  if (!base) throw refuse(`${task.id}: cannot read the submitted diff; fetch ${project.base} before review`);
  let reviewFallback = null;
  let whole = null;
  if (reviewScope) {
    let reviewedSha = null;
    try {
      reviewedSha = git(['rev-parse', '--verify', `${reviewScope.sha}^{commit}`]).trim();
    } catch {
      // A force-pushed and collected or deleted commit cannot be fetched back.
    }
    // Rewritten histories and base updates can mix upstream changes into the diff.
    if (!reviewedSha) {
      reviewFallback = `The earlier reviewed SHA ${reviewScope.sha} is no longer in the repository.`;
    } else if (git(['merge-base', '--is-ancestor', reviewedSha, sha], true) === null) {
      reviewFallback = `The earlier reviewed SHA ${reviewScope.sha} is not an ancestor of ${sha}.`;
    } else if (git(['merge-base', '--is-ancestor', base, reviewedSha], true) === null) {
      reviewFallback = `The project base advanced since the earlier review at ${reviewScope.sha}.`;
    }
    if (reviewFallback) reviewScope = null;
    else {
      // Routing measures the whole change, so a narrowed review keeps its risk and size.
      whole = stat(base);
      base = reviewedSha;
    }
  }
  return { sha, base, ...stat(base), text: git([...args, base, sha]), submitted_sha: task.sha, project_base: project.base,
    review_scope: reviewScope, review_input: reviewInput, review_fallback: reviewFallback, whole,
    tree: require('./scope').tree(repo.root, [base, sha]) };
}

function checkedDiff(diff, project, task, reviewScope = null) {
  if (diff.submitted_sha !== task.sha || diff.project_base !== project.base
    || !isDeepStrictEqual(diff.review_input, reviewScope)) {
    throw refuse(`${task.id}: submitted head, base or review scope changed after diff preparation; retry review dispatch`);
  }
  return diff;
}

function reviewSnapshot(st, task) {
  const T = require('./tasks');
  const latest = (revision) => task.evidence.findLast((e) => e.type === 'review' && e.revision === revision
    && T.eligibleGateEvidence(task, e, st.events)) || null;
  const current = latest(task.revision);
  if (current) return current;
  // A changelog correction arrives as the next revision, after rework --from-review
  // of the failed review at its own head. Any other revision change needs a full review.
  const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id && e.detail.revision === task.revision);
  // A bump skips the numbers a restore retired, so the revision before is the next live one down.
  const retired = new Set(T.retiredRevisions(st.events, task.id));
  let before = task.revision - 1;
  while (retired.has(before)) before -= 1;
  if (!rework?.detail.from_review || rework.detail.previous_revision !== before) return null;
  const previous = latest(before);
  return previous && shaMatch(previous.sha, rework.detail.sha) ? previous : null;
}

function lightCheck(task, repo, review) {
  const F = require('./review-findings');
  if (!review || review.ok !== false || !F.proseOnly(review.findings)) return null;
  if (shaMatch(review.sha, task.sha)) return { review, diff: '' };
  // A wording commit can change only the changelog fragments the reviewer named.
  const allowed = new Set(review.findings.map((f) => f.path).filter(F.changelogPath));
  if (!allowed.size) return null;
  try {
    const git = (args) => cp.execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', timeout: 60000,
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', review.sha, task.sha];
    const files = git([...args, '--name-only', '-z']).split('\0').filter(Boolean);
    if (!files.length || files.some((file) => !allowed.has(file))) return null;
    return { review, diff: git(args) };
  } catch {
    return null;
  }
}

function prepareLight(st, task, repo, diff) {
  diff.review_snapshot = reviewSnapshot(st, task);
  diff.light = lightCheck(task, repo, diff.review_snapshot);
  return diff;
}

function checkedLight(st, task, diff) {
  if (!isDeepStrictEqual(diff.review_snapshot, reviewSnapshot(st, task))) {
    throw refuse(`${task.id}: review changed after light-check preparation; retry review dispatch`);
  }
  return diff;
}

function softwareReport(st, task, preparedCI) {
  const report = require('./tasks').gateReport(task, st.events, st, preparedCI);
  const gates = report.gates.filter((g) => g.type !== 'review');
  return { ok: !!task.sha && gates.every((g) => g.ok), gates, missing: gates.filter((g) => !g.ok).map((g) => `${g.type}: ${g.reason}`) };
}

function cost(entry, rates) {
  if (!rates || ['input', 'cached', 'output'].some((key) => !Number.isSafeInteger(entry[key]) || entry[key] < 0)) return null;
  const fresh = entry.input - entry.cached;
  if (fresh < 0 || (entry.cache_write != null && (!Number.isSafeInteger(entry.cache_write) || entry.cache_write < 0 || entry.cache_write > fresh))) return null;
  // Older inclusive telemetry cannot separate cache writes. Price that part at
  // the higher rate so missing write accounting cannot make a model look cheap.
  const inputCost = entry.cache_write == null
    ? fresh * Math.max(rates.input, rates.cache_write)
    : (fresh - entry.cache_write) * rates.input + entry.cache_write * rates.cache_write;
  return (inputCost + entry.cached * rates.cache_read + entry.output * rates.output) / 1000000;
}

// Keep configured rows apart so provider and context premiums survive loading
// and saving a price table.
function rateTable(prices) {
  return new Map(Object.entries(prices || {}).map(([model, rates]) => [L.routeIdentity(model), rates]));
}

// An exact configured row wins. Without one, a Claude provider, context or
// version variant falls back to its canonical model's row.
function rateFor(model, rates) {
  return rates.get(L.routeIdentity(model)) ?? rates.get(L.modelIdentity(model));
}

// Claude aliases resolve to their release and provider route before pricing.
function entryModel(entry) {
  if (!entry.model) return null;
  return L.routeIdentity(entry.harness === 'claude' ? modelOf(entry) : entry.model);
}

// What an entry costs at the rates from rateTable. A run on several models
// prices each model's own counts, and a model without a rate leaves it unpriced.
function entryCost(entry, rates) {
  if (!entry.models) return cost(entry, rateFor(entryModel(entry), rates));
  let total = 0;
  for (const row of entry.models) {
    const usd = cost(row, rateFor(row.model, rates));
    if (usd === null) return null;
    total += usd;
  }
  return total;
}

function medians(st, prices, env) {
  const samples = new Map();
  const ratesByModel = rateTable(prices);
  for (const task of st.tasks.tasks) for (const entry of task.spend.entries || []) {
    // A running reviewer's partial reading is not its cost until exit finalizes it.
    // A run on several models is not one model's sample.
    if (entry.agent === task.submitted_by || entry.live || entry.models) continue;
    const spawn = st.events.find((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === entry.agent && e.detail.role === 'reviewer');
    if (entry.rung !== 'review' && !spawn) continue;
    const model = entry.model || modelOf({ harness: entry.harness, profile: entry.profile }, env);
    const identity = entry.harness === 'claude'
      ? modelOf({ harness: entry.harness, provider: entry.provider, model }, env)
      : L.routeIdentity(model);
    const value = cost(entry, rateFor(identity, ratesByModel));
    if (value === null || !Number.isFinite(value)) continue;
    if (!samples.has(identity)) samples.set(identity, []);
    samples.get(identity).push(value);
  }
  return new Map([...samples].map(([model, values]) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return [model, values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2];
  }));
}

function choose(st, task, layers, diff, env) {
  const config = { ...DEFAULTS, ...st.project.review };
  const builder = builderOf(st, task, layers, env);
  const { globToRegExp } = require('./gates/tests');
  // A light claim check reads the claims and the changelog correction, not the
  // PR diff, so the PR's size and risk paths do not raise its rung. The
  // min_rung and failed-review floors below still apply.
  const changes = diff.light ? [] : [diff, diff.whole].filter(Boolean);
  const risk = changes.some((c) => c.binary || config.risk_paths.some((glob) => c.files.some((file) => globToRegExp(glob).test(file))));
  const broad = changes.some((c) => c.lines > config.small_lines || c.files.length > config.small_files);
  let level = L.TIERS.indexOf(task.tier);
  if (broad) level = Math.max(level, 1);
  if (risk) level = Math.max(level, 2);
  if (L.TIERS.includes(config.min_rung)) level = Math.max(level, L.TIERS.indexOf(config.min_rung));
  if (diff.review_scope) {
    // A narrowed re-review never runs below the review it follows up.
    const failed = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && e.detail.agent === diff.review_scope.agent && shaMatch(e.detail.sha, diff.review_scope.sha)
      && e.detail.revision === diff.review_scope.revision);
    for (const name of [failed?.detail.review_rung, failed?.detail.review_level]) {
      level = Math.max(level, L.TIERS.indexOf(name));
    }
  }
  const failures = task.evidence.filter((e) => e.type === 'review' && !e.ok && !require('./review-findings').proseOnly(e.findings)
    && e.revision === task.revision && shaMatch(e.sha, task.sha)
    && require('./tasks').eligibleGateEvidence(task, e, st.events));
  level += failures.length;
  for (const failure of failures) {
    const prior = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.agent === failure.agent
      && e.detail.role === 'reviewer' && shaMatch(e.detail.sha, task.sha) && e.detail.revision === task.revision);
    const rank = L.TIERS.indexOf(prior?.detail.review_rung);
    if (rank >= 0) level = Math.max(level, rank + 1);
  }
  level = Math.min(L.TIERS.length - 1, level);
  // A review rung minimum never yields a tier below hard: the review rung's
  // own fallbacks are the weaker models it may drop to.
  const reviewFirst = config.min_rung === 'review';
  const from = reviewFirst ? Math.max(level, REVIEW_FLOOR) : level;
  const candidates = L.TIERS.slice(from).map((name) => ({ name, rung: L.rungOf(layers, name) }))
    .filter((c) => !L.rungErrors(c.name, layers.ladder[c.name], layers).length);
  const fallback = { name: 'review', rung: L.rungOf(layers, 'review') };
  const canFallback = !L.rungErrors('review', layers.ladder.review, layers).length;
  // It starts on the review rung and stays there after failed reviews until
  // the failure rules reach hard.
  let selected = reviewFirst && canFallback && (!failures.length || level < REVIEW_FLOOR) ? fallback : candidates[0];
  if (!selected) selected = canFallback ? fallback : null;
  if (!selected) throw refuse(`${task.id}: no runnable reviewer rung at or above ${L.TIERS[from]} and no runnable review fallback`);
  const costs = medians(st, config.prices, env);
  let current = costs.get(L.routeIdentity(modelOf(selected.rung, env)));
  for (const candidate of candidates) {
    if (selected.name === 'review' || L.TIERS.indexOf(candidate.name) <= L.TIERS.indexOf(selected.name)) continue;
    if (L.routeIdentity(modelOf(candidate.rung, env)) === L.routeIdentity(modelOf(selected.rung, env))) continue;
    const next = costs.get(L.routeIdentity(modelOf(candidate.rung, env)));
    if (current !== undefined && next !== undefined && next <= current) {
      selected = candidate;
      current = next;
    }
  }
  return { ...selected, builder, level: L.TIERS[level], median_cost: current ?? null, risk };
}

function reviewerSection(st, task) {
  const file = require('./tasks').briefPath(st.dir, task.id);
  let brief;
  try {
    brief = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  return require('./brief').sections(brief).content.reviewer.join('\n').trim();
}

// The scope gate's finding for the reviewer: files the diff changes outside
// the paths the task names, each to be justified by the task or sent back.
function scopeSection(st, task, diff) {
  if (!diff.tree) return '';
  const Scope = require('./scope');
  const scope = Scope.check({ task, brief: Scope.briefText(require('./tasks').briefPath(st.dir, task.id)), files: diff.files, tree: diff.tree, project: st.project });
  if (!scope.outside.length) return `## Scope\n\n${Scope.line(scope)}.`;
  return `## Scope\n\n${Scope.line(scope)}.\nCheck that the task needs each of these files; an unneeded change outside the task is a finding.`;
}

// GitHub App logins add an app suffix and [bot]; a human login that only
// contains the name is not revuto.
const REVUTO = /^revuto(?:-[\w-]+)?(?:\[bot\])?$/i;
const SEVERITY = /\[(P[12])\]/;
const RESOLVED = /^\[resolved\](?:\r?\n|$)/i;

// The open revuto findings on the task's PR, each with its latest reply by
// another login. gc is the gh context: the repository for a dispatch, the
// state directory for a brokered command.
async function threads(gc, st, task) {
  const C = require('./gates/common');
  const fields = '{id, in_reply_to_id, path, line, original_line, body, user: .user.login, original_commit_id, html_url}';
  const result = await C.gh(gc, ['api', `repos/${st.project.repo}/pulls/${task.pr}/comments`,
    '--paginate', '--jq', `.[] | ${fields}`]);
  if (!result.ok) throw refuse(C.ghFailure(result, `read PR #${task.pr} review comments`));
  let comments;
  try {
    comments = result.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw refuse(`cannot read PR #${task.pr} review comments`);
  }
  const replies = comments.filter((c) => c.in_reply_to_id != null && !REVUTO.test(c.user || ''));
  return comments.filter((c) => c.in_reply_to_id == null && REVUTO.test(c.user || '') && c.line != null && c.path)
    .map((c) => {
      const reply = replies.filter((r) => r.in_reply_to_id === c.id).at(-1);
      return {
        id: c.id, path: c.path, line: c.line, severity: SEVERITY.exec(c.body || '')?.[1] || null,
        commit: c.original_commit_id || null, url: c.html_url || null,
        reply: reply?.id ?? null, resolved: RESOLVED.test(reply?.body || ''), changed: false, body: c.body || '',
      };
    });
}

// Snapshot active threads and file changes before dispatch because brokered
// evidence runs no git.
async function revuto(ctx, st, task, repo, sha) {
  if (!task.pr || !st.project.repo) return [];
  const C = require('./gates/common');
  const findings = await threads({ ...ctx, root: repo?.root }, st, task);
  for (const f of findings) {
    if (!f.severity || f.resolved || !f.commit || !repo?.root || !sha) continue;
    const r = await C.git(ctx, repo.root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--name-only', f.commit, sha, '--', f.path],
      { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    f.changed = r.ok && !!r.stdout.trim();
  }
  return findings;
}

// How long a reviewer's process can be gone before its monitor records the
// exit: a retry backoff of up to the rung's supervision.max_backoff_ms with no
// attempt running, the group cleanup's SIGTERM grace (5 s), SIGKILL wait (2 s)
// and placeholder cleanup retries (up to 1 s, inside the drain), and a minute
// for the monitor to drain the harness's output and hooks.
const RECEIPT_DRAIN_MS = 60000;
function receiptBound(spawn) {
  return L.supervision(spawn.detail.route || {}).max_backoff_ms + 5000 + 2000 + RECEIPT_DRAIN_MS;
}

// The last time the dispatch was seen working: its spawn, retries, fallbacks,
// usage samples, hooks and notes.
function lastSeen(st, spawn) {
  const start = st.events.indexOf(spawn);
  const agent = spawn.detail.agent;
  let at = Date.parse(spawn.at) || 0;
  for (const e of st.events.slice(start + 1)) {
    if (e.task === spawn.task && (e.agent === agent || e.detail?.agent === agent)) at = Math.max(at, Date.parse(e.at) || 0);
  }
  return at;
}

// The last reviewer dispatched at the task's head and revision, once its
// process has exited without recording review evidence there:
// - `held` when its own exit receipt shows code 0, no signal and no
//   availability failure. Automation does not replace it until an input it
//   read changes: a new head or revision ends the match, and a changed revuto
//   thread is checked by threadsMoved.
// - `pending` while its running monitor may still write that receipt. The
//   reaction to the receipt decides; a dispatch before it would replace a
//   reviewer that may be held.
// - `missing` when no receipt came: the monitor is not observed running, or
//   receiptBound passed since the dispatch was last seen. It is replaced, and
//   the orchestrator is told the monitor did not record the exit.
// A crash, an outage or a stop has its own retries and fallbacks, and the
// next reviewer may not fail the same way, so it is replaced: null. Once
// REVIEW_EXIT_CAP reviewers have failed at this head and revision (see
// failedReviews), the last one is `held` too, with those `failures`.
// A rework after a reviewer's dispatch stopped it (its monitor ends a reviewer
// whose task leaves submitted). Its revision only comes back through a restore
// (gates retry --from-rework), and then that stop says nothing about the
// reviewer: it is neither a held review nor a failure toward the cap.
function stoppedByRework(st, spawn) {
  const own = require('./tasks').taskEvents(st.events, spawn.task);
  return own.slice(own.indexOf(spawn) + 1).some((e) => e.cmd === 'rework');
}

function reviewExit(st, task) {
  if (!task.sha) return null;
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
    && e.detail.revision === task.revision && shaMatch(e.detail.sha, task.sha));
  if (!spawn || stoppedByRework(st, spawn) || !require('./spawn-session').exitedAttempt(spawn, st.events)) return null;
  const verdict = task.evidence.some((v) => v.type === 'review' && v.agent === spawn.detail.agent
    && v.revision === task.revision && shaMatch(v.sha, task.sha));
  if (verdict) return null;
  const exit = exitOf(st, spawn);
  if (!exit) {
    const d = spawn.detail;
    if (!Number.isInteger(d.monitor_pid)) return null;
    const monitor = require('./processes').processState({ host: d.host, pid: d.monitor_pid, start_ticks: d.monitor_start_ticks });
    if (monitor === 'running' && Date.now() - lastSeen(st, spawn) <= receiptBound(spawn)) return { state: 'pending', spawn };
    const failures = failedReviews(st, task);
    return failures.length >= REVIEW_EXIT_CAP ? { state: 'held', spawn, failures, missing: true, monitor } : { state: 'missing', spawn, monitor };
  }
  if (!cleanExit(exit)) {
    const failures = failedReviews(st, task);
    return failures.length >= REVIEW_EXIT_CAP ? { state: 'held', spawn, failures } : null;
  }
  return { state: 'held', spawn };
}

const cleanExit = (exit) => exit.detail.code === 0 && !exit.detail.signal && exit.detail.availability_failure !== true;

// Each reviewer is a paid session, and automation dispatches the next one as
// soon as one exits. A reviewer that crashes on the same head and brief
// would crash again, so failures at one head and revision are capped: the
// first replacement covers a one-off crash, a second failure is a pattern,
// a third only spends. Outages, interrupts and budget stops are not counted,
// since the harness health pause and the budget already stop those. A
// supervisor that failed, or a monitor that died without a receipt, is not
// an outage: it would fail the same way on the next reviewer, so it counts.
const REVIEW_EXIT_CAP = 3;

// The reviewer dispatches at the task's head and revision that ended without
// a verdict there, oldest first: an exit receipt with a nonzero code or a
// signal that is not an outage, or with supervisor_failed; or no receipt from
// a monitor that is no longer running. A running monitor may still write its
// receipt, which then decides.
function failedReviews(st, task) {
  const out = [];
  for (const spawn of st.events) {
    if (spawn.cmd !== 'spawn' || spawn.task !== task.id || spawn.detail.role !== 'reviewer'
      || spawn.detail.revision !== task.revision || !shaMatch(spawn.detail.sha, task.sha)) continue;
    const agent = spawn.detail.agent;
    if (task.evidence.some((v) => v.type === 'review' && v.agent === agent && v.revision === task.revision && shaMatch(v.sha, task.sha))) continue;
    if (stoppedByRework(st, spawn)) continue;
    if (st.events.some((e) => e.task === task.id && ['interrupt', 'budget stop'].includes(e.cmd) && e.detail?.agent === agent)) continue;
    const exit = exitOf(st, spawn);
    if (exit) {
      const d = exit.detail;
      if (d.supervisor_failed !== true && (d.code === 0 && !d.signal || d.availability_failure === true)) continue;
      out.push({ agent, code: d.code ?? null, signal: d.signal || null, supervisor_failed: d.supervisor_failed === true, missing: false, log: spawn.detail.log || null });
      continue;
    }
    const d = spawn.detail;
    if (!Number.isInteger(d.monitor_pid)) continue;
    if (require('./processes').processState({ host: d.host, pid: d.monitor_pid, start_ticks: d.monitor_start_ticks }) === 'running') continue;
    // The latest dispatch may simply still be starting: exitedAttempt says its process is gone.
    if (!require('./spawn-session').exitedAttempt(spawn, st.events)) continue;
    out.push({ agent, code: null, signal: null, supervisor_failed: false, missing: true, log: d.log || null });
  }
  return out;
}

// How a reviewer's dispatch ended, for a notice.
function ending(st, spawn) {
  const exit = exitOf(st, spawn);
  if (!exit) return 'without an exit receipt (its monitor stopped)';
  const d = exit.detail;
  const how = d.signal ? `signal ${d.signal}` : `code ${d.code ?? 'unknown'}`;
  return `with ${how}${d.supervisor_failed === true ? ' after its supervisor failed' : d.availability_failure === true ? ' in an outage' : ''}`;
}

function held(st, task) {
  const exit = reviewExit(st, task);
  return exit?.state === 'held' ? exit.spawn : null;
}

// The monitor's exit receipt for a dispatch, recorded after its last attempt.
function exitOf(st, spawn) {
  const start = st.events.indexOf(spawn);
  return st.events.findLast((e, i) => i > start && e.cmd === 'spawn exit' && e.task === spawn.task
    && e.detail.agent === spawn.detail.agent) || null;
}

// Each thread as the reviewer saw it: the finding and its latest other reply.
function threadKey(findings) {
  return JSON.stringify((findings || []).map((f) => [f.id, f.reply ?? null, f.resolved === true]).sort((a, b) => a[0] - b[0]));
}

// Whether the revuto threads on the PR differ from the held dispatch's
// snapshot: a new finding, a removed one or a new reply. A failed read keeps
// the hold, since a dispatch would refuse on the same read.
async function threadsMoved(ctx, st, task, spawn) {
  if (!Array.isArray(spawn.detail.revuto) || !task.pr || !st.project.repo) return false;
  let now;
  try {
    now = await threads({ root: require('./state').findRepo(ctx.stateDir, ctx.cwd)?.root }, st, task);
  } catch {
    return false;
  }
  return threadKey(now) !== threadKey(spawn.detail.revuto);
}

// Why the held reviewer stopped: its last report or note, and the blocking
// revuto findings its dispatch recorded.
function holdNotice(st, task, spawn) {
  const agent = spawn.detail.agent;
  // The stop hook's own message after a hook stop restates that report, or says none was captured.
  const said = st.events.findLast((e, i) => e.task === task.id && e.agent === agent
    && (['hook report', 'hook stop'].includes(e.cmd) && typeof e.detail.report === 'string' && e.detail.report.trim()
      || ['task note', 'msg'].includes(e.cmd) && typeof e.detail.text === 'string' && e.detail.text.trim()
        && !(e.cmd === 'msg' && st.events[i - 1]?.cmd === 'hook stop' && st.events[i - 1].agent === agent)));
  const exit = exitOf(st, spawn);
  const open = unaddressed(spawn.detail.revuto).map(findingName);
  const failures = exit && cleanExit(exit) ? [] : failedReviews(st, task);
  const capped = failures.length >= REVIEW_EXIT_CAP;
  return { agent, sha: task.sha, revision: task.revision,
    reason: capped
      ? `reviewers ended without a verdict ${failures.length} times at this head and revision; the last, ${agent}, ended ${ending(st, spawn)} (log ${spawn.detail.log || 'none'}); fix the cause, then accept ${task.id} dispatches the next reviewer`
      : said ? (said.detail.report ?? said.detail.text).trim() : null,
    revuto: open, exit: exit ? { code: exit.detail.code ?? null, signal: exit.detail.signal ?? null } : null,
    ...(capped ? { failures: failures.length, cap: REVIEW_EXIT_CAP, agents: failures.map((f) => f.agent) } : {}) };
}

function revutoSection(findings) {
  if (!findings?.length) return '';
  const blocking = findings.filter((f) => f.severity).length;
  return [
    '## Revuto findings',
    `revuto left ${findings.length} open inline comment${findings.length === 1 ? '' : 's'} at this head, ${blocking} marked [P1]/[P2]. Check each against the diff. A review ok is refused while a [P1]/[P2] has no code change at its path since the comment and no resolving reply. The latest non-revuto reply must start with [resolved] on a line of its own; later discussion requires a fresh resolution.`,
    ...findings.map((f) => `### ${f.severity ? `[${f.severity}] ` : ''}${f.path}:${f.line} (comment ${f.id}${f.reply != null ? `, ${f.resolved ? 'resolved' : 'unresolved'} in reply ${f.reply}` : ''})\n\n${f.body.trim()}`),
  ].join('\n\n');
}

// Older snapshots without an explicit resolution signal remain blocking.
function unaddressed(findings) {
  return (findings || []).filter((f) => f.severity && f.resolved !== true && !f.changed);
}

function findingName(f) {
  return `[${f.severity}] comment ${f.id} at ${f.path}:${f.line}${f.url ? ` (${f.url})` : ''}`;
}

function staticContext(root, rules, standards, skill, env) {
  const plugin = env.TOWER_CRANE_PLUGIN_ROOT || path.join(__dirname, '..');
  const read = (file) => {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  };
  // Worktree paths change for each task; labels relative to the checkout keep
  // unchanged documents in the same cache prefix.
  const label = (file) => {
    const relative = path.relative(root, file);
    return (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? file : relative).split(path.sep).join('/');
  };
  const section = (file, heading) => {
    const lines = read(file).split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) return '';
    const level = heading.match(/^#+/)[0].length;
    let end = start + 1;
    let fence = null;
    for (; end < lines.length; end++) {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(lines[end]);
      if (mark) {
        if (!fence) fence = mark[1];
        else if (mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      }
      if (!fence && new RegExp(`^#{1,${level}} `).test(lines[end])) break;
    }
    return lines.slice(start, end).join('\n').trim();
  };
  const profile = standards === 'default' ? path.join(plugin, 'standards', 'default.md') : path.resolve(root, standards);
  return [
    skill,
    '## House rules\n\nThe owner\'s task instructions take precedence. These rule contents are a snapshot for this dispatch, general first and nearest last. Imported rule files are included below.',
    ...rules.map((r) => `### ${r.scope}: ${label(r.path)}\n\n${read(r.path)}`),
    `## Standards: ${standards}\n\n${read(profile)}`,
    ...[
      ['docs/state.md', '### Acceptance gates'],
      ['docs/cli.md', '## Gates'],
    ].map(([file, heading]) => {
      const text = section(path.join(root, file), heading);
      return text ? `## Review contract: ${file}\n\n${text}` : '';
    }),
  ].filter(Boolean).join('\n\n');
}

function context(st, task, diff, report, selection, findings, includeDiff = true, skill = 'the tower-crane-review skill') {
  const T = require('./tasks');
  const gates = report.gates.map((g) => {
    const entry = T.latestGateEvidence(task, g.type, st.events);
    return { type: g.type, ok: g.ok, waived: !!g.waived, summary: entry?.summary || g.reason,
      sha: entry?.sha, revision: entry?.revision, source: entry?.source, tests_mode: entry?.tests_mode,
      commands: entry?.commands, receipt: entry?.receipt };
  });
  const research = require('./research');
  const needsSources = research.required(task);
  const sources = needsSources ? T.latestGateEvidence(task, 'sources', st.events) : null;
  if (diff.light) return [
    `Review ${task.id} at ${diff.sha}${task.pr ? ` (PR #${task.pr})` : ''}. Follow ${skill}.`,
    '## Light claim check',
    `The full review by ${diff.light.review.agent} at ${diff.light.review.sha}, revision ${diff.light.review.revision}, found only false prose claims.`,
    `Check changelog and supporting code only at ${diff.sha}. If worktree HEAD differs, read them with git show ${diff.sha}:<path>. The PR body is its current GitHub text.`,
    'Read the current PR body and the named changelog fragments. Check each claim below against the code or its probe. Report whether each correction is true. Do not repeat the full acceptance checklist or review unchanged code.',
    'An unresolved claim still blocks. A newly introduced security or data-loss defect still blocks. Contract text in docs/cli.md or docs/state.md never qualifies for this path.',
    diff.light.review.ref,
    diff.light.review.summary,
    JSON.stringify(diff.light.review.findings, null, 2),
    '## Gate results', JSON.stringify(gates, null, 2),
    revutoSection(findings),
    ...(includeDiff && diff.light.diff ? ['## Claim correction diff', diff.light.diff] : []),
    'Post the light check as a Tower Crane review at this submitted SHA and record review evidence with --ok only when every correction is verified. If a claim remains false, record --fail with --findings listing every blocker.',
  ].filter(Boolean).join('\n\n');
  return [
    `Review ${task.id} at ${diff.sha}${task.pr ? ` (PR #${task.pr})` : ''}. Follow ${skill}.`,
    ...(task.hotfix ? [`Hotfix: PR #${task.pr} merged before its gates. The supplied diff is the change that landed against its first parent. Record review evidence at merge commit ${task.sha}. A failure creates a follow-up against ${task.hotfix.base}.`] : []),
    `Selected ${selection.name}; complexity ${selection.level}; builder model ${selection.builder}.`,
    `Standards: ${st.project.standards}. Base: ${diff.base}.`,
    'Use the supplied gate results. Do not re-run the full suite unless you change something in a scratch checkout to probe a specific concern. Run only the affected tests for that probe. Read surrounding code only where the diff requires it.',
    `Review only ${diff.sha}. If worktree HEAD differs, read surrounding files with git show ${diff.sha}:<path>.`,
    '## Review scope',
    diff.review_scope ? [
      `Re-review after failed review by ${diff.review_scope.agent} at ${diff.review_scope.sha}, revision ${diff.review_scope.revision}.`,
      'Check each prior blocking finding at the submitted sha and report whether it is fixed. Unresolved prior blockers still block.',
      `Then review only the supplied diff since that review: git diff ${diff.base} ${diff.sha}.`,
      'A defect the new diff causes blocks wherever it shows, including in unchanged code such as an unchanged caller of a changed function. Other new findings on already reviewed code are follow-ups unless they are security or data-loss defects introduced by the change.',
      `Prior review: ${diff.review_scope.summary || 'No summary'}${diff.review_scope.ref ? `\nRead the blocking findings at ${diff.review_scope.ref}.` : ''}`,
      diff.review_scope.reason ? `Rework request:\n${diff.review_scope.reason}` : '',
    ].filter(Boolean).join('\n\n') : [
      'Full review of the submitted change against its acceptance.',
      diff.review_fallback ? `${diff.review_fallback} Use the supplied diff from the project base.` : '',
    ].filter(Boolean).join('\n\n'),
    reviewerSection(st, task),
    scopeSection(st, task, diff),
    revutoSection(findings),
    '## Gate results', JSON.stringify(gates, null, 2),
    ...(needsSources ? [
      `Read ${research.deliverable(task)} at ${diff.sha}. Check each claim maps to a cited source and that its quote supports the claim. Check source credibility and any factual claims outside the structured claims array.`,
      ...(sources?.receipt ? ['## Sources receipt', JSON.stringify(sources.receipt, null, 2)] : []),
    ] : []),
    ...(includeDiff ? ['## Diff', diff.text] : []),
  ].filter(Boolean).join('\n\n');
}

function churnAfter(project) {
  return project.review?.churn_after ?? DEFAULTS.churn_after;
}

module.exports = { cost, entryCost, rateTable, rateFor, errors, canonicalPolicy, modelOf, reReview, diffOf, checkedDiff, prepareLight, checkedLight, softwareReport, choose, staticContext, context, revuto, threads, reviewExit, held, failedReviews, REVIEW_EXIT_CAP, threadsMoved, holdNotice, unaddressed, findingName, churnAfter };
