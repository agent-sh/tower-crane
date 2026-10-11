'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, makeRepo } = require('./helpers');

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
  if (${recovered}) cp.execFileSync('git', ['-c', 'remote.origin.uploadpack=git-upload-pack',
    'fetch', '--no-tags', '--no-write-fetch-head', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
    { cwd: ${JSON.stringify(h.repo)}, stdio: 'pipe' });
  process.stderr.write('fatal: unpack-objects failed\\n');
  process.exit(1);
}
const r = cp.spawnSync('git-upload-pack', process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    h.git(['config', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
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
  h.git(['config', 'remote.origin.uploadpack', `${quote(process.execPath)} ${quote(uploadPack)}`]);
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
  const script = path.join(h.repo, '.git', 'hooks', 'post-checkout');
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
  h.ok(['submit', 'T1', '--sha', second, '--agent', 'w-2']);
  h.ok(['rework', 'T1', '--reason', 'revise the second head', '--agent', 'owner']);

  h.git(['worktree', 'remove', '--force', wt.path]);
  h.git(['branch', '-D', wt.branch]);
  const again = h.json(['worktree', 'T1']);
  assert.equal(again.created, true);
  assert.equal(h.git(['rev-parse', 'HEAD'], again.path), second);
});

test('cancelling a task removes its worktree; a dirty one stays and says why', (t) => {
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
  assert.ok(fs.existsSync(dirty.path), 'the dirty worktree stays');
  assert.ok(h.registers(dirty.path), 'git still registers the dirty worktree');
  assert.ok(!h.registers(clean.path), 'git forgets the removed worktree');
  assert.ok(!h.registers(gone.path), 'prune clears the registration of a missing directory');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T2');
  assert.equal(kept.detail.reason, 'uncommitted changes');
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
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
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
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), agent: 'orchestrator', cmd: 'spawn', task,
      detail: { agent: 'w-1', role: 'worker', rung: 'easy', pid, attempt: 1 },
    })}\n`);
  }

  for (const id of ['T1', 'T2']) h.ok(['task', 'update', id, '--status', 'cancelled']);

  assert.ok(fs.existsSync(live.path), 'the worktree of a running worker stays');
  assert.ok(!fs.existsSync(exited.path), 'the worktree of an exited worker is removed');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
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
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail },
    { at, agent: 'orchestrator', cmd: 'spawn phase', task: 'T1', detail: { ...detail, phase: 'running', monitor_pid: process.ppid, active: true } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));

  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);

  assert.ok(fs.existsSync(wt.path), 'the worktree stays while its monitor runs');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
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
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const kept = events.find((e) => e.cmd === 'worktree kept');
  assert.equal(kept.task, 'T1');
  assert.equal(kept.detail.reason, 'its real location is not under the worktrees root');
});
