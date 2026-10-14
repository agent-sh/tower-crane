'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Local = require('../ci-local');
const { fail, short, git, exec, treeExec, withWorktree, how, killed, errText, tailLines, listSome } = require('./common');
const { diagnosticRedactor, boundedOutputTail, ANSI_ESCAPE } = require('./tests');

// A local CI script runs many steps and prints each step's output when the step ends, so the
// failing step is rarely the last thing printed. Over 889 step outputs of ginza's tools/check.py
// the 90th percentile was 114 lines and 6950 characters: 200 lines and 16 KiB hold the whole
// last step in nine runs of ten, plus the closing receipt lines. The full log keeps the rest.
const TAIL_LINES = 200;
const TAIL_CHARS = 16384;
// The summary is repeated in rework reasons and the inbox, so it keeps the short tail it had.
const SUMMARY_LINES = 20;
// ginza's check receipts measured up to 5.8 MB (513 receipts, mean 0.5 MB), and one run writes
// one or two. These caps hold ten of the largest and stop a broad glob from copying a build tree
// into the state directory; evidence lists every copied file.
const ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_FILES = 100;
// Skipped files are listed for diagnosis; a glob that matched thousands needs only a count.
const SKIPPED_LISTED = 20;

// A timeout or a command killed by a signal failed in its runner, so automation
// retries it once. Only a nonzero exit is a verdict on the merged tree.
function failure(r) {
  if (r.timedOut) return { infrastructure_failure: true };
  if (killed(r)) return { runner_crash: true };
  return Number.isInteger(r.status) && ![0, 126, 127].includes(r.status) && !r.error ? { confirmed_failure: true } : {};
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const stateRelative = (stateDir, file) => path.relative(stateDir, file).split(path.sep).join('/');

// The files the run named: paths its output printed that match artifact_pattern, then the
// artifacts globs in the worktree. Printed paths come first, since the command chose them.
function candidates(local, text, dir) {
  const found = [];
  if (local.artifact_pattern) {
    const re = new RegExp(local.artifact_pattern);
    for (const line of text.split(/\r?\n/)) {
      const m = re.exec(line);
      const named = (m && (m.length > 1 ? m[1] : m[0]))?.trim();
      if (named) found.push({ from: named, file: path.resolve(dir, named), printed: true });
    }
  }
  for (const glob of local.artifacts) {
    for (const rel of fs.globSync(glob, { cwd: dir })) found.push({ from: rel, file: path.join(dir, rel), printed: false });
  }
  return found;
}

// Copies the files the run named out of the gate worktree and its scratch, which are removed
// when the gate ends, into runDir/artifacts. A file elsewhere outlives the gate and is not copied.
function copyArtifacts(local, text, gate, runDir, stateDir) {
  const copied = [];
  const skipped = [];
  let skippedMore = 0;
  const skip = (from, reason) => {
    if (skipped.length < SKIPPED_LISTED) skipped.push({ from, reason });
    else skippedMore += 1;
  };
  const real = (p) => fs.realpathSync.native(p);
  const roots = { parent: real(gate.parent), wt: real(gate.dir), tmp: real(gate.scratch) };
  const seen = new Set();
  let bytes = 0;
  for (const { from, file, printed } of candidates(local, text, gate.dir)) {
    let source;
    try { source = real(file); } catch { skip(from, 'missing'); continue; }
    if (seen.has(source)) continue;
    seen.add(source);
    if (!inside(roots.parent, source)) { skip(from, 'outside the gate worktree and its scratch, so it is kept where it is'); continue; }
    let stat;
    try { stat = fs.statSync(source); } catch (e) { skip(from, e.code || e.message); continue; }
    if (!stat.isFile()) {
      if (printed) skip(from, 'not a file');
      continue;
    }
    if (copied.length >= ARTIFACT_FILES) { skip(from, `more than ${ARTIFACT_FILES} files`); continue; }
    if (bytes + stat.size > ARTIFACT_BYTES) { skip(from, `over the ${ARTIFACT_BYTES / 1048576} MiB total`); continue; }
    const rel = inside(roots.wt, source) ? path.relative(roots.wt, source)
      : inside(roots.tmp, source) ? path.join('TMPDIR', path.relative(roots.tmp, source))
        : path.relative(roots.parent, source);
    const dest = path.join(runDir, 'artifacts', rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(source, dest);
    } catch (e) {
      skip(from, `copy failed: ${e.code || e.message}`);
      continue;
    }
    bytes += stat.size;
    copied.push({ from, path: stateRelative(stateDir, dest), bytes: stat.size });
  }
  return { copied, skipped, skippedMore };
}

// Keeps what diagnoses the run before its worktree goes: the redacted output in full under the
// state directory's logs, its bounded tail for the evidence, and the artifacts the run named.
function keepRun(ctx, local, r, gate, sha, redact) {
  const raw = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  // Redacted before anything is cut: a cut through a token would leave a fragment the patterns miss.
  const text = redact(raw);
  const plain = text.replace(ANSI_ESCAPE, '');
  const kept = { log: null, ...(r.ok ? {} : { output_tail: boundedOutputTail(plain, TAIL_LINES, TAIL_CHARS) }), artifacts: [] };
  if (!ctx.stateDir) return { kept, plain, logFile: null };
  let runDir;
  try {
    const logs = path.join(ctx.stateDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    runDir = fs.mkdtempSync(path.join(logs, `ci-${ctx.task.id}-${short(sha)}-`));
    fs.writeFileSync(path.join(runDir, 'output.log'), text);
  } catch (e) {
    ctx.log?.(`could not save the local CI log: ${e.message}`);
    return { kept: { ...kept, log_error: e.message }, plain, logFile: null };
  }
  const logFile = path.join(runDir, 'output.log');
  kept.log = stateRelative(ctx.stateDir, logFile);
  if (local.artifacts.length || local.artifact_pattern) {
    // A failure to keep artifacts must not turn the command's own result into a gate error.
    try {
      const { copied, skipped, skippedMore } = copyArtifacts(local, plain, gate, runDir, ctx.stateDir);
      kept.artifacts = copied;
      if (skipped.length) kept.artifacts_skipped = skipped;
      if (skippedMore) kept.artifacts_skipped_more = skippedMore;
    } catch (e) {
      kept.artifacts_error = e.message;
      ctx.log?.(`could not keep the local CI artifacts: ${e.message}`);
    }
  }
  return { kept, plain, logFile };
}

function failedSummary(r, plain, kept, logFile, stateDir, redact) {
  const lines = [`local CI ${redact(how(r))}: ${tailLines(plain.trim(), SUMMARY_LINES) || '(empty output)'}`];
  if (logFile) lines.push(`Full log: ${logFile}`);
  else if (kept.log_error) lines.push(`Full log not saved: ${kept.log_error}`);
  if (kept.artifacts.length) {
    lines.push(`Saved artifacts: ${listSome(kept.artifacts.map((a) => `${a.from} -> ${path.join(stateDir, a.path)}`))}`);
  }
  return lines.join('\n');
}

async function run(ctx) {
  const { root, project, task } = ctx;
  const local = Local.resolve(project.ci.local, task);
  if (local.error) return fail(local.error);
  const current = Local.snapshot(root, project, task.sha);
  if (current.error) return fail(current.error);
  const redact = diagnosticRedactor(project, root);
  const result = await withWorktree(ctx, root, current.head_sha, async (dir, env) => {
    // Keep HEAD at the submitted commit while the index and checkout contain the merge result.
    const checkout = await git(ctx, dir, ['read-tree', '--reset', '-u', current.tree_hash], { env });
    if (!checkout.ok) return fail(`local CI cannot check out the merged tree: ${errText(checkout)}`);
    ctx.log?.(`local CI (${local.variant}) at ${short(current.head_sha)} on merged tree ${short(current.tree_hash)}`);
    const start = performance.now();
    const r = await exec({ ...ctx, exec: ctx.exec || treeExec }, local.command[0], local.command.slice(1), {
      cwd: dir, env, timeout: Math.max(1, Math.round(local.timeout * 1000)), processTree: true,
    });
    const receipt = {
      ...current, variant: local.variant, command: [...local.command], timeout: local.timeout,
      exit: r.status, signal: r.signal, duration_ms: Math.round(performance.now() - start),
    };
    const gate = { dir, scratch: env.TMPDIR, parent: path.dirname(dir) };
    const { kept, plain, logFile } = keepRun(ctx, local, r, gate, current.head_sha, redact);
    const res = (ok, summary) => ({ ok, summary, sha: current.head_sha, receipt, local_ci: kept });
    if (!r.ok) return { ...res(false, failedSummary(r, plain, kept, logFile, ctx.stateDir, redact)), ...failure(r) };
    const unchanged = await git(ctx, dir, ['diff', '--quiet', current.tree_hash, '--'], { env });
    const index = await git(ctx, dir, ['write-tree'], { env });
    if (!unchanged.ok || !index.ok || index.stdout.trim() !== current.tree_hash) {
      return res(false, 'local CI changed tracked sources; its result does not cover the merged tree');
    }
    const latest = Local.snapshot(root, project, task.sha);
    if (latest.error || latest.tree_hash !== current.tree_hash || latest.source_digest !== current.source_digest) {
      return res(false, 'local CI merged tree moved during the check; run check ci again');
    }
    return res(true, `local CI (${local.variant}) passed at ${short(current.head_sha)} on merged tree ${short(current.tree_hash)} (${receipt.duration_ms} ms)`);
  });
  return { ...result, sha: current.head_sha };
}

module.exports = { run, TAIL_LINES, TAIL_CHARS, ARTIFACT_BYTES, ARTIFACT_FILES };
