'use strict';

const { spawnSync } = require('./commands');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { KINDS } = require('./state');

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

function validOverride(override) {
  return !!(object(override)
    && Object.keys(override).every((key) => ['command', 'args', 'timeout', 'rerun_cmd'].includes(key))
    && (Object.hasOwn(override, 'command') !== Object.hasOwn(override, 'args'))
    && (Object.hasOwn(override, 'command') ? command(override.command) : args(override.args))
    && (!Object.hasOwn(override, 'timeout') || timeout(override.timeout))
    && (!Object.hasOwn(override, 'rerun_cmd') || rerunCmd(override.rerun_cmd)));
}

// Artifact globs name files in the gate worktree, so they are relative and stay inside it.
const glob = (value) => typeof value === 'string' && !!value.trim() && !value.includes('\0')
  && !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..');

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
    && (!Object.hasOwn(local, 'receipts') || (Array.isArray(local.receipts) && local.receipts.every(glob)))
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
    if (!validOverride(task.ci_local)) return { error: `invalid local CI override for ${task.id}; the owner must set or clear it with task update --ci-local JSON` };
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
    receipts: [...(local.receipts || [])],
    artifact_pattern: local.artifact_pattern ?? null,
    rerun: local.rerun !== false,
    // An args override appends its args to the default rerun too; a replacement command has its own
    // steps, so it reruns whole unless it names its rerun_cmd.
    rerun_cmd: override?.rerun_cmd ? [...override.rerun_cmd]
      : !override?.command && local.rerun_cmd ? [...local.rerun_cmd, ...(override?.args || [])] : null,
  };
}

// Match dispatch's base selection without fetching during acceptance. Merge refreshes origin
// before validating the receipt; a local base ahead of origin remains authoritative here.
function snapshot(root, project, head) {
  if (!root) return { error: 'local CI needs a git repository' };
  const query = (args, encoding = 'utf8') => spawnSync('git', ['-C', root, ...args], {
    encoding, maxBuffer: Infinity, timeout: 60000, windowsHide: true,
  });
  const commit = (ref) => {
    const r = query(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const headSha = commit(head);
  if (!headSha) return { error: `local CI submitted commit ${head} is not available; fetch it and retry` };
  const local = commit(project.base);
  const remote = commit(project.base.startsWith('origin/') ? project.base : `origin/${project.base}`);
  const baseSha = remote && (!local || query(['merge-base', '--is-ancestor', local, remote]).status === 0) ? remote : local;
  if (!baseSha) return { error: `local CI base ${project.base} is not available; fetch it and retry` };
  // A merge of the head checked out reads .gitattributes from the head, so its merge drivers apply.
  const merge = query(['-c', `attr.tree=${headSha}`, 'merge-tree', '--write-tree', baseSha, headSha]);
  if (merge.error || merge.status !== 0) {
    return { error: `local CI cannot merge ${project.base} with ${headSha.slice(0, 10)}: ${merge.error?.message || merge.stderr.trim() || merge.stdout.trim()}` };
  }
  const tree = merge.stdout.trim().split('\n')[0];
  const entries = query(['ls-tree', '-r', '-z', tree], null);
  if (entries.error || entries.status !== 0) return { error: 'local CI cannot read the merged source tree' };
  return {
    head_sha: headSha, base_sha: baseSha, tree_hash: tree,
    source_digest: createHash('sha256').update(entries.stdout).digest('hex'),
  };
}

function mismatch(receipt, current, local, commands) {
  if (!local || local.error) return local?.error || 'local CI configuration changed or is invalid; run check ci again';
  if (!receipt || receipt.head_sha !== current.head_sha) return 'local CI receipt does not match the submitted head; run check ci again';
  if (receipt.tree_hash !== current.tree_hash || receipt.source_digest !== current.source_digest) {
    return 'local CI receipt does not match the current merged tree; run check ci again';
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

module.exports = { valid, validOverride, resolve, snapshot, mismatch, expandSteps };
