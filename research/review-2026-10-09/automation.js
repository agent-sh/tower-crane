'use strict';

const { ROOT, repo, task, submit, load, replay, event, receipt, P, assert, fs, path } = require('./harness');
const probes = [];
const names = ['eligible', 'executors', 'waiting', 'reserve', 'queuedFor', 'line', 'software', 'headCheck', 'hold', 'advance'];
function probe(id, expected, fn) {
  probes.push({ id, expected, async run() {
    const h = repo();
    try {
      h.init();
      for (let i = 0; i < 3; i++) submit(h, task(h, 'docs', `Queue ${i}`));
      const r = replay(h.snapshot());
      r.st.project.gates = { ...r.st.project.gates, executors: 1 };
      r.sources = r.st.events.filter((e) => e.cmd === 'submit');
      r.engine = (extra = {}) => load('lib/automation.js', names, { './state': r.state, ...extra });
      r.a = r.engine();
      r.queue = (source) => r.st.events.push(event('automation queued', source.task, { source: source.id }));
      return await fn(r, h);
    } finally { await h.cleanup(); }
  } });
}

probe('A01', 'A live local executor at cap 1 queues another task.', ({ st, a, ctx, sources }) => {
  st.events.push(receipt(sources[0]));
  const reserved = a.reserve(ctx, sources[1]);
  return { held: reserved === false && a.executors(st) === 1, observed: { reserved, executors: a.executors(st) } };
});
probe('A02', 'A dead executor does not consume a slot and its source can be retried.', ({ st, a, ctx, sources }) => {
  st.events.push(receipt(sources[0], { start_ticks: 'impossible-start-ticks' }));
  assert.equal(P.processState(st.events.at(-1).detail), 'exited');
  const before = a.executors(st);
  const reserved = a.reserve(ctx, sources[0]);
  return { held: before === 0 && reserved === true, observed: { before, reserved } };
});
probe('A03', 'A foreign host executor holds its task but does not consume a local host slot.', ({ st, a, ctx, sources }) => {
  st.events.push(receipt(sources[0], { host: 'unobservable-probe-host' }));
  const own = a.reserve(ctx, sources[0]);
  const other = a.reserve(ctx, sources[1]);
  return { held: own === false && other === true, observed: { sameTask: own, otherTask: other } };
});
probe('A04', 'An older queued eligible source takes a free slot before a newer source.', ({ a, ctx, sources, queue }) => {
  queue(sources[0]);
  const reserved = a.reserve(ctx, sources[2]);
  return { held: reserved === 'behind', observed: { reserved } };
});
probe('A05', 'A cancelled task never reserves an executor or blocks the next queued task.', ({ st, a, ctx, sources, queue }) => {
  queue(sources[0]);
  st.tasks.tasks[0].status = 'cancelled';
  const old = a.reserve(ctx, sources[0]);
  const next = a.reserve(ctx, sources[1]);
  return { held: old === false && next === true, observed: { cancelled: old, next } };
});
probe('A06', 'A queued source for an old head does not block a current source.', ({ st, a, ctx, sources, queue }) => {
  queue(sources[0]);
  st.tasks.tasks[0].sha = 'b'.repeat(40);
  const pending = a.waiting(st).map((e) => e.task);
  const reserved = a.reserve(ctx, sources[1]);
  return { held: !pending.includes('T1') && reserved === true, observed: { pending, reserved } };
});
probe('A07', 'A completed source is deduplicated.', ({ st, a, ctx, sources }) => {
  st.events.push(receipt(sources[0], { phase: 'done' }));
  const reserved = a.reserve(ctx, sources[0]);
  return { held: reserved === false, observed: { reserved } };
});
probe('A08', 'A queued error source is retryable through explicit consume but omitted from automatic queue draining.', ({ st, a, ctx, sources, queue }) => {
  queue(sources[0]);
  st.events.push(receipt(sources[0], { phase: 'error' }));
  const waiting = a.waiting(st).length;
  const reserved = a.reserve(ctx, sources[0]);
  return { verdict: waiting === 0 && reserved === true ? 'by design' : 'CONFIRMED',
    observed: { waiting, explicitRetryReserved: reserved } };
});
probe('A09', 'Startup reconciliation covers active PRs only; an errored no-PR task needs explicit replay.', ({ st, a, ctx, sources, queue }) => {
  queue(sources[0]);
  st.events.push(receipt(sources[0], { phase: 'error', error: 'temporary command failure' }));
  const backlog = a.backlog(ctx);
  const waiting = a.waiting(st);
  return { verdict: backlog.length === 0 && waiting.length === 0 ? 'by design' : 'held',
    observed: { backlog: backlog.length, waiting: waiting.length, pr: st.tasks.tasks[0].pr } };
});
probe('A10', 'Restart creates fresh reconciliation for an accepted, unmerged PR after a deferred receipt.', ({ st, a, ctx, sources }) => {
  Object.assign(st.tasks.tasks[0], { status: 'accepted', pr: 1 });
  st.events.push(receipt(sources[0], { phase: 'deferred' }));
  const backlog = a.backlog(ctx);
  return { held: backlog.length === 1 && backlog[0].task === 'T1',
    observed: { tasks: backlog.map((e) => e.task) } };
});
probe('A11', '104 queued sources for a now-cancelled task are historical receipts, not runnable work.', ({ st, a, sources, queue }) => {
  for (let i = 0; i < 104; i++) {
    const e = event('ci completed', 'T1', { sha: sources[0].detail.sha, revision: 1 });
    st.events.push(e);
    queue(e);
  }
  st.tasks.tasks[0].status = 'cancelled';
  const queued = st.events.filter((e) => e.cmd === 'automation queued').length;
  const waiting = a.waiting(st).length;
  return { verdict: waiting === 0 ? 'by design' : 'CONFIRMED', observed: { queuedWithoutDone: queued, runnable: waiting } };
});
probe('A12', '104 eligible queued sources become runnable after a dead holder; receipt count does not strand them.', ({ st, a, sources, queue }) => {
  for (let i = 0; i < 104; i++) {
    const e = event('ci completed', 'T1', { sha: sources[0].detail.sha, revision: 1 });
    st.events.push(e);
    queue(e);
  }
  st.events.push(receipt(sources[0], { start_ticks: 'impossible-start-ticks' }));
  const waiting = a.waiting(st).length;
  return { held: waiting === 104, observed: { runnable: waiting } };
});
probe('A13', 'A live holder suppresses all 104 queued sources for its task without blocking a free slot for another.', ({ st, a, ctx, sources, queue }) => {
  st.project.gates.executors = 2;
  for (let i = 0; i < 104; i++) {
    const e = event('ci completed', 'T1', { sha: sources[0].detail.sha });
    st.events.push(e); queue(e);
  }
  st.events.push(receipt(sources[0]));
  const waiting = a.waiting(st).length;
  const next = a.reserve(ctx, sources[1]);
  return { held: waiting === 0 && next === true, observed: { runnable: waiting, next } };
});
probe('A14', 'An accepted unmerged task remains eligible; cancellation makes the same event ineligible.', ({ st, a, sources }) => {
  st.tasks.tasks[0].status = 'accepted';
  const accepted = a.eligible(st, sources[0]);
  st.tasks.tasks[0].status = 'cancelled';
  const cancelled = a.eligible(st, sources[0]);
  return { held: accepted && !cancelled, observed: { accepted, cancelled } };
});
probe('A15', 'A successful merge receipt triggers one sweep even after the task is recorded merged.', ({ st, a, sources }) => {
  const t = st.tasks.tasks[0];
  t.status = 'accepted';
  const entry = { type: 'merge', ok: true, source: 'merge', sha: t.sha, revision: t.revision,
    agent: 'orchestrator', commands: [{ command: 'gh', args: ['pr', 'view'], status: 0 }] };
  t.evidence.push(entry);
  const e = event('merge', t.id, entry);
  st.events.push(e);
  const mergedEvent = a.eligible(st, e);
  const oldSubmit = a.eligible(st, sources[0]);
  return { held: mergedEvent && !oldSubmit, observed: { mergedEvent, oldSubmit } };
});
probes.push({ id: 'A16', expected: 'Automation reruns a tests gate whose successful audited receipt became stale under a new command policy.',
  async run() {
    const h = repo();
    try {
      const sha = require(`${ROOT}/test/gate-helpers`).gateFixture(h);
      h.init(['--base', 'main']);
      submit(h, task(h, 'code'), sha);
      h.ok(['check', 'tests', 'T1']);
      const T = require(`${ROOT}/lib/tasks`);
      const tests = () => {
        const st = h.snapshot();
        return T.gateReport(st.tasks.tasks[0], st.events, st).gates[0];
      };
      assert.equal(tests().ok, true);
      h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"']);
      assert.equal(tests().ok, false);
      const before = h.events().filter((e) => e.cmd === 'check tests').length;
      const wait = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0']);
      assert.ok([0, 2].includes(wait.code), wait.stderr);
      assert.ok(h.events().some((e) => e.cmd === 'automation'), 'the watcher reached the submission reaction');
      const after = h.events().filter((e) => e.cmd === 'check tests').length;
      return { held: after > before, observed: { testsRunsBefore: before, testsRunsAfter: after, gate: tests() } };
    } finally { await h.cleanup(); }
  },
});
probe('A17', 'A repeated failed gate waits for an explicit retry at unchanged settings.', async ({ st, engine, ctx }) => {
  const t = st.tasks.tasks[0];
  t.kind = 'code';
  t.evidence.push({ type: 'tests', ok: false, sha: t.sha, revision: t.revision });
  const calls = [];
  await engine({ './check': { runGate: async (_ctx, type) => calls.push(type) } }).software(ctx);
  return { verdict: calls.length ? 'CONFIRMED' : 'by design', observed: { gateCalls: calls } };
});
probe('A18', 'An accepted stack is ordered by its lower member even when its upper member was accepted first.', ({ st, a }) => {
  const [lower, upper, other] = st.tasks.tasks;
  for (const t of st.tasks.tasks) { t.status = 'accepted'; t.pr = Number(t.id.slice(1)); }
  upper.stack = { parent: lower.id, linked: true, base: 'task-lower' };
  for (const t of [upper, other, lower]) st.events.push(event('accept', t.id, { sha: t.sha, revision: t.revision }));
  const order = a.line(st).map((e) => e.members.map((m) => m.id));
  return { held: JSON.stringify(order) === JSON.stringify([['T3'], ['T1', 'T2']]), observed: { order } };
});
probe('A19', 'A non-observable local executor remains busy rather than being treated as dead.', ({ st, a, ctx, sources }) => {
  st.events.push(receipt(sources[0], { pid: null }));
  const reserved = a.reserve(ctx, sources[1]);
  return { held: reserved === false, observed: { reserved, executors: a.executors(st) } };
});

probe('A20', 'All 104 eligible queued notifications drain after the holder dies; each gets a done receipt.', async ({ st, a, ctx, sources, queue }) => {
  const ids = new Set();
  for (let i = 0; i < 104; i++) {
    const e = event('submit', 'T1', { sha: sources[0].detail.sha });
    ids.add(e.id); st.events.push(e); queue(e);
  }
  st.events.push(receipt(sources[0], { start_ticks: 'impossible-start-ticks' }));
  await a.consume(ctx, a.waiting(st), true);
  const done = st.events.filter((e) => e.cmd === 'automation' && e.detail.phase === 'done' && ids.has(e.detail.source)).length;
  const pending = a.waiting(st).length;
  return { held: done === 104 && pending === 0, observed: { done, pending } };
});

probe('A21', 'A known conflicting PR returns to rework before a tests or cleanup command runs (T143 control).', async ({ st, ctx, engine }, h) => {
  const file = path.join(h.repo, 'conflict.txt');
  fs.writeFileSync(file, 'base\n');
  h.git(['add', 'conflict.txt']); h.git(['commit', '-qm', 'conflict base']);
  h.git(['switch', '-qc', 'conflict-head']);
  fs.writeFileSync(file, 'task\n');
  h.git(['commit', '-qam', 'task side']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', 'main']);
  fs.writeFileSync(file, 'main\n');
  h.git(['commit', '-qam', 'main side']);
  const t = st.tasks.tasks[0];
  Object.assign(t, { sha, kind: 'code', pr: 7 });
  st.project.repo = 'acme/probe';
  const C = require(`${ROOT}/lib/gates/common`);
  const T = require(`${ROOT}/lib/tasks`);
  const gates = [];
  const reworks = [];
  const a = engine({
    './gates/common': { ...C, gh: async () => ({ ok: true, stdout: JSON.stringify({
      state: 'OPEN', headRefOid: sha, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
    }) }) },
    './check': { runGate: async (_ctx, type) => gates.push(type) },
    './tasks': { ...T, rework: (action) => { reworks.push(action.flags.reason); t.status = 'rework'; } },
  });
  const result = await a.advance(ctx);
  return { held: result === 'done' && reworks.length === 1 && gates.length === 0,
    observed: { result, gates, reworks } };
});

module.exports = probes;
