'use strict';

// The state writes of a spawn supervisor (lib/spawn-monitor.js). A write reads
// the whole history and the plan, and a process that once held them stays that
// large, so the supervisor, which lives as long as its agent, makes each write
// in a short-lived child of its own (run below) and keeps only its task's view
// (S.taskView). The child runs with the supervisor's environment and identity,
// as the write did inside it; each write still checks the supervision under the
// state lock, with the whole history.

const cp = require('node:child_process');
const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const Authority = require('./authority');
const Health = require('./harness-health');
const { shaMatch } = require('./util');

// Whether the spawn `sup` names is still the one this supervisor runs, by the
// log's order: its latest spawn record, its lease and no release, rework or
// interrupt since. The lease the supervisor took is `since`, its first claim;
// the result carries it on, set when this read finds it.
function valid(st, sup, since) {
  const task = T.getTask(st, sup.task);
  T.requireSupportedTask(task, st);
  const result = (ok) => ({ ok, since });
  const latest = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn');
  if (!latest) return result(false);
  if (latest.detail.agent !== sup.agent || latest.detail.monitor_pid !== sup.monitor_pid) return result(false);
  if (['accepted', 'cancelled'].includes(task.status) || sup.role === 'worker' && !sup.body_fix && task.status === 'submitted') return result(false);
  if (sup.task_status === 'submitted' && (task.status !== 'submitted' || !shaMatch(task.sha, sup.task_sha) || task.revision !== sup.task_revision)) return result(false);
  if (task.claim && sup.role === 'worker') {
    if (task.claim.agent !== sup.agent) {
      if (since || !T.leaseExpired(task, Date.now())) return result(false);
    } else {
      if (since && since !== task.claim.since) return result(false);
      since ||= task.claim.since;
    }
  } else if (since) return result(false);
  const at = st.events.lastIndexOf(latest);
  return result(!st.events.slice(at + 1).some((e) => e.task === task.id && ['release', 'rework', 'interrupt'].includes(e.cmd)));
}

// A budget crossing stops the agent (budget.stop, operational) and asks the
// owner, who alone raises a budget (budget.raise). Returns the stop reason, or
// null when no budget is crossed.
function budget(st, emit, b) {
  const over = T.budgetBreaches(st, T.getTask(st, b.task));
  if (!over.length) return null;
  const reason = `budget: ${over.map(T.breachText).join('; ')}`;
  st.rerender = true;
  emit(b.task, { agent: b.agent, pid: b.pid, breaches: over, action: 'stop', authority: Authority.classOf('budget.stop') }, 'budget stop');
  for (const breach of over) {
    const task = breach.scope === 'project' ? null : breach.scope;
    Authority.escalateQuestion(b.agent, st, emit, { settings: ['budget.raise'], change: { scope: breach.scope, what: breach.what, limit: breach.limit } },
      `${b.agent} on ${b.task} was stopped: ${T.breachText(breach)}. Raise the ${task ? `${task} task` : 'project'} ${breach.what} budget to continue, or leave it stopped.`,
      'owner-required (docs/state.md#authority): the supervisor stopped the agent; only the owner raises a budget', task ? [task] : [], { kind: 'spend' });
  }
  emit(b.task, { ...b.detail, phase: 'blocked', retry: b.attempt, reason }, 'spawn phase');
  return reason;
}

// Each write takes the supervisor's context and plain arguments and returns
// plain results. `sup` names the supervision, `since` its lease.
const OPS = {
  // Events emitted while the supervision holds, or always without `sup`,
  // then the budget check when `budget` names the attempt.
  emit(ctx, { cmd, sup, since, events = [], rerender = false, budget: b }) {
    return S.mutate(ctx, cmd, (st, emit) => {
      const check = sup ? valid(st, sup, since) : { ok: true, since };
      if (!check.ok) return { ok: false, since: check.since };
      if (rerender) st.rerender = true;
      for (const [task, detail, name] of events) emit(task, detail, name || undefined);
      return { ok: true, since: check.since, budget_stop: b ? budget(st, emit, b) : null };
    });
  },
  'spend live'(ctx, { task, entry, final, authoritative, budget: b }) {
    return S.mutate(ctx, 'spend live', (st, emit) => {
      st.rerender = true;
      T.recordLive(st, emit, task, entry, { final, authoritative });
      return { budget_stop: b ? budget(st, emit, b) : null };
    });
  },
  'harness health'(ctx, detail) {
    S.mutate(ctx, 'harness health', (st, emit) => Health.failed(st, emit, detail));
    return {};
  },
  // The attempt's own end: waiting for review or blocked. A login probe the
  // pause admitted and that exited clean clears the pause.
  'exit phase'(ctx, { sup, since, stopped, harness, probe, event }) {
    return S.mutate(ctx, 'spawn exit', (st, emit) => {
      const check = valid(st, sup, since);
      if (!check.ok) return { ok: false, since: check.since };
      st.rerender = true;
      if (!stopped && probe && Health.probed(st, harness, probe)) Health.cleared(emit, harness, 'spawn');
      emit(sup.task, event, 'spawn phase');
      return { ok: true, since: check.since };
    });
  },
  // The supervisor's last records: its phase when it stopped or failed, and
  // the attempt's exit receipt once.
  exit(ctx, { sup, since, detail, attempt, stoppedBy, failed, budgetStop, exit, pid }) {
    S.mutate(ctx, 'spawn exit', (st, emit) => {
      const run = P.runPhase(st, T.getTask(st, sup.task));
      const budgetActive = budgetStop && run?.agent === sup.agent && run.active;
      if (stoppedBy === 'interrupt' || interrupted(st, sup)) {
        st.rerender = true;
        emit(sup.task, { ...detail, phase: 'stopped', active: false, retry: attempt, reason: 'dispatch interrupted' }, 'spawn phase');
      } else if (budgetActive || (stoppedBy || failed) && valid(st, sup, since).ok) {
        st.rerender = true;
        emit(sup.task, { ...detail, phase: 'blocked', retry: attempt,
          reason: budgetStop || (stoppedBy ? `supervisor stopped by ${stoppedBy}` : 'supervisor failed') }, 'spawn phase');
      }
      if (!st.events.some((e) => e.task === sup.task && e.cmd === 'spawn exit' && e.detail.agent === sup.agent && e.detail.pid === pid)) {
        emit(sup.task, exit);
        if (sup.role === 'worker' && !sup.body_fix) {
          require('./escalation').capRespawns(st, emit, sup.task, { cmd: 'spawn exit', task: sup.task, detail: exit }, sup.agent);
        }
      }
    });
    return {};
  },
  session(ctx, { task, detail, id, waitMs }) {
    require('./spawn-session').record({ ...ctx, task }, detail, id, waitMs);
    return {};
  },
  claim(ctx, { task }) {
    T.claim({ ...ctx, pos: [task] });
    return {};
  },
  renew(ctx, { task, since, lease }) {
    T.renew({ ...ctx, pos: [task], claimSince: since, flags: { lease } });
    return {};
  },
  // The messages a fresh attempt's prompt delivers.
  unread(ctx, { agent }) {
    return { events: require('./harness-hooks').unread(S.readEvents(ctx.stateDir), agent) };
  },
  // After the attempt: the worktree once its task is done, a quality climb,
  // then the gates and merges its records start, handed to a live wait host
  // or run here, in the dispatcher's environment.
  // Returns the repository root and the checkouts removed, which the
  // supervisor leaves if it stands in one, as this child does.
  retire(ctx, { task: id }) {
    const task = T.getTask(S.loadState(ctx.stateDir), id);
    // The supervisor that started this child is the one leaving the worktree.
    const outcomes = require('./worktree').retireTask({ ...ctx, cleanupFor: process.ppid }, [{ id: task.id, sha: task.sha, revision: task.revision }]);
    return { root: S.findRepo(ctx.stateDir, ctx.cwd)?.root || null, removed: outcomes.filter((o) => o.removed).map((o) => o.path) };
  },
  async recover(ctx, { task }) {
    await require('./escalation').recover({ ...ctx, pos: [task] });
    return {};
  },
  async reactions(ctx, { task, agent, cwd }) {
    const events = S.readEvents(ctx.stateDir).filter((e) => e.task === task
      && (e.cmd === 'submit' && e.agent === agent
        || e.cmd === 'evidence' && e.agent === agent && e.detail.type === 'review'
        || e.cmd === 'spawn exit' && e.detail.agent === agent));
    const Automation = require('./automation');
    if (Automation.handOff(ctx, events)) return { handed_off: true };
    await Automation.consume({ ...ctx, cwd }, events, true);
    return { handed_off: false };
  },
};

function interrupted(st, sup) {
  return st.events.some((e) => e.cmd === 'interrupt' && e.task === sup.task
    && e.detail.active && e.detail.agent === sup.agent && e.detail.attempt === sup.attempt && e.detail.monitor_pid === sup.monitor_pid);
}

// Runs one write in a child and returns its result, or throws its error with
// the code and flags the supervisor tests (3 for a busy lock, stateIncompatible).
// The child takes the supervisor's Node flags, as the supervisor took its
// dispatcher's, and its stderr is the supervisor's. A write blocks the supervisor as a
// write in its own process did; runAsync leaves its event loop running, for
// the gates and merges after the agent exits.
function request(ctx, op, args) {
  return JSON.stringify({ op, state: ctx.stateDir, agent: ctx.agent, args });
}

function outcome(op, stdout, status) {
  let out;
  try { out = JSON.parse(stdout.trim().split('\n').at(-1)); } catch {
    throw new Error(`supervisor write ${op} exited ${status} without a result`);
  }
  if (out.error) throw Object.assign(new Error(out.error.message), out.error.code === undefined ? {} : { code: out.error.code },
    out.error.stateIncompatible ? { stateIncompatible: true } : {});
  return out.result;
}

function run(ctx, op, args = {}, { env = ctx.env } = {}) {
  const r = cp.spawnSync(process.execPath, [...process.execArgv, __filename], { input: request(ctx, op, args), env, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return outcome(op, r.stdout, r.status ?? r.signal);
}

function runAsync(ctx, op, args = {}, { env = ctx.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [...process.execArgv, __filename], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      try { resolve(outcome(op, stdout, code ?? signal)); } catch (e) { reject(e); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(request(ctx, op, args));
  });
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    let job;
    Promise.resolve().then(() => {
      job = JSON.parse(input);
      const ctx = { stateDir: job.state, agent: job.agent, env: process.env, flags: {}, pos: [] };
      // The child's own reads parse the log once and only what it appends after.
      const release = S.retainEvents(job.state);
      return Promise.resolve(OPS[job.op](ctx, job.args)).finally(release);
    }).then((result) => {
      process.stdout.write(JSON.stringify({ result: result ?? {} }) + '\n');
    }, (e) => {
      process.stdout.write(JSON.stringify({ error: { message: e.message, code: e.code, stateIncompatible: !!e.stateIncompatible } }) + '\n');
    });
  });
}

module.exports = { valid, budget, interrupted, run, runAsync, OPS };
