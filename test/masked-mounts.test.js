'use strict';

// Every name Claude's sandbox mounts in a worktree, through a git merge or
// checkout run by the shim inside real bubblewrap mounts. The mounts follow
// Claude Code 2.1.296's Linux sandbox: each root name of the shared list is
// mounted whether it exists or not. A name that exists gets a read-only bind
// of itself. An absent name whose parent exists gets /dev/null bound over it.
// An absent name whose parent is missing (`.claude` absent) gets an empty
// read-only directory bound at that first missing ancestor. After the command
// Claude removes the mount points it created when they are still empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT } = require('./helpers');
const { FOREGROUND_MAINTENANCE } = require('./repo-seed');
const Placeholders = require('../lib/claude-sandbox-placeholders');
const { readPublished } = require('./atomic-file');

const SHIM = path.join(ROOT, 'lib', 'shim.js');
const BWRAP = process.platform === 'linux'
  && cp.spawnSync('bwrap', ['--dev-bind', '/', '/', '--', 'true'], { stdio: 'ignore' }).status === 0;
const skip = !BWRAP && 'needs bubblewrap, the mount tool Claude uses on Linux';

const root = BWRAP ? fs.mkdtempSync(path.join(TMP_ROOT, 'masked-mounts-')) : null;
if (root) process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const gitconfig = root && path.join(root, 'gitconfig');
if (root) fs.writeFileSync(gitconfig, '[user]\n\tname = agent\n\temail = agent@example.test\n' + FOREGROUND_MAINTENANCE);
const baseEnv = () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TOWER_CRANE_') || (k.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(k))) delete env[k];
  }
  return env;
};

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function commit(dir, files, env, message) {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    else {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  }
  git(['add', '-A'], dir, env);
  git(['commit', '-q', '--allow-empty', '-m', message], dir, env);
}

// A source repository, built once per shape: base, the task branch feat with
// b.txt, and main's commits on top of base.
const seeds = new Map();
function seed(key, base, mains) {
  if (seeds.has(key)) return seeds.get(key);
  const src = fs.mkdtempSync(path.join(root, 'seed-'));
  const env = baseEnv();
  git(['init', '-q', '-b', 'main'], src, env);
  commit(src, base, env, 'base');
  git(['checkout', '-q', '-b', 'feat'], src, env);
  commit(src, { 'b.txt': 'b\n' }, env, 'task');
  git(['checkout', '-q', 'main'], src, env);
  mains.forEach((files, i) => commit(src, files, env, `main ${i + 1}`));
  seeds.set(key, src);
  return src;
}

// Claude's mounts for the worktree as it is now, as bwrap arguments, and the
// mount points bwrap will create on the host.
function claudeMounts(wt, empty) {
  const args = [];
  const created = [];
  const points = new Set();
  for (const name of Placeholders.FILES) {
    const target = path.join(wt, name);
    if (fs.existsSync(target)) {
      args.push('--ro-bind', target, target);
      continue;
    }
    let first = wt;
    for (const part of name.split('/')) {
      first = path.join(first, part);
      if (!fs.existsSync(first)) break;
    }
    if (points.has(first)) continue;
    points.add(first);
    args.push('--ro-bind', first === target ? '/dev/null' : empty, first);
    created.push(first);
  }
  return { args, created };
}

// A Tower Crane worker's linked worktree on branch B, with the private
// excludes file spawn gives a claude sandbox for the names absent at spawn.
function worker(t, src, prepare, { masks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'cell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = baseEnv();
  const repo = path.join(dir, 'repo');
  git(['clone', '-q', src, repo], dir, env);
  const wt = path.join(dir, 'wt');
  git(['worktree', 'add', '-q', '-b', 'B', wt, 'origin/feat'], repo, env);
  prepare(wt);
  const excludes = path.join(dir, 'sandbox-git-exclude');
  const patterns = Placeholders.ignorePatterns(Placeholders.present(wt));
  fs.writeFileSync(excludes, patterns.map((p) => `${p}\n`).join(''));
  const sandboxEnv = { ...env, ...Placeholders.gitEnvironment(excludes, env) };
  const policy = path.join(dir, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'none', gh: [], masks }));
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir);
  const empty = fs.mkdtempSync(path.join(dir, 'claude-empty-'));
  fs.chmodSync(empty, 0o700);
  const trace = path.join(dir, 'trace');
  // One sandboxed Bash command: the shim's git under the mounts, then
  // Claude's cleanup of the mount points it created that are still empty.
  const run = (...args) => {
    fs.rmSync(trace, { force: true });
    const { args: mounts, created } = claudeMounts(wt, empty);
    const r = cp.spawnSync('bwrap', ['--dev-bind', '/', '/', ...mounts, '--chdir', wt, '--',
      process.execPath, SHIM, policy, shimDir, 'git', ...args], { env: { ...sandboxEnv, GIT_TRACE: trace }, encoding: 'utf8' });
    for (const point of created) {
      try {
        const stat = fs.lstatSync(point);
        if (stat.isFile() && stat.size === 0) fs.unlinkSync(point);
        else if (stat.isDirectory() && fs.readdirSync(point).length === 0) fs.rmdirSync(point);
      } catch { /* already gone */ }
    }
    return { ...r, trace: fs.existsSync(trace) ? readPublished(trace, 'utf8') : '' };
  };
  return { wt, run, git: (args) => git(args, wt, sandboxEnv) };
}

const KINDS = Object.fromEntries(Placeholders.DIRECTORIES.map((name) => [name, 'directory']));
const OLD = '# old\n';
const NEW = '# new\n';

// The tracked path a cell moves: the name itself for a file mount, a file
// two levels inside it for a directory mount.
const tracked = (name) => (KINDS[name] ? `${name}/sub/file.txt` : name);

// Start states: present binds what the worktree has; absent mounts /dev/null
// at the name; for a .claude name, absent with .claude missing mounts an empty
// read-only directory at .claude.
function states(name) {
  const list = ['present', 'absent'];
  if (name.startsWith('.claude/')) list.push('absent, .claude missing');
  return list;
}

// The commits a cell moves through. Each step is a separate sandboxed
// command. An absent path is only tracked after a masked move brought it in,
// so changing or deleting one first adds it.
function plan(name, state, edit) {
  const file = tracked(name);
  if (state === 'present') {
    if (edit === 'add') {
      // A directory mount holds another tracked file; a file mount holds the
      // empty placeholder an earlier command's cleanup left behind.
      const base = KINDS[name] ? { 'a.txt': 'a\n', [`${name}/keep.txt`]: 'keep\n' } : { 'a.txt': 'a\n' };
      return { base, mains: [{ 'a.txt': 'a2\n', [file]: NEW }], leftover: !KINDS[name] };
    }
    return { base: { 'a.txt': 'a\n', [file]: OLD }, mains: [{ 'a.txt': 'a2\n', [file]: edit === 'delete' ? null : NEW }] };
  }
  if (edit === 'add') return { base: { 'a.txt': 'a\n' }, mains: [{ 'a.txt': 'a2\n', [file]: NEW }] };
  return { base: { 'a.txt': 'a\n' }, mains: [{ [file]: OLD }, { 'a.txt': 'a2\n', [file]: edit === 'delete' ? null : NEW }] };
}

const EDITS = ['add', 'change', 'delete'];
const OPERATIONS = ['merge', 'checkout'];
const covered = [];

for (const name of Placeholders.FILES) {
  const kind = KINDS[name] || 'file';
  test(`a sandbox mount at ${name} (${kind}) takes the masked move for every start state, edit and operation`, { skip }, async (t) => {
    for (const state of states(name)) {
      for (const edit of EDITS) {
        for (const operation of OPERATIONS) {
          const label = `${name} (${kind}), ${state}, ${edit}, ${operation}`;
          await t.test(label, (t) => {
            const file = tracked(name);
            const { base, mains, leftover } = plan(name, state, edit);
            const src = seed(`${name}:${state === 'present' ? 'present' : 'absent'}:${edit}`, base, mains);
            const w = worker(t, src, (wt) => {
              if (leftover) {
                fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
                fs.writeFileSync(path.join(wt, name), '');
                fs.chmodSync(path.join(wt, name), 0o444);
              }
              // Claude keeps .claude/.cc-writes/ in the worktree, so .claude
              // exists unless this cell starts without it.
              if (name.startsWith('.claude/') && state === 'absent') fs.mkdirSync(path.join(wt, '.claude', '.cc-writes'), { recursive: true });
            });
            let r;
            for (let step = mains.length - 1; step >= 0; step--) {
              const rev = step ? `origin/main~${step}` : 'origin/main';
              r = operation === 'merge' ? w.run('merge', '--no-edit', rev) : w.run('checkout', '--detach', rev);
              assert.equal(r.status, 0, `${label}, to ${rev}: ${r.stderr}`);
              assert.match(r.trace, /built-in: git read-tree -m -u /, `${label}, to ${rev}: the masked move ran`);
              assert.doesNotMatch(r.trace, /built-in: git (merge|checkout) /, `${label}, to ${rev}: plain git did not run`);
            }
            assert.equal(fs.readFileSync(path.join(w.wt, 'a.txt'), 'utf8'), 'a2\n', `${label}: unmasked files moved`);
            if (edit === 'delete') {
              assert.equal(w.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', file]), '', label);
              assert.equal(w.git(['ls-files', '--', file]), '', label);
            } else {
              assert.equal(w.git(['show', `HEAD:${file}`]), NEW.trimEnd(), label);
              assert.match(w.git(['ls-files', '-v', '--', file]), /^S /, `${label}: held off the mount`);
            }
            // The mount kept what the sandbox gave it, and the move wrote nothing
            // under it. An absent mount point is gone after Claude's cleanup.
            if (state !== 'present') assert.equal(fs.existsSync(path.join(w.wt, name)), false, `${label}: mount point cleaned up`);
            else if (edit !== 'add') assert.equal(fs.readFileSync(path.join(w.wt, file), 'utf8'), OLD, `${label}: mount kept`);
            else if (leftover) assert.equal(fs.readFileSync(path.join(w.wt, file), 'utf8'), '', `${label}: placeholder kept`);
            else {
              assert.equal(fs.existsSync(path.join(w.wt, file)), false, `${label}: nothing written under the bind`);
              assert.equal(fs.readFileSync(path.join(w.wt, name, 'keep.txt'), 'utf8'), 'keep\n', label);
            }
            // A file deleted under a present bind stays on the mount, untracked.
            const status = w.git(['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
            assert.deepEqual(status, state === 'present' && edit === 'delete' ? [`?? ${file}`] : [], `${label}: status`);
            // The shim names each one, so a later `git add -A` is not a surprise.
            const noted = [...r.stderr.matchAll(/^tower-crane: (.+) was deleted by this move, but the sandbox mount still holds it/gm)].map((m) => m[1]);
            assert.deepEqual(noted, status.map((line) => line.slice(3)), `${label}: note`);
            covered.push(label);
          });
        }
      }
    }
  });
}

test('the mount table covers every shared mount name, start state, edit and operation', { skip }, () => {
  const expected = Placeholders.FILES.reduce((n, name) => n + states(name).length * EDITS.length * OPERATIONS.length, 0);
  assert.equal(covered.length, expected);
  assert.equal(new Set(covered).size, expected);
});

// The control: the same mounts stop plain git, so each cell above passes only
// through the masked move.
test('without the masked move, plain git stops at the mounts the table uses', { skip }, (t) => {
  for (const [name, state] of [['.mcp.json', 'absent'], ['.vscode', 'present'], ['.claude/hooks', 'absent'], ['.claude/skills', 'absent, .claude missing']]) {
    for (const operation of OPERATIONS) {
      const { base, mains } = plan(name, state, 'add');
      const w = worker(t, seed(`${name}:${state === 'present' ? 'present' : 'absent'}:add`, base, mains), (wt) => {
        if (state === 'absent' && name.startsWith('.claude/')) fs.mkdirSync(path.join(wt, '.claude', '.cc-writes'), { recursive: true });
      }, { masks: false });
      const r = operation === 'merge' ? w.run('merge', '--no-edit', 'origin/main') : w.run('checkout', '--detach', 'origin/main');
      // A checkout can exit 0 after "unable to unlink old", leaving the path modified.
      assert.ok(r.status !== 0 || /^error: /m.test(r.stderr), `${name}, ${state}, ${operation}: plain git passed the mount`);
    }
  }
});
