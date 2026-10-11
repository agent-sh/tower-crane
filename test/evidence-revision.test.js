'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { waitOnRepo } = require('./signals');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function reviewedTask(t, kind = 'docs') {
  const h = makeRepo(t);
  const sha = kind === 'code' ? gateFixture(h) : h.git(['rev-parse', 'HEAD']);
  h.init(['--base', 'main']);
  for (const rung of ['easy', 'medium', 'hard', 'research', 'review']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--clear', 'model', '--clear', 'profile',
      '--clear', 'provider', '--clear', 'effort',
      '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]);
  }
  h.ok(['task', 'add', '--title', 'Fix a link', '--acceptance', 'link works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link.\n' });
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  if (kind === 'code') {
    for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
  }
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '1', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  return { h, sha };
}

// A review_pending accept dispatches the stub reviewer. Its exit runs the
// automation reaction, which accepts on its own once review evidence exists,
// so the test records the fresh review only after that reaction finished.
async function reviewSettled(h) {
  return waitOnRepo(h, () => {
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
    const exit = events.findLast((e) => e.cmd === 'spawn exit' && e.detail.role === 'reviewer');
    return exit && events.some((e) => e.cmd === 'automation' && e.detail.source === exit.id && e.detail.phase === 'done');
  }, 'dispatched reviewer did not settle');
}

for (const status of ['submitted', 'accepted']) {
  test(`G3: rework of a ${status} task cannot reuse a review when the same sha is resubmitted`, async (t) => {
    const { h, sha } = reviewedTask(t);
    if (status === 'accepted') h.ok(['accept', 'T1', '--agent', 'orchestrator']);
    const before = h.json(['task', 'show', 'T1']);
    h.ok(['rework', 'T1', '--reason', 'the reviewer missed a broken link', '--agent', 'orchestrator']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);

    const result = h.json(['accept', 'T1', '--agent', 'orchestrator']);
    assert.equal(result.status, 'submitted', 'accept must wait for a new review');
    assert.equal(result.review_pending, true);
    const shown = h.json(['task', 'show', 'T1']);
    assert.equal(shown.revision, before.revision + 1);
    assert.equal(shown.sha, sha);
    assert.deepEqual(shown.evidence, before.evidence);
    assert.equal(shown.gates.ok, false);
    assert.match(h.ok(['task', 'show', 'T1']), /review ok .* \(revision 1, does not count\)/);

    await reviewSettled(h);
    h.reviewer('T1', 'new-reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '2', '--agent', 'new-reviewer']);
    assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).status, 'accepted');
  });
}

test('G4: changing a submitted brief invalidates the review at the unchanged sha', async (t) => {
  const { h, sha } = reviewedTask(t);
  const before = h.json(['task', 'show', 'T1']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link and cover the CLI docs.\n' });
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.gates.ok, false, 'the changed brief needs a new review');
  assert.equal(shown.revision, before.revision + 1);
  assert.equal(shown.status, 'submitted');
  assert.equal(shown.sha, sha);
  assert.deepEqual(shown.evidence, before.evidence);
  assert.match(h.ok(['task', 'show', 'T1']), /review ok .* \(revision 1, does not count\)/);
  assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).review_pending, true);
  await reviewSettled(h);
  h.reviewer('T1', 'new-reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '2', '--agent', 'new-reviewer']);
  assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).status, 'accepted');
});

test('an accepted brief needs explicit rework before edits, and dependents wait for fresh acceptance', async (t) => {
  const { h, sha } = reviewedTask(t);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Uses the link', '--acceptance', 'uses the accepted link', '--kind', 'docs', '--dep', 'T1']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link.\n' });
  const state = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (const agent of ['orchestrator', 'owner']) {
    const changed = h.run(['brief', 'set', 'T1', '-', '--agent', agent], { input: 'Check the link and log errors.\n' });
    assert.equal(changed.code, 1, 'accepted requirements must stay reviewed until explicit rework');
    assert.match(changed.stderr, /T1 is accepted.*brief.*rework T1/);
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), state);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  assert.equal(h.ok(['brief', 'get', 'T1']), 'Check the link.');
  const accepted = h.json(['task', 'show', 'T1']);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.gates.ok, true);
  assert.ok(h.json(['ready']).ready.some(task => task.id === 'T2'));

  h.ok(['rework', 'T1', '--reason', 'add error logging', '--agent', 'orchestrator']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link and log errors.\n' });
  assert.ok(!h.json(['ready']).ready.some(task => task.id === 'T2'));
  assert.equal(h.run(['claim', 'T2', '--agent', 'dependent']).code, 1);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).review_pending, true);
  assert.equal(h.run(['claim', 'T2', '--agent', 'dependent']).code, 1);
  await reviewSettled(h);
  h.reviewer('T1', 'new-reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', String(h.json(['task', 'show', 'T1']).revision), '--agent', 'new-reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['claim', 'T2', '--agent', 'dependent']);
  assert.equal(h.json(['task', 'show', 'T2']).claim.agent, 'dependent');
});

for (const change of ['rework', 'brief']) {
  test(`${change} invalidates software evidence as well as review evidence`, (t) => {
    const { h, sha } = reviewedTask(t, 'code');
    const before = h.json(['task', 'show', 'T1']);
    if (change === 'rework') {
      h.ok(['rework', 'T1', '--reason', 'check the link again', '--agent', 'orchestrator']);
      h.ok(['claim', 'T1', '--agent', 'worker']);
      h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
    } else {
      h.ok(['brief', 'set', 'T1', '-'], { input: 'Check another link too.\n' });
    }
    const shown = h.json(['task', 'show', 'T1']);
    assert.deepEqual(shown.gates.gates.filter((g) => !g.ok).map((g) => g.type), ['tests', 'clean', 'review']);
    assert.deepEqual(shown.evidence, before.evidence);
    for (const type of ['tests', 'clean']) gateEvidence(h, type, 'checker');
    h.reviewer('T1', 'new-reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '2', '--agent', 'new-reviewer']);
    assert.equal(h.json(['accept', 'T1', '--agent', 'orchestrator']).status, 'accepted');
  });
}

test('brief edits before submission and identical writes preserve the revision', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Link', '--acceptance', 'works', '--kind', 'docs']);
  for (const input of ['First draft.\n', 'Final brief.\n']) {
    h.ok(['brief', 'set', 'T1', '-'], { input });
    assert.equal(h.json(['task', 'show', 'T1']).revision, 1);
  }
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '1', '--agent', 'reviewer']);
  const before = h.json(['task', 'show', 'T1']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Final brief.\n' });
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.revision, before.revision);
  assert.deepEqual(shown.evidence, before.evidence);
  assert.equal(shown.gates.ok, true);
});

for (const change of ['brief', 'rework', 'acceptance']) {
  test(`a reviewer finishing after ${change} records its dispatch revision`, async (t) => {
    const { h, sha } = reviewedTask(t);
    const release = path.join(h.base, 'release-review');
    const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  const result = cp.spawnSync(process.execPath, ${JSON.stringify([BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', sha])}, { env: process.env });
  process.exit(result.status ?? 1);
}, 30);
setTimeout(() => process.exit(2), 300000).unref();
`;
    for (const rung of ['easy', 'medium', 'hard', 'research', 'review']) {
      h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}'])]);
    }
    const after = fs.statSync(path.join(h.state, 'events.jsonl')).size;
    const running = h.runAsync(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
    let dispatched;
    let completion;
    try {
      dispatched = h.json(['wait', '--after', String(after), '--task', 'T1', '--types', 'spawn', '--timeout', '300']);
      if (change === 'brief') {
        h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link and another requirement.\n' });
      } else if (change === 'rework') {
        h.ok(['rework', 'T1', '--reason', 'review the link again']);
        h.ok(['claim', 'T1', '--agent', 'worker']);
        h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
      } else {
        h.ok(['task', 'update', 'T1', '--acceptance', 'link works and logs errors']);
      }
    } finally {
      fs.writeFileSync(release, '');
      completion = await running;
    }
    assert.equal(completion.code, 0, completion.stderr);
    const shown = h.json(['task', 'show', 'T1']);
    const verdict = shown.evidence.at(-1);
    assert.equal(verdict.agent, dispatched.detail.agent);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.revision, 1, 'the verdict belongs to the reviewed revision');
    assert.equal(shown.revision, 2);
    assert.equal(shown.gates.ok, false);
  });
}

test('owner review evidence names the revision reviewed, and a stale one does not count', (t) => {
  const { h, sha } = reviewedTask(t);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Check the link and cover the CLI docs.\n' });
  const review = (...more) => h.run(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, ...more, '--agent', 'owner']);

  const unnamed = review();
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.stderr, /needs --revision/);
  const ahead = review('--revision', '3');
  assert.equal(ahead.code, 1);
  assert.match(ahead.stderr, /revision 2; --revision 3 is ahead/);
  assert.equal(review('--revision', '0').code, 2);

  review('--revision', '1');
  const stale = h.json(['task', 'show', 'T1']);
  assert.equal(stale.evidence.at(-1).revision, 1);
  assert.equal(stale.gates.ok, false, 'a review of the old brief cannot pass the new revision');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--revision', '2', '--agent', 'owner']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});
