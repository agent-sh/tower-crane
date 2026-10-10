'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gate = require('../../lib/gates/merge');
const { result, fakeExec } = require('./helpers');
const { makeRepo } = require('../helpers');
const { gateFixture, gateEvidence } = require('../gate-helpers');
const { stacked } = require('../stack-fixture');

const SHA = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const MERGED = 'e'.repeat(40);
const REPO = 'acme/app';
const isMerge = (args) => (args[0] === 'pr' && args[1] === 'merge')
  || (args[0] === 'api' && args.includes('POST') && /\/merge-async$/.test(args[1]));

// A PR on a fake GitHub: `merge` decides what gh pr merge does to it.
function github({ state = 'OPEN', head = SHA, merge = 'ok', base = 'main', crossRepository = false, landedBase = base } = {}) {
  const pr = { state, headRefOid: head, baseRefName: base, isCrossRepository: crossRepository,
    mergeCommit: state === 'MERGED' ? { oid: MERGED } : null };
  const gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] !== 'pr' || args[1] !== 'merge') return null;
    if (merge === 'refused') return result('', 1, 'GraphQL: Base branch policy prohibits the merge (mergePullRequest)');
    if (merge === 'queued') return result('! Pull request #42 will be added to the merge queue\n');
    Object.assign(pr, { state: 'MERGED', baseRefName: landedBase, mergeCommit: { oid: MERGED } });
    if (merge === 'branch-kept') return result('', 1, 'failed to delete remote branch: protected');
    return result('');
  });
  gh.merges = () => gh.calls.filter((c) => c[2] === 'merge');
  return gh;
}

function ctx(gh, { task = {}, args = {}, project = {} } = {}) {
  return { root: '/repo', worktree: null, task: { id: 'T4', title: 'Change', acceptance: ['works'], kind: 'code', sha: SHA, pr: 42, status: 'accepted', ...task }, project: { repo: REPO, base: 'main', ...project }, args, exec: gh.exec, log() {} };
}

test('a task that is not accepted is never merged', async () => {
  for (const status of ['submitted', 'in_progress', 'rework']) {
    const gh = github();
    const r = await gate.run(ctx(gh, { task: { status } }));
    assert.equal(r.ok, false);
    assert.match(r.summary, new RegExp(`is ${status}, not accepted`));
    assert.equal(gh.calls.length, 0);
  }
});

test('a task without a PR is not merged', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh, { task: { pr: null } }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /has no PR/);
  assert.equal(gh.calls.length, 0);
});

test('merge ok: squash, delete the branch, match the head, confirm MERGED', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.equal(r.sha, SHA);
  assert.deepEqual(gh.merges(), [['gh', 'pr', 'merge', '42', '-R', REPO, '--squash', '--delete-branch', '--match-head-commit', SHA, '--subject', 'Change', '--body', 'works']]);
  assert.match(r.summary, /merged PR #42 into main in acme\/app \(squash\)/);
});

test('plain merges accept the configured project base or the recorded stack dependency base', async () => {
  for (const [base, task] of [['release', {}], ['lower-task', { stack: { base: 'lower-task' } }]]) {
    const gh = github({ base });
    const r = await gate.run(ctx(gh, { project: { base: 'release' }, task }));
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, new RegExp(`into ${base} in acme/app`));
    assert.equal(gh.merges().length, 1);
  }
  const gh = github({ base: 'release' });
  const wrong = await gate.run(ctx(gh, {
    project: { base: 'release' }, task: { stack: { base: 'lower-task' } },
  }));
  assert.equal(wrong.ok, false, wrong.summary);
  assert.match(wrong.summary, /base.*release.*lower-task/);
  assert.equal(gh.merges().length, 0);
});

test('a PR response without a base cannot authorize a merge', async () => {
  const gh = fakeExec(() => result(JSON.stringify({ state: 'OPEN', headRefOid: SHA, isCrossRepository: false })));
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false, r.summary);
  assert.match(r.summary, /base.*undefined.*main/);
  assert.equal(gh.calls.filter((c) => c[2] === 'merge').length, 0);
});

test('--method and project admin policy reach gh', async () => {
  const gh = github();
  const r = await gate.run(ctx(gh, { args: { method: 'rebase' }, project: { merge: { admin: true } } }));
  assert.equal(r.ok, true, r.summary);
  assert.deepEqual(gh.merges(), [['gh', 'pr', 'merge', '42', '-R', REPO, '--rebase', '--delete-branch', '--match-head-commit', SHA, '--admin']]);
  const bad = await gate.run(ctx(github(), { args: { method: 'octopus' } }));
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /--method must be squash, merge or rebase/);
});

test('one-off args cannot enable admin when project policy is unset or false', async () => {
  for (const project of [{}, { merge: { admin: false } }]) {
    const gh = github();
    const r = await gate.run(ctx(gh, { args: { admin: true }, project }));
    assert.equal(r.ok, true, r.summary);
    assert.equal(gh.merges().length, 1);
    assert.ok(!gh.merges()[0].includes('--admin'));
    assert.ok(gh.merges()[0].includes('--match-head-commit'));
  }
});

test('a refused merge: not ok with gh\'s message, tried once', async () => {
  const gh = github({ merge: 'refused' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /Base branch policy prohibits the merge/);
  assert.equal(gh.merges().length, 1);
});

test('the PR head moved: not ok, merge never attempted', async () => {
  const gh = github({ head: OTHER });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR head moved: PR #42 head is dddddddddd/);
  assert.equal(gh.merges().length, 0);
});

test('gh exits 0 but the PR is not merged (merge queue): not ok', async () => {
  const gh = github({ merge: 'queued' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR #42 is OPEN/);
});

test('merged, but gh could not delete the branch: ok with gh\'s message', async () => {
  const gh = github({ merge: 'branch-kept' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.match(r.summary, /failed to delete remote branch/);
});

test('already merged at the accepted sha: ok without merging again', async () => {
  const gh = github({ state: 'MERGED' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.ref, MERGED);
  assert.equal(gh.merges().length, 0);
  const moved = await gate.run(ctx(github({ state: 'MERGED', head: OTHER })));
  assert.equal(moved.ok, false);
  assert.match(moved.summary, /not the accepted/);
});

test('M1: the CLI refuses an accepted PR retargeted from main to release', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.git(['switch', '-q', 'main']);
  h.init(['--repo', REPO, '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Change', '--kind', 'code', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '42', '--agent', 'worker-T1']);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
  h.ok(['accept', 'T1']);
  h.env.FIXTURE_PR_BASE = 'release';
  h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
  const r = h.run(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /base.*release.*main/);
  const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args[1] === 'merge'), false);
  assert.ok(!fs.existsSync(h.env.FIXTURE_MERGED));
  const evidence = h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge');
  assert.equal(evidence.ok, false);
  assert.match(evidence.summary, /release/);
  assert.ok(!evidence.commands.some((c) => c.args[1] === 'merge'));
  h.env.FIXTURE_PR_BASE = 'main';
  const merged = h.json(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(merged.ok, true, merged.summary);
  assert.match(merged.summary, /into main/);
});

test('the plain path refuses a wrong base or a cross-repository PR, including already merged PRs', async () => {
  for (const state of ['OPEN', 'MERGED']) {
    for (const options of [{ base: 'release' }, { crossRepository: true }]) {
      const gh = github({ state, ...options });
      const r = await gate.run(ctx(gh));
      assert.equal(r.ok, false, r.summary);
      assert.match(r.summary, options.base ? /base.*release.*main/ : /same-repository/);
      assert.equal(gh.merges().length, 0);
    }
  }
});

test('a stack PR must target its dependency branch rather than the project base', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.prs[12].baseRefName = 'main'; });
  const r = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /base is main, expected/);
  assert.equal(f.read().calls.some((c) => isMerge(c.args)), false);
});

test('a stack merge refuses members already merged into another base', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  const landed = (d, pr) => Object.assign(d.prs[pr], { state: 'MERGED', baseRefName: 'release', mergeCommit: { oid: 'c'.repeat(40) } });
  f.write((d) => { landed(d, 11); landed(d, 12); });
  const all = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(all.code, 1, all.stdout);
  assert.match(all.stdout, /PR #12 base is release, expected main/);
  f.write((d) => { Object.assign(d.prs[12], { state: 'OPEN', baseRefName: f.lower.branch }); delete d.prs[12].mergeCommit; d.calls = []; });
  const mixed = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(mixed.code, 1, mixed.stdout);
  assert.match(mixed.stdout, /T1: PR base is release, expected main/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'edit' || isMerge(c.args)), false);
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id, '--agent', 'orchestrator']).status, 'accepted');
});

test('a confirmed stack merge names the base it landed on', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  const merged = f.h.json(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(merged.ok, true, merged.summary);
  assert.match(merged.summary, /into main/);
});

test('an asynchronous stack merge into another base stops before the upper PR is merged', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.asyncResponses = { 11: { views: [{ body: { ...d.prs[11], state: 'MERGED', baseRefName: 'release' } }] } };
  });
  const r = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /merged into release.*expected main/);
  assert.equal(f.read().prs[12].state, 'OPEN');
  const merges = f.read().calls.filter((c) => isMerge(c.args));
  assert.equal(merges.length, 1);
  assert.match(merges[0].args[1], /pulls\/11\/merge-async$/);
});

for (const finalRead of [false, true]) {
  test(`an asynchronous merge into the dependency branch stays failed and retains the lower merge${finalRead ? ' on the final read' : ''}`, (t) => {
    const f = stacked(t);
    f.accept('T1');
    f.accept('T2');
    f.write((d) => {
      d.moveOnMerge = { pr: 12, base: f.lower.branch, onPr: 12 };
      if (finalRead) d.asyncResponses = { 12: { views: [{ body: { ...d.prs[12], state: 'MERGED', baseRefName: 'main' } }] } };
    });
    const r = f.h.run(['merge', 'T2', '--agent', 'orchestrator', '--json']);
    const landed = f.read().prs[12];
    assert.equal(landed.state, 'MERGED');
    assert.equal(landed.baseRefName, f.lower.branch);
    assert.equal(f.h.git(['ls-remote', 'origin', `refs/heads/${f.lower.branch}`]).split(/\s/)[0], landed.mergeCommit.oid);
    assert.ok(f.h.git(['show', '-s', '--format=%P', landed.mergeCommit.oid]).split(' ').includes(f.upper.sha));
    assert.equal(r.code, 1, r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.ref, landed.mergeCommit.oid);
    assert.ok(report.summary.includes(`into ${f.lower.branch}`), report.summary);
    if (!finalRead) assert.ok(report.summary.includes(`PR #12 merged into ${f.lower.branch}`), report.summary);
    assert.match(report.summary, /expected main/);
    const lower = f.h.json(['task', 'show', 'T1', '--agent', 'orchestrator']);
    const upper = f.h.json(['task', 'show', 'T2', '--agent', 'orchestrator']);
    assert.equal(lower.evidence.findLast((e) => e.type === 'merge').ok, true);
    assert.equal(upper.evidence.findLast((e) => e.type === 'merge').ok, false);
    assert.equal(upper.evidence.some((e) => e.type === 'merge' && e.ok), false);
  });
}

test('retrying a wrong-base stack merge after sync fails keeps it failed and preserves the worktree', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    d.moveOnMerge = { pr: 12, base: f.lower.branch, onPr: 12 };
    d.syncError = 'temporary transport failure';
  });
  const command = ['merge', 'T2', '--agent', 'orchestrator', '--json'];
  const first = f.h.run(command);
  assert.equal(first.code, 1, first.stdout);
  assert.equal(f.read().prs[12].state, 'MERGED');
  assert.equal(f.read().prs[12].baseRefName, f.lower.branch);
  const main = f.h.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  assert.notEqual(f.h.git(['merge-base', f.upper.sha, main]), f.upper.sha);
  assert.ok(fs.existsSync(f.upper.wt.path));
  for (let retry = 0; retry < 2; retry++) {
    const r = f.h.run(command);
    assert.equal(r.code, 1, r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.summary.includes(f.lower.branch), report.summary);
    assert.match(report.summary, /expected main/);
    assert.equal(f.h.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0], main);
    assert.ok(fs.existsSync(f.upper.wt.path));
    const upper = f.h.json(['task', 'show', 'T2', '--agent', 'orchestrator']);
    assert.equal(upper.evidence.some((e) => e.type === 'merge' && e.ok), false);
  }
  const lower = f.h.json(['task', 'show', 'T1', '--agent', 'orchestrator']);
  assert.equal(lower.evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('a member retry uses async receipts recorded under a higher stack task', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.add('Top', 'T2');
  const top = f.h.json(['worktree', 'T3']);
  f.submit('T3', 13, top);
  f.h.ok(['stack', 'link', 'T3']);
  f.accept('T3');
  f.write((d) => {
    d.moveOnMerge = { pr: 12, base: f.lower.branch, onPr: 12 };
    d.syncError = 'temporary transport failure';
  });
  const first = f.h.run(['merge', 'T3', '--agent', 'orchestrator', '--json']);
  assert.equal(first.code, 1, first.stdout);
  const upper = f.h.json(['task', 'show', 'T2', '--agent', 'orchestrator']);
  assert.equal(upper.evidence.some((e) => e.type === 'merge'), false);
  const retry = f.h.run(['merge', 'T2', '--agent', 'orchestrator', '--json']);
  assert.equal(retry.code, 1, retry.stdout);
  assert.match(JSON.parse(retry.stdout).summary, /expected main/);
  assert.ok(fs.existsSync(f.upper.wt.path));
  assert.equal(f.h.json(['task', 'show', 'T2', '--agent', 'orchestrator']).evidence.some((e) => e.type === 'merge' && e.ok), false);
  assert.equal(f.read().prs[13].state, 'OPEN');
});

test('the accepted merge queue keeps wrong-base stack retries failed', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => {
    for (const pr of Object.values(d.prs)) Object.assign(pr, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    d.moveOnMerge = { pr: 12, base: f.lower.branch, onPr: 12 };
    d.syncError = 'temporary transport failure';
  });
  const command = ['merge', '--accepted', '--agent', 'orchestrator', '--json'];
  const first = f.h.run(command);
  assert.equal(first.code, 1, first.stdout + first.stderr);
  assert.equal(f.read().prs[12].state, 'MERGED', first.stdout + first.stderr);
  for (let retry = 0; retry < 2; retry++) {
    const r = f.h.run(command);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const upper = f.h.json(['task', 'show', 'T2', '--agent', 'orchestrator']);
    assert.equal(upper.evidence.some((e) => e.type === 'merge' && e.ok), false);
    assert.ok(fs.existsSync(f.upper.wt.path));
  }
});

test('a partially merged stack retries on the project base and refuses an unrelated base', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { d.refuseMergePr = 12; });
  const partial = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(partial.code, 1, partial.stdout);
  assert.equal(f.read().prs[11].state, 'MERGED');
  assert.equal(f.read().prs[12].baseRefName, 'main');
  f.write((d) => { d.calls = []; delete d.refuseMergePr; d.prs[12].baseRefName = 'release'; });
  const refused = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /base.*release/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'edit' || isMerge(c.args)), false);
  f.write((d) => { d.prs[12].baseRefName = 'main'; });
  const merged = f.h.json(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(merged.ok, true, merged.summary);
  const merges = f.read().calls.filter((c) => isMerge(c.args));
  assert.equal(merges.length, 1);
  assert.match(merges[0].args[1], /pulls\/12\/merge-async$/);
  assert.ok(merges[0].args.includes('merge_method=merge'));
  assert.ok(merges[0].args.includes(`expected_head_sha=${f.upper.sha}`));
});

test('unstacked fallback retargets only the recorded dependency base after lower tasks land', (t) => {
  const f = stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.h.ok(['stack', 'unstack', 'T2', '--agent', 'orchestrator']);
  f.h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  f.write((d) => { d.calls = []; d.prs[12].baseRefName = 'release'; });
  const refused = f.h.run(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stdout, /base.*release.*main/);
  assert.equal(f.read().calls.some((c) => c.args[1] === 'edit' || isMerge(c.args)), false);
  f.write((d) => { d.prs[12].baseRefName = f.lower.branch; });
  const merged = f.h.json(['merge', 'T2', '--agent', 'orchestrator']);
  assert.equal(merged.ok, true, merged.summary);
  assert.match(merged.summary, /into main/);
  const calls = f.read().calls.map((c) => c.args.slice(0, 2).join(' '));
  const edit = calls.indexOf('pr edit');
  assert.ok(edit >= 0);
  assert.equal(calls[edit + 1], 'pr view');
  assert.equal(calls[edit + 2], 'pr merge');
});

test('merge confirmation names and refuses an unexpected landed base', async () => {
  const gh = github({ landedBase: 'release' });
  const r = await gate.run(ctx(gh));
  assert.equal(r.ok, false, r.summary);
  assert.match(r.summary, /merged.*release.*main/);
  assert.equal(gh.merges().length, 1);
});

test('already merged confirmation names the real base', async () => {
  const r = await gate.run(ctx(github({ state: 'MERGED', base: 'release' }), { project: { base: 'release' } }));
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /into release/);
});
