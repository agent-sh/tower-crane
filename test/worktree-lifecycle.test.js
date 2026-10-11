'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

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
  h.git(['worktree', 'unlock', wt.path]);
  assert.ok(h.ok(['worktree', 'prune', '--dry-run']).includes(wt.path));
  assert.ok(fs.existsSync(wt.path));
  h.ok(['worktree', 'prune']);
  gone(h, wt);
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

test('the supervisor stops a cancelled worker and then removes its worktree', { timeout: 30000 }, async (t) => {
  const h = setup(t);
  const ready = path.join(h.base, 'worker-ready');
  const script = path.join(h.base, 'worker.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000);`);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'wait for cancellation\n' });
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, script, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
  const wt = h.json(['worktree', 'T1']);
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait']);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'worker started before deadline');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
