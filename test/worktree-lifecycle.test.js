'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { fileWritten, killPid } = require('./signals');

function setup(t, accepted = false) {
  return cachedFixture(t, accepted ? 'accepted' : 'tasks', (h) => {
    let sha;
    if (accepted) { sha = gateFixture(h); h.git(['switch', '-q', 'main']); }
    h.init(accepted ? ['--repo', 'acme/demo'] : []);
    h.ok(['task', 'add', '--title', 'Retire', '--acceptance', 'worktree lifecycle']);
    h.ok(['task', 'add', '--title', 'Continue', '--acceptance', 'preserve live work']);
    if (accepted) {
      h.ok(['claim', 'T1', '--agent', 'worker']);
      h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--pr', '9', '--agent', 'worker']);
      for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
      h.reviewer('T1', 'reviewer', sha);
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
      h.ok(['accept', 'T1']);
    }
  });
}

function gone(h, wt) {
  assert.equal(fs.existsSync(wt.path), false, 'checkout removed');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).includes(wt.path), false, 'Git registration removed');
  assert.equal(h.git(['branch', '--list', wt.branch]), '', 'local branch removed');
}

for (const action of ['merge', 'cancel', 'supersede']) {
  test(`${action} removes the task worktree and local branch in the same command`, (t) => {
    const h = setup(t, action === 'merge');
    const wt = h.json(['worktree', 'T1']);
    if (action === 'merge') h.ok(['merge', 'T1', '--agent', 'orchestrator']);
    else h.ok(['task', 'update', 'T1', ...(action === 'cancel' ? ['--status', 'cancelled'] : ['--superseded-by', 'T2'])]);
    gone(h, wt);
    if (action === 'supersede') {
      assert.equal(h.json(['task', 'show', 'T1']).superseded_by, 'T2');
      assert.match(h.ok(['task', 'show', 'T1']), /superseded by: T2/);
      assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /superseded by.*href="#T2"/);
    }
    assert.equal(h.json(['task', 'show', 'T1']).worktree.state, 'removed');
  });
}

test('cancel saves tracked, staged, untracked and ignored work before removal, ignoring an absent sandbox mask', (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, '.mcp.json'), '{}\n');
  fs.writeFileSync(path.join(h.repo, '.gitignore'), 'ignored/\n');
  h.git(['add', '.mcp.json', '.gitignore']);
  h.git(['commit', '-qm', 'config']);
  const wt = h.json(['worktree', 'T1']);
  fs.unlinkSync(path.join(wt.path, '.mcp.json'));
  fs.writeFileSync(path.join(wt.path, '.gitignore'), 'ignored/\ncache/\n');
  h.git(['add', '.gitignore'], wt.path);
  fs.writeFileSync(path.join(wt.path, '.gitignore'), 'ignored/\ncache/\nmore/\n');
  fs.mkdirSync(path.join(wt.path, 'research'));
  fs.writeFileSync(path.join(wt.path, 'research', 'notes.txt'), 'recover this\n');
  fs.mkdirSync(path.join(wt.path, 'ignored'));
  fs.writeFileSync(path.join(wt.path, 'ignored', 'data.bin'), Buffer.from([0, 255, 1]));
  const result = h.run(['task', 'update', 'T1', '--status', 'cancelled']);
  assert.equal(result.code, 0, result.stderr);
  const saved = h.json(['task', 'show', 'T1']).worktree.saved;
  assert.ok(saved.startsWith(path.join(h.state, 'worktree-saves')));
  assert.ok(result.stderr.includes(saved), 'save path printed');
  assert.match(fs.readFileSync(path.join(saved, 'tracked.patch'), 'utf8'), /cache\/|more\//);
  assert.equal(fs.readFileSync(path.join(saved, 'files', 'research', 'notes.txt'), 'utf8'), 'recover this\n');
  assert.deepEqual(fs.readFileSync(path.join(saved, 'files', 'ignored', 'data.bin')), Buffer.from([0, 255, 1]));
  gone(h, wt);
});

test('failed retirement appears in list, board and inbox; dry-run preserves it and prune retries it', (t) => {
  const h = setup(t);
  const wt = h.json(['worktree', 'T1']);
  const record = h.json(['task', 'show', 'T1']).worktree;
  assert.equal(record.path, wt.path);
  assert.equal(record.branch, wt.branch);
  assert.equal(record.base, 'main');
  assert.ok(Date.parse(record.created_at));
  assert.equal(record.head, h.git(['rev-parse', 'HEAD'], wt.path));
  h.git(['worktree', 'lock', '--reason', 'held', wt.path]);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const list = h.json(['worktree', 'list']);
  assert.equal(list.counts.stale, 1);
  assert.match(list.worktrees[0].reason, /locked/);
  const inbox = h.json(['inbox', '--agent', 'orchestrator']);
  assert.equal(inbox.worktrees.counts.stale, 1);
  const item = inbox.items.find((i) => i.kind === 'worktree_stale');
  assert.equal(item.path, wt.path);
  assert.deepEqual(item.action.argv, ['worktree', 'prune']);
  assert.ok(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8').includes(wt.path));
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /1 stale, 0 orphan/);
  const board = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(board, /Worktrees: 1 stale, 0 orphan/);
  assert.match(board, /data-region="worktrees"/);
  h.git(['worktree', 'unlock', wt.path]);
  assert.ok(h.ok(['worktree', 'prune', '--dry-run']).includes(wt.path));
  assert.ok(fs.existsSync(wt.path));
  h.ok(['worktree', 'prune']);
  gone(h, wt);
  const cleaned = fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8');
  assert.match(cleaned, /data-region="worktrees"/);
  assert.doesNotMatch(cleaned, /Worktrees: 1 stale/);
  assert.equal(h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.kind === 'worktree_stale'), false);
});

test('prune keeps accepted but unmerged, rework and interrupted dirty trees, and requires --orphans', (t) => {
  const h = setup(t, true);
  const accepted = h.json(['worktree', 'T1']);
  const rework = h.json(['worktree', 'T2']);
  h.ok(['claim', 'T2', '--agent', 'worker2']);
  h.ok(['submit', 'T2', '--sha', h.git(['rev-parse', 'HEAD'], rework.path), '--agent', 'worker2']);
  h.ok(['rework', 'T2', '--reason', 'continue editing']);
  fs.writeFileSync(path.join(rework.path, 'dirty.txt'), 'resume me');
  h.ok(['task', 'add', '--title', 'Interrupted', '--acceptance', 'resume']);
  const interrupted = h.json(['worktree', 'T3']);
  h.ok(['claim', 'T3', '--agent', 'worker3']);
  fs.writeFileSync(path.join(interrupted.path, 'dirty.txt'), 'resume too');
  h.ok(['interrupt', 'T3']);
  const orphan = path.join(h.base, 'repo-worktrees', 'orphan');
  h.git(['worktree', 'add', '-b', 'unrecorded', orphan, 'main']);
  const outside = path.join(h.base, 'outside');
  h.git(['worktree', 'add', '-b', 'external', outside, 'main']);
  const list = h.json(['worktree', 'list']);
  assert.equal(list.counts.live, 3);
  assert.equal(list.counts.orphan, 1);
  assert.ok(!list.worktrees.some((w) => w.path === outside));
  h.ok(['worktree', 'prune']);
  assert.ok(fs.existsSync(orphan));
  h.ok(['worktree', 'prune', '--orphans']);
  gone(h, { path: orphan, branch: 'unrecorded' });
  for (const wt of [accepted, rework, interrupted]) assert.ok(fs.existsSync(wt.path));
  assert.equal(fs.readFileSync(path.join(rework.path, 'dirty.txt'), 'utf8'), 'resume me');
  assert.ok(fs.existsSync(outside));
});

test('a cancelled worker gets an exit notice from tool and inbox hooks without a queued message', (t) => {
  const h = setup(t);
  const home = path.join(h.state, 'homes', 'worker');
  fs.mkdirSync(home, { recursive: true });
  const binding = path.join(home, 'hook.json');
  fs.writeFileSync(binding, JSON.stringify({ agent: 'worker', task: 'T1', state: h.state, role: 'worker', harness: 'command', attempt: 1 }));
  h.ok(['task', 'update', 'T1', '--superseded-by', 'T2']);
  for (const action of ['tool', 'inbox', 'stop']) {
    const result = h.json(['hook', action, '--binding', binding, '--agent', 'worker']);
    assert.equal(result.exit, true);
    assert.match(result.context, /superseded by T2.*Exit now/);
    assert.equal(result.block, false, 'a stale worker is never held for more work');
  }
});

test('the supervisor stops a cancelled worker and then removes its worktree', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const ready = path.join(h.base, 'worker-ready');
  const script = path.join(h.base, 'worker.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'wait for cancellation\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, script, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const wt = h.json(['worktree', 'T1']);
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait']);
  await fileWritten(ready);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const result = await run;
  assert.match(result.stderr, /stale/);
  gone(h, wt);
});

test('prune adopts a legacy merged-task branch record and removes it without touching live work', (t) => {
  const h = setup(t, true);
  const wt = h.json(['worktree', 'T1']);
  const live = h.json(['worktree', 'T2']);
  h.git(['worktree', 'lock', wt.path]);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const state = h.readState('tasks.json');
  delete state.tasks.find((task) => task.id === 'T1').worktree;
  h.writeState('tasks.json', state);
  h.git(['worktree', 'unlock', wt.path]);
  const list = h.json(['worktree', 'list']);
  assert.equal(list.counts.stale, 1);
  assert.equal(list.counts.live, 1);
  h.ok(['worktree', 'prune']);
  gone(h, wt);
  assert.ok(fs.existsSync(live.path));
});

for (const failure of ['remove', 'branch']) {
  test(`${failure} failure stays actionable in inbox until prune succeeds`, (t) => {
    const h = setup(t);
    const wt = h.json(['worktree', 'T1']);
    fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'keep after failure');
    const preload = path.join(h.base, 'fail-git.js');
    fs.writeFileSync(preload, `
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(command, args, ...rest) {
  if (command === 'git' && ${failure === 'remove' ? "args[0] === 'worktree' && args[1] === 'remove'" : "args[0] === 'branch' && args[1] === '-D'"}) {
    const error = new Error('EROFS: read-only filesystem');
    error.stderr = 'EROFS: read-only filesystem';
    throw error;
  }
  return original.call(this, command, args, ...rest);
};
`);
    h.json(['task', 'update', 'T1', '--status', 'cancelled'], { env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } });
    const record = h.json(['task', 'show', 'T1']).worktree;
    assert.equal(record.state, 'stale');
    assert.match(record.reason, /EROFS/);
    assert.equal(fs.readFileSync(path.join(record.saved, 'files', 'notes.txt'), 'utf8'), 'keep after failure');
    const inbox = h.json(['inbox', '--agent', 'orchestrator']);
    assert.match(inbox.items.find((i) => i.kind === 'worktree_stale').reason, /EROFS/);
    assert.equal(fs.existsSync(wt.path), failure === 'remove');
    h.ok(['worktree', 'prune']);
    gone(h, wt);
    assert.equal(h.json(['worktree', 'list']).counts.stale, 0);
  });
}

for (const action of ['cancel', 'supersede']) {
  test(`${action} saves committed local work in a restorable bundle before deleting the branch`, (t) => {
    const h = setup(t);
    const wt = h.json(['worktree', 'T1']);
    fs.writeFileSync(path.join(wt.path, 'committed.txt'), 'local commit without a remote\n');
    h.git(['add', 'committed.txt'], wt.path);
    h.git(['commit', '-qm', 'local work'], wt.path);
    const sha = h.git(['rev-parse', 'HEAD'], wt.path);
    h.ok(['task', 'update', 'T1', ...(action === 'cancel' ? ['--status', 'cancelled'] : ['--superseded-by', 'T2'])]);
    gone(h, wt);
    const saved = h.json(['task', 'show', 'T1']).worktree.saved;
    const bundle = path.join(saved, 'commits.bundle');
    h.git(['fetch', bundle, `HEAD:refs/heads/recovered-${action}`]);
    assert.equal(h.git(['rev-parse', `recovered-${action}`]), sha);
    assert.equal(h.git(['show', `recovered-${action}:committed.txt`]), 'local commit without a remote');
  });
}

test('retirement saves an ignored-file list and a binary patch larger than Git child output limits', { timeout: 300000 }, (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(h.repo, 'payload.bin'), Buffer.alloc(1));
  h.git(['add', '.gitignore', 'payload.bin']);
  h.git(['commit', '-qm', 'binary baseline']);
  const wt = h.json(['worktree', 'T1']);
  const payload = require('node:crypto').randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(wt.path, 'payload.bin'), payload);
  const ignored = path.join(wt.path, 'node_modules');
  fs.mkdirSync(ignored);
  const name = (i) => 'x'.repeat(135) + String(i).padStart(5, '0') + '.bin';
  for (let i = 0; i < 8000; i++) fs.writeFileSync(path.join(ignored, name(i)), `artifact ${i}`);
  assert.ok(8000 * ('node_modules/'.length + name(0).length + 1) > 1024 * 1024);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  gone(h, wt);
  const saved = h.json(['task', 'show', 'T1']).worktree.saved;
  assert.ok(fs.statSync(path.join(saved, 'tracked.patch')).size > 1024 * 1024);
  const copies = path.join(saved, 'files', 'node_modules');
  assert.equal(fs.readdirSync(copies).length, 8000);
  assert.equal(fs.readFileSync(path.join(copies, name(7999)), 'utf8'), 'artifact 7999');
  h.git(['apply', '--binary', path.join(saved, 'tracked.patch')]);
  assert.deepEqual(fs.readFileSync(path.join(h.repo, 'payload.bin')), payload);
});

test('cancel preserves local commits even when the checkout was already removed', (t) => {
  const h = setup(t);
  const wt = h.json(['worktree', 'T1']);
  fs.writeFileSync(path.join(wt.path, 'committed.txt'), 'recover a missing checkout\n');
  h.git(['add', 'committed.txt'], wt.path);
  h.git(['commit', '-qm', 'local work'], wt.path);
  const head = h.git(['rev-parse', 'HEAD'], wt.path);
  h.git(['worktree', 'remove', wt.path]);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const record = h.json(['task', 'show', 'T1']).worktree;
  assert.equal(record.head, head);
  const saved = record.saved;
  h.git(['fetch', path.join(saved, 'commits.bundle'), `refs/heads/${wt.branch}:refs/heads/recovered`]);
  assert.equal(h.git(['show', 'recovered:committed.txt']), 'recover a missing checkout');
  gone(h, wt);
});

test('prune and repeated cancellation preserve a live task that reuses a retired branch', (t) => {
  const h = setup(t);
  const old = h.json(['worktree', 'T1']);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  h.ok(['claim', 'T2', '--agent', 'worker2']);
  h.ok(['submit', 'T2', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', old.branch, '--agent', 'worker2']);
  h.ok(['rework', 'T2', '--reason', 'reuse the available branch']);
  const live = h.json(['worktree', 'T2']);
  fs.writeFileSync(path.join(live.path, 'dirty.txt'), 'keep the live replacement');
  h.ok(['worktree', 'prune']);
  assert.ok(fs.existsSync(live.path), 'prune preserves the new task checkout');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  assert.equal(fs.readFileSync(path.join(live.path, 'dirty.txt'), 'utf8'), 'keep the live replacement');
  assert.equal(h.json(['worktree', 'list']).worktrees[0].task, 'T2');
  assert.ok(h.git(['branch', '--list', live.branch]));
});

test('cancel saves a dirty initialized submodule before removing its worktree', (t) => {
  const h = setup(t);
  const source = path.join(h.base, 'module-source');
  fs.mkdirSync(source);
  h.git(['init', '-q', '-b', 'main'], source);
  fs.writeFileSync(path.join(source, 'value.txt'), 'base\n');
  h.git(['add', '.'], source);
  h.git(['commit', '-qm', 'module base'], source);
  h.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module']);
  h.git(['commit', '-qm', 'add module']);
  const wt = h.json(['worktree', 'T1']);
  h.git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'], wt.path);
  const child = path.join(wt.path, 'module');
  fs.writeFileSync(path.join(child, 'value.txt'), 'module commit\n');
  h.git(['add', '.'], child);
  h.git(['commit', '-qm', 'local module commit'], child);
  const head = h.git(['rev-parse', 'HEAD'], child);
  fs.writeFileSync(path.join(child, 'value.txt'), 'dirty module\n');
  fs.writeFileSync(path.join(child, 'notes.txt'), 'module notes\n');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const saved = h.json(['task', 'show', 'T1']).worktree.saved;
  const manifest = JSON.parse(fs.readFileSync(path.join(saved, 'manifest.json'), 'utf8'));
  assert.equal(manifest.submodules.length, 1);
  const recovered = manifest.submodules[0].saved;
  assert.equal(fs.readFileSync(path.join(recovered, 'files', 'notes.txt'), 'utf8'), 'module notes\n');
  assert.match(fs.readFileSync(path.join(recovered, 'tracked.patch'), 'utf8'), /dirty module/);
  assert.ok(h.git(['bundle', 'list-heads', path.join(recovered, 'commits.bundle')]).includes(head));
  gone(h, wt);
});

for (const priorBundle of [false, true]) {
  test(`prune saves the current retained branch head after an earlier save (bundle: ${priorBundle})`, (t) => {
    const h = setup(t);
    const wt = h.json(['worktree', 'T1']);
    if (priorBundle) {
      fs.writeFileSync(path.join(wt.path, 'original.txt'), 'original commit\n');
      h.git(['add', 'original.txt'], wt.path);
      h.git(['commit', '-qm', 'original work'], wt.path);
    }
    fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'original dirty notes\n');
    const preload = path.join(h.base, 'fail-delete.js');
    fs.writeFileSync(preload, `
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(command, args, ...rest) {
  if (command === 'git' && args[0] === 'branch' && args[1] === '-D') {
    const error = new Error('temporary branch deletion failure');
    error.stderr = error.message;
    throw error;
  }
  return original.call(this, command, args, ...rest);
};
`);
    h.ok(['task', 'update', 'T1', '--status', 'cancelled'], { env: { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` } });
    const earlier = h.json(['task', 'show', 'T1']).worktree.saved;
    const previous = JSON.parse(fs.readFileSync(path.join(earlier, 'manifest.json'), 'utf8'));
    assert.equal(!!previous.bundle, priorBundle);
    const scratch = path.join(h.base, 'later-checkout');
    h.git(['worktree', 'add', scratch, wt.branch]);
    fs.writeFileSync(path.join(scratch, 'newer.txt'), 'newer local commit\n');
    h.git(['add', 'newer.txt'], scratch);
    h.git(['commit', '-qm', 'newer local work'], scratch);
    const head = h.git(['rev-parse', 'HEAD'], scratch);
    h.git(['worktree', 'remove', scratch]);
    h.ok(['worktree', 'prune']);
    const record = h.json(['task', 'show', 'T1']).worktree;
    const manifest = JSON.parse(fs.readFileSync(path.join(record.saved, 'manifest.json'), 'utf8'));
    assert.ok(manifest.bundle, 'the current recovery contains a bundle');
    h.git(['fetch', path.join(record.saved, manifest.bundle), `refs/heads/${wt.branch}:refs/heads/recovered-newer`]);
    assert.equal(h.git(['rev-parse', 'recovered-newer']), head);
    assert.equal(h.git(['show', 'recovered-newer:newer.txt']), 'newer local commit');
    assert.equal(fs.readFileSync(path.join(earlier, 'files', 'notes.txt'), 'utf8'), 'original dirty notes\n');
    assert.equal(manifest.previous, earlier, 'the previous dirty save remains discoverable');
    gone(h, wt);
  });
}

test('cancellation rechecks a replacement owner while reserving removal', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = h.json(['worktree', 'T1']);
  const paused = path.join(h.base, 'cancel-paused');
  const cancel = h.runAsync(['task', 'update', 'T1', '--status', 'cancelled'], { hooks: { HOOK_STOP_WORKTREE_STATUS: paused } });
  try {
    await fileWritten(paused);
    h.ok(['claim', 'T2', '--agent', 'replacement']);
    h.ok(['submit', 'T2', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'replacement']);
    h.ok(['rework', 'T2', '--reason', 'continue in the existing branch']);
    const live = h.json(['worktree', 'T2']);
    fs.writeFileSync(path.join(live.path, 'replacement.txt'), 'live replacement work\n');
    assert.equal(h.json(['worktree', 'list']).worktrees[0].task, 'T2');
    fs.writeFileSync(`${paused}.go`, '');
    const result = await cancel;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(live.path, 'replacement.txt'), 'utf8'), 'live replacement work\n');
    assert.ok(h.git(['branch', '--list', wt.branch]));
    assert.equal(h.json(['worktree', 'list']).worktrees[0].state, 'live');
    h.ok(['worktree', 'prune']);
    assert.ok(fs.existsSync(live.path));
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await cancel;
  }
});

test('a removal reservation blocks assigning its branch to another task', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = h.json(['worktree', 'T1']);
  h.ok(['claim', 'T2', '--agent', 'replacement']);
  const paused = path.join(h.base, 'remove-paused');
  const cancel = h.runAsync(['task', 'update', 'T1', '--status', 'cancelled'], { hooks: { HOOK_STOP_WORKTREE_REMOVE: paused } });
  try {
    await fileWritten(paused);
    const assigned = h.run(['submit', 'T2', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'replacement']);
    assert.equal(assigned.code, 1, 'a retiring branch cannot become a live replacement');
    assert.match(assigned.stderr, /being removed|retiring/);
    assert.equal(h.json(['task', 'show', 'T2']).status, 'in_progress');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await cancel;
  }
  gone(h, wt);
});

test('orphan prune rechecks a live adopter under the reservation lock', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  const paused = path.join(h.base, 'orphan-status');
  const prune = h.runAsync(['worktree', 'prune', '--orphans', '--json'], { hooks: { HOOK_STOP_WORKTREE_STATUS: paused } });
  try {
    await fileWritten(paused);
    h.ok(['claim', 'T1', '--agent', 'adopter']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
    h.ok(['rework', 'T1', '--reason', 'continue in the adopted checkout']);
    const live = h.json(['worktree', 'T1']);
    fs.writeFileSync(path.join(live.path, 'live.txt'), 'live rework files\n');
    assert.equal(h.json(['worktree', 'list']).worktrees.find((w) => w.path === wt.path).state, 'live');
    fs.writeFileSync(`${paused}.go`, '');
    const result = await prune;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcomes.find((w) => w.path === wt.path).removed, false);
    assert.equal(fs.readFileSync(path.join(live.path, 'live.txt'), 'utf8'), 'live rework files\n');
    assert.ok(h.git(['branch', '--list', wt.branch]));
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await prune;
  }
});

for (const hook of ['HOOK_STOP_WORKTREE_SAVE', 'HOOK_STOP_WORKTREE_REMOVE', 'HOOK_STOP_BRANCH_DELETE']) {
  test(`orphan reservation blocks branch assignment throughout removal (${hook})`, { timeout: 300000 }, async (t) => {
    const h = setup(t);
    const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
    h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
    fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'orphan notes\n');
    h.ok(['claim', 'T1', '--agent', 'adopter']);
    const paused = path.join(h.base, 'orphan-removal');
    const prune = h.runAsync(['worktree', 'prune', '--orphans', '--json'], { hooks: { [hook]: paused } });
    try {
      await fileWritten(paused);
      const assigned = h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
      assert.equal(assigned.code, 1, 'an orphan being removed cannot become a task branch');
      assert.match(assigned.stderr, /being removed|retiring/);
      assert.equal(h.json(['task', 'show', 'T1']).status, 'in_progress');
    } finally {
      fs.writeFileSync(`${paused}.go`, '');
      await prune;
    }
    gone(h, wt);
    assert.deepEqual(h.readState('tasks.json').orphan_retirements || [], []);
    const removal = JSON.parse((await prune).stdout).outcomes.find((w) => w.path === wt.path);
    assert.equal(fs.readFileSync(path.join(removal.saved, 'files', 'notes.txt'), 'utf8'), 'orphan notes\n');
  });
}

test('a competing orphan prune cannot clear the first remover reservation', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  h.ok(['claim', 'T1', '--agent', 'adopter']);
  const paused = path.join(h.base, 'orphan-remove');
  const prune = h.runAsync(['worktree', 'prune', '--orphans', '--json'], { hooks: { HOOK_STOP_WORKTREE_REMOVE: paused } });
  try {
    await fileWritten(paused);
    const competing = h.json(['worktree', 'prune', '--orphans']);
    assert.equal(competing.outcomes.find((w) => w.path === wt.path).removed, false);
    assert.match(competing.outcomes.find((w) => w.path === wt.path).reason, /being removed|retiring/);
    assert.equal(h.readState('tasks.json').orphan_retirements.length, 1);
    const assigned = h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
    assert.equal(assigned.code, 1, 'another failed prune must leave the active reservation intact');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await prune;
  }
  gone(h, wt);
  assert.deepEqual(h.readState('tasks.json').orphan_retirements || [], []);
});

test('failed orphan removal clears its reservation and allows later adoption', (t) => {
  const h = setup(t);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  h.git(['worktree', 'lock', wt.path]);
  const result = h.json(['worktree', 'prune', '--orphans']);
  assert.equal(result.outcomes[0].removed, false);
  assert.match(result.outcomes[0].reason, /locked/);
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const reserved = events.findLast((e) => e.cmd === 'worktree orphan retiring');
  assert.equal(reserved?.detail.path, wt.path);
  assert.equal(reserved?.detail.branch, wt.branch);
  assert.deepEqual(h.readState('tasks.json').orphan_retirements || [], []);
  h.git(['worktree', 'unlock', wt.path]);
  h.ok(['claim', 'T1', '--agent', 'adopter']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
  h.ok(['rework', 'T1', '--reason', 'continue after the failed cleanup']);
  assert.equal(h.json(['worktree', 'T1']).path, wt.path);
});

test('orphan reservation blocks preparation of a task with the same generated branch', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'tower-crane/T1-retire' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  h.ok(['claim', 'T1', '--agent', 'adopter']);
  const paused = path.join(h.base, 'orphan-prepare');
  const prune = h.runAsync(['worktree', 'prune', '--orphans'], { hooks: { HOOK_STOP_WORKTREE_REMOVE: paused } });
  try {
    await fileWritten(paused);
    const prepared = h.run(['worktree', 'T1']);
    assert.equal(prepared.code, 1, 'preparation must not reuse an orphan reserved by prune');
    assert.match(prepared.stderr, /being removed|retiring/);
    assert.equal(h.json(['task', 'show', 'T1']).worktree, undefined);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await prune;
  }
  gone(h, wt);
});

test('orphan ownership includes a newly submitted branch before its worktree record changes', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'adopter']);
  const old = h.json(['worktree', 'T1']);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  const paused = path.join(h.base, 'orphan-owner');
  const prune = h.runAsync(['worktree', 'prune', '--orphans', '--json'], { hooks: { HOOK_STOP_WORKTREE_STATUS: paused } });
  try {
    await fileWritten(paused);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
    h.ok(['rework', 'T1', '--reason', 'resume the newly submitted branch']);
    fs.writeFileSync(path.join(wt.path, 'live.txt'), 'new branch work\n');
    fs.writeFileSync(`${paused}.go`, '');
    const result = await prune;
    assert.equal(JSON.parse(result.stdout).outcomes.find((w) => w.path === wt.path).removed, false);
    assert.equal(fs.readFileSync(path.join(wt.path, 'live.txt'), 'utf8'), 'new branch work\n');
    assert.equal(h.json(['worktree', 'list']).worktrees.find((w) => w.path === wt.path).state, 'live');
    assert.ok(h.git(['branch', '--list', wt.branch]));
    assert.ok(fs.existsSync(old.path), 'the previous checkout also remains intact');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await prune;
  }
});

test('an exited orphan remover holds no resources and its next prune discards the marker', { timeout: 300000 }, async (t) => {
  const h = setup(t);
  const wt = { path: path.join(h.base, 'repo-worktrees', 'unrecorded'), branch: 'unrecorded' };
  h.git(['worktree', 'add', '-b', wt.branch, wt.path, 'main']);
  fs.writeFileSync(path.join(wt.path, 'live.txt'), 'keep after remover crash\n');
  const paused = path.join(h.base, 'orphan-crash');
  const prune = h.runAsync(['worktree', 'prune', '--orphans'], { hooks: { HOOK_STOP_WORKTREE_REMOVE: paused } });
  try {
    await fileWritten(paused);
    const reservation = h.readState('tasks.json').orphan_retirements?.[0];
    assert.equal(reservation?.path, wt.path);
    killPid(reservation.pid, 'SIGKILL');
    await prune;
    h.ok(['claim', 'T1', '--agent', 'adopter']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--branch', wt.branch, '--agent', 'adopter']);
    h.ok(['rework', 'T1', '--reason', 'resume after remover crash']);
    assert.equal(h.json(['worktree', 'T1']).path, wt.path);
    const other = path.join(h.base, 'repo-worktrees', 'other-orphan');
    h.git(['worktree', 'add', '-b', 'other-orphan', other, 'main']);
    h.ok(['worktree', 'prune', '--orphans']);
    assert.deepEqual(h.readState('tasks.json').orphan_retirements || [], []);
    assert.equal(fs.readFileSync(path.join(wt.path, 'live.txt'), 'utf8'), 'keep after remover crash\n');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
    await prune;
  }
});
