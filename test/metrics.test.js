'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, TMP_ROOT } = require('./helpers');
const S = require('../lib/state');
const Cause = require('../lib/rework-cause');
const M = require('../lib/metrics');

const B = Date.parse('2026-10-20T00:00:00Z');
const at = (min) => new Date(B + min * 60000).toISOString();
const MIN = 60000;

function ev(min, cmd, task, detail = {}, agent = 'orchestrator') {
  return { at: at(min), agent, cmd, task, detail };
}

// Five tasks with known phases, causes and spend. T2 fails T1's flaky test
// first, which makes T1's tests rework cross_task. T4 was first claimed
// before the cohort time, T5 is never merged.
function history() {
  const flaky = 'tests failed at a1: Head suite mode full: tests.map is not pinned.\n`node test/run.js` at a1: exit 1.\nFailing tests:\n- flaky one (12.5ms)\nOutput tail (last 40 lines):\nnot ok';
  return [
    ev(0, 'task add', 'T1'), ev(0, 'task add', 'T2'), ev(0, 'task add', 'T3'), ev(0, 'task add', 'T5'), ev(-200, 'task add', 'T4'),
    ev(-100, 'claim', 'T4', { from: 'todo' }, 'worker-T4-1'),
    ev(5, 'claim', 'T2', { from: 'todo' }, 'worker-T2-1'),
    ev(10, 'claim', 'T1', { from: 'todo' }, 'worker-T1-1'),
    ev(10, 'claim', 'T5', { from: 'todo' }, 'worker-T5-1'),
    ev(20, 'claim', 'T3', { from: 'todo' }, 'worker-T3-1'),
    ev(20, 'submit', 'T5', { sha: 'e1' }, 'worker-T5-1'),
    ev(30, 'rework', 'T5', { reason: 'Merge main at abc1234 and resubmit; change nothing else.', sha: 'e1' }),
    ev(40, 'submit', 'T3', { sha: 'c1' }, 'worker-T3-1'),
    ev(50, 'rework', 'T3', { reason: 'PR #3 conflicts with main: a.js. Merge the base, resolve these files and submit a new head.', sha: 'c1' }),
    ev(50, 'submit', 'T2', { sha: 'b1' }, 'worker-T2-1'),
    ev(60, 'claim', 'T3', { from: 'rework' }, 'worker-T3-1'),
    ev(70, 'submit', 'T1', { sha: 'a1' }, 'worker-T1-1'),
    ev(70, 'submit', 'T3', { sha: 'c2' }, 'worker-T3-1'),
    ev(80, 'gate run', 'T1', { type: 'tests', sha: 'a1', source: 'gate:1', phase: 'running' }),
    ev(80, 'rework', 'T3', { reason: 'review FAIL by reviewer-T3-1 at c2:\nReview', sha: 'c2', from_review: true }),
    ev(85, 'gate run', 'T2', { type: 'tests', sha: 'b1', source: 'gate:2', phase: 'running' }),
    ev(86, 'gate run', 'T2', { type: 'tests', sha: 'b1', source: 'gate:2', phase: 'error', error: 'T2: tests gate deferred by the host governor: load: 30 on 24 cores is at or over 24' }),
    ev(90, 'check tests', 'T2', { type: 'tests', ok: false, sha: 'b1', test_failure: { names: ['flaky one'] } }),
    ev(90, 'claim', 'T3', { from: 'rework' }, 'worker-T3-1'),
    ev(95, 'rework', 'T2', { reason: 'PR #2 conflicts with main: b.js.', sha: 'b1', cause: 'conflict_base' }),
    ev(100, 'gate run', 'T1', { type: 'tests', sha: 'a1', source: 'gate:1', phase: 'done' }),
    ev(100, 'check tests', 'T1', { type: 'tests', ok: false, sha: 'a1', test_failure: { names: ['flaky one'] }, receipt: { changed_files: ['lib/x.js'] } }),
    ev(100, 'claim', 'T2', { from: 'rework' }, 'worker-T2-1'),
    ev(100, 'submit', 'T3', { sha: 'c3' }, 'worker-T3-1'),
    ev(100, 'submit', 'T4', { sha: 'd1' }, 'worker-T4-1'),
    ev(105, 'rework', 'T1', { reason: flaky, sha: 'a1', gate: 'tests' }),
    ev(110, 'submit', 'T2', { sha: 'b2' }, 'worker-T2-1'),
    ev(110, 'rework', 'T3', { reason: 'stack sync merged T2 at b2; submit c4 and rerun gates', sha: 'c3' }),
    ev(120, 'accept', 'T2', { sha: 'b2' }),
    ev(120, 'claim', 'T3', { from: 'rework' }, 'worker-T3-1'),
    ev(130, 'claim', 'T1', { from: 'rework' }, 'worker-T1-1'),
    ev(130, 'merge', 'T2', { type: 'merge', ok: true, sha: 'b2' }),
    ev(130, 'submit', 'T3', { sha: 'c4' }, 'worker-T3-1'),
    ev(140, 'rework', 'T3', { reason: 'tests failed at c4: coverage gap: no tests.map entry covers lib/y.js, because it is new.', sha: 'c4', gate: 'tests' }),
    ev(150, 'submit', 'T1', { sha: 'a2' }, 'worker-T1-1'),
    ev(150, 'claim', 'T3', { from: 'rework' }, 'worker-T3-1'),
    ev(150, 'rework', 'T4', { reason: 'PR #4 conflicts with tower-crane/T2-x: c.js.', sha: 'd1', cause: 'conflict_parent' }),
    ev(160, 'spawn', 'T1', { role: 'reviewer', agent: 'reviewer-T1-1', rung: 'review' }),
    ev(160, 'submit', 'T3', { sha: 'c5' }, 'worker-T3-1'),
    ev(160, 'claim', 'T4', { from: 'rework' }, 'worker-T4-1'),
    ev(170, 'spawn exit', 'T1', { role: 'reviewer', agent: 'reviewer-T1-1', code: 0 }),
    ev(170, 'evidence', 'T1', { type: 'review', ok: true, sha: 'a2' }, 'reviewer-T1-1'),
    ev(170, 'accept', 'T3', { sha: 'c5' }),
    ev(170, 'submit', 'T4', { sha: 'd2' }, 'worker-T4-1'),
    ev(175, 'check ci', 'T1', { type: 'ci', ok: false, sha: 'a2', pending: true }),
    ev(175, 'check ci', 'T1', { type: 'ci', ok: true, sha: 'a2' }),
    ev(176, 'check clean', 'T1', { type: 'clean', ok: true, sha: 'a2' }),
    ev(180, 'accept', 'T1', { sha: 'a2' }),
    ev(180, 'accept', 'T4', { sha: 'd2' }),
    ev(200, 'head check', 'T1', { sha: 'a2', ok: true, started_at: at(190), summary: 'ok' }),
    ev(210, 'merge', 'T1', { type: 'merge', ok: true, sha: 'a2' }),
    ev(211, 'merge', 'T1', { type: 'merge', ok: true, sha: 'a2' }),
    ev(250, 'merge', 'T4', { type: 'merge', ok: true, sha: 'd2' }),
    ev(300, 'merge', 'T3', { type: 'merge', ok: true, sha: 'c5' }),
    // Spend: T1 complete (a live reading its exit replaced, a reviewer, a
    // minutes-only report), T2 with a spawn missing usage, T3 with one still live.
    ev(20, 'spend live', 'T1', { agent: 'worker-T1-1', source: 'spawn:worker-T1-1', tokens: 1000, rung: 'medium', harness: 'codex', live: { state: 'live' } }),
    ev(150, 'spend', 'T1', { agent: 'worker-T1-1', source: 'spawn:worker-T1-1', tokens: 5000, rung: 'medium', harness: 'codex' }),
    ev(170, 'spend', 'T1', { agent: 'reviewer-T1-1', source: 'spawn:reviewer-T1-1', tokens: 2000, rung: 'review', harness: 'claude' }),
    ev(150, 'spend', 'T1', { agent: 'worker-T1-1', source: 'manual', minutes: 12, tokens: null, input: null }, 'worker-T1-1'),
    ev(110, 'spend', 'T2', { agent: 'worker-T2-1', source: 'spawn:worker-T2-1', tokens: null, rung: 'medium', harness: 'codex' }),
    ev(160, 'spend', 'T3', { agent: 'worker-T3-1', source: 'spawn:worker-T3-1', tokens: 3000, rung: 'hard', harness: 'claude' }),
    ev(165, 'spend live', 'T3', { agent: 'worker-T3-2', source: 'spawn:worker-T3-2', tokens: 400, rung: 'hard', harness: 'claude', live: { state: 'live' } }),
  ];
}

function writeLog(file, events, torn) {
  // Writers append in time order; the fixture lists events by task for reading.
  const sorted = events.map((e, i) => [e, i]).sort((a, b) => a[0].at.localeCompare(b[0].at) || a[1] - b[1]).map(([e]) => e);
  fs.appendFileSync(file, sorted.map((e) => `${JSON.stringify(e)}\n`).join('') + (torn || ''));
}

function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return `${name} ${st.isDirectory() ? 'dir' : `${st.size} ${st.mtimeMs}`}`;
  });
}

// The torn last line would add a merge of T9 if it were read.
const TORN = `{"at":"${at(100)}","agent":"orchestrator","cmd":"merge","task":"T9","detail":{"ok":tr`;

test('metrics reports merges, causes, the Tower Crane share, tokens and phases for a cohort, lock-free and read-only', (t) => {
  const h = makeRepo(t);
  h.init();
  writeLog(path.join(h.state, 'events.jsonl'), history(), TORN);
  const window = ['--since', '2026-10-19T00:00:00Z', '--until', '2026-10-21T00:00:00Z'];
  const env = { ...h.env, TZ: 'UTC' };
  let all;
  let cohort;
  let text;
  let before;
  let after;
  // Holding the state lock proves the command never waits for it.
  S.withLock(h.state, () => {
    before = snapshot(h.state);
    all = h.json(['metrics', ...window], { env });
    cohort = h.json(['metrics', ...window, '--claimed-after', '2026-10-20T00:00:00Z', '--by', 'day'], { env });
    text = h.ok(['metrics', ...window, '--claimed-after', '2026-10-20T00:00:00Z'], { env });
    after = snapshot(h.state);
  });
  assert.deepEqual(after, before, 'metrics wrote nothing in the state directory');
  assert.equal(all.log.torn_last_line, true);

  assert.deepEqual([all.merges.tasks, all.merges.total], [4, 4]);
  const causes = (r) => Object.fromEntries(Object.entries(r.by_cause).filter(([, n]) => n));
  assert.deepEqual(causes(all.reworks.merged_tasks), { conflict_base: 2, conflict_parent: 1, stack_sync: 1, coverage_gap: 1, cross_task: 1, review: 1 });
  assert.deepEqual([all.reworks.merged_tasks.tc_caused, all.reworks.merged_tasks.tc_share], [6, 0.857]);
  assert.deepEqual([all.reworks.raised_in_window.total, all.reworks.raised_in_window.by_cause.manual, all.reworks.raised_in_window.tc_share], [8, 1, 0.75]);
  assert.deepEqual(all.cohort, { claimed_after: null, excluded_merged_tasks: 0, excluded_reworks_raised: 0 });

  assert.deepEqual(cohort.cohort, { claimed_after: '2026-10-20T00:00:00.000Z', excluded_merged_tasks: 1, excluded_reworks_raised: 1 });
  assert.deepEqual([cohort.merges.tasks, cohort.merges.total], [3, 3]);
  assert.deepEqual(cohort.by_day, [{ day: '2026-10-20', merges: 3, reworks: 7, tc_caused: 5, tokens_known: 10000 }]);
  const m = cohort.reworks.merged_tasks;
  assert.deepEqual([m.total, m.tc_caused, m.by_cause.conflict_parent, m.per_task.p50, m.per_task.p90], [6, 5, 0, 1, 4]);
  assert.deepEqual([cohort.reworks.raised_in_window.total, cohort.reworks.raised_in_window.tc_caused], [7, 5]);

  const g = cohort.gate_runs;
  assert.deepEqual(['tests', 'clean', 'review', 'ci', 'head_check'].map((k) => g.per_task[k].sum), [2, 1, 1, 1, 1]);
  assert.equal(g.governor_deferrals.tests, 1);
  assert.equal(g.tests_wall_ms.per_task.sum, 20 * MIN);
  assert.deepEqual(g.tests_cpu_ms, { value: null, runs_recorded: 0, runs: 1 });

  const tk = cohort.tokens;
  assert.deepEqual([tk.complete_tasks, tk.partial_tasks, tk.per_task.p50, tk.per_task.n], [1, 2, 7000, 1]);
  assert.deepEqual([tk.known_lower_bound.p50, tk.known_lower_bound.p90, tk.known_lower_bound.sum], [3000, 7000, 10000]);
  assert.deepEqual(tk.by_role, { worker: 8000, reviewer: 2000, other: 0 });
  assert.deepEqual(tk.entries, { total: 6, with_tokens: 3, without_tokens: { live: 1, spawn: 1, manual: 1 } });

  const l = cohort.lead_time;
  assert.deepEqual([l.total.p50, l.total.p90, l.total.sum], [210 * MIN, 300 * MIN, 640 * MIN]);
  assert.equal(Object.values(l.phases).reduce((n, p) => n + p.sum, 0), l.total.sum, 'phases add up to the lead time');
  assert.deepEqual(Object.fromEntries(Object.entries(l.phases).map(([k, v]) => [k, v.sum / MIN])),
    { queued: 35, working: 195, waiting_for_gates: 140, gating: 30, reviewing: 10, rework_waiting: 70, accepted_to_merged: 160 });
  assert.equal(l.waiting_share, 0.633);
  assert.deepEqual([cohort.submits.per_task.p50, cohort.submits.per_task.p90, cohort.submits.per_task.mean], [2, 5, 3]);
  assert.deepEqual([cohort.submits.first_pass_ms.p50, cohort.submits.first_pass_ms.p90], [45 * MIN, 60 * MIN]);
  assert.ok(cohort.definitions.tc_caused && cohort.definitions.phases.gating);

  assert.match(text, /^cohort: first claim at or after 2026-10-20T00:00:00\.000Z; excluded 1 merged tasks and 1 reworks raised$/m);
  assert.match(text, /^merged: 3 tasks, 3 merges/m);
  assert.match(text, /^tc caused +5 \(83%\) +5 \(71%\)$/m);
  assert.match(text, /^cross_task \(tc\) +1 +1$/m);
});

test('rework causes from reason text when an event records none', () => {
  const rows = [
    [{ reason: 'PR #4 conflicts with main: a.js. Merge the base' }, 'conflict_base'],
    [{ reason: 'PR #4 conflicts with tower-crane/T1-x: a.js.' }, 'conflict_parent'],
    [{ reason: "Merge T1's resubmitted head abc into T2; resolve conflicts in: a.js." }, 'conflict_parent'],
    [{ reason: 'gh stack sync aborted: conflict' }, 'stack_sync'],
    [{ reason: 'review FAIL by reviewer-T1-1 at abc' }, 'review'],
    [{ reason: 'final review FAIL at abc:\nconcerns' }, 'review'],
    [{ reason: 'anything', from_review: true }, 'review'],
    [{ reason: 'full suite fails on PR #4 merged with main. exit 1' }, 'head_check'],
    [{ reason: 'tests failed at abc: coverage gap: no tests.map entry covers a.js' }, 'coverage_gap'],
    [{ reason: 'tests failed at abc: `npm test` at abc: timed out after 20 min (infrastructure failure).' }, 'timeout'],
    [{ reason: 'tests failed at abc: Failing tests:\n- x', gate: 'tests' }, 'tests'],
    [{ reason: 'ci failed at abc: PR #4 is CONFLICTING (DIRTY): resolve merge conflicts' }, 'conflict_base'],
    [{ reason: 'ci failed at abc: CI not green' }, 'ci'],
    [{ reason: 'clean failed at abc: findings' }, 'clean'],
    [{ reason: 'stall: no progress' }, 'timeout'],
    [{ reason: 'please also fix the docs' }, 'manual'],
  ];
  for (const [detail, cause] of rows) assert.equal(Cause.fromReason(detail), cause, detail.reason);
  // Flags of the failed check at the same head decide what the text cannot.
  const evidence = (flags) => () => flags;
  assert.equal(Cause.fromReason({ reason: 'tests failed at abc: Failing tests:\n- x' }, { gateEvidence: evidence({ main_failure: { names: ['x'] } }) }), 'base_failure');
  assert.equal(Cause.fromReason({ reason: 'tests failed at abc: runner died' }, { gateEvidence: evidence({ runner_crash: true }) }), 'infrastructure');
  assert.equal(Cause.fromReason({ reason: 'PR #4 conflicts with develop: a.js' }, { base: 'develop' }), 'conflict_base');
});

test('a head check rework has a culprit only when a failing test file is one the task changed', () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'metrics-'));
  try {
    const failing = (file) => `full suite fails on PR #1 merged with main. exit 1. Last 40 lines:\n✖ failing tests:\n\ntest at ${file}:3:1\n✖ boom (4.2ms)\n  AssertionError`;
    const events = [];
    for (const [id, file] of [['T1', 'test/a.test.js'], ['T2', 'test/other.test.js']]) {
      events.push(ev(0, 'task add', id), ev(1, 'claim', id), ev(2, 'submit', id),
        ev(3, 'check tests', id, { type: 'tests', ok: true, sha: 's', receipt: { changed_files: ['lib/a.js', 'test/a.test.js'] } }),
        ev(4, 'accept', id), ev(5, 'rework', id, { reason: failing(file), sha: 's' }), ev(6, 'claim', id), ev(7, 'submit', id),
        ev(8, 'accept', id), ev(9, 'merge', id, { ok: true, sha: 's2' }));
    }
    writeLog(path.join(dir, 'events.jsonl'), events);
    const r = M.report(dir, { since: B - MIN, until: B + 60 * MIN });
    assert.equal(r.reworks.merged_tasks.by_cause.head_check, 2);
    assert.deepEqual(r.reworks.merged_tasks.head_check_culprit, { yes: 1, no: 1 });
    assert.equal(r.reworks.merged_tasks.tc_caused, 1);
    assert.deepEqual(M.failures(failing('test/a.test.js')), { names: ['boom'], files: ['test/a.test.js'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
