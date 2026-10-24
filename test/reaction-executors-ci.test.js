'use strict';

// CI completion and review findings while gate executors are free or busy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { refillFixture } = require('./automation-helpers');
const { busyExecutors } = require('./reaction-executors-helpers');

const ciReviewCases = [
  ...['hosted', 'local'].flatMap((provider) => ['success', 'failure', ...(provider === 'hosted' ? ['pending'] : [])]
    .flatMap((result) => [false, true].map((busy) => ({ provider, result, busy, review: 'body' })))),
  ...['code', 'mixed'].flatMap((review) => ['hosted', 'local']
    .map((provider) => ({ provider, result: 'failure', busy: true, review }))),
];
for (const { provider, result, busy, review } of ciReviewCases) {
  test(`CI completion honors ${review} review findings with ${provider} ${result} and ${busy ? 'busy' : 'free'} executors`, async (t) => {
    const h = refillFixture(t);
    for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
    const broken = path.join(h.base, 'ci-broken');
    const prepare = () => {
      const github = h.github();
      github.ci[h.sha] = 'success';
      h.saveGithub(github);
      if (provider === 'local') {
        const script = path.join(h.base, 'local-ci.js');
        fs.writeFileSync(script, `process.exit(require('node:fs').existsSync(${JSON.stringify(broken)}) ? 1 : 0);\n`);
        h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, script], timeout: 30 })]);
      }
      h.submit();
      for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
      h.reviewer('T1', 'reviewer');
      const body = { kind: 'false-claim', path: 'PR body', claim: 'false claim' };
      const code = { kind: 'defect', path: 'lib/change.js', claim: 'missing input handling' };
      h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
        '--fail', '--summary', 'blocking findings', '--findings',
        JSON.stringify(review === 'body' ? [body] : review === 'code' ? [code] : [body, code]), '--agent', 'reviewer']);
      if (!busy) h.ok(['project', 'set', '--paused', 'inspect CI completion']);
    };
    const finish = busy ? await busyExecutors(h, prepare) : (prepare(), async () => {});
    const ci = () => h.logs().filter((e) => e.cmd === 'check ci' && e.task === 'T1');
    const reviewers = () => h.logs().filter((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.role === 'reviewer').length;
    const before = ci().length;
    const dispatched = reviewers();
    if (provider === 'hosted') {
      const github = h.github();
      github.ci[h.sha] = result;
      h.saveGithub(github);
    } else if (result === 'failure') fs.writeFileSync(broken, '');
    try {
      h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
      if (review !== 'body') {
        assert.equal(ci().length, before, 'code rework needs no CI query');
        assert.equal(h.readState('tasks.json').tasks[0].status, 'rework');
      } else if (busy && provider === 'local') {
        assert.equal(ci().length, before, 'local CI waits for an executor');
        assert.ok(h.json(['status']).gate_queue.queued.some((q) => q.id === 'T1'), 'the completion remains visible gate work');
      } else {
        assert.equal(ci().length, before + 1, 'the completion refreshes CI even though review failed');
        assert.equal(ci().at(-1).detail.ok, result === 'success');
        assert.equal(!!ci().at(-1).detail.pending, result === 'pending');
        if (busy) assert.equal(h.json(['status']).gate_queue.queued.some((q) => q.id === 'T1'), false, 'hosted CI takes no executor');
      }
    } finally {
      await finish();
    }
    if (review === 'body') {
      assert.equal(ci().length, before + 1, 'queued completions drain after an executor frees');
      assert.equal(ci().at(-1).detail.ok, result === 'success');
      assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
      if (result !== 'success') {
        const accept = h.run(['accept', 'T1', '--agent', 'orchestrator']);
        assert.equal(accept.code, 1, accept.stderr);
        assert.match(accept.stderr, /ci: latest ci .* (failed|pending)/);
        assert.equal(reviewers(), dispatched, 'red or pending CI cannot dispatch the body correction check');
      }
    }
  });
}

for (const status of ['submitted', 'accepted']) {
test(`${status} body-only review findings do not hide a pending hosted CI reconciliation`, (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const github = h.github();
  github.ci[h.sha] = 'success';
  h.saveGithub(github);
  h.submit();
  for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  if (status === 'accepted') {
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  }
  github.ci[h.sha] = 'pending';
  h.saveGithub(github);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
    '--fail', '--summary', 'false claim', '--findings',
    JSON.stringify([{ kind: 'false-claim', path: 'PR body', claim: 'false claim' }]), '--agent', 'reviewer']);
  github.ci[h.sha] = 'failure';
  h.saveGithub(github);
  h.consume();
  const ci = h.logs().filter((e) => e.cmd === 'check ci' && e.task === 'T1');
  assert.equal(ci.length, 3);
  assert.equal(ci.at(-1).detail.ok, false);
  assert.equal(!!ci.at(-1).detail.pending, false);
});
}
