'use strict';
// Gate `check clean ID`: the cleanup tool (deslop) reads the task's change against the base
// branch; any HIGH finding, or a scan that did not complete, fails the gate. It runs on a fresh
// checkout of the submitted commit because the task worktree may have moved on or hold
// uncommitted edits.
const { fail, short, how, errText, shell, shellQuote, resolveCommit, mergeBase, withWorktree } = require('./common');

const timeouts = require('../gate-timeouts');
const SHOW_HIGH = 10;

function countBy(items, key) {
  const counts = new Map();
  for (const it of items) {
    const k = it[key] || 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
}

// Fields in which a cleanup tool reports checks that did not run. A scan with a gap is no
// evidence that the change is clean.
const ERROR_FIELDS = ['errors', 'detectorErrors', 'failedChecks'];

function scanGaps(report) {
  const gaps = [];
  for (const field of ERROR_FIELDS) {
    const v = report[field];
    if (!v) continue;
    const list = Array.isArray(v) ? v : typeof v === 'object' ? Object.entries(v).map(([k, e]) => `${k}: ${typeof e === 'string' ? e : JSON.stringify(e)}`) : [v];
    for (const e of list) gaps.push(typeof e === 'string' ? e : JSON.stringify(e));
  }
  return gaps;
}

function where(it) {
  return it.line ? `${it.file}:${it.line}` : String(it.file || '?');
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  const selected = require('../gate-commands').select(project, 'clean', args);
  if (selected.error) return fail(selected.error);
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (!project.base) return fail('project.json has no base branch; set "base" (for example "main")');
  const minutes = args.timeout == null ? timeouts.minutes(project, 'clean') : Number(args.timeout);
  if (!timeouts.valid(minutes)) return fail(`--timeout must be a positive number of minutes within Node's timer range, got ${args.timeout}`);
  const sha = task.sha;
  const res = (ok, summary) => ({ ok, summary, sha });

  const tool = { command: selected.command, name: selected.command };
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  const mb = await mergeBase(ctx, root, project.base, full);
  if (!mb) return res(false, `no merge base between ${project.base} and ${short(full)}; fetch ${project.base} (git fetch origin ${project.base}) and run the gate again`);

  const out = await withWorktree(ctx, root, full, async (dir, env) => {
    // The merge base itself is passed so the tool reads the same change the tests gate reverts.
    const command = `${tool.command} ${shellQuote(dir)} ${shellQuote(`--base=${mb.sha}`)} --json`;
    log(`check clean: ${tool.name} at ${short(full)} against ${mb.ref}`);
    const r = await shell(ctx, command, { cwd: dir, env, timeout: Math.round(minutes * 60 * 1000) });
    if (r.timedOut) return { ...timeouts.failure(r, minutes, command, `at ${short(full)}`), sha };
    if (!r.ok) return res(false, `cleanup tool (${tool.name}) failed: ${how(r)}: ${errText(r, 20)}`);
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      return res(false, `cleanup tool (${tool.name}) did not print JSON; it must accept --json. Output starts: ${r.stdout.trim().slice(0, 200)}`);
    }
    if (!report || !Array.isArray(report.items)) {
      return res(false, `cleanup tool (${tool.name}) printed no "items" list; use a deslop version that accepts --base and --json`);
    }
    const items = report.items;
    const high = items.filter((it) => String(it.severity).toLowerCase() === 'high');
    const lines = [`${tool.name} at ${short(full)} against ${mb.ref} (merge base ${short(mb.sha)}): ${items.length ? countBy(items, 'severity') : 'no findings'}`];
    if (items.length) lines.push(`By check: ${countBy(items, 'check')}`);
    // The tool lists HIGH findings first, so a capped list still shows every HIGH it found.
    if (Number.isInteger(report.total) && report.total > items.length) lines.push(`The tool listed ${items.length} of ${report.total} findings.`);
    const gaps = scanGaps(report);
    if (gaps.length) lines.push(`The scan is incomplete; checks that did not run: ${gaps.join('; ')}`);
    if (high.length) {
      lines.push(`HIGH (${high.length}):`);
      for (const it of high.slice(0, SHOW_HIGH)) lines.push(`- ${where(it)} ${it.message || it.check || ''}`.trimEnd());
      if (high.length > SHOW_HIGH) lines.push(`- and ${high.length - SHOW_HIGH} more`);
      lines.push('Fix the HIGH findings, commit, and submit the new sha.');
    }
    if (gaps.length) lines.push('Fix what stopped those checks (the tool, its dependencies, or the files it could not read) and run the gate again.');
    return { ...res(high.length === 0 && gaps.length === 0, lines.join('\n')),
      ...(high.length && !gaps.length ? { confirmed_failure: true } : {}) };
  });
  return { ...out, sha };
}

module.exports = { run };
