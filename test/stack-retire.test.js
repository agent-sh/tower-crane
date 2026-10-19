'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper } = require('./stack-fixture');
const { HUNG_TEST_MS } = require('./signals');

const task = (f) => f.h.readState('tasks.json').tasks.find((t) => t.id === 'T2');
const events = (f) => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function remoteMerge(f, method) {
  const base = f.h.git(['rev-parse', 'origin/main']);
  const tree = f.h.git(['rev-parse', `${f.sha}^{tree}`]);
  const sha = f.h.git(['commit-tree', tree, '-p', base, ...(method === 'merge' ? ['-p', f.sha] : []), '-m', 'land parent']);
  f.h.git(['push', 'origin', `${sha}:main`, `:${f.lower.branch}`]);
  f.write((d) => { d.prs[11].state = 'MERGED'; d.prs[11].mergeCommit = { oid: sha }; });
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
