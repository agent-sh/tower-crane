'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('./commands');
const { refuse, nowIso } = require('./util');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');

const GATES = ['tests', 'clean', 'sources', 'ci', 'merge'];

// The unpinned gate commands the named gates need for task.
function missingPins(st, task, gates) {
  const keys = [];
  if (gates.includes('tests') && require('./tests-policy').resolve(st.project, task.kind).mode !== 'none') keys.push('tests_cmd');
  if (gates.includes('clean')) keys.push('clean_cmd');
  return keys.filter((key) => st.project.gates?.[key] == null);
}

// Gates run outside the lock (tests can take minutes) and record their result
// afterwards against the revision they started on, so a plan change made
// meanwhile leaves the result uncounted.
function gatePath(name) {
  if (!GATES.includes(name)) throw refuse(`unknown gate ${name}`);
  const modPath = path.join(__dirname, 'gates', `${name}.js`);
  if (!fs.existsSync(modPath)) throw refuse(`gate not installed: ${name} (lib/gates/${name}.js is missing; update tower-crane)`);
  return modPath;
}

async function runGate(ctx, name) {
  const modPath = gatePath(name);
  // Merge reads under the lock so its stack snapshot is one consistent state.
  const load = () => (name === 'merge' ? S.withLock(ctx.stateDir, () => S.loadState(ctx.stateDir)) : S.loadState(ctx.stateDir));
  let st = load();
  const task = T.getTask(st, ctx.pos[0]);
  if (require('./gate-commands').heal(ctx, missingPins(st, task, [name])).length) st = load();
  // A caller that checked an earlier state refuses to run the gate on another.
  const stale = ctx.expect?.(st);
  if (stale) return { stale, data: null, text: `${task.id}: ${name} not run: ${stale}`, code: 1 };
  const testsMode = name === 'tests'
    ? { tests_mode: require('./tests-policy').resolve(st.project, task.kind).mode ?? null } : {};
  const ciPolicy = name === 'ci' && st.project.ci?.local == null
    ? { ci_policy: require('./ci-hosted').resolve(st.project).policy ?? null } : {};
  const gatePolicy = ['tests', 'clean'].includes(name)
    ? { gate_policy: require('./gate-commands').resolve(st.project, name).policy ?? null } : {};
  // The directory the gate built its worktree under, so evidence shows where its checkout lived.
  const worktreeRoot = ['tests', 'clean'].includes(name) || (name === 'ci' && st.project.ci?.local != null)
    ? { tmp_root: require('./gate-tmp').root(st.project) } : {};
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const Stack = require('./stack');
  const stackTasks = name === 'merge' ? Stack.chain(st, task) : [];
  const snapshot = name === 'merge' ? Stack.capture(st, [task.id]) : null;
  const isStacked = !!task.stack || st.tasks.tasks.some((t) => t.stack?.linked && Stack.chain(st, t).some((x) => x.id === task.id));
  // A stale local link can leave a dependent unlinked while GitHub still stacks it on this PR.
  const stackedAbove = name === 'merge'
    ? st.tasks.tasks.filter((t) => t.stack && t.pr && t.id !== task.id && t.status !== 'cancelled' && !Stack.merged(st, t)
      && Stack.chain(st, t).some((x) => x.id === task.id)).map((t) => ({ id: t.id, pr: t.pr, sha: t.sha }))
    : [];
  const commands = [];
  const gateCtx = {
    root: repo ? repo.root : null,
    mergeCommands: name === 'merge' ? st.events.filter((e) => e.cmd === 'merge' && e.detail?.type === 'merge').flatMap((e) => e.detail.commands || []) : [],
    // Capture execution here so a summary cannot stand in for a command receipt.
    exec: async (command, args, opts = {}) => {
      const run = opts.shell || opts.processTree ? require('./gates/common').treeExec : spawnSync;
      const r = await run(command, args, { windowsHide: true, ...opts });
      commands.push({ command, args: [...args], cwd: opts.cwd || null, status: r.status ?? null, signal: r.signal || null });
      return r;
    },
  };
  const gate = require(modPath);
  if (!gate || typeof gate.run !== 'function') throw refuse(`gate not installed: lib/gates/${name}.js does not export run(ctx)`);
  let result;
  if (name === 'merge') {
    if (task.status !== 'accepted') throw refuse(`${task.id} is ${task.status}; merge needs an accepted task`);
    // A PR that already landed at the accepted head is confirmed before any gate
    // or lower-member check: confirming reads only this task's PR, merges and
    // retargets nothing, and needs no current evidence. Stack members take the
    // same path. An open PR gets null here and goes through the gates below.
    const report = T.gateReport(task, st.events, st);
    const ci = T.latestGateEvidence(task, 'ci', st.events);
    if (typeof gate.confirm === 'function') {
      result = await gate.confirm({ ...gateCtx, task, project: st.project, isStacked, args: { ...ctx.flags } });
    }
    for (const member of result ? [] : stackTasks) {
      const ci = T.latestGateEvidence(member, 'ci', st.events);
      const merged = Stack.merged(st, member);
      if (!ci?.receipt || merged || !repo) continue;
      const { git, resolveCommit, how, errText, short } = require('./gates/common');
      const origin = await git(gateCtx, repo.root, ['remote', 'get-url', 'origin'], { timeout: 60000 });
      if (origin.ok) {
        const base = Stack.targetBase(st, member).replace(/^origin\//, '');
        const ref = `refs/remotes/origin/${base}`;
        const fetched = await git(gateCtx, repo.root,
          ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${ref}`],
          { timeout: 60000, killSignal: 'SIGKILL', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (!fetched.ok) throw refuse(`git fetch origin ${base} failed: ${how(fetched)}: ${errText(fetched)}`);
        const tip = await resolveCommit(gateCtx, repo.root, ref);
        if (tip !== ci.receipt.base_sha) {
          throw refuse(`local CI receipt base moved: origin/${base} is ${short(tip)}, checked base was ${short(ci.receipt.base_sha)}; run tower-crane check ci ${member.id} before merging`);
        }
      }
    }
    // Status alone is not enough: evidence recorded after the accept, or a
    // hand edit, can leave the gates failing for what would be merged.
    if (!report.ok && !result) {
      const remedy = ci && report.gates.some((g) => g.type === 'ci' && !g.ok)
        ? `run tower-crane check ci ${task.id} before merging`
        : `send it back with tower-crane rework ${task.id} --reason R`;
      throw refuse(`${task.id} is accepted, but its gates no longer pass: ${report.missing.join('; ')}; ${remedy}`);
    }
  }
  const worktree = repo ? W.findWorktree(repo, W.branchFor(task)) : null;
  const source = name === 'merge' ? 'merge' : `check ${name}`;
  result ??= await gate.run({
    ...gateCtx,
    worktree,
    task: JSON.parse(JSON.stringify(task)),
    project: JSON.parse(JSON.stringify(name !== 'merge' && task.stack ? { ...st.project, base: Stack.targetBase(st, task) } : st.project)),
    isStacked,
    stackTasks,
    stackedAbove,
    stackReports: Object.fromEntries(stackTasks.map((t) => [t.id, T.gateReport(t, st.events, st)])),
    mergedIds: stackTasks.filter((t) => Stack.merged(st, t)).map((t) => t.id),
    validateStack: () => {
      const current = S.withLock(ctx.stateDir, () => S.loadState(ctx.stateDir));
      if (!Stack.unchanged(snapshot, current)) {
        return `${task.id}: project settings, stack members or their events changed during stack head checks; rerun merge`;
      }
      for (const old of stackTasks) {
        const t = T.getTask(current, old.id);
        if (t.sha !== old.sha || t.revision !== old.revision || t.status !== 'accepted'
          || (!Stack.merged(current, t) && !T.gateReport(t, current.events, current).ok)) {
          return `${t.id}: accepted task changed during stack head checks`;
        }
      }
      return null;
    },
    args: { ...ctx.flags },
    log: (msg) => process.stderr.write(`[${name}] ${msg}\n`),
  });
  if (!result || typeof result.ok !== 'boolean' || typeof result.summary !== 'string') {
    throw refuse(`gate ${name} returned an invalid result; expected { ok, summary }`);
  }
  const sha = result.sha || task.sha;
  if (!sha) throw refuse(`${task.id} has no submitted sha and the ${name} gate did not report one; submit the task first`);
  const entry = S.mutate(ctx, source, (st2, emit) => {
    // What merged is recorded regardless; stack metadata follows only the state the merge read.
    const current = !snapshot || Stack.unchanged(snapshot, st2);
    const summary = !current && (result.stackUnavailable || result.retargeted)
      ? `${result.summary}; stack metadata not applied because the stack changed during merge` : result.summary;
    if (result.stackUnavailable && current) {
      for (const old of stackTasks) {
        const member = T.getTask(st2, old.id);
        member.stack_disabled = true;
        if (member.stack) member.stack.linked = false;
        emit(member.id, { reason: 'stacks unavailable; use ordinary merges in dependency order' }, 'stack unavailable');
      }
    }
    const t = T.getTask(st2, task.id);
    if (result.retargeted && current && t.stack) t.stack.base = result.retargeted;
    const receipt = result.receipt ? { receipt: result.receipt } : {};
    const capped = result.capped_review?.length ? { capped_review: result.capped_review } : {};
    const confirmed = result.confirmed_failure === true ? { confirmed_failure: true } : {};
    const testFailure = result.test_failure ? { test_failure: result.test_failure } : {};
    const infrastructure = result.infrastructure_failure ? { infrastructure_failure: true, timeout: result.timeout } : {};
    const e = { type: name, ok: result.ok, sha: String(sha).toLowerCase(), agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary, ref: result.ref || null, revision: task.revision, source, commands, ...receipt, ...capped, ...testFailure, ...testsMode, ...ciPolicy, ...gatePolicy, ...worktreeRoot, ...confirmed, ...infrastructure };
    t.evidence.push(e);
    emit(t.id, { type: name, ok: e.ok, sha: e.sha, ref: e.ref, revision: e.revision, source, commands, ...receipt, ...capped, ...testFailure, ...testsMode, ...ciPolicy, ...gatePolicy, ...worktreeRoot, ...confirmed, ...infrastructure });
    for (const merged of result.mergedTasks || []) {
      if (merged.id === task.id && result.ok) continue;
      const lower = T.getTask(st2, merged.id);
      const confirmed = { type: 'merge', ok: true, sha: merged.sha, revision: merged.revision,
        agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary: merged.summary, ref: merged.ref || null, source, commands };
      lower.evidence.push(confirmed);
      emit(lower.id, { type: 'merge', ok: true, sha: confirmed.sha, revision: confirmed.revision, ref: confirmed.ref, source, commands });
    }
    // GitHub rebased the dependents above a merged lower PR. Their gates must run again at the new head.
    for (const moved of current ? (result.movedHeads || []) : []) {
      const dependent = T.getTask(st2, moved.id);
      if (!['accepted', 'submitted'].includes(dependent.status)) continue;
      const previous = dependent.sha;
      dependent.sha = moved.sha;
      dependent.status = 'submitted';
      emit(dependent.id, { from: previous, sha: moved.sha, reason: `GitHub moved PR #${dependent.pr} after ${task.id} merged; gates run again at the new head` }, 'stack head');
    }
    return { task: t.id, ...e };
  });
  if (entry.confirmed_failure) await require('./escalation').recover({ ...ctx, pos: [task.id], flags: {} });
  // A confirmation changed no PR, so it must not push or retarget upper PRs.
  if (name === 'merge' && !result.confirmOnly && (result.ok || result.mergedTasks?.length) && st.tasks.tasks.some((t) => t.stack?.linked)) {
    await require('./automation').refreshStacks(ctx);
  }
  if (name === 'merge') W.retireTask(ctx, [...(result.ok ? [{ id: task.id, sha: entry.sha, revision: entry.revision }] : []), ...(result.mergedTasks || []).map((m) => ({ id: m.id, sha: m.sha, revision: m.revision }))]);
  return {
    data: entry,
    text: `${entry.task}: ${name} ${entry.ok ? 'ok' : 'FAIL'} at ${entry.sha.slice(0, 7)}: ${entry.summary}`,
    code: entry.ok ? 0 : 1,
  };
}

module.exports = { runGate, gatePath, GATES, missingPins };
