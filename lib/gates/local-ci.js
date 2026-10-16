'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const Local = require('../ci-local');
const { fail, short, git, exec, treeExec, withWorktree, mergeCommit, how, killed, errText, tailLines, stripFor } = require('./common');
const { diagnosticRedactor, boundedOutputTail } = require('./tests');

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
// Runs kept per task. ginza's T1 checked one head three times; five keep the current head's
// runs and the last run of the head before it. A ginza run's log is up to 0.5 MB.
const RUNS_KEPT = 5;
// Artifacts are copied as the command wrote them, so they live outside logs/, in a directory
// every agent sandbox hides (lib/agents.js CI_ARTIFACTS). Agents get redacted text only.
const ARTIFACTS_DIR = require('../agents').CI_ARTIFACTS;
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

// Reads at most room + 1 bytes from one descriptor opened without following a final symbolic
// link, so a file swapped or grown after the containment check cannot pass the cap. O_NONBLOCK
// keeps a FIFO from blocking the open.
function readCapped(file, room) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) return { error: 'not a file' };
    const chunks = [];
    let total = 0;
    const chunk = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, room + 1 - total), null);
      if (n === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
      if (total > room) return { over: true };
    }
    return { data: Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}

// Copies the files the run named out of the gate worktree and its scratch, which are removed
// when the gate ends, into dest. A file elsewhere outlives the gate and is not copied. Text files
// get the log's cleanup and redaction. A file with a NUL byte or invalid UTF-8 is binary: decoding it
// would turn its invalid bytes into U+FFFD, so only its exact byte matches are redacted, and it is not
// copied when a secret shows that those cannot remove (lib/binary-redact.js).
function copyArtifacts(local, text, gate, dest, stateDir, redact) {
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
    if (copied.length >= ARTIFACT_FILES) { skip(from, `more than ${ARTIFACT_FILES} files`); continue; }
    let read;
    try { read = readCapped(source, ARTIFACT_BYTES - bytes); } catch (e) { skip(from, e.code === 'ELOOP' ? 'a symbolic link' : e.code || e.message); continue; }
    if (read.error) {
      if (printed) skip(from, read.error);
      continue;
    }
    if (read.over) { skip(from, `over the ${ARTIFACT_BYTES / 1048576} MiB total`); continue; }
    // Separate trees, so a worktree file named TMPDIR/x and a scratch file x cannot share a destination.
    const rel = inside(roots.wt, source) ? path.join('worktree', path.relative(roots.wt, source))
      : inside(roots.tmp, source) ? path.join('TMPDIR', path.relative(roots.tmp, source))
        : path.join('gate', path.relative(roots.parent, source));
    const binary = read.data.includes(0) || !isUtf8(read.data);
    let body;
    let redacted;
    if (binary) {
      const out = redact.bytes(read.data);
      if (out.missed) { skip(from, `binary, and ${out.missed} that exact byte redaction cannot remove`); continue; }
      body = out.body;
      redacted = body !== read.data;
    } else {
      const raw = stripFor(redact, read.data.toString('utf8'));
      body = redact(raw);
      redacted = body !== raw;
    }
    const target = path.join(dest, rel);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, body, { mode: 0o600 });
    } catch (e) {
      skip(from, `copy failed: ${e.code || e.message}`);
      continue;
    }
    bytes += read.data.length;
    copied.push({ from, path: stateRelative(stateDir, target), bytes: Buffer.byteLength(body),
      ...(binary ? { binary: true } : {}), ...(redacted ? { redacted: true } : {}) });
  }
  return { copied, skipped, skippedMore };
}

// Keeps the newest RUNS_KEPT runs of the task, by modification time, in logs/ and ARTIFACTS_DIR.
function prune(stateDir, task) {
  const logs = path.join(stateDir, 'logs');
  const prefix = `ci-${task}-`;
  let runs;
  try {
    runs = fs.readdirSync(logs).filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, at: fs.statSync(path.join(logs, name)).mtimeMs }));
  } catch {
    return;
  }
  runs.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  for (const { name } of runs.slice(RUNS_KEPT)) {
    for (const dir of [logs, path.join(stateDir, ARTIFACTS_DIR)]) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

// Keeps what diagnoses the run before its worktree goes: the redacted output in full under the
// state directory's logs, its bounded tail for the evidence, and on failure the artifacts the run
// named, in ARTIFACTS_DIR.
function keepRun(ctx, local, r, gate, sha, redact) {
  const raw = r.output != null ? r.output : [r.stdout, r.stderr].filter(Boolean).join('\n');
  // Escapes come out first: one between a token's prefix and its body hides it from the patterns,
  // and removing it afterwards would put the token back together. Redacted before anything is cut:
  // a cut through a token would leave a fragment the patterns miss.
  const plain = redact(stripFor(redact, raw));
  const kept = { log: null, ...(r.ok ? {} : { output_tail: boundedOutputTail(plain, TAIL_LINES, TAIL_CHARS) }), artifacts: [] };
  if (!ctx.stateDir) return { kept, plain, logFile: null };
  let runDir;
  try {
    const logs = path.join(ctx.stateDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    runDir = fs.mkdtempSync(path.join(logs, `ci-${ctx.task.id}-${short(sha)}-`));
    fs.writeFileSync(path.join(runDir, 'output.log'), plain);
  } catch (e) {
    ctx.log?.(`could not save the local CI log: ${e.message}`);
    return { kept: { ...kept, log_error: e.message }, plain, logFile: null };
  }
  const logFile = path.join(runDir, 'output.log');
  kept.log = stateRelative(ctx.stateDir, logFile);
  // A passing run's files prove nothing the receipt does not, so only a failure keeps them.
  if (!r.ok && (local.artifacts.length || local.artifact_pattern)) {
    // A failure to keep artifacts must not turn the command's own result into a gate error.
    try {
      const store = path.join(ctx.stateDir, ARTIFACTS_DIR);
      fs.mkdirSync(store, { recursive: true, mode: 0o700 });
      // Like homes/, ignored by a repository that holds the state directory.
      const ignore = path.join(store, '.gitignore');
      try {
        fs.writeFileSync(ignore, '*\n', { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const { copied, skipped, skippedMore } = copyArtifacts(local, plain, gate, path.join(store, path.basename(runDir)), ctx.stateDir, redact);
      kept.artifacts = copied;
      if (skipped.length) kept.artifacts_skipped = skipped;
      if (skippedMore) kept.artifacts_skipped_more = skippedMore;
    } catch (e) {
      kept.artifacts_error = e.message;
      ctx.log?.(`could not keep the local CI artifacts: ${e.message}`);
    }
  }
  try {
    prune(ctx.stateDir, ctx.task.id);
  } catch (e) {
    ctx.log?.(`could not prune old local CI runs: ${e.message}`);
  }
  return { kept, plain, logFile };
}

// The summary reaches worker and reviewer prompts through rework reasons, so it names the
// redacted log and only counts the artifacts, which the orchestrator and the owner read from the
// evidence's local_ci.artifacts.
function failedSummary(r, plain, kept, logFile, redact) {
  const lines = [`local CI ${redact(how(r))}: ${tailLines(plain.trim(), SUMMARY_LINES) || '(empty output)'}`];
  if (logFile) lines.push(`Full log: ${logFile}`);
  else if (kept.log_error) lines.push(`Full log not saved: ${kept.log_error}`);
  if (kept.artifacts.length) lines.push(`Artifacts: ${kept.artifacts.length} kept for the orchestrator and the owner (local_ci.artifacts)`);
  return lines.join('\n');
}

async function run(ctx) {
  const { root, project, task } = ctx;
  const local = Local.resolve(project.ci.local, task);
  if (local.error) return fail(local.error);
  const current = Local.snapshot(root, project, task.sha);
  if (current.error) return fail(current.error);
  const redact = diagnosticRedactor(project, root);
  // A clean checkout: a check that requires one (ginza's tools/check.py working_tree_clean)
  // fails when HEAD names the head while the index holds the merge.
  const merged = await mergeCommit(ctx, root, { base: current.base_sha, head: current.head_sha, tree: current.tree_hash });
  if (merged.error) return fail(`local CI ${merged.error}`);
  const result = await withWorktree(ctx, root, merged.sha, async (dir, env) => {
    ctx.log?.(`local CI (${local.variant}) at ${short(current.head_sha)} on merge ${short(merged.sha)} of tree ${short(current.tree_hash)}`);
    const start = performance.now();
    const r = await exec({ ...ctx, exec: ctx.exec || treeExec }, local.command[0], local.command.slice(1), {
      cwd: dir, env, timeout: Math.max(1, Math.round(local.timeout * 1000)), processTree: true,
    });
    const receipt = {
      ...current, merge_sha: merged.sha, variant: local.variant, command: [...local.command], timeout: local.timeout,
      exit: r.status, signal: r.signal, duration_ms: Math.round(performance.now() - start),
    };
    const gate = { dir, scratch: env.TMPDIR, parent: path.dirname(dir) };
    const { kept, plain, logFile } = keepRun(ctx, local, r, gate, current.head_sha, redact);
    const res = (ok, summary) => ({ ok, summary, sha: current.head_sha, receipt, local_ci: kept });
    if (!r.ok) return { ...res(false, failedSummary(r, plain, kept, logFile, redact)), ...failure(r) };
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

module.exports = { run, TAIL_LINES, TAIL_CHARS, ARTIFACT_BYTES, ARTIFACT_FILES, RUNS_KEPT, ARTIFACTS_DIR };
