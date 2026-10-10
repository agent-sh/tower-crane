'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, stacked } = require('./stack-fixture');

// Every merge request the stub received, as 'pr N' for gh pr merge, 'async N' for
// GitHub's asynchronous merge API and 'stack N' for gh stack merge.
const merges = (f) => f.read().calls.flatMap((c) => {
  if (['pr', 'stack'].includes(c.args[0]) && c.args[1] === 'merge') return [{ route: `${c.args[0]} ${c.args[2]}`, args: c.args }];
  const post = c.args[0] === 'api' && c.args.includes('POST') && /pulls\/(\d+)\/merge-async$/.exec(c.args[1]);
  return post ? [{ route: `async ${post[1]}`, args: c.args }] : [];
});
const routes = (f) => merges(f).map((m) => m.route);

test('a stack that adds then modifies the same file merges without changing accepted heads', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  fs.writeFileSync(path.join(wt.path, 'T1.txt'), 'T2 modified T1\n');
  f.h.git(['add', 'T1.txt'], wt.path);
  const upper = f.submit('T2', 12, wt);
  f.h.ok(['stack', 'link', 'T2']);
  f.accept('T1');
  f.accept('T2');
  const merged = f.h.run(['merge', 'T2']);
  assert.equal(merged.code, 0, `${merged.stdout}\n${merged.stderr}`);
  const data = f.read();
  for (const [pr, head] of [[11, f.sha], [12, upper]]) {
    assert.equal(data.prs[pr].state, 'MERGED');
    assert.equal(data.prs[pr].headRefOid, head);
    assert.notEqual(data.prs[pr].mergeCommit.oid, head);
    assert.equal(f.h.git(['merge-base', head, 'origin/main']), head);
  }
  assert.equal(f.h.git(['show', 'origin/main:T1.txt']), 'T2 modified T1');
  assert.equal(f.h.git(['rev-parse', wt.branch]), upper);
  assert.ok(!fs.existsSync(wt.path), 'the merged task worktree is removed');
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('M4: a head pushed after the last stack check cannot land', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  fs.writeFileSync(path.join(f.lower.path, 'unaccepted.txt'), 'unaccepted\n');
  f.h.git(['add', 'unaccepted.txt'], f.lower.path);
  f.h.git(['commit', '-qm', 'unaccepted work'], f.lower.path);
  f.h.git(['push', 'origin', f.lower.branch], f.lower.path);
  const moved = f.h.git(['rev-parse', 'HEAD'], f.lower.path);
  const base = f.h.git(['ls-remote', 'origin', 'refs/heads/main']);
  f.write((d) => { d.moveOnMerge = { pr: 11, head: moved }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  const data = f.read();
  assert.equal(data.prs[11].headRefOid, moved);
  assert.equal(data.prs[11].state, 'OPEN', 'the moved head must be refused before merging');
  assert.equal(data.prs[12].state, 'OPEN');
  assert.equal(f.h.git(['ls-remote', 'origin', 'refs/heads/main']), base);
  for (const id of ['T1', 'T2']) {
    assert.equal(f.h.json(['task', 'show', id]).evidence.some((e) => e.type === 'merge' && e.ok), false);
  }
});

test('a later head race stops the chain and records only the accepted lower merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  fs.writeFileSync(path.join(f.upper.wt.path, 'unaccepted.txt'), 'unaccepted\n');
  f.h.git(['add', 'unaccepted.txt'], f.upper.wt.path);
  f.h.git(['commit', '-qm', 'unaccepted upper work'], f.upper.wt.path);
  f.h.git(['push', 'origin', f.upper.wt.branch], f.upper.wt.path);
  const moved = f.h.git(['rev-parse', 'HEAD'], f.upper.wt.path);
  f.write((d) => { d.moveOnMerge = { pr: 12, head: moved, onPr: 12 }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Head branch was modified/);
  const data = f.read();
  assert.equal(data.prs[11].state, 'MERGED');
  assert.equal(data.prs[11].headRefOid, f.sha);
  assert.equal(data.prs[12].state, 'OPEN');
  assert.equal(f.h.git(['rev-parse', 'origin/main']), data.prs[11].mergeCommit.oid);
  assert.equal(f.h.git(['merge-base', f.sha, 'origin/main']), f.sha);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge' && e.ok), false);
});

test('an unlinked dependent targets main and merges normally when its lower PR merges before submission', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
  fs.writeFileSync(path.join(wt.path, 'T2.txt'), 'T2\n');
  f.h.git(['add', 'T2.txt'], wt.path);
  f.h.git(['commit', '-qm', 'upper work'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  const sha = f.h.git(['rev-parse', 'HEAD'], wt.path);
  f.write((d) => {
    d.prs[12] = { number: 12, state: 'OPEN', headRefOid: sha, headRefName: wt.branch,
      baseRefName: f.lower.branch, isCrossRepository: false, autoMergeRequest: null };
  });
  f.accept('T1');
  f.h.ok(['merge', 'T1']);
  const squash = f.read().prs[11].mergeCommit.oid;
  assert.notEqual(squash, f.sha);
  assert.equal(f.h.git(['show', '-s', '--format=%P', squash]).split(' ').length, 1);
  assert.notEqual(f.h.git(['merge-base', f.sha, squash]), f.sha);
  assert.equal(f.h.git(['ls-remote', '--heads', 'origin', f.lower.branch]), '');
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, false);
  f.h.ok(['submit', 'T2', '--sha', sha, '--branch', wt.branch, '--pr', '12', '--agent', 'worker-T2']);
  f.h.ok(['stack', 'link', 'T2']);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(f.read().prs[12].baseRefName, 'main');
  assert.equal(task.stack, undefined);
  assert.equal(task.sha, sha);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  f.accept('T2');
  f.h.ok(['merge', 'T2']);
  const evidence = f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge');
  assert.equal(evidence.ok, true);
  assert.ok(evidence.commands.some((c) => c.args[0] === 'pr' && c.args[1] === 'merge' && c.args.includes('--match-head-commit')));
  assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && ['link', 'sync', 'merge'].includes(c.args[1])), false);
});

test('stack merge rechecks every accepted head and records evidence for all merged tasks', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.prs[11].headRefOid = 'a'.repeat(40); });
  const moved = f.h.run(['merge', 'T2']);
  assert.equal(moved.code, 1);
  assert.match(moved.stdout, /T1: PR head moved/);
  assert.deepEqual(routes(f), []);
  f.write((d) => { d.prs[11].headRefOid = f.sha; });
  f.h.ok(['merge', 'T2', '--method', 'merge']);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
  for (const [index, head] of [f.sha, f.upper.sha].entries()) {
    const { args } = merges(f)[index];
    assert.ok(args.includes(`expected_head_sha=${head}`));
    assert.ok(args.includes('merge_method=merge'));
  }
  const polls = f.read().calls.filter((c) => c.args[0] === 'api' && /merge-async\/m\d+$/.test(c.args[1]));
  assert.deepEqual(polls.map((c) => c.args[1].match(/pulls\/(\d+)/)[1]), ['11', '12']);
  assert.equal(f.read().prs[12].baseRefName, 'main');
  for (const [id, head] of [['T1', f.sha], ['T2', f.upper.sha]]) {
    const task = f.h.json(['task', 'show', id]);
    const evidence = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(evidence.ok, true);
    assert.ok(evidence.commands.some((c) => c.args[0] === 'api' && c.args.includes(`expected_head_sha=${head}`)));
    assert.match(task.phase?.label || f.h.ok(['task', 'show', id]), /merged/);
  }
  const upper = f.h.git(['rev-parse', 'HEAD'], f.h.json(['worktree', 'T2']).path);
  assert.equal(f.h.git(['merge-base', upper, 'origin/main']), upper);
  assert.equal(f.h.git(['rev-parse', 'origin/main^{tree}']), f.h.git(['rev-parse', `${upper}^{tree}`]));
  f.write((d) => { d.linked = false; });
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(routes(f).length, 2);
});

test('an unaccepted lower task, unknown remote lower PR, or auto-merge prevents stack merge', (t) => {
  const f = stacked(t);
  f.accept('T2');
  // Passing gate receipts do not authorize merging a still-submitted lower task.
  f.write((d) => { Object.assign(d.prs[11], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); });
  const ci = f.h.run(['check', 'ci', 'T1']);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  f.h.reviewer('T1', 'independent-reviewer', f.sha);
  f.h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', f.sha, '--agent', 'independent-reviewer', '--summary', 'checked']);
  const lower = f.h.json(['task', 'show', 'T1']);
  assert.equal(lower.status, 'submitted');
  assert.equal(lower.gates.ok, true, 'passing receipts still need an acceptance');
  f.write((d) => { d.calls = []; });
  assert.match(f.h.run(['merge', 'T2']).stdout, /T1: every lower task must be accepted with passing gates/);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'),
    'an unaccepted member stops the merge after reading the target, which may already have landed; nothing merges or retargets');
  f.accept('T1');
  f.write((d) => { d.order.unshift(99); });
  assert.match(f.h.run(['merge', 'T2']).stdout, /untracked lower PR/);
  assert.match(f.h.run(['stack', 'sync', 'T2']).stderr, /untracked PRs/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'sync'), false);
  f.write((d) => { d.order.shift(); d.prs[11].autoMergeRequest = {}; });
  assert.match(f.h.run(['merge', 'T2']).stdout, /without auto-merge/);
  assert.deepEqual(routes(f), []);
});

test('queued stack merges are not evidence of a merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.queued = true; });
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false);
  let base = f.h.git(['rev-parse', 'origin/main']);
  f.write((d) => {
    d.linked = false;
    for (const pr of Object.values(d.prs)) {
      const tree = f.h.git(['rev-parse', `${pr.headRefOid}^{tree}`]);
      base = f.h.git(['commit-tree', tree, '-p', base, '-p', pr.headRefOid, '-m', `Queued merge PR #${pr.number}`]);
      pr.state = 'MERGED';
      pr.mergeCommit = { oid: base };
    }
  });
  f.h.git(['push', 'origin', `${base}:main`]);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false, 'confirming the upper task records nothing for the lower one');
  f.h.ok(['merge', 'T1']);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.deepEqual(routes(f), ['async 11']);
});

test('an asynchronous merge that GitHub reports failed stops the chain after the confirmed lower merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.asyncFail = 12; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /asynchronous merge of PR #12 ended failed: Merge conflict in T2\.txt/);
  assert.equal(f.read().prs[11].state, 'MERGED');
  assert.equal(f.read().prs[12].state, 'OPEN');
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge' && e.ok), false);
});

test('a failed asynchronous POST without a job id reports the refusal after checking the PR', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.asyncResponses = { 11: {
      post: { body: { status: 'failed', error: 'Required review is missing' } },
      views: [{ advanceMs: 10 * 60 * 1000 + 1 }],
    } };
  });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /asynchronous merge of PR #11 ended failed: Required review is missing/);
  assert.doesNotMatch(r.stdout, /may be in a merge queue/);
  assert.deepEqual(routes(f), ['async 11']);
  const data = f.read();
  assert.equal(data.asyncResponses[11].views.length, 0, 'the PR was read before reporting the refusal');
  assert.equal(data.calls.some((c) => c.args[0] === 'api' && /merge-async\//.test(c.args[1])), false);
  for (const id of ['T1', 'T2']) {
    assert.equal(f.h.json(['task', 'show', id]).evidence.some((e) => e.type === 'merge' && e.ok), false);
  }
});

for (const unread of [false, true]) {
  test(`a failed job survives a PR read error and a retired status endpoint${unread ? ' while confirmation stays unavailable' : ''}`, (t) => {
    const f = stacked(t);
    f.accept('T1');
    f.accept('T2');
    const readError = { code: 1, error: 'gh: Server Error (HTTP 502)' };
    f.write((d) => {
      d.asyncResponses = { 12: {
        polls: [
          { body: { status: 'failed', error: 'Merge conflict in T2.txt' } },
          { code: 1, error: 'gh: Not Found (HTTP 404)', advanceMs: 10 * 60 * 1000 + 1 },
        ],
        views: unread ? [readError, readError] : [readError],
      } };
    });
    const r = f.h.run(['merge', 'T2']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /asynchronous merge of PR #12 ended failed: Merge conflict in T2\.txt/);
    assert.doesNotMatch(r.stdout, /may be in a merge queue/);
    assert.deepEqual(routes(f), ['async 11', 'async 12']);
    const data = f.read();
    assert.equal(data.asyncResponses[12].polls.length, 0);
    assert.equal(data.asyncResponses[12].views.length, 0);
    assert.equal(data.prs[12].state, 'OPEN');
    assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
    assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge' && e.ok), false);
  });
}

test('a confirmed accepted merge takes precedence over a retained terminal failure', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.asyncResponses = { 11: {
      post: { body: { status: 'failed', message: 'Merge was cancelled' } },
      views: [{ code: 1, error: 'gh: Server Error (HTTP 502)' }, { merge: true }],
    } };
  });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('failed status polls defer to the PR state: a 5xx waits, a 404 after the merge landed confirms it', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.pollFailures = { 11: ['gh: Server Error (HTTP 502)'], 12: ['gh: Not Found (HTTP 404)'] }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
  const data = f.read();
  for (const pr of [11, 12]) assert.equal(data.prs[pr].state, 'MERGED');
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('a PR still open after the bounded wait fails with the last poll error', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.queued = true; d.pollFailures = { 11: ['gh: Server Error (HTTP 502)'] }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /PR #11 is not merged 10 minutes after .*last status poll failed: gh: Server Error \(HTTP 502\)/);
  assert.equal(f.read().prs[11].state, 'OPEN');
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge' && e.ok), false);
});

test('linked stacks refuse squash and rebase to preserve accepted dependency ancestry', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  for (const method of ['squash', 'rebase']) {
    const r = f.h.run(['merge', 'T2', '--method', method]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /stack merges use merge commits/);
  }
  assert.deepEqual(routes(f), []);
});

test('a refused upper merge retains lower evidence and retries without merging the lower PR again', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.refuseMergePr = 12; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Base branch policy prohibits the merge/);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.read().prs[12].baseRefName, 'main');
  assert.equal(f.read().prs[12].state, 'OPEN');
  f.write((d) => { delete d.refuseMergePr; });
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(routes(f), ['async 11', 'async 12', 'async 12']);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
});

for (const [setting, cli] of [['base', ['project', 'set', '--base', 'release']], ['admin', ['project', 'set', '--merge-admin', 'true']]]) {
  test(`a project ${setting} change during the final head checks stops the stack merge`, (t) => {
    const f = stacked(t);
    f.accept('T1');
    f.accept('T2');
    f.write((d) => { d.during = { 'pr view': [cli] }; });
    const r = f.h.run(['merge', 'T2']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /changed during stack head checks/);
    assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'), false);
  });
}

test('a task changed during the lower merge stops before the upper merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.during = { 'merge-async': [['rework', 'T2', '--reason', 'another worker takes over'], ['claim', 'T2', '--agent', 'worker-new']] };
  });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed during stack head checks/);
  assert.deepEqual(routes(f), ['async 11']);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.claim.agent, 'worker-new');
  assert.equal(task.stack.linked, true);
  assert.equal(task.stack_disabled, undefined);
  assert.equal(f.h.json(['task', 'show', 'T1']).stack_disabled, undefined);
});

test('a bottom PR with a stale local link to its dependent merges through the asynchronous merge API pinned to its head', (t) => {
  const f = stacked(t);
  f.accept('T1');
  const state = f.h.readState('tasks.json');
  state.tasks.find((item) => item.id === 'T2').stack.linked = false;
  f.h.writeState('tasks.json', state);

  const r = f.h.run(['merge', 'T1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(f.read().prs[11].state, 'MERGED');
  const merge = f.read().calls.find((c) => c.args[0] === 'api' && c.args.includes('POST') && /pulls\/11\/merge-async$/.test(c.args[1]));
  assert.ok(merge, 'the bottom PR merges through the asynchronous merge API');
  assert.ok(merge.args.includes(`expected_head_sha=${f.sha}`), 'the merge pins the accepted head');
  assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'), false);
});

test('after a lower stack merge, a dependent whose head GitHub moved takes the new head and needs its gates again', (t) => {
  const f = stacked(t);
  f.accept('T1');
  const wt = f.upper.wt;
  f.h.git(['commit', '--allow-empty', '-qm', 'T2 rebased onto main'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  const rebased = f.h.git(['rev-parse', 'HEAD'], wt.path);
  f.write((d) => { d.rebased = { 12: rebased }; });

  const r = f.h.run(['merge', 'T1']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.sha, rebased);
  assert.equal(task.status, 'submitted');
});

test('merging a stacked task whose head GitHub rebases after its lower PR merges returns it to submitted at the new head', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  const wt = f.upper.wt;
  f.h.git(['commit', '--allow-empty', '-qm', 'T2 rebased onto main'], wt.path);
  f.h.git(['push', 'origin', wt.branch], wt.path);
  const rebased = f.h.git(['rev-parse', 'HEAD'], wt.path);
  f.write((d) => { d.rebased = { 12: rebased }; });

  const r = f.h.run(['merge', 'T2']);
  assert.notEqual(r.code, 0, r.stdout + r.stderr);
  assert.equal(f.read().prs[11].state, 'MERGED');
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.sha, rebased);
  assert.equal(task.status, 'submitted');
});

// The hook binding a spawned worker writes into its own agent home.
function hookCall(f, id, action = 'tool') {
  const home = path.join(f.h.state, 'homes', `worker-${id}`);
  fs.mkdirSync(home, { recursive: true });
  const binding = path.join(home, 'hook.json');
  fs.writeFileSync(binding, JSON.stringify({ agent: `worker-${id}`, task: id, state: f.h.state, harness: 'codex', attempt: 1 }) + '\n');
  return ['hook', action, '--binding', binding, '--agent', `worker-${id}`];
}

test('unrelated workers logging hook progress and notes during the final head checks do not stop the stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.add('unrelated');
  f.write((d) => { d.during = { 'pr view': [hookCall(f, 'T3'), ['task', 'note', 'T3', 'progress', '--agent', 'worker-T3']] }; });
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('stack members logging hook progress during the final head checks do not stop the stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.during = { 'pr view': [hookCall(f, 'T2')] }; });
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
});

test('a stack member stopping during the final head checks does not stop the stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.during = { 'pr view': [hookCall(f, 'T2', 'stop')] }; });
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(routes(f), ['async 11', 'async 12']);
  // The stop emits its own orchestrator notice; the merge passed with that notice in the log.
  const log = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some((e) => e.cmd === 'hook stop' && e.agent === 'worker-T2'));
  assert.ok(log.some((e) => e.cmd === 'msg' && e.agent === 'worker-T2' && e.detail.to === 'orchestrator'));
});

test('an ordinary message from a stack member during the final head checks still stops the stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.during = { 'pr view': [['msg', '--to', 'orchestrator', 'still working', '--task', 'T1', '--agent', 'worker-T1']] } });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed during stack head checks/);
  assert.deepEqual(routes(f), []);
});

test('a member event during the final head checks still stops the stack merge', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.during = { 'pr view': [['task', 'note', 'T1', 'progress', '--agent', 'worker-T1']] }; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed during stack head checks/);
  assert.deepEqual(routes(f), []);
});

test('three dependent PRs form one stack and all accepted lower tasks get merge evidence', (t) => {
  const f = stacked(t);
  f.add('third', 'T2');
  const wt = f.h.json(['worktree', 'T3']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.json(['task', 'show', 'T2']).sha);
  f.submit('T3', 13, wt);
  f.h.ok(['stack', 'link', 'T3']);
  assert.deepEqual(f.read().order, [11, 12, 13]);
  for (const id of ['T1', 'T2', 'T3']) f.accept(id);
  f.h.ok(['merge', 'T3']);
  for (const id of ['T1', 'T2', 'T3']) {
    assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
  }
});

test('admin merge requires unstacking, then lower tasks land before upper PRs target main', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['project', 'set', '--merge-admin', 'true']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /cannot use --admin/);
  assert.deepEqual(routes(f), []);
  f.h.ok(['stack', 'unstack', 'T2']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /waits for every lower task/);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.deepEqual(routes(f), ['pr 11', 'pr 12']);
  assert.ok(merges(f).every((m) => m.args.includes('--admin') && m.args.includes('--match-head-commit')));
  assert.equal(f.read().prs[12].baseRefName, 'main');
});

test('exit 9 during linking retains work and falls back to ordinary merges in dependency order', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  const sha = f.submit('T2', 12, wt);
  f.write((d) => { d.unavailable = true; });
  f.h.ok(['stack', 'link', 'T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  f.accept('T1');
  f.accept('T2');
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().calls.some((c) => c.args[0] === 'stack' && c.args[1] === 'merge'), false);
});

test('lower acceptance cannot hide failing current gate evidence', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.reviewer('T1', 'reviewer-independent', f.sha);
  f.h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', f.sha, '--agent', 'reviewer-independent']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /T1.*passing gates/);
  assert.deepEqual(routes(f), []);
});

test('a stack member merged at its accepted head is confirmed without current gates, and nothing above it moves', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', f.sha, '--agent', 'reviewer-independent']);
  const upperBase = f.read().prs[12].baseRefName;
  const landed = (head) => f.write((d) => {
    Object.assign(d.prs[11], { state: 'MERGED', headRefOid: head, mergeCommit: { oid: 'c'.repeat(40) } });
    d.calls = [];
  });
  landed('b'.repeat(40));
  const rejected = f.h.run(['merge', 'T1']);
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stdout, /merged with head b+, not the accepted/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'merge'), false, 'a different landed head is refused without a merge');
  landed(f.sha);
  const confirmed = f.h.json(['merge', 'T1']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.match(confirmed.summary, /was already merged/);
  assert.deepEqual(f.read().calls.map((c) => c.args.slice(0, 2)), [['pr', 'view']],
    'confirmation reads the PR and runs no merge, retarget or stack command');
  const lower = f.h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'merge');
  assert.deepEqual(lower.map((e) => e.ok), [false, true], 'the refused landing stays on record beside the confirmation');
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge'), false, 'the upper task keeps no merge evidence');
  assert.deepEqual([f.read().prs[12].state, f.read().prs[12].baseRefName], ['OPEN', upperBase]);
});

test('a stack member merged at its accepted head with passing gates is confirmed without a stack sync', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  const upperBase = f.read().prs[12].baseRefName;
  f.write((d) => {
    Object.assign(d.prs[11], { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } });
    d.calls = [];
  });
  const confirmed = f.h.json(['merge', 'T1']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.match(confirmed.summary, /was already merged/);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'),
    'confirmation with passing gates reads the PR and runs no merge, retarget or stack sync');
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.some((e) => e.type === 'merge'), false, 'the upper task keeps no merge evidence');
  assert.deepEqual([f.read().prs[12].state, f.read().prs[12].baseRefName], ['OPEN', upperBase]);
});

test('a merged stack member is confirmed while its lower PR is still open, and the lower PR is left alone', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    Object.assign(d.prs[12], { state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
    d.calls = [];
  });
  const confirmed = f.h.json(['merge', 'T2']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'), 'an open lower PR is not merged, retargeted or synced');
  assert.deepEqual([f.read().prs[11].state, f.read().prs[11].baseRefName], ['OPEN', 'main']);
});

test('a merged stack member with passing gates is confirmed even while a lower task fails review', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', f.sha, '--agent', 'reviewer-independent']);
  f.write((d) => {
    Object.assign(d.prs[12], { state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
    d.calls = [];
  });
  const confirmed = f.h.json(['merge', 'T2']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.match(confirmed.summary, /was already merged/);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'),
    'confirmation with a failing lower review reads the PR and runs no merge or stack sync');
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false, 'the failing lower task gets no merge evidence');
});

test('a merged stack member with passing gates is confirmed without re-checking a stale lower CI receipt', (t) => {
  const f = stacked(t);
  f.h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 30 })]);
  f.h.ok(['check', 'ci', 'T1']);
  f.h.ok(['accept', 'T1', '--waive', 'review', '--reason', 'offline fixture']);
  f.accept('T2');
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  f.write((d) => {
    Object.assign(d.prs[12], { state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
    d.calls = [];
  });
  const confirmed = f.h.json(['merge', 'T2']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.match(confirmed.summary, /was already merged/);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'),
    'confirmation reads only the PR, so the lower receipt base is not compared');
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false, 'the lower task gets no merge evidence');
});

test('confirming a merged stack member records evidence for it alone, not for merged lower members', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    Object.assign(d.prs[11], { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } });
    Object.assign(d.prs[12], { state: 'MERGED', mergeCommit: { oid: 'd'.repeat(40) } });
    d.calls = [];
  });
  const confirmed = f.h.json(['merge', 'T2']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.equal(f.h.json(['task', 'show', 'T1']).evidence.some((e) => e.type === 'merge'), false, 'the merged lower task gets no receipt from the upper confirmation');
  assert.equal(f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'merge').ok, true);
  assert.ok(f.read().calls.every((c) => c.args[0] === 'pr' && c.args[1] === 'view'));
});

test('local CI covers each dependency base and merge rechecks lower receipts', (t) => {
  const f = stacked(t);
  f.h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 30 })]);
  for (const id of ['T1', 'T2']) {
    f.h.ok(['check', 'ci', id]);
    f.h.ok(['accept', id, '--waive', 'review', '--reason', 'offline fixture']);
  }
  const receipt = f.h.json(['task', 'show', 'T2']).evidence.findLast((e) => e.type === 'ci').receipt;
  assert.equal(receipt.base_sha, f.sha);
  f.h.git(['commit', '--allow-empty', '-qm', 'main moved']);
  f.h.git(['push', 'origin', 'main']);
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /check ci T1 before merging/);
  assert.deepEqual(routes(f), []);
});

test('stacks disabled after acceptance select ordinary merge gates and keep dependency ordering', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.unavailable = true; });
  const r = f.h.run(['merge', 'T2']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ordinary merges enabled/);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  f.h.ok(['merge', 'T1']);
  f.h.ok(['merge', 'T2']);
  assert.equal(f.read().prs[12].baseRefName, 'main');
});

test('relinking after capability recovery restores the stack gate and refuses admin bypass', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.unavailable = true; });
  assert.equal(f.h.run(['merge', 'T2']).code, 1);
  f.write((d) => { d.unavailable = false; });
  f.h.ok(['stack', 'link', 'T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, undefined);
  f.h.ok(['project', 'set', '--merge-admin', 'true']);
  assert.match(f.h.run(['merge', 'T2']).stdout, /cannot use --admin/);
  assert.deepEqual(routes(f), []);
  f.h.ok(['project', 'set', '--merge-admin', 'false']);
  f.h.ok(['merge', 'T2']);
});

// Code tasks with a suite that logs which task files and base files its tree
// holds, open PRs GitHub reports mergeable, and main moved on the remote.
function queued(t) {
  const f = stacked(t);
  const { shellQuote } = require('../lib/gates/common');
  const log = path.join(f.h.base, 'suites.jsonl');
  const suite = path.join(f.h.base, 'suite.js');
  fs.writeFileSync(suite, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(
  ['T1.txt', 'T2.txt', 'moved.txt'].filter((f) => require('node:fs').existsSync(f))) + '\\n');\n`);
  f.h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  // The shared stack template submits docs tasks, and a submitted task's kind
  // cannot change, so these copies are written as code tasks.
  const tasks = f.h.readState('tasks.json');
  for (const task of tasks.tasks) task.kind = 'code';
  f.h.writeState('tasks.json', tasks);
  f.write((d) => { for (const n of [11, 12]) Object.assign(d.prs[n], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); });
  fs.writeFileSync(path.join(f.h.repo, 'moved.txt'), 'main moved\n');
  f.h.git(['add', 'moved.txt']);
  f.h.git(['commit', '-qm', 'main moves']);
  f.h.git(['push', 'origin', 'main']);
  f.main = f.h.git(['rev-parse', 'main']);
  f.acceptCode = (id) => f.h.ok(['accept', id, '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--waive', 'ci',
    '--reason', 'offline stack fixture']);
  f.consume = () => f.h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  f.suites = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []);
  f.checks = () => fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter((e) => e.cmd === 'head check');
  f.merges = () => routes(f);
  return f;
}

test('a stack is one queue entry: its upper task waits for the lower one and the chain is checked against current main', (t) => {
  const f = queued(t);
  f.acceptCode('T2');
  f.consume();
  assert.deepEqual(f.merges(), [], 'an upper task never heads the line before its lower task is accepted');
  assert.deepEqual(f.checks(), []);
  f.acceptCode('T1');
  f.consume();
  assert.deepEqual(f.checks().map((e) => [e.task, e.detail.members, e.detail.base_sha, e.detail.ok]),
    [['T2', ['T1', 'T2'], f.main, true]], 'one check at the top of the chain merged with main');
  assert.deepEqual(f.suites(), [['T1.txt', 'T2.txt', 'moved.txt']]);
  assert.deepEqual(f.merges(), ['async 11', 'async 12']);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('after the lower task merges alone, the upper head check runs against main, not the deleted lower branch', (t) => {
  const f = queued(t);
  const scratch = path.join(f.upper.wt.path, 'scratch.txt');
  // A dirty upper worktree defers stack sync, so T2 still names the lower branch.
  fs.writeFileSync(scratch, 'local edit\n');
  f.acceptCode('T1');
  f.consume();
  assert.deepEqual(f.merges(), ['async 11']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.base, f.lower.branch);
  f.h.git(['push', 'origin', `:${f.lower.branch}`]);
  f.h.git(['update-ref', '-d', `refs/remotes/origin/${f.lower.branch}`]);
  f.write((d) => { d.prs[12].baseRefName = 'main'; });
  const main = f.h.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  f.acceptCode('T2');
  f.consume();
  assert.deepEqual(f.checks().map((e) => [e.task, e.detail.members, e.detail.base_sha]),
    [['T1', ['T1'], f.main], ['T2', ['T2'], main]]);
  assert.deepEqual(f.merges(), ['async 11', 'async 12']);
  assert.equal(f.suites().length, 2, 'the upper task runs one check, against main');
});
