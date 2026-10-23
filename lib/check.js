'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('./commands');
const { isDeepStrictEqual } = require('node:util');
const { refuse, nowIso } = require('./util');
const { sameSha } = require('./gates/common');
const S = require('./state');
const T = require('./tasks');
const W = require('./worktree');
const Runtime = require('./runtime');

const GATES = ['tests', 'clean', 'sources', 'ci', 'merge', 'final-review'];

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
  // The lease and host governor place runOnce takes, kept here so every way out of the run releases them.
  const held = { lease: null, unit: null };
  let error = null;
  try {
    return await runOnce(ctx, name, held);
  } catch (e) {
    // A gate that failed because the host governor stopped it reports the stop.
    error = (!e.governorDeferred && !ctx.gateSignal?.aborted && held.unit?.stopped()) || e;
    throw error;
  } finally {
    held.unit?.release();
    if (held.lease) require('./gate-runs').abandon(ctx, held.lease, error);
  }
}

// Gates that run the project's own commands and can take the host's memory.
function heavy(st, task, name) {
  return ['tests', 'clean'].includes(name) || (name === 'ci' && !task.hotfix && st.project.ci?.local != null);
}

function line(entry, name, note = '') {
  return `${entry.task}: ${name} ${entry.ok ? 'ok' : entry.stalled ? 'STALLED' : entry.pending ? 'PENDING' : 'FAIL'} at ${entry.sha.slice(0, 7)}${note}: ${entry.summary}`;
}

function recordedMerge(st, task) {
  if (task.status !== 'accepted') return null;
  const entry = T.latestGateEvidence(task, 'merge', st.log || st.events);
  if (!entry?.ok || entry.waived) return null;
  const summary = `already merged at ${entry.ref || entry.sha}`;
  return { data: { task: task.id, ...entry, summary }, text: `${task.id}: ${summary}`, code: 0 };
}

function parentHeadInputs(st, task) {
  const Stack = require('./stack');
  if (!task.stack || Stack.completed(st, task)) return null;
  const dep = T.getTask(st, task.stack.parent);
  return { id: dep.id, sha: dep.sha };
}

function validateParentHead(st, task, expected, name) {
  const current = parentHeadInputs(st, task);
  if (!isDeepStrictEqual(current, expected)) {
    throw refuse(`${task.id}: ${name} parent head changed to ${current?.id || '(none)'} at ${current?.sha || '(none)'}; retry`);
  }
}

function requireParentHead(ctx, st, task, name) {
  const dep = parentHeadInputs(st, task);
  if (!dep) return null;
  const root = W.needRepo(ctx).root;
  if (!dep.sha || !task.sha
    || S.git(['merge-base', '--is-ancestor', dep.sha, task.sha], root) === null) {
    throw refuse(`${task.id}: ${name} waits for a submitted head containing ${dep.id} at ${dep.sha || '(none)'}; refresh the child and resubmit`);
  }
  return dep;
}

async function runOnce(ctx, name, held) {
  ctx.automationSignal?.throwIfAborted();
  const modPath = gatePath(name);
  // Merge reads under the lock so its stack snapshot is one consistent state.
  const load = () => (name === 'merge' ? S.withLock(ctx.stateDir, () => S.loadState(ctx.stateDir)) : S.loadState(ctx.stateDir));
  const Stack = require('./stack');
  await Stack.refreshParent(ctx, ctx.pos[0]);
  let st = load();
  const task = T.getTask(st, ctx.pos[0]);
  if (name === 'merge') {
    const recorded = recordedMerge(st, task);
    if (recorded) return recorded;
  }
  requireParentHead(ctx, st, task, name);
  if (require('./gate-commands').heal(ctx, missingPins(st, task, [name])).length) st = load();
  // A caller that checked an earlier state refuses to run the gate on another.
  const stale = ctx.expect?.(st);
  if (stale) return { stale, data: null, text: `${task.id}: ${name} not run: ${stale}`, code: 1 };
  const testsMode = name === 'tests'
    ? { tests_mode: require('./tests-policy').resolve(st.project, task.kind).mode ?? null } : {};
  const ciPolicy = name === 'ci' && (task.hotfix || st.project.ci?.local == null)
    ? { ci_policy: require('./ci-hosted').resolve(st.project).policy ?? null } : {};
  const gatePolicy = ['tests', 'clean'].includes(name)
    ? { gate_policy: require('./gate-commands').resolve(st.project, name).policy ?? null } : {};
  // The directory the gate built its worktree under, so evidence shows where its checkout lived.
  const worktreeRoot = ['tests', 'clean'].includes(name) || (name === 'ci' && st.project.ci?.local != null)
    ? { tmp_root: require('./gate-tmp').root(st.project, ctx.env) } : {};
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  const stackTasks = name === 'merge' ? Stack.chain(st, task) : [];
  const snapshot = name === 'merge' ? Stack.capture(st, [task.id]) : null;
  const stackComplete = Stack.completed(st, task);
  const isStacked = !!Stack.effectiveStack(st, task) || st.tasks.tasks.some((t) => t.stack?.linked && !Stack.merged(st, t)
    && !Stack.completed(st, t) && Stack.chain(st, t).some((x) => x.id === task.id));
  // A stale local link can leave a dependent unlinked while GitHub still stacks it on this PR.
  const stackedAbove = name === 'merge'
    ? st.tasks.tasks.filter((t) => t.stack && t.pr && t.id !== task.id && t.status !== 'cancelled' && !Stack.merged(st, t)
      && Stack.chain(st, t).some((x) => x.id === task.id)).map((t) => ({ id: t.id, pr: t.pr, sha: t.sha }))
    : [];
  // The wait's signal, joined by the host governor's once it admits the gate.
  let signal = ctx.gateSignal;
  const commands = [];
  const gateCtx = {
    root: repo ? repo.root : null,
    // Local CI keeps its full log and artifacts under the state directory's logs.
    stateDir: ctx.stateDir,
    signal,
    // The environment that picks the gate temporary root: a supervisor's reaction drops an inherited TOWER_CRANE_TMP.
    tmpEnv: ctx.env,
    mergeCommands: name === 'merge' ? st.events.filter((e) => e.cmd === 'merge' && e.detail?.type === 'merge').flatMap((e) => e.detail.commands || []) : [],
    // Capture execution here so a summary cannot stand in for a command receipt.
    exec: async (command, args, opts = {}) => {
      const tree = ctx.gateSignal || opts.shell || opts.processTree;
      const run = tree ? require('./gates/common').treeExec : spawnSync;
      // Without a wait's signal only process-tree commands take one; spawnSync has none to honor.
      const r = await run(command, args, { windowsHide: true, ...opts, signal: !tree || (opts.cleanup && signal?.aborted) ? undefined : signal,
        ...(tree && held.unit ? { onSpawn: (pid, scope) => held.unit.attach(pid, scope) } : {}) });
      Runtime.throwIfMissing(r.error);
      Runtime.throwIfMissing(r.stderr);
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
      result = await gate.confirm({ ...gateCtx, task, project: st.project, isStacked, stackComplete, args: { ...ctx.flags } });
    }
    for (const member of result ? [] : stackTasks) {
      const ci = T.latestGateEvidence(member, 'ci', st.events);
      const merged = Stack.merged(st, member);
      if (!ci?.receipt || merged || !repo) continue;
      const { git, resolveCommit, how, errText, short } = require('./gates/common');
      const origin = await git(gateCtx, repo.root, ['remote', 'get-url', 'origin'], { timeout: 60000 });
      const base = Stack.targetBase(st, member).replace(/^origin\//, '');
      if (origin.ok) {
        const ref = `refs/remotes/origin/${base}`;
        const fetched = await git(gateCtx, repo.root,
          ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${base}:${ref}`],
          { timeout: 60000, killSignal: 'SIGKILL', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        if (!fetched.ok) throw refuse(`git fetch origin ${base} failed: ${how(fetched)}: ${errText(fetched)}`);
      }
      // Reports accept a receipt on its pinned base; what merges must have been checked on the base it lands on.
      const tip = origin.ok ? await resolveCommit(gateCtx, repo.root, `refs/remotes/origin/${base}`)
        : await require('./ci-local').selectedBase(gateCtx, repo.root, Stack.targetBase(st, member));
      if (tip !== ci.receipt.base_sha) {
        throw refuse(`local CI receipt base moved: ${origin.ok ? 'origin/' : ''}${base} is ${short(tip)}, checked base was ${short(ci.receipt.base_sha)}; run tower-crane check ci ${member.id} before merging`);
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
  // A run of this gate already going at the same head and revision is joined, not repeated.
  const Runs = require('./gate-runs');
  if (name !== 'merge' && Runs.leased(st, task, name)) {
    const got = await Runs.acquire(ctx, task, name, Runs.budgetMs(ctx, st.project, repo?.root, task, name));
    if (got.joined) {
      const { holder, entry } = got.joined;
      const joined = { source: holder.detail.source, agent: holder.agent, via: holder.via || null, pid: holder.detail.pid,
        host: holder.detail.host || null, at: holder.at };
      return { data: { ...entry, joined }, text: line(entry, name, ` (joined the run by ${holder.agent}, pid ${holder.detail.pid}, started ${holder.at})`), code: entry.ok ? 0 : 1 };
    }
    held.lease = got.lease;
  }
  // A gate that runs its own commands takes a place in the host budget, or
  // waits with its reason; past the stop line the governor aborts it through
  // this signal, which records no verdict. A joiner above takes none.
  if (heavy(st, task, name)) {
    held.unit = require('./governor').admit(ctx, { kind: name, task: task.id, project: st.project });
    signal = gateCtx.signal = AbortSignal.any([ctx.gateSignal, held.unit.signal].filter(Boolean));
  }
  const worktree = repo ? W.findWorktree(repo, W.branchFor(task)) : null;
  const source = name === 'merge' ? 'merge' : `check ${name}`;
  // Joining a run or waiting for host capacity can outlast a parent submission.
  if (task.stack) requireParentHead(ctx, S.loadState(ctx.stateDir), task, name);
  result ??= await gate.run({
    ...gateCtx,
    worktree,
    task: JSON.parse(JSON.stringify(task)),
    project: JSON.parse(JSON.stringify(name !== 'merge' && task.stack ? { ...st.project, base: Stack.targetBase(st, task) } : st.project)),
    isStacked,
    stackComplete,
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
  Runtime.throwIfMissing(result.summary);
  Runtime.throwIfMissing(result.containment?.error);
  // A gate the host governor stopped records no verdict; the reaction that ran it runs it again once there is room.
  const stopped = !ctx.gateSignal?.aborted && held.unit?.stopped();
  if (stopped) throw stopped;
  if (ctx.gateSignal?.aborted && name !== 'merge') {
    result = { ...result, ok: false, confirmed_failure: false, voided: true, summary: `${name} gate interrupted by wait shutdown; retry with gates retry`,
      ...(name === 'final-review' ? { final_review: { ...result.final_review, outcome: 'not_run', interrupted: true } } : {}) };
  }
  const sha = result.sha || task.sha;
  if (!sha) throw refuse(`${task.id} has no submitted sha and the ${name} gate did not report one; submit the task first`);
  let unchanged = false;
  let recorded = null;
  const entry = S.mutate(ctx, source, (st2, emit) => {
    // Another merge can finish while this gate is confirming GitHub's result.
    if (name === 'merge' && result.ok) {
      recorded = recordedMerge(st2, { ...T.getTask(st2, task.id), sha, revision: task.revision });
      if (recorded) return recorded.data;
    }
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
    // Rechecking CI that is still pending the same way adds nothing: the
    // recorded entry stays the receipt, and tasks.json and the log are untouched.
    const prior = name === 'ci' && result.pending ? T.latestGateEvidence(t, 'ci', st2.events) : null;
    if (prior?.pending && sameSha(prior.sha, sha) && prior.revision === task.revision && prior.summary === summary
      && !!prior.not_running === !!result.not_running && !!prior.stalled === !!result.stalled
      && (prior.ref || null) === (result.ref || null) && isDeepStrictEqual(prior.ci_policy, ciPolicy.ci_policy)) {
      unchanged = true;
      if (held.lease) Runs.release(emit, held.lease, prior.at);
      return { task: t.id, ...prior };
    }
    if (result.retargeted && current && t.stack) t.stack.base = result.retargeted;
    const receipt = result.receipt ? { receipt: result.receipt } : {};
    const capped = result.capped_review?.length ? { capped_review: result.capped_review } : {};
    const confirmed = result.confirmed_failure === true ? { confirmed_failure: true } : {};
    const testFailure = result.test_failure ? { test_failure: result.test_failure } : {};
    const localCi = result.local_ci ? { local_ci: result.local_ci } : {};
    const infrastructure = result.infrastructure_failure ? { infrastructure_failure: true, timeout: result.timeout } : {};
    const crash = result.runner_crash ? { runner_crash: true } : {};
    const native = Array.isArray(result.native_crash) && result.native_crash.length ? { native_crash: result.native_crash } : {};
    const flaky = Array.isArray(result.flaky) && result.flaky.length ? { flaky: result.flaky } : {};
    const resourceReason = result.resource_reason || result.receipt?.resource_reason;
    const resource = resourceReason ? { resource_reason: resourceReason,
      containment: result.containment || result.receipt?.containment } : {};
    const worker = result.worker_failure ? { worker_failure: true } : {};
    const voided = result.voided ? { voided: true } : {};
    const config = result.config_failure ? { config_failure: result.config_failure } : {};
    // The later commit and run that stood for a hotfix merge commit's cancelled push run.
    const hotfixCI = name === 'ci' && result.hotfix_ci ? { hotfix_ci: result.hotfix_ci } : {};
    // How the final review ended: pass, concerns, refused, not_run or skipped.
    const finalReview = name === 'final-review' && result.final_review ? { final_review: result.final_review } : {};
    const pending = result.pending ? { pending: true, ...(result.not_running ? { not_running: true } : {}), ...(result.stalled ? { stalled: true } : {}) } : {};
    const mainFailure = {
      ...(result.main_failure ? { main_failure: result.main_failure } : {}),
      ...(result.base_rerun_killed ? { base_rerun_killed: result.base_rerun_killed } : {}),
      ...(result.base_rerun_timed_out ? { base_rerun_timed_out: result.base_rerun_timed_out } : {}),
    };
    const e = { type: name, ok: result.ok, sha: String(sha).toLowerCase(), agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary, ref: result.ref || null, revision: task.revision, source, commands, ...receipt, ...capped, ...testFailure, ...localCi, ...testsMode, ...ciPolicy, ...gatePolicy, ...worktreeRoot, ...confirmed, ...infrastructure, ...crash, ...native, ...flaky, ...resource, ...worker, ...voided, ...config, ...pending, ...mainFailure, ...hotfixCI, ...finalReview };
    t.evidence.push(e);
    // Before the gate's own event, so that event stays the last one this write records.
    if (held.lease) Runs.release(emit, held.lease, e.at, !!ctx.gateSignal?.aborted);
    emit(t.id, { type: name, ok: e.ok, sha: e.sha, ref: e.ref, revision: e.revision, source, commands, ...receipt, ...capped, ...testFailure, ...localCi, ...testsMode, ...ciPolicy, ...gatePolicy, ...worktreeRoot, ...confirmed, ...infrastructure, ...crash, ...native, ...flaky, ...resource, ...worker, ...voided, ...config, ...pending, ...mainFailure, ...hotfixCI, ...finalReview });
    require('./flakes').open(st2, emit, t, e);
    for (const merged of result.mergedTasks || []) {
      if (merged.id === task.id && result.ok) continue;
      const lower = T.getTask(st2, merged.id);
      if (recordedMerge(st2, { ...lower, sha: merged.sha, revision: merged.revision })) continue;
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
  if (recorded) return recorded;
  held.lease = null;
  if (ctx.waitShutdown && ctx.automationSignal?.aborted && !ctx.gateSignal?.aborted) ctx.waitShutdown.drained += 1;
  // A hotfix follow-up is a state record no later reaction repeats, so a drained gate still opens it.
  if (task.hotfix && !entry.ok) {
    if (!ctx.gateSignal?.aborted) require('./hotfix').settle({ ...ctx, pos: [task.id] });
  } else if (entry.confirmed_failure && !ctx.automationSignal?.aborted) await require('./escalation').recover({ ...ctx, pos: [task.id], flags: {} });
  // A confirmation changed no PR, so it must not push or retarget upper PRs.
  if (name === 'merge' && !result.confirmOnly && (result.ok || result.mergedTasks?.length) && st.tasks.tasks.some((t) => t.stack)) {
    await require('./automation').refreshStacks(ctx);
  }
  if (name === 'merge') W.retireTask(ctx, [...(result.ok ? [{ id: task.id, sha: entry.sha, revision: entry.revision }] : []), ...(result.mergedTasks || []).map((m) => ({ id: m.id, sha: m.sha, revision: m.revision }))]);
  return {
    data: entry,
    text: line(entry, name, unchanged ? ` (unchanged since ${entry.at})` : ''),
    code: entry.ok ? 0 : 1,
  };
}

module.exports = { runGate, gatePath, GATES, missingPins, recordedMerge, parentHeadInputs, requireParentHead, validateParentHead };
