'use strict';

// CI feedback for the task's own PR while its run is still going: one job's log, written to the
// task scratch with its failing tests named, and the open code-scanning alerts on the PR head.
// Sandboxed workers reach both through the state broker, which runs gh outside their sandbox.
const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const { stripEscapes, cleanOutput } = require('./ci-log-text');
const CI = require('./gates/ci');
const Hosted = require('./ci-hosted');
const { refuse, usage } = require('./util');

// GitHub puts a timestamp in front of every line of a job log.
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
// A line that starts a failing test: the name, and the error when the line carries it.
const FAILURES = [
  /^\s*not ok \d+ - (.+?)\s*$/, // node --test, TAP
  /^\s*✖ (?!failing tests:)(.+?)(?: \([\d.]+m?s\))?\s*$/, // node --test, spec reporter
  /^\s*--- FAIL: (\S+)/, // go test, including indented subtests
  /^FAILED (\S+?)(?: - (.+))?$/, // pytest short summary
];
// The error line under a failing test: the first one before the next test starts.
const ERROR = /\b(?:error|expected|actual|assert\w*|exception)\b/i;
// Go's testing.T logs carry a source location even when the message has no error keyword.
const GO_DIAGNOSTIC = /^\s*.+\.go:\d+(?::\d+)?:\s*\S/;
const NEXT = /^\s*(?:not ok|ok) \d+ /;
const YAML_END = /^\s*(?:---|\.\.\.)\s*$/;
const LOOKAHEAD = 20;

function failingTests(text) {
  const lines = text.split('\n').map((line) => line.replace(STAMP, ''));
  const found = new Map();
  lines.forEach((line, i) => {
    const hit = FAILURES.map((re) => re.exec(line)).find(Boolean);
    if (!hit) return;
    const name = hit[1].trim();
    let error = hit[2]?.trim() || null;
    for (let j = i + 1; !error && j < lines.length && j <= i + LOOKAHEAD; j++) {
      if (NEXT.test(lines[j]) || FAILURES.some((re) => re.test(lines[j]))) break;
      if ((ERROR.test(lines[j]) || GO_DIAGNOSTIC.test(lines[j])) && !YAML_END.test(lines[j])) error = lines[j].trim();
    }
    // The spec reporter repeats failures in its summary, where the error lines often sit.
    if (!found.has(name)) found.set(name, { name, error });
    else if (!found.get(name).error) found.get(name).error = error;
  });
  return [...found.values()];
}

// The task whose PR is read: --task, else the task process's own.
function ownTask(st, ctx, command) {
  const id = ctx.flags.task || ctx.env.TOWER_CRANE_TASK;
  if (!id) throw usage(`${command} needs --task ID outside a task process`);
  return T.getTask(st, id);
}

// gh must not load git configuration from a worktree the sandboxed worker controls.
function ghContext(ctx) {
  return S.via(ctx).via
    ? { root: ctx.stateDir, ghEnv: { GIT_DIR: path.join(ctx.stateDir, 'no-repository') } }
    : { root: ctx.cwd };
}

async function json(ctx, endpoint) {
  const r = await C.gh(ghContext(ctx), ['api', endpoint]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh api ${endpoint}`));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw refuse(`invalid GitHub response for gh api ${endpoint}`);
  }
}

async function pages(ctx, endpoint, filter = '.[]') {
  const r = await C.gh(ghContext(ctx), ['api', endpoint, '--paginate', '--jq', filter]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh api ${endpoint}`));
  try {
    return r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw refuse(`invalid GitHub response for gh api ${endpoint}`);
  }
}

// This process writes outside the sandbox, into a directory the worker can change. The sandbox may write
// the scratch root but not its parent, so the worker cannot replace the root, and the log name is the only
// part of the path it controls. A link left there is removed, and wx then refuses to open anything at the
// name, a link included, so the write never follows one.
function writeLog(scratch, job, text) {
  const file = path.join(scratch, `ci-job-${job}.log`);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
  return file;
}

async function log(ctx) {
  const job = ctx.pos[0];
  if (!/^\d+$/.test(job || '')) throw usage('ci log needs a numeric JOB_ID; usage: tower-crane ci log JOB_ID [--failed-tests]');
  const st = S.loadState(ctx.stateDir);
  const task = ownTask(st, ctx, 'ci log');
  const repo = st.project.repo;
  if (!task.branch) throw refuse(`${task.id} has no branch yet; its worktree records one`);
  if (!task.scratch) throw refuse(`${task.id} has no task scratch directory yet; spawn records it when the worker starts`);
  // The PR head is the tip of the task's branch. The worker pushes that before it submits, so its pre-submit CI reads work too.
  // A job of another branch, or of an older head, is not in a check run on this PR head.
  const run = await json(ctx, `repos/${repo}/actions/jobs/${job}`);
  const head = (await json(ctx, `repos/${repo}/git/ref/heads/${task.branch.split('/').map(encodeURIComponent).join('/')}`)).object?.sha;
  if (run.head_branch !== task.branch || !C.sameSha(run.head_sha, head)) {
    throw refuse(`job ${job} is not in a check run on ${task.id}'s PR head: it runs on ${run.head_branch} at ${C.short(run.head_sha)}, and ${task.branch} is at ${C.short(head)}`);
  }
  const r = await C.gh(ghContext(ctx), ['api', `repos/${repo}/actions/jobs/${job}/logs`, '--allow-escape-sequences']);
  if (!r.ok) throw refuse(stripEscapes(C.ghFailure(r, `gh api repos/${repo}/actions/jobs/${job}/logs`)));
  const text = stripEscapes(r.stdout);
  const file = writeLog(task.scratch, job, text);
  const failed = ctx.flags['failed-tests'] ? failingTests(text) : null;
  const lines = [file];
  if (failed) {
    if (!failed.length) lines.push('no failing test names in the log; read it at the path above');
    else lines.push(`failing tests (${failed.length}):`);
    for (const { name, error } of failed) lines.push(`  ${name}`, ...(error ? [`    ${error}`] : []));
  }
  return { data: { log: file, ...(failed ? { failed } : {}) }, text: lines.join('\n') };
}

async function alerts(ctx) {
  const st = S.loadState(ctx.stateDir);
  const task = ownTask(st, ctx, 'ci alerts');
  if (!task.pr) throw refuse(`${task.id} has no PR yet; alerts are listed for a submitted PR`);
  const ref = encodeURIComponent(`refs/pull/${task.pr}/head`);
  const rows = (await pages(ctx, `repos/${st.project.repo}/code-scanning/alerts?state=open&ref=${ref}&per_page=100`)).map(alertRow);
  const text = rows.length
    ? rows.map((r) => `#${r.number} ${r.rule} ${r.severity} ${r.path}:${r.line} ${r.message}`).join('\n')
    : `no open code-scanning alerts on PR #${task.pr}`;
  return { data: { pr: task.pr, alerts: rows }, text };
}

function alertRow(a) {
  const at = a.most_recent_instance?.location || {};
  return cleanOutput({
    number: a.number,
    rule: a.rule?.id ?? null,
    severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null,
    path: at.path ?? null,
    line: at.start_line ?? null,
    message: a.most_recent_instance?.message?.text ?? a.rule?.description ?? null,
  });
}

// CodeQL usually analyses the synthetic merge commit. Its parents must still match this PR.
async function currentAlerts(ctx, repo, pr, sha) {
  const pull = await json(ctx, `repos/${repo}/pulls/${pr}`);
  if (!C.sameSha(pull.head?.sha, sha)) throw refuse(`PR #${pr} head changed while reading alerts; retry ci checks`);
  const targets = [{ ref: `refs/pull/${pr}/head`, sha }];
  if (pull.merge_commit_sha) {
    const merge = await json(ctx, `repos/${repo}/git/commits/${pull.merge_commit_sha}`);
    if (!C.sameSha(merge.sha, pull.merge_commit_sha)
      || !merge.parents?.some((p) => C.sameSha(p.sha, sha))
      || !merge.parents?.some((p) => C.sameSha(p.sha, pull.base?.sha))) {
      throw refuse(`PR #${pr} merge commit does not match its current head and base; retry ci checks`);
    }
    targets.unshift({ ref: `refs/pull/${pr}/merge`, sha: merge.sha });
  }
  const found = new Map();
  for (const target of targets) {
    const rows = await pages(ctx, `repos/${repo}/code-scanning/alerts?state=open&ref=${encodeURIComponent(target.ref)}&per_page=100`);
    for (const a of rows) {
      const instance = a.most_recent_instance;
      if (instance?.ref !== target.ref || !C.sameSha(instance.commit_sha, target.sha)) continue;
      if (!found.has(a.number)) found.set(a.number, alertRow(a));
    }
  }
  return [...found.values()];
}

// A worker creates its PR before submit records the number; resolve it from the recorded branch.
async function currentPr(ctx, task, repo) {
  if (!task.branch) throw refuse(`${task.id} has no branch yet; its worktree records one`);
  const r = await C.gh(ghContext(ctx), ['pr', 'view', String(task.pr || task.branch), '-R', repo, '--json', 'number,headRefName,headRefOid']);
  if (!r.ok) throw refuse(C.ghFailure(r, 'gh pr view'));
  let pr;
  try { pr = JSON.parse(r.stdout); }
  catch { throw refuse('invalid GitHub response for gh pr view'); }
  if (pr?.headRefName !== task.branch || !/^[a-f0-9]{40,64}$/i.test(pr?.headRefOid || '') || !Number.isInteger(pr?.number)) {
    throw refuse(`PR #${pr?.number ?? '?'} does not identify ${task.id}'s branch ${task.branch} and head`);
  }
  return pr;
}

async function checks(ctx) {
  const st = S.loadState(ctx.stateDir);
  const task = ctx.pos[0] ? T.getTask(st, ctx.pos[0]) : ownTask(st, ctx, 'ci checks');
  if (!task.branch) throw refuse(`${task.id} has no branch yet; its worktree records one`);
  const repo = st.project.repo;
  if (!repo) throw refuse('project.json has no repo; set "repo" to "owner/name"');
  const { policy, error } = Hosted.resolve(st.project);
  if (error) throw refuse(error);
  const pr = await currentPr(ctx, task, repo);
  const sha = pr.headRefOid;
  const checks = await CI.fetchChecks(ghContext(ctx), repo, sha, policy, { all: true });
  if (checks.error) throw refuse(stripEscapes(checks.error));
  const superseded = new Set(CI.judge(policy, checks).superseded);
  const rows = [];
  for (const run of checks.runs.filter((c) => !CI.greenRun(c))) {
    const reasons = [CI.nonblockingReason(policy, run), superseded.has(run) ? 'superseded check run: the CI gate uses a newer run at this head' : null].filter(Boolean);
    const reason = reasons.length ? reasons.join('; ') : null;
    const annotations = run.output?.annotations_count === 0 ? []
      : await pages(ctx, `repos/${repo}/check-runs/${run.id}/annotations?per_page=100`);
    rows.push(cleanOutput({ ...run, nonblocking: !!reason, reason, annotations }));
  }
  let openAlerts = null;
  let alertsError = null;
  try { openAlerts = await currentAlerts(ctx, repo, pr.number, sha); }
  catch (e) { alertsError = stripEscapes(e.message); }
  const found = await CI.revutoFindings(ghContext(ctx), repo, pr.number);
  const findings = found.error ? null : cleanOutput(found.findings);
  const findingsError = found.error ? stripEscapes(found.error) : null;
  const lines = [`${task.id} PR #${pr.number} at ${sha}`];
  if (!rows.length) lines.push('no non-green check runs');
  for (const row of rows) {
    lines.push(`${row.name} (${row.app}): ${row.status === 'completed' ? row.conclusion : row.status}${row.nonblocking ? `; nonblocking (${row.reason})` : ''}`);
    lines.push(`  title: ${row.output?.title || '(none)'}`, `  summary: ${row.output?.summary || '(none)'}`);
    for (const a of row.annotations) lines.push(`  ${a.path}:${a.start_line} ${a.title || ''} ${a.message || ''}`.trimEnd());
  }
  if (alertsError) lines.push(`code-scanning alerts unavailable: ${alertsError}`);
  else if (!openAlerts.length) lines.push(`no open code-scanning alerts on PR #${pr.number} at this head`);
  else for (const a of openAlerts) lines.push(`#${a.number} ${a.rule} ${a.severity} ${a.path}:${a.line} ${a.message}`);
  if (findingsError) lines.push(`revuto findings unavailable: ${findingsError}`);
  else if (!findings.length) lines.push(`no open revuto inline findings on PR #${pr.number}`);
  else lines.push(`open revuto inline findings on PR #${pr.number}:`, ...CI.revutoLines(findings));
  return { data: { task: task.id, pr: pr.number, sha, checks: rows, alerts: openAlerts,
    ...(alertsError ? { alerts_error: alertsError } : {}), findings,
    ...(findingsError ? { findings_error: findingsError } : {}) }, text: lines.join('\n') };
}

// A reason explains one fix in a sentence or two. The reply goes out under the
// owner's GitHub identity, so its length is bounded.
const REASON_MAX = 1000;

// The reply posts as the owner but its text may come from a worker: a
// zero-width joiner after each @ keeps it from mentioning anyone, and the last
// line names who wrote it.
function replyBody(ctx, reason) {
  const role = require('./authority').role(ctx, S.roles(ctx.stateDir));
  return `[resolved]\n${reason.replaceAll('@', '@\u200d')}\n\nby ${role ? '' : 'worker '}${ctx.agent}`;
}

// A [resolved] reply on a revuto finding, the resolution review evidence
// accepts. Workers cannot write to GitHub from their sandbox, so the reply
// goes through this command and, for a worker, the state broker. The event it
// records lets automation dispatch a review held at the task's head.
async function resolve(ctx) {
  const id = ctx.pos[0];
  if (!/^\d+$/.test(id || '')) throw usage('ci resolve needs a numeric COMMENT_ID; usage: tower-crane ci resolve COMMENT_ID --reason TEXT [--task ID]');
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('ci resolve needs --reason saying how the finding was fixed or why it does not apply');
  if (reason.length > REASON_MAX) throw usage(`ci resolve --reason is ${reason.length} characters; keep it to ${REASON_MAX}`);
  const st = S.loadState(ctx.stateDir);
  const task = ownTask(st, ctx, 'ci resolve');
  const repo = st.project.repo;
  if (!repo) throw refuse('project.json has no repo; set "repo" to "owner/name"');
  const pr = task.pr ? Number(task.pr) : (await currentPr(ctx, task, repo)).number;
  const findings = await require('./reviewer').threads(ghContext(ctx), st, { ...task, pr });
  if (!findings.some((f) => String(f.id) === id)) throw refuse(`comment ${id} is not an open revuto finding on PR #${pr}`);
  const r = await C.gh(ghContext(ctx), ['api', '--method', 'POST', `repos/${repo}/pulls/${pr}/comments/${id}/replies`,
    '-f', `body=${replyBody(ctx, reason)}`]);
  if (!r.ok) throw refuse(C.ghFailure(r, `reply on comment ${id}`));
  let reply = null;
  try { reply = JSON.parse(r.stdout)?.id ?? null; } catch { /* GitHub accepted the reply; its id is optional here. */ }
  S.mutate(ctx, 'ci resolve', (now, emit) => {
    const t = T.getTask(now, task.id);
    emit(t.id, { comment: Number(id), pr, reply, sha: t.sha, revision: t.revision });
  });
  const event = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'ci resolve' && e.task === task.id);
  await require('./automation').consume(ctx, [event]);
  return { data: { task: task.id, pr, comment: Number(id), reply }, text: `${task.id}: marked revuto comment ${id} on PR #${pr} [resolved]` };
}

module.exports = { log, alerts, checks, resolve, failingTests };
