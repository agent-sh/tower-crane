'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isUtf8 } = require('node:buffer');
const Local = require('../ci-local');
const { fail, short, git, exec, treeExec, withWorktree, mergeCommit, how, killed, errText, tailLines, stripFor, redactJoined } = require('./common');
const { diagnosticRedactor, boundedOutputTail } = require('./tests');
const { textBudget, textWork } = require('../text-redaction-budget');

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
// Eight MiB holds ginza's largest measured receipt (5.8 MB). Scan and redact the whole
// bounded input before cutting it, so a secret across the cut cannot leave a fragment.
const RECEIPT_BYTES = 8 * 1024 * 1024;
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

const jsonLike = (raw) => ['{', '[', '"'].includes(raw.trimStart()[0])
  || (raw.includes('"') && raw.includes('\\'));

// JSON escapes hide controls and line breaks inside captured output. Redact decoded keys
// and strings, then serialize them so those readings cannot expose a credential.
function receiptText(raw, redact) {
  return textBudget(raw, () => {
    let redacted = false;
    const clean = (text) => {
      const body = redact(stripFor(redact, text));
      if (body !== text) redacted = true;
      return body;
    };
    try {
      const value = JSON.parse(raw.replace(/^\uFEFF/, ''), (key, item, context) => {
        textWork();
        if (typeof item === 'number') return JSON.rawJSON(context.source);
        if (typeof item === 'string') return clean(item);
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const result = Object.create(null);
        for (const [name, child] of Object.entries(item)) {
          textWork();
          const label = clean(name);
          let unique = label;
          let suffix = 2;
          while (Object.hasOwn(result, unique)) {
            textWork();
            unique = `${label} (${suffix++})`;
          }
          result[unique] = child;
        }
        return result;
      });
      return { body: JSON.stringify(value), redacted };
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (jsonLike(raw)) return {
          body: '[unscannable JSON receipt: invalid or multiple JSON values; content omitted]', redacted: true,
        };
        return { body: clean(raw), redacted };
      }
      if (e instanceof RangeError) return {
        body: '[unscannable JSON receipt: nesting exceeds the JSON processor; content omitted]', redacted: true,
      };
      throw e;
    }
  }, (body) => ({ body, redacted: true }));
}

// Windows tools can write JSON as UTF-16. A valid document uses the same decoded
// redaction as UTF-8 instead of the exact byte matcher for other binary files.
function unicodeReceipt(data, redact) {
  for (const encoding of ['utf-16le', 'utf-16be']) {
    let raw;
    try {
      raw = new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch {
      raw = new TextDecoder(encoding).decode(data);
      if (jsonLike(raw)) return {
        body: '[unscannable JSON receipt: invalid Unicode encoding; content omitted]', redacted: true,
      };
      continue;
    }
    const result = textBudget(raw, () => {
      if (!jsonLike(raw)) {
        try { JSON.parse(raw); } catch { return null; }
      }
      return receiptText(raw, redact);
    }, (body) => ({ body, redacted: true }));
    if (result) return result;
  }
  const raw = new TextDecoder().decode(data);
  if (jsonLike(raw)) return {
    body: '[unscannable JSON receipt: invalid text encoding or JSON; content omitted]', redacted: true,
  };
  return null;
}

// Copies the files the run named out of the gate worktree and its scratch, which are removed
// when the gate ends, into dest. A file elsewhere outlives the gate and is not copied. Text files
// get the log's cleanup and redaction. A file with a NUL byte or invalid UTF-8 is binary: decoding it
// would turn its invalid bytes into U+FFFD, so only its exact byte matches are redacted, and it is not
// copied when a secret shows that those cannot remove (lib/binary-redact.js).
function copyArtifacts(local, text, gate, dest, stateDir, redact, receipts = false) {
  const copied = [];
  const skipped = [];
  const failures = new Set();
  const steps = new Set();
  const labels = [];
  const fields = [];
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
    if (receipts && !inside(roots.wt, source)) { skip(from, 'outside the gate worktree'); continue; }
    if (copied.length >= ARTIFACT_FILES) { skip(from, `more than ${ARTIFACT_FILES} files`); continue; }
    let read;
    try { read = readCapped(source, ARTIFACT_BYTES - bytes); } catch (e) { skip(from, e.code === 'ELOOP' ? 'a symbolic link' : e.code || e.message); continue; }
    if (read.error) {
      if (printed) skip(from, read.error);
      continue;
    }
    if (read.over) { skip(from, `over the ${ARTIFACT_BYTES / 1048576} MiB total`); continue; }
    // Separate trees, so a worktree file named TMPDIR/x and a scratch file x cannot share a destination.
    const rel = receipts ? path.relative(roots.wt, source)
      : inside(roots.wt, source) ? path.join('worktree', path.relative(roots.wt, source))
      : inside(roots.tmp, source) ? path.join('TMPDIR', path.relative(roots.tmp, source))
        : path.join('gate', path.relative(roots.parent, source));
    let binary = read.data.includes(0) || !isUtf8(read.data);
    let body;
    let redacted;
    const unicode = receipts && binary ? unicodeReceipt(read.data, redact) : null;
    if (unicode) {
      ({ body, redacted } = unicode);
      binary = false;
    } else if (binary) {
      const out = redact.bytes(read.data);
      if (out.missed) { skip(from, `binary, and ${out.missed} that exact byte redaction cannot remove`); continue; }
      body = out.body;
      redacted = body !== read.data;
    } else if (receipts) {
      ({ body, redacted } = receiptText(read.data.toString('utf8'), redact));
    } else {
      const raw = stripFor(redact, read.data.toString('utf8'));
      body = redact(raw);
      redacted = body !== raw;
    }
    const diagnostic = receipts && !binary ? receiptDiagnostic(body, redact) : { names: [], labels: [], fields: [] };
    let truncated = false;
    if (receipts && Buffer.byteLength(body) > RECEIPT_BYTES) {
      const notice = Buffer.from(`\n[receipt truncated at ${RECEIPT_BYTES / 1048576} MiB]\n`);
      const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
      let end = RECEIPT_BYTES - notice.length;
      if (!binary) while (end > 0 && (data[end] & 0xc0) === 0x80) end -= 1;
      body = Buffer.concat([data.subarray(0, end), notice]);
      truncated = true;
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
    for (const name of diagnostic.names) failures.add(name);
    for (const step of diagnostic.steps || []) steps.add(step);
    labels.push(...diagnostic.labels);
    fields.push(...diagnostic.fields);
    copied.push({ from, path: stateRelative(stateDir, target), bytes: Buffer.byteLength(body),
      ...(binary ? { binary: true } : {}), ...(redacted ? { redacted: true } : {}),
      ...(truncated ? { truncated: true } : {}) });
  }
  const summary = safeReceiptSummary([...failures], [labels, fields], redact);
  // Failed step names leave the receipts only when their summary did: a rerun passes them as arguments.
  return { copied, skipped, skippedMore, failures: summary,
    steps: summary.some((name) => name.startsWith('[receipt summary omitted')) ? [] : [...steps] };
}

const SUMMARY_OMITTED = '[receipt summary omitted: a credential spans fields]';

// Fields that are safe separately can recreate a wrapped credential when read together.
function safeReceiptSummary(names, readings, redact) {
  if (!redact) return names;
  const groups = [names, ...readings];
  return textBudget(groups.map(group => group.join('\n')).join('\n'), () => {
    const clean = (text) => redact(stripFor(redact, text));
    const result = names.map(clean);
    for (const reading of groups) {
      const joined = reading.map(clean).join('\n');
      if (clean(joined) !== joined) return [SUMMARY_OMITTED];
    }
    return [...new Set(result)];
  }, () => ['[receipt summary omitted: redaction limit]']);
}

// check.py records reasons even when the step output ended in OK. Other receipt formats
// still reach the summary through their copied paths.
function receiptFailures(body, redact) {
  return receiptDiagnostic(body, redact).names;
}

function receiptDiagnostic(body, redact) {
  if (!redact) return receiptDiagnosticWithin(body);
  try {
    return textBudget(body, () => receiptDiagnosticWithin(body, redact), () => ({
      names: ['[receipt summary omitted: redaction limit]'], labels: [], fields: [],
    }));
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { names: ['[receipt summary omitted: processing limit]'], labels: [], fields: [] };
  }
}

function receiptDiagnosticWithin(body, redact) {
  const empty = { names: [], labels: [], fields: [] };
  let receipt;
  try { receipt = JSON.parse(body); } catch { return empty; }
  if (!receipt || typeof receipt !== 'object') return empty;
  const names = [];
  const labels = [];
  const fields = [];
  const readings = [];
  const steps = [];
  for (const step of Array.isArray(receipt.steps) ? receipt.steps : []) {
    if (!step || typeof step.outcome !== 'string' || step.outcome === 'passed') continue;
    const name = typeof step.name === 'string' && step.name.trim() ? step.name
      : Array.isArray(step.argv) && step.argv.every((arg) => typeof arg === 'string') ? step.argv.join(' ').trim() : '';
    if (!name) continue;
    steps.push(name);
    const parts = typeof step.name === 'string' && step.name.trim() ? [step.name] : step.argv;
    labels.push(...parts);
    fields.push(...parts, step.outcome);
    readings.push([...parts, step.outcome]);
    const check = Number.isInteger(step.check) && Array.isArray(receipt.checks) ? receipt.checks[step.check] : null;
    const details = [`outcome: ${step.outcome}`];
    if (Number.isInteger(check?.exit_code)) details.push(`exit ${check.exit_code}`);
    if (check?.timed_out === true) details.push('timed out');
    names.push(`${name} (${details.join(', ')})`);
  }
  const reasons = Array.isArray(receipt.failure_reasons)
    ? receipt.failure_reasons.filter((reason) => typeof reason === 'string' && reason.trim()) : [];
  labels.push(...reasons);
  fields.push(...reasons);
  for (const [key, reason] of [
    ['head_unchanged', 'head changed during local CI'],
    ['source_unchanged', 'sources changed during local CI'],
    ['working_tree_clean_after', 'working tree is dirty after local CI'],
  ]) {
    if (receipt[key] === false) reasons.push(reason);
  }
  const result = safeReceiptSummary([...new Set([...names, ...reasons])], [labels, fields, ...readings], redact);
  if (result.includes(SUMMARY_OMITTED)) return { names: result, labels: [], fields: [] };
  const clean = (text) => redact ? redact(stripFor(redact, text)) : text;
  return { names: result, labels: labels.map(clean), fields: fields.map(clean), steps: [...new Set(steps.map(clean))] };
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

function artifactStore(stateDir) {
  const store = path.join(stateDir, ARTIFACTS_DIR);
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(store, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return store;
}

// Keeps what diagnoses the run before its worktree goes: the redacted output in full under the
// state directory's logs, its bounded tail for the evidence, and on failure the artifacts the run
// named, in ARTIFACTS_DIR. Receipt contents stay hidden there on both pass and fail.
function keepRun(ctx, local, r, gate, sha, redact) {
  // Escapes come out first: one between a token's prefix and its body hides it from the patterns,
  // and removing it afterwards would put the token back together. Redacted before anything is cut:
  // a cut through a token would leave a fragment the patterns miss.
  const plain = redactJoined(r, redact);
  const kept = { log: null, ...(r.ok ? {} : { output_tail: boundedOutputTail(plain, TAIL_LINES, TAIL_CHARS) }), artifacts: [], receipts: [] };
  let steps = [];
  if (!ctx.stateDir) return { kept, plain, logFile: null, steps };
  let runDir;
  try {
    const logs = path.join(ctx.stateDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    runDir = fs.mkdtempSync(path.join(logs, `ci-${ctx.task.id}-${short(sha)}-`));
    fs.writeFileSync(path.join(runDir, 'output.log'), plain);
  } catch (e) {
    ctx.log?.(`could not save the local CI log: ${e.message}`);
    return { kept: { ...kept, log_error: e.message }, plain, logFile: null, steps };
  }
  const logFile = path.join(runDir, 'output.log');
  kept.log = stateRelative(ctx.stateDir, logFile);
  if (local.receipts.length) {
    try {
      const { copied, skipped, skippedMore, failures, steps: failed } = copyArtifacts(
        { artifacts: local.receipts }, '', gate,
        path.join(artifactStore(ctx.stateDir), path.basename(runDir), 'receipts'), ctx.stateDir, redact, true);
      kept.receipts = copied;
      steps = failed;
      if (failures.length) kept.receipt_failures = failures;
      if (skipped.length) kept.receipts_skipped = skipped;
      if (skippedMore) kept.receipts_skipped_more = skippedMore;
    } catch (e) {
      kept.receipts_error = e.message;
      ctx.log?.(`could not keep the local CI receipts: ${e.message}`);
    }
  }
  // A passing run's files prove nothing the receipt does not, so only a failure keeps them.
  if (!r.ok && (local.artifacts.length || local.artifact_pattern)) {
    // A failure to keep artifacts must not turn the command's own result into a gate error.
    try {
      const store = artifactStore(ctx.stateDir);
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
  return { kept, plain, logFile, steps };
}

// The summary reaches worker and reviewer prompts through rework reasons, so it names the
// redacted log and only counts the artifacts, which the orchestrator and the owner read from the
// evidence's local_ci.artifacts.
function failedSummary(r, plain, kept, logFile, redact) {
  const lines = [`local CI ${redact(how(r))}: ${tailLines(plain.trim(), SUMMARY_LINES) || '(empty output)'}`];
  if (logFile) lines.push(`Full log: ${logFile}`);
  else if (kept.log_error) lines.push(`Full log not saved: ${kept.log_error}`);
  if (kept.artifacts.length) lines.push(`Artifacts: ${kept.artifacts.length} kept for the orchestrator and the owner (local_ci.artifacts)`);
  if (kept.receipt_failures?.length) lines.push(`Receipt failures: ${kept.receipt_failures.join('; ')}`);
  if (kept.receipts.length) lines.push(`Receipts: ${kept.receipts.map((file) => `${file.path}${file.truncated ? ' (truncated at 8 MiB)' : ''}`).join(', ')}`);
  if (kept.receipts_skipped?.length) lines.push(`Receipts skipped: ${kept.receipts_skipped.map((file) => `${file.from}: ${file.reason}`).join('; ')}`);
  if (kept.receipts_skipped_more) lines.push(`Receipts skipped: ${kept.receipts_skipped_more} more`);
  if (kept.receipts_error) lines.push(`Receipts not saved: ${kept.receipts_error}`);
  return redact(stripFor(redact, lines.join('\n')));
}

// One flaky record per failed step the first run's receipts named, or one for the command when
// they named none.
function flakyRecords(local, first, again, rerun) {
  const excerpt = boundedOutputTail(first.plain, 20, 2000);
  const runOf = (run, command) => ({ command: command.join(' '), status: run.r.status ?? null, signal: run.r.signal || null,
    duration_ms: run.duration_ms, log: run.kept.log });
  return (first.steps.length ? first.steps : [null]).map((step) => ({
    test: `local CI ${step ?? local.command.join(' ')}`, step: local.variant,
    first_failure: { ...runOf(first, local.command), error: null, excerpt }, rerun: runOf(again, rerun.command),
  }));
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
  const once = (argv) => withWorktree(ctx, root, merged.sha, async (dir, env) => {
    ctx.log?.(`local CI (${local.variant}) at ${short(current.head_sha)} on merge ${short(merged.sha)} of tree ${short(current.tree_hash)}: ${argv.join(' ')}`);
    const start = performance.now();
    const r = await exec({ ...ctx, exec: ctx.exec || treeExec }, argv[0], argv.slice(1), {
      cwd: dir, env, timeout: Math.max(1, Math.round(local.timeout * 1000)), processTree: true,
    });
    const duration_ms = Math.round(performance.now() - start);
    const gate = { dir, scratch: env.TMPDIR, parent: path.dirname(dir) };
    const kept = keepRun(ctx, local, r, gate, current.head_sha, redact);
    let changed = false;
    if (r.ok) {
      const unchanged = await git(ctx, dir, ['diff', '--quiet', current.tree_hash, '--'], { env });
      const index = await git(ctx, dir, ['write-tree'], { env });
      changed = !unchanged.ok || !index.ok || index.stdout.trim() !== current.tree_hash;
    }
    return { r, duration_ms, changed, ...kept };
  });
  const first = await once(local.command);
  // A worktree that could not be set up returns withWorktree's failed result, which has no run.
  if (!first.r) return { ...first, sha: current.head_sha };
  const receipt = {
    ...current, merge_sha: merged.sha, variant: local.variant, command: [...local.command], timeout: local.timeout,
    exit: first.r.status, signal: first.r.signal, duration_ms: first.duration_ms,
    ...(first.r.resource_reason ? { resource_reason: first.r.resource_reason, containment: first.r.containment } : {}),
  };
  const res = (ok, summary, kept, extra = {}) => ({ ok, summary, sha: current.head_sha, receipt, local_ci: kept, ...extra });
  let decided = first;
  let flaky = null;
  let note = '';
  // Only a nonzero exit is a verdict on the merged tree, so only it reruns: its failed steps
  // through rerun_cmd when the receipts named them, else the whole command, once and with no loop.
  // The rerun checks the same pinned merge, so a base that moved meanwhile does not change what it covers.
  if (!first.r.ok && failure(first.r).confirmed_failure && local.rerun) {
    const steps = local.rerun_cmd && first.steps.length ? first.steps : null;
    const command = steps ? Local.expandSteps(local.rerun_cmd, steps) : [...local.command];
    const what = steps ? `failed steps ${steps.join(', ')}` : 'the whole command';
    ctx.log?.(`local CI failed; rerunning ${what} once on the same merge: ${command.join(' ')}`);
    const again = await once(command);
    receipt.rerun = { command, steps, exit: again.r?.status ?? null, signal: again.r?.signal ?? null, duration_ms: again.duration_ms ?? null };
    if (!again.r) {
      note = `\nRerun: could not rerun ${what}: ${redact(again.summary)}; the failure stands.`;
    } else if (again.r.ok && !again.changed) {
      decided = again;
      flaky = flakyRecords(local, first, again, receipt.rerun);
      note = `\nRerun: reran ${what} once on the same merge: exit 0; flaky: ${flaky.map((f) => f.test).join(', ')}. First failure log: ${first.kept.log ?? 'not saved'}`;
    } else {
      note = `\nRerun: reran ${what} once on the same merge: ${again.changed ? 'it changed tracked sources' : redact(how(again.r))}; the failure stands.${again.kept.log ? ` Rerun log: ${again.kept.log}` : ''}`;
    }
  }
  if (!decided.r.ok) return { ...res(false, failedSummary(first.r, first.plain, first.kept, first.logFile, redact) + note, first.kept), ...failure(first.r) };
  const kept = flaky ? { ...decided.kept, first_failure: first.kept } : decided.kept;
  if (decided.changed) return res(false, 'local CI changed tracked sources; its result does not cover the merged tree', kept);
  // The base read at the start pins the merged tree. A base that moves during the run leaves
  // the result true for that tree: the receipt records it and the merge queue checks the real one.
  return res(true, `local CI (${local.variant}) passed at ${short(current.head_sha)} on merged tree ${short(current.tree_hash)} of base ${short(current.base_sha)} (${decided.duration_ms} ms)${note}`,
    kept, flaky ? { flaky } : {});
}

module.exports = { run, receiptText, receiptFailures, TAIL_LINES, TAIL_CHARS, ARTIFACT_BYTES, ARTIFACT_FILES, RECEIPT_BYTES, RUNS_KEPT, ARTIFACTS_DIR };
