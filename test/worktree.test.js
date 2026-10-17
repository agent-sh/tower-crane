'use strict';

const { fileWritten, childExit } = require('./signals');
const StateFiles = require('./state-files');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, makeRepo, run, runAsync, HOOKS } = require('./helpers');

// Gate preparation (lib/gates/common.js withWorktree) at `sha` in `repo`, in
// a process with the fixture's environment. `marker` is created when the
// gate runs git worktree prune, which follows its relink.
function gate(h, repo, sha, marker = '') {
  const script = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const { withWorktree } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'gates', 'common'))});
    const exec = async (cmd, args, opts) => {
      if (process.env.GATE_MARK && args.includes('prune')) fs.writeFileSync(process.env.GATE_MARK, '');
      const r = cp.spawnSync(cmd, args, opts);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    withWorktree({ exec }, process.env.GATE_REPO, process.env.GATE_SHA, async () => ({ ok: true })).then((r) => {
      process.stdout.write(JSON.stringify(r));
      process.exitCode = r && r.ok ? 0 : 1;
    });`;
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, ['-e', script], { cwd: repo, env: { ...h.env, GATE_REPO: repo, GATE_SHA: sha, GATE_MARK: marker } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A task, a bare origin and a clone of it standing in for another machine;
// built once per process for each base and copied for each test.
function setup(t, base = 'main') {
  return cachedFixture(t, base, (h) => {
    if (base !== 'main') h.git(['branch', base]);
    h.init(['--base', base]);
    h.ok(['task', 'add', '--title', 'Fresh base', '--acceptance', 'starts from the freshest base']);
    const origin = path.join(h.base, 'origin.git');
    h.git(['init', '--bare', '-q', origin]);
    h.git(['remote', 'set-url', 'origin', origin]);
    h.git(['push', 'origin', base]);
    h.git(['branch', `--set-upstream-to=origin/${base}`, base]);
    const upstream = path.join(h.base, 'upstream');
    h.git(['clone', '-q', '--branch', base, origin, upstream]);
    return { origin, upstream, baseBranch: base };
  });
}

function advance(h, cwd, file) {
  fs.writeFileSync(path.join(cwd, file), 'new base commit\n');
  h.git(['add', file], cwd);
  h.git(['commit', '-qm', file], cwd);
  return h.git(['rev-parse', 'HEAD'], cwd);
}

for (const base of ['main', 'release/next']) {
  test(`worktree fetches ${base} and starts from origin when the local base is stale`, (t) => {
    const h = setup(t, base);
    const stale = h.git(['rev-parse', base]);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', 'origin', base], h.upstream);
    assert.equal(h.git(['rev-parse', `origin/${base}`]), stale);

    const wt = h.json(['worktree', 'T1']);
    assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
    assert.equal(h.git(['rev-parse', `origin/${base}`]), fresh);
    assert.equal(h.git(['rev-parse', base]), stale);
    // The branch tracks its namesake on origin, never the base: a sandboxed
    // worker cannot write the config `git push -u` would change.
    assert.equal(h.git(['for-each-ref', '--format=%(upstream)', `refs/heads/${wt.branch}`]), `refs/remotes/origin/${wt.branch}`);
    assert.equal(fs.readFileSync(path.join(wt.path, 'remote.txt'), 'utf8'), 'new base commit\n');
    assert.equal(h.json(['task', 'show', 'T1']).branch, wt.branch);

    // An existing worktree must remain usable even while origin is unavailable.
    fs.renameSync(h.origin, `${h.origin}.offline`);
    const again = h.json(['worktree', 'T1']);
    assert.equal(again.created, false);
    assert.equal(again.path, wt.path);
    assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
  });
}

// A dispatch prefetches before it waits for the dispatch lock; a dependency
// can merge on origin in that wait, so a dependent's worktree still starts
// from the base as it is when the worktree is made.
test('a dependent task starts from the base as it is under the dispatch lock, not as prefetched', (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Dependent', '--acceptance', 'builds on T1', '--dep', 'T1']);
  const W = require('../lib/worktree');
  const repo = { root: h.repo, commonDir: path.join(h.repo, '.git') };
  const st = require('../lib/state').loadState(h.state);
  const task = st.tasks.tasks.find((x) => x.id === 'T2');
  const fetched = W.prefetch(repo, st, task);
  const merged = advance(h, h.upstream, 'merged-dependency.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const wt = W.create(repo, st, task, undefined, fetched);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), merged);
});

test('worktree keeps a local base that is ahead of origin', (t) => {
  const h = setup(t);
  const local = advance(h, h.repo, 'local.txt');
  const remote = h.git(['rev-parse', 'origin/main']);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`using local base main at ${local}; origin/main is at ${remote}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
});

test('worktree keeps a divergent local base while refreshing origin', (t) => {
  const h = setup(t);
  const local = advance(h, h.repo, 'local.txt');
  const remote = advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`using local base main at ${local}; origin/main is at ${remote}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
  assert.equal(h.git(['rev-parse', 'origin/main']), remote);
});

test('worktree uses the fetched base when no local base branch exists', (t) => {
  const h = setup(t);
  const fresh = advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  h.git(['checkout', '-q', '--detach']);
  h.git(['branch', '-D', 'main']);
  h.git(['update-ref', '-d', 'refs/remotes/origin/main']);
  const wt = h.json(['worktree', 'T1']);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
});

test('worktree refreshes origin even when its configured fetch excludes the base', (t) => {
  const h = setup(t);
  h.git(['config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other']);
  const fresh = advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const wt = h.json(['worktree', 'T1']);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
  assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
});

test('worktree refuses a failed origin fetch without recording or creating a task branch', (t) => {
  const h = setup(t);
  fs.renameSync(h.origin, `${h.origin}.offline`);
  const before = StateFiles.logText(h.state);
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(StateFiles.logText(h.state), before);
  assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
});

test('worktree uses a local base missing from origin instead of its stale tracking ref', (t) => {
  const h = setup(t);
  h.git(['symbolic-ref', 'HEAD', 'refs/heads/other'], h.origin);
  h.git(['push', 'origin', ':main']);
  const local = advance(h, h.repo, 'local.txt');
  h.git(['update-ref', 'refs/remotes/origin/main', h.git(['rev-parse', 'HEAD~1'])]);

  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`origin has no base branch main; using local base at ${local}`));
  const wt = JSON.parse(r.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), local);
  assert.equal(h.json(['task', 'show', 'T1']).branch, wt.branch);
});

test('worktree refuses a base missing both locally and on origin without writing state', (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--base', 'missing']);
  const before = StateFiles.logText(h.state);
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /base branch missing is not in this repository/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(StateFiles.logText(h.state), before);
  assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
});

test('worktree refuses a locked tracking ref that does not match the origin tip', (t) => {
  const h = setup(t);
  const stale = h.git(['rev-parse', 'origin/main']);
  advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const before = StateFiles.logText(h.state);
  fs.writeFileSync(path.join(h.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');

  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.git(['rev-parse', 'origin/main']), stale);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(StateFiles.logText(h.state), before);
  assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
});

for (const recovered of [true, false]) {
  test(`an unpack failure ${recovered ? 'uses a tip fetched by another caller' : 'refuses a stale tracking ref'}`, (t) => {
    const h = setup(t);
    const stale = h.git(['rev-parse', 'origin/main']);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', 'origin', 'main'], h.upstream);
    const marker = path.join(h.base, 'upload-pack-failed');
    const uploadPack = path.join(h.base, 'upload-pack.js');
    // A peer may finish importing the new tip before this caller's object write fails.
    fs.writeFileSync(uploadPack, `
const fs = require('node:fs');
const cp = require('node:child_process');
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '');
  if (${recovered}) cp.execFileSync('git', ['-c', 'remote.origin.uploadpack=git-upload-pack', '-c', 'protocol.file.allow=always',
    'fetch', '--no-tags', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    { cwd: ${JSON.stringify(h.repo)}, stdio: 'pipe' });
  process.stderr.write('fatal: unpack-objects failed\\n');
  process.exit(1);
}
const r = cp.spawnSync('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    // The CLI's git takes upload-pack only from the user's own config.
    h.git(['config', '--global', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
    const before = StateFiles.logText(h.state);
    const result = h.run(['worktree', 'T1', '--json']);
    if (recovered) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(h.git(['rev-parse', 'HEAD'], JSON.parse(result.stdout).path), fresh);
      assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
    } else {
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /git fetch origin main failed/);
      assert.equal(h.git(['rev-parse', 'origin/main']), stale);
      assert.equal(StateFiles.logText(h.state), before);
      assert.equal(h.json(['task', 'show', 'T1']).branch, null);
      assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
    }
  });
}

for (const error of ['lock', 'fetching ref refs/remotes/origin/main failed: incorrect old value provided']) {
  test(`worktree retries once after ${error} and uses the fresh tracking ref`, (t) => {
    const h = setup(t);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', 'origin', 'main'], h.upstream);
    const attempts = path.join(h.base, 'fetch-attempts');
    const r = h.run(['worktree', 'T1', '--json'], {
      hooks: { HOOK_FETCH_ERROR: error, HOOK_FETCH_ATTEMPTS: attempts },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(attempts, 'utf8'), '..', 'exactly two fetch attempts');
    const wt = JSON.parse(r.stdout);
    assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
    assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
  });
}

for (const error of ['lock', 'incorrect old value provided', 'fatal: unpack-objects failed']) {
  test(`worktree refuses repeated ${error} without creating or recording a branch`, (t) => {
    const h = setup(t);
    advance(h, h.upstream, 'remote.txt');
    h.git(['push', 'origin', 'main'], h.upstream);
    const before = StateFiles.logText(h.state);
    const attempts = path.join(h.base, 'fetch-attempts');
    const r = h.run(['worktree', 'T1'], {
      hooks: { HOOK_FETCH_ERROR: error, HOOK_FETCH_ALWAYS: '1', HOOK_FETCH_ATTEMPTS: attempts },
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /git fetch origin main failed/);
    assert.equal(fs.readFileSync(attempts, 'utf8'), error.includes('unpack-objects') ? '.' : '..');
    assert.equal(h.json(['task', 'show', 'T1']).branch, null);
    assert.equal(StateFiles.logText(h.state), before);
    assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
    assert.equal(h.json(['worktree', 'T1']).created, true, 'the failed call permits a later preparation');
  });
}

function guardUploadPack(h, delay = 200) {
  const active = path.join(h.base, 'fetch-active');
  const attempts = path.join(h.base, 'fetch-attempts');
  const uploadPack = path.join(h.base, 'upload-pack.js');
  fs.writeFileSync(uploadPack, `
const fs = require('node:fs');
const cp = require('node:child_process');
const active = ${JSON.stringify(active)};
try {
  fs.writeFileSync(active, '', { flag: 'wx' });
} catch {
  process.stderr.write('concurrent upload-pack processes\\n');
  process.exit(1);
}
try {
  fs.appendFileSync(${JSON.stringify(attempts)}, '.');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delay}); // wait-allow: a slow upload-pack widens the window a concurrent fetch would hit
  const r = cp.spawnSync('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
  process.exitCode = r.status === null ? 1 : r.status;
} finally {
  fs.unlinkSync(active);
}
`);
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  // The CLI's git takes upload-pack only from the user's own config.
  h.git(['config', '--global', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
  return attempts;
}

for (const command of ['worktree', 'spawn']) {
  // Proof comes from the recorded upload-pack calls, not elapsed time, which
  // tracks host load. The suite's hung-test timeout only catches a hang.
  test(`one dispatch prepares six ${command} tasks from one slow base fetch`, { timeout: 300000 }, async (t) => {
    const h = setup(t);
    const fresh = advance(h, h.upstream, 'remote.txt');
    h.git(['push', 'origin', 'main'], h.upstream);
    const ids = ['T1'];
    for (let i = 2; i <= 6; i++) {
      ids.push(h.ok(['task', 'add', '--title', `Parallel ${i}`, '--acceptance', 'uses fresh base']));
    }
    if (command === 'spawn') {
      h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command',
        JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
      for (const id of ids) h.ok(['brief', 'set', id, '-'], { input: 'Use the fresh base.\n' });
    }
    const attempts = guardUploadPack(h, 15000);
    const hooks = { HOOK_WORKTREE_ADD_ACTIVE: path.join(h.base, 'worktree-add-active') };
    const trees = h.json(['worktree', ...ids], { hooks });
    assert.equal(fs.readFileSync(attempts, 'utf8'), '.', 'the dispatcher fetched once before preparing workers');
    assert.equal(trees.length, 6);
    for (let i = 0; i < trees.length; i++) {
      assert.equal(trees[i].id, ids[i]);
      assert.equal(h.git(['rev-parse', 'HEAD'], trees[i].path), fresh);
      assert.ok(h.json(['task', 'show', ids[i]]).branch);
    }
    if (command === 'spawn') {
      const results = await Promise.all(ids.map((id) => h.runAsync(
        ['spawn', '--role', 'medium', '--task', id, '--wait', '--json'], { hooks })));
      assert.deepEqual(results.map((r) => r.code), Array(6).fill(0), results.map((r) => r.stderr).join('\n'));
      // Each spawn runs in the worktree the dispatch prepared from its one
      // fetch, and none of them fetched again.
      assert.deepEqual(results.map((r) => JSON.parse(r.stdout).cwd), trees.map((tree) => tree.path));
      for (const r of results) assert.equal(h.git(['rev-parse', 'HEAD'], JSON.parse(r.stdout).cwd), fresh);
      assert.equal(fs.readFileSync(attempts, 'utf8'), '.', 'no spawn fetched');
    }
    assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
  });
}

test('a later dispatch fetches again even when the previous fetch did not move the tracking ref', (t) => {
  const h = setup(t);
  h.json(['worktree', 'T1']);
  const fresh = advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const id = h.ok(['task', 'add', '--title', 'Next dispatch', '--acceptance', 'fresh base']);
  const wt = h.json(['worktree', id]);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), fresh);
});

for (const hooks of [{ HOOK_ADD_ERROR: 'ETIMEDOUT' }, { HOOK_DIE_WORKTREE_ADD: '1' }]) {
  test(`an interrupted add cannot be reused without inspection: ${Object.keys(hooks)[0]}`, (t) => {
    const h = setup(t);
    const before = StateFiles.logText(h.state);
    const r = h.run(['worktree', 'T1'], { hooks });
    assert.notEqual(r.code, 0, r.stderr);
    const retry = h.run(['worktree', 'T1']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /worktree.*unfinished/);
    assert.match(retry.stderr, /git worktree unlock <path>/);
    assert.match(retry.stderr, /git worktree remove --force <path>/);
    assert.equal(h.json(['task', 'show', 'T1']).branch, null);
    assert.equal(StateFiles.logText(h.state), before);
    const dir = path.join(h.base, 'repo-worktrees', 'T1-fresh-base');
    assert.equal(h.git(['status', '--porcelain'], dir), '');
    h.git(['worktree', 'unlock', dir]);
    assert.equal(h.json(['worktree', 'T1']).created, false, 'an inspected, complete worktree can be reused');
  });
}

const waitForFile = (file) => fileWritten(file);

test('a surviving post-checkout child cannot write into a replacement worktree', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const paused = path.join(h.base, 'hook-paused');
  const done = path.join(h.base, 'hook-done');
  const cliPid = path.join(h.base, 'cli-pid');
  const hook = path.join(h.base, 'post-checkout.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const end = Date.now() + 300000;
while (!fs.existsSync(${JSON.stringify(paused + '.go')}) && Date.now() < end) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.writeFileSync('orphan.txt', 'original Git child');
fs.writeFileSync(${JSON.stringify(done)}, '');
`);
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  // The CLI's git runs only hooks from the user's own config.
  const hooks = path.join(h.base, 'hooks');
  fs.mkdirSync(hooks);
  fs.appendFileSync(h.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
  const script = path.join(hooks, 'post-checkout');
  fs.writeFileSync(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hook)}\n`, { mode: 0o755 });
  let cli;
  const first = h.runAsync(['worktree', 'T1'], { hooks: { HOOK_ADD_PID: cliPid }, onSpawn: (child) => { cli = child; } });
  try {
    await waitForFile(paused);
    cli.kill('SIGKILL');
    assert.notEqual((await childExit(cli, { signal: t.signal })).code, 0);
    const retry = h.run(['worktree', 'T1']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /worktree.*unfinished/);
    assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await waitForFile(done);
    await first;
  }
  const retry = h.run(['worktree', 'T1']);
  assert.equal(retry.code, 1, retry.stderr);
  assert.match(retry.stderr, /worktree.*unfinished/);
  assert.equal(fs.readFileSync(path.join(h.base, 'repo-worktrees', 'T1-fresh-base', 'orphan.txt'), 'utf8'), 'original Git child');
});

test('a registration interrupted before HEAD exists is refused without deleting it', (t) => {
  const h = setup(t);
  const dir = path.join(h.base, 'repo-worktrees', 'T1-fresh-base');
  const admin = path.join(h.repo, '.git', 'worktrees', 'T1-fresh-base');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'gitdir'), path.join(dir, '.git') + '\n');
  fs.writeFileSync(path.join(admin, 'locked'), 'initializing');
  const before = StateFiles.logText(h.state);
  for (let i = 0; i < 2; i++) {
    const retry = h.run(['worktree', 'T1']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /unfinished|incomplete|exists and is not a worktree/);
  }
  assert.ok(fs.existsSync(path.join(admin, 'locked')));
  assert.equal(StateFiles.logText(h.state), before);
});

test('a rework recreated after a newer submission from another checkout starts from that submission, not a stale tracking ref', (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const wt = h.json(['worktree', 'T1']);
  fs.writeFileSync(path.join(wt.path, 'first.txt'), 'first\n');
  h.git(['add', 'first.txt'], wt.path);
  h.git(['commit', '-qm', 'first'], wt.path);
  h.git(['push', 'origin', wt.branch], wt.path);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD'], wt.path), '--agent', 'w-1']);
  h.ok(['rework', 'T1', '--reason', 'revise the first head', '--agent', 'owner']);
  h.ok(['claim', 'T1', '--agent', 'w-2']);

  // Another checkout pushes and submits a newer head; this checkout's tracking ref still names the first.
  h.git(['fetch', '-q', 'origin', wt.branch], h.upstream);
  h.git(['checkout', '-q', '-B', wt.branch, `origin/${wt.branch}`], h.upstream);
  fs.writeFileSync(path.join(h.upstream, 'second.txt'), 'second\n');
  h.git(['add', 'second.txt'], h.upstream);
  h.git(['commit', '-qm', 'second'], h.upstream);
  const second = h.git(['rev-parse', 'HEAD'], h.upstream);
  h.git(['push', 'origin', wt.branch], h.upstream);
  assert.throws(() => h.git(['cat-file', '-e', `${second}^{commit}`]));
  const submitted = h.json(['submit', 'T1', '--sha', second.toUpperCase(), '--agent', 'w-2']);
  assert.equal(submitted.sha, second);
  assert.throws(() => h.git(['cat-file', '-e', `${second}^{commit}`]));
  h.ok(['rework', 'T1', '--reason', 'revise the second head', '--agent', 'owner']);

  h.git(['worktree', 'remove', '--force', wt.path]);
  h.git(['branch', '-D', wt.branch]);
  const again = h.json(['worktree', 'T1']);
  assert.equal(again.created, true);
  assert.equal(h.git(['rev-parse', 'HEAD'], again.path), second);
});

test('submit fetches the task branch before resolving a remote-only abbreviation', (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const wt = h.json(['worktree', 'T1']);
  h.git(['push', 'origin', wt.branch], wt.path);
  h.git(['fetch', '-q', 'origin', wt.branch], h.upstream);
  h.git(['checkout', '-q', '-B', wt.branch, `origin/${wt.branch}`], h.upstream);
  const remote = advance(h, h.upstream, 'remote-only.txt');
  h.git(['push', 'origin', wt.branch], h.upstream);
  assert.notEqual(h.git(['rev-parse', `origin/${wt.branch}`]), remote);
  const submitted = h.json(['submit', 'T1', '--sha', remote.slice(0, 8).toUpperCase(), '--agent', 'w-1']);
  assert.equal(submitted.sha, remote);
  assert.equal(h.git(['rev-parse', `origin/${wt.branch}`]), remote);
  assert.equal(h.git(['rev-parse', `${remote}^{commit}`]), remote);
  const before = h.readState('tasks.json');
  const refused = h.run(['submit', 'T1', '--sha', 'f'.repeat(8), '--agent', 'w-1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot resolve.*commit/);
  assert.deepEqual(h.readState('tasks.json'), before);
});

test('cancelling removes clean, dirty and missing worktrees, saving dirty files', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const title of ['Clean', 'Dirty', 'Gone']) h.ok(['task', 'add', '--title', title, '--acceptance', 'not needed']);
  const clean = h.json(['worktree', 'T1']);
  const dirty = h.json(['worktree', 'T2']);
  const gone = h.json(['worktree', 'T3']);
  fs.writeFileSync(path.join(dirty.path, 'notes.txt'), 'unfinished\n');
  fs.rmSync(gone.path, { recursive: true, force: true });

  for (const id of ['T1', 'T2', 'T3']) h.ok(['task', 'update', id, '--status', 'cancelled']);

  assert.ok(!fs.existsSync(clean.path), 'the clean worktree is removed');
  assert.ok(!fs.existsSync(dirty.path), 'the dirty worktree is saved and removed');
  assert.ok(!h.registers(dirty.path), 'git forgets the dirty worktree');
  assert.ok(!h.registers(clean.path), 'git forgets the removed worktree');
  assert.ok(!h.registers(gone.path), 'prune clears the registration of a missing directory');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const saved = events.find((e) => e.cmd === 'worktree removed' && e.task === 'T2').detail.saved;
  assert.equal(fs.readFileSync(path.join(saved, 'files', 'notes.txt'), 'utf8'), 'unfinished\n');
});

// A sandboxed agent writes the git directory but not its worktrees/, so a
// task worktree's admin directory lives beside the worktrees, where git
// reaches it through a link; git works there and removal takes both away.
test('a task worktree keeps its admin directory outside the git directory\'s worktrees/, and removal takes it away', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Admin', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  const common = fs.realpathSync.native(path.join(h.repo, '.git'));
  const name = path.basename(wt.path);
  const entry = path.join(common, 'worktrees', name);
  const admin = path.join(path.dirname(wt.path), '.git-admin', name);
  // Relative, so a move of the project directory keeps them.
  assert.equal(fs.readlinkSync(entry), path.relative(path.dirname(entry), admin));
  assert.equal(fs.readFileSync(path.join(wt.path, '.git'), 'utf8'), `gitdir: ${path.relative(wt.path, admin)}\n`);
  assert.equal(fs.readFileSync(path.join(admin, 'commondir'), 'utf8'), `${path.relative(admin, common)}\n`);
  assert.equal(fs.realpathSync.native(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt.path)), common);
  fs.writeFileSync(path.join(wt.path, 'f.txt'), 'f\n');
  h.git(['add', 'f.txt'], wt.path);
  h.git(['commit', '-qm', 'f'], wt.path);
  assert.equal(h.git(['rev-parse', `refs/heads/${wt.branch}`]), h.git(['rev-parse', 'HEAD'], wt.path));
  assert.ok(h.registers(wt.path));
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  assert.ok(!h.registers(wt.path), 'git forgets the worktree');
  // lstat: a dangling link would pass an existsSync check.
  for (const p of [entry, admin]) assert.equal(fs.lstatSync(p, { throwIfNoEntry: false }), undefined, `${p} is gone`);
});

// The repository and the worktrees root sit side by side in the project
// directory; moving it keeps a task worktree working, and the next prune
// does not take its admin directory for a stale one.
test('a moved project directory keeps its relocated task worktree, and the next worktree call relinks it before prune', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Moved', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  fs.writeFileSync(path.join(wt.path, 'f.txt'), 'f\n');
  h.git(['add', 'f.txt'], wt.path);
  h.git(['commit', '-qm', 'f'], wt.path);
  fs.writeFileSync(path.join(wt.path, 'staged.txt'), 'staged\n');
  h.git(['add', 'staged.txt'], wt.path);
  const head = h.git(['rev-parse', 'HEAD'], wt.path);
  const project = path.join(h.base, 'moved');
  fs.mkdirSync(project);
  const repo = path.join(project, path.basename(h.repo));
  const moved = path.join(project, path.basename(path.dirname(wt.path)), path.basename(wt.path));
  fs.renameSync(h.repo, repo);
  fs.renameSync(path.dirname(wt.path), path.dirname(moved));
  // git alone already works in the moved worktree.
  assert.equal(h.git(['rev-parse', 'HEAD'], moved), head);
  assert.equal(h.git(['status', '--porcelain'], moved), 'A  staged.txt');
  // git still names the old place, and its prune would empty the admin directory.
  assert.match(h.git(['worktree', 'list', '--porcelain'], repo), /prunable/);
  const r = run(['worktree', 'T1', '--json'], { cwd: repo, env: h.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).path, moved);
  const listing = h.git(['worktree', 'list', '--porcelain'], repo);
  assert.doesNotMatch(listing, /prunable/);
  assert.match(listing, new RegExp(`^worktree ${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(h.git(['status', '--porcelain'], moved), 'A  staged.txt', 'the index survived');
});

// Gate preparation prunes worktree registrations too, so after a move it
// relinks the relocated admin directories first, as the worktree command does.
test('gate preparation in a moved project relinks a relocated task worktree before it prunes', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Moved', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  fs.writeFileSync(path.join(wt.path, 'staged.txt'), 'staged\n');
  h.git(['add', 'staged.txt'], wt.path);
  const sha = h.git(['rev-parse', 'HEAD']);
  const project = path.join(h.base, 'moved');
  fs.mkdirSync(project);
  const repo = path.join(project, path.basename(h.repo));
  const moved = path.join(project, path.basename(path.dirname(wt.path)), path.basename(wt.path));
  fs.renameSync(h.repo, repo);
  fs.renameSync(path.dirname(wt.path), path.dirname(moved));
  assert.match(h.git(['worktree', 'list', '--porcelain'], repo), /prunable/);
  const r = await gate(h, repo, sha);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const listing = h.git(['worktree', 'list', '--porcelain'], repo);
  assert.doesNotMatch(listing, /prunable/);
  assert.match(listing, new RegExp(`^worktree ${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(h.git(['status', '--porcelain'], moved), 'A  staged.txt', 'the index survived');
});

// A relink that ran between the move of a new worktree's admin directory and
// its link would make the link first, and the creation would fail with the
// worktree left locked; both take the repository's worktree lock.
test('a gate that prepares while a task worktree is being created waits until its admin directory is linked', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Race', '--acceptance', 'not needed']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const signal = path.join(h.base, 'admin-link');
  const creating = runAsync(['worktree', 'T1', '--json'], { cwd: h.repo, pre: ['--require', HOOKS],
    env: { ...h.env, HOOK_STATE: h.state, HOOK_STOP_ADMIN_LINK: signal } });
  await fileWritten(signal);
  const pruned = path.join(h.base, 'pruned');
  const gated = gate(h, h.repo, sha, pruned);
  // Without the lock the gate relinks and prunes now; with it, it waits.
  for (const end = Date.now() + 3000; !fs.existsSync(pruned) && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); // wait-allow: give an unlocked gate time to prune before the creation is released
  fs.writeFileSync(`${signal}.go`, '');
  const [created, prepared] = await Promise.all([creating, gated]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(prepared.code, 0, prepared.stderr + prepared.stdout);
  const wt = JSON.parse(created.stdout);
  assert.equal(h.git(['rev-parse', 'HEAD'], wt.path), sha);
  assert.doesNotMatch(h.git(['worktree', 'list', '--porcelain']), /^locked/m, 'no registration is left locked');
});

// A sandboxed worker writes the repository's git directory, where Tower Crane
// 0.1.2 and earlier took the worktree lock; one it leaves there must stall
// nothing (the sandboxes' write lists: test/isolation.test.js).
test('a worktree lock planted in the git directory stalls neither relink nor gate preparation', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Planted', '--acceptance', 'not needed']);
  const planted = path.join(h.repo, '.git', 'tower-crane-worktree.lock');
  fs.mkdirSync(planted);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(JSON.parse(r.stdout).path));
  assert.match(r.stderr, /tower-crane-worktree\.lock exists; Tower Crane 0\.1\.2 and earlier take the worktree lock there/, 'an older version\'s lock is reported, not raced silently');
  assert.ok(fs.existsSync(planted), 'a lock this process did not make is left alone');
  const g = await gate(h, h.repo, h.git(['rev-parse', 'HEAD']));
  assert.equal(g.code, 0, g.stderr + g.stdout);
});

// A newer holder killed inside the lock leaves the old path with its marker,
// which the next holder clears without a notice.
test('the old lock path a killed newer holder left is cleared by its marker', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Killed', '--acceptance', 'not needed']);
  const legacy = path.join(h.repo, '.git', 'tower-crane-worktree.lock');
  const state = path.join(__dirname, '..', 'lib', 'state');
  const left = cp.spawnSync(process.execPath, ['-e', `if (!require(${JSON.stringify(state)}).mkdirMarkedLock(process.argv[1])) process.exit(1)`, legacy]);
  assert.equal(left.status, 0, String(left.stderr));
  assert.equal(fs.readdirSync(legacy).length, 1);
  const r = h.run(['worktree', 'T1', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no longer waits/);
  assert.equal(fs.existsSync(legacy), false);
});

// While a newer process holds the lock, an older one that still takes it in
// the git directory finds it held there too.
test('a worktree lock holder also holds the old lock path for older versions while it works', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Mirror', '--acceptance', 'not needed']);
  const signal = path.join(h.base, 'admin-link');
  const creating = runAsync(['worktree', 'T1', '--json'], { cwd: h.repo, pre: ['--require', HOOKS],
    env: { ...h.env, HOOK_STATE: h.state, HOOK_STOP_ADMIN_LINK: signal } });
  await fileWritten(signal);
  const legacy = path.join(h.repo, '.git', 'tower-crane-worktree.lock');
  assert.ok(fs.existsSync(legacy), 'the old path is held during the admin move');
  fs.writeFileSync(`${signal}.go`, '');
  const created = await creating;
  assert.equal(created.code, 0, created.stderr);
  assert.doesNotMatch(created.stderr, /no longer waits/);
  assert.equal(fs.existsSync(legacy), false, 'released with the lock');
});

// Removal empties the admin directory a relink writes, so cancelling a task
// waits for the lock a relink holds, and both wait on the one in the worktrees
// root, which no sandboxed agent writes.
// A marker as a live holder writes it, from this process; `extra` overrides fields.
function holdLock(lock, extra = {}) {
  const os = require('node:os');
  fs.mkdirSync(lock, { recursive: true });
  const nonce = 'a1b2c3d4e5f60718';
  let pidns = null;
  let boot = null;
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* not Linux */ }
  try { boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { /* not Linux */ }
  const file = path.join(lock, nonce);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), boot_id: boot, pidns, at: new Date().toISOString(), nonce, ...extra }));
  return { dir: lock, nonce, file };
}

// Both wait while the lock is held, then finish once it is released.
async function waitsForLock(h, held, runs) {
  const S = require('../lib/state');
  let done = 0;
  for (const p of runs) p.then(() => { done++; });
  // Without the lock they finish now; with it, they wait.
  for (const end = Date.now() + 3000; !done && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); // wait-allow: give an unlocked command time to finish before the lock is released
  const waited = done === 0;
  S.releaseMarkedLock(held);
  return { waited, results: await Promise.all(runs) };
}

test('removing a task worktree and relinking wait for the worktree lock in the state directory', async (t) => {
  const h = makeRepo(t);
  h.init();
  for (const title of ['Cancelled', 'Next']) h.ok(['task', 'add', '--title', title, '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  const lock = path.join(fs.realpathSync.native(h.state), 'worktree', 'lock');
  // This live process holds it, with its marker inside, as a gate would.
  const S = require('../lib/state');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const held = S.tryMarkedLock(lock);
  assert.ok(held);
  const cancelling = runAsync(['task', 'update', 'T1', '--status', 'cancelled'], { cwd: h.repo, env: h.env });
  const relinking = runAsync(['worktree', 'T2', '--json'], { cwd: h.repo, env: h.env });
  let done = 0;
  for (const p of [cancelling, relinking]) p.then(() => { done++; });
  // Without the lock both finish now; with it, both wait.
  for (const end = Date.now() + 3000; !done && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); // wait-allow: give an unlocked removal and relink time to finish before the lock is released
  assert.equal(done, 0, 'neither finished while the lock was held');
  assert.ok(fs.existsSync(wt.path), 'the worktree is not removed under a held lock');
  S.releaseMarkedLock(held);
  const [cancelled, relinked] = await Promise.all([cancelling, relinking]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(relinked.code, 0, relinked.stderr);
  assert.equal(fs.existsSync(wt.path), false, 'removed once the lock is free');
  assert.ok(fs.existsSync(JSON.parse(relinked.stdout).path));
  assert.equal(fs.existsSync(lock), false);
});

// macOS and Windows record no start time, and a long gate add or remove can
// hold the lock past 60 s: a live holder on this host keeps it whatever its age.
test('a live holder keeps the worktree lock past 60 s without a start time', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Old holder', '--acceptance', 'not needed']);
  const held = holdLock(path.join(fs.realpathSync.native(h.state), 'worktree', 'lock'));
  const old = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(held.file, old, old);
  const { waited, results: [r] } = await waitsForLock(h, held, [runAsync(['worktree', 'T1', '--json'], { cwd: h.repo, env: h.env })]);
  assert.ok(waited, 'a live holder without a start time is not taken over');
  assert.equal(r.code, 0, r.stderr);
});

// A holder in another pid namespace cannot be judged by its pid: it keeps the
// lock while it touches its marker, and loses it 60 s after it stops.
test('a holder in another pid namespace keeps the worktree lock only while it refreshes its marker', (t) => {
  const h = makeRepo(t);
  const S = require('../lib/state');
  const lock = path.join(h.base, 'locks', 'lock');
  const held = holdLock(lock, { pidns: 'pid:[1]', pid: 1 });
  assert.equal(S.tryMarkedLock(lock, { keepLive: true }), null, 'a fresh marker is kept');
  const old = new Date(Date.now() - 2 * 60000);
  fs.utimesSync(held.file, old, old);
  S.refreshMarkedLock(held);
  assert.equal(S.tryMarkedLock(lock, { keepLive: true }), null, 'a refreshed marker is kept');
  fs.utimesSync(held.file, old, old);
  // One attempt clears the stale marker; the next takes the lock.
  const taken = S.tryMarkedLock(lock, { keepLive: true }) || S.tryMarkedLock(lock, { keepLive: true });
  assert.ok(taken, 'one that stopped refreshing is taken over');
  S.releaseMarkedLock(taken);
});

// A gate in a project without task worktrees needs no worktrees root, and the
// repository's parent may not be writable (a container with the repo at /app).
test('gate preparation creates no worktrees root and runs when the repository\'s parent is read-only', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'permission bits do not bind' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = h.git(['rev-parse', 'HEAD']);
  const first = await gate(h, h.repo, sha);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert.equal(fs.existsSync(path.join(h.base, 'repo-worktrees')), false, 'no worktrees root beside the repository');
  fs.chmodSync(h.base, 0o555);
  let again;
  try { again = await gate(h, h.repo, sha); } finally { fs.chmodSync(h.base, 0o755); }
  assert.equal(again.code, 0, again.stderr + again.stdout);
});

// A submodule's git directory is in the superproject's, which the
// superproject's workers write; the lock is in the project's state directory.
test('a project in a submodule takes the worktree lock in its state directory, not in the superproject\'s git directory', async (t) => {
  const h = makeRepo(t);
  const sub = path.join(h.base, 'sub-origin');
  h.git(['init', '-q', '-b', 'main', sub]);
  h.git(['commit', '-q', '--allow-empty', '-m', 'sub'], sub);
  h.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub']);
  h.git(['commit', '-q', '-m', 'add sub']);
  const cwd = path.join(h.repo, 'sub');
  const state = path.join(h.base, 'sub-state');
  const env = { ...h.env, TOWER_CRANE_STATE: state };
  const ok = (args) => { const r = run(args, { cwd, env }); assert.equal(r.code, 0, r.stderr); return r; };
  ok(['init', '--name', 'sub', '--goal', 'g']);
  ok(['task', 'add', '--title', 'In sub', '--acceptance', 'not needed']);
  const S = require('../lib/state');
  const lock = path.join(fs.realpathSync.native(state), 'worktree', 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const held = S.tryMarkedLock(lock);
  assert.ok(held);
  const { waited, results: [r] } = await waitsForLock(h, held, [runAsync(['worktree', 'T1', '--json'], { cwd, env })]);
  assert.ok(waited, 'the relink waits for the lock in the state directory');
  assert.equal(r.code, 0, r.stderr);
  const superGit = path.join(h.repo, '.git');
  const found = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith('tower-crane-worktree')) found.push(path.join(dir, e.name)); else if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name)); } };
  walk(superGit);
  assert.deepEqual(found, [], 'no lock under the superproject\'s git directory');
});

// Only a directory already at the old path is an older holder's; a git
// directory that refuses the mkdir is not.
test('the old lock path notice needs a directory there, not another mkdir failure', (t) => {
  const W = require('../lib/worktree');
  const h = makeRepo(t);
  const missing = path.join(h.base, 'no-such-git-dir');
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return true; };
  let held;
  try { held = W.legacyHold(missing); } finally { process.stderr.write = write; }
  assert.equal(held, null);
  assert.deepEqual(written.filter((w) => /no longer waits/.test(w)), []);
});

// `p/r` and `p/r.git` share `p/r-worktrees`, so a relink from one must leave
// the other's relocated admin directories alone.
test('a repository that shares the worktrees root does not relink the other repository\'s task worktrees', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, (t) => {
  const h = makeRepo(t);
  h.init();
  const other = path.join(h.base, `${path.basename(h.repo)}.git`);
  fs.cpSync(h.repo, other, { recursive: true });
  h.ok(['task', 'add', '--title', 'Mine', '--acceptance', 'not needed']);
  const mine = h.json(['worktree', 'T1']);
  const common = fs.realpathSync.native(path.join(h.repo, '.git'));
  const admin = path.join(path.dirname(mine.path), '.git-admin', path.basename(mine.path));
  const commondir = fs.readFileSync(path.join(admin, 'commondir'), 'utf8');
  assert.ok(run(['task', 'add', '--title', 'Theirs', '--acceptance', 'not needed'], { cwd: other, env: h.env }).code === 0);
  const r = run(['worktree', 'T1', '--json'], { cwd: other, env: h.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(path.dirname(JSON.parse(r.stdout).path), path.dirname(mine.path), 'both repositories use one worktrees root');
  assert.equal(fs.readFileSync(path.join(admin, 'commondir'), 'utf8'), commondir);
  assert.equal(fs.lstatSync(path.join(other, '.git', 'worktrees', path.basename(mine.path)), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.realpathSync.native(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], mine.path)), common);
  assert.ok(h.registers(mine.path));
});

test('cancelling keeps a worktree that git still has locked', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Locked', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  h.git(['worktree', 'lock', '--reason', 'tower-crane: creating worktree', wt.path]);

  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);

  assert.ok(fs.existsSync(wt.path), 'the locked worktree stays');
  assert.ok(h.registers(wt.path), 'git still registers it');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'worktree is locked');
});

test('cancelling keeps a worktree while its worker process is still running', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const title of ['Live', 'Exited']) h.ok(['task', 'add', '--title', title, '--acceptance', 'not needed']);
  const live = h.json(['worktree', 'T1']);
  const exited = h.json(['worktree', 'T2']);
  // This test process is alive; 999999 is a pid that has exited.
  for (const [task, pid] of [['T1', process.pid], ['T2', 999999]]) {
    StateFiles.appendLog(h.state, `${JSON.stringify({
      at: new Date().toISOString(), agent: 'orchestrator', cmd: 'spawn', task,
      detail: { agent: 'w-1', role: 'worker', rung: 'easy', pid, attempt: 1 },
    })}\n`);
  }

  for (const id of ['T1', 'T2']) h.ok(['task', 'update', id, '--status', 'cancelled']);

  assert.ok(fs.existsSync(live.path), 'the worktree of a running worker stays');
  assert.ok(!fs.existsSync(exited.path), 'the worktree of an exited worker is removed');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'an agent is still running on the task');
});

test('cancelling keeps a worktree while the monitor of an exited reviewer still runs', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Reviewed', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  const at = new Date().toISOString();
  // The reviewer process has exited; its monitor, this test's parent, is alive and runs in the worktree.
  const detail = { agent: 'r-1', role: 'reviewer', rung: 'review', pid: 999999, attempt: 1 };
  StateFiles.appendLog(h.state, [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail },
    { at, agent: 'orchestrator', cmd: 'spawn phase', task: 'T1', detail: { ...detail, phase: 'running', monitor_pid: process.ppid, active: true } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));

  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);

  assert.ok(fs.existsSync(wt.path), 'the worktree stays while its monitor runs');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'an agent is still running on the task');
});

test('cancelling does not remove a checkout that a symlink moves outside the worktrees root', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Linked', '--acceptance', 'not needed']);
  const wt = h.json(['worktree', 'T1']);
  // The registered path still reads as inside the root, but its parent is a
  // link to a directory elsewhere, so the checkout really lives outside.
  const pool = path.join(h.base, 'repo-worktrees', 'pool');
  const outside = path.join(h.base, 'outside');
  fs.mkdirSync(pool, { recursive: true });
  h.git(['worktree', 'move', wt.path, path.join(pool, path.basename(wt.path))]);
  fs.mkdirSync(outside);
  fs.renameSync(pool, path.join(outside, 'pool'));
  // A junction needs no privilege on Windows; POSIX ignores the type.
  fs.symlinkSync(path.join(outside, 'pool'), pool, 'junction');

  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);

  const checkout = path.join(outside, 'pool', path.basename(wt.path));
  assert.ok(fs.existsSync(checkout), 'the checkout outside the worktrees root stays');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'its real location is not under the worktrees root');
});

// Only wait passes a signal. Without one nothing can stop the fetch, so base
// resolution keeps the blocking run and skips treeExec's process-tree scan.
test('base resolution runs git through treeExec only when a signal can stop it', async (t) => {
  const h = setup(t);
  const moved = advance(h, h.upstream, 'moved.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const W = require('../lib/worktree');
  const tree = t.mock.method(require('../lib/gates/common'), 'treeExec');
  assert.equal(await W.resolveBaseAsync({ root: h.repo }, 'main'), moved);
  assert.equal(tree.mock.callCount(), 0, 'outside wait the fetch runs blocking');
  assert.equal(await W.resolveBaseAsync({ root: h.repo }, 'main', new AbortController().signal), moved);
  assert.ok(tree.mock.callCount() > 0, 'inside wait the fetch can be stopped');
});
