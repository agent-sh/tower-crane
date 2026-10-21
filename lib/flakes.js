'use strict';
// A test that failed and then passed when its gate reran it once is flaky (docs/state.md#gate-reruns).
// The tests and local CI gates record each one in their evidence and audit event as `flaky`, so the
// events are the ledger. A test flaky in two different tasks within DAYS days is no one task's doing,
// and one task to fix it opens; its `task add` event names the test, so records before it never open
// another.
const S = require('./state');
const T = require('./tasks');
const { nowIso } = require('./util');

const DAYS = 7;
const GATES = { 'check tests': 'tests', 'check ci': 'ci' };

// Flaky records in the audit events, oldest first: {test, task, gate, sha, at, step, excerpt, ...}.
function ledger(events) {
  const found = [];
  for (const e of events) {
    if (!GATES[e.cmd] || !Array.isArray(e.detail?.flaky)) continue;
    for (const f of e.detail.flaky) {
      if (typeof f?.test !== 'string' || !f.test) continue;
      found.push({ ...f, task: e.task, gate: GATES[e.cmd], sha: e.detail.sha || null, at: e.at });
    }
  }
  return found;
}

function brief(id, test, records) {
  const runs = records.map((r) => [
    `### ${r.task}, ${r.gate} gate at ${r.sha}`,
    '',
    `${r.at}${r.step ? `, ${r.step} step` : ''}: \`${r.first_failure?.command ?? 'unknown command'}\` failed${r.first_failure?.error ? ` with ${r.first_failure.error}` : ''}, then \`${r.rerun?.command ?? 'its rerun'}\` passed.`,
    '',
    '```text',
    (r.first_failure?.excerpt || '(no excerpt)').replace(/```/g, "'''"),
    '```',
  ].join('\n'));
  return `# ${id}: fix flaky test ${test}\n\n${test} failed once and passed on its rerun in ${new Set(records.map((r) => r.task)).size} tasks within ${DAYS} days, so no one change caused it. Find why it fails some runs (shared files, wall-clock bounds under load, ordering, a real race in the code under test) and fix that cause. Retrying or loosening the test without a cause is not a fix.\n\n## Flaky runs\n\n${runs.join('\n\n')}\n`;
}

// Inside the mutation that records `entry` for `task`: opens one task for each of its flaky tests
// that another task also saw flaky within DAYS days of now, since that test's last flake task.
function open(st, emit, task, entry, now = Date.now()) {
  if (!Array.isArray(entry.flaky) || !entry.flaky.length) return [];
  const since = now - DAYS * 24 * 60 * 60 * 1000;
  const records = ledger(st.events);
  const gate = entry.type === 'tests' ? 'tests' : 'ci';
  const opened = [];
  for (const f of entry.flaky) {
    if (typeof f?.test !== 'string' || !f.test || opened.some((t) => t.test === f.test)) continue;
    const last = st.events.findLast((e) => e.cmd === 'task add' && e.detail?.flake === f.test);
    const after = Math.max(since, last ? Date.parse(last.at) : -Infinity);
    const prior = records.filter((r) => r.test === f.test && r.task !== task.id && Date.parse(r.at) >= after);
    if (!prior.length) continue;
    const mine = { ...f, task: task.id, gate, sha: entry.sha, at: entry.at };
    const seen = [prior.at(-1), mine];
    const t = T.newTask(st, { title: `Fix flaky test ${f.test}`, kind: 'code', size: 'S',
      acceptance: [`${f.test} passes on every run: the cause of its flaky failures in ${seen.map((r) => r.task).join(' and ')} is named and fixed`] });
    const at = nowIso();
    t.notes.push({ at, agent: 'tower-crane', text: `Opened because ${f.test} was flaky in ${seen.map((r) => `${r.task} at ${String(r.sha).slice(0, 7)}`).join(' and ')} within ${DAYS} days.` });
    S.writeAtomic(T.briefPath(st.dir, t.id), brief(t.id, f.test, seen));
    emit(t.id, { title: t.title, flake: f.test, seen: seen.map((r) => ({ task: r.task, gate: r.gate, sha: r.sha, at: r.at })) }, 'task add');
    opened.push({ id: t.id, test: f.test });
  }
  return opened;
}

module.exports = { ledger, open, brief, DAYS };
