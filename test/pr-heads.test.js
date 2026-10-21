'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countHeads } = require('../lib/pr-heads');

const old = 'a'.repeat(40);
const intermediate = 'b'.repeat(40);
const sha = 'c'.repeat(40);
const branch = 'task/change';
const before = '2026-10-01T10:00:00Z';
const after = '2026-10-01T10:00:01Z';
const previous = { at: before, detail: { sha: old } };
const run = (head_sha, extra = {}) => ({ head_sha, head_branch: branch, event: 'pull_request',
  created_at: after, pull_requests: [{ number: 7 }], ...extra });

test('PR head history counts publications across workflows and revisions', () => {
  for (const row of [
    { name: 'first publish before CI starts', runs: [], previous: null, count: 1 },
    { name: 'first publish includes abandoned heads', runs: [run(intermediate), run(sha)], previous: null, count: 2 },
    { name: 'many workflows and reruns share one head', runs: [run(sha), run(sha, { event: 'push' })], count: 1 },
    { name: 'two new heads', runs: [run(intermediate), run(sha)], count: 2 },
    { name: 'unordered history', runs: [run(sha), run(intermediate), run(sha)], count: 2 },
    { name: 'previous head and older history excluded', runs: [run(old), run(intermediate, { created_at: '2026-09-01T00:00:00Z' }), run(sha)], count: 1 },
    { name: 'same timestamp includes a new head', runs: [run(intermediate, { created_at: before })], count: 2 },
    { name: 'unrelated branch and PR excluded', runs: [run(intermediate, { head_branch: 'main' }), run(intermediate, { pull_requests: [{ number: 8 }] })], count: 1 },
    { name: 'manual and target workflows excluded', runs: [run(intermediate, { event: 'workflow_dispatch' }), run(intermediate, { event: 'pull_request_target' })], count: 1 },
    { name: 'empty PR list on a push', runs: [run(intermediate, { event: 'push', pull_requests: [] })], count: 2 },
    { name: 'same-head resubmit adds no publication', sha: old, runs: [run(old)], count: 0 },
    { name: 'case-insensitive SHAs', runs: [run(sha.toUpperCase()), run(old.toUpperCase())], count: 1 },
  ]) {
    assert.equal(countHeads(row.runs, { sha: row.sha || sha, branch, pr: 7,
      previous: row.previous === null ? null : previous }), row.count, row.name);
  }
});

test('invalid relevant history is unavailable rather than a zero count', () => {
  for (const extra of [{ head_sha: 'bad' }, { created_at: 'bad' }]) {
    assert.throws(() => countHeads([run(sha, extra)], { sha, branch, pr: 7, previous }), /invalid .*PR head history/);
  }
  assert.throws(() => countHeads([{}], { sha, branch, pr: 7, previous }), /invalid entry in PR head history/);
});
