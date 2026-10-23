'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('./commands');
const { isDeepStrictEqual } = require('node:util');
const { refuse, usage, conflict, nowIso, shaMatch, shortTime, byId, readStdin } = require('./util');
const S = require('./state');
const L = require('./ladder');
const P = require('./processes');
const B = require('./brief');
const Scope = require('./scope');
const Authority = require('./authority');

const SIZE_HOURS = { S: 1, M: 4, L: 8 };
const GATE_TYPES = ['tests', 'clean', 'sources', 'review', 'ci'];
const SOFTWARE_GATES = ['tests', 'clean', 'sources', 'ci', 'merge'];
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PRECHECKS = ['pass', 'fail', 'skipped'];
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function knownFlakes(events, tasks) {
  const open = new Set(tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status)).map((t) => t.id));
  return new Set(events.filter((e) => e.cmd === 'task add' && open.has(e.task) && typeof e.detail?.flake === 'string')
    .map((e) => e.detail.flake));
}

// The gate writer calls this inside its existing state mutation, so concurrent
// failures of the same test cannot create two open fix tasks.
function recordFailureTasks(st, emit, task, entry) {
  for (const record of [...entry.base_failure || [], ...entry.known_flake || []]) {
    const title = `${record.test} fails on main`;
    const flakeIds = st.events.filter((e) => e.cmd === 'task add' && e.detail?.flake === record.test).map((e) => e.task);
    let fix = st.tasks.tasks.find((t) => t.id !== task.id && !['accepted', 'cancelled'].includes(t.status)
      && (t.title === title || t.base_failure_test === record.test || flakeIds.includes(t.id)));
    if (!fix) {
      fix = newTask(st, { title, kind: 'code', size: 'S',
        acceptance: [`${record.test} passes on main; its recorded failure cause is fixed`] });
      fix.base_failure_test = record.test;
      S.writeAtomic(briefPath(st.dir, fix.id), `# ${fix.id}: ${title}\n\nFix the failure recorded below. Find and fix its cause.\n`);
      emit(fix.id, { title, base_failure_test: record.test }, 'task add');
    }
    record.fix_task = fix.id;
    const text = `${task.id} ${entry.type} at ${entry.sha}: ${record.classification}; test ${record.test}; `
      + `run ${record.base_run?.id ?? record.run ?? entry.sha}; first error: ${record.error || record.first_failure?.error || '(not reported)'}`;
    note(fix, 'tower-crane', text);
    const file = briefPath(st.dir, fix.id);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${fix.id}: ${fix.title}\n`;
    S.writeAtomic(file, `${before.trimEnd()}\n\n## Failure evidence\n\n- ${text}\n`);
    emit(fix.id, { text, from_task: task.id, gate: entry.type, ...record }, 'task note');
  }
}

function normId(id, prefix) {
  const s = String(id || '').trim();
  return new RegExp(`^${prefix}\\d+$`, 'i').test(s) ? s.toUpperCase() : s;
}

function getTask(st, id) {
  const tid = normId(id, 'T');
  const task = st.tasks.tasks.find((t) => t.id === tid);
  if (!task) throw refuse(`no task ${id}; tower-crane task list shows the ids`);
  return task;
}

const briefPath = (dir, id) => path.join(dir, 'briefs', `${id}.md`);
const hasBrief = (st, task) => fs.existsSync(briefPath(st.dir, task.id));

function leaseExpired(task, now) {
  return task.status === 'in_progress' && !!task.claim && Date.parse(task.claim.until) <= now;
}

// An expired lease frees the task: it counts as the status it had before the claim.
function effectiveStatus(task, now) {
  if (leaseExpired(task, now)) return task.claim.from || 'todo';
  return task.status;
}

function openDecisionsFor(st, id) {
  return st.decisions.decisions.filter((d) => d.status === 'open' && d.blocks.includes(id));
}

// Why a todo or rework task cannot be claimed; empty when it is ready.
function blockReasons(st, task, now = Date.now()) {
  const reasons = unsupportedTaskValues(task, st);
  const redesign = require('./review-findings').redesign(task, st.events);
  if (redesign) reasons.push(redesign.reason);
  if (st.project.limits.paused) reasons.push(`project paused: ${st.project.limits.paused}`);
  const stackParent = require('./stack').parent(st, task);
  const byKey = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  for (const dep of task.depends_on) {
    const d = byKey.get(dep);
    if (!d) reasons.push(`depends on ${dep}, which does not exist`);
    else if (d.status !== 'accepted' && !(d.status === 'submitted' && stackParent)) reasons.push(`depends on ${dep} (${d.status})`);
  }
  if (task.needs_owner) reasons.push(`needs owner: ${task.needs_owner}`);
  for (const d of openDecisionsFor(st, task.id)) reasons.push(`waits for decision ${d.id}: ${d.question}`);
  reasons.push(...lockReasons(st, task, now));
  return reasons;
}

// Readers keep future values, but dispatch and readiness must understand
// the fields that choose work, capabilities and model routes.
function unsupportedTaskValues(task, st) {
  const fields = { status: S.STATUSES, kind: S.KINDS, size: S.SIZES, tier: S.TIERS };
  const reasons = Object.entries(fields).filter(([key, values]) => !values.includes(task[key]))
    .map(([key]) => `unsupported ${key} "${task[key]}"; upgrade Tower Crane`);
  for (const need of task.needs || []) {
    if (!S.NEEDS.includes(need)) reasons.push(`unsupported capability "${need}"; upgrade Tower Crane`);
  }
  if (task.tier_range && [task.tier_range.min, task.tier_range.max].some((tier) => !S.TIERS.includes(tier))) {
    reasons.push('unsupported tier_range; upgrade Tower Crane');
  }
  for (const decision of st?.decisions?.decisions || []) {
    if (decision.blocks.includes(task.id) && !['open', 'answered', 'withdrawn'].includes(decision.status)) {
      reasons.push(`decision ${decision.id} has unsupported status "${decision.status}"; upgrade Tower Crane`);
    }
  }
  return reasons;
}

function requireSupportedTask(task, st) {
  const reasons = unsupportedTaskValues(task, st);
  if (reasons.length) throw Object.assign(refuse(`${task.id}: ${reasons.join('; ')}`), { stateIncompatible: true });
}

function isReady(st, task, now) {
  const eff = effectiveStatus(task, now);
  return (eff === 'todo' || eff === 'rework') && blockReasons(st, task, now).length === 0;
}

// Tasks whose completion frees the most outstanding work go first.
function unblockCounts(st) {
  const dependents = new Map();
  for (const t of st.tasks.tasks) {
    for (const d of t.depends_on) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(t);
    }
  }
  const counts = new Map();
  for (const t of st.tasks.tasks) {
    const seen = new Set();
    const stack = [t.id];
    while (stack.length) {
      for (const dt of dependents.get(stack.pop()) || []) {
        if (seen.has(dt.id) || dt.status === 'accepted' || dt.status === 'cancelled') continue;
        seen.add(dt.id);
        stack.push(dt.id);
      }
    }
    counts.set(t.id, seen.size);
  }
  return counts;
}

function readyTasks(st, now) {
  const counts = unblockCounts(st);
  return st.tasks.tasks
    .filter((t) => isReady(st, t, now))
    .sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || counts.get(b.id) - counts.get(a.id) || byId(a, b))
    .map((t) => ({ task: t, unblocks: counts.get(t.id) }));
}

function blockedTasks(st, now) {
  return st.tasks.tasks
    .filter((t) => ['todo', 'rework'].includes(effectiveStatus(t, now)))
    .map((t) => ({ task: t, reasons: blockReasons(st, t, now) }))
    .filter((b) => b.reasons.length)
    .sort((a, b) => byId(a.task, b.task));
}

// todo splits into ready or blocked; everything else shows its stored status.
function displayStatus(st, task, now) {
  const eff = effectiveStatus(task, now);
  if (eff === 'todo') return blockReasons(st, task, now).length ? 'blocked' : 'ready';
  return eff;
}

function requiredGates(task) {
  const gates = task.kind === 'code' || task.hotfix ? ['tests', 'clean', 'review'] : ['review'];
  if (require('./research').required(task)) gates.unshift('sources');
  // A PR lands through GitHub whatever the task's kind, so CI must pass on the exact commit.
  return task.pr ? [...gates, 'ci'] : gates;
}

// The events of one task, from an index built once per events array. Views
// check every task against the whole log; scanning it per task grows with
// tasks times events. An array that grew in place is indexed again.
const taskIndexes = new WeakMap();
function taskEvents(events, id) {
  let index = taskIndexes.get(events);
  if (!index || index.length !== events.length) {
    const byTask = new Map();
    for (const e of events) {
      if (!e) continue;
      let list = byTask.get(e.task);
      if (!list) byTask.set(e.task, list = []);
      list.push(e);
    }
    index = { length: events.length, byTask };
    taskIndexes.set(events, index);
  }
  return index.byTask.get(id) || [];
}

function hasGateEvent(task, entry, events) {
  const source = entry.type === 'merge' ? 'merge' : `check ${entry.type}`;
  if (entry.source !== source || !Array.isArray(entry.commands)) return false;
  if (entry.ok && !entry.commands.length) return false;
  return taskEvents(events, task.id).some((event) => event.cmd === entry.source
    && event.agent === entry.agent && event.detail
    && event.detail.type === entry.type && event.detail.source === entry.source
    && event.detail.sha === entry.sha && event.detail.ok === entry.ok
    && event.detail.revision === entry.revision && isDeepStrictEqual(event.detail.commands, entry.commands)
    && isDeepStrictEqual(event.detail.receipt, entry.receipt)
    && isDeepStrictEqual(event.detail.base_failure, entry.base_failure)
    && isDeepStrictEqual(event.detail.known_flake, entry.known_flake)
    && isDeepStrictEqual(event.detail.ci_policy, entry.ci_policy)
    && isDeepStrictEqual(event.detail.gate_policy, entry.gate_policy)
    && event.detail.tests_mode === entry.tests_mode
    && event.detail.confirmed_failure === entry.confirmed_failure
    && event.detail.pending === entry.pending
    && event.detail.not_running === entry.not_running
    && event.detail.stalled === entry.stalled);
}

function eligibleGateEvidence(task, entry, events) {
  if (entry.waived) {
    if (entry.agent === 'owner') return true;
    if (!Authority.isOrchestrator(entry.agent, events)) return false;
    if (Authority.TABLE[`waive.${entry.type}`]?.[0] === Authority.OPERATIONAL && !entry.approved_by) return true;
    // An owner-required waiver the orchestrator recorded counts only with the owner's approval in the log.
    return !!entry.approved_by && entry.revision === task.revision
      && Authority.approvedIn(events, entry.approved_by, entry.type === 'review' ? 'waive.review_live' : `waive.${entry.type}`, task.id, entry.sha, task.revision);
  }
  return entry.type === 'review' ? independentReviewer(task, entry, events) : hasGateEvent(task, entry, events);
}

// Anyone can record review evidence under any name, so only a reviewer
// dispatch for this exact head and revision, or the owner, stands for review.
function independentReviewer(task, entry, events) {
  if (entry.source === 'hotfix review') return require('./hotfix').postedReviewRecorded(task, entry, events);
  if (entry.agent === task.submitted_by) return false;
  if (entry.agent === 'owner') return true;
  return taskEvents(events, task.id).some((e) => e.cmd === 'spawn' && e.detail?.role === 'reviewer'
    && e.detail.agent === entry.agent && e.detail.revision === entry.revision && shaMatch(e.detail.sha, entry.sha));
}

function latestGateEvidence(task, type, events = []) {
  return task.evidence.findLast((e) => e.type === type && e.revision === task.revision
    && shaMatch(e.sha, task.sha) && eligibleGateEvidence(task, e, events));
}

function ciInputs(st, task) {
  return { sha: task.sha, kind: task.kind, override: task.ci_local,
    local: st?.project.ci?.local, base: st ? require('./stack').targetBase(st, task) : null,
    pinned: (st && latestGateEvidence(task, 'ci', st.events)?.receipt?.base_sha) || null };
}

function prepareCI(st, task) {
  if (task.hotfix || !st?.project.ci?.local || !task.sha) return null;
  const Local = require('./ci-local');
  const inputs = ciInputs(st, task);
  const repo = S.findRepo(st.dir, process.cwd());
  const current = Local.snapshot(repo?.root, { ...st.project, base: inputs.base }, task.sha);
  // A merged task's report keeps its recorded result, so its cache entry is dropped.
  const live = () => st.tasks.tasks.filter((t) => t.sha && t.status !== 'cancelled'
    && !latestGateEvidence(t, 'merge', st.events)?.ok).map((t) => t.id);
  return { inputs: structuredClone(inputs), current,
    pinned: Local.pinned(repo?.root, current, inputs.pinned, st.dir ? { dir: st.dir, task: task.id, live } : null) };
}

function gatePolicyMismatch(task, entry, st) {
  if (!st || !entry.ok || entry.waived || !['tests', 'clean'].includes(entry.type)) return null;
  const reason = require('./gate-commands').mismatch(entry, st.project, task);
  if (reason) return reason;
  if (entry.type === 'tests') {
    const policy = require('./tests-policy').resolve(st.project, task.kind);
    if (policy.error) return policy.error;
    if (entry.tests_mode !== policy.mode) {
      return `tests evidence mode ${entry.tests_mode ?? 'unrecorded'} no longer matches ${policy.mode}; run tower-crane check tests ${task.id} again`;
    }
  }
  return null;
}

function gateReport(task, events = [], st, preparedCI) {
  const sha7 = task.sha ? task.sha.slice(0, 7) : null;
  const merge = latestGateEvidence(task, 'merge', events);
  const merged = merge?.ok && !merge.waived;
  const gates = requiredGates(task).map((type) => {
    if (!task.sha) return { type, ok: false, reason: 'the task has no submitted sha' };
    // A marker in tasks.json alone cannot prove the gate ran; require its audit receipt too.
    const latest = latestGateEvidence(task, type, events);
    if (!latest) {
      const atSha = task.evidence.filter((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha));
      const others = atSha.filter((e) => e.agent !== task.submitted_by);
      const reason = type !== 'review' || !atSha.length ? `no ${type} evidence at ${sha7} for revision ${task.revision}`
        : !others.length ? `only the submitter (${task.submitted_by}) reviewed; needs an ok review from a spawned reviewer or the owner`
          : `review by ${[...new Set(others.map((e) => e.agent))].join(', ')} does not count: not a reviewer spawned for ${task.id} at ${sha7} revision ${task.revision}, nor the owner`;
      return { type, ok: false, reason };
    }
    if (!latest.ok) {
      const state = latest.stalled ? 'stalled' : latest.pending ? 'pending' : 'failed';
      return { type, ok: false, state, reason: `latest ${type} at ${sha7} ${state}${latest.summary ? `: ${latest.summary}` : ''}` };
    }
    if (type === 'sources' && !latest.waived && st && latest.receipt?.min_sources !== require('./research').minimum(st.project)) {
      return { type, ok: false, reason: `research.min_sources changed; run tower-crane check sources ${task.id} again` };
    }
    const policyReason = gatePolicyMismatch(task, latest, st);
    if (policyReason) return { type, ok: false, reason: policyReason };
    if (type === 'ci' && !task.hotfix && (latest.receipt || st?.project.ci?.local != null) && !latest.waived && !merged) {
      const Local = require('./ci-local');
      const local = Local.resolve(st?.project.ci?.local, task);
      if (local.error) return { type, ok: false, reason: local.error };
      const prepared = preparedCI || prepareCI(st, task);
      if (!prepared || !isDeepStrictEqual(prepared.inputs, ciInputs(st, task))) {
        throw refuse(`${task.id}: local CI inputs changed after preparation; retry`);
      }
      const current = prepared.current;
      const reason = local.error || current.error || Local.mismatch(latest.receipt, current, local, latest.commands, prepared.pinned);
      if (reason) return { type, ok: false, reason };
    } else if (type === 'ci' && st && !latest.waived && !merged) {
      const reason = require('./ci-hosted').mismatch(latest.ci_policy, st.project, task.id);
      if (reason) return { type, ok: false, reason };
    }
    return { type, ok: true, waived: !!latest.waived, agent: latest.agent, reason: latest.waived ? `waived by ${latest.agent}` : `ok by ${latest.agent}` };
  });
  const missing = [...unsupportedTaskValues(task, st),
    ...(task.hotfix && !require('./hotfix').recorded({ events }, task) ? ['hotfix has no matching merge record'] : []),
    ...gates.filter((g) => !g.ok).map((g) => `${g.type}: ${g.reason}`)];
  return { ok: !!task.sha && !missing.length, gates, missing };
}

// The CLI is the only writer, so it never lets a dependency point nowhere or
// loop back; validate still checks files that were edited by hand.
function assertGraph(st, ids) {
  const byKey = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  for (const id of ids) {
    for (const dep of byKey.get(id).depends_on) {
      if (!byKey.has(dep)) throw refuse(`${id} depends on ${dep}, which does not exist; add ${dep} first or fix the id`);
    }
  }
  for (const id of ids) {
    const cycle = cycleThrough(byKey, id);
    if (cycle) throw refuse(`dependencies would form a cycle (${cycle.join(' -> ')}, each needing the next); drop one of them`);
  }
}

function cycleThrough(byKey, id) {
  const seen = new Set();
  const trail = [id];
  const walk = (cur) => {
    for (const d of byKey.get(cur).depends_on) {
      if (d === id) return [...trail, id];
      if (seen.has(d) || !byKey.has(d)) continue;
      seen.add(d);
      trail.push(d);
      const found = walk(d);
      if (found) return found;
      trail.pop();
    }
    return null;
  };
  return walk(id);
}

function findCycles(tasks) {
  const byKey = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map();
  const stack = [];
  const cycles = new Map();
  const visit = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of byKey.get(id).depends_on) {
      if (!byKey.has(d)) continue;
      if (color.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join(',');
        if (!cycles.has(key)) cycles.set(key, [...cyc, d]);
      } else if (!color.get(d)) visit(d);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const t of [...tasks].sort(byId)) if (!color.get(t.id)) visit(t.id);
  return [...cycles.values()];
}

function asList(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

function checkEnum(name, value, list) {
  if (!list.includes(value)) throw usage(`--${name} must be one of ${list.join(', ')}, got "${value}"`);
}

// The highest task number the event log has seen. tasks.json can lose a write
// whose receipt the log kept; numbering past the log keeps every id unique.
function loggedTaskMax(events) {
  let max = 0;
  for (const e of events) {
    const m = typeof e.task === 'string' && /^T(\d+)$/.exec(e.task);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function taskNeeds(value) {
  let names;
  try { names = JSON.parse(value); } catch { throw usage(`--needs must be a JSON array of capabilities: ${S.NEEDS.join(', ')}`); }
  if (!Array.isArray(names) || !names.every((name) => S.NEEDS.includes(name))) {
    throw usage(`--needs must be a JSON array of capabilities: ${S.NEEDS.join(', ')}`);
  }
  return [...new Set(names)];
}

function newTask(st, fields) {
  st.tasks.next = Math.max(st.tasks.next, loggedTaskMax(st.events) + 1);
  const id = `T${st.tasks.next}`;
  st.tasks.next += 1;
  const task = {
    id,
    title: fields.title,
    kind: fields.kind || 'code',
    needs: fields.needs || [],
    acceptance: fields.acceptance,
    depends_on: fields.depends_on || [],
    locks: fields.locks || [],
    environment: fields.environment || null,
    needs_owner: fields.needs_owner?.trim() || null,
    // Who set the hold decides who may cancel the task past it (Authority.holdSetting).
    ...(fields.needs_owner?.trim() && fields.needs_owner_by ? { needs_owner_by: fields.needs_owner_by } : {}),
    size: fields.size || 'M',
    ...L.tierSpec(fields.tier || L.defaultTier(fields.kind || 'code', fields.size || 'M')),
    status: 'todo',
    claim: null,
    branch: null,
    pr: null,
    sha: null,
    submitted_by: null,
    evidence: [],
    revision: 1,
    spend: { minutes: 0, tokens: 0 },
    notes: [],
  };
  st.tasks.tasks.push(task);
  return task;
}

function note(task, agent, text) {
  task.notes.push({ at: nowIso(), agent, text });
}

// A restore (gates retry --from-rework) returns a task to the revision its
// automatic gate rework replaced and retires the replaced number. Every later
// bump skips retired numbers, so evidence recorded at one never counts again.
function retiredRevisions(events, id) {
  return taskEvents(events, id).filter((e) => e.cmd === 'restore' && Number.isInteger(e.detail?.from_revision))
    .map((e) => e.detail.from_revision);
}

function nextRevision(st, task) {
  return Math.max(task.revision, ...retiredRevisions(st.events, task.id)) + 1;
}

function taskLine(st, t, now) {
  return `${t.id.padEnd(5)} ${(t.status === 'accepted' && t.hotfix ? 'accepted (hotfix)' : displayStatus(st, t, now)).padEnd(11)} ${t.size} ${t.kind.padEnd(8)} ${t.title}${t.priority === 'urgent' && !['accepted', 'cancelled'].includes(t.status) ? '  [urgent]' : ''}`;
}

// ---- Plan ----

function checkTier(tier, fail = usage) {
  if (!L.tierSpec(tier)) throw fail(`--tier must be one of ${L.TIERS.join(', ')} or an ascending range such as easy..medium`);
}

function applyTier(task, value) {
  delete task.tier_range;
  delete task.escalation_pending;
  Object.assign(task, L.tierSpec(value));
}

function taskAdd(ctx) {
  const f = ctx.flags;
  if (!f.title || !f.title.trim()) throw usage('task add needs --title');
  const acceptance = asList(f.acceptance);
  if (!acceptance.length) throw usage('task add needs at least one --acceptance line saying how to tell it is done');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.tier !== undefined) checkTier(f.tier);
  const brief = f.brief === undefined ? undefined : readBriefFile(ctx, f.brief);
  const needs = f.needs === undefined ? [] : taskNeeds(f.needs);
  const task = S.mutate(ctx, 'task add', (st, emit, commit) => {
    let added = null;
    try {
      const t = newTask(st, {
        title: f.title.trim(), kind: f.kind, needs, acceptance, size: f.size, tier: f.tier,
        depends_on: asList(f.dep).map((d) => normId(d, 'T')), needs_owner: f['needs-owner'] ? f['needs-owner'] : null,
        needs_owner_by: Authority.holdBy(ctx, st.events),
        locks: [...new Set(asList(f.lock))], environment: f.environment?.trim() || null,
      });
      assertGraph(st, [t.id]);
      // Under the lock and before the sketch renders, so the task never shows as briefless.
      if (brief !== undefined) {
        added = t.id;
        fs.mkdirSync(path.dirname(briefPath(st.dir, t.id)), { recursive: true });
        S.writeAtomic(briefPath(st.dir, t.id), brief);
      }
      emit(t.id, { title: t.title, ...(brief !== undefined ? { bytes: Buffer.byteLength(brief) } : {}) });
      // Commit and clean up failures before another add can reuse this id.
      commit();
      return t;
    } catch (e) {
      if (added) discardUncommittedBrief(st.dir, added);
      throw e;
    }
  });
  if (brief !== undefined) warnRoleSections(brief);
  return { data: task, text: task.id };
}

// A commit is durable once its last event is logged. An add that failed
// after that point, renaming tasks.json, leaves its staged tasks.json for the
// next lock holder to rename into place, so its task and brief stay. The
// caller still holds the mutation lock, so the log ends with that commit's
// last event exactly when it reached that point.
function discardUncommittedBrief(dir, id) {
  const holds = (file) => S.readJson(file).tasks.some((t) => t.id === id);
  const last = S.lastLogged(dir)?.id;
  const committed = holds(path.join(dir, 'tasks.json'))
    || S.stagedCommits(dir, 'tasks').some((c) => c.id === last && holds(c.file));
  if (!committed) fs.rmSync(briefPath(dir, id), { force: true });
}

function readBriefFile(ctx, file) {
  try {
    return fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8');
  } catch (e) {
    throw refuse(`cannot read ${file} (${e.code || e.message})`);
  }
}

function taskUpdate(ctx) {
  const f = { ...ctx.flags };
  if (f['superseded-by'] !== undefined) f.status = 'cancelled';
  if (!Object.keys(f).length) throw usage('task update needs at least one change; see tower-crane task update --help');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.priority !== undefined) checkEnum('priority', f.priority, ['urgent', 'normal']);
  if (f.tier !== undefined) checkTier(f.tier);
  const needs = f.needs === undefined ? null : taskNeeds(f.needs);
  if (f.status !== undefined && f.status !== 'cancelled') {
    throw usage('task update can only set --status cancelled; claim, submit, accept and rework move the other states');
  }
  let ciLocal;
  if (f['ci-local'] !== undefined) {
    const message = '--ci-local must be JSON with command or args and optional positive timeout in seconds and receipts, or null';
    try {
      ciLocal = JSON.parse(f['ci-local']);
    } catch {
      throw usage(message);
    }
    const Local = require('./ci-local');
    if (ciLocal !== null && !Local.validOverride(ciLocal, { allowReceipts: true })) throw usage(Local.receiptsError(ciLocal) || message);
  }
  const grants = f['broker-verbs'] === undefined ? null : require('./verbs').grantList(f['broker-verbs']);
  const task = S.mutate(ctx, 'task update', (st, emit, commit) => {
    const t = getTask(st, ctx.pos[0]);
    if (f.status !== undefined && !S.STATUSES.includes(t.status)) throw refuse(`${t.id}: unsupported status "${t.status}"; upgrade Tower Crane`);
    const liveClaim = t.status === 'in_progress' && t.claim && !leaseExpired(t, Date.now()) ? t.claim : null;
    const needsOwner = f['needs-owner'] === undefined ? undefined : f['needs-owner'].trim() || null;
    // Updating the reason must not bypass owner-done's check.
    const settings = [
      ...(f.kind !== undefined ? Authority.kindSettings(t, f.kind) : []),
      ...(f.priority !== undefined ? ['task.priority'] : []),
      ...(f.tier !== undefined && (f.tier !== t.tier || t.tier_range) ? ['task.tier'] : []),
      ...(f['ci-local'] !== undefined ? ['ci.local'] : []),
      ...(needsOwner !== undefined && t.needs_owner && needsOwner !== t.needs_owner ? ['task.needs_owner'] : []),
      ...(f.status === 'cancelled' && t.needs_owner ? [Authority.holdSetting(st, t)] : []),
      ...[['budget-hours', 'hours'], ['budget-tokens', 'tokens']].filter(([flag]) => f[flag] !== undefined)
        .map(([flag, key]) => require('./project').budgetSetting(t.budget?.[key] ?? null, f[flag])),
    ];
    const grantSettings = grants ? require('./verbs').grantSettings(st.project, t, grants) : [];
    settings.push(...grantSettings);
    const budgetFields = [['budget-hours', 'hours'], ['budget-tokens', 'tokens']].filter(([flag]) => f[flag] !== undefined);
    const target = { task: t.id, ...(f.kind !== undefined ? { kind: f.kind } : {}), ...(f.status !== undefined ? { status: f.status } : {}) };
    const change = { ...target, ...Object.fromEntries(budgetFields
      .filter(([flag, key]) => Authority.classOf(require('./project').budgetSetting(t.budget?.[key] ?? null, f[flag])) === Authority.OWNER)
      .map(([flag]) => [flag, f[flag]])), ...(grantSettings.includes('task.broker_verbs_owner') ? { broker_verbs: grants } : {}) };
    const ownerChange = { ...target, ...Object.fromEntries(budgetFields.map(([flag]) => [flag, f[flag]])), ...(grants ? { broker_verbs: grants } : {}) };
    Authority.enforce(ctx, st, settings, { change, emit, commit, keep: true, quiet: true });
    const changes = {};
    const material = [];
    if (needs !== null) {
      if (!isDeepStrictEqual(needs, t.needs)) material.push('needs');
      t.needs = changes.needs = needs;
    }
    if (f.lock !== undefined) {
      const locks = [...new Set(asList(f.lock))];
      if (!isDeepStrictEqual([...locks].sort(), [...t.locks].sort())) {
        const holders = workerHolders(st, Date.now()).filter((h) => h.task === t.id);
        if (holders.length) {
          throw refuse(`${t.id}'s locks cannot change while held by ${holders.map((h) => `${h.agent} (${h.kind})`).join(', ')}; wait for release, submission or expiry`);
        }
      }
      t.locks = changes.locks = locks;
    }
    if (f.environment !== undefined) t.environment = changes.environment = f.environment.trim() || null;
    if (grants) {
      if (grants.length) t.broker_verbs = grants;
      else delete t.broker_verbs;
      changes.broker_verbs = grants;
    }
    if (f.title !== undefined) {
      if (!f.title.trim()) throw usage('--title cannot be empty');
      t.title = changes.title = f.title.trim();
    }
    if (f.acceptance !== undefined) {
      const acc = asList(f.acceptance);
      if (!acc.length) throw usage('--acceptance cannot be empty; every task needs a way to tell it is done');
      if (JSON.stringify(acc) !== JSON.stringify(t.acceptance)) material.push('acceptance');
      t.acceptance = changes.acceptance = acc;
    }
    if (f['closed-acceptance']) {
      if (!material.includes('acceptance')) throw usage('--closed-acceptance needs a changed --acceptance list');
      settings.push('task.scope_ruling');
      changes.closed_acceptance = true;
      changes.review_after = t.evidence.length;
    }
    if (f.dep !== undefined) {
      const deps = asList(f.dep).map((d) => normId(d, 'T'));
      if ([...deps].sort().join() !== [...t.depends_on].sort().join()) material.push('dependencies');
      t.depends_on = changes.depends_on = deps;
    }
    for (const [flag, key] of [['budget-hours', 'hours'], ['budget-tokens', 'tokens']]) {
      if (f[flag] === undefined) continue;
      if (f[flag] < 0) throw usage(`--${flag} cannot be negative`);
      t.budget = { hours: null, tokens: null, ...t.budget, [key]: f[flag] };
      changes.budget = t.budget;
    }
    if (f.size !== undefined) t.size = changes.size = f.size;
    if (f.priority !== undefined) {
      // Absent means normal, so normal removes the field instead of storing it.
      if (f.priority === 'urgent') t.priority = 'urgent';
      else delete t.priority;
      changes.priority = f.priority;
    }
    if (f.kind !== undefined) {
      if (f.kind !== t.kind) material.push('kind');
      t.kind = changes.kind = f.kind;
    }
    if (f['ci-local'] !== undefined) {
      if (!isDeepStrictEqual(t.ci_local ?? null, ciLocal)) material.push('local CI override');
      if (ciLocal === null) delete t.ci_local;
      else t.ci_local = ciLocal;
      changes.ci_local = ciLocal;
    }
    // A tier is chosen once; changing size or kind later does not move it.
    if (f.tier !== undefined) { applyTier(t, f.tier); changes.tier = f.tier; }
    if (needsOwner !== undefined && needsOwner !== t.needs_owner) {
      t.needs_owner = changes.needs_owner = needsOwner;
      if (needsOwner) t.needs_owner_by = changes.needs_owner_by = Authority.holdBy(ctx, st.events);
      else delete t.needs_owner_by;
    } else if (needsOwner !== undefined) {
      changes.needs_owner = needsOwner;
    }
    if (f['superseded-by'] !== undefined) {
      const replacement = getTask(st, f['superseded-by']);
      if (replacement.id === t.id || replacement.status === 'cancelled') throw refuse('supersede requires a different live replacement task');
      t.superseded_by = changes.superseded_by = replacement.id;
    }
    if (f.status === 'cancelled') {
      if (t.status === 'accepted') throw refuse(`${t.id} is already accepted; it cannot be cancelled`);
      t.status = changes.status = 'cancelled';
      t.claim = null;
    }
    // An accepted task was reviewed and gated against its acceptance,
    // dependencies and capabilities (authority refuses its kind). Changing one
    // would leave it accepted for something nobody checked, with its dependents still claimable.
    if (t.status === 'accepted' && material.length) {
      throw refuse(`${t.id} is accepted, so its ${material.join(' and ')} cannot change; send it back first with tower-crane rework ${t.id} --reason R`);
    }
    assertGraph(st, [t.id]);
    if (liveClaim && material.length && !f.interrupt) throw refuse(`${t.id} has a live claim; changing ${material.join(' and ')} requires --interrupt by the owner or orchestrator`);
    // Kind needs no new revision: the gates are worked out from the current kind.
    const bump = material.includes('acceptance') || material.includes('dependencies') || material.includes('needs');
    if (bump) {
      t.revision = nextRevision(st, t);
      changes.revision = t.revision;
    }
    const interrupted = liveClaim && material.length;
    if (interrupted) settings.push('task.interrupt');
    const ownerWrite = {
      settings: [
        ...(f.kind !== undefined ? ['task.downgrade'] : []),
        ...(f.status === 'cancelled' ? ['task.cancel_needs_owner'] : []),
        ...(budgetFields.length ? ['budget.raise'] : []),
        ...(grants ? ['task.broker_verbs_owner'] : []),
      ], change: ownerChange,
    };
    // Combine the changed fields and interruption into one settings audit.
    Authority.enforce(ctx, st, settings, { change, ownerWrite, emit, commit });
    // Bumped first, so the interrupt event carries the revision the task now has.
    if (interrupted) interruptClaim(ctx, st, emit, t, `requirements changed: ${material.join(', ')}`, liveClaim, false);
    emit(t.id, changes);
    return { t, bump };
  });
  if (f.status === 'cancelled') {
    require('./worktree').retireTask(ctx, [{ id: task.t.id, sha: task.t.sha, revision: task.t.revision }]);
    task.t = getTask(S.loadState(ctx.stateDir), task.t.id);
  }
  return { data: task.t, text: `updated ${task.t.id}${task.bump ? `; revision is now ${task.t.revision}, so earlier evidence no longer counts` : ''}` };
}

// Tier changes from the serve Settings view: the write task update --tier
// makes, for several tasks under one lock, so a refused one writes none.
// expect maps each task to the tier the page loaded; a task whose tier moved
// since is refused, so the page cannot undo a change it never showed.
function setTiers(ctx, tiers, via, expect) {
  for (const tier of Object.values(tiers)) checkTier(tier);
  return S.mutate(ctx, 'task update', (st, emit) => {
    const tasks = Object.keys(tiers).map((id) => getTask(st, id));
    Authority.enforce(ctx, st, tasks.some((t) => t.tier !== tiers[t.id] || t.tier_range) ? ['task.tier'] : [], { emit });
    if (expect) {
      const stale = tasks.filter((t) => expect[t.id] !== t.tier).map((t) => `${t.id} is now ${t.tier}, not ${expect[t.id]}`);
      if (stale.length) throw conflict(`tiers changed since this page loaded: ${stale.join('; ')}; reload the page and make the edit again`);
    }
    return tasks.map((t) => {
      applyTier(t, tiers[t.id]);
      emit(t.id, via ? { tier: t.tier, via } : { tier: t.tier });
      return { id: t.id, tier: t.tier };
    });
  });
}

function taskNote(ctx) {
  const text = ctx.pos.slice(1).join(' ').trim();
  if (!text) throw usage('task note needs the note text: tower-crane task note T1 "what happened"');
  const kind = ctx.flags.kind;
  if (kind !== undefined && kind !== 'scope-ruling') throw usage('task note --kind must be scope-ruling');
  const task = S.mutate(ctx, 'task note', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (kind) Authority.enforce(ctx, st, ['task.scope_ruling'], { emit });
    note(t, ctx.agent, text);
    if (kind) t.notes.at(-1).kind = kind;
    emit(t.id, { text, ...(kind ? { kind, revision: t.revision, review_after: t.evidence.length } : {}) });
    return t;
  });
  return { data: task.notes[task.notes.length - 1], text: `noted on ${task.id}` };
}

function describeTask(st, t, now) {
  const display = displayStatus(st, t, now);
  const out = {
    ...t,
    stack: require('./stack').effectiveStack(st, t),
    run: P.runPhase(st, t),
    display,
    lease_expired: leaseExpired(t, now),
    blocked_by: ['todo', 'rework'].includes(effectiveStatus(t, now)) ? blockReasons(st, t, now) : [],
    gates: t.sha ? gateReport(t, st.events, st) : null,
  };
  return out;
}

function taskShow(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const t = getTask(st, ctx.pos[0]);
  const d = describeTask(st, t, now);
  d.spend_by_rung = require('./escalation').spendByRung(t);
  const lines = [
    `${t.id}  ${t.title}`,
    `status: ${t.status}${t.status === 'accepted' && t.hotfix ? ' (hotfix)' : display(d)}  kind: ${t.kind}  size: ${t.size}  tier: ${t.tier}  priority: ${t.priority || 'normal'}  revision: ${t.revision}`,
  ];
  if (t.superseded_by) lines.push(`superseded by: ${t.superseded_by}`);
  if (t.tier_range) lines.push(`tier range: ${t.tier_range.min}..${t.tier_range.max}`);
  if (t.depends_on.length) {
    lines.push(`depends on: ${t.depends_on.map((id) => {
      const dep = st.tasks.tasks.find((x) => x.id === id);
      return `${id} (${dep ? dep.status : 'missing'})`;
    }).join(', ')}`);
  }
  if (t.needs_owner) lines.push(`needs owner: ${t.needs_owner}`);
  const capped = require('./escalation').respawnCapped(st, t);
  if (capped) {
    // Read from the log now: state never stores agent output.
    d.respawn_cap = { exits: capped.exits, cap: capped.cap, agents: capped.agents, log: capped.log, tail: P.logTail(capped.log) };
    lines.push(`last worker log: ${capped.log || '(none)'}`);
    if (capped.log) {
      lines.push(`  tail (last ${P.TAIL_LINES} lines, at most ${P.TAIL_BYTES} bytes):`,
        ...(d.respawn_cap.tail || '(empty)').split('\n').map((line) => `    ${line}`));
    }
  }
  if (t.needs.length) lines.push(`needs: ${t.needs.join(', ')}`);
  if (t.locks.length) lines.push(`locks: ${t.locks.join(', ')}`);
  if (t.environment) lines.push(`environment: ${t.environment}`);
  if (t.archive) lines.push(`archive: ${t.archive.path}, ${t.archive.files} files, ${t.archive.bytes} bytes (${t.archive.reason} ${shortTime(t.archive.at)})${t.archive.notice ? `; ${t.archive.notice}` : ''}`);
  if (t.archive_grants?.length) lines.push(`archive grants: ${t.archive_grants.join(', ')}`);
  if (t.broker_verbs?.length) lines.push(`broker verbs: ${t.broker_verbs.join(', ')} (tower-crane verb NAME --param KEY=VALUE)`);
  if (t.host_probes?.length) lines.push('host probes:', ...t.host_probes.map((cmd) => `  - ${cmd}`));
  if (t.ci_local != null) lines.push(`ci.local override: ${JSON.stringify(t.ci_local)}`);
  if (d.blocked_by.length) lines.push(`blocked: ${d.blocked_by.join('; ')}`);
  lines.push('acceptance:', ...t.acceptance.map((a) => `  - ${a}`));
  if (t.claim) lines.push(`claim: ${t.claim.agent} until ${shortTime(t.claim.until)}${d.lease_expired ? ' (expired)' : ''}`);
  if (d.run) lines.push(`phase: ${P.phaseText(d.run)}`);
  if (t.branch || t.pr || t.sha) lines.push(`branch: ${t.branch || '-'}  pr: ${t.pr ? `#${t.pr}` : '-'}  sha: ${t.sha || '-'}${t.submitted_by ? `  submitted by ${t.submitted_by}` : ''}`);
  if (d.stack) lines.push(`stack: after ${d.stack.parent}, PR base ${d.stack.base}, ${d.stack.linked ? 'linked' : 'pending link'}${t.stack_disabled ? ' (unavailable)' : ''}`);
  if (t.hotfix) lines.push(`hotfix: PR #${t.hotfix.pr} merged before its gates at ${t.hotfix.merge_sha}${t.hotfix.follow_up ? `; follow-up ${t.hotfix.follow_up}` : ''}`);
  if (t.github_stack != null) lines.push(`GitHub stack: ${JSON.stringify(t.github_stack)}`);
  if (d.gates) lines.push(`gates: ${d.gates.gates.map((g) => `${g.type} ${g.ok ? 'ok' : g.state || 'missing'}`).join(', ')}`);
  if (t.evidence.length) {
    lines.push('evidence:');
    for (const e of t.evidence) {
      const stale = e.revision !== t.revision ? ` (revision ${e.revision}, does not count)`
        : SOFTWARE_GATES.includes(e.type) && (!shaMatch(e.sha, t.sha) || !eligibleGateEvidence(t, e, st.events) || gatePolicyMismatch(t, e, st))
          || e.type === 'review' && !eligibleGateEvidence(t, e, st.events)
          ? ' (does not count)' : '';
      lines.push(`  - ${e.type} ${e.waived ? 'waived' : e.ok ? 'ok' : 'FAIL'} at ${e.sha ? e.sha.slice(0, 7) : '-'} by ${e.agent} ${shortTime(e.at)}${stale}${e.summary ? `: ${e.summary}` : ''}`);
      for (const c of Array.isArray(e.commands) ? e.commands : []) {
        const command = [c.command, ...(Array.isArray(c.args) ? c.args : [])].map((s) => JSON.stringify(s)).join(' ');
        lines.push(`    command: ${command} (cwd: ${c.cwd || '-'}, status: ${c.status ?? '-'}${c.signal ? `, signal: ${c.signal}` : ''})`);
      }
      if (e.type === 'verb' && e.verb) {
        lines.push(`    params: ${JSON.stringify(e.verb.params)}, ${e.verb.duration_ms} ms`,
          ...(e.verb.outputs || []).map((o) => `    output ${o.name}: ${o.sha256 ? `sha256 ${o.sha256}` : 'not written'}`));
      }
    }
  }
  if (t.notes.length) {
    lines.push('notes:');
    for (const n of t.notes) lines.push(`  - ${shortTime(n.at)} ${n.agent}: ${n.text}`);
  }
  lines.push(`spend: ${t.spend.minutes} min, ${t.spend.tokens} tokens${t.budget ? `  budget: ${[t.budget.hours != null ? `${t.budget.hours} h` : null, t.budget.tokens != null ? `${t.budget.tokens} tokens` : null].filter(Boolean).join(', ') || 'none'}` : ''}`);
  if (t.tier_range) for (const [rung, spend] of Object.entries(d.spend_by_rung)) lines.push(`  ${rung}: ${spend.tokens ?? 'unknown'} tokens, USD ${spend.cost_usd ?? 'unknown'}`);
  for (const l of liveSpend(t)) lines.push(`live spend: ${liveText(l)}`);
  const missing = missingUsage(t);
  if (missing) lines.push(`spawns without usage: ${missing}; retry tower-crane spend ${t.id} --from-spawn AGENT after telemetry is available`);
  return { data: d, text: lines.join('\n') };
}

function display(d) {
  if (d.lease_expired) return ' (lease expired)';
  if (d.display === 'ready' || d.display === 'blocked') return ` (${d.display})`;
  return '';
}

function taskList(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const want = ctx.flags.status;
  if (want !== undefined) checkEnum('status', want, [...S.STATUSES, 'ready', 'blocked']);
  const rows = [...st.tasks.tasks].sort(byId).filter((t) => {
    if (!want) return true;
    if (want === 'ready') return isReady(st, t, now);
    if (want === 'blocked') return ['todo', 'rework'].includes(effectiveStatus(t, now)) && blockReasons(st, t, now).length > 0;
    return t.status === want;
  });
  return {
    data: rows.map((t) => describeTask(st, t, now)),
    text: rows.length ? rows.map((t) => taskLine(st, t, now)).join('\n') : 'no tasks',
  };
}

const PLAN_FIELDS = ['id', 'title', 'acceptance', 'kind', 'needs', 'size', 'tier', 'depends_on', 'needs_owner', 'locks', 'environment'];

function planImport(ctx) {
  const file = ctx.pos[0];
  let raw;
  try {
    raw = file === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8');
  } catch (e) {
    throw refuse(`cannot read ${file} (${e.code || e.message})`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message})`);
  }
  if (!Array.isArray(plan) || !plan.length) throw refuse(`${file} must hold a non-empty JSON array of task objects`);
  const added = S.mutate(ctx, 'plan import', (st, emit) => {
    const local = new Map();
    const out = [];
    plan.forEach((entry, i) => {
      const where = `plan entry ${i + 1}${entry && entry.id ? ` (${entry.id})` : ''}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw refuse(`${where} must be an object`);
      const unknown = Object.keys(entry).filter((k) => !PLAN_FIELDS.includes(k));
      if (unknown.length) throw refuse(`${where}: unknown field ${unknown.join(', ')}; allowed: ${PLAN_FIELDS.join(', ')}`);
      if (typeof entry.title !== 'string' || !entry.title.trim()) throw refuse(`${where} needs a title`);
      const acceptance = asList(entry.acceptance);
      if (!acceptance.length) throw refuse(`${where} has no acceptance; every task needs at least one line saying how to tell it is done`);
      if (entry.kind !== undefined && !S.KINDS.includes(entry.kind)) throw refuse(`${where}: kind must be one of ${S.KINDS.join(', ')}`);
      const needs = entry.needs === undefined ? [] : taskNeeds(JSON.stringify(entry.needs));
      if (entry.size !== undefined && !S.SIZES.includes(entry.size)) throw refuse(`${where}: size must be one of ${S.SIZES.join(', ')}; split anything larger`);
      if (entry.tier !== undefined) checkTier(entry.tier, refuse);
      if (entry.needs_owner !== undefined && entry.needs_owner !== null && typeof entry.needs_owner !== 'string') {
        throw refuse(`${where}: needs_owner must be a string or null`);
      }
      if (entry.locks !== undefined && (!Array.isArray(entry.locks)
        || !entry.locks.every((lock) => typeof lock === 'string' && lock.trim()))) {
        throw refuse(`${where}: locks must be an array of non-empty resource names`);
      }
      if (entry.environment !== undefined && entry.environment !== null && typeof entry.environment !== 'string') {
        throw refuse(`${where}: environment must be a string or null`);
      }
      const name = entry.id === undefined ? null : String(entry.id);
      if (name !== null && (local.has(name) || st.tasks.tasks.some((t) => t.id === normId(name, 'T')))) {
        throw refuse(`${where}: id ${name} is already taken; give each plan entry a unique local name`);
      }
      const deps = asList(entry.depends_on).map((d) => {
        if (local.has(d)) return local.get(d);
        const tid = normId(d, 'T');
        if (st.tasks.tasks.some((t) => t.id === tid)) return tid;
        throw refuse(`${where}: unknown dependency ${d}; it must name an earlier plan entry or an existing task`);
      });
      const t = newTask(st, {
        title: entry.title.trim(), acceptance, kind: entry.kind, needs, size: entry.size, tier: entry.tier,
        depends_on: deps, needs_owner: entry.needs_owner ? entry.needs_owner : null, needs_owner_by: Authority.holdBy(ctx, st.events),
        locks: [...new Set(asList(entry.locks))], environment: entry.environment?.trim() || null,
      });
      if (name !== null) local.set(name, t.id);
      emit(t.id, { title: t.title, local: name });
      out.push({ id: t.id, local: name, title: t.title });
    });
    return out;
  });
  return { data: { added }, text: added.map((a) => `${a.id}${a.local ? ` (${a.local})` : ''}  ${a.title}`).join('\n') };
}

function briefSet(ctx) {
  const [id, dash] = ctx.pos;
  const file = ctx.flags.file;
  if ((file === undefined) === (dash !== '-')) throw usage('brief set needs exactly one source: --file F, or - to read stdin');
  let text;
  try {
    text = file !== undefined ? fs.readFileSync(path.resolve(ctx.cwd, file), 'utf8') : readStdin();
  } catch (e) {
    throw refuse(`cannot read ${file || 'stdin'} (${e.code || e.message})`);
  }
  const out = S.mutate(ctx, 'brief set', (st, emit) => {
    const t = getTask(st, id);
    const target = briefPath(st.dir, t.id);
    if (t.sha && (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text)) {
      if (t.status === 'accepted') {
        throw refuse(`${t.id} is accepted, so its brief cannot change; send it back first with tower-crane rework ${t.id} --reason R`);
      }
      t.revision = nextRevision(st, t);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    S.writeAtomic(target, text);
    emit(t.id, { bytes: Buffer.byteLength(text), revision: t.revision });
    return { id: t.id, path: target };
  });
  warnRoleSections(text);
  return { data: out, text: `brief for ${out.id} written to ${out.path}` };
}

function warnRoleSections(text) {
  if (B.hasSection(text, 'reviewer') && !B.hasSection(text, 'worker')) {
    process.stderr.write('tower-crane: brief has a ## Reviewer section without a ## Worker section\n');
  }
}

function briefGet(ctx) {
  const st = S.loadState(ctx.stateDir);
  const t = getTask(st, ctx.pos[0]);
  const file = briefPath(st.dir, t.id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw refuse(`${t.id} has no brief; write one with tower-crane brief set ${t.id} --file F`);
  }
  if (ctx.flags.role !== undefined) {
    const role = String(ctx.flags.role).trim().toLowerCase();
    if (!['worker', 'reviewer'].includes(role)) throw usage('--role must be worker or reviewer');
    text = B.forRole(text, role);
  } else {
    text = B.forRole(text, B.roleForAgent(ctx.agent));
  }
  return { data: { id: t.id, path: file, brief: text }, text: text.replace(/\n$/, ''), raw: true };
}

function planIssues(st) {
  const issues = [];
  const live = st.tasks.tasks.filter((t) => t.status !== 'cancelled');
  const ids = new Set(st.tasks.tasks.map((t) => t.id));
  for (const t of [...live].sort(byId)) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) issues.push({ task: t.id, kind: 'unknown-dependency', message: `${t.id} depends on ${d}, which does not exist` });
    }
    if (!t.acceptance.length) issues.push({ task: t.id, kind: 'no-acceptance', message: `${t.id} has no acceptance; add it with tower-crane task update ${t.id} --acceptance A` });
    if (t.size === 'L' && !t.notes.some((n) => /^split:/i.test(n.text.trim()))) {
      issues.push({ task: t.id, kind: 'unsplit', message: `${t.id} is size L; split it, or record why not with tower-crane task note ${t.id} "split: <reason>"` });
    }
  }
  for (const cyc of findCycles(st.tasks.tasks)) {
    issues.push({ task: cyc[0], kind: 'cycle', message: `dependency cycle ${cyc.join(' -> ')}` });
  }
  const b = st.project.budget;
  const planned = live.reduce((sum, t) => sum + SIZE_HOURS[t.size], 0);
  if (b.hours != null && planned > b.hours) {
    issues.push({ task: null, kind: 'budget', message: `planned work is about ${planned} h (S=1, M=4, L=8) against a budget of ${b.hours} h` });
  }
  const minutes = st.tasks.tasks.reduce((s, t) => s + t.spend.minutes, 0);
  const tokens = st.tasks.tasks.reduce((s, t) => s + t.spend.tokens, 0);
  if (b.hours != null && minutes / 60 > b.hours) issues.push({ task: null, kind: 'budget', message: `spend is ${round1(minutes / 60)} h, over the ${b.hours} h budget` });
  if (b.tokens != null && tokens > b.tokens) issues.push({ task: null, kind: 'budget', message: `spend is ${tokens} tokens, over the ${b.tokens} token budget` });
  issues.push(...logDrift(st));
  return issues;
}

// tasks.json and the append-only event log are written in one locked step, so
// a task or note the log records but tasks.json lacks was overwritten by a
// writer that did not hold the lock. A commit logs its events before it
// renames tasks.json, so a last_event the log lacks means the log lost them.
function logDrift(st) {
  const issues = [];
  const last = st.tasks.last_event;
  if (last && !st.events.findLast((e) => e.id === last)) {
    issues.push({ task: null, kind: 'log-drift', message: `tasks.json holds a change whose event ${last} is missing from events.jsonl; events.jsonl lost a write` });
  }
  const byId = new Map(st.tasks.tasks.map((t) => [t.id, t]));
  const missing = new Map();
  for (const e of st.events) {
    if (typeof e.task !== 'string' || !/^T\d+$/.test(e.task)) continue;
    const t = byId.get(e.task);
    if (!t) {
      if (!missing.has(e.task)) missing.set(e.task, e);
      continue;
    }
    if (e.cmd === 'task note' && e.detail && typeof e.detail.text === 'string'
      && !t.notes.some((n) => n.text === e.detail.text)) {
      issues.push({ task: t.id, kind: 'log-drift', message: `${t.id} is missing the note ${e.agent} logged at ${e.at} in events.jsonl; tasks.json lost a write` });
    }
  }
  for (const [id, e] of [...missing].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const title = e.detail && e.detail.title ? ` "${e.detail.title}"` : '';
    issues.push({ task: id, kind: 'log-drift', message: `${id}${title} is in events.jsonl (${e.cmd} by ${e.agent} at ${e.at}) but missing from tasks.json; tasks.json lost a write` });
  }
  const max = loggedTaskMax(st.events);
  if (st.tasks.next <= max) {
    issues.push({ task: null, kind: 'log-drift', message: `tasks.json next is ${st.tasks.next}, but events.jsonl already used T${max}; the next task add takes T${max + 1}` });
  }
  return issues;
}

const round1 = (n) => Math.round(n * 10) / 10;

function ladderWarnings(st, layers, env) {
  const warnings = [];
  for (const task of st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status))) {
    try {
      require('./reviewer').choose(st, task, layers, { lines: 0, files: [], binary: false }, env);
    } catch (e) {
      warnings.push({ task: task.id, kind: 'review-unavailable', message: e.message });
    }
  }
  return warnings;
}

// The program a route starts, or null when it is on this machine. A command
// template that names its program through a placeholder is known only at dispatch.
function missingProgram(route, env, cwd) {
  const program = route.harness === 'command' ? route.command?.[0] : route.harness;
  if (!program || route.harness === 'command' && /\{(task|brief|prompt|cwd|session)\}/.test(program)) return null;
  return require('./spawn').findExecutable(program, cwd, true, env) === null ? program : null;
}

// A valid plan can still be one this machine cannot run: no harness program
// for a worker or a reviewer, or no gh login for the PR every worker opens.
function harnessWarnings(st, layers, env, cwd) {
  const warnings = [];
  const missing = (name) => {
    const programs = L.routes(L.rungOf(layers, name)).map((route) => missingProgram(route, env, cwd));
    return programs.every(Boolean) ? [...new Set(programs)] : null;
  };
  const needs = (names) => names.map((name) => `${name} needs ${missing(name).join(' or ')}`).join(', ');
  const workers = L.TIERS.filter((name) => missing(name));
  if (workers.length === L.TIERS.length) {
    warnings.push({ task: null, kind: 'worker-harness', message: `no harness on PATH can run a worker: ${needs(workers)}` });
  } else {
    const open = st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status));
    const at = (tier) => L.TIERS.indexOf(tier);
    for (const name of workers) {
      const tasks = open.filter((t) => t.tier === name
        || t.tier_range && at(t.tier_range.min) <= at(name) && at(name) <= at(t.tier_range.max)).map((t) => t.id);
      if (tasks.length) warnings.push({ task: null, kind: 'worker-harness', message: `ladder ${name} cannot start a worker for ${tasks.join(', ')}: ${needs([name])} on PATH` });
    }
  }
  const reviewers = ['review', ...L.TIERS];
  if (reviewers.every((name) => missing(name))) {
    warnings.push({ task: null, kind: 'reviewer-harness', message: `no harness on PATH can run a reviewer: ${needs(reviewers)}` });
  }
  return warnings;
}

function ghWarnings(env, cwd) {
  const gh = cp.spawnSync('gh', ['auth', 'status'], {
    cwd, env: { ...process.env, ...env, GH_PROMPT_DISABLED: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (gh.error?.code === 'ENOENT') {
    return [{ task: null, kind: 'gh-auth', message: 'gh is not on PATH; workers open PRs with it: install the GitHub CLI and run gh auth login' }];
  }
  if (!gh.error && gh.status === 0) return [];
  // gh lists each host first; the line that names the failure says more.
  const lines = `${gh.stderr || ''}\n${gh.stdout || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /not logged|fail|invalid|expired|token|connect|resolve|network|timeout/i.test(l)) || lines[0];
  const why = gh.error ? (gh.error.code === 'ETIMEDOUT' ? 'timed out after 30 s' : gh.error.message) : said || `exit ${gh.status}`;
  // Offline, gh reports a stored token as invalid, so a failure here does not
  // prove the login is gone.
  return [{ task: null, kind: 'gh-auth', message: `gh auth status failed (${why}); workers open PRs with gh. If this machine is online, run gh auth login` }];
}

function validate(ctx) {
  // A reader without the lock can see a commit's events before its files.
  const st = S.lockedLoad(ctx.stateDir, 'validate');
  const issues = planIssues(st);
  // A ladder that cannot run is a broken plan: spawn would refuse it.
  let layers = null;
  try {
    layers = L.resolve(st.project, ctx.env);
    for (const e of L.check(st.project, ctx.env)) issues.push({ task: null, kind: 'ladder', message: e });
  } catch (e) {
    issues.push({ task: null, kind: 'ladder', message: e.message });
  }
  const cwd = ctx.cwd || process.cwd();
  const warnings = [...layers ? [...ladderWarnings(st, layers, ctx.env), ...harnessWarnings(st, layers, ctx.env, cwd)] : [], ...ghWarnings(ctx.env, cwd)];
  const lines = issues.length ? issues.map((i) => i.message) : [`plan ok: ${st.tasks.tasks.length} tasks`];
  return {
    data: { ok: issues.length === 0, issues, warnings },
    text: [...lines, ...warnings.map((w) => `warning: ${w.message}`)].join('\n'),
    code: issues.length ? 1 : 0,
  };
}

// ---- Run ----

function ready(ctx) {
  const st = S.loadState(ctx.stateDir);
  const now = Date.now();
  const r = readyTasks(st, now);
  const data = {
    ready: r.map(({ task, unblocks }) => ({ id: task.id, title: task.title, kind: task.kind, size: task.size, tier: task.tier, priority: task.priority || 'normal', locks: task.locks, environment: task.environment, status: effectiveStatus(task, now), unblocks })),
    exited_claims: P.exitedClaims(st),
  };
  const lines = r.length
    ? r.map(({ task, unblocks }) => `${task.id.padEnd(5)} ${task.size} ${task.kind.padEnd(8)} ${task.title}${task.priority === 'urgent' ? '  [urgent]' : ''}${unblocks ? `  (unblocks ${unblocks})` : ''}${effectiveStatus(task, now) === 'rework' ? '  [rework]' : ''}`)
    : ['no task is ready'];
  if (ctx.flags.all) {
    const b = blockedTasks(st, now);
    data.blocked = b.map(({ task, reasons }) => ({ id: task.id, title: task.title, reasons }));
    if (b.length) lines.push('', 'blocked:', ...b.map(({ task, reasons }) => `${task.id.padEnd(5)} ${task.title}: ${reasons.join('; ')}`));
  }
  lines.push(...P.exitLines(data.exited_claims));
  return { data, text: lines.join('\n') };
}

function leaseMinutes(ctx, st) {
  const lease = ctx.flags.lease !== undefined ? ctx.flags.lease : st.project.limits.lease_minutes;
  if (lease < 1) throw usage('--lease must be at least 1 minute');
  return lease;
}

function claimReadiness(st, task, now, agent) {
  if (task.status === 'in_progress' && !leaseExpired(task, now)) {
    if (task.claim.agent !== agent) {
      throw refuse(`${task.id} is claimed by ${task.claim.agent} until ${shortTime(task.claim.until)}; pick another task from tower-crane ready`);
    }
    return task.claim.from || 'todo';
  }
  const effective = effectiveStatus(task, now);
  if (effective !== 'todo' && effective !== 'rework') {
    throw refuse(`${task.id} is ${effective}; only todo or rework tasks can be claimed`);
  }
  checkReady(st, task, now, 'the workers limit is reached', agent);
  return effective;
}

// A removal marks its task while it runs. The marker belongs to the process
// that wrote it; one left by a process that exited is what a crash left, and
// holds nothing.
function isRetiring(t) {
  return !!t.retiring && P.processState(t.retiring) !== 'exited';
}

function retirementHolder(st, t, { branch = t.worktree?.branch || t.branch, path = t.worktree?.path } = {}) {
  const task = st.tasks.tasks.find((other) => isRetiring(other) && (other.id === t.id
    || branch && branch === (other.retiring.branch || other.worktree?.branch || other.branch)
    || path && path === (other.retiring.path || other.worktree?.path)));
  if (task) return task;
  const orphan = (st.tasks.orphan_retirements || []).find((reservation) => isRetiring({ retiring: reservation })
    && (branch && branch === reservation.branch || path && path === reservation.path));
  return orphan ? { id: 'orphan cleanup', retiring: orphan } : null;
}

function claim(ctx) {
  // A spawned worker's gh is limited by its agent file, so GitHub is read on the
  // engine side: spawn checks the dispatched task's stacks before dispatch and that
  // worker's claim reads the record. Any other claim reads GitHub here.
  const dispatched = !!ctx.env.TOWER_CRANE_HOOK && ctx.env.TOWER_CRANE_TASK === ctx.pos[0] && ctx.env.TOWER_CRANE_AGENT === ctx.agent;
  if (!dispatched) require('./stack').refreshReadiness(ctx, ctx.pos[0]);
  const task = S.mutate(ctx, 'claim', (st, emit) => {
    const now = Date.now();
    const t = getTask(st, ctx.pos[0]);
    if (P.interruptHeld(st, t, now)) {
      throw refuse(`${t.id}'s interrupted supervisor is still stopping; wait for its exit or one lease, then claim again`);
    }
    const retiring = retirementHolder(st, t);
    if (retiring) throw refuse(`${t.id}'s worktree is being removed for ${retiring.id}; claim it once the removal ends`);
    const lease = leaseMinutes(ctx, st);
    const eff = claimReadiness(st, t, now, ctx.agent);
    if (t.status === 'in_progress' && !leaseExpired(t, now)) {
      t.claim.until = new Date(now + lease * 60000).toISOString();
      emit(t.id, { until: t.claim.until, from: t.claim.from, renewed: true });
      return t;
    }
    grantClaim(t, emit, ctx.agent, eff, lease, now);
    return t;
  });
  return { data: task, text: `claimed ${task.id} for ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

// A new lease for agent once claim's checks have passed; eff is the status it replaces.
function grantClaim(t, emit, agent, eff, lease, now) {
  const previous = t.status === 'in_progress' ? t.claim.agent : null;
  t.claim = { agent, since: new Date(now).toISOString(), until: new Date(now + lease * 60000).toISOString(), from: eff };
  t.status = 'in_progress';
  emit(t.id, { until: t.claim.until, from: eff, ...(previous ? { took_over_from: previous } : {}) }, 'claim', agent);
}

// The unclaimed worker reservations still holding a slot, from the event log
// alone. Each carries the process identity its latest monitor record named.
// History snapshots stay unchanged between appends; expiry still uses the current clock.
const reservationCache = new WeakMap();

function reservations(st, now) {
  const horizon = st.project.limits.lease_minutes * 60000;
  const cached = reservationCache.get(st.events);
  if (cached && cached.length === st.events.length && cached.horizon === horizon) {
    return cached.slots.filter((slot) => slot.until > now).map((slot) => ({ ...slot, proc: { ...slot.proc } }));
  }
  const pending = new Map();
  const key = (e) => JSON.stringify([e.task, e.detail.agent, e.detail.attempt]);
  const proc = (d) => ({ host: d.host, pid: d.pid, start_ticks: d.start_ticks, monitor_pid: d.monitor_pid, monitor_start_ticks: d.monitor_start_ticks,
    ...(typeof d.pidns === 'string' ? { pidns: d.pidns } : {}) });
  // A worker claims within minutes; a reservation unclaimed for a whole lease
  // since its monitor last wrote, or past a scheduled backoff, cannot belong to
  // a live dispatch. Once lapsed it stays lapsed: another holder may have
  // taken the slot.
  for (const e of st.events) {
    // Spawns recorded before reservations existed carry no marker and hold nothing.
    if (e.cmd === 'spawn' && e.detail.role === 'worker' && e.detail.reserved === true && !e.detail.claim_since) {
      pending.set(key(e), { task: e.task, agent: e.detail.agent, attempt: e.detail.attempt, proc: proc(e.detail), until: Date.parse(e.at) + horizon });
    } else if (e.cmd === 'interrupt' && e.detail.role === 'worker' && e.detail.active) {
      // Clearing the lease cannot free the slot before supervised cleanup ends.
      pending.set(key(e), { task: e.task, agent: e.detail.agent, attempt: e.detail.attempt, proc: proc(e.detail), until: Date.parse(e.at) + horizon });
    } else if (e.cmd === 'claim') {
      for (const [id, slot] of pending) {
        if (slot.task === e.task && slot.agent === (e.detail.holder || e.agent)) pending.delete(id);
      }
    } else if (e.cmd === 'reservation clear') {
      // Spawn records this only after probing the reservation's processes under the lock.
      pending.delete(key(e));
    } else if (['spawn retry', 'spawn fallback', 'spawn phase'].includes(e.cmd) && pending.has(key(e))) {
      // Session receipts replay an earlier attempt's detail, so only the
      // monitor's own records move the pid or the horizon.
      const slot = pending.get(key(e));
      // The monitor records active false once the attempt is over with no retry pending.
      if (e.detail.active === false || Date.parse(e.at) >= slot.until) pending.delete(key(e));
      else {
        const backoff = e.cmd === 'spawn phase' && Number.isFinite(e.detail.backoff_ms) ? e.detail.backoff_ms : 0;
        Object.assign(slot, { proc: e.detail.pid === undefined ? slot.proc : proc(e.detail), until: Math.max(slot.until, Date.parse(e.at) + backoff + horizon) });
      }
    } else if (['spawn exit', 'worker-exited'].includes(e.cmd)) {
      const spawn = P.exitSpawn(e, st.events);
      if (spawn && pending.get(key(spawn))?.proc.pid === e.detail.pid) pending.delete(key(spawn));
    }
  }
  const slots = [...pending.values()];
  reservationCache.set(st.events, { slots, length: st.events.length, horizon });
  return slots.filter((slot) => slot.until > now).map((slot) => ({ ...slot, proc: { ...slot.proc } }));
}

// Every observer reads the same holders from the event log: a sandboxed
// claimer cannot see peer pids, so claim never probes. Spawn clears gone
// reservations with a recorded event before it counts.
function workerHolders(st, now) {
  // An unfamiliar status cannot release an existing lease while its worker
  // may still be finishing an edit without supervision.
  const holders = st.tasks.tasks.filter((t) => t.claim
    && (t.status === 'in_progress' || !S.STATUSES.includes(t.status))
    && !(Date.parse(t.claim.until) <= now))
    .map((t) => ({ task: t.id, agent: t.claim.agent, kind: 'lease' }));
  for (const slot of reservations(st, now)) {
    if (holders.some((h) => h.task === slot.task && h.agent === slot.agent)) continue;
    holders.push({ task: slot.task, agent: slot.agent, kind: 'reservation' });
  }
  return holders;
}

function lockReasons(st, t, now, agent) {
  if (!t.locks.length) return [];
  const tasks = new Map(st.tasks.tasks.map((task) => [task.id, task]));
  return workerHolders(st, now)
    .filter((h) => h.task !== t.id || (agent !== undefined && h.agent !== agent))
    .flatMap((h) => (tasks.get(h.task)?.locks || [])
      .filter((lock) => t.locks.includes(lock))
      .map((lock) => `lock ${lock} held by ${h.task} (${h.agent}, ${h.kind})`));
}

// Called under the state lock; only the same task and agent can reuse a slot.
function checkWorkers(st, t, now, lead, agent) {
  const reasons = lockReasons(st, t, now, agent);
  if (reasons.length) throw refuse(`${t.id} is blocked: ${reasons.join('; ')}`);
  const holders = workerHolders(st, now).filter((h) => h.task !== t.id || h.agent !== agent);
  if (holders.length >= st.project.limits.workers) {
    const names = holders.map((h) => `${h.task} (${h.agent}, ${h.kind})`).join(', ');
    throw refuse(`${lead} (${holders.length} worker slots held, limit ${st.project.limits.workers}); holders: ${names}; wait for one to finish or raise it with tower-crane project set --workers N`);
  }
}

// The readiness and capacity checks a claim and an expired-lease renewal share.
function checkReady(st, t, now, lead, agent) {
  requireSupportedTask(t, st);
  const reasons = blockReasons(st, t, now);
  if (reasons.length) throw refuse(`${t.id} is blocked: ${reasons.join('; ')}`);
  checkWorkers(st, t, now, lead, agent);
}

function requireClaimant(t, agent, verb) {
  requireSupportedTask(t);
  if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress; claim it with tower-crane claim ${t.id}`);
  if (t.claim.agent !== agent) throw refuse(`only the claimant (${t.claim.agent}) can ${verb} ${t.id}; you are ${agent}`);
}

function renew(ctx) {
  const task = S.mutate(ctx, 'renew', (st, emit) => {
    const now = Date.now();
    const t = getTask(st, ctx.pos[0]);
    requireClaimant(t, ctx.agent, 'renew');
    if (ctx.claimSince !== undefined && t.claim.since !== ctx.claimSince) throw refuse(`${t.id}'s claim was replaced`);
    // An expired lease stopped counting toward the limit and may have lost its
    // readiness, so renewing it takes a slot back and passes the claim checks.
    if (leaseExpired(t, now)) checkReady(st, t, now, `${t.id}'s lease expired and the workers limit is reached`, ctx.agent);
    t.claim.until = new Date(now + leaseMinutes(ctx, st) * 60000).toISOString();
    emit(t.id, { until: t.claim.until });
    return t;
  });
  return { data: task, text: `${task.id} held by ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

// The PR a claim opened, checked as submit checks one. Read before the state lock, as submit reads its PR.
function releasePullRequest(ctx, pr) {
  if (pr < 1) throw usage('--pr must be a pull request number');
  const before = S.loadState(ctx.stateDir);
  const pullRequest = inspectPullRequest(ctx, before.project, pr);
  if (pullRequest.state !== 'OPEN') throw refuse(`PR #${pr} is ${pullRequest.state.toLowerCase()}; only an open PR can be linked when a claim is released`);
  const t = getTask(before, ctx.pos[0]);
  // As submit does, a task moves to a new PR only once the PR it records is closed or merged.
  if (t.pr && t.pr !== pr && inspectPullRequest(ctx, before.project, t.pr).state === 'OPEN') {
    throw refuse(`${t.id} is already linked to open PR #${t.pr}; release it with --pr ${t.pr} or close PR #${t.pr} before linking PR #${pr}`);
  }
  return { headRefName: pullRequest.headRefName, previous: { pr: t.pr, branch: t.branch } };
}

// Whether the task's latest release was for a decision that blocked it, answered or not.
function releasedForDecision(st, t) {
  const last = st.events.findLast((e) => e.task === t.id && e.cmd === 'release');
  return !!last?.detail.decisions?.length;
}

function release(ctx) {
  if (ctx.flags.dead) return require('./actions').release(ctx);
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('release needs --reason so the next agent knows why');
  const pr = ctx.flags.pr;
  const pullRequest = pr === undefined ? null : releasePullRequest(ctx, pr);
  const task = S.mutate(ctx, 'release', (st, emit, commit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress`);
    if (pullRequest) {
      // The PR was read before the lock; a change since then refuses, as submit refuses it.
      if (t.pr !== pullRequest.previous.pr || t.branch !== pullRequest.previous.branch) throw refuse(`${t.id}'s PR or branch changed while checking GitHub; retry the release`);
      const moving = !!t.pr && t.pr !== pr;
      if (!moving && t.branch && t.branch !== pullRequest.headRefName) throw refuse(`${t.id} is on branch "${t.branch}", but PR #${pr} has head branch "${pullRequest.headRefName}"`);
    }
    const exited = P.exitedClaims(st, st.events, { includeTail: false }).find((c) => c.id === t.id);
    if (ctx.deadOnly && !exited) throw refuse(`${t.id}: claim is no longer verified exited`);
    if (ctx.deadOnly && ctx.requireExitCleanup) {
      const blocked = require('./escalation').releaseBlocker(ctx, st, t);
      if (blocked) throw refuse(`${t.id}: ${blocked}`);
    }
    // Two live workers on one task is worse than a stuck one, so only the owner judges a process it cannot see exit.
    if (t.claim.agent !== ctx.agent && !exited) {
      try {
        Authority.enforce(ctx, st, ['claim.release'], { change: { release: t.id, holder: t.claim.agent, claim_since: t.claim.since }, emit, commit });
      } catch (e) {
        // A board request from the owner opened a decision; the board shows it.
        if (e.decision) throw e;
        throw refuse(`only the claimant (${t.claim.agent}) or the owner can release ${t.id} while its spawned process has not been verified exited: ${e.message}`);
      }
    }
    const recovery = exited ? { pid: exited.pid, log: exited.log, code: exited.code, size: exited.size } : null;
    // A release while a question blocks the task is a release for that decision; rework may send such a task back.
    const decisions = openDecisionsFor(st, t.id).map((d) => d.id);
    const holder = t.claim.agent;
    // Linking follows the authority check: a refused escalation still commits the state it was given.
    if (pullRequest) {
      // A submitted sha belongs to the PR the task had, so a new PR resumes from its own head on origin.
      // A sha submitted without a PR is on the task's branch, so it stays.
      if (t.pr && t.pr !== pr) t.sha = null;
      t.pr = pr;
      t.branch = pullRequest.headRefName;
    }
    t.status = t.claim.from || 'todo';
    t.claim = null;
    note(t, ctx.agent, `released claim held by ${holder}: ${reason}`);
    if (pullRequest) note(t, ctx.agent, `linked PR #${pr} on branch ${t.branch}`);
    if (recovery) note(t, ctx.agent, `exited spawn: pid ${recovery.pid}; log: ${recovery.log || '(none)'}; exit code: ${recovery.code ?? 'unknown'}; size: ${recovery.size ?? 'unknown'} bytes`);
    emit(t.id, { reason, holder, status: t.status, ...(decisions.length ? { decisions } : {}), ...(recovery ? { exited_spawn: recovery } : {}) });
    return t;
  });
  return { data: task, text: `released ${task.id}; it is ${task.status} again` };
}

function interruptClaim(ctx, st, emit, t, reason, claim = t.claim, audit = true, hold = null) {
  // Replacing an existing owner ask is its own guarded change.
  const settings = ['task.interrupt', ...(hold && t.needs_owner && t.needs_owner !== hold ? ['task.needs_owner'] : [])];
  Authority.enforce(ctx, st, settings, { emit: audit ? emit : null, quiet: !audit });
  if (!claim) throw refuse(`${t.id} is ${t.status}, not in progress`);
  const run = P.runPhase(st, { ...t, status: 'in_progress', claim });
  t.status = t.status === 'cancelled' ? 'cancelled' : claim.from || 'todo';
  t.claim = null;
  if (hold && hold !== t.needs_owner) {
    t.needs_owner = hold;
    t.needs_owner_by = Authority.holdBy(ctx, st.events);
  }
  note(t, ctx.agent, `interrupted claim held by ${claim.agent}: ${reason}`);
  const active = run?.active !== false && !!run?.monitor_pid && P.processState(P.monitorProcess(run)) !== 'exited';
  emit(t.id, { ...(run || {}), holder: claim.agent, claim, status: t.status, revision: t.revision, reason,
    phase: active ? 'stopping' : 'stopped', active, ...(hold ? { needs_owner: hold } : {}) }, 'interrupt');
}

// A waiting owner holds no claim. Its supervisor stops it on this record as
// on a claimed run's, and the task keeps its status: the ownership ends, and
// the next failure goes the respawn path.
function interruptOwner(ctx, st, emit, t, owner, reason, hold) {
  const settings = ['task.interrupt', ...(hold && t.needs_owner && t.needs_owner !== hold ? ['task.needs_owner'] : [])];
  Authority.enforce(ctx, st, settings, { emit });
  if (hold && hold !== t.needs_owner) {
    t.needs_owner = hold;
    t.needs_owner_by = Authority.holdBy(ctx, st.events);
  }
  const attempt = owner.spawn.detail.attempt;
  const run = st.events.findLast((e) => ['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && e.task === t.id
    && e.detail.agent === owner.agent && e.detail.attempt === attempt)?.detail || owner.spawn.detail;
  const active = !!run.monitor_pid && P.processState(P.monitorProcess(run)) !== 'exited';
  note(t, ctx.agent, `interrupted the owning worker ${owner.agent}: ${reason}`);
  emit(t.id, { ...run, holder: owner.agent, claim: null, owner: true, status: t.status, revision: t.revision, reason,
    phase: active ? 'stopping' : 'stopped', active, ...(hold ? { needs_owner: hold } : {}) }, 'interrupt');
}

function interrupt(ctx) {
  const raw = ctx.flags['needs-owner'];
  const hold = raw === undefined ? null : String(raw).trim();
  if (hold === '') throw usage('--needs-owner needs the reason the owner reads');
  let owner = null;
  const task = S.mutate(ctx, 'interrupt', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    owner = t.claim ? null : require('./ownership').state(st, t);
    if (owner?.phase === 'waiting') {
      interruptOwner(ctx, st, emit, t, owner, hold || 'owner interrupted', hold);
      return t;
    }
    // The ask lands in the write that releases the claim, so no dispatch can
    // claim the task between the stop and the hold.
    interruptClaim(ctx, st, emit, t, hold || 'dispatch interrupted', t.claim, true, hold);
    return t;
  });
  if (owner?.phase === 'waiting') {
    return { data: task, text: `interrupted ${task.id}'s owner ${owner.agent}; ${task.id} stays ${task.status}, and a failure dispatches a new worker${hold ? `; it waits on the owner until owner-done ${task.id}` : ''}` };
  }
  return { data: task, text: `interrupted ${task.id}; claim released, revision ${task.revision} and worktree kept${hold ? `; it waits on the owner until owner-done ${task.id}` : ''}` };
}

// For the state broker the worktree and its repository's config are the
// agent's, so gh names the repository and has none to run git in.
function inspectPullRequest(ctx, project, pr) {
  const brokered = !!S.via(ctx).via;
  if (brokered && !project.repo) throw refuse(`checking PR #${pr} for a sandboxed agent needs the project's repo; ask the owner to run tower-crane project set --repo OWNER/REPO`);
  const args = ['pr', 'view', String(pr)];
  if (project.repo) args.push('-R', project.repo);
  args.push('--json', 'state,headRefName');
  const result = cp.spawnSync('gh', args, {
    cwd: brokered ? ctx.stateDir : ctx.cwd,
    env: { ...process.env, ...ctx.env, GH_PROMPT_DISABLED: '1', ...(brokered ? { GIT_DIR: path.join(ctx.stateDir, 'no-repository') } : {}) },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    let detail;
    if (result.error?.code === 'ENOENT') detail = 'gh not found on PATH; install the GitHub CLI and run gh auth login';
    else if (result.error?.code === 'ETIMEDOUT') detail = 'timed out after 60 seconds';
    else {
      detail = String(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim();
      if (!detail) detail = `exit ${result.status}`;
    }
    throw refuse(`could not check existing PR #${pr} before submitting: ${detail}`);
  }
  let pullRequest;
  try {
    pullRequest = JSON.parse(result.stdout);
  } catch (e) {
    throw refuse(`could not read gh pr view ${pr} output: ${e.message}`);
  }
  if (!pullRequest || !['OPEN', 'CLOSED', 'MERGED'].includes(pullRequest.state)
    || (pullRequest.state === 'OPEN' && (typeof pullRequest.headRefName !== 'string' || !pullRequest.headRefName))) {
    throw refuse(`could not read state and head branch from gh pr view ${pr} output`);
  }
  return pullRequest;
}

function resolveSubmitSha(ctx, input) {
  if (!input) throw usage('submit needs --sha with the commit to review');
  if (!SHA_RE.test(input)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${input}"`);
  if (FULL_SHA_RE.test(input)) return input.toLowerCase();
  if (S.via(ctx).via === 'broker') {
    // Git reads agent-controlled configuration, so resolve inside the sandbox before forwarding.
    throw refuse('sandboxed submit needs a full commit sha; run submit through the worker CLI');
  }
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) throw refuse('submit needs the task repository to resolve its commit');
  const opts = { cwd: repo.root, env: ctx.env, encoding: 'utf8', timeout: 60000, windowsHide: true };
  const resolve = () => cp.spawnSync('git', ['rev-parse', '--verify', `${input.toLowerCase()}^{commit}`], opts);
  let resolved = resolve();
  if (resolved.status !== 0) {
    const task = getTask(S.loadState(ctx.stateDir), ctx.pos[0]);
    const branch = ctx.flags?.branch || task.branch;
    if (branch) {
      cp.spawnSync('git', ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], opts);
      resolved = resolve();
    }
  }
  const sha = resolved.stdout?.trim();
  if (resolved.status !== 0 || !FULL_SHA_RE.test(sha || '')) {
    throw refuse(`cannot resolve "${input}" to a unique commit in ${repo.root}`);
  }
  return sha;
}

// The PR's checks at the submitted head, judged as `check ci` judges them (lib/gates/ci.js).
async function submitChecks(ctx, f, sha) {
  const CI = require('./gates/ci');
  const st = S.loadState(ctx.stateDir);
  const task = getTask(st, ctx.pos[0]);
  // A brokered agent's worktree holds its own git config, so gh runs from the state directory
  // with no repository for git, as inspectPullRequest does.
  const brokered = !!S.via(ctx).via;
  const gateCtx = { ...ctx, root: brokered ? ctx.stateDir : ctx.cwd,
    ghEnv: brokered ? { GIT_DIR: path.join(ctx.stateDir, 'no-repository') } : undefined };
  const pr = f.pr ?? task.pr;
  const { refusal, report, pending, findings } = await CI.submitReport(gateCtx, st.project, {
    sha, pr, taskId: task.id,
  });
  if (refusal) throw refuse([refusal, report].filter(Boolean).join('\n'));
  // Revuto's [P1]/[P2] findings already on the PR refuse as review ok would refuse them, so the head
  // does not cost a reviewer and a rework round. Submit does not wait for findings still to come.
  const R = require('./reviewer');
  const blocking = R.unaddressed(await R.markChanged(ctx, S.findRepo(ctx.stateDir, ctx.cwd)?.root, findings || [], sha));
  if (blocking.length) {
    const unreadable = blocking.filter((x) => x.unreadable);
    const fetchHint = unreadable.length
      ? `git could not read the commit ${unreadable.length === 1 ? 'that finding was' : 'those findings were'} left on (${unreadable.map((x) => `comment ${x.id} at ${String(x.commit).slice(0, 10)}`).join(', ')}), so ${unreadable.length === 1 ? 'its path counts' : 'their paths count'} as unchanged. Fetch the PR's earlier heads with git fetch origin, or close the finding with tower-crane ci resolve.` : '';
    throw refuse([`revuto's ${blocking.length === 1 ? 'finding' : 'findings'} ${blocking.map((x) => `[${x.severity}] ${x.path}:${x.line} (comment ${x.id})`).join(', ')} on PR #${pr} ${blocking.length === 1 ? 'has' : 'have'} no code change at ${blocking.length === 1 ? 'its path' : 'their paths'} since the comment and no [resolved] reply, so review ok would refuse ${blocking.length === 1 ? 'it' : 'them'}. Fix each at its path, or close it with tower-crane ci resolve <comment id> --agent <name> --reason "<the fix and where, or why it does not apply>", then submit again.`, fetchHint, report].filter(Boolean).join('\n'));
  }
  return { report, pending };
}

async function submit(ctx) {
  const f = ctx.flags;
  const beforeFix = S.loadState(ctx.stateDir);
  const bodyFix = beforeFix.events.findLast((e) => e.cmd === 'spawn' && e.task === ctx.pos[0]
    && e.detail.agent === ctx.agent);
  if (bodyFix?.detail.body_fix && getTask(beforeFix, ctx.pos[0]).status === 'submitted') {
    throw refuse('PR-body repair cannot submit commits; exit after editing the PR body');
  }
  const probes = f['host-probe'] ?? [];
  if (!Array.isArray(probes) || !probes.every((cmd) => typeof cmd === 'string' && cmd.trim() && !cmd.includes('\0'))) {
    throw usage('--host-probe must be a non-blank command without NUL bytes');
  }
  const hostProbes = probes.map((cmd) => cmd.trim());
  const sha = resolveSubmitSha(ctx, f.sha);
  if (getTask(S.loadState(ctx.stateDir), ctx.pos[0]).hotfix) throw refuse('a recorded hotfix keeps its merge commit; submit its follow-up task instead');
  if (f.pr !== undefined && f.pr < 1) throw usage('--pr must be a pull request number');
  if (f.precheck !== undefined && !PRECHECKS.includes(f.precheck)) throw usage(`--precheck must be pass, fail or skipped, got "${f.precheck}"`);
  let previousPr;
  let previousBranch;
  let previousTaskId;
  let submittedBranch = f.branch;
  const branchOrPrSupplied = f.branch !== undefined || f.pr !== undefined;
  if (branchOrPrSupplied) {
    const before = S.loadState(ctx.stateDir);
    const previousTask = getTask(before, ctx.pos[0]);
    previousTaskId = previousTask.id;
    previousPr = previousTask.pr;
    previousBranch = previousTask.branch;
    if (previousPr) {
      const oldPullRequest = inspectPullRequest(ctx, before.project, previousPr);
      const submittedPr = f.pr === undefined ? previousPr : f.pr;
      const prChanged = submittedPr !== previousPr;
      if (oldPullRequest.state === 'OPEN' && prChanged) {
        const branch = f.branch === undefined ? '' : ` and branch "${f.branch}"`;
        throw refuse(`${previousTask.id} already has open PR #${previousPr} from branch "${oldPullRequest.headRefName}"; refusing PR #${submittedPr}${branch}. Close PR #${previousPr} before changing the PR`);
      }
      if (oldPullRequest.state === 'OPEN' && f.branch !== undefined && f.branch !== oldPullRequest.headRefName) {
        throw refuse(`${previousTask.id} already has open PR #${previousPr} from branch "${oldPullRequest.headRefName}"; refusing submitted branch "${f.branch}". Reuse that branch or close PR #${previousPr} before submitting a new branch`);
      }
      if (prChanged) {
        const newPullRequest = inspectPullRequest(ctx, before.project, submittedPr);
        if (typeof newPullRequest.headRefName !== 'string' || !newPullRequest.headRefName) {
          throw refuse(`could not read head branch from new PR #${submittedPr}`);
        }
        if (f.branch !== undefined && f.branch !== newPullRequest.headRefName) {
          throw refuse(`${previousTask.id} PR #${submittedPr} has head branch "${newPullRequest.headRefName}"; submitted branch "${f.branch}" does not match the new PR`);
        }
        submittedBranch = newPullRequest.headRefName;
      }
    }
  }
  const ci = await submitChecks(ctx, f, sha);
  const submitted = submittedDiff(ctx, sha);
  const placeholders = submitPlaceholders(submitted);
  if (placeholders.length) throw refuse(`${sha.slice(0, 7)} adds ${placeholders.join(', ')} as empty files, which claude's sandbox leaves as placeholders; remove them from the branch, or give a real file by that name content, and submit again`);
  const scope = submitScope(submitted);
  const task = S.mutate(ctx, 'submit', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (branchOrPrSupplied && (t.pr !== previousPr || t.branch !== previousBranch)) {
      throw refuse(`${previousTaskId}'s branch or PR changed while checking GitHub; retry the submit`);
    }
    if (t.status === 'submitted') {
      // Submission clears the lease, so submitted_by preserves who may replace the head.
      if (t.submitted_by !== ctx.agent) throw refuse(`only the submitter (${t.submitted_by}) can resubmit ${t.id}; you are ${ctx.agent}`);
    } else {
      requireClaimant(t, ctx.agent, 'submit');
    }
    const retiring = retirementHolder(st, t, { branch: submittedBranch ?? t.branch });
    if (retiring) throw refuse(`${t.id}'s branch is being removed for ${retiring.id}; submit after the removal ends`);
    const previousSha = t.sha;
    const previousClaim = t.claim;
    const owner = require('./ownership').claimable(st, t, ctx.agent);
    const previousRevision = t.revision;
    const probesChanged = shaMatch(previousSha, sha) && !isDeepStrictEqual(t.host_probes ?? [], hostProbes);
    // Leases and failed verdicts use the revision too, so a new list must retire the whole old run.
    if (probesChanged) t.revision = nextRevision(st, t);
    t.status = 'submitted';
    t.sha = sha;
    t.host_probes = hostProbes;
    if (submittedBranch !== undefined) t.branch = submittedBranch;
    if (t.worktree && t.worktree.branch === t.branch) t.worktree.head = t.sha;
    if (f.pr !== undefined) t.pr = f.pr;
    t.submitted_by = ctx.agent;
    t.claim = null;
    if (f.summary) note(t, ctx.agent, `submitted: ${f.summary}`);
    if (scope?.outside?.length) note(t, ctx.agent, Scope.line(scope));
    if (ci.pending) note(t, ctx.agent, `submitted with CI pending: ${ci.pending.join(', ')}`);
    const spawned = st.events.some((e) => e.cmd === 'spawn' && e.task === t.id && e.detail.agent === ctx.agent);
    emit(t.id, { previous_sha: previousSha, sha: t.sha, branch: t.branch, pr: t.pr, host_probes: t.host_probes, summary: f.summary || null,
      ...(probesChanged ? { previous_revision: previousRevision, revision: t.revision } : {}),
      ...(f.precheck !== undefined ? { precheck: f.precheck } : {}),
      ...(spawned && previousClaim ? { claim: previousClaim } : {}), scope,
      ...(owner.own ? { own: true } : owner.refused ? { own: false, own_refused: owner.refused } : {}) });
    return { ...t, own: owner };
  });
  const { own, ...done } = task;
  const owning = own.own ? `you own ${done.id}'s PR until it is done: run tower-crane wait --own --timeout SEC and fix what it hands back`
    : own.refused ? `${own.refused}: exit after this submit; a failure dispatches a new worker` : null;
  return { data: { ...done, scope, ci_report: ci.report || null, own: !!own.own },
    text: [`submitted ${done.id} at ${done.sha.slice(0, 7)}`, Scope.line(scope), ci.report, owning].filter(Boolean).join('\n') };
}

// The submitted diff, read before the state lock: null without a task,
// { error } when git cannot read it.
function submittedDiff(ctx, sha) {
  let st;
  let task;
  try {
    st = S.loadState(ctx.stateDir);
    task = getTask(st, ctx.pos[0]);
  } catch {
    return null;
  }
  const repo = S.findRepo(ctx.stateDir, ctx.cwd);
  if (!repo) return { error: 'no repository to read the diff from' };
  try {
    const project = { ...st.project, base: require('./stack').targetBase(st, task) };
    return { st, task, repo, diff: require('./reviewer').diffOf(repo, project, { ...task, sha }) };
  } catch (e) {
    return { error: e.message };
  }
}

// Empty placeholder files the submitted commits add, as claude's sandbox
// leaves them. A diff git cannot read refuses nothing here; review and the
// gates read it.
function submitPlaceholders(submitted) {
  if (!submitted?.diff) return [];
  return require('./claude-sandbox-placeholders').committed(submitted.repo.root, submitted.diff.base, submitted.diff.sha);
}

// The submitted diff against the paths the task names. A head or base git
// cannot read leaves the scope unchecked, never the submit refused.
function submitScope(submitted) {
  if (!submitted) return null;
  if (submitted.error) return { error: submitted.error };
  const { st, task, diff } = submitted;
  try {
    return Scope.check({ task, brief: Scope.briefText(briefPath(st.dir, task.id)), files: diff.files, tree: diff.tree, project: st.project });
  } catch (e) {
    return { error: e.message };
  }
}

// Restrict findings to the current revision and head so an older dispatch cannot block it.
function dispatchedReview(st, task, sha) {
  return st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
    && e.detail.revision === task.revision && shaMatch(e.detail.sha, sha) && Array.isArray(e.detail.revuto));
}

async function evidence(ctx) {
  const f = ctx.flags;
  if (f.findings !== undefined && (f.type !== 'review' || !f.fail)) throw usage('--findings is only for a failed review');
  const findings = f.findings === undefined ? undefined : require('./review-findings').parse(f.findings);
  if (!S.EVIDENCE_TYPES.includes(f.type)) throw usage(`--type must be one of ${S.EVIDENCE_TYPES.join(', ')}`);
  if (!!f.ok === !!f.fail) throw usage('evidence needs exactly one of --ok or --fail');
  if (SOFTWARE_GATES.includes(f.type) || f.type === 'final-review') {
    const command = f.type === 'merge' ? 'merge' : f.type === 'final-review' ? 'accept' : `check ${f.type}`;
    throw refuse(`only tower-crane ${command} records ${f.type} evidence; run that command for ${ctx.pos[0]}`);
  }
  if (f.type === 'verb') throw refuse(`only tower-crane verb records verb evidence, from the run it made for ${ctx.pos[0]}`);
  // A worker can move the submitted head while a reviewer is still working.
  if (f.type === 'review' && f.sha === undefined) throw usage('review evidence needs --sha with the commit reviewed');
  if (f.sha !== undefined && !SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  if (f.revision !== undefined && f.revision < 1) throw usage(`--revision must be 1 or more, got ${f.revision}`);
  const entry = S.mutate(ctx, 'evidence', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    const sha = f.sha ? f.sha.toLowerCase() : t.sha;
    if (!sha) throw refuse(`${t.id} has no submitted sha yet; pass --sha for the commit this evidence is about`);
    const dispatch = f.type === 'review' ? st.events.findLast((event) => event.cmd === 'spawn'
      && event.task === t.id && event.detail.role === 'reviewer' && event.detail.agent === ctx.agent) : null;
    // A reviewer spawn did not start reads the brief on its own, so only it
    // can say which revision its verdict is about.
    if (f.revision !== undefined && f.revision > t.revision) throw refuse(`${t.id} is at revision ${t.revision}; --revision ${f.revision} is ahead of it`);
    if (f.type === 'review' && !dispatch && f.revision === undefined) {
      throw refuse(`review evidence from a reviewer spawn did not start needs --revision with the revision reviewed (${t.id} is at ${t.revision})`);
    }
    const revision = dispatch ? dispatch.detail.revision : f.revision ?? t.revision;
    // The dispatch recorded whether each finding's file changed, so this
    // check reads only state and holds for brokered evidence, which runs no git.
    if (f.type === 'review' && f.ok) {
      const R = require('./reviewer');
      const open = R.unaddressed(dispatchedReview(st, { ...t, revision }, sha)?.detail.revuto);
      if (open.length) {
        throw refuse(`${t.id}: review ok refused; revuto ${open.map(R.findingName).join('; ')} ${open.length === 1 ? 'has' : 'have'} no code change at that path since the comment and no resolving reply on the thread. The worker or the orchestrator resolves it with a reply whose first line is [resolved] (tower-crane ci resolve COMMENT_ID --task ${t.id} --reason TEXT), and the next dispatch reads it. If the finding stands, record --fail. Otherwise say so in your report and exit: automation dispatches no other reviewer at this head until the thread changes or the orchestrator runs accept`);
      }
    }
    const e = { type: f.type, ok: !!f.ok, sha, agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary: f.summary || null, ref: f.ref || null, revision,
      ...(dispatch?.detail.body_recheck ? { body_recheck: true } : {}),
      ...(findings ? { findings } : {}) };
    if (e.type === 'review' && !e.ok) e.areas = require('./review-findings').areas(e.summary, findings);
    t.evidence.push(e);
    emit(t.id, { type: e.type, ok: e.ok, sha: e.sha, revision: e.revision });
    return { task: t.id, ...e };
  });
  if (entry.type === 'review' && !entry.ok) {
    const task = getTask(S.loadState(ctx.stateDir), entry.task);
    if (task.hotfix) require('./hotfix').settle({ ...ctx, pos: [entry.task] });
    // Prose-only failures climb no rung; they wait for a correction or review rework.
    else if (!require('./review-findings').proseOnly(entry.findings)) await require('./escalation').recover({ ...ctx, pos: [entry.task], flags: {} });
  }
  return { data: entry, text: `${entry.task}: ${entry.type} ${entry.ok ? 'ok' : 'FAIL'} at ${entry.sha.slice(0, 7)} by ${entry.agent}` };
}

// Whether the reviewer is capped or down for the task's submitted head: a
// check ci at that head recorded a capped review run (ci.capped_review), or a
// review spawn at that head exited without its verdict.
function reviewerOut(st, task) {
  const here = (e) => e.revision === task.revision && shaMatch(e.sha, task.sha);
  if (task.evidence.some((e) => e.type === 'ci' && here(e) && e.capped_review?.length)) return true;
  const Sessions = require('./spawn-session');
  return st.events.some((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
    && here(e.detail) && Sessions.exitedAttempt(e, st.events)
    && !task.evidence.some((v) => v.type === 'review' && v.agent === e.detail.agent && here(v)));
}

async function accept(ctx) {
  const f = ctx.flags;
  const waive = asList(f.waive);
  for (const w of waive) if (!GATE_TYPES.includes(w)) throw usage(`--waive must be one of ${GATE_TYPES.join(', ')}, got "${w}"`);
  if (waive.length && !(f.reason || '').trim()) throw usage('--waive needs --reason saying why the gate does not apply');
  const dropPaths = asList(f['drop-citation']).map((p) => {
    const rel = require('./archive').relative(String(p));
    if (!rel) throw usage(`--drop-citation ${p} must be a path relative to the task scratch, as accept's refusal names it`);
    return rel;
  });
  if (dropPaths.length && !(f.reason || '').trim()) throw usage('--drop-citation needs --reason saying why the cited path is stale or wrong');
  // Dropping a citation lets accept go on without evidence a note promised; it is the orchestrator's call.
  if (dropPaths.length) Authority.enforce(ctx, S.loadState(ctx.stateDir), ['accept.drop_citation'], { quiet: true });
  if (waive.length) {
    const st = S.loadState(ctx.stateDir);
    const t = getTask(st, ctx.pos[0]);
    // Only the tests gate of a hotfix can be waived, and only when its failure also failed at the merge's first parent.
    if (t.hotfix && (waive.some((w) => w !== 'tests') || !require('./hotfix').baseFailure(t, st.events))) {
      throw refuse('hotfix acceptance requires every gate; the only waiver is the owner\'s --waive tests, for tests whose every failing name also fails at the merge\'s first parent');
    }
  }
  // Waiving review for a reviewer that is neither capped nor down is the owner's.
  // The owner's approval is applied, and the waiver audited, with the
  // acceptance that records it, so a review dispatch or a failed gate in
  // between leaves the approval usable and the log without a setting event.
  const waiver = (st) => {
    const t = getTask(st, ctx.pos[0]);
    const out = waive.includes('review') && reviewerOut(st, t);
    const settings = waive.map((w) => (w === 'review' && !out ? 'waive.review_live' : `waive.${w}`));
    return { settings, change: { accept: t.id, sha: t.sha, revision: t.revision, waive, reason: f.reason.trim() } };
  };
  if (waive.length) {
    S.mutate(ctx, 'accept', (st, emit, commit) => {
      const { settings, change } = waiver(st);
      Authority.enforce(ctx, st, settings, { change, emit, commit, keep: true, quiet: true });
    });
  }
  let st = S.loadState(ctx.stateDir);
  let task = getTask(st, ctx.pos[0]);
  if (task.status !== 'submitted') throw refuse(`${task.id} is ${task.status}; only submitted tasks can be accepted`);
  if (f['retry-review']) Authority.enforce(ctx, st, ['accept.retry_review'], { quiet: true });
  const rejected = (!f['retry-review'] || waive.includes('review'))
    && require('./actions').acceptFailure(st, task, waive.includes('review'));
  if (rejected) return rejected;
  await require('./stack').refreshParent(ctx, task.id);
  st = S.loadState(ctx.stateDir);
  task = getTask(st, task.id);
  require('./check').requireParentHead(ctx, st, task, 'accept');
  if (task.status !== 'submitted') throw refuse(`${task.id} is ${task.status}; only submitted tasks can be accepted`);
  const pins = require('./check').missingPins(st, task, requiredGates(task).filter((g) => !waive.includes(g)));
  if (require('./gate-commands').heal(ctx, pins).length) {
    st = S.loadState(ctx.stateDir);
    task = getTask(st, task.id);
  }
  if (f.cmd !== undefined || f['proof-cmd'] !== undefined) {
    const selected = require('./gate-commands').select(st.project, 'tests', f,
      require('./tests-policy').resolve(st.project, task.kind).mode);
    if (selected.error) throw refuse(selected.error);
  }
  const original = { sha: task.sha, revision: task.revision };
  for (const type of requiredGates(task).filter((g) => g !== 'review' && !waive.includes(g))) {
    const entry = latestGateEvidence(task, type, st.events);
    const attempted = task.evidence.some((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha));
    const current = gateReport(task, st.events, st).gates.find((g) => g.type === type);
    // A successful attempt whose inputs changed leaves the current gate missing, and a void
    // checked nothing, so both run like a missing gate.
    if (!current?.ok && (!attempted || entry?.ok || entry?.voided) && (type !== 'tests' || f.cmd || st.project.gates?.tests_cmd || require('./tests-policy').resolve(st.project, task.kind).mode === 'none')) {
      process.stderr.write(`${task.id}: running ${entry?.voided ? 'voided' : entry ? 'stale' : 'missing'} ${type} software gate; review is checked separately\n`);
      await require('./check').runGate({ ...ctx, flags: type === 'tests' ? { cmd: f.cmd, 'proof-cmd': f['proof-cmd'] } : {} }, type);
      st = S.loadState(ctx.stateDir);
      task = getTask(st, task.id);
      if (task.hotfix?.follow_up) return { data: task, code: 1, text: `${task.id}: hotfix failed; follow-up ${task.hotfix.follow_up} requires rework` };
      if (task.sha !== original.sha || task.revision !== original.revision || task.status !== 'submitted') {
        throw refuse(`${task.id} changed while its software gates ran; retry accept`);
      }
    }
    const gate = gateReport(task, st.events, st).gates.find((g) => g.type === type);
    if (!gate?.ok) break;
  }
  st = S.loadState(ctx.stateDir);
  task = getTask(st, task.id);
  const changedReview = (!f['retry-review'] || waive.includes('review'))
    && require('./actions').acceptFailure(st, task, waive.includes('review'));
  if (changedReview) return changedReview;
  const software = require('./reviewer').softwareReport(st, task);
  const passed = software.gates.every((g) => g.ok || waive.includes(g.type));
  // Review evidence that cannot count must not stand in for the reviewer it would replace.
  const review = task.evidence.some((e) => e.type === 'review' && e.revision === task.revision && shaMatch(e.sha, task.sha)
    && eligibleGateEvidence(task, e, st.events));
  const verdict = latestGateEvidence(task, 'review', st.events);
  // Body edits have no submit event. Automation verifies the edit and unchanged
  // head before requesting the same light check as an explicit accept.
  const lightRetry = (!ctx.automatic || ctx.bodyRecheck) && verdict?.ok === false && require('./review-findings').bodyOnly(verdict.findings);
  const reviewRetry = f['retry-review'] && verdict?.ok === false && !lightRetry
    ? { sha: task.sha, revision: task.revision, review: verdict } : null;
  if (passed && (!review || lightRetry || reviewRetry) && !waive.includes('review')) {
    // A waiver stays atomic with acceptance; it cannot authorize a dispatch
    // that a refused accept would leave without an audit record.
    if (!software.ok) throw refuse(`${task.id}: software gates must pass before review dispatch; this accept's waivers are recorded only with acceptance`);
    const active = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && shaMatch(e.detail.sha, task.sha) && e.detail.revision === task.revision && !require('./spawn-session').exitedAttempt(e, st.events));
    const started = active ? { data: active.detail } : await require('./spawn').spawn({ ...ctx, reviewRetry, pos: [], flags: { task: task.id, role: 'review' } });
    return { data: { ...task, review_pending: true, reviewer: started.data.agent }, text: `${task.id}: software gates passed; review pending with ${started.data.agent}` };
  }
  // The project's external reviewer reads a head its own check skipped once, after every other
  // gate passed and before acceptance; its concerns send the task back with their findings.
  const FinalReview = require('./final-review');
  // Without a PR in the project's repo there is no external review to ask for.
  const finalReview = !!FinalReview.settings(st.project) && !task.hotfix && !!task.pr && !!st.project.repo;
  if (finalReview && !FinalReview.current(task, st.events)
    && gateReport(task, st.events, st).gates.every((g) => g.ok || waive.includes(g.type))) {
    process.stderr.write(`${task.id}: every other gate passed; running the final review\n`);
    const ran = await require('./check').runGate({ ...ctx, flags: {} }, 'final-review');
    st = S.loadState(ctx.stateDir);
    task = getTask(st, task.id);
    if (task.sha !== original.sha || task.revision !== original.revision || task.status !== 'submitted') {
      throw refuse(`${task.id} changed while its final review ran; retry accept`);
    }
    // A joined run's evidence counts as this run's; one interrupted or refused gave no verdict.
    const final = FinalReview.current(task, st.events);
    if (FinalReview.concerns(final)) {
      const back = rework({ ...ctx, pos: [task.id], flags: { reason: `final review FAIL at ${task.sha}:\n${final.summary}` } });
      await require('./escalation').recover({ ...ctx, pos: [task.id], flags: {} });
      return { data: back.data, code: 1, text: `${task.id}: final review raised concerns; ${back.text}` };
    }
    if (!final) {
      const said = ran.data?.summary?.split('\n')[0] || ran.text || 'no result';
      return { data: task, code: 1, text: `${task.id}: not accepted; the final review at ${task.sha.slice(0, 7)} gave no verdict (${said}); retry accept` };
    }
  }
  const preparedCI = prepareCI(st, task);
  const expectedParent = require('./check').requireParentHead(ctx, S.loadState(ctx.stateDir), task, 'accept');
  // The gates are checked before the archive is written, so an accept they refuse reads no scratch
  // and leaves no archive; the write below checks them again with the waivers it records.
  const early = gateReport(task, st.events, st, preparedCI);
  const waived = new Set(early.gates.filter((g) => !g.ok && waive.includes(g.type)).map((g) => `${g.type}: ${g.reason}`));
  const unmet = early.missing.filter((m) => !waived.has(m));
  if (unmet.length) throw refuse(`${task.id} cannot be accepted yet: ${unmet.join('; ')}`);
  // Acceptance leads to the scratch's removal, so the archive is written first; a cited path it
  // cannot keep whole refuses here.
  const drop = dropPaths.map((p) => ({ path: p, reason: f.reason.trim(), by: ctx.agent, at: nowIso() }));
  let archived;
  try {
    archived = await require('./archive').onAccept(ctx, st, task, drop);
  } catch (e) {
    if (e.archive) require('./archive').recordRefusal(ctx, task, e.archive);
    throw e;
  }
  const result = S.mutate(ctx, 'accept', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    require('./check').validateParentHead(st, t, expectedParent, 'accept');
    if (t.status !== 'submitted') throw refuse(`${t.id} is ${t.status}; only submitted tasks can be accepted`);
    if (t.sha !== original.sha || t.revision !== original.revision) throw refuse(`${t.id} changed while accepting; retry accept`);
    if (waive.includes('review')) {
      const refusal = require('./actions').acceptFailure(st, t, true);
      if (refusal) return { refusal };
    }
    let approved = null;
    const who = Authority.role(ctx, st.events);
    const preexisting = t.hotfix && waive.includes('tests') ? require('./hotfix').baseFailure(t, st.events) : null;
    if (t.hotfix && waive.length && !preexisting) throw refuse(`${t.id}: the tests failure at the merge's first parent changed while accepting; retry accept`);
    const { settings, change } = waive.length ? waiver(st) : { settings: [], change: null };
    const owner = settings.filter((k) => Authority.classOf(k) === Authority.OWNER);
    // A board request from the owner goes through the same approval, and uses
    // only the owner's own, as Authority.enforce does.
    if (owner.length && (who === 'orchestrator' || ctx.requestApproval)) {
      approved = Authority.approval(st, owner, change, ctx.requestApproval ? ctx.agent : null);
      if (!approved) throw refuse(`${t.id}: the owner's approval of this waiver was used or changed while accepting; retry accept`);
      Authority.apply(ctx, approved);
    }
    for (const [i, type] of waive.entries()) {
      // Operational waivers stand on their own, even in an approved request.
      const approvedBy = approved && Authority.classOf(settings[i]) === Authority.OWNER ? approved.id : null;
      t.evidence.push({ type, ok: true, waived: true, sha: t.sha, agent: ctx.agent, at: nowIso(), summary: f.reason.trim(), ref: null, revision: t.revision, ...(approvedBy ? { approved_by: approvedBy } : {}),
        ...(preexisting && type === 'tests' ? { base_failure: preexisting } : {}) });
    }
    const report = gateReport(t, st.events, st, preparedCI);
    if (!report.ok) throw refuse(`${t.id} cannot be accepted yet: ${report.missing.join('; ')}`);
    const final = finalReview ? FinalReview.current(t, st.events) : null;
    if (finalReview && !final) throw refuse(`${t.id} cannot be accepted yet: no final review at ${t.sha.slice(0, 7)} for revision ${t.revision}; retry accept`);
    if (FinalReview.concerns(final)) throw refuse(`${t.id} cannot be accepted: the final review at ${t.sha.slice(0, 7)} raised concerns; send it back with tower-crane rework ${t.id} --reason R`);
    t.status = 'accepted';
    if (archived) t.archive = archived;
    if (who === 'owner') {
      Authority.applyOwner(ctx, st, settings, change, emit);
      Authority.applyOwner(ctx, st, settings.map(key => key === 'waive.review' ? 'waive.review_live' : key), change, emit);
    }
    if (drop.length && !who) throw refuse(`${t.id}: dropping a citation is operational; only the orchestrator or the owner accepts with --drop-citation`);
    const audited = [...(waive.length ? settings : []), ...(drop.length ? ['accept.drop_citation'] : [])];
    if (audited.length) Authority.audit(ctx, who, audited, emit, approved);
    emit(t.id, { sha: t.sha, revision: t.revision, standards: st.project.standards, waived: waive,
      ...(archived ? { archive: archived.path } : {}),
      ...(drop.length ? { dropped_citations: drop.map((d) => d.path), reason: drop[0].reason } : {}),
      ...(final ? { final_review: { outcome: final.final_review?.outcome ?? null, at: final.at, summary: final.summary.split('\n')[0] } } : {}),
      ...(preexisting ? { base_failure: preexisting } : {}),
      ...(t.hotfix ? { hotfix: true, pr: t.pr, reason: 'accepted (hotfix); merged before its gates' } : {}) });
    return { task: t, report, final };
  });
  if (result.refusal) return result.refusal;
  const finalText = result.final ? `, final review ${result.final.final_review.outcome}` : '';
  const text = `accepted${result.task.hotfix ? ' (hotfix)' : ''} ${result.task.id} at ${result.task.sha.slice(0, 7)} (${result.report.gates.map((g) => `${g.type} ${g.reason}`).join(', ')}${finalText})`;
  if (!result.task.hotfix) return { data: result.task, text };
  // The PR already landed: the merge gate only confirms it and records merge evidence at the merge commit.
  const merge = await require('./check').runGate({ ...ctx, flags: {} }, 'merge');
  return { data: getTask(S.loadState(ctx.stateDir), result.task.id), code: merge.code,
    text: `${text}\n${merge.text}${merge.code ? `; retry with tower-crane merge ${result.task.id}` : ''}` };
}

function appendBriefNote(dir, t, line) {
  const file = briefPath(dir, t.id);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = `# ${t.id} ${t.title}\n`;
  }
  const headings = text.match(/^## .*$/gm) || [];
  text = text.replace(/\s*$/, '\n');
  if (headings[headings.length - 1] !== '## Rework notes') text += '\n## Rework notes\n\n';
  text += `- ${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  S.writeAtomic(file, text);
}

function rework(ctx) {
  if (ctx.pos[0] && getTask(S.loadState(ctx.stateDir), ctx.pos[0]).hotfix) return require('./hotfix').rework(ctx);
  if (ctx.flags['from-review'] && !ctx.fromReview) return require('./actions').rework(ctx);
  let reason = (ctx.flags.reason || '').trim();
  let held = null;
  if (!reason && !ctx.fromReview) throw usage('rework needs --reason saying what to fix');
  const task = S.mutate(ctx, 'rework', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (ctx.fromReview) {
      const review = latestGateEvidence(t, 'review', st.events);
      if (!review || review.ok !== false) throw refuse(`${t.id}: no current failed review`);
      const expected = ctx.fromReview;
      if (t.sha !== expected.sha || t.revision !== expected.revision || t.pr !== expected.pr
        || st.project.repo !== expected.repo || !isDeepStrictEqual(review, expected.review)) {
        throw refuse(`${t.id}: task or review changed while fetching findings; refresh inbox and retry`);
      }
      reason = expected.reason;
      review.areas = require('./review-findings').areas(reason, review.findings);
    }
    // A caller that judged an earlier state leaves a changed task alone.
    const stale = ctx.expect?.(st);
    if (stale) return { stale };
    if (ctx.expected && (t.sha !== ctx.expected.sha || t.revision !== ctx.expected.revision
      || ctx.expected.base !== undefined && require('./stack').targetBase(st, t) !== ctx.expected.base)) {
      throw refuse(`${t.id} changed during conflict detection; retry on its current head`);
    }
    requireSupportedTask(t, st);
    const retiring = retirementHolder(st, t);
    if (retiring) throw refuse(`${t.id}'s worktree is being removed for ${retiring.id}; send it back once the removal ends`);
    if (t.status !== 'submitted' && t.status !== 'accepted' && !(t.status === 'todo' && releasedForDecision(st, t))) {
      throw refuse(`${t.id} is ${t.status}; only submitted or accepted tasks, or todo tasks released for a decision, can be sent back`);
    }
    const previousRevision = t.revision;
    const escalation = require('./escalation');
    const worker = st.events.findLast((e) => e.task === t.id && e.cmd === 'spawn' && e.detail.role === 'worker');
    const failed = escalation.failure(st, t, worker);
    const Ownership = require('./ownership');
    const owner = Ownership.state(st, t);
    const climbs = (t.escalations || []).length;
    t.status = 'rework';
    t.claim = null;
    t.revision = nextRevision(st, t);
    note(t, ctx.agent, `rework: ${reason}`);
    appendBriefNote(st.dir, t, `${shortTime(nowIso())} ${ctx.agent}: ${reason}`);
    // gate names the software gate whose failure automation settled by this
    // rework; only such a rework can be restored with gates retry --from-rework.
    const detail = { reason, sha: t.sha, previous_revision: previousRevision, revision: t.revision,
      ...(ctx.fromReview ? { from_review: true } : {}), ...(ctx.gateRework ? { gate: ctx.gateRework } : {}) };
    emit(t.id, detail);
    escalation.recordFailure(st, emit, t, ctx.agent, failed, false);
    // A quality climb runs on another rung, so its worker is a new one; what
    // holds a claim (an owner ask, a decision, a pause, the redesign gate)
    // holds the handover as well.
    if (owner?.phase === 'waiting' && t.status === 'rework' && (t.escalations || []).length === climbs
      && !blockReasons(st, t).length) {
      // A gate rework that gates retry --from-rework can still undo waits out
      // gates.rework_hold_min unclaimed, as it would for a new worker, and
      // refill hands it to the owner that keeps waiting when the hold ends.
      if (ctx.gateRework && require('./rework-hold').minutes(st.project)) held = detail.owner_held = owner.agent;
      else Ownership.handBack(st, emit, t, owner.agent, reason);
    }
    return t;
  });
  if (task.stale) return { stale: task.stale, data: null, text: `${ctx.pos[0]} not sent back: ${task.stale}`, code: 1 };
  return { data: task, text: `${task.id} sent back for rework${task.status === 'in_progress' ? `; its owner ${task.claim.agent} fixes it`
    : held ? `; its owner ${held} fixes it after the rework hold` : ''}` };
}

// Stored model IDs are trimmed and case folded. Provider prefixes and the 1M
// suffix stay, so each record shows the ID that ran; pricing matches by identity.
function priceSpend(entry, project) {
  const fold = (model) => (model ? model.trim().toLowerCase() : model);
  entry.model = fold(entry.model);
  for (const row of entry.models || []) row.model = fold(row.model);
  const reviewer = require('./reviewer');
  entry.cost_usd = reviewer.entryCost(entry, reviewer.rateTable(project.review?.prices));
}

function recordSpend(t, entry, old, emit, project) {
  priceSpend(entry, project);
  t.spend.entries ||= [];
  if (old) t.spend.entries.splice(t.spend.entries.indexOf(old), 1);
  t.spend.entries.push(entry);
  t.spend.minutes += entry.minutes - (old?.minutes || 0);
  t.spend.tokens += (entry.tokens || 0) - (old?.tokens || 0);
  for (const k of ['input', 'cached', 'output']) if (entry[k] !== null) t.spend[k] = (t.spend[k] || 0) + entry[k] - (old?.[k] || 0);
  emit(t.id, entry, 'spend');
}

function collectSpawn(st, emit, ev) {
  const t = getTask(st, ev.task);
  if (P.supervised(st, t, st.events) && P.runPhase(st, t)?.agent === ev.detail.agent) throw refuse(`${ev.detail.agent} is still supervised`);
  const sessions = require('./spawn-session');
  if (!sessions.exitedAttempt(ev, st.events)) throw refuse(`${ev.detail.agent} is still running or its exit is unverified; wait for its exit, then retry tower-crane spend ${ev.task} --from-spawn ${ev.detail.agent}`);
  const next = st.events.findIndex((e, i) => i > st.events.indexOf(ev) && e.cmd === 'spawn'
    && e.task === ev.task && e.detail.agent === ev.detail.agent);
  const boundaries = st.events.slice(st.events.indexOf(ev) + 1, next < 0 ? st.events.length : next)
    .filter((e) => (e.cmd === 'spawn fallback' || e.cmd === 'spawn retry' && e.detail.fresh)
      && e.task === ev.task && e.detail.agent === ev.detail.agent
      && e.detail.attempt === ev.detail.attempt);
  const segments = [ev, ...boundaries];
  for (let i = 0; i < segments.length; i++) {
    collectRoute(st, emit, t, { ...segments[i], detail: {
      ...segments[i].detail, ...(segments[i + 1] ? { log_end: segments[i + 1].detail.log_start } : {}),
    } }, ev);
  }
}

// One usage entry per route segment of a dispatch. The supervisor's live
// entry and the exit collection share this key, so the exit replaces it.
function spawnSource(agent, resumed, attempt, routeIndex, retry) {
  return `spawn:${agent}${resumed ? `:attempt:${attempt}` : ''}${routeIndex ? `:route:${routeIndex}` : ''}${retry !== null ? `:retry:${retry}` : ''}`;
}

// Usage a resumed session added after its baseline; unknown without one. Each
// model's counts come off its own baseline row, and the primary model is picked
// again from what this invocation ran, so earlier models are not charged twice.
function usageSince(parsed, baseline) {
  if (!parsed || !baseline) return baseline === undefined ? parsed : null;
  const minus = (a, b) => a !== null && b !== null && a >= b ? a - b : null;
  const none = { tokens: 0, input: 0, cached: 0, output: 0 };
  const { models: _, ...whole } = parsed;
  const out = { ...whole };
  for (const key of ['tokens', 'input', 'cached', 'output']) out[key] = minus(parsed[key], baseline[key]);
  if (out.tokens === null) return null;
  const before = new Map((baseline.models || [baseline]).map((u) => [u.model, u]));
  const rows = (parsed.models || [parsed]).map((u) => {
    const b = before.get(u.model) || none;
    return { model: u.model, tokens: minus(u.tokens, b.tokens), input: minus(u.input, b.input), cached: minus(u.cached, b.cached), output: minus(u.output, b.output) };
  }).filter((r) => r.tokens !== 0);
  const primary = rows.reduce((a, b) => ((b.tokens ?? -1) > (a.tokens ?? -1) ? b : a), { model: null, tokens: -1 });
  // Rows with unknown counts, or none at all, still keep the model that ran.
  return { ...out, model: primary.model ?? rows[0]?.model ?? parsed.model, ...(rows.length > 1 ? { models: rows } : {}) };
}

function collectRoute(st, emit, t, ev, dispatch) {
  const source = spawnSource(ev.detail.agent, dispatch.detail.resumed, dispatch.detail.attempt, ev.detail.route_index, ev.detail.fresh ? ev.detail.retry : null);
  const old = (t.spend.entries || []).find((e) => e.source === source);
  const sessions = require('./spawn-session');
  const session = sessions.logReader(ev.detail.log, ev.detail.harness, ev.detail.log_start || 0, ev.detail.log_end)(true);
  if (session) sessions.receipt(st, emit, ev.task, ev.detail, session);
  const usage = require('./usage-files');
  const result = usage.readResult(ev.detail);
  let parsed = result || usage.readUsage(ev.detail);
  if (parsed && ev.detail.resumed && ev.detail.harness === 'codex') parsed = usageSince(parsed, ev.detail.usage_before || null);
  // Cumulative snapshots cannot refund usage. At equal totals, keep Claude's
  // reconciled session detail rather than a partial log.
  if (!result && old?.tokens != null && (parsed?.tokens < old.tokens
    || ev.detail.harness === 'claude' && parsed?.tokens === old.tokens)) parsed = null;
  // Without exit telemetry the last live reading becomes the recorded usage.
  if (old?.live && !parsed) {
    const { live: _, ...final } = old;
    recordSpend(t, { ...final, at: nowIso() }, old, emit, st.project);
    return;
  }
  if (old && !parsed) return;
  const entry = {
    at: nowIso(), agent: ev.detail.agent, minutes: 0, tokens: null, input: null, cached: null, output: null,
    ...parsed, rung: ev.detail.rung || null, harness: ev.detail.harness,
    model: parsed?.model || old?.model || ev.detail.model || null, profile: ev.detail.profile || null,
    source, billing: ev.detail.billing ?? null,
  };
  const provider = ev.detail.route?.provider;
  if (ev.detail.harness === 'claude' && provider) {
    entry.provider = provider;
    if (entry.model) entry.model = require('./claude-provider').model(provider, entry.model);
  }
  if (old) {
    for (const key of ['tokens', 'input', 'cached', 'output']) if (entry[key] === null) entry[key] = old[key];
    if (!old.live && ['tokens', 'input', 'cached', 'output', 'model', 'provider'].every((key) => entry[key] === old[key])) return;
  }
  recordSpend(t, entry, old, emit, st.project);
}

// Unchanged readings write nothing; a reading older than LIVE_STALE intervals
// is stale, even if the supervisor can still read the unchanged file.
const LIVE_STALE = 10;

// Records a running spawn's usage as its route segment's entry. A final reading
// can repair early exit collection without moving the entry back to live.
function recordLive(st, emit, taskId, entry, { final = false, authoritative = false } = {}) {
  const t = getTask(st, taskId);
  const old = (t.spend.entries || []).find((e) => e.source === entry.source);
  const collected = old && !old.live;
  if (collected && !final) return false;
  // Losing telemetry cannot refund usage or refresh the last measured total.
  const degraded = !authoritative && old?.tokens != null && (entry.tokens === null || entry.tokens < old.tokens);
  if (degraded) {
    if (collected) return false;
    entry = { ...old, live: { ...old.live, state: 'stale' } };
  }
  if (collected) {
    const { live: _, ...reconciled } = entry;
    recordSpend(t, reconciled, old, emit, st.project);
    return true;
  }
  if (!degraded) priceSpend(entry, st.project);
  t.spend.entries ||= [];
  if (old) t.spend.entries.splice(t.spend.entries.indexOf(old), 1);
  t.spend.entries.push(entry);
  t.spend.tokens += (entry.tokens || 0) - (old?.tokens || 0);
  for (const k of ['input', 'cached', 'output']) {
    if (entry[k] !== null || old?.[k] != null) t.spend[k] = (t.spend[k] || 0) + (entry[k] || 0) - (old?.[k] || 0);
  }
  emit(t.id, entry, 'spend live');
  return true;
}

// Each running agent's usage not yet collected at exit, with the freshness of
// its newest reading: live, stale or unavailable. Earlier route segments of the
// same agent stop updating once the next starts, so only the newest one ages.
function liveSpend(t, now = Date.now()) {
  const byAgent = new Map();
  for (const e of t.spend.entries || []) if (e.live) byAgent.set(e.agent, [...byAgent.get(e.agent) || [], e]);
  return [...byAgent.values()].map((entries) => {
    const e = entries.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a));
    const known = entries.filter((x) => x.tokens !== null);
    const age = Math.max(0, now - Date.parse(e.at));
    const stale = age > LIVE_STALE * e.live.interval_ms;
    return { task: t.id, agent: e.agent, harness: e.harness, tokens: known.length ? known.reduce((n, x) => n + x.tokens, 0) : null,
      at: e.at, stale_at: new Date(Date.parse(e.at) + LIVE_STALE * e.live.interval_ms).toISOString(),
      age_s: Math.round(age / 1000), state: stale ? 'stale' : e.live.state, ...(e.live.error ? { error: e.live.error } : {}) };
  });
}

function missingUsage(t) {
  return (t.spend.entries || []).filter((e) => e.tokens === null && !e.live && e.source.startsWith('spawn:')).length;
}

function liveText(l) {
  const age = l.age_s < 120 ? `${l.age_s}s` : `${Math.round(l.age_s / 60)}m`;
  if (l.state === 'unavailable') return `${l.task} ${l.agent}: usage unavailable from ${l.harness} while it runs (${l.error ? `${l.error}; ` : ''}checked ${age} ago)`;
  return `${l.task} ${l.agent}: ${l.tokens} tokens, ${l.state}${l.state === 'stale' ? `, last read ${age} ago` : ` ${age} ago`}`;
}

// Budgets the recorded and live usage has crossed, for the project and the task.
function budgetBreaches(st, t) {
  const out = [];
  const check = (scope, budget, minutes, tokens) => {
    if (budget?.tokens != null && tokens > budget.tokens) out.push({ scope, what: 'tokens', used: tokens, limit: budget.tokens });
    if (budget?.hours != null && minutes / 60 > budget.hours) out.push({ scope, what: 'hours', used: round1(minutes / 60), limit: budget.hours });
  };
  const tasks = st.tasks.tasks;
  check('project', st.project.budget, tasks.reduce((s, x) => s + x.spend.minutes, 0), tasks.reduce((s, x) => s + x.spend.tokens, 0));
  if (t) check(t.id, t.budget, t.spend.minutes, t.spend.tokens);
  return out;
}

function breachText(b) {
  return `${b.scope === 'project' ? 'project' : b.scope} ${b.what} budget crossed: ${b.used} of ${b.limit}`;
}

async function spend(ctx) {
  const f = ctx.flags;
  if (!f['from-spawn'] && f.minutes === undefined && f.tokens === undefined) throw usage('spend needs --minutes N and/or --tokens N, or --from-spawn AGENT');
  for (const k of ['minutes', 'tokens', 'input', 'cached', 'cache-write', 'output']) {
    if (f[k] !== undefined && (!Number.isSafeInteger(f[k]) || f[k] < 0)) throw usage(`--${k} must be a non-negative safe integer`);
  }
  if (['input', 'cached', 'cache-write', 'output'].some((k) => f[k] !== undefined) && f.tokens === undefined) throw usage('token breakdown needs --tokens N');
  if (f['cache-write'] !== undefined && (f.input === undefined || (f.cached || 0) + f['cache-write'] > f.input)) throw usage('--cached plus --cache-write cannot exceed --input');
  if (f.cached !== undefined && f.input !== undefined && f.cached > f.input) throw usage('--cached cannot exceed --input');
  if (f.tokens !== undefined && (f.input || 0) + (f.output || 0) > f.tokens) throw usage('--input plus --output cannot exceed --tokens');
  if (f.cached !== undefined && f.tokens !== undefined && f.cached > f.tokens) throw usage('--cached cannot exceed --tokens');
  if (f.rung !== undefined && !L.RUNGS.includes(f.rung)) throw usage(`--rung must be one of ${L.RUNGS.join(', ')}`);
  if (f.harness !== undefined && !L.HARNESSES.includes(f.harness)) throw usage(`--harness must be one of ${L.HARNESSES.join(', ')}`);
  if (f.model !== undefined && !f.model.trim()) throw usage('--model cannot be empty');
  if (f['from-spawn'] && ['minutes', 'tokens', 'input', 'cached', 'cache-write', 'output', 'rung', 'harness', 'model'].some((k) => f[k] !== undefined)) throw usage('--from-spawn cannot be combined with manual spend');
  const task = S.mutate(ctx, 'spend', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    let entry;
    if (f['from-spawn']) {
      const ev = st.events.findLast((e) => e.cmd === 'spawn' && e.task === t.id && e.detail?.agent === f['from-spawn']);
      if (!ev) throw refuse(`no spawn ${f['from-spawn']} on ${t.id}`);
      require('./events').observe(st, emit, ev, ctx);
      return t;
    } else {
      const rung = f.rung ? L.rungOf(L.resolve(st.project, ctx.env), f.rung) : {};
      entry = {
        at: nowIso(), agent: ctx.agent, minutes: f.minutes || 0, tokens: f.tokens ?? null,
        input: f.input ?? null, cached: f.cached ?? null, output: f.output ?? null,
        ...(f['cache-write'] !== undefined ? { cache_write: f['cache-write'] } : {}),
        rung: f.rung || null, harness: f.harness || rung.harness || null,
        model: f.model || rung.model || null, profile: rung.profile || null, source: 'manual',
      };
      if (entry.harness === 'claude' && require('./claude-provider').selected(rung)) {
        entry.provider = rung.provider;
        if (entry.model) entry.model = require('./claude-provider').model(rung.provider, entry.model);
      }
    }
    recordSpend(t, entry, null, emit, st.project);
    return t;
  });
  if (f['from-spawn']) await require('./stack').observe(ctx);
  const missing = missingUsage(task);
  return { data: { id: task.id, spend: task.spend }, text: `${task.id}: ${task.spend.minutes} min, ${task.spend.tokens} tokens${missing ? `; ${missing} spawn(s) without usage` : ''}` };
}

function ownerDone(ctx) {
  const task = S.mutate(ctx, 'owner-done', (st, emit) => {
    Authority.enforce(ctx, st, ['task.needs_owner'], { emit });
    const t = getTask(st, ctx.pos[0]);
    if (!t.needs_owner) throw refuse(`${t.id} is not waiting on the owner`);
    const was = t.needs_owner;
    t.needs_owner = null;
    delete t.needs_owner_by;
    note(t, ctx.agent, `owner done: ${was}${ctx.flags.note ? `; ${ctx.flags.note}` : ''}`);
    emit(t.id, { was, note: ctx.flags.note || null });
    return t;
  });
  return { data: task, text: `${task.id} no longer waits on the owner` };
}

module.exports = {
  SIZE_HOURS, GATE_TYPES, knownFlakes, recordFailureTasks, normId, getTask, newTask, discardUncommittedBrief, isRetiring, retirementHolder, briefPath, hasBrief, leaseExpired, effectiveStatus, blockReasons, unsupportedTaskValues, requireSupportedTask, isReady, readyTasks,
  blockedTasks, displayStatus, requiredGates, taskEvents, retiredRevisions, nextRevision, note, appendBriefNote, latestGateEvidence, eligibleGateEvidence, gateReport, prepareCI, planIssues, findCycles, unblockCounts,
  describeTask, checkWorkers, workerHolders, claimReadiness, grantClaim, gatePolicyMismatch, reservations,
  taskAdd, taskUpdate, setTiers, taskNote, taskShow, taskList, planImport, briefSet, briefGet, validate,
  ready, claim, renew, release, interrupt, resolveSubmitSha, submit, evidence, accept, rework, spend, collectSpawn, ownerDone,
  spawnSource, usageSince, recordLive, liveSpend, liveText, missingUsage, budgetBreaches, breachText, LIVE_STALE,
};
