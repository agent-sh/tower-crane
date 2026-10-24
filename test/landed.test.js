'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublished } = require('./atomic-file');
const { cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

// T1 is the task whose PR the orchestrator merged on GitHub; T2 depends on it;
// T3 is unrelated. gh answers `pr view` from pr.json and logs every call, so a
// test sees that the landing reads the PR once and calls nothing else.
function fixture(t) {
  return cachedFixture(t, 'native-landed', (h) => {
    h.init(['--repo', 'acme/demo']);
    gateFixture(h);
    h.git(['switch', '-q', 'main']);
    h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'measures it']);
    h.ok(['task', 'add', '--title', 'Uses the probe', '--acceptance', 'reads it', '--dep', 'T1']);
    h.ok(['task', 'add', '--title', 'Other work', '--acceptance', 'does it']);
    fs.writeFileSync(path.join(h.base, 'tools', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = JSON.parse(fs.readFileSync(process.env.FIXTURE_PR_FILE, 'utf8'));
  console.log(JSON.stringify({ ...pr, ...JSON.parse(process.env.FIXTURE_PR_PATCH || '{}') }));
} else {
  console.error('fixture: a native landing makes no other gh call');
  process.exit(3);
}
`);
    h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh-calls.jsonl');
    h.env.FIXTURE_PR_FILE = path.join(h.base, 'pr.json');
  });
}

const task = (h, id = 'T1') => h.readState('tasks.json').tasks.find((t) => t.id === id);
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const ghCalls = (h) => (fs.existsSync(h.env.FIXTURE_GH_LOG) ? readPublished(h.env.FIXTURE_GH_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const landed = (h, args, opts) => h.run(['task', 'landed', 'T1', '--pr', '42', '--reason', 'native clean-context review passed; PR checks green', ...args], opts);
const patch = (fields) => ({ env: { FIXTURE_PR_PATCH: JSON.stringify(fields) } });

// T1 claimed by a worker in its own worktree, with a commit on its branch and
// uncommitted notes the retirement must save. PR 42 from that branch merged on main.
function claimed(t) {
  const h = fixture(t);
  const wt = h.json(['worktree', 'T1']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  fs.writeFileSync(path.join(wt.path, 'probe.js'), 'module.exports = 2;\n');
  h.git(['add', 'probe.js'], wt.path);
  h.git(['commit', '-qm', 'probe'], wt.path);
  const head = h.git(['rev-parse', 'HEAD'], wt.path);
  fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'local notes\n');
  h.git(['merge', '-q', '--squash', wt.branch]);
  h.git(['commit', '-qm', 'Probe (#42)']);
  const merge = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(h.env.FIXTURE_PR_FILE, JSON.stringify({
    number: 42, state: 'MERGED', mergeCommit: { oid: merge }, baseRefName: 'main', headRefName: wt.branch, headRefOid: head,
    url: 'https://github.com/acme/demo/pull/42', mergedAt: '2026-10-24T10:00:00Z', mergedBy: { login: 'avifenesh' },
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'checks (shared files)', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'revuto', state: 'SUCCESS' },
    ],
  }));
  return Object.assign(h, { wt, head, merge });
}

test('task landed accepts a natively merged PR without gates or review, unblocks dependents and retires the worktree', (t) => {
  const h = claimed(t);
  assert.equal(task(h).status, 'in_progress', 'the fixture holds a live claim');
  const before = events(h).length;

  const worker = landed(h, ['--agent', 'w-1']);
  assert.equal(worker.code, 1);
  assert.match(worker.stderr, /orchestrator or owner/);
  for (const [fields, why] of [
    [{ state: 'OPEN', mergeCommit: null }, /PR #42 is not merged \(OPEN\)/],
    [{ baseRefName: 'release' }, /merged into release, not the project base main/],
    [{ headRefName: 'someone/else' }, /PR #42 \(branch someone\/else\) is not T1's: it records branch tower-crane\/T1-/],
  ]) {
    const r = landed(h, [], patch(fields));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, why);
  }
  const wrongSha = landed(h, ['--sha', 'a'.repeat(40)]);
  assert.equal(wrongSha.code, 1);
  assert.match(wrongSha.stderr, /--sha aaaaaaa is not PR #42's merge commit/);
  assert.equal(task(h).status, 'in_progress');
  assert.equal(events(h).length, before, 'a refusal writes nothing');

  fs.writeFileSync(h.env.FIXTURE_GH_LOG, '');
  const r = landed(h, ['--sha', h.merge, '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(ghCalls(h).map((args) => args.slice(0, 2)), [['pr', 'view']], 'one read of the PR, nothing else');
  const t1 = task(h);
  assert.equal(t1.status, 'accepted');
  assert.equal(t1.claim, null);
  assert.equal(t1.sha, h.head);
  assert.equal(t1.pr, 42);
  assert.equal(t1.revision, 1);
  assert.deepEqual({ ...t1.landed, recorded_at: null }, {
    pr: 42, merge_sha: h.merge, head_sha: h.head, base: 'main', branch: h.wt.branch, url: 'https://github.com/acme/demo/pull/42',
    merged_at: '2026-10-24T10:00:00Z', merged_by: 'avifenesh', reason: 'native clean-context review passed; PR checks green',
    checks: [{ name: 'checks (shared files)', workflow: 'CI', conclusion: 'success' }, { name: 'CodeQL', conclusion: 'success' }, { name: 'revuto', conclusion: 'success' }],
    recorded_at: null, recorded_by: 'owner',
  });
  const log = events(h).slice(before);
  const event = log.find((e) => e.cmd === 'task landed');
  assert.equal(event.detail.merge_sha, h.merge);
  assert.equal(event.detail.previous_status, 'in_progress');
  assert.equal(event.detail.released.agent, 'w-1');
  assert.deepEqual(event.detail.checks.map((c) => c.name), ['checks (shared files)', 'CodeQL', 'revuto']);
  // No gate ran and no reviewer was dispatched.
  assert.deepEqual(log.filter((e) => /^check |^gate run$|^spawn$|^accept$|^merge$/.test(e.cmd)), []);

  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.gates.gates.length > 0, true);
  assert.match(h.ok(['task', 'show', 'T1']), /status: accepted \(native\)[\s\S]*landed: PR #42 merged at/);
  assert.match(h.ok(['task', 'list']), /T1 +accepted \(native\)/);
  assert.equal(h.json(['status']).counts.accepted_native, 1);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T2', 'T3'], 'T2 no longer waits for T1');

  // Retired as a cancelled task's worktree is, with the uncommitted notes saved.
  const retired = log.find((e) => e.task === 'T1' && e.cmd === 'worktree removed');
  assert.ok(retired, JSON.stringify(log.filter((e) => /^worktree/.test(e.cmd))));
  assert.equal(fs.existsSync(h.wt.path), false);
  assert.equal(fs.readFileSync(path.join(retired.detail.saved, 'files', 'notes.txt'), 'utf8'), 'local notes\n');

  // The same record again changes nothing; a different one is refused.
  const count = events(h).length;
  assert.match(landed(h, []).stdout, /already landed with PR #42/);
  assert.equal(events(h).length, count);
  const again = h.run(['task', 'landed', 'T1', '--pr', '41', '--reason', 'r']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /T1 is already accepted \(native, PR #42\)/);

  // Metrics count the landing as a merge, apart from Tower Crane's, and keep it out of the scorecard.
  const m = h.json(['metrics']);
  assert.deepEqual([m.merges.total, m.merges.tower_crane, m.merges.native_landed, m.merges.tasks], [1, 0, 1, 1]);
  assert.equal(m.gate_runs.per_task.tests.n, 0);
  assert.equal(m.lead_time.total.n, 0);
  assert.equal(h.json(['metrics', '--include-native']).lead_time.total.n, 1);
  assert.match(h.ok(['metrics']), /1 merges \(0 Tower Crane, 1 native landed\)/);
});

test('task landed refuses an owner ask, a cancelled task and a PR recorded on another task', (t) => {
  const h = claimed(t);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'pick the probe format']);
  const asked = landed(h, []);
  assert.equal(asked.code, 1);
  assert.match(asked.stderr, /T1 waits on the owner \(pick the probe format\)/);
  h.ok(['owner-done', 'T1']);

  // T3 records the same PR, as a submit with --pr would.
  const doc = h.readState('tasks.json');
  doc.tasks.find((x) => x.id === 'T3').pr = 42;
  h.writeState('tasks.json', doc);
  const shared = landed(h, []);
  assert.equal(shared.code, 1);
  assert.match(shared.stderr, /PR #42 \(branch .*\) is also recorded on T3/);

  h.ok(['task', 'update', 'T3', '--status', 'cancelled']);
  h.ok(['task', 'update', 'T1', '--status', 'cancelled']);
  const cancelled = landed(h, []);
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.stderr, /T1 is cancelled/);
  assert.equal(events(h).filter((e) => e.cmd === 'task landed').length, 0);
});

test('a rework after a native landing refuses the consumed PR, and a later gate acceptance does not show as native', (t) => {
  const h = claimed(t);
  assert.equal(landed(h, []).code, 0);
  h.ok(['rework', 'T1', '--reason', 'the probe must report units']);
  assert.equal(task(h).status, 'rework');
  assert.equal(task(h).revision, 2);

  // The same PR again, from a rerun of the reconciliation loop, would accept the task without the fix.
  const before = events(h).length;
  for (const args of [[], ['--sha', h.merge]]) {
    const again = landed(h, args);
    assert.equal(again.code, 1, again.stderr);
    assert.match(again.stderr, /T1: PR #42 \(merge [0-9a-f]{7}\) already landed this task at revision 1, which was sent back since; the rework needs a new PR/);
  }
  // A new PR that merged the same commit is the same landing.
  const sameMerge = h.run(['task', 'landed', 'T1', '--pr', '44', '--reason', 'r'], patch({ number: 44 }));
  assert.equal(sameMerge.code, 1, sameMerge.stderr);
  assert.match(sameMerge.stderr, /already landed this task at revision 1/);
  assert.equal(events(h).length, before);
  assert.equal(task(h).status, 'rework');

  // Accepted again through the gates and merged by Tower Crane at the new revision:
  // the earlier landing is history, not this acceptance.
  const doc = h.readState('tasks.json');
  const t1 = doc.tasks.find((x) => x.id === 'T1');
  const head = 'c'.repeat(40);
  Object.assign(t1, { status: 'accepted', sha: head });
  t1.evidence.push({ type: 'merge', ok: true, sha: head, revision: 2, agent: 'owner', at: new Date().toISOString(), summary: 'merged', ref: null, source: 'merge', commands: [] });
  h.writeState('tasks.json', doc);
  assert.match(h.ok(['task', 'list']), /T1 +accepted +M code/);
  assert.doesNotMatch(h.ok(['task', 'list']), /native/);
  assert.equal(h.json(['status']).counts.accepted_native, 0);
  const shown = h.ok(['task', 'show', 'T1']);
  assert.match(shown, /status: accepted  kind/);
  assert.match(shown, /earlier landing \(sent back since\): PR #42/);
  const Landed = require('../lib/landed');
  assert.equal(Landed.current(task(h)), null);
});

test('a landing at a later revision whose PR head moved past the task sha stays native after a merge gate confirms it', (t) => {
  const h = fixture(t);
  const wt = h.json(['worktree', 'T1']);
  const commit = (file, text) => {
    fs.writeFileSync(path.join(wt.path, file), text);
    h.git(['add', file], wt.path);
    h.git(['commit', '-qm', file], wt.path);
    return h.git(['rev-parse', 'HEAD'], wt.path);
  };
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const submittedSha = commit('probe.js', 'module.exports = 2;\n');
  h.ok(['submit', 'T1', '--sha', submittedSha, '--branch', wt.branch, '--agent', 'w-1']);
  h.ok(['rework', 'T1', '--reason', 'report units']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['release', 'T1', '--reason', 'finished natively', '--agent', 'w-1']);
  // The orchestrator pushed fixes to the branch itself, so the PR head is not the task's sha.
  const head = commit('units.js', 'module.exports = "ms";\n');
  h.git(['merge', '-q', '--squash', wt.branch]);
  h.git(['commit', '-qm', 'Probe (#42)']);
  const merge = h.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(h.env.FIXTURE_PR_FILE, JSON.stringify({ number: 42, state: 'MERGED', mergeCommit: { oid: merge }, baseRefName: 'main',
    headRefName: wt.branch, headRefOid: head, url: 'https://github.com/acme/demo/pull/42', mergedAt: new Date().toISOString(),
    mergedBy: { login: 'avifenesh' }, statusCheckRollup: [] }));
  const before = task(h);
  assert.equal(before.revision, 2);
  assert.equal(before.sha, submittedSha);
  assert.notEqual(before.sha, head);
  assert.equal(landed(h, []).code, 0);

  // A merge reaction queued before the landing runs afterwards and confirms the same merge,
  // recording merge evidence of its own at the landed head and revision.
  const doc = h.readState('tasks.json');
  const t1 = doc.tasks.find((x) => x.id === 'T1');
  const detail = { type: 'merge', ok: true, sha: head, ref: merge, revision: 2, source: 'merge',
    commands: [{ command: 'gh', args: ['pr', 'view', '42', '-R', 'acme/demo'] }] };
  const at = new Date().toISOString();
  t1.evidence.push({ ...detail, agent: 'orchestrator', at, summary: `PR #42 already merged at ${merge}` });
  h.writeState('tasks.json', doc);
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({ at, agent: 'orchestrator', via: 'automation', cmd: 'merge', task: 'T1', detail })}\n`);

  assert.match(h.ok(['task', 'list']), /T1 +accepted \(native\)/);
  assert.equal(h.json(['status']).counts.accepted_native, 1);
  assert.match(h.ok(['task', 'show', 'T1']), /\nlanded: PR #42/);
  const m = h.json(['metrics']);
  assert.deepEqual([m.merges.total, m.merges.tower_crane, m.merges.native_landed], [1, 0, 1], 'the confirmation is the landing, not a second merge');
  assert.equal(m.gate_runs.per_task.tests.n, 0);
});
