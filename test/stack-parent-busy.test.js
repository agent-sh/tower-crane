'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper, resubmit } = require('./stack-fixture');
const { events, reviewProbe, child } = require('./stack-parent-helpers');

// A stacked child whose head holds the parent, a stopped git operation or a live session, and cached gates.

// The worker merges the parent itself and resubmits with leftovers in its checkout.
function submitWithParent(f, top, parent) {
  f.h.git(['merge', '--no-ff', '--no-edit', parent], top.wt.path);
  f.h.git(['push', 'origin', top.wt.branch], top.wt.path);
  const sha = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
  f.write((d) => { d.prs[12].headRefOid = sha; });
  f.h.ok(['submit', 'T2', '--sha', sha, '--branch', top.wt.branch, '--pr', '12', '--agent', 'worker-T2']);
  return sha;
}

for (const cycle of [false, true]) {
  for (const dirty of ['unstaged', 'staged', 'untracked']) {
    for (const entry of ['accept', 'check clean']) {
      test(`dirty submitted child whose head holds the parent keeps its status through ${entry} with ${dirty} edits${cycle ? ' after a dirty rework' : ''}`, (t) => {
        const f = setup(t);
        const top = upper(f);
        const file = dirty === 'untracked' ? 'pr-body.md' : 'T2.txt';
        const dirt = () => {
          fs.writeFileSync(path.join(top.wt.path, file), 'pending edits\n');
          if (dirty === 'staged') f.h.git(['add', file], top.wt.path);
        };
        let parent;
        if (cycle) {
          dirt();
          parent = resubmit(f, false);
          assert.equal(f.h.run(['check', 'clean', 'T2']).code, 1);
          assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
          f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
          // The leftover outlives the worker's merge, which needs a clean index.
          f.h.git(['reset', '-q', '--hard'], top.wt.path);
          fs.rmSync(path.join(top.wt.path, file), { force: true });
          submitWithParent(f, top, parent);
          dirt();
        } else {
          parent = resubmit(f, false);
          submitWithParent(f, top, parent);
          dirt();
        }
        const before = f.h.json(['task', 'show', 'T2']);
        const status = f.h.git(['status', '--porcelain'], top.wt.path);
        const reworks = () => events(f).filter((e) => e.task === 'T2' && e.cmd === 'rework').length;
        const offset = reworks();
        const args = entry === 'accept' ? ['accept', 'T2', '--waive', 'review', '--waive', 'ci', '--reason', 'offline stack fixture']
          : ['check', 'clean', 'T2'];
        f.h.run(args);
        const task = f.h.json(['task', 'show', 'T2']);
        assert.equal(reworks(), offset, 'a head that holds the parent is not sent back');
        assert.equal(task.status, entry === 'accept' ? 'accepted' : 'submitted');
        assert.equal(task.revision, before.revision);
        assert.equal(task.sha, before.sha);
        assert.equal(task.stack.parent_sha, parent);
        assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), before.sha);
        assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), status);
        const deferred = events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred' && e.detail.parent_sha === parent);
        assert.equal(deferred.length, cycle ? 1 : 0, 'a head that holds the parent records no deferral');
      });
    }
  }
}

// Holding the parent tolerates a busy checkout, not a stopped Git operation.
for (const operation of ['bisect', 'cherry-pick']) {
  for (const busy of ['none', 'dirty', 'live']) {
    test(`child whose branch holds the parent refuses refresh during a stopped ${operation} with ${busy} busy state`, (t) => {
      const f = setup(t);
      const top = upper(f);
      const parent = resubmit(f, false);
      if (busy === 'live') {
        f.h.ok(['rework', 'T2', '--reason', 'child continues']);
        f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
        f.h.git(['merge', '--no-ff', '--no-edit', parent], top.wt.path);
      } else submitWithParent(f, top, parent);
      if (busy === 'dirty') fs.writeFileSync(path.join(top.wt.path, 'pr-body.md'), 'pending edits\n');
      const git = (...args) => cp.spawnSync('git', args, { cwd: top.wt.path, env: f.h.env, encoding: 'utf8' });
      if (operation === 'bisect') git('bisect', 'start', 'HEAD', 'HEAD~1');
      else git('cherry-pick', f.h.git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'same tree'], top.wt.path));
      const before = f.h.json(['task', 'show', 'T2']);
      const gate = f.h.run(['check', busy === 'live' ? 'ci' : 'clean', 'T2']);
      assert.equal(gate.code, 1);
      assert.ok(gate.stderr.includes(`T2: worktree ${top.wt.path} has a ${operation} in progress; finish or abort it there`), gate.stderr);
      const task = f.h.json(['task', 'show', 'T2']);
      assert.notEqual(task.stack.parent_sha, parent);
      assert.equal(task.status, before.status);
      assert.equal(task.revision, before.revision);
      assert.deepEqual(task.gates, before.gates, 'no gate runs during the operation');
      assert.equal(events(f).some((e) => e.task === 'T2' && e.cmd === 'stack sync'), false);
    });
  }
}

test('live child whose branch holds the parent records it without a deferral', (t) => {
  const f = setup(t);
  const top = upper(f);
  const parent = resubmit(f, false);
  f.h.ok(['rework', 'T2', '--reason', 'child continues']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
  f.h.git(['merge', '--no-ff', '--no-edit', parent], top.wt.path);
  const head = f.h.git(['rev-parse', 'HEAD'], top.wt.path);
  f.h.run(['check', 'ci', 'T2']);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.stack.parent_sha, parent);
  assert.equal(task.status, 'in_progress');
  assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), head);
  assert.equal(events(f).some((e) => e.task === 'T2' && e.cmd === 'stack sync deferred'), false);
  assert.ok(events(f).some((e) => e.task === 'T2' && e.cmd === 'stack sync' && e.detail.ok));
});

for (const busy of ['live', 'dirty']) {
  for (const linked of [false, true]) {
    test(`parent refresh records ${busy} ${linked ? 'linked' : 'prepared'} deferral once per parent head`, (t) => {
      const f = setup(t);
      const top = linked ? upper(f) : child(f, false, false);
      if (linked) f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      if (busy === 'live') f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
      else fs.writeFileSync(path.join(top.wt.path, 'pending.txt'), 'pending edits\n');
      const count = (sha) => events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred' && e.detail.parent_sha === sha).length;
      const refresh = () => {
        f.h.run(['check', 'ci', 'T2']);
        if (linked) f.h.ok(['worktree', 'T1']);
      };
      const first = resubmit(f, false);
      refresh();
      refresh();
      assert.equal(count(first), 1);
      fs.writeFileSync(path.join(f.lower.path, 'T1c.txt'), 'another parent head\n');
      f.h.git(['add', 'T1c.txt'], f.lower.path);
      const second = resubmit(f, false);
      refresh();
      refresh();
      assert.equal(count(second), 1);
      assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred').length, 2);
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const entry of ['waived accept', 'accept review', 'review dry-run', 'review spawn', 'unlinked review', 'automatic accept', 'automatic review']) {
  for (const stale of [false, true]) {
    test(`${entry} ${stale ? 'refuses stale' : 'allows current'} stacked child after cached software gates`, (t) => {
      const f = setup(t);
      const top = upper(f);
      if (entry === 'unlinked review') f.h.ok(['stack', 'unstack', 'T2']);
      f.h.ok(['check', 'ci', 'T2']);
      reviewProbe(f);
      Object.assign(f.h.env, {
        USERPROFILE: f.h.env.HOME, CLAUDE_CONFIG_DIR: path.join(f.h.env.HOME, '.claude'),
        CODEX_HOME: path.join(f.h.env.HOME, '.codex'), GH_CONFIG_DIR: path.join(f.h.env.HOME, '.config', 'gh'),
        XDG_CONFIG_HOME: path.join(f.h.env.HOME, '.config'), XDG_DATA_HOME: path.join(f.h.env.HOME, '.local', 'share'),
      });
      if (entry === 'automatic accept') f.h.ok(['evidence', 'T2', '--type', 'review', '--ok', '--sha', top.sha, '--revision', '1']);
      if (entry === 'automatic review') {
        // A native submission needs an exited worker receipt for automatic review.
        const at = new Date().toISOString();
        const detail = { agent: 'worker-T2', role: 'worker', sha: top.sha, revision: 1, pid: 999999, attempt: 1 };
        fs.appendFileSync(path.join(f.h.state, 'events.jsonl'), [
          { at, agent: 'orchestrator', cmd: 'spawn', task: 'T2', detail },
          { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T2', detail: { agent: detail.agent, pid: detail.pid, attempt: 1, code: 0 } },
        ].map((e) => `${JSON.stringify(e)}\n`).join(''));
      }
      const parent = stale ? resubmit(f, false) : f.sha;
      const before = events(f).filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'reviewer').length;
      let result;
      if (entry.startsWith('automatic')) {
        if (entry === 'automatic accept') f.h.ok(['project', 'set', '--paused', 'review acceptance probe']);
        result = f.h.run(['wait', '--task', 'T2', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      } else if (entry.startsWith('review') || entry === 'unlinked review') {
        result = f.h.run(['spawn', '--task', 'T2', '--role', 'review',
          ...(entry === 'review dry-run' ? ['--dry-run'] : ['--wait']), '--json']);
      } else {
        result = f.h.run(['accept', 'T2', '--json',
          ...(entry === 'waived accept' ? ['--waive', 'review', '--reason', 'offline fixture'] : [])]);
      }
      const task = f.h.json(['task', 'show', 'T2']);
      const reviewers = events(f).filter((e) => e.cmd === 'spawn' && e.task === 'T2' && e.detail.role === 'reviewer');
      if (stale) {
        assert.notEqual(task.status, 'accepted', result.stdout + result.stderr);
        assert.equal(reviewers.length, before, 'no reviewer starts at the old head');
        if (!entry.startsWith('automatic')) {
          assert.equal(result.code, 1, result.stdout + result.stderr);
          assert.match(result.stderr, new RegExp(`containing T1 at ${parent}`));
        }
        assert.equal(task.sha, top.sha, 'refresh still requires a new child submission');
      } else if (entry === 'waived accept' || entry === 'automatic accept') {
        assert.equal(task.status, 'accepted', result.stdout + result.stderr);
      } else if (entry === 'automatic review') {
        assert.equal(reviewers.length, before + 1, result.stdout + result.stderr);
      } else {
        assert.equal(result.code, 0, result.stdout + result.stderr);
      }
    });
  }
}
