'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper } = require('./stack-fixture');
const { HUNG_TEST_MS } = require('./signals');
const S = require('../lib/state');
const T = require('../lib/tasks');

const task = (f) => f.h.readState('tasks.json').tasks.find((t) => t.id === 'T2');
const events = (f) => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function automaticNote(f) {
  const note = task(f).notes.findLast((n) => n.text.startsWith('Stack parent T1 merged.'));
  assert.ok(note, 'the worker receives the automatic merge-base note');
  assert.deepEqual(events(f).filter((e) => e.cmd === 'task note' && e.task === 'T2' && e.detail.text === note.text), [],
    'automatic notes do not enter the owner-comment event channel');
  assert.deepEqual(T.planIssues(S.loadState(f.h.state)).filter((issue) => issue.kind === 'log-drift'), []);
}

function remoteMerge(f, method) {
  const base = f.h.git(['rev-parse', 'origin/main']);
  const tree = f.h.git(['rev-parse', `${f.sha}^{tree}`]);
  const sha = f.h.git(['commit-tree', tree, '-p', base, ...(method === 'merge' ? ['-p', f.sha] : []), '-m', 'land parent']);
  f.h.git(['push', 'origin', `${sha}:main`, `:${f.lower.branch}`]);
  f.write((d) => {
    d.prs[11].state = 'MERGED';
    d.prs[11].mergeCommit = { oid: sha };
    if (d.closeOnDelete) {
      for (const pr of Object.values(d.prs)) {
        if (pr.state === 'OPEN' && pr.baseRefName === f.lower.branch) pr.state = 'CLOSED';
      }
    }
  });
}

function probeWorker(f) {
  const script = path.join(f.h.base, 'probe.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(path.join(process.env.TOWER_CRANE_STATE, 'tasks.json'), 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(f.h.base, 'dispatch.json'))}, JSON.stringify({
  task: state.tasks.find((t) => t.id === 'T2'), prompt: process.argv.at(-1),
}));`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
}

for (const status of ['todo', 'in_progress']) {
  test(`a parent merge reaction retires a ${status} child without a PR`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    if (status === 'in_progress') f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
    f.accept('T1');
    f.h.ok(['merge', 'T1']);
    assert.equal(task(f).stack, undefined);
    const complete = events(f).find((e) => e.cmd === 'stack complete' && e.task === 'T2');
    assert.deepEqual(complete?.detail, { parent: 'T1', base: 'main', pr: null });
    assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.sha, 'retirement preserves the child branch');
    assert.match(f.h.ok(['task', 'show', 'T2']), /merge main.*before/i);
    automaticNote(f);
  });
}

for (const method of ['squash', 'merge']) {
  test(`dispatch rechecks a remotely ${method}-merged parent before spawning its child without a PR`, (t) => {
    const f = setup(t);
    const wt = f.h.json(['worktree', 'T2']);
    fs.writeFileSync(path.join(wt.path, 'child.txt'), 'child work\n');
    f.h.git(['add', 'child.txt'], wt.path);
    f.h.git(['commit', '-qm', 'child work'], wt.path);
    const head = f.h.git(['rev-parse', 'HEAD'], wt.path);
    remoteMerge(f, method);
    probeWorker(f);
    f.h.ok(['spawn', '--task', 'T2', '--wait']);
    const dispatched = JSON.parse(fs.readFileSync(path.join(f.h.base, 'dispatch.json'), 'utf8'));
    assert.equal(dispatched.task.stack, undefined);
    assert.ok(dispatched.task.notes.some((n) => /merge main.*before/i.test(n.text)));
    assert.doesNotMatch(dispatched.prompt, /Its PR targets tower-crane\/T1/);
    const history = events(f);
    assert.ok(history.findIndex((e) => e.cmd === 'stack complete' && e.task === 'T2')
      < history.findIndex((e) => e.cmd === 'spawn' && e.task === 'T2'));
    assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), head, 'existing child commits survive dispatch');
    assert.ok(f.read().calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args[2] === '11'));
    automaticNote(f);
  });
}

for (const mismatch of ['head', 'base', 'repository']) {
  test(`dispatch refuses a remotely merged parent with a different ${mismatch}`, (t) => {
    const f = setup(t);
    f.h.json(['worktree', 'T2']);
    remoteMerge(f, 'squash');
    f.write((d) => {
      if (mismatch === 'head') d.prs[11].headRefOid = 'a'.repeat(40);
      if (mismatch === 'base') d.prs[11].baseRefName = 'unrelated';
      if (mismatch === 'repository') d.prs[11].isCrossRepository = true;
    });
    probeWorker(f);
    const result = f.h.run(['spawn', '--task', 'T2', '--wait']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /merged stack parent differs/);
    assert.ok(task(f).stack);
    assert.equal(events(f).some((e) => e.cmd === 'spawn' && e.task === 'T2'), false);
  });
}

test('an observer retires a child without a PR left behind after a merge receipt', (t) => {
  const f = setup(t);
  f.h.json(['worktree', 'T2']);
  const previous = task(f).stack;
  f.accept('T1');
  f.h.ok(['merge', 'T1']);
  const state = f.h.readState('tasks.json');
  state.tasks.find((t) => t.id === 'T2').stack = previous;
  f.h.writeState('tasks.json', state);
  const after = fs.statSync(path.join(f.h.state, 'events.jsonl')).size;
  f.h.ok(['wait', '--task', 'T2', '--types', 'stack complete', '--after', String(after), '--observe', '--timeout', String(HUNG_TEST_MS / 1000)]);
  assert.equal(task(f).stack, undefined);
  assert.equal(events(f).filter((e) => e.cmd === 'stack complete' && e.task === 'T2').length, 2);
  automaticNote(f);
});

for (const childState of ['OPEN', 'CLOSED', 'replacement']) {
  test(`retiring a child with a ${childState} PR leaves an open PR against main`, (t) => {
    const f = setup(t);
    upper(f);
    f.accept('T1');
    if (childState === 'CLOSED') f.accept('T2');
    const previousRevision = task(f).revision;
    // Exercise ordinary squash retirement, including GitHub closing the dependent
    // when deletion removes its base, without the linked-stack merge path.
    f.write((d) => {
      d.linked = false;
      d.closeOnDelete = childState !== 'OPEN';
      d.prs[12].title = 'upper';
      d.prs[12].body = 'keep this description';
      if (childState === 'replacement') {
        d.prs[13] = { ...d.prs[12], number: 13, baseRefName: 'main', title: 'upper', body: 'keep this description' };
      }
    });
    f.h.ok(['stack', 'unstack', 'T2']);
    f.h.ok(['merge', 'T1']);
    assert.equal(task(f).stack, undefined);
    const current = task(f);
    const pr = f.read().prs[current.pr];
    automaticNote(f);
    assert.equal(pr.state, 'OPEN');
    assert.equal(pr.baseRefName, 'main');
    assert.equal(pr.headRefOid, current.sha);
    assert.equal(pr.headRefName, current.branch);
    if (childState === 'OPEN') assert.equal(current.pr, 12);
    else {
      assert.equal(current.pr, 13);
      assert.equal(current.revision, previousRevision + 1);
      assert.equal(current.status, 'submitted');
      assert.equal(pr.body, 'keep this description');
      assert.equal(f.read().calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length,
        childState === 'replacement' ? 0 : 1);
    }
  });
}

function middle(f, upperState, middleStatus, disabled = true, linked = true) {
  if (linked) upper(f);
  else {
    const wt = f.h.json(['worktree', 'T2']);
    f.submit('T2', 12, wt);
  }
  f.accept('T1');
  if (middleStatus === 'accepted') f.accept('T2');
  const id = f.add('top', 'T2');
  const wt = f.h.json(['worktree', id]);
  if (upperState === 'submitted') {
    f.submit(id, 13, wt);
    f.h.ok(['stack', 'link', id]);
  }
  if (disabled) {
    f.write((d) => { d.linked = false; });
    f.h.ok(['stack', 'unstack', 'T2']);
  }
  return wt;
}

for (const childState of ['OPEN', 'CLOSED']) {
  for (const checkout of ['present', 'missing']) {
    test(`linked middle dispatch uses main with a ${childState} PR and ${checkout} checkout after a remote merge`, (t) => {
      const f = setup(t);
      middle(f, 'submitted', 'accepted', false);
      const wt = f.h.json(['worktree', 'T2']);
      const previous = task(f);
      f.write((d) => { d.closeOnDelete = childState === 'CLOSED'; });
      remoteMerge(f, 'squash');
      f.h.ok(['rework', 'T2', '--reason', 'continue middle work']);
      if (checkout === 'missing') {
        f.h.git(['worktree', 'remove', '--force', wt.path]);
        f.h.git(['branch', '-D', previous.branch]);
      }
      probeWorker(f);
      f.h.ok(['spawn', '--task', 'T2', '--wait']);
      const dispatched = JSON.parse(fs.readFileSync(path.join(f.h.base, 'dispatch.json'), 'utf8'));
      assert.equal(dispatched.task.stack.base, 'main');
      assert.equal(dispatched.task.stack.parent, 'T1');
      assert.match(dispatched.prompt, /Its PR targets main/);
      assert.doesNotMatch(dispatched.prompt, /--base tower-crane\/T1/);
      assert.equal(f.read().prs[dispatched.task.pr].state, 'OPEN');
      assert.equal(f.read().prs[dispatched.task.pr].baseRefName, 'main');
      assert.equal(f.h.git(['rev-parse', previous.branch]), previous.sha);
      assert.equal(f.h.readState('tasks.json').tasks.find((item) => item.id === 'T3').stack.parent, 'T2');
      automaticNote(f);
      if (childState === 'OPEN' && checkout === 'present') {
        const claim = task(f).claim;
        if (claim) f.h.ok(['release', 'T2', '--agent', claim.agent, '--reason', 'probe worker finished']);
        f.h.ok(['check', 'ci', 'T3']);
        f.h.ok(['stack', 'sync', 'T2']);
        assert.equal(task(f).stack.base, 'main', 'later synchronization preserves the verified dispatch base');
        assert.equal(f.h.readState('tasks.json').tasks.find((item) => item.id === 'T3').stack.base, previous.branch);
      }
    });
  }
}

for (const upperState of ['todo', 'submitted']) {
  for (const middleStatus of ['submitted', 'accepted']) {
    for (const entry of ['merge', 'observer']) {
      test(`${middleStatus} middle PR closed on base deletion recovers by ${entry} with a ${upperState} task above`, (t) => {
        const f = setup(t);
        middle(f, upperState, middleStatus);
        const previous = task(f);
        f.write((d) => {
          d.closeOnDelete = true;
          d.prs[12].title = 'middle title';
          d.prs[12].body = 'middle description';
          if (entry === 'observer') d.createError = 'temporary replacement failure';
        });
        f.h.ok(['merge', 'T1']);
        if (entry === 'observer') {
          assert.equal(task(f).pr, 12);
          assert.equal(task(f).stack.base, f.lower.branch);
          f.write((d) => { delete d.createError; });
          // wait-allow: zero timeout requests one observation pass, not a readiness wait
          f.h.run(['wait', '--after', '0', '--types', 'never', '--observe', '--timeout', '0']);
        }
        const current = task(f);
        const pr = f.read().prs[current.pr];
        assert.notEqual(current.pr, 12);
        assert.equal(pr.state, 'OPEN');
        assert.equal(pr.baseRefName, 'main');
        assert.equal(pr.headRefOid, previous.sha);
        assert.equal(pr.headRefName, previous.branch);
        assert.equal(pr.title, 'middle title');
        assert.equal(pr.body, 'middle description');
        assert.equal(current.stack.parent, 'T1', 'the upper chain retains its lower lineage');
        assert.equal(current.stack.base, 'main');
        assert.equal(current.revision, previous.revision + 1);
        assert.equal(current.status, 'submitted');
        assert.equal(current.stack.linked, false);
        assert.equal(current.stack_disabled, true);
        assert.equal(f.h.readState('tasks.json').tasks.find((item) => item.id === 'T3').stack.parent, 'T2');
        assert.ok(events(f).some((e) => e.task === 'T2' && e.cmd === 'stack base' && e.detail.base === 'main'));
        automaticNote(f);
        if (entry === 'merge' && middleStatus === 'accepted') {
          f.accept('T2');
          const merged = f.h.json(['merge', 'T2']);
          assert.equal(merged.ok, true, merged.summary);
        }
      });
    }
  }
  for (const source of ['audited', 'remote-squash', 'remote-merge']) {
    test(`middle dispatch uses main after ${source.replace('remote-', 'remote ')} parent merge with a ${upperState} task above`, (t) => {
      const f = setup(t);
      middle(f, upperState, 'accepted');
      const previous = task(f);
      if (source === 'audited') f.h.ok(['merge', 'T1']);
      else remoteMerge(f, source.slice('remote-'.length));
      assert.equal(f.h.git(['ls-remote', '--heads', 'origin', f.lower.branch]), '');
      f.h.ok(['rework', 'T2', '--reason', 'continue middle work']);
      probeWorker(f);
      f.h.ok(['spawn', '--task', 'T2', '--wait']);
      const dispatched = JSON.parse(fs.readFileSync(path.join(f.h.base, 'dispatch.json'), 'utf8'));
      assert.equal(dispatched.task.stack.base, 'main');
      assert.equal(dispatched.task.stack.parent, 'T1');
      assert.match(dispatched.prompt, /Its PR targets main/);
      assert.doesNotMatch(dispatched.prompt, /--base tower-crane\/T1/);
      assert.equal(S.loadState(f.h.state).tasks.tasks.find((item) => item.id === 'T3').stack.parent, 'T2');
      assert.equal(require('../lib/stack').targetBase(S.loadState(f.h.state), task(f)), 'main');
      assert.equal(f.h.git(['rev-parse', previous.branch]), previous.sha, 'dispatch preserves the middle commits');
      assert.equal(f.read().prs[12].baseRefName, 'main');
      automaticNote(f);
    });
  }
}

test('a recreated unlinked middle checkout preserves its project base and lineage', (t) => {
  const f = setup(t);
  middle(f, 'todo', 'accepted', false, false);
  const wt = f.h.json(['worktree', 'T2']);
  const previous = task(f);
  f.h.ok(['merge', 'T1']);
  assert.equal(task(f).stack.base, 'main');
  assert.equal(task(f).stack.linked, false);
  assert.equal(task(f).stack_disabled, undefined);
  f.h.ok(['rework', 'T2', '--reason', 'continue unlinked middle work']);
  f.h.git(['worktree', 'remove', '--force', wt.path]);
  f.h.git(['branch', '-D', previous.branch]);
  probeWorker(f);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
  const dispatched = JSON.parse(fs.readFileSync(path.join(f.h.base, 'dispatch.json'), 'utf8'));
  assert.equal(dispatched.task.stack.base, 'main');
  assert.equal(dispatched.task.stack.parent, 'T1');
  assert.equal(f.h.git(['rev-parse', previous.branch]), previous.sha);
  assert.equal(f.h.readState('tasks.json').tasks.find((item) => item.id === 'T3').stack.parent, 'T2');
});

for (const mismatch of ['head', 'base', 'repository', 'auto-merge']) {
  test(`closed middle PR recovery refuses a different ${mismatch} before a PR write`, (t) => {
    const f = setup(t);
    middle(f, 'todo', 'submitted');
    f.write((d) => {
      d.closeOnDelete = true;
      if (mismatch === 'head') d.prs[12].headRefOid = 'a'.repeat(40);
      if (mismatch === 'base') {
        d.prs[12].baseRefName = 'unrelated';
        d.prs[12].state = 'CLOSED';
      }
      if (mismatch === 'repository') d.prs[12].isCrossRepository = true;
      if (mismatch === 'auto-merge') d.prs[12].autoMergeRequest = { enabledAt: '2026-10-19T00:00:00Z' };
      d.calls = [];
    });
    f.h.ok(['merge', 'T1']);
    assert.equal(task(f).pr, 12);
    assert.equal(task(f).stack.base, f.lower.branch);
    assert.ok(events(f).some((e) => e.task === 'T2' && e.cmd === 'stack sync deferred'
      && /stack PR must target/.test(e.detail.reason)));
    assert.equal(f.read().calls.some((c) => c.args[0] === 'pr' && ['create', 'edit'].includes(c.args[1])), false);
  });
}
