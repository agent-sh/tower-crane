'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function acceptedTask(t) {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.git(['switch', '-q', 'main']);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Keep task worktrees', '--acceptance', 'Preserve the branch', '--acceptance', 'Pin the accepted head']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--pr', '9', '--branch', 'fixture-change', '--agent', 'w-1']);
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  h.ok(['accept', 'T1']);
  const log = path.join(h.base, 'gh-args.jsonl');
  h.env.FIXTURE_GH_LOG = log;
  return {
    h, sha,
    merge(extra = []) {
      fs.rmSync(h.env.FIXTURE_MERGED, { force: true });
      fs.rmSync(log, { force: true });
      const evidence = h.json(['merge', 'T1', ...extra, '--agent', 'orchestrator']);
      assert.equal(evidence.ok, true, evidence.summary);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      const merges = calls.filter((args) => args[1] === 'merge');
      assert.equal(merges.length, 1);
      assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], sha);
      const receipt = evidence.commands.find((c) => c.command === 'gh' && c.args[1] === 'merge');
      assert.deepEqual(receipt.args, merges[0]);
      return merges[0];
    },
  };
}

test('merge defaults commit text from the task and preserves explicit multiline or empty bodies', (t) => {
  const { merge } = acceptedTask(t);
  const defaults = merge();
  assert.ok(defaults.includes('--squash'));
  assert.ok(defaults.includes('--delete-branch'));
  assert.equal(defaults[defaults.indexOf('--subject') + 1], 'Keep task worktrees');
  assert.equal(defaults[defaults.indexOf('--body') + 1], 'Preserve the branch\nPin the accepted head');
  const body = 'First paragraph.\n\nLiteral `code` and $(text).';
  const explicit = merge(['--subject', 'Custom squash subject', '--body', body]);
  assert.equal(explicit[explicit.indexOf('--subject') + 1], 'Custom squash subject');
  assert.equal(explicit[explicit.indexOf('--body') + 1], body);
  assert.ok(!explicit.includes('--admin'));
  const empty = merge(['--body', '']);
  assert.equal(empty[empty.indexOf('--body') + 1], '');
  const rebase = merge(['--method', 'rebase']);
  assert.ok(rebase.includes('--rebase'));
  assert.ok(!rebase.includes('--subject'));
  assert.ok(!rebase.includes('--body'));
});

test('agents cannot request admin merging outside owner-set project policy', (t) => {
  const { h, merge } = acceptedTask(t);
  for (const policy of [undefined, 'false', 'null']) {
    if (policy !== undefined) h.ok(['project', 'set', '--merge-admin', policy]);
    assert.ok(!merge().includes('--admin'));
    fs.rmSync(h.env.FIXTURE_GH_LOG, { force: true });
    const snapshot = () => ['tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));
    const before = snapshot();
    for (const agent of ['w-1', 'orchestrator']) {
      const refused = h.run(['merge', 'T1', '--admin', '--agent', agent]);
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, /unknown option --admin for merge/);
      assert.ok(!fs.existsSync(h.env.FIXTURE_GH_LOG), 'no GitHub command ran');
      assert.deepEqual(snapshot(), before, 'refusal records no merge evidence');
    }
    const project = h.readState('project.json');
    const denied = h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'w-1']);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /only the owner/);
    assert.deepEqual(snapshot(), before, 'refusal writes no events');
    // The orchestrator's request becomes a decision for the owner and changes nothing.
    const escalated = h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator']);
    assert.equal(escalated.code, 1, escalated.stderr);
    assert.match(escalated.stderr, /merge\.admin is owner-required; opened D1 for the owner/);
    assert.deepEqual(h.readState('project.json'), project);
  }
  assert.doesNotMatch(h.ok(['merge', '--help']), /--admin\b/);
});

test('invalid merge text or methods refuse before calling GitHub', (t) => {
  const { h } = acceptedTask(t);
  for (const gatesPass of [true, false]) {
    if (!gatesPass) {
      gateEvidence(h, 'ci', 'checker', false);
      fs.rmSync(h.env.FIXTURE_GH_LOG, { force: true });
    }
    for (const state of ['OPEN', 'MERGED']) {
      h.env.FIXTURE_PR_STATE = state;
      for (const extra of [
        ['--subject', ' \t'], ['--method', 'rebase', '--subject', 'Ignored?'],
        ['--method', 'rebase', '--body', ''], ['--method', 'octopus'],
      ]) {
        const refused = h.run(['merge', 'T1', ...extra, '--agent', 'orchestrator', '--json']);
        assert.equal(refused.code, 1, refused.stderr);
        assert.equal(JSON.parse(refused.stdout).ok, false);
        assert.ok(!fs.existsSync(h.env.FIXTURE_GH_LOG), `${state}, gates pass ${gatesPass}: no GitHub command ran`);
      }
    }
  }
});

test('failed current gates permit only confirmation of a merged PR at the accepted head', (t) => {
  const { h, sha } = acceptedTask(t);
  gateEvidence(h, 'ci', 'checker', false);
  fs.rmSync(h.env.FIXTURE_GH_LOG, { force: true });
  const refused = h.run(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /its gates no longer pass: ci: latest ci at .* failed:/);
  assert.ok(!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'));
  h.env.FIXTURE_PR_STATE = 'MERGED';
  const confirmed = h.json(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(confirmed.ok, true, confirmed.summary);
  assert.deepEqual([confirmed.sha, confirmed.ref], [sha, sha]);
  assert.match(confirmed.summary, /was already merged/);
  const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['pr', 'view'], ['pr', 'view']]);
  assert.equal(confirmed.commands.length, 1, 'confirmation records the single lookup that proved the merge');
});

test('project merge options retain a branch checked out in a live worktree and select admin merging', (t) => {
  const { h, merge } = acceptedTask(t);
  const worktree = h.json(['worktree', 'T1', '--agent', 'orchestrator']).path;
  h.ok(['project', 'set', '--merge-keep-branch', 'true', '--merge-admin', 'true']);
  const kept = merge();
  assert.ok(!kept.includes('--delete-branch'));
  assert.ok(kept.includes('--admin'));
  assert.equal(h.git(['symbolic-ref', '--short', 'HEAD'], worktree), 'fixture-change');
  assert.ok(h.git(['worktree', 'list', '--porcelain']).includes('branch refs/heads/fixture-change'));
  h.ok(['project', 'set', '--merge-keep-branch', 'false', '--merge-admin', 'false']);
  const reset = merge(['--method', 'merge']);
  assert.ok(reset.includes('--merge'));
  assert.ok(reset.includes('--delete-branch'));
  assert.ok(!reset.includes('--admin'));
});

test('merge settings support init, clearing and atomic rejection of invalid or unauthorized admin policy', (t) => {
  const h = makeRepo(t);
  h.init(['--merge-keep-branch', 'true', '--merge-admin', 'true']);
  assert.deepEqual(h.json(['project', 'show']).merge, { keep_branch: true, admin: true });
  assert.match(h.ok(['project', 'show']), /merge\.keep_branch: true\nmerge\.admin: true/);
  for (const command of [['project', 'set'], ['init']]) {
    const help = h.ok([...command, '--help']);
    assert.match(help, /--merge-keep-branch JSON.*null/);
    assert.match(help, /--merge-admin JSON.*owner.*null/);
  }
  h.ok(['project', 'set', '--merge-admin', 'null']);
  assert.deepEqual(h.json(['project', 'show']).merge, { keep_branch: true });
  h.ok(['project', 'set', '--merge-keep-branch', 'null']);
  assert.ok(!Object.hasOwn(h.json(['project', 'show']), 'merge'));
  const snapshot = () => ['project.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(h.state, f), 'utf8'));
  const before = snapshot();
  for (const flag of ['--merge-keep-branch', '--merge-admin']) {
    for (const value of ['1', '"true"', '{}', 'yes']) {
      const bad = h.run(['project', 'set', '--name', 'must not persist', flag, value]);
      assert.equal(bad.code, 2, bad.stderr);
      assert.match(bad.stderr, /must be true, false or null/);
      assert.deepEqual(snapshot(), before);
    }
  }
  const denied = h.run(['project', 'set', '--name', 'must not persist', '--merge-admin', 'true', '--agent', 'w-1']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /only the owner/);
  assert.deepEqual(snapshot(), before);
  const fresh = makeRepo(t);
  const init = fresh.run(['init', '--name', 'demo', '--goal', 'merge policy', '--merge-admin', 'true', '--agent', 'w-1']);
  assert.equal(init.code, 1, init.stderr);
  assert.match(init.stderr, /only the owner/);
  assert.ok(!fs.existsSync(fresh.state));
  const project = h.readState('project.json');
  for (const settings of [[], true, { admin: 'true' }, { keep_branch: 'false' }]) {
    h.writeState('project.json', { ...project, merge: settings });
    const invalid = h.run(['project', 'show']);
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.match(invalid.stderr, /merge.*must be/);
  }
});

test('a PR GitHub refuses as an unrecorded stack member squashes through the asynchronous API with the same text at the accepted head', (t) => {
  const { h, sha } = acceptedTask(t);
  h.env.FIXTURE_GH_STACK_REFUSAL = '1';
  const calls = () => fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  // The asynchronous API cannot rebase, so a rebase keeps GitHub's refusal and posts nothing.
  const rebase = h.run(['merge', 'T1', '--method', 'rebase', '--agent', 'orchestrator']);
  assert.equal(rebase.code, 1, rebase.stdout);
  assert.match(`${rebase.stdout}${rebase.stderr}`, /gh pr merge refused PR #9: GraphQL: This pull request is part of a stack/);
  assert.equal(calls().some((args) => args.includes('POST')), false);
  const evidence = h.json(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(evidence.ok, true, evidence.summary);
  assert.match(evidence.summary, /merged PR #9 into main in acme\/demo through the asynchronous merge API at /);
  assert.ok(evidence.ref);
  const refused = calls().find((args) => args[1] === 'merge' && args.includes('--squash'));
  const subject = refused[refused.indexOf('--subject') + 1];
  const body = refused[refused.indexOf('--body') + 1];
  assert.deepEqual(calls().filter((args) => args.includes('POST')), [
    ['api', 'repos/acme/demo/pulls/9/merge-async', '--method', 'POST', '-f', 'merge_method=squash', '-f', `expected_head_sha=${sha}`, '-f', `commit_title=${subject}`, '-f', `commit_message=${body}`],
  ]);
  assert.equal(subject, 'Keep task worktrees');
  assert.equal(body, 'Preserve the branch\nPin the accepted head');
  // The API never deletes the head branch, so the fallback deletes it once the merge is confirmed, as --delete-branch would.
  assert.deepEqual(calls().filter((args) => args.includes('DELETE')), [
    ['api', 'repos/acme/demo/git/refs/heads/fixture-change', '--method', 'DELETE'],
  ]);
  assert.match(evidence.summary, /; deleted branch fixture-change$/);
  assert.ok(evidence.commands.some((c) => c.command === 'gh' && c.args[1] === 'merge' && c.status === 1));
  assert.ok(evidence.commands.some((c) => c.command === 'gh' && c.args.includes('POST') && c.status === 0));
});

test('the asynchronous fallback encodes each segment of a head branch name it deletes', (t) => {
  const { h } = acceptedTask(t);
  h.env.FIXTURE_GH_STACK_REFUSAL = '1';
  h.env.FIXTURE_PR_HEAD = 'feature/fixture#change';
  const evidence = h.json(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(evidence.ok, true, evidence.summary);
  const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  // A raw '#' would start a fragment and delete a different ref; the slash stays a path separator.
  assert.deepEqual(calls.filter((args) => args.includes('DELETE')), [
    ['api', 'repos/acme/demo/git/refs/heads/feature/fixture%23change', '--method', 'DELETE'],
  ]);
});

test('the asynchronous fallback keeps the head branch when merge.keep_branch is set', (t) => {
  const { h } = acceptedTask(t);
  h.env.FIXTURE_GH_STACK_REFUSAL = '1';
  h.ok(['project', 'set', '--merge-keep-branch', 'true']);
  const evidence = h.json(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(evidence.ok, true, evidence.summary);
  assert.doesNotMatch(evidence.summary, /branch/);
  const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args.includes('DELETE')), false);
  assert.equal(calls.filter((args) => args.includes('POST')).length, 1);
});

test('the asynchronous fallback refuses under merge.admin instead of dropping the admin option', (t) => {
  const { h } = acceptedTask(t);
  h.env.FIXTURE_GH_STACK_REFUSAL = '1';
  h.ok(['project', 'set', '--merge-admin', 'true']);
  const refused = h.run(['merge', 'T1', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(`${refused.stdout}${refused.stderr}`, /no admin option while merge\.admin is set/);
  const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args.includes('POST') || args.includes('DELETE')), false);
  assert.ok(calls.some((args) => args[1] === 'merge' && args.includes('--admin')));
});
