'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT } = require('./helpers');

const SHIM = path.join(ROOT, 'lib', 'shim.js');

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir, files, env, message) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(['add', '-A'], dir, env);
  git(['commit', '-q', '-m', message], dir, env);
}

// A source repository where origin/main is ahead of the task branch B: the
// files in `main` change on main, the files in `task` on the branch. The
// worktree is a clone with B checked out from origin/feat.
function fixture(t, { base, task, main }) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'masked-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = agent\n\temail = agent@example.test\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  for (const k of Object.keys(env)) if (k.startsWith('TOWER_CRANE_') || (k.startsWith('GIT_') && !k.startsWith('GIT_CONFIG_'))) delete env[k];

  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  git(['init', '-q', '-b', 'main'], src, env);
  commit(src, base, env, 'base');
  git(['checkout', '-q', '-b', 'feat'], src, env);
  commit(src, task, env, 'task');
  git(['checkout', '-q', 'main'], src, env);
  commit(src, main, env, 'main');
  const wt = path.join(root, 'wt');
  git(['clone', '-q', src, wt], root, env);
  git(['checkout', '-q', '-b', 'B', 'origin/feat'], wt, env);

  // The shim as a worker runs it: the agent's policy, then git's real merge.
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'none', gh: [] }));
  const shimDir = path.join(root, 'bin');
  fs.mkdirSync(shimDir);
  const merge = (...args) => cp.spawnSync(process.execPath, [SHIM, policy, shimDir, 'git', 'merge', ...args],
    { cwd: wt, env, encoding: 'utf8' });
  const commitMain = (files) => {
    commit(src, files, env, 'main again');
    git(['fetch', '-q', 'origin'], wt, env);
  };
  return { env, wt, merge, commitMain, head: () => git(['rev-parse', 'HEAD'], wt, env), show: (rev) => git(['show', rev], wt, env) };
}

test('a merge through the shim that brings in a sandbox-masked path succeeds and leaves the mount alone', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{}\n' } });
  // The sandbox mounts over .mcp.json while it is absent from the branch. git
  // cannot unlink or write a mount point, so a plain merge stops at this path.
  fs.mkdirSync(path.join(f.wt, '.mcp.json'));
  fs.writeFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'keep\n');
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(['rev-list', '--parents', '-n1', 'HEAD'], f.wt, f.env).split(' ').length, 3);
  assert.equal(f.show('HEAD:.mcp.json'), '{}');
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'utf8'), 'keep\n');
  assert.equal(git(['status', '--porcelain'], f.wt, f.env), '');
});

test('a merge through the shim that changes a tracked masked path keeps the file the sandbox gave and applies the rest', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { 'a.txt': 'a2\n', '.mcp.json': '{"v":2}\n' },
  });
  // The read-only bind shows the real file, which the merge must not write.
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '{"v":1}\n');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a2\n');
  assert.equal(git(['status', '--porcelain'], f.wt, f.env), '');

  // The next merge reads the index this one left behind.
  f.commitMain({ '.mcp.json': '{"v":3}\n' });
  const again = f.merge('--no-edit', 'origin/main');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '{"v":1}\n');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":3}');
  assert.equal(git(['status', '--porcelain'], f.wt, f.env), '');
});

test('a masked merge that conflicts is refused with its reason, and the branch does not move', (t) => {
  const f = fixture(t, { base: { '.mcp.json': '{"v":1}\n' }, task: { '.mcp.json': '{"v":"task"}\n' }, main: { '.mcp.json': '{"v":"main"}\n' } });
  const before = f.head();
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /conflicts with the masked path \.mcp\.json/);
  assert.equal(f.head(), before);
});

test('a masked merge with an option the plumbing does not honour is refused with its reason', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{}\n' } });
  const before = f.head();
  const r = f.merge('--squash', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /merge option --squash is not supported when the merge brings in \.mcp\.json/);
  assert.equal(f.head(), before);
});

test('a merge through the shim that brings in no masked path runs as git merge', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { 'c.txt': 'c\n' } });
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(['rev-list', '--parents', '-n1', 'HEAD'], f.wt, f.env).split(' ').length, 3);
  assert.equal(fs.readFileSync(path.join(f.wt, 'c.txt'), 'utf8'), 'c\n');
});
