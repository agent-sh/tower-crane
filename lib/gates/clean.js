'use strict';
// Gate `check clean ID`: the cleanup tool (deslop) reads the task's change against the base
// branch; any HIGH finding, or a scan that did not complete, fails the gate. It runs on a fresh
// checkout of the submitted commit because the task worktree may have moved on or hold
// uncommitted edits.
const fs = require('fs');
const path = require('path');
const { fail, short, how, killed, notFound, tailLines, shell, shellQuote, git, resolveCommit, mergeBase, withWorktree } = require('./common');

const { gitEnv } = require('../commands');
const timeouts = require('../gate-timeouts');
const SHOW_HIGH = 10;
const SHOW_OUT = 5;
// The old deslop plugin ignores --base and scans every file, so its findings are not the
// change's. The rewrite reports `"scope": "diff"` and ties each finding to the change. Both carry
// plugin version 5.5.0, so the report's scope tells them apart, not a version number.
const DIFF_SCOPED_FIX = 'install the diff-scoped deslop rewrite (agent-sh/deslop main from commit e669dbc; its --json report carries "scope": "diff", the old plugin\'s does not) and pin its scripts/detect.js with project set --clean-cmd';

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

// A path in `git diff` output: quoted with C escapes when it holds a quote, backslash or control
// character, even with core.quotePath off.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function diffPath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
    } else if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The files merge base..head changes and the lines it adds or rewrites on the head side.
async function changeOf(ctx, root, from, to) {
  // --text and --inter-hunk-context=0 so a binary attribute or a config setting cannot hide or widen the changed lines.
  const opts = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--text', '--inter-hunk-context=0', '-M'];
  const names = await git(ctx, root, [...opts, '--name-only', '-z', from, to]);
  const patch = await git(ctx, root, [...opts, '-U0', '--src-prefix=a/', '--dst-prefix=b/', from, to]);
  if (!names.ok || !patch.ok) return null;
  const files = new Set(names.stdout.split('\0').filter(Boolean));
  const lines = new Map();
  let ranges = null;
  let prev = '';
  // Lines left in the current hunk body: an added line that reads `++ x` shows as `+++ x` and
  // must not be taken for a file header.
  let left = 0;
  for (const line of patch.stdout.split('\n')) {
    if (left > 0) {
      if (!line.startsWith('\\')) left--;
    } else if (line.startsWith('diff --git ')) {
      ranges = null;
    } else if (line.startsWith('+++ ') && prev.startsWith('--- ')) {
      const p = diffPath(line.slice(4).replace(/\t$/, ''));
      ranges = p.startsWith('b/') ? [] : null;
      if (ranges) lines.set(p.slice(2), ranges);
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return null;
      const removed = m[1] !== undefined ? Number(m[1]) : 1;
      const start = Number(m[2]);
      const count = m[3] !== undefined ? Number(m[3]) : 1;
      left = removed + count;
      if (ranges && count > 0) ranges.push([start, start + count - 1]);
    }
    prev = line;
  }
  return { files, lines };
}

// A finding's path relative to the checkout, or null when it names no file (PR text, say).
function relPath(file, dirs) {
  if (typeof file !== 'string' || !file || file.startsWith('(')) return null;
  let p = file;
  if (path.isAbsolute(p)) {
    const inside = dirs.map((d) => path.relative(d, p)).find((r) => r && !r.startsWith('..') && !path.isAbsolute(r));
    p = inside === undefined ? p : inside;
  }
  return path.posix.normalize(p.split(path.sep).join('/'));
}

// A finding is the change's when its file is changed and its line, if it names one, is one the
// change added or rewrote. A finding that names no file cannot be placed, so it is judged.
function inChange(it, change, dirs) {
  const file = relPath(it.file, dirs);
  if (file === null) return true;
  if (!change.files.has(file)) return false;
  const line = Number(it.line);
  if (!Number.isInteger(line) || line <= 0) return true;
  return (change.lines.get(file) || []).some(([a, b]) => line >= a && line <= b);
}

// The old deslop plugin prints `findings` where the gate reads `items`, and exits 2 on any
// critical finding anywhere in the repository.
function oldDeslop(stdout) {
  try {
    const report = JSON.parse(stdout);
    return !!report && Array.isArray(report.findings) && !Array.isArray(report.items);
  } catch {
    return false;
  }
}

async function run(ctx) {
  const { root, task, project } = ctx;
  const args = ctx.args || {};
  const log = ctx.log || (() => {});
  const selected = require('../gate-commands').select(project, 'clean', args);
  if (selected.error) return fail(selected.error, selected.config ? { config_failure: selected.config } : {});
  if (!task.sha) return fail(`task ${task.id} has no submitted sha; submit it first with tower-crane submit ${task.id} --sha SHA`);
  if (!project.base) return fail('project.json has no base branch; set "base" (for example "main")');
  const minutes = args.timeout == null ? timeouts.minutes(project, 'clean') : Number(args.timeout);
  if (!timeouts.valid(minutes)) return fail(`--timeout must be a positive number of minutes within Node's timer range, got ${args.timeout}`);
  const sha = task.sha;
  const res = (ok, summary) => ({ ok, summary, sha });

  const tool = { command: selected.command, name: selected.command };
  const full = await resolveCommit(ctx, root, sha);
  if (!full) return res(false, `commit ${sha} is not in ${root}; fetch it (git fetch origin ${task.branch || '<branch>'}) and run the gate again`);
  const mb = await mergeBase(ctx, root, project.base, full, task);
  if (!mb) return res(false, `no merge base between ${project.base} and ${short(full)}; fetch ${project.base} (git fetch origin ${project.base}) and run the gate again`);

  // The tool's output reaches summaries, evidence and worker prompts.
  const redact = require('./tests').diagnosticRedactor(project, root);
  const out = await withWorktree(ctx, root, full, async (dir, env) => {
    // The merge base itself is passed so the tool reads the same change the tests gate reverts.
    const command = `${tool.command} ${shellQuote(dir)} ${shellQuote(`--base=${mb.sha}`)} --json`;
    log(`check clean: ${tool.name} at ${short(full)} against ${mb.ref}`);
    // The tool is the owner's, but the git it runs here reads the repository config a worker writes.
    const r = await shell(ctx, command, { cwd: dir, env: gitEnv(dir, env), timeout: Math.round(minutes * 60 * 1000) });
    if (r.timedOut) return { ...timeouts.failure(r, minutes, command, `at ${short(full)}`, redact), sha };
    if (!r.ok) {
      // The exit status still fails the gate; the old plugin's output only names the fix.
      const old = !killed(r) && oldDeslop(r.stdout);
      const hint = old ? `\nIts output is the old deslop plugin's (a "findings" list, no "scope"), which ignores --base and exits 2 on a critical finding anywhere in the repository. To judge only the change, ${DIFF_SCOPED_FIX}.` : '';
      // Redacted before the cut to 20 lines, so the cut cannot leave a fragment the patterns miss.
      const said = tailLines(redact(r.stderr.trim() || r.stdout.trim()), 20);
      return { ...res(false, `cleanup tool (${tool.name}) failed: ${redact(how(r))}: ${said}${hint}`), ...(killed(r) ? { runner_crash: true } : {}),
        ...(notFound(r) || old ? { config_failure: { key: 'clean_cmd' } } : {}) };
    }
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      return res(false, `cleanup tool (${tool.name}) did not print JSON; it must accept --json. Output starts: ${redact(r.stdout.trim()).slice(0, 200)}`);
    }
    if (!report || !Array.isArray(report.items)) {
      const old = !!report && Array.isArray(report.findings);
      return { ...res(false, `cleanup tool (${tool.name}) printed no "items" list${old ? ' but a "findings" list, the old deslop plugin\'s output, which ignores --base' : ''}; ${DIFF_SCOPED_FIX}`),
        config_failure: { key: 'clean_cmd' } };
    }
    // A tool that declares diff scope already tied each finding to the change, including a stale
    // mention in a file the change did not touch. Any other report is cut to the change here.
    const scoped = report.scope === 'diff';
    let items = report.items;
    let outside = [];
    if (!scoped && items.length) {
      const change = await changeOf(ctx, root, mb.sha, full);
      if (!change) return { ...res(false, `cannot list the files ${short(mb.sha)}..${short(full)} changes, so the findings of ${tool.name}, which reports no diff scope, cannot be scoped to the change; run the gate again`), infrastructure_failure: true };
      // The tool may print absolute paths through either spelling of the checkout.
      const dirs = [dir, fs.realpathSync.native(dir)];
      // Shown relative to the checkout, which the gate removes when it ends.
      const placed = items.map((it) => ({ ...it, file: relPath(it.file, dirs) ?? it.file }));
      outside = placed.filter((it) => !inChange(it, change, dirs));
      items = placed.filter((it) => inChange(it, change, dirs));
    }
    const high = items.filter((it) => String(it.severity).toLowerCase() === 'high');
    const lines = [`${tool.name} at ${short(full)} against ${mb.ref} (merge base ${short(mb.sha)}): ${items.length ? countBy(items, 'severity') : 'no findings'}${outside.length ? ' in the change' : ''}`];
    if (items.length) lines.push(`By check: ${countBy(items, 'check')}`);
    if (outside.length) {
      const shown = outside.slice(0, SHOW_OUT).map((it) => `${where(it)}${it.severity ? ` (${String(it.severity).toLowerCase()})` : ''}`).join(', ');
      lines.push(`Out of scope, not judged (${outside.length}, outside the files and lines ${short(mb.sha)}..${short(full)} changes): ${shown}${outside.length > SHOW_OUT ? `, and ${outside.length - SHOW_OUT} more` : ''}`);
      const every = items.length === 0 ? 'every finding is' : `${outside.length} of ${outside.length + items.length} findings are`;
      lines.push(`The tool reported no diff scope (no "scope": "diff" in its JSON) and ${every} outside the change, so it likely ignores --base and scans the whole repository, as the old deslop plugin does. To judge only the change, ${DIFF_SCOPED_FIX}.`);
    }
    // The tool lists HIGH findings first, so a capped list still shows every HIGH it found.
    if (scoped && Number.isInteger(report.total) && report.total > report.items.length) lines.push(`The tool listed ${report.items.length} of ${report.total} findings.`);
    const gaps = scanGaps(report);
    // The cut runs after the tool's cap, so a capped report without diff scope can hide a finding
    // in the change behind findings elsewhere.
    if (!scoped && Number.isInteger(report.total) && report.total > report.items.length) {
      gaps.push(`the tool listed ${report.items.length} of ${report.total} findings and reports no diff scope, so findings in the change may be past its cap; raise its limit or ${DIFF_SCOPED_FIX}`);
    }
    if (gaps.length) lines.push(`The scan is incomplete; checks that did not run: ${gaps.join('; ')}`);
    if (high.length) {
      lines.push(`HIGH (${high.length}):`);
      for (const it of high.slice(0, SHOW_HIGH)) lines.push(`- ${where(it)} ${it.message || it.check || ''}`.trimEnd());
      if (high.length > SHOW_HIGH) lines.push(`- and ${high.length - SHOW_HIGH} more`);
      lines.push('Fix the HIGH findings, commit, and submit the new sha.');
    }
    if (gaps.length) lines.push('Fix what stopped those checks (the tool, its dependencies, or the files it could not read) and run the gate again.');
    // Checks that did not run are the tool's failure, so automation retries the scan once before it reworks.
    return { ...res(high.length === 0 && gaps.length === 0, lines.join('\n')),
      ...(high.length && !gaps.length ? { confirmed_failure: true } : {}), ...(gaps.length ? { infrastructure_failure: true } : {}) };
  });
  return { ...out, sha };
}

module.exports = { run };
