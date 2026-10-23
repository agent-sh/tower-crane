'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { countHeads, read, warning } = require('../lib/pr-heads');
const C = require('../lib/gates/common');

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

test('run creation time can place replaced heads in a later submit interval', () => {
  const boundary = { at: '2026-10-01T10:00:05.500Z', detail: { sha: old } };
  const lateRun = (head, extra = {}) => run(head, { created_at: '2026-10-01T11:00:00Z', ...extra });
  for (const row of [
    { name: 'late run of a head replaced before submit can overcount',
      runs: [lateRun(intermediate, { event: 'push', created_at: '2026-10-01T10:00:06Z', pull_requests: [] }), lateRun(sha)], count: 2 },
    { name: 'late workflows and reruns of that head still count once',
      runs: [lateRun(intermediate), lateRun(intermediate, { event: 'push' }), lateRun(sha)], count: 2 },
    { name: 'late run of the previous submitted head is excluded',
      runs: [lateRun(old), lateRun(sha)], count: 1 },
    { name: 'a replaced head without a run can be missed',
      runs: [lateRun(sha)], count: 1 },
    { name: 'a run created before the boundary is excluded',
      runs: [lateRun(intermediate, { created_at: '2026-10-01T10:00:05Z' }), lateRun(sha)], count: 1 },
  ]) {
    assert.equal(countHeads(row.runs, { sha, branch, pr: 7, previous: boundary }), row.count, row.name);
  }
});

for (const file of ['docs/state.md', 'docs/cli.md', 'changelog.d/T497.md']) {
  test(`push history timing uncertainty in ${file}`, () => {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/observed lower bound/i.test(text), 'the observed count is not a lower bound');
    assert.ok(/heads that start no Actions run can be missed/.test(text), 'missing runs can undercount pushes');
    assert.ok(/late run.*head replaced before the previous submit can be counted/i.test(text), 'late runs can overcount pushes');
  });
}

test('history queries use whole seconds while counts retain the exact submit boundary', async (t) => {
  const gh = C.gh;
  t.after(() => { C.gh = gh; });
  const boundary = { at: '2026-10-01T10:00:05.500Z', detail: { sha: old, pr: 7, branch }, task: 'T1', cmd: 'submit' };
  C.gh = async (_ctx, args) => {
    if (args[0] === 'pr') return { ok: true, stdout: JSON.stringify({ headRefName: branch, headRefOid: sha }) };
    const query = new URL(args[1], 'https://api.github.com');
    assert.equal(query.searchParams.get('created'), '>=2026-10-01T10:00:05Z');
    return { ok: true, stdout: [
      run(intermediate, { created_at: '2026-10-01T10:00:05.499Z' }),
      run(sha, { created_at: '2026-10-01T10:00:05.500Z' }),
    ].map(JSON.stringify).join('\n') };
  };
  assert.deepEqual(await read({}, { repo: 'acme/app' }, { task: { id: 'T1' }, sha, pr: 7, events: [boundary] }), { count: 1 });
});

test('policy refusals at either history read are informational and ordinary failures warn', async (t) => {
  const gh = C.gh;
  t.after(() => { C.gh = gh; });
  for (const command of ['pr', 'api']) {
    for (const denied of [true, false]) {
      C.gh = async (_ctx, args) => args[0] === command
        ? { ok: false, stderr: denied ? "gh is not allowed by this agent's agent file" : 'HTTP 503' }
        : { ok: true, stdout: JSON.stringify({ headRefName: branch, headRefOid: sha }) };
      const result = await read({}, { repo: 'acme/app' }, { task: { id: 'T1' }, sha, pr: 7, events: [] });
      assert.equal(result.count, null);
      if (denied) {
        assert.match(result.note, /gh policy refuses.*history/);
        assert.equal(result.error, undefined);
        assert.equal(warning(result), null);
      } else {
        assert.match(result.error, /HTTP 503/);
        assert.match(warning(result), /unavailable/);
      }
    }
  }
});

test('multiple observed heads call for inspection without attributing every push to the worker', () => {
  assert.match(warning({ count: 2 }), /inspect.*delayed runs.*engine or orchestrator pushes/);
});
