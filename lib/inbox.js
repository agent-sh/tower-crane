'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const C = require('./gates/common');
const Reviews = require('./review-findings');
const { refuse, usage } = require('./util');

const ACKNOWLEDGEABLE = new Set(['message', 'stall', 'decision_answer', 'owner_comment', 'review_exit_missing']);
const SOFTWARE_GATES = T.GATE_TYPES.filter((type) => type !== 'review');

function authorized(ctx, st) {
  if (!require('./authority').role(ctx, st.events)) throw refuse('inbox and batch actions require the orchestrator or owner identity');
}

function liveWorker(st, task) {
  if (P.supervised(st, task, st.events)) return true;
  const spawn = T.taskEvents(st.events, task.id).findLast((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  return !!spawn && !require('./spawn-session').exitedAttempt(spawn, st.events);
}

// Automatic refill passes hold: a gate rework that can still be restored
// waits out gates.rework_hold_min first, and a task whose own gate reaction
// still runs waits for it, since refill no longer waits behind reactions.
// A spawn --ready by hand does neither.
function dispatchable(st, hold = false) {
  const now = Date.now();
  const reacting = hold ? require('./automation').busy(st) : new Set();
  return T.readyTasks(st, now).map((x) => x.task)
    .filter((t) => ['todo', 'rework'].includes(t.status) && !liveWorker(st, t)
      && !(hold && (reacting.has(t.id) || require('./rework-hold').holdEnd(st, t, now))));
}

function item(kind, task, detail, argv, suffix = '') {
  return { id: `${kind}:${task || 'project'}${suffix ? `:${suffix}` : ''}`, kind, task, ...detail,
    action: { command: ['tower-crane', ...argv].map(C.shellQuote).join(' '), argv } };
}

function confirmedFailure(st, task, failure) {
  if (failure.confirmed_failure !== true || failure.infrastructure_failure) return false;
  const audit = st.events.findLast((e) => e.task === task.id && e.cmd === failure.source
    && e.agent === failure.agent && e.detail.type === failure.type
    && e.detail.sha === failure.sha && e.detail.revision === failure.revision);
  return audit?.detail.ok === false && audit.detail.confirmed_failure === true && !audit.detail.infrastructure_failure
    && isDeepStrictEqual(audit.detail.commands, failure.commands);
}

function failureCommand(task, failure, confirmed) {
  return confirmed || failure.worker_failure
    ? ['rework', task.id, '--reason', `${failure.type} failed at ${task.sha}: ${failure.summary}`]
    : ['check', failure.type, task.id];
}

function gateCommand(st, task, gate) {
  if (SOFTWARE_GATES.includes(gate.type)) {
    const failure = T.latestGateEvidence(task, gate.type, st.events);
    return failure?.ok === false
      ? failureCommand(task, failure, confirmedFailure(st, task, failure))
      : ['check', gate.type, task.id];
  }
  const review = T.latestGateEvidence(task, 'review', st.events);
  if (review?.ok === false) return Reviews.bodyOnly(review.findings) ? ['accept', task.id] : ['rework', '--from-review', task.id];
  return ['rework', task.id, '--reason', gate.reason];
}

function local(st, agent) {
  const items = [];
  const acknowledged = new Set(st.events.filter((e) => e.cmd === 'inbox ack')
    .flatMap((e) => e.detail.items || [e.detail.item]));
  const closed = new Set(st.tasks.tasks.filter((task) => task.status === 'cancelled'
    || (task.status === 'accepted' && require('./stack').merged(st, task))).map((task) => task.id));
  const expired = (at, tasks) => Date.parse(at) < Date.now() - 24 * 60 * 60 * 1000
    && tasks.length > 0 && tasks.every((id) => closed.has(id));
  for (const task of st.tasks.tasks) {
    // Closed tasks never show the hold, and their offloaded evidence is costly to load.
    const open = !['accepted', 'cancelled'].includes(task.status);
    const redesign = open ? Reviews.redesign(task, st.events) : null;
    if (open) {
      if (redesign) items.push(item('review_redesign', task.id, redesign,
        ['task', 'note', task.id, '<design change>', '--kind', 'scope-ruling']));
      const Churn = require('./review-churn');
      if (Churn.count(task, st.events) >= require('./reviewer').churnAfter(st.project)) items.push(item('review_churn', task.id,
        { ...Churn.history(task, st.events, st.project), spend: task.spend,
          reason: redesign?.reason || 'Repeated failed reviews: bound scope, split the task, or change tier. Rework can proceed.' },
        ['task', 'show', task.id]));
    }
    if (['submitted', 'accepted'].includes(task.status) && !require('./stack').merged(st, task)) {
      const review = T.latestGateEvidence(task, 'review', st.events);
      const bodyRepair = require('./review-body').state(st, task);
      if (bodyRepair?.stuck) items.push(item('review_body_stuck', task.id,
        { sha: task.sha, revision: task.revision, reason: bodyRepair.reason, findings: review.summary,
          blockers: review.findings, ref: review.ref || null, reviewer: review.agent,
          correction: `Edit the false PR-body claims before accept requests a light reviewer check. If the body cannot be corrected, run rework ${task.id} --reason R.` },
        ['accept', task.id]));
      else if (review?.ok === false && !bodyRepair?.fixing && !bodyRepair?.held) items.push(item('review_failed', task.id,
        { sha: task.sha, findings: review.summary, ref: review.ref || null, reviewer: review.agent,
          finding_count: Reviews.count(review.summary), findings_complete: false,
          ...(Reviews.bodyOnly(review.findings) ? { prose_only: true,
            correction: `Edit the false PR-body claims before accept requests a light reviewer check. If the body cannot be corrected, run rework ${task.id} --reason R.` } : {}) },
        Reviews.bodyOnly(review.findings) ? ['accept', task.id] : ['rework', '--from-review', task.id]));
      // Automation held review dispatch after a reviewer exited without a
      // verdict; the orchestrator's accept dispatches the next reviewer.
      const hold = task.status === 'submitted' && (!review || bodyRepair?.recheck) && require('./reviewer').held(st, task);
      const notice = hold && st.events.findLast((e) => e.cmd === 'review held' && e.task === task.id && e.detail.agent === hold.detail.agent);
      if (notice) items.push(item('review_held', task.id, { ...notice.detail,
        reason: notice.detail.reason || `reviewer ${notice.detail.agent} exited without review evidence and left no report` },
      ['accept', task.id]));
      for (const type of SOFTWARE_GATES) {
        const failure = T.latestGateEvidence(task, type, st.events);
        if (failure?.ok !== false) continue;
        // Stalled CI gets no more scheduled rechecks; the orchestrator restarts it.
        if (failure.stalled) {
          items.push(item('ci_stalled', task.id, { gate: type, sha: task.sha, revision: task.revision, summary: failure.summary,
            ref: failure.ref || null, since: failure.at, addressed_to: 'orchestrator' }, ['check', type, task.id], type));
          continue;
        }
        // A missing pinned command is project configuration: the orchestrator pins it, and the task stays submitted.
        if (failure.config_failure) {
          const key = failure.config_failure.key;
          // tests.host_env and tests.crucial are JSON tests settings; the other keys are pinned gate commands.
          const json = key === 'tests_host_env' || key === 'tests_crucial';
          items.push(item('gate_config', task.id, { gate: type, setting: json ? key.replace('_', '.') : `gates.${key}`, addressed_to: 'orchestrator',
            sha: task.sha, revision: task.revision, summary: failure.summary, then: `gates retry ${task.id}` },
          ['project', 'set', `--${key.replaceAll('_', '-')}`, json ? '<JSON>' : '<command>'], type));
          continue;
        }
        const confirmed = confirmedFailure(st, task, failure);
        items.push(item('gate_failed', task.id, {
          gate: type, sha: task.sha, revision: task.revision, summary: failure.summary, ref: failure.ref || null,
          confirmed_failure: confirmed,
          ...(failure.test_failure ? { test_failure: failure.test_failure } : {}),
          ...(failure.local_ci ? { local_ci: failure.local_ci } : {}),
          ...(failure.infrastructure_failure ? { infrastructure_failure: true, timeout: failure.timeout } : {}),
          ...(failure.main_failure ? { main_failure: failure.main_failure } : {}),
        }, failureCommand(task, failure, confirmed), type));
      }
    }
    // spawn refuses a task without a brief, so a ready or rework item for it
    // would name a command that fails; brief set is the resolving action.
    if ((task.status === 'rework' || T.isReady(st, task, Date.now())) && !T.hasBrief(st, task)) {
      items.push(item('brief_missing', task.id, { reason: 'task has no brief; spawn refuses it until one is written' },
        ['brief', 'set', task.id, '--file', '<brief file>']));
    } else if (task.status === 'rework' && (!liveWorker(st, task) || !task.claim && require('./ownership').state(st, task)?.held)) {
      const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id);
      // A held owner's live spawn takes the task when the hold ends, so restore is all there is to do.
      const owner = liveWorker(st, task) ? rework.detail.owner_held : null;
      // An automatic gate rework nobody has touched can be undone once its cause is fixed, without a
      // worker. snapshot drops the command when the PR or branch head moved; refill waits until hold_until.
      const holdUntil = require('./rework-hold').holdEnd(st, task);
      const restore = !require('./automation').unrestorable(st, task)
        ? { gate: rework.detail.gate, restore: `gates retry ${task.id} --from-rework`, ...(holdUntil ? { hold_until: holdUntil } : {}) } : {};
      if (!redesign) items.push(item('rework_ready', task.id, { reason: rework?.detail.reason || 'task requires rework', blockers: T.blockReasons(st, task), ...restore, ...(owner ? { owner } : {}) },
        owner ? ['gates', 'retry', task.id, '--from-rework'] : ['spawn', '--ready']));
    } else if (task.status === 'todo' && T.isReady(st, task, Date.now()) && !liveWorker(st, task)) {
      items.push(item('ready', task.id, { reason: 'ready for a worker' }, ['spawn', '--ready']));
    }
  }
  for (const dead of P.exitedClaims(st, st.events, { includeTail: false })) {
    const { id, ...detail } = dead;
    items.push(item('dead_claim', id, detail, ['release', '--dead']));
  }
  for (const decision of st.decisions.decisions) {
    if (decision.status === 'open') {
      const who = require('./decisions').orchestratorAnswers(st, decision) ? '<answer>' : '<owner answer>';
      items.push(item('decision', null, { decision }, ['answer', decision.id, '--choice', who], decision.id));
    } else if (decision.status === 'answered') {
      const id = `decision_answer:project:${decision.id}`;
      if (!acknowledged.has(id) && !expired(decision.answered_at, decision.blocks)) {
        items.push(item('decision_answer', null, { decision, at: decision.answered_at }, ['inbox', '--ack', id], decision.id));
      }
    }
  }
  const events = [...st.events, ...require('./events').sources(st, st.events, Date.now()).filter((e) => e.type === 'stall')
    .map((e) => ({ ...e, cmd: 'stall', id: e.detail.source }))];
  const legacyComments = new Map();
  for (const event of events) {
    if (event.agent === 'owner' && ['task note', 'decision note'].includes(event.cmd)) {
      // Older logs have no event ids. Count identical records so even repeated
      // comments have stable ids without changing the historical event log.
      let source = event.id;
      if (!source) {
        const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
        const occurrence = (legacyComments.get(hash) || 0) + 1;
        legacyComments.set(hash, occurrence);
        source = `legacy-${hash}-${occurrence}`;
      }
      const id = `owner_comment:${event.task || 'project'}:${source}`;
      if (!acknowledged.has(id)) items.push(item('owner_comment', event.task,
        { ...event.detail, from: event.agent, event: source, at: event.at }, ['inbox', '--ack', id], source));
    }
    // Automation replaced the reviewer; the wedged or dead monitor stays visible until acknowledged.
    if (event.cmd === 'review exit missing') {
      const id = `review_exit_missing:${event.task}:${event.id}`;
      if (!acknowledged.has(id)) items.push(item('review_exit_missing', event.task, { ...event.detail, event: event.id, at: event.at },
        ['inbox', '--ack', id], event.id));
    }
    if (event.cmd === 'msg' && ['orchestrator', agent].includes(event.detail.to)) {
      const id = `message:${event.task || 'project'}:${event.id}`;
      if (!acknowledged.has(id) && !expired(event.at, [event.task])) items.push(item('message', event.task,
        { from: event.agent, text: event.detail.text, event: event.id, at: event.at }, ['inbox', '--ack', id], event.id));
    }
    if (event.cmd === 'stall') {
      const task = st.tasks.tasks.find((t) => t.id === event.task);
      if (!task?.claim || task.claim.agent !== event.detail.agent || task.claim.until !== event.detail.until) continue;
      if (events.slice(events.indexOf(event) + 1).some((e) => e.task === task.id && e.agent === task.claim.agent
        && !['stall', 'worker-exited'].includes(e.cmd))) continue;
      const source = event.detail.source ? createHash('sha256').update(event.detail.source).digest('hex') : event.id;
      const id = `stall:${task.id}:${source}`;
      if (!acknowledged.has(id)) items.push(item('stall', task.id, { ...event.detail, event: event.id, at: event.at || event.detail.until },
        ['inbox', '--ack', id], source));
    }
  }
  return items;
}

// This project's work the host governor deferred or stopped. They clear on
// their own: a reaction deferral when no longer owed, other admission hints
// after ten minutes without a retry, a stop an hour after it.
function governorItems(ctx, st) {
  const G = require('./governor');
  const v = G.view(ctx, st.project);
  const deferred = new Map(v.deferred.map((d) => [`${d.task}:${d.kind}`, d]));
  for (const d of require('./automation').governorDeferred(st)) deferred.set(`${d.task}:${d.kind}`, d);
  return [
    ...[...deferred.values()].map((d) => item('governor_deferred', d.task, { unit: d.kind, reason: d.reason, since: d.since, at: d.at, governor: v.state }, ['status'], d.kind)),
    ...v.stops.map((x) => item('governor_stopped', x.task, { unit: x.kind, agent: x.agent, reason: x.reason, at: x.at }, ['status'], `${x.kind}:${x.at}`)),
  ];
}

// A red run on the base clears only when a later run of its workflow is green; it has no ack.
function mainItems(st) {
  const MainCI = require('./main-ci');
  const base = st.project.base;
  const items = [];
  const byHead = new Map();
  for (const run of MainCI.pushFailures(st)) {
    if (!byHead.has(run.sha)) byHead.set(run.sha, []);
    byHead.get(run.sha).push(run);
  }
  for (const push of byHead.values()) {
    const run = push[0];
    const { id: runId, ...detail } = run;
    const existing = MainCI.fixTask(st, run);
    items.push(item('main_ci_failed', null, { ...detail, run: runId, base, runs: push,
      jobs: push.flatMap((r) => r.jobs), existing_task: existing?.id || null,
      reason: push.flatMap(MainCI.describe).join('\n') },
    existing ? ['task', 'show', existing.id]
      : ['task', 'add', '--title', MainCI.runTitle(base, run), '--kind', 'code', '--acceptance', `${run.workflow} on ${base} is green`],
    run.sha));
  }
  for (const run of MainCI.red(st)) {
    // An item's own id field names the item, so the run id goes under `run`.
    const { repeats, id: runId, ...detail } = run;
    const existing = MainCI.fixTask(st, run);
    if (run.event !== 'push') items.push(item('main_ci_failed', null, { run: runId, ...detail, base, repeats, existing_task: existing?.id || null,
      reason: MainCI.describe(run).join('\n') },
    existing ? ['task', 'show', existing.id]
      : ['task', 'add', '--title', MainCI.runTitle(base, run), '--kind', 'code', '--acceptance', `${run.workflow} on ${base} is green`],
    String(run.workflow_id)));
    for (const repeat of repeats) {
      const flaky = MainCI.flakyTask(st, repeat.test);
      items.push(item('main_ci_flaky', null, { base, test: repeat.test, workflow: run.workflow, run: runId, earlier_runs: repeat.runs,
        existing_task: flaky?.id || null,
        reason: `${repeat.test} failed on ${base} in run ${runId} and, before a green run, in run ${repeat.runs.join(', ')}` },
      flaky ? ['task', 'show', flaky.id]
        : ['task', 'add', '--title', MainCI.flakyTitle(base, repeat.test), '--kind', 'code', '--acceptance', `${repeat.test} passes repeatably on ${base}`],
      createHash('sha256').update(repeat.test).digest('hex').slice(0, 16)));
    }
  }
  return items;
}

async function query(ctx, args, list = false) {
  const r = await C.gh({ root: ctx.cwd, exec: ctx.inboxExec }, args);
  if (!r.ok) throw require('./inbox-github').failure(r, `gh ${args.join(' ')}`);
  try {
    return list ? r.stdout.split('\n').filter((s) => s.trim()).flatMap((s) => JSON.parse(s)) : JSON.parse(r.stdout);
  } catch { throw refuse(`invalid GitHub response for ${args.join(' ')}`); }
}

async function codeql(task, api) {
  const [pull] = await api(`pulls/${task.pr}`, '.');
  if (!pull) return [];
  if (!C.sameSha(pull.head?.sha, task.sha)) throw refuse(`PR #${task.pr} head changed while resolving CodeQL analyses; refresh inbox`);
  const targets = [{ ref: `refs/pull/${task.pr}/head`, sha: task.sha }];
  const mergeSha = pull.merge_commit_sha;
  if (mergeSha) {
    let current = C.sameSha(mergeSha, task.sha);
    if (!current) {
      const [merge] = await api(`git/commits/${mergeSha}`, '.');
      if (merge) {
        // GitHub's synthetic merge ref can lag a push or base update.
        // Both parents must still describe this PR before its alerts count.
        current = C.sameSha(merge.sha, mergeSha)
          && merge.parents?.some((p) => C.sameSha(p.sha, task.sha))
          && merge.parents?.some((p) => C.sameSha(p.sha, pull.base?.sha));
        if (!current) throw refuse(`PR #${task.pr} CodeQL merge commit does not match its current head and base; refresh inbox`);
      }
    }
    if (current) targets.unshift({ ref: `refs/pull/${task.pr}/merge`, sha: mergeSha });
  }
  const found = new Map();
  for (const { ref, sha } of targets) {
    const alerts = await api(`code-scanning/alerts?state=open&ref=${encodeURIComponent(ref)}&per_page=100`, '.[]');
    for (const alert of alerts) {
      const instance = alert.most_recent_instance;
      if (alert.tool?.name !== 'CodeQL' || instance?.ref !== ref || !C.sameSha(instance.commit_sha, sha)) continue;
      const key = alert.number ?? alert.html_url ?? JSON.stringify(alert);
      if (!found.has(key)) found.set(key, alert);
    }
  }
  return [...found.values()];
}

async function remote(ctx, st, task) {
  const items = [];
  const { repo } = st.project;
  const pr = await query(ctx, ['pr', 'view', String(task.pr), '-R', repo, '--json', 'state,headRefOid,mergeable,mergeStateStatus,url']);
  const same = C.sameSha(pr.headRefOid, task.sha);
  if (task.status === 'accepted' && pr.state === 'MERGED' && same) {
    return [item('accepted_unmerged', task.id, { pr: task.pr, sha: task.sha, remote: pr, confirmation: true,
      reason: 'PR merged at the accepted head; confirm its missing local merge receipt' }, ['merge', '--accepted'])];
  }
  if (task.status === 'accepted') {
    const failure = task.evidence.findLast((e) => e.type === 'merge' && e.revision === task.revision && C.sameSha(e.sha, task.sha));
    const queue = st.events.findLast((e) => e.cmd === 'merge queue' && e.detail.blocked?.task === task.id)?.detail.blocked;
    const deferred = st.events.findLast((e) => ['queue skipped', 'merge deferred'].includes(e.cmd) && e.task === task.id
      && e.detail.revision === task.revision && C.sameSha(e.detail.sha, task.sha))?.detail;
    const gates = T.gateReport(task, st.events, st);
    const blocker = gates.gates.find((gate) => !gate.ok);
    const reason = !same ? `PR head moved from ${task.sha} to ${pr.headRefOid}`
      : pr.state !== 'OPEN' ? `PR is ${pr.state}`
        : pr.mergeable !== 'MERGEABLE' ? `PR mergeability is ${pr.mergeable || 'UNKNOWN'}`
          : !gates.ok ? gates.missing.join('; ')
            : deferred?.reason || queue?.reason || (failure?.ok === false ? failure.summary : 'accepted PR has not merged');
    items.push(item('accepted_unmerged', task.id, { pr: task.pr, sha: task.sha, remote: pr, reason },
      !same || pr.state !== 'OPEN' || pr.mergeable === 'CONFLICTING'
        ? ['rework', task.id, '--reason', reason]
        : pr.mergeable === 'MERGEABLE' && blocker ? gateCommand(st, task, blocker) : ['merge', '--accepted']));
  }
  if (task.status !== 'submitted' || pr.state !== 'OPEN') return items;
  if (!same) {
    const reason = `PR head moved to ${pr.headRefOid}; verify the change and resubmit it through the worker's claim before rerunning gates`;
    items.push(item('head_changed', task.id, { pr: task.pr, sha: task.sha, head: pr.headRefOid, reason },
      ['rework', task.id, '--reason', reason]));
    return items;
  }
  const api = async (endpoint, filter) => {
    try { return await query(ctx, ['api', `repos/${repo}/${endpoint}`, '--paginate', '--jq', filter], true); }
    catch (e) {
      items.push(item('github_error', task.id, { pr: task.pr, reason: e.message,
        ...(e.inboxPending ? { pending: true } : {}) }, ['inbox'], endpoint.split('?')[0]));
      return [];
    }
  };
  const { policy, error } = require('./ci-hosted').resolve(st.project);
  if (error) throw refuse(error);
  const runs = await api(`commits/${task.sha}/check-runs?per_page=100`, '.check_runs[]');
  const failed = runs.filter((run) => {
    const app = typeof run.app === 'string' ? run.app : run.app?.slug;
    if (app !== 'revuto-review' || policy.ignore_apps.includes(app) || run.status !== 'completed' || run.conclusion !== 'failure') return false;
    const text = [run.output?.title, run.output?.summary].filter(Boolean).join('\n');
    return policy.required.some((name) => run.name?.startsWith(name))
      || !policy.capped_review.some((rule) => rule.app === app && new RegExp(rule.pattern, 'i').test(text));
  });
  if (failed.length) {
    const comments = (await api(`pulls/${task.pr}/comments?per_page=100`, '.[]'))
      .filter((c) => C.sameSha(c.commit_id, task.sha) && /^revuto(?:-[\w-]+)?(?:\[bot\])?$/.test(c.user?.login || ''));
    const findings = comments.map((c) => `${c.path}:${c.line ?? c.original_line ?? '?'} (comment ${c.id}) ${c.body}\n${c.html_url}`).join('\n');
    // The reason becomes the brief's rework note, so it says how a fixed finding is closed.
    const reason = `revuto failed at ${task.sha}\n${findings || failed.map((r) => r.output?.summary || r.name).join('\n')}`
      + (comments.length ? '\nAfter fixing a finding, or when it does not apply, mark it with tower-crane ci resolve COMMENT_ID --reason TEXT; review ok is refused while a [P1]/[P2] finding has neither a change at its path nor that reply.' : '');
    items.push(item('revuto_failed', task.id, { pr: task.pr, sha: task.sha, checks: failed, comments, reason },
      ['rework', task.id, '--reason', reason]));
  }
  try {
    const alerts = await codeql(task, api);
    if (alerts.length) {
      const reason = alerts.map((a) => `CodeQL ${a.rule?.id}: ${a.most_recent_instance?.message?.text || a.rule?.description} (${a.html_url})`).join('\n');
      items.push(item('codeql_alert', task.id, { pr: task.pr, sha: task.sha, alerts, reason },
        ['rework', task.id, '--reason', reason]));
    }
  } catch (e) {
    items.push(item('github_error', task.id, { pr: task.pr, reason: e.message }, ['inbox'], 'codeql'));
  }
  return items;
}

async function snapshot(ctx, st = S.loadState(ctx.stateDir), { refresh = false } = {}) {
  authorized(ctx, st);
  const github = require('./inbox-github').reader(ctx, st, refresh);
  ctx = { ...ctx, inboxExec: github.exec };
  // The base's CI read runs alongside the per-PR reads.
  const mainRead = refresh
    ? require('./main-ci').refresh(ctx, st).then((wrote) => ({ wrote }), (e) => ({ error: e.message }))
    : Promise.resolve({ error: github.main_error });
  let items = [...local(st, ctx.agent), ...governorItems(ctx, st)];
  await Promise.all(items.filter((i) => i.kind === 'rework_ready' && i.restore).map(async (entry) => {
    let moved;
    try { moved = await require('./automation').headMoved(ctx, st, T.getTask(st, entry.task)); }
    catch (e) { moved = e.inboxPending ? 'GitHub data not yet refreshed by the host follower' : e.message; }
    if (moved) {
      delete entry.restore;
      entry.restore_blocked = moved;
    }
  }));
  const tasks = st.tasks.tasks.filter((task) => ['submitted', 'accepted'].includes(task.status) && !require('./stack').merged(st, task));
  const remoteItems = await Promise.all(tasks.map(async (task) => {
    if (!task.pr || !st.project.repo) {
      return task.status === 'accepted' ? [item('accepted_unmerged', task.id,
        { reason: 'task has no PR or project repository' },
        ['rework', task.id, '--reason', 'record the project repository and submit a PR before merging'])] : [];
    }
    try { return await remote(ctx, st, task); }
    catch (e) { return [item('github_error', task.id, { pr: task.pr, reason: e.message,
      ...(e.inboxPending ? { pending: true } : {}) }, ['inbox'])]; }
  }));
  for (const [index, findings] of remoteItems.entries()) {
    // A landed accepted head needs its audited confirmation, not another
    // code iteration for gate evidence that no longer applies.
    if (findings.some((i) => i.confirmation)) {
      items = items.filter((i) => i.task !== tasks[index].id || !['gate_failed', 'gate_config', 'ci_stalled', 'review_failed'].includes(i.kind));
    }
    items.push(...findings);
  }
  const reviewErrors = await Promise.all(items.filter((i) => i.kind === 'review_failed').map(async (entry) => {
    const task = T.getTask(st, entry.task);
    const review = T.latestGateEvidence(task, 'review', st.events);
    try {
      const findings = await Reviews.resolve(ctx, st, task, review);
      Object.assign(entry, { findings: findings.body, ref: findings.ref, finding_count: findings.finding_count,
        findings_complete: true, findings_source: findings.source });
      return [];
    } catch (e) {
      if (!e.inboxPending) entry.fetch_error = e.message;
      return [item('github_error', task.id, { reason: e.message,
        ...(e.inboxPending ? { pending: true } : {}) }, ['inbox'], 'review')];
    }
  }));
  items.push(...reviewErrors.flat());
  const main = await mainRead;
  github.save(main.error);
  items.push(...mainItems(main.wrote ? S.loadState(ctx.stateDir) : st));
  if (main.error) items.push(item('github_error', null, { reason: main.error }, ['inbox'], 'main-ci'));
  items = items.filter((i) => i.kind !== 'github_error' || !i.pending);
  if (github.missing.size) {
    const tasks = [...github.missing].filter((id) => id !== 'project');
    const lastRefresh = Date.parse(github.read_at);
    // A recent completed pass can be between writes. Re-read its cache; an
    // overdue or missing pass needs only one bounded observation, not a host.
    const recent = Number.isFinite(lastRefresh) && lastRefresh <= Date.now()
      && Date.now() - lastRefresh < 60000;
    const action = recent ? ['inbox'] : ['wait', '--inbox', '--observe', '--timeout', '1'];
    items.push(item('github_pending', null, { tasks, count: tasks.length, last_refresh: github.read_at,
      stale: github.stale.size > 0,
      reason: `GitHub data for ${tasks.length} tasks${github.missing.has('project') ? ' and the project base' : ''} awaiting refresh; last refresh ${github.read_at || 'never'}${github.stale.size ? '; last known findings remain visible' : ''}` },
    action));
  }
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'automation') last.set(e.task, e.detail);
  const executors = [...last.entries()].filter(([, d]) => d.phase === 'running' && P.processState(d) !== 'exited')
    .map(([task, d]) => ({ task, ...d, process: P.processState(d) }));
  const worktrees = require('./worktree').inventory(st, S.findRepo(ctx.stateDir, ctx.cwd));
  for (const w of worktrees.filter((w) => w.state !== 'live')) {
    items.push(item(`worktree_${w.state}`, w.task, { path: w.path, branch: w.branch, status: w.status, reason: w.reason },
      ['worktree', 'prune', ...(w.state === 'orphan' ? ['--orphans'] : [])], w.path));
  }
  return { items, owner: require('./decisions').ownerSummary(st), worktrees: { counts: require('./worktree').counts(worktrees), entries: worktrees }, executors, gate_queue: require('./automation').gateQueue(st) };
}

async function inbox(ctx) {
  const f = ctx.flags;
  const before = f['ack-before'];
  if (f.kind !== undefined && before === undefined) throw usage('inbox --kind requires --ack-before');
  if (f.kind !== undefined && !ACKNOWLEDGEABLE.has(f.kind)) {
    throw usage(`inbox --kind needs one of ${[...ACKNOWLEDGEABLE].join(', ')}`);
  }
  if (f.ack !== undefined && before !== undefined) throw usage('inbox --ack and --ack-before cannot be combined');
  const cutoff = before === undefined ? null : Date.parse(before);
  if (before !== undefined && !Number.isFinite(cutoff)) throw usage('inbox --ack-before needs a valid timestamp');
  if (f.ack !== undefined || before !== undefined) {
    const requested = f.ack === undefined ? [] : Array.isArray(f.ack) ? f.ack : [f.ack];
    const data = S.mutate(ctx, 'inbox ack', (st, emit) => {
      authorized(ctx, st);
      const current = local(st, ctx.agent).filter((i) => ACKNOWLEDGEABLE.has(i.kind));
      const byId = new Map(current.map((i) => [i.id, i]));
      const found = before === undefined ? [...new Set(requested)].map((id) => {
        if (!byId.has(id)) throw usage('inbox --ack needs current acknowledgeable item ids');
        return byId.get(id);
      }) : current.filter((i) => (!f.kind || i.kind === f.kind) && Date.parse(i.at) <= cutoff);
      if (before === undefined && requested.length === 1) {
        emit(found[0].task, { item: found[0].id });
        return { acknowledged: found[0].id };
      }
      const items = found.map((i) => i.id);
      const detail = { items, count: items.length,
        ...(before === undefined ? {} : { cutoff: new Date(cutoff).toISOString(), ...(f.kind ? { kind: f.kind } : {}) }) };
      emit(null, detail);
      return { acknowledged: items, count: items.length, ...(before === undefined ? {} : { cutoff: detail.cutoff }) };
    });
    return { data, text: Array.isArray(data.acknowledged)
      ? `acknowledged ${data.count} inbox items${data.cutoff ? ` at or before ${data.cutoff}` : ''}`
      : `acknowledged ${data.acknowledged}` };
  }
  const data = await snapshot(ctx);
  const queue = `${data.worktrees.counts.stale} stale worktrees, ${data.worktrees.counts.orphan} orphan worktrees\ngate queue: ${require('./automation').describeQueue(data.gate_queue)}\n${data.owner.line}`;
  return { data, text: data.items.length ? data.items.map((i) => i.kind === 'github_pending'
    ? `${i.reason}\n  resolve: ${i.action.command}`
    : `${i.id}\n${JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k]) => !['id', 'action'].includes(k))), null, 2)}\n  resolve: ${i.action.command}`).join('\n\n')
    + `\n\nlive gate executors: ${data.executors.length}\n${queue}` : `inbox empty; live gate executors: ${data.executors.length}\n${queue}` };
}

// A snapshot receipt deduplicates concurrent followers without making inbox
// reads destructive. Reappearing findings wake again after a clear snapshot.
async function observe(ctx) {
  const st = S.loadState(ctx.stateDir);
  if (!require('./authority').role(ctx, st.events)) return;
  const data = await snapshot(ctx, st, { refresh: true });
  const fingerprints = data.items.map((i) => ({ id: i.id, hash: createHash('sha256').update(JSON.stringify(i)).digest('hex'), task: i.task }));
  const oncePerHead = new Set(data.items.filter((i) => i.kind === 'main_ci_failed' && i.runs).map((i) => i.id));
  S.mutate(ctx, 'inbox snapshot', (current, emit) => {
    const previous = current.events.findLast((e) => e.cmd === 'inbox snapshot')?.detail.items || [];
    if (JSON.stringify(previous) === JSON.stringify(fingerprints)) return;
    for (const i of fingerprints) {
      if (oncePerHead.has(i.id) && current.events.some((e) => e.cmd === 'inbox item' && e.detail.item === i.id)) continue;
      if (!previous.some((old) => old.id === i.id && old.hash === i.hash)) emit(i.task, { item: i.id }, 'inbox item');
    }
    emit(null, { items: fingerprints });
  });
}

module.exports = { inbox, snapshot, observe, authorized, liveWorker, dispatchable };
