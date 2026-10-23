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

function resolve(local, task) {
  if (!valid(local)) return { error: 'local CI configuration is invalid; set command, timeout and valid by_kind, artifacts, receipts, artifact_pattern, rerun and rerun_cmd fields with tower-crane project set --ci-local JSON' };
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
  };
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
  // A failed run that its one rerun passed (docs/state.md#gate-reruns): the rerun is the command, or
  // the configured rerun_cmd with the steps the failed run's receipts named.
  const rerun = receipt.rerun;
  if (rerun != null) {
    const steps = Array.isArray(rerun.steps) && rerun.steps.length && rerun.steps.every((step) => typeof step === 'string') ? rerun.steps : null;
    const want = steps && local.rerun_cmd ? expandSteps(local.rerun_cmd, steps) : local.command;
    if (!local.rerun || !isDeepStrictEqual(rerun.command, want) || (rerun.steps != null && !steps)) {
      return 'local CI receipt rerun does not match the configured rerun; run check ci again';
    }
    if (!Number.isInteger(receipt.exit) || receipt.exit === 0 || !exited(receipt) || rerun.exit !== 0 || rerun.signal || !exited(rerun)) {
      return 'local CI receipt is not a successful command result';
    }
    if (!ran(receipt.command, false) || !ran(rerun.command, true)) return 'local CI receipt has no matching command execution';
    return null;
  }
  if (receipt.exit !== 0 || receipt.signal || !exited(receipt)) {
    return 'local CI receipt is not a successful command result';
  }
  if (!ran(receipt.command, true)) return 'local CI receipt has no matching command execution';
  return null;
}

module.exports = { valid, validOverride, receiptsError, resolve, snapshot, selectedBase, pinned, mismatch, expandSteps };
