'use strict';

// A merge that brings in a path the sandbox masks. Claude Code mounts over
// those paths (a read-only bind of the real file, or /dev/null when it is
// absent), and git can neither unlink nor write a mount point, so a plain
// merge stops with "would lose untracked files". This module builds such a
// merge with plumbing instead: merge-tree makes the tree, commit-tree the
// commit, a two-tree read-tree moves the unmasked files, and each masked
// entry goes into the index without a checkout and is marked skip-worktree.
// The branch then moves to the merge commit. Masked files keep what the
// sandbox gave them. A merge that brings in no masked path returns null, and
// the caller runs git merge as it always does.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('./commands');

// Claude Code's protected list (claude 2.1.295). A directory covers every
// tracked file under it.
const MASKED_FILES = ['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.mcp.json', '.profile', '.ripgreprc', '.zprofile', '.zshrc'];
const MASKED_DIRS = ['.claude/agents', '.claude/commands', '.idea', '.vscode'];

// merge-tree --write-tree needs git 2.38.
const MIN_GIT = [2, 38];
// The merge options the plumbing honours. Anything else could change what
// gets written, so a masked merge that uses it is refused.
const OPTIONS = ['--no-edit', '--no-ff', '--ff', '-q', '--quiet'];
// git merge options that take a value; the value is not the ref. -m is the
// only one the plumbing honours; the others are refused with their value.
const VALUED = ['-m', '--message', '-s', '--strategy', '-X', '--strategy-option', '-F', '--file', '--cleanup', '--into-name'];

const isMasked = (p) => MASKED_FILES.includes(p) || MASKED_DIRS.some((d) => p.startsWith(`${d}/`));

const FAILED = Symbol('failed');

// Merges `rest` (the arguments after `merge`) with the git at `real`, under
// the same global options. Returns null when the merge touches no masked
// path, or the exit code of the merge otherwise.
function mergeMasked(globals, rest, real) {
  const git = (argv, { input, env } = {}) => {
    const r = cp.spawnSync(real, [...globals, ...argv], { encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'inherit'] });
    return { status: r.status, out: String(r.stdout || '') };
  };
  // Mutations run with git's own errors on stderr; any failure stops the merge.
  const run = (argv, opts) => {
    const r = git(argv, opts);
    if (r.status !== 0) throw FAILED;
    return r.out;
  };
  const fail = (message) => {
    process.stderr.write(`tower-crane: ${message}\n`);
    return 1;
  };

  const refs = [];
  const options = [];
  let message;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (VALUED.includes(a)) {
      const value = rest[++k];
      if (a === '-m' || a === '--message') message = value;
      else options.push(`${a} ${value}`);
    } else if (a.startsWith('--message=')) message = a.slice('--message='.length);
    else if (a.startsWith('-')) options.push(a);
    else refs.push(a);
  }
  if (refs.length !== 1) return null;
  const [ref] = refs;

  const ours = git(['rev-parse', '--verify', '-q', 'HEAD']).out.trim();
  const theirs = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).out.trim();
  if (!ours || !theirs) return null;
  const base = git(['merge-base', ours, theirs]).out.trim();
  if (!base) return null;
  const touched = git(['diff', '--name-only', '--no-renames', '-z', base, theirs]).out.split('\0').filter(isMasked);
  if (!touched.length) return null;

  const unsupported = options.filter((o) => !OPTIONS.includes(o));
  if (unsupported.length) return fail(`merge option ${unsupported[0]} is not supported when the merge brings in ${touched[0]}`);
  const version = /(\d+)\.(\d+)/.exec(git(['version']).out);
  if (!version || Number(version[1]) < MIN_GIT[0] || (Number(version[1]) === MIN_GIT[0] && Number(version[2]) < MIN_GIT[1])) {
    return fail(`merging ${touched[0]} needs git ${MIN_GIT.join('.')} or newer`);
  }
  // The masked entries are rewritten in the index, so staged work on one would be lost.
  const staged = git(['diff', '--cached', '--name-only', '--no-renames', '-z', ours]).out.split('\0').find(isMasked);
  if (staged) return fail(`${staged} has staged changes; commit or unstage them before merging ${ref}`);
  const merged = git(['merge-tree', '--write-tree', ours, theirs]);
  if (merged.status === 1) return fail(`merging ${ref} conflicts with the masked path ${touched[0]} or other files; resolve it outside the sandbox`);
  if (merged.status !== 0) return fail(`cannot compute the merge of ${ref}`);
  const tree = merged.out.split('\n')[0];

  // Entries of a revision under the masked paths: path to { mode, sha }.
  const masked = (rev) => new Map(git(['ls-tree', '-r', '-z', rev, '--', ...MASKED_FILES, ...MASKED_DIRS]).out.split('\0').filter(Boolean).map((line) => {
    const [meta, p] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    return [p, { mode, sha }];
  }));
  const zero = '0'.repeat(ours.length);
  const line = (p, e) => (e ? `${e.mode} ${e.sha}\t${p}\0` : `0 ${zero}\t${p}\0`);

  const ff = base === ours && !options.includes('--no-ff');
  const commit = ff ? theirs : git(['commit-tree', tree, '-p', ours, '-p', theirs, '-m', message ?? `Merge ${ref}`]).out.trim();
  if (!commit) return fail(`cannot record the merge of ${ref}`);
  const before = masked(ours);
  const after = masked(commit);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-merge-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    // The tree to read into the worktree: the merge with each masked path
    // kept at ours' entry, or absent where ours has none. read-tree then
    // sees no change under a masked path, so it never touches the mount.
    run(['read-tree', commit], { env });
    const paths = new Set([...before.keys(), ...after.keys()]);
    run(['update-index', '-z', '--index-info'], { env, input: [...paths].map((p) => line(p, before.get(p))).join('') });
    const target = run(['write-tree'], { env }).trim();
    run(['read-tree', '-m', '-u', ours, target]);

    // Masked entries go into the index without a checkout; skip-worktree
    // keeps git from comparing them with the mount.
    run(['update-index', '-z', '--index-info'], { input: [...paths].map((p) => line(p, after.get(p))).join('') });
    run(['update-index', '-z', '--skip-worktree', '--stdin'], { input: [...after.keys()].map((p) => `${p}\0`).join('') });
    run(['update-ref', '-m', `merge ${ref}`, 'HEAD', commit, ours]);
    return 0;
  } catch (e) {
    if (e !== FAILED) throw e;
    return 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { mergeMasked, isMasked, MASKED_FILES, MASKED_DIRS };
