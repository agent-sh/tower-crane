'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { score, ciChecks } = require('../lib/bench-gates');
const { taskSpend } = require('../lib/bench-tokens');

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

test('bench tokens reports accepted-task tokens and cost by rung and escalation path', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  for (const title of ['climbed', 'direct', 'open']) h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  const spend = (task, rung, model, tokens, cached) => h.ok(['spend', task, '--tokens', String(tokens), '--input', String(tokens - 10),
    '--cached', String(cached), '--output', '10', '--rung', rung, '--model', model, '--harness', 'codex', '--agent', `${rung}-${task}`]);
  const spawn = (task, rung) => JSON.stringify({ at: '2026-10-07T00:00:00Z', agent: 'orchestrator', cmd: 'spawn', task, detail: { role: 'worker', rung, agent: `${rung}-${task}` } });
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [spawn('T1', 'easy'), spawn('T1', 'easy'), spawn('T1', 'medium'), spawn('T2', 'medium')].join('\n') + '\n');
  spend('T1', 'easy', 'openai.gpt-6-luna', 1000010, 0);
  spend('T1', 'medium', 'openai.gpt-6.1-sol', 3000010, 2000000);
  spend('T1', 'review', 'openai.gpt-6.1-sol', 500010, 0);
  spend('T2', 'medium', 'openai.gpt-6.1-sol', 2000010, 0);
  spend('T2', 'review', 'global.anthropic.claude-opus-5-5[1m]', 100010, 0);
  spend('T3', 'easy', 'openai.gpt-6-luna', 7000010, 0);
  // Minute-only manual records are not missing telemetry.
  h.ok(['spend', 'T2', '--minutes', '5']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].status = 'accepted';
  doc.tasks[1].status = 'accepted';
  h.writeState('tasks.json', doc);
  const prices = path.join(h.base, 'prices.json');
  fs.writeFileSync(prices, JSON.stringify({ luna: { input: 0.1, cache_write: 0.1, cache_read: 0.01, output: 0.5 }, sol: { input: 2, cache_write: 2, cache_read: 0.1, output: 10 } }));
  const r = h.json(['bench', 'tokens', '--prices', prices]);
  assert.deepEqual([r.accepted, r.complete], [2, 2]);
  assert.equal(r.all_tasks_tokens, 13600060, 'spend on unaccepted tasks counts toward the cost of accepted ones');
  assert.equal(r.tokens_per_accepted, 6800030);
  assert.deepEqual(r.unpriced_models, { 'global.anthropic.claude-opus-5-5[1m]': 1 }, 'the 1M-context id needs its own price row');
  assert.equal(r.by_path.medium.priced_tasks, 0);
  assert.deepEqual(Object.keys(r.by_path), ['easy>medium', 'medium']);
  assert.equal(r.by_path['easy>medium'].median_tokens, 4500030);
  assert.equal(r.by_rung.medium.median_tokens, 2500010);
  assert.equal(r.by_rung.medium.tasks, 2);
  const t1 = r.tasks.find((x) => x.id === 'T1');
  assert.deepEqual([t1.fresh, t1.cached, t1.output], [2500000, 2000000, 30]);
  // easy 1M fresh luna, medium 1M fresh + 2M cached sol, review 0.5M fresh sol, plus output.
  const usd = 1 * 0.1 + 10e-6 * 0.5 + (1 * 2 + 2 * 0.1 + 10e-6 * 10) + (0.5 * 2 + 10e-6 * 10);
  assert.ok(Math.abs(r.by_path['easy>medium'].median_usd - usd) < 1e-9);
  const text = h.ok(['bench', 'tokens']);
  assert.match(text, /accepted tasks: 2, with complete token records: 2/);
  assert.match(text, /easy>medium\s+1\s+4\.50M/);
  assert.match(text, /unpriced entries by model: global\.anthropic\.claude-opus-5-5\[1m\] 1/);
});

test('bench excludes accepted tasks missing worker, reviewer or resumed-session usage from medians', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  for (const title of ['missing review', 'missing worker', 'complete', 'missing resumed usage']) {
    h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  }
  const events = [];
  for (const task of ['T1', 'T2', 'T3', 'T4']) {
    for (const role of ['worker', 'reviewer']) {
      events.push({ at: '2026-10-07T00:00:00Z', cmd: 'spawn', task, detail: { agent: `${role}-${task}`, role, rung: role === 'worker' ? 'easy' : 'review' } });
    }
  }
  events.push({ at: '2026-10-07T00:01:00Z', cmd: 'spawn', task: 'T4',
    detail: { agent: 'worker-T4', role: 'worker', rung: 'easy', resumed: true, attempt: 2 } });
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const doc = h.readState('tasks.json');
  for (const task of doc.tasks) {
    task.status = 'accepted';
    task.spend.entries = ['worker', 'reviewer'].filter((role) => !(task.id === 'T1' && role === 'reviewer') && !(task.id === 'T2' && role === 'worker'))
      .map((role) => ({ at: '2026-10-07T00:00:30Z', minutes: 0, agent: `${role}-${task.id}`, source: `spawn:${role}-${task.id}`, tokens: 100, input: 90, cached: 0,
        output: 10, cost_usd: 1, harness: null, model: null, profile: null, rung: role === 'worker' ? 'easy' : 'review' }));
  }
  h.writeState('tasks.json', doc);
  h.ok(['spend', 'T1', '--minutes', '2', '--agent', 'reviewer-T1']);
  let result = h.json(['bench', 'tokens']);
  assert.deepEqual([result.accepted, result.complete, result.overall.priced_tasks], [4, 1, 1]);
  assert.equal(result.by_rung.easy.tasks, 1);
  assert.equal(result.by_path.easy.tasks, 1);
  assert.equal(result.all_tasks_tokens, 600, 'partial recorded spend still contributes to total cost');
  assert.deepEqual(result.tasks.map((row) => row.missing_spawns), [
    ['spawn:reviewer-T1'], ['spawn:worker-T2'], [], ['spawn:worker-T4:attempt:2'],
  ]);
  // A matching native token report completes the reviewer; minute-only spend did not.
  h.ok(['spend', 'T1', '--tokens', '0', '--agent', 'reviewer-T1']);
  result = h.json(['bench', 'tokens']);
  assert.equal(result.complete, 2);
  const routes = [
    ['spawn fallback', { route_index: 1 }],
    ['spawn retry', { route_index: 1, retry: 1, fresh: true }],
    ['spawn retry', { route_index: 1, retry: 2, fresh: false }],
  ].map(([cmd, detail]) => ({ cmd, task: 'T3', at: '2026-10-07T00:00:20Z', detail: { agent: 'worker-T3', ...detail } }));
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), routes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  result = h.json(['bench', 'tokens']);
  const missing = result.tasks.find((row) => row.id === 'T3').missing_spawns;
  assert.deepEqual(missing, ['spawn:worker-T3:route:1', 'spawn:worker-T3:route:1:retry:1']);
  assert.equal(result.complete, 1, 'resumable retries share usage; fresh routes need their own records');
  const updated = h.readState('tasks.json');
  for (const source of missing) updated.tasks[2].spend.entries.push({
    ...updated.tasks[2].spend.entries[0], source, tokens: 0, input: 0, cached: 0, output: 0, cost_usd: 0,
  });
  h.writeState('tasks.json', updated);
  result = h.json(['bench', 'tokens']);
  assert.equal(result.complete, 2);
});

test('token categories preserve unknown breakdowns across spend entries', () => {
  const measured = { tokens: 100, input: 70, cached: 20, output: 30 };
  const unknown = { tokens: 200, input: null, cached: null, output: null };
  for (const [entries, expected] of [
    [[unknown], [null, null, null]],
    [[measured, unknown], [null, null, null]],
    [[unknown, measured], [null, null, null]],
    [[{ ...unknown, cached: 10, output: 20 }], [null, 10, 20]],
    [[{ ...measured, output: null }], [50, 20, null]],
    [[{ tokens: 0, input: 0, cached: 0, output: 0 }], [0, 0, 0]],
  ]) {
    const row = taskSpend({ spend: { entries } }, new Map());
    assert.deepEqual([row.fresh, row.cached, row.output], expected, JSON.stringify(entries));
  }
});

test('bench tokens excludes unknown categories from medians while retaining known totals and measured zeros', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  for (const title of ['measured', 'total only', 'measured zeros']) {
    h.ok(['task', 'add', '--title', title, '--acceptance', 'done']);
  }
  h.ok(['spend', 'T1', '--tokens', '100', '--input', '70', '--cached', '20', '--output', '30', '--rung', 'medium']);
  h.ok(['spend', 'T2', '--tokens', '200', '--rung', 'medium']);
  h.ok(['spend', 'T3', '--tokens', '100', '--input', '100', '--cached', '0', '--output', '0', '--rung', 'medium']);
  const doc = h.readState('tasks.json');
  for (const task of doc.tasks) task.status = 'accepted';
  h.writeState('tasks.json', doc);
  const result = h.json(['bench', 'tokens']);
  assert.deepEqual([result.accepted, result.complete, result.all_tasks_tokens], [3, 3, 400]);
  assert.equal(result.overall.median_tokens, 100);
  for (const group of [result.overall, result.by_path.medium]) {
    assert.deepEqual([group.median_fresh, group.median_cached, group.median_output], [75, 10, 15]);
  }
  const unknown = result.tasks.find((row) => row.id === 'T2');
  assert.deepEqual([unknown.fresh, unknown.cached, unknown.output], [null, null, null]);
  // With no measured breakdown left, category medians stay unknown.
  for (const task of doc.tasks) if (task.id !== 'T2') task.status = 'todo';
  h.writeState('tasks.json', doc);
  const onlyUnknown = h.json(['bench', 'tokens']);
  assert.deepEqual([onlyUnknown.overall.median_fresh, onlyUnknown.overall.median_cached, onlyUnknown.overall.median_output], [null, null, null]);
});

test('token completeness requires finalized usage even for measured or stale live entries', () => {
  const measured = { source: 'spawn:worker-T1', tokens: 100, input: 90, cached: 0, output: 10 };
  for (const [entry, expected] of [
    [{ ...measured, live: { state: 'live', interval_ms: 1000 } }, [100, 1]],
    [{ ...measured, live: { state: 'stale', interval_ms: 1000 } }, [100, 1]],
    [{ ...measured, tokens: 0, input: 0, output: 0, live: { state: 'live', interval_ms: 1000 } }, [0, 1]],
    [{ ...measured, tokens: null, input: null, cached: null, output: null, live: { state: 'unavailable', interval_ms: 1000 } }, [0, 1]],
    [measured, [100, 0]],
    [{ ...measured, tokens: null, input: null, cached: null, output: null }, [0, 1]],
    [{ source: 'manual', tokens: null, input: null }, [0, 0]],
  ]) {
    const result = taskSpend({ spend: { entries: [entry] } }, new Map());
    assert.deepEqual([result.tokens, result.unknown], expected, JSON.stringify(entry));
  }
});

test('bench tokens excludes live worker and reviewer usage from every median until collection finalizes it', (t) => {
  const h = makeRepo(t);
  t.after(h.cleanup);
  h.init();
  h.ok(['task', 'add', '--title', 'accepted before collection', '--acceptance', 'done']);
  const dispatches = ['worker', 'reviewer'].map((role) => ({
    at: '2026-10-07T00:00:00Z', cmd: 'spawn', task: 'T1',
    detail: { agent: `${role}-T1`, role, rung: role === 'worker' ? 'medium' : 'review' },
  }));
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), dispatches.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const doc = h.readState('tasks.json');
  const task = doc.tasks[0];
  task.status = 'accepted';
  task.spend.entries = ['worker', 'reviewer'].map((role) => ({
    at: '2026-10-07T00:00:30Z', agent: `${role}-T1`, source: `spawn:${role}-T1`, minutes: 0,
    tokens: role === 'worker' ? 1000 : 100, input: role === 'worker' ? 900 : 90, cached: 0,
    output: role === 'worker' ? 100 : 10, cost_usd: role === 'worker' ? 0.001 : 0.0001,
    rung: role === 'worker' ? 'medium' : 'review', harness: null, model: null, profile: null,
  }));
  const [worker, reviewer] = task.spend.entries;
  reviewer.live = { state: 'live', interval_ms: 1000 };
  const incomplete = (tokens, unknown) => {
    h.writeState('tasks.json', doc);
    const result = h.json(['bench', 'tokens']);
    assert.deepEqual([result.accepted, result.complete, result.overall.tasks, result.overall.priced_tasks], [1, 0, 0, 0]);
    assert.deepEqual([result.overall.median_tokens, result.overall.mean_tokens, result.overall.median_usd], [null, null, null]);
    assert.deepEqual(result.by_path, {});
    assert.deepEqual(result.by_rung, {});
    assert.deepEqual([result.all_tasks_tokens, result.tokens_per_accepted], [tokens, tokens], 'live usage stays in recorded-spend totals');
    assert.equal(result.tasks[0].unknown, unknown);
    assert.deepEqual(result.tasks[0].missing_spawns, [], 'recorded live usage is incomplete, not absent');
  };
  incomplete(1100, 1);
  worker.live = { state: 'stale', interval_ms: 1000 };
  incomplete(1100, 2);
  delete reviewer.live;
  Object.assign(reviewer, { tokens: 10000, input: 9000, output: 1000, cost_usd: 0.01 });
  incomplete(11000, 1);
  // Collection can finalize a source without changing its last measured counters.
  delete worker.live;
  h.writeState('tasks.json', doc);
  const result = h.json(['bench', 'tokens']);
  assert.deepEqual([result.accepted, result.complete, result.all_tasks_tokens], [1, 1, 11000]);
  for (const group of [result.overall, result.by_path.medium]) {
    assert.deepEqual([group.tasks, group.priced_tasks, group.median_tokens, group.mean_tokens], [1, 1, 11000, 11000]);
    assert.ok(Math.abs(group.median_usd - 0.011) < 1e-12);
    assert.deepEqual([group.median_fresh, group.median_cached, group.median_output], [9900, 0, 1100]);
  }
  assert.deepEqual([result.by_rung.medium.median_tokens, result.by_rung.review.median_tokens], [1000, 10000]);
  assert.deepEqual([result.by_rung.medium.median_usd, result.by_rung.review.median_usd], [0.001, 0.01]);
  assert.equal(result.tasks[0].unknown, 0);
});
