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

function validOverride(override) {
  return !!(object(override)
    && Object.keys(override).every((key) => ['command', 'args', 'timeout'].includes(key))
    && (Object.hasOwn(override, 'command') !== Object.hasOwn(override, 'args'))
    && (Object.hasOwn(override, 'command') ? command(override.command) : args(override.args))
    && (!Object.hasOwn(override, 'timeout') || timeout(override.timeout)));
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
    && (!Object.hasOwn(local, 'artifact_pattern') || pattern(local.artifact_pattern))
    && (!Object.hasOwn(local, 'by_kind') || (object(local.by_kind)
      && Object.entries(local.by_kind).every(([kind, override]) => KINDS.includes(kind) && validOverride(override)))));
}

function resolve(local, task) {
  if (!valid(local)) return { error: 'local CI configuration is invalid; set command, timeout and valid by_kind, artifacts and artifact_pattern fields with tower-crane project set --ci-local JSON' };
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
    artifact_pattern: local.artifact_pattern ?? null,
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
  const merge = query(['merge-tree', '--write-tree', baseSha, headSha]);
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
  if (receipt.exit !== 0 || receipt.signal || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) {
    return 'local CI receipt is not a successful command result';
  }
  if (!commands.some((c) => c.command === receipt.command[0] && isDeepStrictEqual(c.args, receipt.command.slice(1))
    && c.status === 0 && !c.signal)) return 'local CI receipt has no matching command execution';
  return null;
}

module.exports = { valid, validOverride, resolve, snapshot, mismatch };
