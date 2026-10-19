'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper, resubmit } = require('./stack-fixture');
const { fakeAgentEnv } = require('./helpers');
const Stack = require('../lib/stack');

const events = (f) => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('parent refresh eligibility preserves lifecycle validation', () => {
  const old = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const landed = (st, task) => {
    const entry = { type: 'merge', source: 'merge', sha: task.sha, revision: task.revision, agent: 'orchestrator',
      ok: true, commands: [{ command: 'gh', args: ['pr', 'merge'], status: 0 }] };
    task.evidence.push(entry);
    st.events.push({ task: task.id, cmd: 'merge', agent: entry.agent, detail: entry });
  };
  const cases = [
    ['submitted', () => {}, true],
    ['accepted', (_, dep) => { dep.status = 'accepted'; }, true],
    ['unchanged head', (_, dep) => { dep.sha = old; }, false],
    ['no head', (_, dep) => { dep.sha = null; }, false],
    ['no branch', (_, dep) => { dep.branch = null; }, false],
    ...['todo', 'rework', 'in_progress', 'cancelled'].map((status) => [status, (_, dep) => { dep.status = status; }, false]),
    ['merged parent', (st, dep) => { dep.status = 'accepted'; landed(st, dep); }, false],
    ['retiring parent', (_, dep) => { dep.retiring = { pid: process.pid }; }, false],
    ['shared retirement reservation', (st, dep) => {
      st.tasks.tasks.push({ id: 'T3', retiring: { pid: process.pid, branch: dep.branch } });
    }, false],
    ['orphan retirement reservation', (st, dep) => {
      st.tasks.orphan_retirements = [{ pid: process.pid, branch: dep.branch }];
    }, false],
    ['disabled stack', (_, dep, child) => { dep.status = 'accepted'; child.stack_disabled = true; }, true],
    ['unstacked child', (_, dep, child) => { delete child.stack; }, false],
    ['cancelled child', (_, dep, child) => { child.status = 'cancelled'; }, false],
    ['merged child', (st, dep, child) => { child.status = 'accepted'; landed(st, child); }, false],
  ];
  for (const [name, change, expected] of cases) {
    const dep = { id: 'T1', status: 'submitted', sha: newer, branch: 'lower', revision: 1, evidence: [] };
    const child = { id: 'T2', status: 'rework', sha: old, revision: 1, evidence: [],
      stack: { parent: 'T1', parent_sha: old } };
    const st = { tasks: { tasks: [dep, child] }, events: [] };
    change(st, dep, child);
    assert.equal(Stack.parentRefreshNeeded(st, child), expected, name);
  }
});

function inspector(f) {
  const script = path.join(f.h.base, 'inspect-worker.js');
  const receipt = path.join(f.h.base, 'dispatch.json');
  fs.writeFileSync(script, `const fs = require('node:fs'), cp = require('node:child_process');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  prompt: process.argv[2]
}));
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--env', JSON.stringify(fakeAgentEnv({ NODE_OPTIONS: f.h.env.NODE_OPTIONS })),
    '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
  return () => JSON.parse(fs.readFileSync(receipt, 'utf8'));
}

function child(f, submitted, conflict) {
  if (submitted) {
    const top = upper(f);
    if (!conflict) return top;
    f.h.ok(['rework', 'T2', '--reason', 'child edits']);
    fs.writeFileSync(path.join(top.wt.path, 'T1.txt'), 'child\n');
    f.h.git(['add', 'T1.txt'], top.wt.path);
    f.h.git(['commit', '-qm', 'child edits'], top.wt.path);
    f.h.git(['push', 'origin', top.wt.branch], top.wt.path);
    const sha = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
    f.write((d) => { d.prs[12].headRefOid = sha; });
    f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
    f.h.ok(['submit', 'T2', '--sha', sha, '--pr', '12', '--agent', 'worker-T2']);
    return { wt: top.wt, sha };
  }
  const wt = f.h.json(['worktree', 'T2']);
  const file = conflict ? 'T1.txt' : 'child.txt';
  fs.writeFileSync(path.join(wt.path, file), 'child\n');
  f.h.git(['add', file], wt.path);
  f.h.git(['commit', '-qm', 'child edits'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  return { wt, sha: f.h.git(['rev-parse', 'HEAD'], wt.path) };
}

function newerParent(f, conflict) {
  if (conflict) fs.writeFileSync(path.join(f.lower.path, 'T1.txt'), 'parent\n');
  if (conflict) f.h.git(['add', 'T1.txt'], f.lower.path);
  return resubmit(f, false);
}

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
        if (rewrite && published) {
          assert.equal(result.code, 1, result.stdout + result.stderr);
          assert.match(result.stderr, /git push failed/);
          assert.equal(f.h.git(['rev-parse', wt.branch]), f.sha);
          assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
          assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), f.sha);
        } else {
          assert.equal(result.code, 0, result.stdout + result.stderr);
          assert.equal(read().head, parent);
          assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, parent);
          assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], path.join(f.h.base, 'remote.git')), parent);
          if (rewrite) assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, read().head]));
        }
      });
    }
  }
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
