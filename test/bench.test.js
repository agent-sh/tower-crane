'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { score, ciChecks } = require('../lib/bench-gates');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function recordedHistory(h, records) {
  h.init();
  h.ok(['task', 'add', '--title', 'Recorded results', '--acceptance', 'done']);
  const evidence = [];
  const events = records.map(([cmd, detail, summary], i) => {
    const time = Date.parse('2026-10-07T00:00:00Z') + i * 1000;
    if (summary !== undefined) evidence.push({ ...detail, agent: 'orchestrator', revision: 1, at: new Date(time).toISOString(), summary });
    return { task: 'T1', cmd, detail, agent: 'orchestrator', at: new Date(time + 3).toISOString() };
  });
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const doc = h.readState('tasks.json');
  doc.tasks[0].evidence = evidence;
  h.writeState('tasks.json', doc);
}

test('bench deduplicates SHA spellings without merging distinct commits or tasks', () => {
  const collision = A.slice(0, 7) + 'd'.repeat(33);
  for (const { shas, tp } of [
    { shas: [A.slice(0, 7), A], tp: 1 },
    { shas: [A, A.slice(0, 7)], tp: 1 },
    { shas: [A.slice(0, 7).toUpperCase(), A.slice(0, 20), A], tp: 1 },
    { shas: [A.slice(0, 6), A], tp: 2 },
    { shas: [A, collision], tp: 2 },
    { shas: [A.slice(0, 7), A, collision], tp: 3 },
  ]) {
    const rows = shas.map((sha) => ({ task: 'T1', gate: 'ci', sha, ok: false, label: 'tp', reason: 'checks', checks: ['lint'] }));
    rows.push({ task: 'T1', gate: 'ci', sha: B, ok: false, label: 'fp', reason: 'checks', checks: ['lint'] });
    const gate = score(rows, 'ci');
    assert.deepEqual([gate.tp, gate.fp, gate.precision], [tp, 1, tp / (tp + 1)], JSON.stringify(shas));
    assert.deepEqual(ciChecks(rows), [{ check: 'lint', fails: tp + 1, tp, fp: 1, open: 0, precision: tp / (tp + 1) }]);
  }
  const rows = [
    { task: 'T1', sha: A.slice(0, 7) },
    { task: 'T1', sha: A.slice(0, 20) },
    { task: 'T2', sha: collision },
  ].map((r) => ({ ...r, gate: 'ci', ok: false, label: 'tp', reason: 'checks', checks: ['lint'] }));
  assert.equal(score(rows, 'ci').tp, 2);
  assert.equal(ciChecks(rows)[0].tp, 2);
});

test('bench CLI counts mixed-length gate and CI failures once per commit', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  const records = [];
  for (const sha of [A.slice(0, 7), A]) {
    records.push(['check tests', { type: 'tests', ok: false, sha }],
      ['check ci', { type: 'ci', ok: false, sha }, 'failing: lint (failure)']);
  }
  records.push(['submit', { sha: B }],
    ['check tests', { type: 'tests', ok: false, sha: B }],
    ['check ci', { type: 'ci', ok: false, sha: B.slice(0, 7) }, 'failing: lint (failure)'],
    ['check tests', { type: 'tests', ok: true, sha: B.slice(0, 7) }],
    ['check ci', { type: 'ci', ok: true, sha: B }],
    ['evidence', { type: 'review', ok: true, sha: B }]);
  recordedHistory(h, records);
  const result = h.json(['bench', 'gates']);
  for (const name of ['tests', 'ci']) {
    const gate = result.gates.find((g) => g.gate === name);
    assert.deepEqual([gate.runs, gate.results, gate.tp, gate.fp, gate.precision], [4, 3, 1, 1, 0.5]);
  }
  assert.deepEqual(result.ci_checks, [{ check: 'lint', fails: 2, tp: 1, fp: 1, open: 0, precision: 0.5 }]);
  assert.equal(result.labels.length, 8, 'raw run labels retain the recorded SHA spellings');
});

test('bench includes sources passes contradicted by review and overturned sources failures', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  recordedHistory(h, [
    ['check sources', { type: 'sources', ok: false, sha: A }],
    ['check sources', { type: 'sources', ok: true, sha: A }],
    ['evidence', { type: 'review', ok: false, sha: A }],
    ['check sources', { type: 'sources', ok: false, sha: B }],
    ['submit', { sha: C }],
    ['check sources', { type: 'sources', ok: true, sha: C }],
    ['evidence', { type: 'review', ok: true, sha: C }],
    ['evidence', { type: 'sources', ok: true, sha: B }],
  ]);
  const result = h.json(['bench', 'gates']);
  const sources = result.gates.find((g) => g.gate === 'sources');
  assert.ok(sources, 'sources has a gate-table row');
  assert.deepEqual([sources.runs, sources.tp, sources.fp, sources.fn, sources.tn], [4, 1, 1, 1, 1]);
  assert.deepEqual([sources.precision, sources.recall], [0.5, 0.5]);
  assert.equal(result.labels.filter((r) => r.gate === 'sources').length, 4);
  assert.match(h.ok(['bench', 'gates']), /^sources\s+4/m);
});

test('bench keeps CI checks first reported by later polls without counting repeated checks twice', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  recordedHistory(h, [
    ['check ci', { type: 'ci', ok: false, sha: A }, 'failing: lint (failure)'],
    ['check ci', { type: 'ci', ok: false, sha: A }, 'failing: lint (failure), revuto-review (failure)'],
    ['check ci', { type: 'ci', ok: false, sha: A }, 'failing: revuto-review (failure)'],
    ['check ci', { type: 'ci', ok: true, sha: A }],
    ['check ci', { type: 'ci', ok: false, sha: B }, 'failing: lint (failure)'],
    ['submit', { sha: C }],
  ]);
  const result = h.json(['bench', 'gates']);
  assert.deepEqual(result.ci_checks, [
    { check: 'lint', fails: 2, tp: 1, fp: 1, open: 0, precision: 0.5 },
    { check: 'revuto-review', fails: 1, tp: 0, fp: 1, open: 0, precision: 0 },
  ]);
  assert.equal(result.gates.find((g) => g.gate === 'ci').results, 3, 'gate results still dedupe whole verdicts');
});

test('bench labels confirmed local CI execution failures and excludes local observation failures', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  const local = (exit, signal = null, confirmed = true) => ({
    type: 'ci', ok: false, sha: A, confirmed_failure: confirmed,
    receipt: { variant: 'default', command: ['node', 'check.js'], head_sha: A, exit, signal, duration_ms: 10 },
  });
  recordedHistory(h, [
    ['check tests', { type: 'tests', ok: true, sha: A }],
    // Local receipts identify the failed execution without any hosted summary.
    ['check ci', local(1)],
    ['submit', { sha: B }],
  ]);
  let result = h.json(['bench', 'gates']);
  assert.equal(result.gates.find((g) => g.gate === 'tests').fn, 1);
  assert.equal(result.gates.find((g) => g.gate === 'ci').tp, 1);
  assert.deepEqual(result.ci_checks, [
    { check: 'local CI (default)', fails: 1, tp: 1, fp: 0, open: 0, precision: 1 },
  ]);
  const eventFile = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  const failed = events.find((e) => e.cmd === 'check ci');
  for (const detail of [local(0), local(null), local(126), local(127), local(9009), local(1, 'SIGTERM'), local(1, null, false)]) {
    failed.detail = detail;
    fs.writeFileSync(eventFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    result = h.json(['bench', 'gates']);
    assert.equal(result.gates.find((g) => g.gate === 'ci').noncode, 1);
    assert.equal(result.gates.find((g) => g.gate === 'tests').fn, 0);
  }
  failed.detail = local(1);
  events.push({ cmd: 'check ci', task: 'T1', at: '2026-10-07T00:00:04Z', detail: { type: 'ci', ok: true, sha: A } });
  fs.writeFileSync(eventFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  result = h.json(['bench', 'gates']);
  assert.equal(result.gates.find((g) => g.gate === 'ci').fp, 1);
  assert.equal(result.gates.find((g) => g.gate === 'tests').fn, 0);
});

function history(h) {
  h.init();
  for (const title of ['one', 'two', 'three']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  const lines = [];
  let clock = Date.parse('2026-10-07T00:00:00Z');
  const at = () => new Date(clock += 1000).toISOString();
  const evidence = { T1: [], T2: [], T3: [] };
  const gate = (task, type, sha, ok, summary = null) => {
    // The gate stamps its evidence entry before the event, so the two differ.
    const time = at();
    lines.push({ at: new Date(Date.parse(time) + 3).toISOString(), agent: 'orchestrator', cmd: type === 'merge' ? 'merge' : `check ${type}`, task, detail: { type, ok, sha, source: `check ${type}` } });
    evidence[task].push({ type, ok, sha, agent: 'orchestrator', at: time, summary, ref: null, revision: 1 });
  };
  const ev = (task, cmd, detail, agent = 'orchestrator') => lines.push({ at: at(), agent, cmd, task, detail });
  // T1: a tests fail the same sha later passes, then a review blocker at that sha.
  ev('T1', 'submit', { sha: A });
  gate('T1', 'tests', A, false);
  gate('T1', 'tests', A, true);
  gate('T1', 'tests', A, true);
  ev('T1', 'evidence', { type: 'review', ok: false, sha: A }, 'reviewer-T1-1');
  // An agent's own tests note is not a gate run.
  ev('T1', 'evidence', { type: 'tests', ok: true, sha: A }, 'worker-T1-1');
  // A failed check run after the review blocker contradicts the same pass.
  gate('T1', 'ci', A, false, `CI not green at ${A.slice(0, 10)} in o/r:\nfailing: lint (failure)`);
  // T2: a fail that stood until a new sha, a pass a review confirms despite a
  // mergeability failure, then a pass a failing check run contradicts.
  ev('T2', 'submit', { sha: A });
  gate('T2', 'tests', A, false);
  ev('T2', 'submit', { sha: B });
  gate('T2', 'tests', B, true);
  gate('T2', 'ci', B, false, 'PR #3 mergeability is unknown or unavailable (UNKNOWN, UNKNOWN); wait for GitHub to compute it.');
  gate('T2', 'ci', B, true);
  ev('T2', 'evidence', { type: 'review', ok: true, sha: B }, 'reviewer-T2-1');
  ev('T2', 'submit', { sha: C });
  gate('T2', 'clean', C, true);
  gate('T2', 'ci', C, false, `CI not green at ${C.slice(0, 10)} in o/r:\nfailing: test (windows-latest, node 24, shard 1/2) (failure), lint (failure)\ncheck suites not green: github-actions (failure, 2 runs)`);
  // T3: a pending CI run the task moved past says nothing about A; a failed
  // check run the task moved past is a true positive.
  ev('T3', 'submit', { sha: A });
  gate('T3', 'ci', A, false, `CI not green at ${A.slice(0, 10)} in o/r:\nnot completed: test (ubuntu-latest, node 24) (in_progress)`);
  ev('T3', 'submit', { sha: B });
  gate('T3', 'ci', B, false, `CI not green at ${B.slice(0, 10)} in o/r:\nnot completed: lint (queued)`);
  gate('T3', 'ci', B, false, `CI not green at ${B.slice(0, 10)} in o/r:\nfailing: lint (failure)`);
  ev('T3', 'submit', { sha: C });
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const doc = h.readState('tasks.json');
  for (const task of doc.tasks) task.evidence = evidence[task.id];
  h.writeState('tasks.json', doc);
}

test('bench gates labels gate fails overturned at the same sha and passes later contradicted', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  history(h);
  const r = h.json(['bench', 'gates']);
  const tests = r.gates.find((g) => g.gate === 'tests');
  // T1's two passes at A count once; T1 and T2 fails are one fp and one tp.
  assert.deepEqual([tests.runs, tests.results, tests.tp, tests.fp, tests.fn, tests.tn, tests.open], [5, 4, 1, 1, 1, 1, 0]);
  assert.deepEqual(tests.fn_by, { review: 1, ci: 1 }, 'the CI contradiction counts though the review came first');
  assert.equal(tests.precision, 0.5);
  assert.equal(tests.recall, 0.5);
  const clean = r.gates.find((g) => g.gate === 'clean');
  assert.deepEqual([clean.fn, clean.fn_by.ci], [1, 1], 'a failed check run contradicts the clean pass');
  const ci = r.gates.find((g) => g.gate === 'ci');
  assert.deepEqual([ci.tp, ci.fp, ci.tn, ci.open, ci.noncode], [1, 0, 1, 2, 3], 'mergeability and pending fails are neither true nor false');
  assert.equal(ci.precision, 1);
  assert.equal(ci.recall_ci, null, 'the ci gate is not scored against itself');
  assert.equal(tests.recall_ci, 0.5);
  assert.deepEqual(r.ci_fail_reasons, { mergeability: 1, checks: 3, pending: 2 });
  assert.deepEqual(r.ci_checks.map((c) => c.check).sort(), ['lint', 'test (windows-latest, node 24)']);
  assert.equal(r.labels.filter((l) => l.task === 'T1' && l.gate === 'tests').length, 3, 'manual tests evidence is not labeled');
});

test('bench gates scores deslop checks from hand verdicts, a reviewer eval and an agent report', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  const file = (name, text) => { const p = path.join(h.base, name); fs.writeFileSync(p, text); return p; };
  const hits = file('hits.jsonl', [
    { detector: 'debug', verdict: 'true-slop' }, { detector: 'debug', verdict: 'harmless' },
    { detector: 'debug', verdict: 'false-positive' }, { detector: 'debug', verdict: 'false-positive' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const findings = file('findings.jsonl', [
    { source: 'o/r#1 https://x', reviewed_commit: 'abc', example: 'lib/a.js:10', deslop_caught: false },
    { source: 'o/r#1 https://y', reviewed_commit: 'abc', example: 'docs/b.md', deslop_caught: true },
    { source: 'o/r#2 https://z', reviewed_commit: 'def', example: 'x.js:1', deslop_caught: false },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const runs = file('runs.json', JSON.stringify({
    'o/r#1@abc': { items: [{ check: 'stale-mention', file: 'lib/a.js', line: 14 }, { check: 'stale-mention', file: 'lib/a.js', line: 40 }, { check: 'missing-path', file: 'docs/b.md', line: 3 }] },
    'o/r#1@head': { items: [{ check: 'stale-mention', file: 'z.js', line: 1 }] },
  }));
  const report = file('report.json', JSON.stringify({ findings: [{ check: 'missing-path' }], dismissed: [{ check: 'missing-path' }, { check: 'em-dash' }] }));
  const r = h.json(['bench', 'gates', '--deslop-hits', hits, '--deslop-findings', findings, '--deslop-runs', runs, '--deslop-report', report]);
  assert.deepEqual(r.deslop.hits, [{ check: 'debug', items: 4, tp: 1, harmless: 1, fp: 2, precision: 0.25, precision_lenient: 0.5 }]);
  const e = r.deslop.eval;
  assert.deepEqual([e.findings, e.previous_caught, e.evaluated, e.caught], [3, 1, 2, 2], 'o/r#2 has no run and is not evaluated');
  const stale = e.checks.find((c) => c.check === 'stale-mention');
  assert.deepEqual([stale.items, stale.tp, stale.unconfirmed, stale.caught, stale.recall], [2, 1, 1, 1, 0.5], 'head runs carry no labels');
  assert.deepEqual(r.deslop.report.map((c) => [c.check, c.confirmed, c.dismissed]), [['missing-path', 1, 1], ['em-dash', 0, 1]]);
  const refused = h.run(['bench', 'gates', '--deslop-runs', runs]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--deslop-runs needs --deslop-findings/);
});
