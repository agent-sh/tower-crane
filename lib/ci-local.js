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

function validOverride(override, { allowReceipts = false } = {}) {
  return !!(object(override)
    && Object.keys(override).every((key) => ['command', 'args', 'timeout'].includes(key)
      || (allowReceipts && key === 'receipts'))
    && (Object.hasOwn(override, 'command') !== Object.hasOwn(override, 'args'))
    && (Object.hasOwn(override, 'command') ? command(override.command) : args(override.args))
    && (!Object.hasOwn(override, 'timeout') || timeout(override.timeout))
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
    && (!Object.hasOwn(local, 'inputs') || (Array.isArray(local.inputs) && local.inputs.every(glob)))
    && !receiptsError(local)
    && (!Object.hasOwn(local, 'artifact_pattern') || pattern(local.artifact_pattern))
    && (!Object.hasOwn(local, 'by_kind') || (object(local.by_kind)
      && Object.entries(local.by_kind).every(([kind, override]) => KINDS.includes(kind) && validOverride(override)))));
}

function resolve(local, task) {
  if (!valid(local)) return { error: 'local CI configuration is invalid; set command, timeout and valid by_kind, artifacts, receipts, inputs and artifact_pattern fields with tower-crane project set --ci-local JSON' };
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
  if (receipt.exit !== 0 || receipt.signal || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) {
    return 'local CI receipt is not a successful command result';
  }
  if (!commands.some((c) => c.command === receipt.command[0] && isDeepStrictEqual(c.args, receipt.command.slice(1))
    && c.status === 0 && !c.signal)) return 'local CI receipt has no matching command execution';
  return null;
}

// What the command reads beyond the task's own changes: each repository path its argv names,
// such as the script it runs or a directory it scans, and the owner's `inputs` globs, such as
// lockfiles and configuration the command loads without naming them. An argv path is matched
// as written on any platform: a `\` separator reads as `/`, a flag's `=value` counts
// like the next argv entry, `.`, `./` and Go's `./...` name the whole repository, and an argv
// glob such as `test/**/*.test.js` names what it matches and all beneath it.
function reads(command, inputs) {
  const { globToRegExp } = require('./gates/tests');
  const named = [];
  for (const raw of command) {
    const value = raw.startsWith('-') ? raw.slice(raw.indexOf('=') + 1 || raw.length) : raw;
    const arg = value.replace(/\\/g, '/');
    if (!arg || path.posix.isAbsolute(arg) || /^[A-Za-z]:/.test(arg)) continue;
    const norm = path.posix.normalize(arg);
    if (norm === '..' || norm.startsWith('../')) continue;
    const parts = norm.split('/').filter((part) => part && part !== '.');
    if (parts.at(-1) === '...') parts.pop();
    const p = parts.join('/');
    if (!p) return () => true;
    if (/[*?{]/.test(p)) {
      const re = globToRegExp(p);
      named.push((file) => file.split('/').some((_, i, all) => re.test(all.slice(0, i + 1).join('/'))));
    } else named.push((file) => file === p || file.startsWith(`${p}/`));
  }
  const globs = inputs.map(globToRegExp);
  return (file) => named.some((match) => match(file)) || globs.some((re) => re.test(file));
}

// A receipt checked on an older base still stands for the merge onto `tip` when the base only
// moved forward, the head merges onto the tip cleanly, and the base changed no path the head
// changes or the command reads: the run already saw every file it would see again. A run that
// takes hours on a busy base comes back behind the tip on every lap, so rerunning on any move
// would never land it. Returns null when it stands, else the reason it must run again. Every
// read goes through the caller's git, so its command receipts show them.
async function behind(ctx, root, { receipt, tip, head, inputs = [] }) {
  const { git, short } = require('./gates/common');
  const run = (args) => git(ctx, root, args, { timeout: 60000 });
  const from = receipt.base_sha;
  if (!(await run(['merge-base', '--is-ancestor', from, tip])).ok) return `its checked base ${short(from)} is not in the history of ${short(tip)}`;
  if (!(await run(['-c', `attr.tree=${head}`, 'merge-tree', '--write-tree', tip, head])).ok) return `${short(head)} does not merge cleanly onto ${short(tip)}`;
  const names = async (range) => {
    const r = await run(['diff', '--name-only', '--no-renames', '-z', range]);
    return r.ok ? r.stdout.split('\0').filter(Boolean) : null;
  };
  const moved = await names(`${from}..${tip}`);
  const changed = await names(`${from}...${head}`);
  if (!moved || !changed) return 'the paths the base and the head changed cannot be listed';
  const own = new Set(changed);
  const read = reads(args(receipt.command) ? receipt.command : [], args(inputs) ? inputs : []);
  const shared = moved.filter((file) => own.has(file) || read(file));
  if (!shared.length) return null;
  return `the base changed ${shared.slice(0, 5).join(', ')}${shared.length > 5 ? ` and ${shared.length - 5} more` : ''}, which the task changes or the CI command reads`;
}

module.exports = { valid, validOverride, receiptsError, resolve, snapshot, selectedBase, pinned, mismatch, reads, behind };
