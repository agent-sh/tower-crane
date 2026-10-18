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
  const spawn = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'worker');
  return !!spawn && !require('./spawn-session').exitedAttempt(spawn, st.events);
}

// Automatic refill passes hold: a gate rework that can still be restored
// waits out gates.rework_hold_min first. A spawn --ready by hand does not.
function dispatchable(st, hold = false) {
  const now = Date.now();
  return T.readyTasks(st, now).map((x) => x.task)
    .filter((t) => ['todo', 'rework'].includes(t.status) && !liveWorker(st, t)
      && !(hold && require('./rework-hold').holdEnd(st, t, now)));
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
  const acknowledged = new Set(st.events.filter((e) => e.cmd === 'inbox ack').map((e) => e.detail.item));
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
      if (review?.ok === false) items.push(item('review_failed', task.id,
        { sha: task.sha, findings: review.summary, ref: review.ref || null, reviewer: review.agent,
          finding_count: Reviews.count(review.summary), findings_complete: false,
          ...(Reviews.bodyOnly(review.findings) ? { prose_only: true,
            correction: `Edit the false PR-body claims before accept requests a light reviewer check. If the body cannot be corrected, run rework ${task.id} --reason R.` } : {}) },
        Reviews.bodyOnly(review.findings) ? ['accept', task.id] : ['rework', '--from-review', task.id]));
      // Automation held review dispatch after a reviewer exited without a
      // verdict; the orchestrator's accept dispatches the next reviewer.
      const hold = task.status === 'submitted' && !review && require('./reviewer').held(st, task);
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
          // tests.host_env is a JSON map of the host-only opt-ins; the other keys are pinned gate commands.
          const hostEnv = key === 'tests_host_env';
          items.push(item('gate_config', task.id, { gate: type, setting: hostEnv ? 'tests.host_env' : `gates.${key}`, addressed_to: 'orchestrator',
            sha: task.sha, revision: task.revision, summary: failure.summary, then: `gates retry ${task.id}` },
          ['project', 'set', `--${key.replaceAll('_', '-')}`, hostEnv ? '<JSON>' : '<command>'], type));
          continue;
        }
        const confirmed = confirmedFailure(st, task, failure);
        items.push(item('gate_failed', task.id, {
          gate: type, sha: task.sha, revision: task.revision, summary: failure.summary, ref: failure.ref || null,
          confirmed_failure: confirmed,
          ...(failure.test_failure ? { test_failure: failure.test_failure } : {}),
          ...(failure.local_ci ? { local_ci: failure.local_ci } : {}),
          ...(failure.infrastructure_failure ? { infrastructure_failure: true, timeout: failure.timeout } : {}),
        }, failureCommand(task, failure, confirmed), type));
      }
    }
    // spawn refuses a task without a brief, so a ready or rework item for it
    // would name a command that fails; brief set is the resolving action.
    if ((task.status === 'rework' || T.isReady(st, task, Date.now())) && !T.hasBrief(st, task)) {
      items.push(item('brief_missing', task.id, { reason: 'task has no brief; spawn refuses it until one is written' },
        ['brief', 'set', task.id, '--file', '<brief file>']));
    } else if (task.status === 'rework' && !liveWorker(st, task)) {
      const rework = st.events.findLast((e) => e.cmd === 'rework' && e.task === task.id);
      // An automatic gate rework nobody has touched can be undone once its cause is fixed, without a
      // worker. snapshot drops the command when the PR or branch head moved; refill waits until hold_until.
      const holdUntil = require('./rework-hold').holdEnd(st, task);
      const restore = !require('./automation').unrestorable(st, task)
        ? { gate: rework.detail.gate, restore: `gates retry ${task.id} --from-rework`, ...(holdUntil ? { hold_until: holdUntil } : {}) } : {};
      if (!redesign) items.push(item('rework_ready', task.id, { reason: rework?.detail.reason || 'task requires rework', blockers: T.blockReasons(st, task), ...restore },
        ['spawn', '--ready']));
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
      if (!acknowledged.has(id)) items.push(item('decision_answer', null, { decision }, ['inbox', '--ack', id], decision.id));
    }
  }
  const events = [...st.events, ...require('./events').sources(st, st.events, Date.now()).filter((e) => e.type === 'stall')
    .map((e) => ({ ...e, cmd: 'stall', id: e.detail.source }))];
  for (const event of events) {
    if (event.agent === 'owner' && ['task note', 'decision note'].includes(event.cmd)) {
      const id = `owner_comment:${event.task || 'project'}:${event.id}`;
      if (!acknowledged.has(id)) items.push(item('owner_comment', event.task,
        { ...event.detail, from: event.agent, event: event.id }, ['inbox', '--ack', id], event.id));
    }
    // Automation replaced the reviewer; the wedged or dead monitor stays visible until acknowledged.
    if (event.cmd === 'review exit missing') {
      const id = `review_exit_missing:${event.task}:${event.id}`;
      if (!acknowledged.has(id)) items.push(item('review_exit_missing', event.task, { ...event.detail, event: event.id },
        ['inbox', '--ack', id], event.id));
    }
    if (event.cmd === 'msg' && ['orchestrator', agent].includes(event.detail.to)) {
      const id = `message:${event.task || 'project'}:${event.id}`;
      if (!acknowledged.has(id)) items.push(item('message', event.task,
        { from: event.agent, text: event.detail.text, event: event.id }, ['inbox', '--ack', id], event.id));
    }
    if (event.cmd === 'stall') {
      const task = st.tasks.tasks.find((t) => t.id === event.task);
      if (!task?.claim || task.claim.agent !== event.detail.agent || task.claim.until !== event.detail.until) continue;
      if (events.slice(events.indexOf(event) + 1).some((e) => e.task === task.id && e.agent === task.claim.agent
        && !['stall', 'worker-exited'].includes(e.cmd))) continue;
      const source = event.detail.source ? createHash('sha256').update(event.detail.source).digest('hex') : event.id;
      const id = `stall:${task.id}:${source}`;
      if (!acknowledged.has(id)) items.push(item('stall', task.id, { ...event.detail, event: event.id },
        ['inbox', '--ack', id], source));
    }
  }
  return items;
}

// A red run on the base clears only when a later run of its workflow is green; it has no ack.
function mainItems(st) {
  const MainCI = require('./main-ci');
  const base = st.project.base;
  const items = [];
  for (const run of MainCI.red(st)) {
    // An item's own id field names the item, so the run id goes under `run`.
    const { repeats, id: runId, ...detail } = run;
    const existing = MainCI.fixTask(st, run);
    items.push(item('main_ci_failed', null, { run: runId, ...detail, base, repeats, existing_task: existing?.id || null,
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
  const r = await C.gh({ root: ctx.cwd }, args);
  if (!r.ok) throw refuse(C.ghFailure(r, `gh ${args.join(' ')}`));
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
      items.push(item('github_error', task.id, { pr: task.pr, reason: e.message }, ['inbox'], endpoint.split('?')[0]));
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

async function snapshot(ctx, st = S.loadState(ctx.stateDir)) {
  authorized(ctx, st);
  // The base's CI read runs alongside the per-PR reads.
  const mainRead = require('./main-ci').refresh(ctx, st).then((wrote) => ({ wrote }), (e) => ({ error: e.message }));
  let items = local(st, ctx.agent);
  for (const entry of items.filter((i) => i.kind === 'rework_ready' && i.restore)) {
    let moved;
    try { moved = await require('./automation').headMoved(ctx, st, T.getTask(st, entry.task)); }
    catch (e) { moved = e.message; }
    if (moved) {
      delete entry.restore;
      entry.restore_blocked = moved;
    }
  }
  for (const task of st.tasks.tasks) {
    if (!['submitted', 'accepted'].includes(task.status) || require('./stack').merged(st, task)) continue;
    if (!task.pr || !st.project.repo) {
      if (task.status === 'accepted') items.push(item('accepted_unmerged', task.id,
        { reason: 'task has no PR or project repository' },
        ['rework', task.id, '--reason', 'record the project repository and submit a PR before merging']));
      continue;
    }
    try {
      const findings = await remote(ctx, st, task);
      // A landed accepted head needs its audited confirmation, not another
      // code iteration for gate evidence that no longer applies.
      if (findings.some((i) => i.confirmation)) {
        items = items.filter((i) => i.task !== task.id || !['gate_failed', 'gate_config', 'ci_stalled', 'review_failed'].includes(i.kind));
      }
      items.push(...findings);
    }
    catch (e) { items.push(item('github_error', task.id, { pr: task.pr, reason: e.message }, ['inbox'])); }
  }
  for (const entry of [...items].filter((i) => i.kind === 'review_failed')) {
    const task = T.getTask(st, entry.task);
    const review = T.latestGateEvidence(task, 'review', st.events);
    try {
      const findings = await Reviews.resolve(ctx, st, task, review);
      Object.assign(entry, { findings: findings.body, ref: findings.ref, finding_count: findings.finding_count,
        findings_complete: true, findings_source: findings.source });
    } catch (e) {
      entry.fetch_error = e.message;
      items.push(item('github_error', task.id, { reason: e.message }, ['inbox'], 'review'));
    }
  }
  const main = await mainRead;
  items.push(...mainItems(main.wrote ? S.loadState(ctx.stateDir) : st));
  if (main.error) items.push(item('github_error', null, { reason: main.error }, ['inbox'], 'main-ci'));
  const last = new Map();
  for (const e of st.events) if (e.cmd === 'automation') last.set(e.task, e.detail);
  const executors = [...last.entries()].filter(([, d]) => d.phase === 'running' && P.processState(d) !== 'exited')
    .map(([task, d]) => ({ task, ...d, process: P.processState(d) }));
  const worktrees = require('./worktree').inventory(st, S.findRepo(ctx.stateDir, ctx.cwd));
  for (const w of worktrees.filter((w) => w.state !== 'live')) {
    items.push(item(`worktree_${w.state}`, w.task, { path: w.path, branch: w.branch, status: w.status, reason: w.reason },
      ['worktree', 'prune', ...(w.state === 'orphan' ? ['--orphans'] : [])], w.path));
  }
  return { items, worktrees: { counts: require('./worktree').counts(worktrees), entries: worktrees }, executors, gate_queue: require('./automation').gateQueue(st) };
}

async function inbox(ctx) {
  if (ctx.flags.ack !== undefined) {
    const data = S.mutate(ctx, 'inbox ack', (st, emit) => {
      authorized(ctx, st);
      const found = local(st, ctx.agent).find((i) => i.id === ctx.flags.ack && ACKNOWLEDGEABLE.has(i.kind));
      if (!found) throw usage('inbox --ack needs a current message, stall, decision answer or owner comment item id');
      emit(found.task, { item: found.id });
      return { acknowledged: found.id };
    });
    return { data, text: `acknowledged ${data.acknowledged}` };
  }
  const data = await snapshot(ctx);
  const queue = `${data.worktrees.counts.stale} stale worktrees, ${data.worktrees.counts.orphan} orphan worktrees\ngate queue: ${require('./automation').describeQueue(data.gate_queue)}`;
  return { data, text: data.items.length ? data.items.map((i) =>
    `${i.id}\n${JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k]) => !['id', 'action'].includes(k))), null, 2)}\n  resolve: ${i.action.command}`).join('\n\n')
    + `\n\nlive gate executors: ${data.executors.length}\n${queue}` : `inbox empty; live gate executors: ${data.executors.length}\n${queue}` };
}

// A snapshot receipt deduplicates concurrent followers without making inbox
// reads destructive. Reappearing findings wake again after a clear snapshot.
async function observe(ctx) {
  const st = S.loadState(ctx.stateDir);
  if (!require('./authority').role(ctx, st.events)) return;
  const data = await snapshot(ctx, st);
  const fingerprints = data.items.map((i) => ({ id: i.id, hash: createHash('sha256').update(JSON.stringify(i)).digest('hex'), task: i.task }));
  S.mutate(ctx, 'inbox snapshot', (current, emit) => {
    const previous = current.events.findLast((e) => e.cmd === 'inbox snapshot')?.detail.items || [];
    if (JSON.stringify(previous) === JSON.stringify(fingerprints)) return;
    for (const i of fingerprints) {
      if (!previous.some((old) => old.id === i.id && old.hash === i.hash)) emit(i.task, { item: i.id }, 'inbox item');
    }
    emit(null, { items: fingerprints });
  });
}

module.exports = { inbox, snapshot, observe, authorized, liveWorker, dispatchable };
