'use strict';
// Final review, run by accept once per head and revision after every other gate passed. An
// external review bot with a per-PR round cap skips the later heads of a PR, and the CI gate
// lets that capped check through (ci.capped_review), so the head that merges was often never
// reviewed by it. gates.final_review names a command that asks the reviewer for one more
// review of that head. It runs from a gate worktree at the commit with the gate environment.
// Exit 0 passes; concerns_exit is a finding that sends the task to rework; any other end (a
// refusal, an error, a timeout) is recorded with its output and does not block acceptance.
// Project validation reads errors() through lib/gate-commands.js, so the gate helpers load on first run.
const C = () => require('./common');

const WHEN = ['capped', 'always'];
const KEYS = ['command', 'when', 'capped_pattern', 'timeout', 'concerns_exit'];
// concerns_exit defaults to the code Revuto's final mode exits with on blocking concerns (it exits
// 0 on a pass, 1 on an error and 3 when it refuses); the timeout to the other gate commands' budget.
const DEFAULTS = { when: 'capped', timeout: 1200, concerns_exit: 2 };
const MAX_TIMER_MS = 2 ** 31 - 1;
const SHOW_LINES = 40;

function errors(gates) {
  const v = gates?.final_review;
  if (v == null) return [];
  const bad = (message) => [`project.json gates.final_review ${message}`];
  if (typeof v !== 'object' || Array.isArray(v)) return bad('must be an object or null');
  const unknown = Object.keys(v).filter((k) => !KEYS.includes(k));
  if (unknown.length) return bad(`has unknown keys: ${unknown.join(', ')}; it takes ${KEYS.join(', ')}`);
  if (!Array.isArray(v.command) || !v.command.length || !v.command.every((a) => typeof a === 'string' && !a.includes('\0'))
    || !v.command[0].trim()) return bad('command must be a nonempty argv array of strings without NUL bytes');
  if (v.when !== undefined && !WHEN.includes(v.when)) return bad('when must be "capped" or "always"');
  if ((v.when ?? DEFAULTS.when) === 'capped' || v.capped_pattern !== undefined) {
    if (typeof v.capped_pattern !== 'string' || !v.capped_pattern.trim()) return bad('capped_pattern must be a nonempty regular expression; "when": "capped" needs it');
    try { new RegExp(v.capped_pattern, 'i'); } catch (e) { return bad(`capped_pattern is not a valid regular expression: ${e.message}`); }
  }
  if (v.timeout !== undefined && !(typeof v.timeout === 'number' && v.timeout > 0 && v.timeout * 1000 <= MAX_TIMER_MS)) {
    return bad("timeout must be a positive number of seconds within Node's timer range");
  }
  if (v.concerns_exit !== undefined && !(Number.isInteger(v.concerns_exit) && v.concerns_exit >= 1 && v.concerns_exit <= 255)) {
    return bad('concerns_exit must be an exit code from 1 to 255');
  }
  return [];
}

function settings(project) {
  const v = project.gates?.final_review;
  return v == null || errors(project.gates).length ? null : { ...DEFAULTS, ...v };
}

// The final review evidence that stands for the task's head and revision, if any.
function current(task, events) {
  return require('../tasks').latestGateEvidence(task, 'final-review', events) || null;
}

function expand(arg, values) {
  return arg.replace(/\{(repo|pr|sha)\}/g, (_, key) => values[key]);
}

async function list(ctx, endpoint, filter) {
  const r = await C().gh(ctx, ['api', endpoint, '--paginate', '--jq', filter]);
  if (!r.ok) return { error: C().ghFailure(r, `gh api ${endpoint}`) };
  try {
    return { items: r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) };
  } catch (e) {
    return { error: `could not read gh api ${endpoint} output: ${e.message}` };
  }
}

// The completed check runs at the head whose output title or summary matches the pattern: the
// reviewer said there that it skipped this head. A rerun leaves the older run listed, so only the
// newest run of each name counts.
async function cappedRuns(ctx, repo, sha, pattern) {
  const read = await list(ctx, `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
    '.check_runs[] | {id, started_at, name, status, conclusion, app: .app.slug, output: {title: .output.title, summary: .output.summary}}');
  if (read.error) return read;
  const re = new RegExp(pattern, 'i');
  const { latest } = require('./ci').latestRuns(read.items);
  const runs = latest.filter((c) => c.status === 'completed'
    && re.test([c.output?.title, c.output?.summary].filter((s) => typeof s === 'string').join('\n')));
  return { runs: runs.map((c) => `${c.name} (${c.app})`) };
}

// The reviewer's word at this head, for the rework notes: the latest PR review left on the
// commit, and the inline comments that start a thread there.
async function reviewComments(ctx, repo, pr, sha) {
  const { short, sameSha } = C();
  const lines = [];
  const reviews = await list(ctx, `repos/${repo}/pulls/${pr}/reviews?per_page=100`, '.[] | {id, user: .user.login, body, commit_id, html_url}');
  if (reviews.error) lines.push(`PR reviews not read: ${reviews.error}`);
  const review = (reviews.items || []).filter((r) => sameSha(r.commit_id, sha) && typeof r.body === 'string' && r.body.trim()).at(-1);
  if (review) lines.push(`Latest review at ${short(sha)} by ${review.user || 'unknown'}${review.html_url ? ` (${review.html_url})` : ''}:`, review.body.trim());
  const comments = await list(ctx, `repos/${repo}/pulls/${pr}/comments?per_page=100`,
    '.[] | {id, in_reply_to_id, path, line, body, user: .user.login, commit_id, original_commit_id}');
  if (comments.error) lines.push(`PR review comments not read: ${comments.error}`);
  const inline = (comments.items || []).filter((c) => c.in_reply_to_id == null && c.path && sameSha(c.original_commit_id || c.commit_id, sha));
  if (inline.length) {
    lines.push(`Review comments at ${short(sha)}:`);
    for (const c of inline) {
      lines.push(`- ${c.path}${c.line != null ? `:${c.line}` : ''} (comment ${c.id}${c.user ? ` by ${c.user}` : ''})`,
        ...String(c.body || '').trimEnd().split(/\r?\n/).map((l) => `  ${l}`));
    }
  }
  return lines;
}

async function run(ctx) {
  const { short, how, tailLines, stripFor, exec, resolveCommit, withWorktree } = C();
  const { root, task, project } = ctx;
  const config = settings(project);
  const sha = task.sha;
  if (!config) return { ok: false, summary: 'project.json has no valid gates.final_review', sha };
  if (!sha) return { ok: false, summary: `task ${task.id} has no submitted sha; submit it first`, sha };
  const result = (outcome, summary, extra = {}) => ({ ok: outcome !== 'concerns', summary, sha,
    final_review: { outcome, when: config.when, ...extra } });
  if (!project.repo || !task.pr) return result('not_run', `final review not run at ${short(sha)}: no PR in a recorded repo, so no external reviewer reads this head`);
  let capped = [];
  if (config.when === 'capped') {
    const read = await cappedRuns(ctx, project.repo, sha, config.capped_pattern);
    if (read.error) return result('not_run', `final review not run at ${short(sha)}: cannot read the check runs that say whether the external review was capped: ${read.error}`);
    if (!read.runs.length) {
      return result('skipped', `final review skipped at ${short(sha)}: no check run there matches gates.final_review.capped_pattern /${config.capped_pattern}/i, so the external reviewer was not capped at this head`);
    }
    capped = read.runs;
  }
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return result('not_run', `final review not run: commit ${sha} is not in ${root}; fetch it and run accept again`, { capped });
  const argv = config.command.map((arg) => expand(arg, { repo: project.repo, pr: String(task.pr), sha: full }));
  const redact = require('./tests').diagnosticRedactor(project, root);
  const shown = redact(argv.join(' '));
  const why = capped.length ? `the external review was capped (${capped.join(', ')})` : 'gates.final_review.when is "always"';
  const out = await withWorktree(ctx, root, full, async (dir, env) => {
    // The reviewer is the owner's, but a git it runs reads the repository config a worker writes.
    const { gitEnv } = require('../commands');
    return { r: await exec(ctx, argv[0], argv.slice(1), { cwd: dir, env: gitEnv(dir, env), timeout: Math.round(config.timeout * 1000),
      processTree: true, stdio: ['ignore', 'pipe', 'pipe'] }) };
  });
  if (!out.r) return result('not_run', `final review not run at ${short(full)}: ${out.summary}`, { capped });
  const r = out.r;
  const said = tailLines(redact(stripFor(redact, (r.output || [r.stdout, r.stderr].filter(Boolean).join('\n')).trim())), SHOW_LINES);
  const exit = { capped, exit: r.status, signal: r.signal, ...(r.timedOut ? { timed_out: true } : {}) };
  const output = said ? `Output:\n${said}` : 'No output.';
  if (r.ok) return result('pass', `final review passed at ${short(full)}: ${shown} exited 0; ran because ${why}\n${output}`, exit);
  if (!r.error && !r.signal && r.status === config.concerns_exit) {
    const comments = await reviewComments(ctx, project.repo, task.pr, full);
    return result('concerns', [`final review raised concerns at ${short(full)}: ${shown} exited ${r.status} (gates.final_review.concerns_exit); ran because ${why}`,
      output, ...comments].join('\n'), exit);
  }
  // A command that ran and said no is a refusal; one that never finished did not run.
  const outcome = r.timedOut || r.missing || r.error || r.signal ? 'not_run' : 'refused';
  return result(outcome, `final review ${outcome === 'refused' ? 'refused' : 'not run'} at ${short(full)}: ${shown} ${redact(how(r))}; recorded, it does not block acceptance; ran because ${why}\n${output}`, exit);
}

module.exports = { run, errors, settings, current, expand, DEFAULTS };
