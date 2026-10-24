'use strict';

const { spawnSync } = require('./commands');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { KINDS, writeAtomic } = require('./state');

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const args = (value) => Array.isArray(value) && value.every((arg) => typeof arg === 'string' && !arg.includes('\0'));
const command = (value) => args(value) && value.length > 0 && !!value[0].trim();
const timeout = (value) => typeof value === 'number' && Number.isFinite(value)
  && value > 0 && value * 1000 <= 2147483647;

// The argv that reruns only a failed run's steps: each argument that is exactly STEPS becomes the
// failed step names, one argument per step.
const STEPS = '{steps}';
const rerunCmd = (value) => command(value) && value.includes(STEPS);
const expandSteps = (argv, steps) => argv.flatMap((arg) => (arg === STEPS ? steps : [arg]));

// ci.overlap: the project's hook that names the local CI steps a base move can reach
// (docs/state/ci.md#base-moves). It gets OLD_BASE NEW_BASE PR_HEAD appended.
const validOverlap = (value) => !!(object(value) && Object.keys(value).every((key) => ['command', 'timeout'].includes(key))
  && command(value.command) && timeout(value.timeout));

// A step name becomes one argument of the steps-only argv, so it cannot read as an option.
const stepName = (value) => typeof value === 'string' && !!value.trim() && !value.includes('\0') && !value.startsWith('-');

// The hook's printed verdict, normalized, or why it cannot stand for the steps a base move reached.
function overlapResult(value) {
  if (!object(value)) return { error: 'its output is not a JSON object' };
  for (const key of ['pr_steps', 'main_steps', 'shared']) {
    if (!Array.isArray(value[key]) || !value[key].every(stepName)) return { error: `its ${key} is not a list of step names` };
  }
  if (!['keep', 'rerun'].includes(value.verdict)) return { error: 'its verdict is neither keep nor rerun' };
  const shared = [...new Set(value.shared)];
  // A shared step is one both sides select; a name outside either list is not a step the hook knows.
  const unknown = shared.filter((step) => !value.pr_steps.includes(step) || !value.main_steps.includes(step));
  if (unknown.length) return { error: `shared step ${unknown.join(', ')} is not in both pr_steps and main_steps` };
  // A step both sides select is shared whatever the hook's own set logic says, so it never carries over unrun.
  const missed = [...new Set(value.pr_steps.filter((step) => value.main_steps.includes(step) && !shared.includes(step)))];
  if (missed.length) return { error: `step ${missed.join(', ')} is in both pr_steps and main_steps but not shared` };
  if (value.verdict === 'keep' && shared.length) return { error: 'its verdict keep names shared steps' };
  if (value.verdict === 'rerun' && !shared.length) return { error: 'its verdict rerun names no shared steps' };
  return { pr_steps: [...value.pr_steps], main_steps: [...value.main_steps], shared, verdict: value.verdict };
}

function parseOverlap(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch { return { error: 'its output is not JSON' }; }
  return overlapResult(value);
}

function validOverride(override, { allowReceipts = false } = {}) {
  return !!(object(override)
    && Object.keys(override).every((key) => ['command', 'args', 'timeout', 'rerun_cmd'].includes(key)
      || (allowReceipts && key === 'receipts'))
    && (Object.hasOwn(override, 'command') !== Object.hasOwn(override, 'args'))
    && (Object.hasOwn(override, 'command') ? command(override.command) : args(override.args))
    && (!Object.hasOwn(override, 'timeout') || timeout(override.timeout))
    && (!Object.hasOwn(override, 'rerun_cmd') || rerunCmd(override.rerun_cmd))
    && !receiptsError(override));
}

// Artifact globs name files in the gate worktree, so they are relative and stay inside it.
const glob = (value) => typeof value === 'string' && !!value.trim() && !value.includes('\0')
  && !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..');

function receiptsError(local) {
  if (!object(local) || !Object.hasOwn(local, 'receipts')
    || (Array.isArray(local.receipts) && local.receipts.every(glob))) return null;
  return '--ci-local receipts must be an array of relative globs without ..';
}

// A pattern that finds the paths the command prints, such as a receipt line. The first capture
// group is the path when the pattern has one, else the whole match.
function pattern(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function valid(local) {
  return !!(object(local) && command(local.command) && timeout(local.timeout)
    && (!Object.hasOwn(local, 'artifacts') || (Array.isArray(local.artifacts) && local.artifacts.every(glob)))
    && !receiptsError(local)
    && (!Object.hasOwn(local, 'artifact_pattern') || pattern(local.artifact_pattern))
    && (!Object.hasOwn(local, 'rerun') || typeof local.rerun === 'boolean')
    && (!Object.hasOwn(local, 'rerun_cmd') || rerunCmd(local.rerun_cmd))
    && (!Object.hasOwn(local, 'by_kind') || (object(local.by_kind)
      && Object.entries(local.by_kind).every(([kind, override]) => KINDS.includes(kind) && validOverride(override)))));
}

function resolve(local, task, overlap = null) {
  if (!valid(local)) return { error: 'local CI configuration is invalid; set command, timeout and valid by_kind, artifacts, receipts, artifact_pattern, rerun and rerun_cmd fields with tower-crane project set --ci-local JSON' };
  if (overlap != null && !validOverlap(overlap)) return { error: 'ci.overlap is invalid; set {command: argv, timeout: seconds} or null with tower-crane project set --ci-overlap JSON' };
  let override;
  let variant = 'default';
  if (task.ci_local != null) {
    if (!validOverride(task.ci_local, { allowReceipts: true })) return { error: `invalid local CI override for ${task.id}; the owner must set or clear it with task update --ci-local JSON` };
    override = task.ci_local;
    variant = `task:${task.id}`;
  } else if (local.by_kind && Object.hasOwn(local.by_kind, task.kind)) {
    override = local.by_kind[task.kind];
    variant = `kind:${task.kind}`;
  }
  return {
    variant,
    command: override?.command ? [...override.command] : [...local.command, ...(override?.args || [])],
    timeout: override?.timeout ?? local.timeout,
    artifacts: [...(local.artifacts || [])],
    receipts: [...(override?.receipts ?? local.receipts ?? [])],
    artifact_pattern: local.artifact_pattern ?? null,
    rerun: local.rerun !== false,
    // An args override appends its args to the default rerun too; a replacement command has its own
    // steps, so it reruns whole unless it names its rerun_cmd.
    rerun_cmd: override?.rerun_cmd ? [...override.rerun_cmd]
      : !override?.command && local.rerun_cmd ? [...local.rerun_cmd, ...(override?.args || [])] : null,
    overlap: overlap ? { command: [...overlap.command], timeout: overlap.timeout } : null,
  };
}

// The argv a receipt's first run executed: the shared steps through rerun_cmd, or the command.
const runCommand = (receipt, local) => (Array.isArray(receipt.steps) && receipt.steps.length && local.rerun_cmd
  ? expandSteps(local.rerun_cmd, receipt.steps) : local.command);

// The command executions a receipt's own checks read, so a receipt that narrows it can carry them.
function audited(receipt, local, commands) {
  const argvs = [local.command, runCommand(receipt, local), receipt.rerun?.command, receipt.overlap?.command].filter(Array.isArray);
  return commands.filter((c) => argvs.some((argv) => c.command === argv[0] && isDeepStrictEqual(c.args, argv.slice(1))));
}

const querier = (root) => (args, encoding = 'utf8') => spawnSync('git', ['-C', root, ...args], {
  encoding, maxBuffer: Infinity, timeout: 60000, windowsHide: true,
});

const commitOf = (query, ref) => {
  const r = query(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
};

function mergedTree(query, baseName, baseSha, headSha) {
  // A merge of the head checked out reads .gitattributes from the head, so its merge drivers apply.
  const merge = query(['-c', `attr.tree=${headSha}`, 'merge-tree', '--write-tree', baseSha, headSha]);
  if (merge.error || merge.status !== 0) {
    return { error: `local CI cannot merge ${baseName} with ${headSha.slice(0, 10)}: ${merge.error?.message || merge.stderr.trim() || merge.stdout.trim()}` };
  }
  const tree = merge.stdout.trim().split('\n')[0];
  const entries = query(['ls-tree', '-r', '-z', tree], null);
  if (entries.error || entries.status !== 0) return { error: 'local CI cannot read the merged source tree' };
  return {
    head_sha: headSha, base_sha: baseSha, tree_hash: tree,
    source_digest: createHash('sha256').update(entries.stdout).digest('hex'),
  };
}

// Match dispatch's base selection without fetching during acceptance. Merge refreshes origin
// before validating the receipt; a local base ahead of origin remains authoritative here.
function snapshot(root, project, head) {
  if (!root) return { error: 'local CI needs a git repository' };
  const query = querier(root);
  const headSha = commitOf(query, head);
  if (!headSha) return { error: `local CI submitted commit ${head} is not available; fetch it and retry` };
  const baseSha = selectBase(query, project.base);
  if (!baseSha) return { error: `local CI base ${project.base} is not available; fetch it and retry` };
  return mergedTree(query, project.base, baseSha, headSha);
}

const remoteBase = (base) => (base.startsWith('origin/') ? base : `origin/${base}`);

function selectBase(query, base) {
  const local = commitOf(query, base);
  const remote = commitOf(query, remoteBase(base));
  return remote && (!local || query(['merge-base', '--is-ancestor', local, remote]).status === 0) ? remote : local;
}

// The base commit snapshot would select now, or null, read through the gate's git so the
// merge gate's command receipts show the read.
async function selectedBase(ctx, root, base) {
  const { git, resolveCommit } = require('./gates/common');
  const local = await resolveCommit(ctx, root, base);
  const remote = await resolveCommit(ctx, root, remoteBase(base));
  return remote && (!local || (await git(ctx, root, ['merge-base', '--is-ancestor', local, remote])).ok) ? remote : local;
}

const PIN_CACHE = 'local-ci-pin-cache.json';

// A pinned result is fixed by its three commit ids, so the cache keeps each task's last one and
// reports recompute it only when the base moves. A cache that cannot be read or written costs
// only the recomputation; a sandbox opens the state directory read-only.
function cachedPin(cache, key) {
  if (!cache) return null;
  let hit;
  try { hit = JSON.parse(fs.readFileSync(path.join(cache.dir, PIN_CACHE), 'utf8')).tasks?.[cache.task]; } catch { return null; }
  if (hit?.key !== key || typeof hit.contained !== 'boolean') return null;
  if (!hit.contained) return { contained: false };
  return typeof hit.tree_hash === 'string' && typeof hit.source_digest === 'string'
    ? { tree_hash: hit.tree_hash, source_digest: hit.source_digest, contained: true } : null;
}

function storePin(cache, key, pin) {
  if (!cache) return;
  const file = path.join(cache.dir, PIN_CACHE);
  try {
    let tasks = {};
    try { tasks = JSON.parse(fs.readFileSync(file, 'utf8')).tasks || {}; } catch { /* A missing or torn cache starts empty. */ }
    const live = new Set(cache.live());
    const kept = Object.fromEntries(Object.entries(tasks).filter(([id]) => id !== cache.task && live.has(id)));
    const entry = pin.contained ? { key, tree_hash: pin.tree_hash, source_digest: pin.source_digest, contained: true } : { key, contained: false };
    writeAtomic(file, JSON.stringify({ version: 1, tasks: { ...kept, [cache.task]: entry } }));
  } catch { /* An unwritable cache leaves the next report to recompute. */ }
}

// The head merged with the base a receipt checked, and whether the current base still
// descends from it. A check that takes hours would never finish on a busy base if every base
// commit voided it, so a receipt stays valid on its own merged tree while the base moves
// forward; the merge queue checks the real merged tree before anything lands.
function pinned(root, current, baseSha, cache = null) {
  if (!root || current.error || !baseSha || baseSha === current.base_sha) return null;
  const key = `${baseSha} ${current.base_sha} ${current.head_sha}`;
  const hit = cachedPin(cache, key);
  if (hit) return { ...hit, base_sha: baseSha };
  const query = querier(root);
  if (!/^[0-9a-f]{40,64}$/.test(baseSha) || !commitOf(query, baseSha)) return { base_sha: baseSha, contained: false };
  // Exit 1 is a verdict; anything else is a failed read and is not cached.
  const ancestor = query(['merge-base', '--is-ancestor', baseSha, current.base_sha]);
  const contained = ancestor.status === 0;
  const pin = contained ? { ...mergedTree(query, baseSha.slice(0, 10), baseSha, current.head_sha), base_sha: baseSha, contained }
    : { base_sha: baseSha, contained };
  if (!pin.error && [0, 1].includes(ancestor.status)) storePin(cache, key, pin);
  return pin;
}

function mismatch(receipt, current, local, commands, pin = null) {
  if (!local || local.error) return local?.error || 'local CI configuration changed or is invalid; run check ci again';
  if (!receipt || receipt.head_sha !== current.head_sha) return 'local CI receipt does not match the submitted head; run check ci again';
  if ((receipt.tree_hash !== current.tree_hash || receipt.source_digest !== current.source_digest)
    && !(pin && !pin.error && pin.contained && pin.base_sha === receipt.base_sha
      && pin.tree_hash === receipt.tree_hash && pin.source_digest === receipt.source_digest)) {
    return pin?.base_sha === receipt.base_sha && !pin.contained
      ? `local CI receipt does not match the current merged tree, and its checked base ${String(receipt.base_sha).slice(0, 10)} is not in the selected base's history; run check ci again`
      : 'local CI receipt does not match the current merged tree; run check ci again';
  }
  if (receipt.variant !== local.variant) return 'local CI receipt does not match the selected variant; run check ci again';
  if (!isDeepStrictEqual(receipt.command, local.command) || receipt.timeout !== local.timeout) {
    return 'local CI receipt does not match the configured command or timeout; run check ci again';
  }
  const ran = (argv, ok) => commands.some((c) => c.command === argv[0] && isDeepStrictEqual(c.args, argv.slice(1))
    && (!ok || (c.status === 0 && !c.signal)));
  const exited = (run) => Number.isFinite(run.duration_ms) && run.duration_ms >= 0;
  if (receipt.narrows != null || receipt.steps != null) {
    const reason = narrowed(receipt, local, ran);
    if (reason) return reason;
    // A kept receipt ran nothing on its tree: every step's inputs are the narrowed receipt's.
    if (!receipt.steps.length) return null;
  }
  const first = runCommand(receipt, local);
  // A failed run that its one rerun passed (docs/state.md#gate-reruns): the rerun is the first
  // command again, or the configured rerun_cmd with the steps the failed run's receipts named.
  const rerun = receipt.rerun;
  if (rerun != null) {
    const steps = Array.isArray(rerun.steps) && rerun.steps.length && rerun.steps.every((step) => typeof step === 'string') ? rerun.steps : null;
    const want = steps && local.rerun_cmd ? expandSteps(local.rerun_cmd, steps) : first;
    if (!local.rerun || !isDeepStrictEqual(rerun.command, want) || (rerun.steps != null && !steps)) {
      return 'local CI receipt rerun does not match the configured rerun; run check ci again';
    }
    if (!Number.isInteger(receipt.exit) || receipt.exit === 0 || !exited(receipt) || rerun.exit !== 0 || rerun.signal || !exited(rerun)) {
      return 'local CI receipt is not a successful command result';
    }
    if (!ran(first, false) || !ran(rerun.command, true)) return 'local CI receipt has no matching command execution';
    return null;
  }
  if (receipt.exit !== 0 || receipt.signal || !exited(receipt)) {
    return 'local CI receipt is not a successful command result';
  }
  if (!ran(first, true)) return 'local CI receipt has no matching command execution';
  return null;
}

// A receipt carried across a base move (docs/state/ci.md#base-moves): the receipt it narrows holds
// on its own tree, the configured hook ran on both bases and this head, and the steps that ran here
// are exactly the hook's shared steps, or none on its keep.
function narrowed(receipt, local, ran) {
  const from = receipt.narrows;
  const invalid = 'local CI receipt does not narrow a valid earlier receipt; run check ci again';
  if (!object(from) || !Array.isArray(receipt.narrows_commands) || !Array.isArray(receipt.steps) || !receipt.steps.every(stepName)
    || from.head_sha !== receipt.head_sha || !from.base_sha || from.base_sha === receipt.base_sha) return invalid;
  const held = mismatch(from, from, local, receipt.narrows_commands);
  if (held) return `local CI receipt narrows a receipt that does not hold: ${held}`;
  const hook = receipt.overlap;
  const argv = local.overlap && [...local.overlap.command, from.base_sha, receipt.base_sha, receipt.head_sha];
  if (!argv || !object(hook) || !isDeepStrictEqual(hook.command, argv) || hook.exit !== 0 || !ran(argv, true)) {
    return 'local CI receipt has no matching ci.overlap run; run check ci again';
  }
  const out = overlapResult(hook);
  if (out.error || !isDeepStrictEqual(receipt.steps, out.shared) || (out.shared.length && !local.rerun_cmd)) {
    return 'local CI receipt steps do not match its ci.overlap verdict; run check ci again';
  }
  return null;
}

module.exports = { valid, validOverride, validOverlap, receiptsError, resolve, snapshot, selectedBase, pinned, mismatch, expandSteps, parseOverlap, overlapResult, audited, runCommand };
