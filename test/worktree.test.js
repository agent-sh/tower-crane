'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');

// A task, a bare origin and a clone of it standing in for another machine;
// built once per process for each base and copied for each test.
function setup(t, base = 'main') {
  return cachedFixture(t, base, (h) => {
    if (base !== 'main') h.git(['branch', base]);
    h.init(['--base', base]);
    h.ok(['task', 'add', '--title', 'Fresh base', '--acceptance', 'starts from the freshest base']);
    const origin = path.join(h.base, 'origin.git');
    h.git(['init', '--bare', '-q', origin]);
    h.git(['remote', 'add', 'origin', origin]);
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
    assert.equal(h.git(['for-each-ref', '--format=%(upstream)', `refs/heads/${wt.branch}`]), '');
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
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
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
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /base branch missing is not in this repository/);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.equal(h.git(['branch', '--list', 'tower-crane/*']), '');
});

test('worktree refuses a locked tracking ref that does not match the origin tip', (t) => {
  const h = setup(t);
  const stale = h.git(['rev-parse', 'origin/main']);
  advance(h, h.upstream, 'remote.txt');
  h.git(['push', 'origin', 'main'], h.upstream);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  fs.writeFileSync(path.join(h.repo, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');

  const r = h.run(['worktree', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git fetch origin main failed/);
  assert.equal(h.git(['rev-parse', 'origin/main']), stale);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
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
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const result = h.run(['worktree', 'T1', '--json']);
    if (recovered) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(h.git(['rev-parse', 'HEAD'], JSON.parse(result.stdout).path), fresh);
      assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
    } else {
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /git fetch origin main failed/);
      assert.equal(h.git(['rev-parse', 'origin/main']), stale);
      assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
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
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const attempts = path.join(h.base, 'fetch-attempts');
    const r = h.run(['worktree', 'T1'], {
      hooks: { HOOK_FETCH_ERROR: error, HOOK_FETCH_ALWAYS: '1', HOOK_FETCH_ATTEMPTS: attempts },
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /git fetch origin main failed/);
    assert.equal(fs.readFileSync(attempts, 'utf8'), error.includes('unpack-objects') ? '.' : '..');
    assert.equal(h.json(['task', 'show', 'T1']).branch, null);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delay});
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
  test(`one dispatch prepares six ${command} tasks from one slow base fetch`, { timeout: 60000 }, async (t) => {
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
    const started = Date.now();
    const hooks = { HOOK_WORKTREE_ADD_ACTIVE: path.join(h.base, 'worktree-add-active') };
    const trees = h.json(['worktree', ...ids], { hooks });
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
      for (const r of results) assert.equal(h.git(['rev-parse', 'HEAD'], JSON.parse(r.stdout).cwd), fresh);
    }
    assert.equal(h.git(['rev-parse', 'origin/main']), fresh);
    assert.equal(fs.readFileSync(attempts, 'utf8'), '.', 'the dispatcher fetched once before preparing workers');
    assert.ok(Date.now() - started < 30000, 'the dispatch finishes within two fetch times');
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
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const r = h.run(['worktree', 'T1'], { hooks });
    assert.notEqual(r.code, 0, r.stderr);
    const retry = h.run(['worktree', 'T1']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /worktree.*unfinished/);
    assert.match(retry.stderr, /git worktree unlock <path>/);
    assert.match(retry.stderr, /git worktree remove --force <path>/);
    assert.equal(h.json(['task', 'show', 'T1']).branch, null);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
    const dir = path.join(h.base, 'repo-worktrees', 'T1-fresh-base');
    assert.equal(h.git(['status', '--porcelain'], dir), '');
    h.git(['worktree', 'unlock', dir]);
    assert.equal(h.json(['worktree', 'T1']).created, false, 'an inspected, complete worktree can be reused');
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `${file} appeared before the deadline`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a surviving post-checkout child cannot write into a replacement worktree', { timeout: 30000 }, async (t) => {
  const h = setup(t);
  const paused = path.join(h.base, 'hook-paused');
  const done = path.join(h.base, 'hook-done');
  const cliPid = path.join(h.base, 'cli-pid');
  const hook = path.join(h.base, 'post-checkout.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const end = Date.now() + 20000;
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
  const first = h.runAsync(['worktree', 'T1'], { hooks: { HOOK_ADD_PID: cliPid } });
  try {
    await waitForFile(paused);
    process.kill(Number(fs.readFileSync(cliPid, 'utf8')), 'SIGKILL');
    assert.notEqual((await first).code, 0);
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
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (let i = 0; i < 2; i++) {
    const retry = h.run(['worktree', 'T1']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /unfinished|incomplete|exists and is not a worktree/);
  }
  assert.ok(fs.existsSync(path.join(admin, 'locked')));
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
});
