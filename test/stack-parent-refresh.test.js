'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper, resubmit } = require('./stack-fixture');
const { events, inspector, child, newerParent } = require('./stack-parent-helpers');

// Child gates while the parent moves, rewritten parents and the refresh merge and push.

for (const status of ['submitted', 'accepted', 'rework', 'in_progress']) {
  for (const stale of [false, true]) {
    test(`a child gate ${stale ? 'waits for the newer head' : 'checks its current head'} while the parent is ${status}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      const parent = stale ? resubmit(f, false) : f.sha;
      if (status === 'accepted') f.accept('T1');
      if (['rework', 'in_progress'].includes(status)) f.h.ok(['rework', 'T1', '--reason', 'parent continues work']);
      if (status === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
      const result = f.h.run(['check', 'ci', 'T2', '--json']);
      if (stale) {
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`waits for a submitted head containing T1 at ${parent}`));
        assert.equal(events(f).some((e) => e.task === 'T2' && e.cmd === 'check ci'), false);
      } else {
        assert.equal(result.code, 0, result.stdout + result.stderr);
        const checked = JSON.parse(result.stdout);
        assert.equal(checked.ok, true);
        assert.equal(checked.sha, top.sha);
      }
    });
  }
}

test('a child gate waits when a replacement parent PR has no submitted head', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T1', '--reason', 'replace parent PR']);
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  f.write((d) => {
    d.prs[21] = { ...d.prs[11], number: 21 };
    d.prs[11].state = 'CLOSED';
  });
  f.h.ok(['release', 'T1', '--agent', 'worker-T1', '--pr', '21', '--reason', 'new PR needs submission']);
  assert.equal(f.h.json(['task', 'show', 'T1']).sha, null);
  const result = f.h.run(['check', 'ci', 'T2']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /waits for a submitted head containing T1 at \(none\)/);
});

for (const rewrite of [false, true]) {
  for (const published of [false, true]) {
    for (const checkout of [false, true]) {
      test(`untouched child adopts ${rewrite ? 'rewritten' : 'descendant'} parent with ${published ? 'published' : 'unpublished'} branch and ${checkout ? 'present' : 'absent'} checkout`, (t) => {
        const f = setup(t);
        const wt = f.h.json(['worktree', 'T2']);
        if (published) f.h.git(['push', 'origin', wt.branch], wt.path);
        if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
        const parent = resubmit(f, rewrite);
        const read = inspector(f);
        const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(read().head, parent);
        assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), parent);
        if (rewrite) assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, read().head]));
      });
    }
  }
}

for (const checkout of [false, true]) {
  test(`a gate-published untouched child dispatches after a later rewrite with ${checkout ? 'present' : 'absent'} checkout`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    const published = resubmit(f, false);
    assert.equal(f.h.run(['check', 'ci', 'T2']).code, 1);
    assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), published);
    if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
    const parent = resubmit(f, true);
    const read = inspector(f);
    f.h.ok(['spawn', '--task', 'T2', '--wait']);
    assert.equal(read().head, parent);
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
    assert.throws(() => f.h.git(['merge-base', '--is-ancestor', published, parent]));
  });
}

for (const checkout of [false, true]) {
  test(`a guarded rewrite lease preserves new remote child work with ${checkout ? 'present' : 'absent'} checkout`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    f.h.git(['push', 'origin', wt.branch], wt.path);
    const peer = path.join(f.h.base, 'peer');
    f.h.git(['clone', '--branch', wt.branch, path.join(f.h.base, 'remote.git'), peer]);
    fs.writeFileSync(path.join(peer, 'remote-child.txt'), 'remote child\n');
    f.h.git(['add', 'remote-child.txt'], peer);
    f.h.git(['commit', '-qm', 'remote child work'], peer);
    f.h.git(['push', 'origin', wt.branch], peer);
    const remote = f.h.git(['rev-parse', 'HEAD'], peer);
    if (!checkout) f.h.git(['worktree', 'remove', wt.path]);
    resubmit(f, true);
    inspector(f);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /guarded lease expected/);
      assert.equal(f.h.git(['rev-parse', wt.branch]), f.sha);
      assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), remote);
      const task = f.h.json(['task', 'show', 'T2']);
      assert.equal(task.stack.parent_sha, f.sha);
      assert.equal(task.notes.filter((n) => n.text.includes('guarded lease expected')).length, 1);
    }
  });
}

for (const linked of [false, true]) {
  test(`rewritten parents preserve own child commits for ${linked ? 'linked' : 'unlinked'} restacking`, (t) => {
    const f = setup(t);
    const top = upper(f);
    if (!linked) f.h.ok(['stack', 'unstack', 'T2']);
    f.h.git(['rm', 'T1.txt'], f.lower.path);
    const parent = resubmit(f, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.h.run(['check', 'ci', 'T2']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /child has its own commits.*Restack/);
      assert.equal(f.h.git(['rev-parse', top.wt.branch]), top.sha);
      assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), top.sha);
      assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
    }
    assert.equal(f.h.json(['task', 'show', 'T2']).notes.filter((n) => n.text.includes('child has its own commits')).length, 1);
    f.write((d) => { d.restack = { branch: top.wt.branch, oldParent: f.sha, parent }; });
    if (!linked) f.h.ok(['stack', 'link', 'T2']);
    f.h.json(['worktree', 'T2']);
    assert.ok(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'),
      events(f).filter((e) => e.cmd === 'stack sync deferred').map((e) => e.detail.reason).join('\n'));
    const restacked = f.h.git(['rev-parse', top.wt.branch]);
    f.h.git(['merge-base', '--is-ancestor', parent, restacked]);
    assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, restacked]));
    assert.throws(() => f.h.git(['cat-file', '-e', `${restacked}:T1.txt`]));
    assert.equal(f.h.git(['show', `${restacked}:T2.txt`]), 'T2');
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
  });
}

for (const status of ['rework', 'in_progress']) {
  test(`linked base refresh proceeds after parent refresh is a no-op for ${status}`, (t) => {
    const f = setup(t);
    upper(f);
    resubmit(f, false);
    f.h.ok(['rework', 'T1', '--reason', 'parent continues work']);
    if (status === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
    fs.writeFileSync(path.join(f.h.repo, 'main.txt'), 'main\n');
    f.h.git(['add', 'main.txt']);
    f.h.git(['commit', '-qm', 'main advances']);
    f.h.git(['push', 'origin', 'main']);
    if (status === 'in_progress') {
      f.h.json(['worktree', 'T2']);
      assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'), false);
      f.h.ok(['release', 'T1', '--agent', 'worker-T1', '--reason', 'parent worker finished']);
    }
    f.h.json(['worktree', 'T2']);
    assert.ok(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'sync'));
    assert.equal(f.h.json(['task', 'show', 'T2']).stack.synced_base, f.h.git(['rev-parse', 'origin/main']));
  });
}

for (const submitted of [false, true]) {
  for (const conflict of [false, true]) {
    test(`parent resubmission ${conflict ? 'conflicts without moving' : 'merges and pushes'} the ${submitted ? 'submitted' : 'prepared'} child before dispatch`, (t) => {
      const f = setup(t);
      const top = child(f, submitted, conflict);
      const parent = newerParent(f, conflict);
      const read = inspector(f);
      f.h.ok(['spawn', '--task', 'T2', '--wait']);
      const task = f.h.json(['task', 'show', 'T2']);
      const dispatched = read();
      const log = events(f);
      const sync = log.findLast((e) => e.task === 'T2' && e.cmd === 'stack sync');
      assert.ok(sync);
      assert.equal(sync.detail.parent_sha, parent);
      if (conflict) {
        assert.equal(dispatched.head, top.sha);
        assert.equal(task.stack.parent_sha, f.sha);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), top.sha);
        assert.match(dispatched.prompt, new RegExp(parent));
        assert.match(dispatched.prompt, /resolve conflicts in: T1\.txt/);
        assert.equal(sync.detail.failure, 'conflict');
        assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), '');
      } else {
        assert.equal(f.h.git(['rev-parse', `${dispatched.head}^1`]), top.sha);
        assert.equal(f.h.git(['rev-parse', `${dispatched.head}^2`]), parent);
        assert.equal(f.h.git(['show', '-s', '--format=%s', dispatched.head]), "Merge T1's resubmitted head into T2");
        assert.equal(task.stack.parent_sha, parent);
        assert.equal(f.h.git(['rev-parse', `refs/heads/${top.wt.branch}`], path.join(f.h.base, 'remote.git')), dispatched.head);
        assert.equal(sync.detail.ok, true);
      }
      assert.ok(log.indexOf(sync) < log.findIndex((e) => e.cmd === 'spawn' && e.task === 'T2'));
      assert.doesNotMatch(f.h.git(['worktree', 'list', '--porcelain']), /stack-parent-/);
    });
  }
}

for (const conflict of [false, true]) {
  test(`parent refresh ${conflict ? 'conflicts' : 'merges'} after recovering the child from its remote`, (t) => {
    const f = setup(t);
    const top = child(f, false, conflict);
    const parent = newerParent(f, conflict);
    f.h.git(['worktree', 'remove', top.wt.path]);
    f.h.git(['branch', '-D', top.wt.branch]);
    const read = inspector(f);
    f.h.ok(['spawn', '--task', 'T2', '--wait']);
    if (conflict) {
      assert.equal(read().head, top.sha);
      assert.match(read().prompt, new RegExp(parent));
      assert.match(read().prompt, /T1\.txt/);
    } else {
      assert.equal(f.h.git(['rev-parse', `${read().head}^2`]), parent);
    }
  });
}

test('a failed refresh push leaves the child branch and stack metadata for retry', (t) => {
  const f = setup(t);
  const top = child(f, false, false);
  newerParent(f, false);
  inspector(f);
  // A receive hook exercises the real Git push failure against the bare remote.
  const hook = path.join(f.h.base, 'remote.git', 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /git push failed/);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
  assert.doesNotMatch(f.h.git(['worktree', 'list', '--porcelain']), /stack-parent-/);
  fs.unlinkSync(hook);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
});

for (const conflict of [false, true]) {
  test(`a gate ${conflict ? 'defers the conflicting' : 'syncs then waits for resubmission of the'} child instead of running its old head`, (t) => {
    const f = setup(t);
    const top = child(f, true, conflict);
    const parent = newerParent(f, conflict);
    const before = events(f).filter((e) => e.task === 'T2' && e.cmd.startsWith('check ')).length;
    const result = f.h.run(['check', 'clean', 'T2']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`waits for a submitted head containing T1 at ${parent}`));
    const task = f.h.json(['task', 'show', 'T2']);
    assert.equal(task.status, 'rework');
    assert.equal(task.sha, top.sha);
    assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd.startsWith('check ')).length, before);
    const head = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
    if (conflict) assert.equal(head, top.sha);
    else assert.equal(f.h.git(['rev-parse', `${head}^2`]), parent);
    // The conflict note and revision remain stable across retries.
    f.h.run(['check', 'clean', 'T2']);
    assert.equal(f.h.json(['task', 'show', 'T2']).revision, task.revision);
    assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync').length, 1);
  });
}
