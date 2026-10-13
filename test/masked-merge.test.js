'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT } = require('./helpers');
const { isMasked, MASKED_DIRS } = require('../lib/masked-merge');
const { FILES: SANDBOX_PATHS } = require('../lib/claude-sandbox-placeholders');

const SHIM = path.join(ROOT, 'lib', 'shim.js');

test('masked file names match case-insensitively through the sandbox search depth', () => {
  for (const [file, masked] of [
    ['.mcp.json', true],
    ['.MCP.json', true],
    ['lib/.bashrc', true],
    ['lib/.Bashrc', true],
    ['one/two/.gitconfig', true],
    ['one/two/three/.gitconfig', false],
    ['web/.vscode/settings.json', true],
    ['.VSCode/settings.json', true],
    ['.idea/workspace.xml', true],
    ['.claude/commands/run.md', true],
    ['web/.VSCode/deep/settings.json', true],
    ['one/two/.vscode/settings.json', true],
    ['one/two/three/.vscode/settings.json', false],
    ['docs/.claude/commands/y.md', true],
    ['lib/bashrc', false],
    ['lib/.bashrc.backup', false],
    ['web/vscode/settings.json', false],
    ['.claude/hooks/run.md', true],
    ['.claude/settings.json', true],
    ['.CLAUDE/Settings.Local.JSON', true],
    ['web/.claude/settings.json', true],
    ['.claude/unknown.json', false],
  ]) assert.equal(isMasked(file), masked, file);
});

test('every known root sandbox placeholder is covered by the Git mask classifier', () => {
  for (const file of SANDBOX_PATHS) {
    assert.ok(isMasked(file), file);
  }
});

function git(args, cwd, env) {
  return cp.execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir, files, env, message) {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(['add', '-A'], dir, env);
  git(['commit', '-q', '-m', message], dir, env);
}

// A source repository where origin/main is ahead of the task branch B: the
// files in `main` change on main, the files in `task` on the branch. The
// worktree is a clone with B checked out from origin/feat.
function fixture(t, { base, task, main }, { masks = true, source } = {}) {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'masked-merge-'));
  const permissions = [];
  t.after(() => {
    for (const [fd, mode] of permissions.reverse()) {
      try { fs.fchmodSync(fd, mode); }
      finally { fs.closeSync(fd); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = agent\n\temail = agent@example.test\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root };
  for (const k of Object.keys(env)) if (k.startsWith('TOWER_CRANE_') || (k.startsWith('GIT_') && !k.startsWith('GIT_CONFIG_'))) delete env[k];
  // A sandbox passes its own git config this way; its excludes file hides masked paths, so the fixture's repositories must not see it.
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)) delete env[k];

  const src = source || path.join(root, 'src');
  if (!source) {
    fs.mkdirSync(src);
    git(['init', '-q', '-b', 'main'], src, env);
    commit(src, base, env, 'base');
    git(['checkout', '-q', '-b', 'feat'], src, env);
    commit(src, task, env, 'task');
    git(['checkout', '-q', 'main'], src, env);
    commit(src, main, env, 'main');
  }
  const wt = path.join(root, 'wt');
  git(['clone', '-q', src, wt], root, env);
  git(['checkout', '-q', '-b', 'B', 'origin/feat'], wt, env);

  // The shim as a worker runs it: the agent's policy, then git's own command in `cwd`.
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'none', gh: [], masks }));
  const shimDir = path.join(root, 'bin');
  fs.mkdirSync(shimDir);
  const shim = (cwd, ...args) => cp.spawnSync(process.execPath, [SHIM, policy, shimDir, 'git', ...args],
    { cwd, env, encoding: 'utf8' });
  const commitMain = (files) => {
    commit(src, files, env, 'main again');
    git(['fetch', '-q', 'origin'], wt, env);
  };
  return {
    env,
    wt,
    shim,
    merge: (...args) => shim(wt, 'merge', ...args),
    checkout: (...args) => shim(wt, 'checkout', ...args),
    commitMain,
    git: (args) => git(args, wt, env),
    head: () => git(['rev-parse', 'HEAD'], wt, env),
    show: (rev) => git(['show', rev], wt, env),
    readOnly: file => {
      const full = path.join(wt, file);
      const fd = fs.openSync(full, 'r');
      const stat = fs.fstatSync(fd);
      permissions.push([fd, stat.mode & 0o777]);
      fs.fchmodSync(fd, stat.isDirectory() ? 0o555 : 0o444);
    },
  };
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

test('merge and checkout preserve existing nested and case-variant masked files', (t) => {
  for (const file of ['lib/.bashrc', 'lib/.Bashrc', 'web/.vscode/settings.json', '.VSCode/settings.json', '.MCP.json']) {
    for (const operation of ['merge', 'checkout']) {
      const f = fixture(t, {
        base: { 'a.txt': 'a\n', [file]: 'v1\n' },
        task: { 'b.txt': 'b\n' },
        main: { 'a.txt': 'a2\n', [file]: 'v2\n' },
      });
      // A mount can show content that differs from the index; ordinary git refuses that change.
      fs.writeFileSync(path.join(f.wt, file), 'mount\n');
      f.readOnly(file);
      const result = operation === 'merge'
        ? f.merge('--no-edit', 'origin/main')
        : f.checkout('--detach', 'origin/main');
      assert.equal(result.status, 0, `${operation} ${file}: ${result.stderr}`);
      assert.equal(fs.readFileSync(path.join(f.wt, file), 'utf8'), 'mount\n', `${operation} ${file}`);
      assert.equal(f.show(`HEAD:${file}`), 'v2', `${operation} ${file}`);
      assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a2\n');
      assert.equal(f.git(['status', '--porcelain']), '', `${operation} ${file}`);
    }
  }
});

test('a nested read-only bind remains masked when its permission bits are writable', (t) => {
  const file = 'lib/.Bashrc';
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', [file]: 'v1\n' },
    task: { 'b.txt': 'b\n' },
    main: { [file]: 'v2\n' },
  });
  const target = path.join(f.git(['rev-parse', '--show-toplevel']), file);
  const preload = path.join(f.wt, '.git', 'mount-probe.js');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const access = fs.accessSync;
fs.accessSync = (file, mode) => {
  if (path.resolve(file) === ${JSON.stringify(target)} && mode === fs.constants.W_OK) {
    throw Object.assign(new Error('read-only mount'), { code: 'EROFS' });
  }
  return access(file, mode);
};
`);
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`;
  const result = f.merge('--no-edit', 'origin/main');
  assert.equal(result.status, 0, result.stderr);
  const fd = fs.openSync(target, 'r');
  try {
    assert.notEqual(fs.fstatSync(fd).mode & 0o222, 0);
    assert.equal(fs.readFileSync(fd, 'utf8'), 'v1\n');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(f.show(`HEAD:${file}`), 'v2');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a nested protected file behind a read-only parent moves through the shim',
  { skip: process.platform === 'win32' && 'Windows directory chmod does not model a read-only bind' }, (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', 'lib/.bashrc': 'v1\n' },
    task: { 'b.txt': 'b\n' },
    main: { 'lib/.bashrc': 'v2\n' },
  });
  f.readOnly('lib');
  const result = f.merge('--no-edit', 'origin/main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, 'lib/.bashrc'), 'utf8'), 'v1\n');
  assert.equal(f.show('HEAD:lib/.bashrc'), 'v2');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('merge and checkout preserve all protected Claude configuration entries', (t) => {
  for (const file of [
    '.claude/settings.json', '.claude/settings.local.json', '.claude/launch.json',
    '.claude/loop.md', '.claude/scheduled_tasks.json', '.claude/skills/x/SKILL.md',
    '.claude/hooks/pre.sh', '.claude/output-styles/style.md',
    '.claude/routines/routine.md', '.claude/workflows/workflow.md',
  ]) {
    for (const operation of ['merge', 'checkout']) {
      const f = fixture(t, {
        base: { 'a.txt': 'a\n', [file]: 'v1\n' },
        task: { 'b.txt': 'b\n' },
        main: { 'a.txt': 'a2\n', [file]: 'v2\n' },
      });
      fs.writeFileSync(path.join(f.wt, file), 'mount\n');
      f.readOnly(file);
      const result = operation === 'merge'
        ? f.merge('--no-edit', 'origin/main')
        : f.checkout('--detach', 'origin/main');
      assert.equal(result.status, 0, `${operation} ${file}: ${result.stderr}`);
      assert.equal(fs.readFileSync(path.join(f.wt, file), 'utf8'), 'mount\n', `${operation} ${file}`);
      assert.equal(f.show(`HEAD:${file}`), 'v2', `${operation} ${file}`);
      assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a2\n');
      assert.equal(f.git(['status', '--porcelain']), '', `${operation} ${file}`);
    }
  }
});

// test/masked-mounts.test.js runs every mount under real bubblewrap mounts.
// This one runs everywhere: Claude mounts each root name of the shared list
// even when it is absent at spawn, so a move under an absent root directory
// mount is held off the worktree. An untracked file stands in for the mount.
test('a move that adds a file under an absent root directory mount is held off the mount', (t) => {
  for (const dir of MASKED_DIRS) {
    for (const operation of ['merge', 'checkout']) {
      const file = `${dir}/sub/new.txt`;
      const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { 'a.txt': 'a2\n', [file]: 'new\n' } });
      fs.mkdirSync(path.dirname(path.join(f.wt, dir)), { recursive: true });
      fs.writeFileSync(path.join(f.wt, dir), '');
      fs.appendFileSync(path.join(f.wt, '.git', 'info', 'exclude'), `/${dir}\n`);
      const result = operation === 'merge' ? f.merge('--no-edit', 'origin/main') : f.checkout('--detach', 'origin/main');
      assert.equal(result.status, 0, `${operation} ${dir}: ${result.stderr}`);
      assert.equal(f.show(`HEAD:${file}`), 'new', `${operation} ${dir}`);
      assert.match(f.git(['ls-files', '-v', '--', file]), /^S /, `${operation} ${dir}`);
      assert.equal(fs.readFileSync(path.join(f.wt, dir), 'utf8'), '', `${operation} ${dir}`);
      assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a2\n');
      assert.equal(f.git(['status', '--porcelain']), '', `${operation} ${dir}`);
    }
  }
});

test('a masked move materializes protected nested names that did not exist before it', (t) => {
  const added = ['web/.Bashrc', 'web/.VSCode/settings.json', 'web/.claude/skills/new/SKILL.md'];
  for (const operation of ['merge', 'checkout']) {
    const f = fixture(t, {
      base: { '.mcp.json': 'v1\n', 'a.txt': 'a\n' },
      task: { 'b.txt': 'b\n' },
      main: { '.mcp.json': 'v2\n', ...Object.fromEntries(added.map(file => [file, 'new\n'])) },
    });
    // An empty nested directory yields no match in the spawn-time file scan.
    fs.mkdirSync(path.join(f.wt, 'web', '.VSCode'), { recursive: true });
    const result = operation === 'merge'
      ? f.merge('--no-edit', 'origin/main')
      : f.checkout('--detach', 'origin/main');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), 'v1\n');
    for (const file of added) {
      assert.equal(fs.readFileSync(path.join(f.wt, file), 'utf8'), 'new\n');
      assert.match(f.git(['ls-files', '-v', '--', file]), /^H /, file);
    }
    assert.equal(f.git(['status', '--porcelain']), '');
    // These files remain unmounted for this worker, including its next move.
    f.commitMain({ '.mcp.json': 'v3\n', ...Object.fromEntries(added.map(file => [file, 'next\n'])) });
    const again = operation === 'merge'
      ? f.merge('--no-edit', 'origin/main')
      : f.checkout('--detach', 'origin/main');
    assert.equal(again.status, 0, again.stderr);
    for (const file of added) {
      assert.equal(fs.readFileSync(path.join(f.wt, file), 'utf8'), 'next\n');
      assert.match(f.git(['ls-files', '-v', '--', file]), /^H /);
    }
  }
});

test('a discovered nested protected directory keeps deeper entries and new children off the mount',
  { skip: process.platform === 'win32' && 'Windows directory chmod does not model a read-only bind' }, (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', 'web/.VSCode/settings.json': 'v1\n', 'web/.VSCode/deep/keep.json': 'keep\n' },
    task: { 'b.txt': 'b\n' },
    main: { 'web/.VSCode/settings.json': 'v2\n', 'web/.VSCode/deep/keep.json': 'updated\n', 'web/.VSCode/new.json': 'new\n' },
  });
  f.readOnly('web/.VSCode');
  const result = f.merge('--no-edit', 'origin/main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, 'web/.VSCode/settings.json'), 'utf8'), 'v1\n');
  assert.equal(fs.readFileSync(path.join(f.wt, 'web/.VSCode/deep/keep.json'), 'utf8'), 'keep\n');
  assert.equal(fs.existsSync(path.join(f.wt, 'web/.VSCode/new.json')), false);
  assert.equal(f.show('HEAD:web/.VSCode/new.json'), 'new');
  assert.equal(f.show('HEAD:web/.VSCode/deep/keep.json'), 'updated');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a protected name below the scan depth is materialized when no shallower file discovers its directory', (t) => {
  const f = fixture(t, {
    base: { '.mcp.json': 'v1\n', 'web/.VSCode/deep/settings.json': 'v1\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': 'v2\n', 'web/.VSCode/deep/settings.json': 'v2\n' },
  });
  const result = f.merge('--no-edit', 'origin/main');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), 'v1\n');
  assert.equal(fs.readFileSync(path.join(f.wt, 'web/.VSCode/deep/settings.json'), 'utf8'), 'v2\n');
  assert.match(f.git(['ls-files', '-v', '--', 'web/.VSCode/deep/settings.json']), /^H /);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a fast-forward through the shim that brings in a sandbox-masked path moves the branch and leaves the mount alone', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{}\n' } });
  // Put the branch on the base that main descends from, so the merge is a fast-forward.
  f.git(['checkout', '-q', '-B', 'B', 'origin/main^']);
  fs.mkdirSync(path.join(f.wt, '.mcp.json'));
  fs.writeFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'keep\n');
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.head(), f.git(['rev-parse', 'origin/main']));
  assert.equal(f.show('HEAD:.mcp.json'), '{}');
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'utf8'), 'keep\n');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a masked merge that conflicts is refused with its reason, and the branch does not move', (t) => {
  const f = fixture(t, { base: { '.mcp.json': '{"v":1}\n' }, task: { '.mcp.json': '{"v":"task"}\n' }, main: { '.mcp.json': '{"v":"main"}\n' } });
  const before = f.head();
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /conflicts with the masked path \.mcp\.json/);
  assert.equal(f.head(), before);
});

test('outside the sandbox a merge that brings in a masked path runs as git merge', (t) => {
  const f = fixture(t, { base: { '.mcp.json': '{"v":1}\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{"v":2}\n' } }, { masks: false });
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '{"v":2}\n');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a masked merge with staged changes to a masked path is refused with its reason, and the branch does not move', (t) => {
  const f = fixture(t, { base: { '.mcp.json': '{"v":1}\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{"v":2}\n' } });
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '{"v":"local"}\n');
  f.git(['add', '.mcp.json']);
  const before = f.head();
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\.mcp\.json has staged changes; commit or unstage them before merging origin\/main/);
  assert.equal(f.head(), before);
});

test('a masked merge with an option the plumbing does not honour is refused with its reason', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { '.mcp.json': '{}\n' } });
  const before = f.head();
  for (const [args, option] of [[['--squash'], '--squash'], [['-s', 'ort'], '-s ort'], [['-X', 'ours'], '-X ours']]) {
    const r = f.merge(...args, 'origin/main');
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes(`merge option ${option} is not supported when the merge brings in .mcp.json`), r.stderr);
  }
  assert.equal(f.head(), before);
});

test('a merge through the shim that brings in no masked path runs as git merge', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { 'c.txt': 'c\n' } });
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(['rev-list', '--parents', '-n1', 'HEAD'], f.wt, f.env).split(' ').length, 3);
  assert.equal(fs.readFileSync(path.join(f.wt, 'c.txt'), 'utf8'), 'c\n');
});

test('a merge through the shim run from a subdirectory brings in a masked path at the top of the worktree', (t) => {
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'sub/a.txt': 'sub\n' }, main: { '.mcp.json': '{}\n' } });
  fs.mkdirSync(path.join(f.wt, '.mcp.json'));
  fs.writeFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'keep\n');
  const r = f.shim(path.join(f.wt, 'sub'), 'merge', '--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.show('HEAD:.mcp.json'), '{}');
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json', 'keep'), 'utf8'), 'keep\n');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a merge through the shim brings in a masked path whose name contains a tab and leaves the mount alone', { skip: process.platform === 'win32' && 'Windows file names cannot contain a tab' }, (t) => {
  const tabbed = '.vscode/a\tb.json';
  const f = fixture(t, { base: { 'a.txt': 'a\n' }, task: { 'b.txt': 'b\n' }, main: { [tabbed]: '{}\n' } });
  fs.mkdirSync(path.join(f.wt, tabbed), { recursive: true });
  fs.writeFileSync(path.join(f.wt, tabbed, 'keep'), 'keep\n');
  f.readOnly(tabbed);
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.show(`HEAD:${tabbed}`), '{}');
  assert.equal(fs.readFileSync(path.join(f.wt, tabbed, 'keep'), 'utf8'), 'keep\n');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a masked merge with a staged change to another file is refused with its reason, and the branch does not move', (t) => {
  const f = fixture(t, { base: { '.mcp.json': '{"v":1}\n', 'b.txt': 'b0\n' }, task: { 'c.txt': 'c\n' }, main: { '.mcp.json': '{"v":2}\n' } });
  fs.writeFileSync(path.join(f.wt, 'b.txt'), 'local\n');
  f.git(['add', 'b.txt']);
  const before = f.head();
  const r = f.merge('--no-edit', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /b\.txt has staged changes; commit or unstage them before merging origin\/main/);
  assert.equal(f.head(), before);
});

test('a checkout through the shim that brings in a changed sandbox-masked path moves HEAD and leaves the mount alone', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  // The sandbox shows an empty file at the mount, which differs from the index, so a plain checkout refuses it.
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('--detach', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'HEAD');
  assert.equal(f.head(), f.git(['rev-parse', 'origin/main']));
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim that creates a branch lets git commit a change after the masked path moved', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('-b', 'C', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--abbrev-ref', 'HEAD']), 'C');
  fs.writeFileSync(path.join(f.wt, 'c.txt'), 'c\n');
  f.git(['add', 'c.txt']);
  f.git(['commit', '-q', '-m', 'add c']);
  assert.equal(f.show('HEAD:c.txt'), 'c');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim of a local branch that brings in a changed sandbox-masked path moves HEAD onto that branch', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  f.git(['branch', 'M', 'origin/main']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('M');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/M');
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim run with -C into a directory the checkout removes still moves HEAD', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'sub/a.txt': 'sub\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  // main has no sub/, so the checkout removes the directory -C names.
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.shim(f.wt, '-C', 'sub', 'checkout', '--detach', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.head(), f.git(['rev-parse', 'origin/main']));
  assert.equal(fs.existsSync(path.join(f.wt, 'sub')), false);
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim of a branch another worktree has checked out is refused as git refuses it, and both worktrees stay as they were', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  // M sits on origin/main, so a plain checkout brings in the changed .mcp.json.
  // N sits on the task head, so -B N origin/main would move it.
  const [m, n] = ['M', 'N'].map((b) => path.join(path.dirname(f.wt), `other-${b}`));
  f.git(['branch', 'M', 'origin/main']);
  f.git(['branch', 'N']);
  f.git(['worktree', 'add', '-q', m, 'M']);
  f.git(['worktree', 'add', '-q', n, 'N']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const before = f.head();
  for (const [args, branch, dir] of [[['-B', 'N', 'origin/main'], 'N', n], [['M'], 'M', m]]) {
    const at = f.git(['rev-parse', branch]);
    const r = f.checkout(...args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`'${branch}' is already used by worktree at`));
    assert.equal(f.git(['rev-parse', branch]), at);
    assert.equal(git(['status', '--porcelain'], dir, f.env), '');
  }
  assert.equal(f.head(), before);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/B');
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
});

test('a checkout through the shim with a branch name git refuses leaves HEAD, the index and the worktree as they were', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n', 'a.txt': 'a2\n' },
  });
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const before = f.head();
  const r = f.checkout('-b', 'bad..name', 'origin/main');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /'bad\.\.name' is not a valid branch name/);
  assert.equal(f.head(), before);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/B');
  assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(f.wt, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(f.git(['diff', '--cached', '--name-only']), '');
});

test('a checkout through the shim that resets the previous branch by its @{-1} shorthand moves that branch and leaves the mount alone', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n', 'a.txt': 'a2\n' },
  });
  f.git(['checkout', '-q', '-b', 'prev', 'origin/main']);
  f.git(['checkout', '-q', 'B']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('-B', '@{-1}', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/prev');
  assert.equal(f.head(), f.git(['rev-parse', 'origin/main']));
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a2\n');
  assert.equal(fs.existsSync(path.join(f.wt, 'b.txt')), false);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim of the previous branch by its @{-1} shorthand moves HEAD onto that branch', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  f.git(['checkout', '-q', '-b', 'prev', 'origin/main']);
  f.git(['checkout', '-q', 'B']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('@{-1}');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/prev');
  assert.equal(f.head(), f.git(['rev-parse', 'origin/main']));
  assert.equal(fs.readFileSync(path.join(f.wt, '.mcp.json'), 'utf8'), '');
  assert.equal(f.show('HEAD:.mcp.json'), '{"v":2}');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a checkout through the shim of a name that is both a branch and a tag moves HEAD onto the branch and loads the branch', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n', 'a.txt': 'a2\n' },
  });
  // The branch M is the task head and the tag M is origin/main. git's checkout takes the branch.
  f.git(['branch', 'M', 'B']);
  f.git(['tag', 'M', 'origin/main']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const before = f.head();
  const r = f.checkout('M');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/M');
  assert.equal(f.head(), before);
  assert.equal(fs.readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.existsSync(path.join(f.wt, 'b.txt')), true);
  assert.equal(f.git(['diff', '--cached', '--name-only']), '');
});

test('a checkout through the shim of a branch records git\'s reflog message, so @{-1} after it names the branch it left', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n', 'a.txt': 'a2\n' },
  });
  f.git(['branch', 'M', 'origin/main']);
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  assert.equal(f.checkout('M').status, 0);
  assert.equal(f.git(['reflog', '-n1', '--format=%gs', 'HEAD']), 'checkout: moving from B to M');
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('@{-1}');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', '--symbolic-full-name', 'HEAD']), 'refs/heads/B');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a detached checkout through the shim records git\'s reflog message', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('--detach', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['reflog', '-n1', '--format=%gs', 'HEAD']), 'checkout: moving from B to origin/main');
});

test('a checkout through the shim that creates a branch records git\'s branch and HEAD reflog messages', (t) => {
  const f = fixture(t, {
    base: { 'a.txt': 'a\n', '.mcp.json': '{"v":1}\n' },
    task: { 'b.txt': 'b\n' },
    main: { '.mcp.json': '{"v":2}\n' },
  });
  fs.writeFileSync(path.join(f.wt, '.mcp.json'), '');
  const r = f.checkout('-b', 'N', 'origin/main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['reflog', '-n1', '--format=%gs', 'HEAD']), 'checkout: moving from B to N');
  assert.equal(f.git(['reflog', '-n1', '--format=%gs', 'refs/heads/N']), 'branch: Created from origin/main');
});
