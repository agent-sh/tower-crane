'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const C = require('./gates/common');
const { refuse, usage } = require('./util');

const DEFAULT_TIMEOUT = 10;
const MAX_TIMEOUT = 60;
const REPEAT_LIMIT = 3;
const OUTPUT_LIMIT = 8192;
const RECEIPT_ENV = 'TOWER_CRANE_PRESUBMIT_RECEIPT';

function settings(project) {
  const value = project.gates?.presubmit;
  if (value == null) return null;
  return Array.isArray(value) ? { command: value, timeout_sec: DEFAULT_TIMEOUT }
    : { command: value.command, timeout_sec: value.timeout_sec ?? DEFAULT_TIMEOUT };
}

function errors(value) {
  if (value == null) return [];
  const config = Array.isArray(value) ? { command: value } : value;
  const argv = config?.command;
  if (!config || typeof config !== 'object' || !Array.isArray(argv) || !argv.length
    || !argv.every((s) => typeof s === 'string' && !s.includes('\0')) || !argv[0].trim()
    || Object.keys(config).some((k) => !['command', 'timeout_sec'].includes(k))) {
    return ['presubmit must be an argv array or {command: argv, timeout_sec?: seconds}, without NUL bytes'];
  }
  const timeout = config.timeout_sec ?? DEFAULT_TIMEOUT;
  return typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT
    ? [`presubmit timeout_sec must be greater than 0 and at most ${MAX_TIMEOUT}`] : [];
}

function taskOf(st, ctx) {
  return require('./tasks').getTask(st, ctx.pos[0]);
}

function claimant(ctx, task) {
  if (task.status === 'submitted' && task.submitted_by === ctx.agent) return;
  if (task.status !== 'in_progress' || task.claim?.agent !== ctx.agent) {
    throw refuse(`only the claimant or submitter can submit ${task.id}`);
  }
}

function history(st, task) {
  return st.events.filter((e) => e.task === task.id
    && ['presubmit refused', 'presubmit retry', 'presubmit override', 'submit'].includes(e.cmd));
}

function configKey(config) {
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function hold(st, task) {
  if (!settings(st.project)) return null;
  const last = history(st, task).at(-1);
  return last?.cmd === 'presubmit refused' && last.detail.escalated
    && last.detail.config_key === configKey(settings(st.project)) ? last : null;
}

function override(st, task, sha) {
  const last = history(st, task).at(-1);
  return last?.cmd === 'presubmit override' && last.detail.sha === sha
    && last.detail.revision === task.revision
    && last.detail.config_key === configKey(settings(st.project)) ? last : null;
}

function redact(project, cwd, text) {
  const clean = require('./gates/tests').diagnosticRedactor(project, cwd);
  const output = clean(C.stripFor(clean, text));
  // Redact before capping so a secret crossing the cap stays whole.
  return output.length > OUTPUT_LIMIT ? output.slice(0, OUTPUT_LIMIT) + '\n[output capped]' : output;
}

function outsideDiff(ctx, st, task, sha, output, error) {
  if (['ENOENT', 'EACCES', 'EPERM'].includes(error)) return `environment: ${error}`;
  if (/\b(?:command not found|permission denied|ModuleNotFoundError|Cannot find module|No such file or directory)\b/i.test(output)) {
    return 'missing tool, dependency or inaccessible file';
  }
  try {
    const repo = { root: ctx.cwd };
    const project = { ...st.project, base: require('./stack').targetBase(st, task) };
    const diff = require('./reviewer').diffOf(repo, project, { ...task, sha });
    const changed = new Set(diff.files);
    const tracked = require('./commands').execFileSync('git', ['ls-files', '-z'],
      { cwd: ctx.cwd, env: ctx.env, encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean);
    // Only file diagnostics count; a script's incidental mention of its own path does not.
    const file = tracked.find((f) => !changed.has(f)
      && new RegExp(`(?:^|[\\s"'(])(?:${escapeRegex(ctx.cwd.replaceAll('\\', '/'))}/)?${escapeRegex(f)}(?::\\d+|["']?,? line \\d+)`, 'm').test(output.replaceAll('\\', '/')));
    return file ? `diagnostic outside the task diff: ${file}` : null;
  } catch {
    return null;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifyHead(ctx, task, sha) {
  if (task.worktree?.path && path.resolve(task.worktree.path) !== path.resolve(ctx.cwd)) {
    throw refuse(`presubmit must run in ${task.id}'s worktree: ${task.worktree.path}`);
  }
  const cp = require('./commands');
  const opts = { cwd: ctx.cwd, env: ctx.env, encoding: 'utf8', timeout: 10000 };
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
  if (head !== sha) throw refuse(`presubmit needs worktree HEAD ${sha}; found ${head}`);
  const dirty = cp.execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], opts).trim();
  if (dirty) throw refuse('presubmit needs a clean tracked worktree at the submitted head');
}

// This runs only in the caller. A brokered submit receives its receipt and never runs repository code.
async function prepare(ctx, sha) {
  const st = S.loadState(ctx.stateDir);
  const task = taskOf(st, ctx);
  const config = settings(st.project);
  if (!config) return null;
  claimant(ctx, task);
  const safeConfig = { ...config, command: config.command.map((s) => redact(st.project, ctx.cwd, s)) };
  const base = { sha, config: safeConfig, config_key: configKey(config) };
  const waived = override(st, task, sha);
  if (waived) {
    verifyHead(ctx, task, sha);
    return { ...base, override: waived.id, duration_ms: 0, ok: true, output: '' };
  }
  if (hold(st, task)) throw refuse(`${task.id}: presubmit is escalated to the orchestrator; stop retrying until presubmit retry or override`);
  verifyHead(ctx, task, sha);
  const start = performance.now();
  const result = await C.treeExec(config.command[0], config.command.slice(1), {
    cwd: ctx.cwd, env: ctx.env, timeout: Math.max(1, Math.ceil(config.timeout_sec * 1000)), keep: 64 * 1024,
  });
  const duration = Math.round(performance.now() - start);
  const clean = require('./gates/tests').diagnosticRedactor(st.project, ctx.cwd);
  let output = C.redactJoined(result, clean);
  if (result.error) output += `\n${result.error.code || 'error'}: ${result.error.message}`;
  let ok = !result.error && result.status === 0;
  const external = ok ? null : outsideDiff(ctx, st, task, sha, output, result.error?.code);
  let error = result.error?.code || null;
  try { verifyHead(ctx, task, sha); } catch (e) {
    ok = false;
    error = 'WORKTREE_CHANGED';
    output += `\n${e.message}`;
  }
  return { ...base, duration_ms: duration, ok, status: result.status,
    error, external, output: redact(st.project, ctx.cwd, output) };
}

function validateReceipt(receipt, config, sha) {
  if (!receipt || receipt.sha !== sha || receipt.config_key !== configKey(config)
    || errors(receipt.config).length
    || typeof receipt.ok !== 'boolean' || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0
    || typeof receipt.output !== 'string' || receipt.output.length > OUTPUT_LIMIT + 100
    || (receipt.status != null && !Number.isInteger(receipt.status))
    || (receipt.error != null && (typeof receipt.error !== 'string' || receipt.error.length > 80))
    || (receipt.external != null && (typeof receipt.external !== 'string' || receipt.external.length > 1024))) {
    throw refuse('presubmit receipt is missing or stale; submit through the worker CLI in its worktree');
  }
  if (receipt.ok && !receipt.override && (receipt.status !== 0 || receipt.error)) {
    throw refuse('presubmit pass receipt needs exit status zero');
  }
}

async function check(ctx, sha) {
  let receipt;
  if (S.via(ctx).via === 'broker') {
    try { receipt = JSON.parse(ctx.env[RECEIPT_ENV]); } catch { receipt = null; }
  } else receipt = await prepare(ctx, sha);
  const st = S.loadState(ctx.stateDir);
  const task = taskOf(st, ctx);
  const config = settings(st.project);
  if (!config) {
    if (receipt) throw refuse('presubmit setting changed while the command ran; retry submit');
    return null;
  }
  claimant(ctx, task);
  validateReceipt(receipt, config, sha);
  const waived = override(st, task, sha);
  if (receipt.override && receipt.override !== waived?.id) throw refuse('presubmit override is stale; retry submit');
  if (hold(st, task)) throw refuse(`${task.id}: presubmit is escalated to the orchestrator; stop retrying`);
  const detail = { sha, config: { ...config, command: receipt.config.command.map((s) => redact(st.project, ctx.cwd, s)) },
    config_key: configKey(config), duration_ms: receipt.duration_ms, ok: receipt.ok,
    status: receipt.status ?? null, error: receipt.error ?? null,
    ...(receipt.override ? { override: receipt.override } : {}),
    output: redact(st.project, ctx.cwd, receipt.output),
    external: receipt.external ? redact(st.project, ctx.cwd, receipt.external) : null };
  if (receipt.ok) return detail;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([config, detail.status, detail.error, detail.output])).digest('hex');
  const refused = S.mutate(ctx, 'presubmit refused', (current, emit) => {
    const t = taskOf(current, ctx);
    claimant(ctx, t);
    if (!isDeepStrictEqual(config, settings(current.project))) throw refuse('presubmit setting changed; retry submit');
    const last = history(current, t).at(-1);
    if (hold(current, t)) throw refuse(`${t.id}: presubmit is escalated to the orchestrator; stop retrying`);
    const attempts = last?.cmd === 'presubmit refused' && last.detail.fingerprint === fingerprint
      ? last.detail.attempts + 1 : 1;
    const escalation = detail.external || (attempts >= REPEAT_LIMIT ? `${REPEAT_LIMIT} identical consecutive failures` : null);
    const recorded = { ...detail, fingerprint, attempts, escalated: !!escalation, reason: escalation };
    emit(t.id, recorded);
    return recorded;
  });
  throw refuse([`presubmit refused ${task.id}: ${receipt.error || `exit ${receipt.status}`}`,
    redact(st.project, ctx.cwd, JSON.stringify(config.command)), detail.output,
    refused.escalated ? `Escalated to orchestrator (${refused.reason}); stop retrying. Use presubmit retry or presubmit override with a recorded reason.`
      : `Attempt ${refused.attempts}/${REPEAT_LIMIT}; fix and submit again in this attempt.`].filter(Boolean).join('\n'));
}

function assertCurrent(st, task, receipt, sha) {
  if (receipt ? receipt.config_key !== configKey(settings(st.project)) : settings(st.project) !== null) {
    throw refuse('presubmit setting changed; retry submit');
  }
  if (hold(st, task)) throw refuse('presubmit is escalated to the orchestrator; stop retrying');
  if (receipt?.override && override(st, task, sha)?.id !== receipt.override) throw refuse('presubmit override changed; retry submit');
}

function resolve(ctx) {
  const mode = ctx.request.command === 'presubmit override' ? 'override' : 'retry';
  const reason = ctx.flags.reason?.trim();
  if (!reason) throw usage('presubmit resolution needs --reason');
  const data = S.mutate(ctx, `presubmit ${mode}`, (st, emit) => {
    if (!require('./authority').role(ctx, st.events)) throw refuse('presubmit retry and override require the orchestrator or owner');
    const task = taskOf(st, ctx);
    const failure = history(st, task).at(-1);
    if (failure?.cmd !== 'presubmit refused') throw refuse(`${task.id} has no current presubmit refusal`);
    const config = settings(st.project);
    if (!config || configKey(config) !== failure.detail.config_key) throw refuse('presubmit setting changed; retry submit directly');
    const detail = { reason: redact(st.project, ctx.cwd, reason), sha: failure.detail.sha,
      revision: task.revision, config: failure.detail.config, config_key: configKey(config),
      refusal: failure.id, attempts: failure.detail.attempts };
    emit(task.id, detail);
    return detail;
  });
  return { data, text: `presubmit ${mode} recorded for ${ctx.pos[0]}: ${data.reason}` };
}

module.exports = { settings, errors, prepare, check, assertCurrent, hold, resolve, RECEIPT_ENV };
