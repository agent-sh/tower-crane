'use strict';

// CI feedback for the task's own PR while its run is still going: one job's log, written to the
// task scratch with its failing tests named, and the open code-scanning alerts on the PR head.
// Sandboxed workers reach both through the state broker, which runs gh outside their sandbox.
const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const { cleanLog } = require('./ci-log-text');
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

async function json(ctx, endpoint) {
  const r = await C.gh({ root: ctx.cwd }, ['api', endpoint]);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh api ${endpoint}`));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw refuse(`invalid GitHub response for gh api ${endpoint}`);
  }
}

async function pages(ctx, endpoint) {
  const r = await C.gh({ root: ctx.cwd }, ['api', endpoint, '--paginate', '--jq', '.[]']);
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
  const r = await C.gh({ root: ctx.cwd }, ['api', `repos/${repo}/actions/jobs/${job}/logs`, '--allow-escape-sequences']);
  if (!r.ok) throw refuse(cleanLog(C.ghFailure(r, `gh api repos/${repo}/actions/jobs/${job}/logs`)));
  const text = cleanLog(r.stdout);
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
  const rows = (await pages(ctx, `repos/${st.project.repo}/code-scanning/alerts?state=open&ref=${ref}&per_page=100`)).map((a) => {
    const at = a.most_recent_instance?.location || {};
    return {
      number: a.number,
      rule: a.rule?.id ?? null,
      severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null,
      path: at.path ?? null,
      line: at.start_line ?? null,
      message: a.most_recent_instance?.message?.text ?? a.rule?.description ?? null,
    };
  });
  const text = rows.length
    ? rows.map((r) => `#${r.number} ${r.rule} ${r.severity} ${r.path}:${r.line} ${r.message}`).join('\n')
    : `no open code-scanning alerts on PR #${task.pr}`;
  return { data: { pr: task.pr, alerts: rows }, text };
}

module.exports = { log, alerts, failingTests };
