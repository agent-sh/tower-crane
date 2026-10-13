'use strict';

// A merge or checkout that brings in a path the sandbox masks. Claude Code
// mounts over those paths (a read-only bind of the real file, or /dev/null when
// it is absent), and git can neither unlink nor write a mount point, so a plain
// merge stops with "would lose untracked files in it" and a checkout with
// "please commit your changes". These moves are built with plumbing instead:
// merge-tree makes a merge's tree and commit-tree its commit, a two-tree
// read-tree moves the unmasked files, and each masked entry goes into the index
// without a checkout and is marked skip-worktree. HEAD or its branch then moves.
// Masked files keep what the sandbox gave them. A move that brings in no masked
// path returns null, and the caller runs git as it always does.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('./commands');
const { REGULAR_FILES: MASKED_FILES, DIRECTORIES: MASKED_DIRS } = require('./claude-sandbox-placeholders');

// Claude Code 2.1.296 searches dangerous names case-insensitively through
// three path components. A discovered protected directory covers its subtree.
const MASK_SEARCH_DEPTH = 3;

// merge-tree --write-tree needs git 2.38.
const MIN_GIT = [2, 38];
// The merge options the plumbing honours. Anything else could change what
// gets written, so a masked merge that uses it is refused.
const OPTIONS = ['--no-edit', '--no-ff', '--ff', '-q', '--quiet'];
// git merge options that take a value; the value is not the ref. -m is the
// only one the plumbing honours; the others are refused with their value.
const VALUED = ['-m', '--message', '-s', '--strategy', '-X', '--strategy-option', '-F', '--file', '--cleanup', '--into-name'];
// The checkout options the plumbing honours. -b and -B name the branch to
// create; each takes its name as the next argument.
const CHECKOUT_OPTIONS = ['--detach', '-q', '--quiet'];
const CHECKOUT_VALUED = ['-b', '-B'];

function maskedDirectories(p) {
  const parts = p.split('/');
  const lower = parts.map(part => part.toLowerCase());
  const matches = [];
  for (const directory of MASKED_DIRS) {
    const names = directory.split('/');
    for (let start = 0; start + names.length <= MASK_SEARCH_DEPTH; start++) {
      if (start + names.length > parts.length) break;
      if (names.every((name, offset) => lower[start + offset] === name)) {
        matches.push(parts.slice(0, start + names.length).join('/'));
      }
    }
  }
  return matches;
}

function isMasked(p) {
  const lower = p.toLowerCase();
  const parts = lower.split('/');
  return (parts.length <= MASK_SEARCH_DEPTH && MASKED_FILES.some(file => lower === file || lower.endsWith(`/${file}`)))
    || maskedDirectories(p).length > 0;
}

function readOnly(p) {
  try {
    const stat = fs.lstatSync(p);
    // A read-only bind may retain writable mode bits, so access also checks
    // the mount's writability. An ordinary mode restriction is protected too.
    if ((stat.mode & 0o222) === 0) return true;
    fs.accessSync(p, fs.constants.W_OK);
    return false;
  }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return true;
    throw error;
  }
}

// Claude mounts every root name of the shared list whether it exists or not: a
// read-only bind of what is there, /dev/null where the name is absent, or an
// empty read-only directory at the first missing ancestor (`.claude` itself
// absent). So a path at or under one of them always meets a mount.
const ROOT_MOUNTS = [...MASKED_FILES, ...MASKED_DIRS];

function maskedInWorktree(cwd) {
  const mounts = new Map();
  const mounted = (p) => {
    if (!mounts.has(p)) mounts.set(p, readOnly(path.join(cwd, p)));
    return mounts.get(p);
  };
  return p => {
    if (ROOT_MOUNTS.some(m => p === m || p.startsWith(`${m}/`))) return true;
    // git can neither create nor unlink an entry inside a read-only directory,
    // whatever the entry's name.
    for (let dir = path.posix.dirname(p); dir !== '.'; dir = path.posix.dirname(dir)) {
      if (mounted(dir)) return true;
    }
    // A nested protected name is mounted only where it existed at spawn.
    return isMasked(p) && mounted(p);
  };
}

const FAILED = Symbol('failed');

const fail = (message) => {
  process.stderr.write(`tower-crane: ${message}\n`);
  return 1;
};

// git at `real` under the same global options, run from the top of the
// worktree. -C names the directory git runs in, and a move can remove that
// directory, so it is dropped: every path the move gives git is root-relative.
// cwd is null outside a worktree. run() throws FAILED on a non-zero exit: the
// move stops, and git's own error is already on stderr.
function gitRunner(globals, real) {
  const at = cp.spawnSync(real, [...globals, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const cwd = at.status === 0 ? at.stdout.trim() : null;
  const rest = [];
  for (let k = 0; k < globals.length; k++) {
    if (globals[k] === '-C') k++;
    else rest.push(globals[k]);
  }
  const git = (argv, { input, env } = {}) => {
    const r = cp.spawnSync(real, [...rest, ...argv], { cwd, encoding: 'utf8', input, env, stdio: ['pipe', 'pipe', 'inherit'] });
    return { status: r.status, out: String(r.stdout || '') };
  };
  const run = (argv, opts) => {
    const r = git(argv, opts);
    if (r.status !== 0) throw FAILED;
    return r.out;
  };
  return { cwd, git, run, masked: cwd && maskedInWorktree(cwd) };
}

// The first path with a staged change against `ours`. git refuses any staged
// change before a merge or checkout, and the masked entries are rewritten in
// the index, so the move refuses it too.
const stagedPath = ({ git }, ours) => git(['diff', '--cached', '--name-only', '--no-renames', '-z', ours]).out.split('\0').find(Boolean);

// The path of another worktree that has `ref` checked out, or null. git will not
// check a branch out twice, and a move that reset it would leave that worktree's
// HEAD, index and files behind.
function checkedOutElsewhere({ git, cwd }, ref) {
  for (const block of git(['worktree', 'list', '--porcelain']).out.split('\n\n')) {
    const lines = block.split('\n');
    const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (lines.includes(`branch ${ref}`) && dir !== cwd) return dir;
  }
  return null;
}

// The branch name git gives `name`, with a shorthand such as @{-1} expanded to
// the branch it stands for. Null when git does not accept it as a branch name.
function branchName({ git }, name) {
  const r = git(['check-ref-format', '--branch', name]);
  return r.status === 0 ? r.out.trim() : null;
}

// Entries of a revision under the masked paths, keyed by path from the top of
// the worktree: path to { mode, sha }.
function maskedEntries({ run, masked }, rev) {
  const out = run(['ls-tree', '--full-tree', '-r', '-z', rev]);
  return new Map(out.split('\0').filter(Boolean).map((line) => {
    // Only the first tab ends the metadata: a path may contain tabs.
    const tab = line.indexOf('\t');
    const [mode, , sha] = line.slice(0, tab).split(' ');
    return [line.slice(tab + 1), { mode, sha }];
  }).filter(([p]) => masked(p)));
}

// Moves the index and the worktree from `ours` to `commit`, then runs
// `moveRef`. Each masked path keeps ours' entry while the unmasked files move,
// so read-tree never touches the mount. The masked entries then take commit's
// values without a checkout, marked skip-worktree, which keeps git from
// comparing them with the mount. Returns the exit code of the move.
function moveMasked(g, ours, commit, moveRef) {
  const { run } = g;
  const before = maskedEntries(g, ours);
  const after = maskedEntries(g, commit);
  const zero = '0'.repeat(ours.length);
  const line = (p, e) => (e ? `${e.mode} ${e.sha}\t${p}\0` : `0 ${zero}\t${p}\0`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-merge-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    // The tree to read into the worktree: commit with each masked path kept at
    // ours' entry, or absent where ours has none. read-tree then sees no change
    // under a masked path, so it never touches the mount.
    run(['read-tree', commit], { env });
    const paths = new Set([...before.keys(), ...after.keys()]);
    run(['update-index', '-z', '--index-info'], { env, input: [...paths].map((p) => line(p, before.get(p))).join('') });
    const target = run(['write-tree'], { env }).trim();
    run(['read-tree', '-m', '-u', ours, target]);

    // Masked entries go into the index without a checkout; skip-worktree
    // keeps git from comparing them with the mount.
    run(['update-index', '-z', '--index-info'], { input: [...paths].map((p) => line(p, after.get(p))).join('') });
    run(['update-index', '-z', '--skip-worktree', '--stdin'], { input: [...after.keys()].map((p) => `${p}\0`).join('') });
    moveRef();
    return 0;
  } catch (e) {
    if (e !== FAILED) throw e;
    return 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Merges `rest` (the arguments after `merge`) with the git at `real`, under
// the same global options. Returns null when the merge touches no masked
// path, or the exit code of the merge otherwise.
function mergeMasked(globals, rest, real) {
  const g = gitRunner(globals, real);
  if (!g.cwd) return null;
  const { git, run } = g;

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
  const touched = git(['diff', '--name-only', '--no-renames', '-z', base, theirs]).out.split('\0').filter(g.masked);
  if (!touched.length) return null;

  const unsupported = options.filter((o) => !OPTIONS.includes(o));
  if (unsupported.length) return fail(`merge option ${unsupported[0]} is not supported when the merge brings in ${touched[0]}`);
  const version = /(\d+)\.(\d+)/.exec(git(['version']).out);
  if (!version || Number(version[1]) < MIN_GIT[0] || (Number(version[1]) === MIN_GIT[0] && Number(version[2]) < MIN_GIT[1])) {
    return fail(`merging ${touched[0]} needs git ${MIN_GIT.join('.')} or newer`);
  }
  const staged = stagedPath(g, ours);
  if (staged) return fail(`${staged} has staged changes; commit or unstage them before merging ${ref}`);
  const merged = git(['merge-tree', '--write-tree', ours, theirs]);
  if (merged.status === 1) return fail(`merging ${ref} conflicts with the masked path ${touched[0]} or other files; resolve it outside the sandbox`);
  if (merged.status !== 0) return fail(`cannot compute the merge of ${ref}`);
  const tree = merged.out.split('\n')[0];

  const ff = base === ours && !options.includes('--no-ff');
  const commit = ff ? theirs : git(['commit-tree', tree, '-p', ours, '-p', theirs, '-m', message ?? `Merge ${ref}`]).out.trim();
  if (!commit) return fail(`cannot record the merge of ${ref}`);
  return moveMasked(g, ours, commit, () => run(['update-ref', '-m', `merge ${ref}`, 'HEAD', commit, ours]));
}

// Switches to the revision in `rest` (the arguments after `checkout`) with the
// git at `real`, under the same global options: a branch, a revision (detached),
// or -b and -B with a start point. A checkout of paths is git's own. Returns null
// when the switch touches no masked path, or the exit code of the checkout otherwise.
function checkoutMasked(globals, rest, real) {
  const g = gitRunner(globals, real);
  if (!g.cwd) return null;
  const { git, run } = g;

  const refs = [];
  const options = [];
  let create;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (CHECKOUT_VALUED.includes(a)) create = { flag: a, name: rest[++k] };
    else if (a.startsWith('-')) options.push(a);
    else refs.push(a);
  }
  if (refs.length > 1 || (!refs.length && !create) || (create && !create.name)) return null;
  const [start = 'HEAD'] = refs;

  const ours = git(['rev-parse', '--verify', '-q', 'HEAD']).out.trim();
  // The branch name git gives the target. A shorthand such as @{-1} is expanded
  // to the branch it stands for; null when git does not accept it as a branch name.
  const name = branchName(g, create ? create.name : start);
  // An existing branch of that name is the target, so its commit is the tree that
  // moves in: git's checkout takes a branch over a tag or path of the same name.
  const existing = !create && name && !options.includes('--detach') && git(['show-ref', '--verify', '-q', `refs/heads/${name}`]).status === 0;
  const theirs = git(['rev-parse', '--verify', '-q', `${existing ? `refs/heads/${name}` : start}^{commit}`]).out.trim();
  if (!ours || !theirs) return null;
  const touched = git(['diff', '--name-only', '--no-renames', '-z', ours, theirs]).out.split('\0').filter(g.masked);
  if (!touched.length) return null;

  const unsupported = options.filter((o) => !CHECKOUT_OPTIONS.includes(o));
  if (unsupported.length) return fail(`checkout option ${unsupported[0]} is not supported when the checkout brings in ${touched[0]}`);
  const staged = stagedPath(g, ours);
  if (staged) return fail(`${staged} has staged changes; commit or unstage them before checking out ${start}`);

  // Refused before the index or the worktree moves: a name git does not accept,
  // or a branch another worktree has checked out. -b refuses a name that exists,
  // which git reports itself.
  if (create && !name) return fail(`'${create.name}' is not a valid branch name`);
  const branch = create || existing ? `refs/heads/${name}` : null;
  const known = branch && git(['show-ref', '--verify', '-q', branch]).status === 0;
  if (create?.flag === '-b' && known) return null;
  const other = branch && checkedOutElsewhere(g, branch);
  if (other) return fail(`'${branch.replace(/^refs\/heads\//, '')}' is already used by worktree at '${other}'`);

  // The reflog messages git writes for the same move. @{-1} reads HEAD's log to
  // find the branch left, so the message must match git's. HEAD's names the branch
  // or commit it leaves and the one it reaches, as typed.
  const head = git(['symbolic-ref', '-q', 'HEAD']).out.trim();
  const from = head ? head.replace(/^refs\/heads\//, '') : ours;
  const reason = `checkout: moving from ${from} to ${name ?? start}`;
  const startName = branchName(g, start) ?? start;
  return moveMasked(g, ours, theirs, () => {
    if (create) run(['update-ref', '-m', `branch: ${known ? 'Reset to' : 'Created from'} ${startName}`, branch, theirs]);
    if (branch) run(['symbolic-ref', '-m', reason, 'HEAD', branch]);
    else run(['update-ref', '--no-deref', '-m', reason, 'HEAD', theirs, ours]);
  });
}

module.exports = { mergeMasked, checkoutMasked, isMasked, MASKED_FILES, MASKED_DIRS };
