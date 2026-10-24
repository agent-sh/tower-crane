'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, upper, resubmit } = require('./stack-fixture');
const { events, inspector, reviewProbe, child } = require('./stack-parent-helpers');
const Stack = require('../lib/stack');
const Check = require('../lib/check');

// Stacked children whose parent has a newer head: snapshots, review verdicts first, dirty checkouts.

test('acceptance and review parent snapshots detect a newer submission at application', () => {
  for (const operation of ['accept', 'review']) {
    for (const change of ['unchanged', 'claim', 'sha', 'parent', 'missing sha']) {
      const dep = { id: 'T1', sha: 'a'.repeat(40), revision: 1, status: 'submitted', evidence: [] };
      const other = { ...dep, id: 'T3', sha: 'b'.repeat(40), evidence: [] };
      const child = { id: 'T2', stack: { parent: 'T1' } };
      const st = { tasks: { tasks: [dep, child, other] }, events: [] };
      const expected = Check.parentHeadInputs(st, child);
      if (change === 'claim') dep.status = 'in_progress';
      if (change === 'sha') dep.sha = 'c'.repeat(40);
      if (change === 'parent') child.stack.parent = 'T3';
      if (change === 'missing sha') dep.sha = null;
      if (['unchanged', 'claim'].includes(change)) Check.validateParentHead(st, child, expected, operation);
      else assert.throws(() => Check.validateParentHead(st, child, expected, operation), /parent head changed/);
    }
  }
});

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

function failReview(f, top, kind = 'code') {
  const ref = 'https://github.com/acme/app/pull/12#issuecomment-501';
  const file = kind === 'changelog' ? 'changelog.d/T2.md' : 'lib/child.js';
  const body = `Review (Tower Crane)\nSHA: ${top.sha}\nVerdict: FAIL\n${file}:1 - fix the finding`;
  f.write((data) => { data.comments = kind === 'missing' ? [] : [{ id: 501, body, html_url: ref }]; });
  f.h.ok(['evidence', 'T2', '--type', 'review', '--fail', '--sha', top.sha, '--revision', '1',
    '--summary', body, '--ref', ref, '--findings', JSON.stringify([
      { kind: kind === 'changelog' ? 'false-claim' : 'defect', path: file, claim: 'fix the finding' },
    ])]);
}

// A review spawn sends a task with a current failed review to rework. accept does not
// rework it or start another review at that head: it stays submitted and the
// orchestrator's inbox offers the rework (docs/state/gates.md).
function assertFailedReviewHandled(f, entry, task) {
  if (entry === 'review spawn') {
    assert.equal(task.status, 'rework');
    const rework = events(f).findLast((e) => e.task === 'T2' && e.cmd === 'rework');
    assert.equal(rework.detail.from_review, true);
    assert.equal(rework.detail.previous_revision, 1);
    return;
  }
  assert.deepEqual([task.status, task.revision], ['submitted', 1]);
  assert.equal(events(f).some((e) => e.task === 'T2' && e.cmd === 'rework'), false);
  const item = f.h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.id === 'review_failed:T2');
  assert.deepEqual(item?.action.argv, ['rework', '--from-review', 'T2']);
}

function reviewEntry(f, entry) {
  return f.h.run(entry === 'review spawn' ? ['spawn', '--task', 'T2', '--role', 'review', '--wait']
    : ['accept', 'T2', ...(entry === 'waived accept' ? ['--waive', 'review', '--reason', 'offline fixture'] : [])]);
}

for (const entry of ['accept', 'waived accept', 'review spawn']) {
  for (const parentStatus of ['submitted', 'accepted', 'rework', 'in_progress']) {
    test(`current FAIL takes precedence over parent ${parentStatus} in ${entry}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      f.h.ok(['check', 'ci', 'T2']);
      failReview(f, top);
      resubmit(f, false);
      if (parentStatus === 'accepted') f.accept('T1');
      if (['rework', 'in_progress'].includes(parentStatus)) f.h.ok(['rework', 'T1', '--reason', 'parent continues']);
      if (parentStatus === 'in_progress') f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
      const before = f.h.readState('tasks.json').tasks.find((task) => task.id === 'T2');
      const offset = events(f).length;
      const result = reviewEntry(f, entry);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /current review FAIL/);
      const task = f.h.json(['task', 'show', 'T2']);
      assertFailedReviewHandled(f, entry, task);
      if (entry !== 'review spawn') {
        assert.deepEqual(f.h.readState('tasks.json').tasks.find((task) => task.id === 'T2'), before,
          'accept holds the failed submission, including its verdict and revision');
        assert.deepEqual(events(f).slice(offset).filter((event) => event.task === 'T2'), [],
          'refusal neither refreshes the parent nor records a waiver or another review');
      }
      assert.equal(task.stack.parent_sha, f.sha, 'failed review takes precedence over parent synchronization');
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const entry of ['accept', 'waived accept', 'review spawn']) {
  for (const kind of ['changelog', 'missing']) {
    test(`current FAIL ${kind} findings are handled before refresh in ${entry}`, (t) => {
      const f = setup(t);
      const top = upper(f);
      f.h.ok(['check', 'ci', 'T2']);
      failReview(f, top, kind);
      resubmit(f, false);
      const before = f.h.readState('tasks.json').tasks.find((task) => task.id === 'T2');
      const offset = events(f).length;
      const result = reviewEntry(f, entry);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const task = f.h.json(['task', 'show', 'T2']);
      if (entry !== 'review spawn') {
        assert.match(result.stdout + result.stderr, /current review FAIL/);
        assertFailedReviewHandled(f, entry, task);
        assert.deepEqual(f.h.readState('tasks.json').tasks.find((task) => task.id === 'T2'), before,
          'accept retains failed findings without fetching them or refreshing the parent');
        assert.deepEqual(events(f).slice(offset).filter((event) => event.task === 'T2'), []);
      } else if (kind === 'missing') {
        assert.equal(task.status, 'submitted');
        assert.match(result.stderr, /linked review comment/);
      } else {
        assertFailedReviewHandled(f, entry, task);
      }
      assert.equal(task.stack.parent_sha, f.sha);
      assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
    });
  }
}

for (const status of ['todo', 'rework', 'in_progress']) {
  for (const newer of [false, true]) {
    test(`unsubmitted ${status} review preview ignores ${newer ? 'newer' : 'current'} parent ancestry`, (t) => {
      const f = setup(t);
      if (status === 'rework') {
        upper(f);
        f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      } else f.h.ok(['worktree', 'T2']);
      if (status === 'in_progress') f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
      if (newer) resubmit(f, false);
      reviewProbe(f);
      const before = f.h.json(['task', 'show', 'T2']);
      const offset = events(f).length;
      const result = f.h.run(['spawn', '--task', 'T2', '--role', 'review', '--dry-run', '--json']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(JSON.parse(result.stdout).argv, 'fallback command is previewed');
      assert.deepEqual(f.h.json(['task', 'show', 'T2']), before);
      assert.equal(events(f).length, offset, 'preview publishes no state');
    });
  }
}

for (const linked of [false, true]) {
  for (const [dirty, timing] of [['unstaged', 'before'], ['staged', 'before'], ['untracked', 'before'], ['untracked', 'during merge']]) {
    test(`dirty ${dirty} ${linked ? 'linked' : 'prepared'} child defers its parent refresh and dispatches (${timing})`, (t) => {
      const f = setup(t);
      let top;
      if (linked) {
        top = upper(f);
        f.h.ok(['rework', 'T2', '--reason', 'child continues']);
      } else top = child(f, false, false);
      const parent = resubmit(f, false);
      const name = dirty === 'untracked' ? 'pending.txt' : linked ? 'T2.txt' : 'child.txt';
      if (timing === 'during merge') f.h.env.TEST_STACK_DIRTY_AFTER_MERGE = path.join(top.wt.path, name);
      else fs.writeFileSync(path.join(top.wt.path, name), 'pending edits\n');
      if (dirty === 'staged') f.h.git(['add', name], top.wt.path);
      const status = f.h.git(['status', '--porcelain'], top.wt.path);
      const inspect = inspector(f);
      const result = f.h.run(['spawn', '--task', 'T2', '--wait', '--json']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(inspect().head, top.sha);
      assert.match(inspect().prompt, new RegExp(parent));
      assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), timing === 'during merge' ? `?? ${name}` : status);
      assert.equal(fs.readFileSync(path.join(top.wt.path, name), 'utf8'), 'pending edits\n');
      assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, f.sha);
      const gate = f.h.run(['check', 'ci', 'T2']);
      assert.equal(gate.code, 1);
      assert.match(gate.stderr, new RegExp(`containing T1 at ${parent}`));
    });
  }
}

for (const status of ['submitted', 'accepted']) {
  for (const dirty of ['unstaged', 'staged', 'untracked']) {
    for (const entry of ['accept', 'check clean']) {
      if (status === 'accepted' && entry === 'accept') continue;
      test(`dirty ${status} child schedules rework through ${entry} with ${dirty} edits`, (t) => {
        const f = setup(t);
        const top = upper(f);
        if (status === 'accepted') f.accept('T2');
        const file = dirty === 'untracked' ? 'pr-body.md' : 'T2.txt';
        fs.writeFileSync(path.join(top.wt.path, file), 'pending edits\n');
        if (dirty === 'staged') f.h.git(['add', file], top.wt.path);
        const before = f.h.git(['status', '--porcelain'], top.wt.path);
        const parent = resubmit(f, false);
        const args = entry === 'accept' ? ['accept', 'T2'] : ['check', 'clean', 'T2'];
        const result = f.h.run(args);
        assert.equal(result.code, 1, result.stdout + result.stderr);
        const task = f.h.json(['task', 'show', 'T2']);
        assert.equal(task.status, 'rework', 'a completed submission needs a worker to recover');
        assert.equal(task.revision, 2);
        assert.equal(task.sha, top.sha);
        assert.equal(task.stack.parent_sha, f.sha);
        assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
        assert.equal(f.h.git(['status', '--porcelain'], top.wt.path), before);
        const reworks = () => events(f).filter((e) => e.task === 'T2' && e.cmd === 'rework');
        assert.equal(reworks().length, 1);
        assert.match(reworks()[0].detail.reason, new RegExp(parent));
        const named = `submitted ${parent}`;
        assert.equal(task.notes.filter((n) => n.text.includes(named)).length, 1, 'the reason is noted once');
        assert.equal(f.h.run(['brief', 'get', 'T2']).stdout.split(named).length - 1, 1, 'the brief names the reason once');
        f.h.run(['check', 'clean', 'T2']);
        assert.equal(reworks().length, 1, 'repeated gates do not advance rework again');
        const inbox = f.h.json(['inbox', '--agent', 'orchestrator']);
        assert.ok(inbox.items.some((item) => item.task === 'T2' && item.kind === 'rework_ready'));
        const inspect = inspector(f);
        const dispatched = f.h.run(['spawn', '--task', 'T2', '--wait']);
        assert.equal(dispatched.code, 0, dispatched.stdout + dispatched.stderr);
        assert.equal(inspect().head, top.sha);
        assert.match(inspect().prompt, new RegExp(parent));
        assert.equal(fs.readFileSync(path.join(top.wt.path, file), 'utf8'), 'pending edits\n');
        const gate = f.h.run(['check', 'ci', 'T2']);
        assert.equal(gate.code, 1);
        assert.match(gate.stderr, new RegExp(`containing T1 at ${parent}`));
      });
    }
  }
}

for (const status of ['submitted', 'accepted']) {
  test(`an existing dirty deferral still schedules a ${status} child for rework`, (t) => {
    const f = setup(t);
    const top = upper(f);
    if (status === 'accepted') f.accept('T2');
    fs.writeFileSync(path.join(top.wt.path, 'pr-body.md'), 'pending edits\n');
    const parent = resubmit(f, false);
    // A prior pass may have recorded the receipt before submission completed.
    fs.appendFileSync(path.join(f.h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), agent: 'orchestrator', cmd: 'stack sync deferred', task: 'T2',
      detail: { parent: 'T1', parent_sha: parent, failure: 'dirty', reason: 'prior dirty deferral' },
    }) + '\n');
    f.h.run(['check', 'clean', 'T2']);
    assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
    const deferred = events(f).filter((e) => e.task === 'T2' && e.cmd === 'stack sync deferred');
    assert.equal(deferred.length, 1, 'the recovery does not duplicate its receipt');
    assert.equal(events(f).filter((e) => e.task === 'T2' && e.cmd === 'rework').length, 1);
    assert.equal(f.h.git(['rev-parse', 'HEAD'], top.wt.path), top.sha);
  });
}
