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
const { waitUntil, childClosed, fileWritten, killGroup } = require('./signals');

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

// Unlinking a mount point on the host detaches the bind in the sandbox's own
// mount namespace, and the sandboxed command can then write the name. A
// reviewer or small spawn sweeps the worktree while the task's worker may
// still run commands there.
test('the spawn sweep keeps a placeholder a live sandbox binds over, and takes it once that sandbox exits', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'live-bind-'));
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  const env = baseEnv();
  git(['init', '-q', '-b', 'main'], wt, env);
  const file = path.join(wt, '.bashrc');
  const ready = path.join(dir, 'ready');
  const go = path.join(dir, 'go');
  const script = 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done; if (echo planted > .bashrc) 2>/dev/null; then echo wrote; else echo refused; fi';
  const box = cp.spawn('bwrap', ['--dev-bind', '/', '/', '--ro-bind', '/dev/null', file, '--chdir', wt, '--', 'sh', '-c', script, 'sh', ready, go], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  box.stdout.on('data', (chunk) => { out += chunk; });
  try {
    await waitUntil(() => fs.existsSync(ready), { paths: [dir], alive: box, what: 'the sandbox has its bind' });
    const placeholder = fs.lstatSync(file);
    assert.equal(placeholder.size, 0);
    assert.equal(placeholder.mode & 0o222, 0, 'bwrap left an empty read-only placeholder');
    assert.deepEqual(Placeholders.sweep(wt, env).removed, [], 'a bound placeholder stays');
  } finally {
    fs.writeFileSync(go, '');
  }
  assert.equal((await childClosed(box)).code, 0);
  assert.equal(out.trim(), 'refused', 'the sandbox still cannot write the name');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.deepEqual(Placeholders.sweep(wt, env).removed, ['.bashrc'], 'with the sandbox gone the placeholder is stale');
});

// A sandbox that binds over an existing placeholder of the worktree and,
// once told to go, tries to write it. Bounded: it goes by itself after 60 s.
function holdScript(dir) {
  const script = path.join(dir, 'hold.sh');
  fs.writeFileSync(script, [
    'exec bwrap --dev-bind / / --ro-bind /dev/null "$1/.bashrc" --chdir "$1" -- sh -c \'',
    'touch "$1/ready"; i=0; while [ ! -e "$1/go" ] && [ $i -lt 3000 ]; do sleep 0.02; i=$((i+1)); done;', // wait-allow: the sandboxed shell has no signal helper; the cap ends a holder the test left
    'if (echo planted > .bashrc) 2>/dev/null; then echo wrote; else echo refused; fi\' sh "$2"',
    '',
  ].join('\n'));
  return script;
}

function staleWorktree(dir, env) {
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  git(['init', '-q', '-b', 'main'], wt, env);
  const file = path.join(wt, '.bashrc');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o444);
  return { wt, file };
}

// The sweep reads git's index before it removes anything; a command another
// agent starts meanwhile binds over a name the sweep is about to remove.
test('a sandbox that binds a stale placeholder while the sweep reads the index keeps its bind', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'late-bind-'));
  const env = baseEnv();
  const { wt, file } = staleWorktree(dir, env);
  const hold = holdScript(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const realGit = cp.execFileSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).trim();
  // The sweep's git starts the sandbox and waits for its bind.
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `if [ ! -e "${dir}/started" ]; then`,
    `  touch "${dir}/started"`,
    `  sh "${hold}" "${wt}" "${dir}" > "${dir}/out" 2>&1 &`,
    `  i=0; while [ ! -e "${dir}/ready" ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done`, // wait-allow: the sweep's git blocks the test's event loop, so the shell waits for the bind
    'fi',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  let result;
  try {
    result = Placeholders.sweep(wt, { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` });
  } finally {
    fs.writeFileSync(path.join(dir, 'go'), '');
  }
  assert.ok(fs.existsSync(path.join(dir, 'started')), 'the sweep ran git');
  const out = await fileWritten(path.join(dir, 'out'), { check: (text) => /wrote|refused/.test(text) });
  assert.equal(out.trim(), 'refused', 'the sandbox still cannot write the name');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.held, [{ relative: '.bashrc', why: 'mounted' }]);
  assert.match(Placeholders.heldLine(result.held, 'stale Claude sandbox placeholders'), /kept stale Claude sandbox placeholders \.bashrc: a live sandbox binds over it, and removing a bound name would let that sandbox write it/);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

// After an agent exits, its monitor removes the placeholders its sandbox
// left; another agent's sandbox can still bind over the same names.
test('the cleanup after an agent exits keeps a placeholder another live sandbox binds over', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'exit-bind-'));
  const env = baseEnv();
  const { wt, file } = staleWorktree(dir, env);
  const box = cp.spawn('sh', [holdScript(dir), wt, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  box.stdout.on('data', (chunk) => { out += chunk; });
  let result;
  try {
    await waitUntil(() => fs.existsSync(path.join(dir, 'ready')), { paths: [dir], alive: box, what: 'the sandbox has its bind' });
    result = Placeholders.remove(wt, []);
  } finally {
    fs.writeFileSync(path.join(dir, 'go'), '');
  }
  assert.equal((await childClosed(box)).code, 0);
  assert.equal(out.trim(), 'refused', 'the sandbox still cannot write the name');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.held, [{ relative: '.bashrc', why: 'mounted' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.deepEqual(Placeholders.remove(wt, []).removed, ['.bashrc'], 'with the sandbox gone the placeholder goes');
});

// A bind that lands between the removal's read of the mount tables and its
// rmdir. The process table the removal reads is the test's own: its one
// process's mountinfo is a FIFO that a helper fills. The helper starts a
// sandbox that binds an empty directory over .claude/hooks, and answers the
// first read with no mounts, as a read just before the bind would, and each
// later one with the sandbox's real table. rmdir under a bind detaches it,
// and the sandbox could then make .claude/hooks/h, a hook that runs outside it.
test('a directory placeholder bound after the first mount read keeps its bind', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(root, 'dir-bind-'));
  const wt = path.join(dir, 'wt');
  const hooks = path.join(wt, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(path.join(proc, '1', 'ns'), { recursive: true });
  fs.symlinkSync('mnt:[1]', path.join(proc, '1', 'ns', 'mnt'));
  const fifo = path.join(proc, '1', 'mountinfo');
  assert.equal(cp.spawnSync('mkfifo', [fifo]).status, 0);
  const helper = path.join(dir, 'helper.sh');
  fs.writeFileSync(helper, [
    // Its own session, so ending the helper's group leaves the sandbox to answer.
    'setsid bwrap --dev-bind / / --ro-bind "$3" "$4" --chdir "$2" -- sh -c \'',
    'echo $$ > "$1/pid.new"; mv "$1/pid.new" "$1/pid"; i=0; while [ ! -e "$1/go" ] && [ $i -lt 3000 ]; do sleep 0.02; i=$((i+1)); done;', // wait-allow: the sandboxed shell has no signal helper; the cap ends a holder the test left
    'if (mkdir -p .claude/hooks && echo planted > .claude/hooks/h) 2>/dev/null; then echo wrote; else echo refused; fi\' sh "$1" > "$1/out" 2>&1 &',
    'i=0; while [ ! -e "$1/pid" ] && [ $i -lt 500 ]; do sleep 0.02; i=$((i+1)); done', // wait-allow: the removal blocks the test's event loop, so the helper waits for the bind
    ': > "$5"',
    'while :; do cat "/proc/$(cat "$1/pid")/mountinfo" > "$5"; done',
    '',
  ].join('\n'));
  const fill = cp.spawn('sh', [helper, dir, wt, empty, hooks, fifo], { stdio: 'ignore', detached: true });
  let result;
  try {
    await waitUntil(() => fs.existsSync(path.join(dir, 'pid')), { paths: [dir], alive: fill, what: 'the sandbox has its bind' });
    const was = process.env.TOWER_CRANE_PROC;
    process.env.TOWER_CRANE_PROC = proc;
    try {
      result = Placeholders.remove(wt, ['.claude']);
    } finally {
      if (was === undefined) delete process.env.TOWER_CRANE_PROC;
      else process.env.TOWER_CRANE_PROC = was;
    }
  } finally {
    fs.writeFileSync(path.join(dir, 'go'), '');
    try { killGroup(fill.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const out = await fileWritten(path.join(dir, 'out'), { check: (text) => /wrote|refused/.test(text) });
  assert.equal(out.trim(), 'refused', 'the sandbox still cannot write into the name');
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.held, [{ relative: '.claude/hooks', why: 'mounted' }]);
  assert.equal(fs.existsSync(path.join(hooks, 'h')), false);
  assert.deepEqual(fs.readdirSync(path.join(wt, '.claude')), ['hooks'], 'the directory is back under its name');
  assert.match(Placeholders.heldLine([{ relative: '.vscode', why: 'unknown' }, { relative: '.idea', why: 'unknown' }], 'placeholders'),
    /kept placeholders \.vscode, \.idea: a mount table of this user's processes could not be read, so a sandbox may bind over them$/m);
});
