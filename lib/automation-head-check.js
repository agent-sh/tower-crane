'use strict';

const S = require('./state');
const T = require('./tasks');
const Runtime = require('./runtime');
const C = require('./gates/common');
const { isDeepStrictEqual } = require('node:util');
const { refuse } = require('./util');
const { sourceOf } = require('./automation-common');
const { releaseExecutor, takeExecutor } = require('./automation-executors');
const { baseTip, conflicts } = require('./automation-generated');
const { binding } = require('./automation-merge');

// Gate evidence belongs to the PR's own diff and survives a base move. Before
// merging, the head of the line runs the full suite (in crucial mode, the
// crucial and mapped suites the tests gate selects) once on its merge with
// the current project base, unless its head already contains that base or an
// earlier check covered the same head, revision, base and command. A stack
// runs it once at its top task, whose head carries every lower task.
async function headCheck(ctx, st, { members, target: task }, passed) {
  const bound = binding(st, passed);
  const tested = members.find((m) => T.requiredGates(m).includes('tests')
    && require('./tests-policy').resolve(st.project, m.kind).mode !== 'none');
  if (!tested) return { status: 'ok' };
  const mode = require('./tests-policy').resolve(st.project, tested.kind).mode;
  const selected = require('./gate-commands').select(st.project, 'tests', {}, mode);
  if (selected.error) throw refuse(`${task.id}: ${selected.error}`);
  const onto = st.project.base;
  const { repo, base, tip } = await baseTip(ctx, st, task, true, onto);
  const commands = [];
  // The suite's host governor place, taken once the suite will run; until then
  // its commands take the wait's signal alone.
  let unit = null;
  let signal = ctx.gateSignal;
  const gc = { root: repo.root, stateDir: ctx.stateDir, project: st.project, signal, tmpEnv: ctx.env, testGrant: { task: task.id, kind: 'suite' }, exec: async (command, args, opts = {}) => {
    const tree = ctx.gateSignal || opts.shell;
    const run = tree ? C.treeExec : require('./commands').spawnSync;
    const r = await run(command, args, { windowsHide: true, ...opts, signal: !tree || (opts.cleanup && signal?.aborted) ? undefined : signal,
      ...(tree && unit ? { onSpawn: (pid, scope) => unit.attach(pid, scope) } : {}) });
    Runtime.throwIfMissing(r.error);
    Runtime.throwIfMissing(r.stderr);
    commands.push({ command, args: [...args], cwd: opts.cwd || null, status: r.status ?? null, signal: r.signal || null });
    return r;
  } };
  const contains = async (m) => (await C.git(gc, repo.root, ['merge-base', '--is-ancestor', tip, m.sha])).ok;
  if ((await Promise.all(members.map(contains))).every(Boolean)) return { status: 'ok', tip };
  // Bottom first, so the rework goes to the lowest task that conflicts.
  for (const m of members) {
    const conflict = await conflicts({ ...ctx, pos: [m.id] }, m, false, onto);
    if (conflict === 'deferred') return { status: 'deferred', summary: `${m.id}: generated conflicts await matching GitHub confirmation` };
    if (conflict) return { status: 'rework' };
  }
  if (await contains(task)) return { status: 'ok', tip };
  const ids = members.map((m) => m.id);
  // Select from the merged tree so crucial files added on base are included.
  const head = await C.resolveCommit(gc, repo.root, task.sha);
  if (!head) throw refuse(`${task.id}: commit ${C.short(task.sha)} is not in ${repo.root} for the head check`);
  const tree = await C.git(gc, repo.root, ['-c', `attr.tree=${head}`, 'merge-tree', '--write-tree', tip, head], { timeout: 60000 });
  if (!tree.ok) throw refuse(`${task.id}: cannot merge ${base} at ${C.short(tip)} for the head check: ${C.errText(tree)}`);
  const merged = await C.mergeCommit(gc, repo.root, { base: tip, head, tree: tree.stdout.trim().split('\n')[0] });
  if (merged.error) throw refuse(`${task.id}: head check ${merged.error}`);
  // In crucial mode the line runs what the tests gate selects for the change, not the full suite.
  const crucial = await require('./gates/tests').queueSelection(gc, repo.root, st.project, tip, task.sha, task.kind, merged.sha);
  if (crucial?.error) throw refuse(`${task.id}: head check ${crucial.error}`);
  const cmd = crucial?.command || selected.command;
  const done = st.events.findLast((e) => e.cmd === 'head check' && e.task === task.id && C.sameSha(e.detail.sha, task.sha)
    && e.detail.revision === task.revision && e.detail.base_sha === tip && e.detail.command === cmd);
  const minutes = require('./gate-timeouts').minutes(st.project, 'tests');
  const retry = done?.detail.infrastructure_failure && done.detail.timeout?.minutes === minutes ? done : null;
  // The queue reservation serializes the rerun. Its receipt also serves later
  // passes, even if it times out, so queued notifications cannot multiply suites.
  if (done?.detail.rerun_of && (done.detail.ok || retry)) {
    const source = sourceOf(done);
    const summary = `Shared head-check rerun ${source}: ${done.detail.summary}`;
    S.mutate(ctx, 'head check shared', (st2, emit) => {
      if (st2.events.some((e) => e.cmd === 'head check shared' && e.task === task.id && e.detail.source === source)) return;
      emit(task.id, { sha: task.sha, revision: task.revision, base_sha: tip, command: cmd,
        source, ok: done.detail.ok, summary, ...(retry ? { infrastructure_failure: true } : {}) });
    });
    return done.detail.ok ? { status: 'ok', tip } : { status: 'infrastructure', summary };
  }
  if (done?.detail.ok) return { status: 'ok', tip };
  const what = `${C.short(task.sha)}${ids.length > 1 ? ` (stack ${ids.join(', ')})` : ''} merged with ${base} at ${C.short(tip)}`;
  // The suite runs on a clean checkout of a commit of the merge: a suite that requires a clean
  // tree fails when HEAD names the head while the index holds the merge. attr.tree reads
  // .gitattributes from the head, as the merge in a checkout of the head did, so its merge drivers apply.
  // A deferral or a stop leaves the line to the reaction's retry, with no head check recorded.
  await takeExecutor(ctx, task, 'head check');
  let outcome;
  try {
    unit = require('./governor').admit(ctx, { kind: 'suite', task: task.id, project: st.project });
    try {
      signal = gc.signal = AbortSignal.any([ctx.gateSignal, unit.signal].filter(Boolean));
      outcome = await suite(ctx, st, gc, repo, merged, cmd, what);
      const stopped = !ctx.gateSignal?.aborted && unit.stopped();
      if (stopped) throw stopped;
    } catch (e) {
      throw (!e.governorDeferred && !ctx.gateSignal?.aborted && unit.stopped()) || e;
    } finally {
      unit.release();
    }
  } finally {
    releaseExecutor(ctx);
  }
  if (!outcome.ran) throw refuse(`${task.id}: ${outcome.summary}`);
  Runtime.throwIfMissing(outcome.summary);
  S.mutate(ctx, 'head check', (st2, emit) => {
    emit(task.id, { sha: task.sha, revision: task.revision, base_sha: tip, command: cmd, members: ids, ok: outcome.ok, summary: outcome.summary, commands,
      ...(crucial ? { head_mode: 'crucial', head_tests: crucial.tests } : {}),
      ...(retry ? { rerun_of: sourceOf(retry) } : {}),
      ...(outcome.infrastructure_failure ? { infrastructure_failure: true, timeout: outcome.timeout } : {}) });
  });
  if (ctx.waitShutdown && ctx.automationSignal?.aborted && !ctx.gateSignal?.aborted) ctx.waitShutdown.drained += 1;
  ctx.automationSignal?.throwIfAborted();
  if (outcome.ok) return { status: 'ok', tip };
  if (outcome.infrastructure_failure) return { status: 'infrastructure', summary: outcome.summary };
  // The top task goes back; the line then checks the tasks below it alone.
  // A failure under a command, base or head that changed while the suite ran
  // says nothing about the current one, so the line checks again instead.
  T.rework({ ...ctx, pos: [task.id], expected: { sha: task.sha, revision: task.revision },
    expect: (now) => (isDeepStrictEqual(binding(now, passed), bound) ? null : 'head of the line changed during its check'),
    flags: { reason: `${crucial ? 'crucial and mapped suites fail' : 'full suite fails'} on PR #${task.pr} merged with ${base}. ${outcome.summary}` } });
  return { status: 'rework' };
}

// The head check's suite on a clean checkout of the merge commit.
function suite(ctx, st, gc, repo, merged, cmd, what) {
  return C.withWorktree(gc, repo.root, merged.sha, async (dir, env) => {
    const timeouts = require('./gate-timeouts');
    const minutes = timeouts.minutes(st.project, 'tests');
    const timeout = Math.round(minutes * 60 * 1000);
    ctx.automationSignal?.throwIfAborted();
    const run = await C.shell(gc, cmd, { cwd: dir, env, timeout, keep: 1 << 20 });
    if (run.timedOut) return { ran: true, ...timeouts.failure(run, minutes, cmd, `on ${what}`) };
    const out = run.output ?? [run.stdout, run.stderr].filter(Boolean).join('\n');
    return run.ok ? { ran: true, ok: true, summary: `\`${cmd}\` on ${what}: exit 0` }
      : { ran: true, ok: false, summary: `\`${cmd}\` on ${what}: ${C.how(run)}. Last 40 lines:\n${C.tailLines(out, 40)}` };
  });
}

module.exports = { headCheck, suite };
