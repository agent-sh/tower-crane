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
    .sort((a, b) => counts.get(b.id) - counts.get(a.id) || byId(a, b))
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
  const gates = task.kind === 'code' ? ['tests', 'clean', 'review'] : ['review'];
  if (require('./research').required(task)) gates.unshift('sources');
  // A PR lands through GitHub whatever the task's kind, so CI must pass on the exact commit.
  return task.pr ? [...gates, 'ci'] : gates;
}

function hasGateEvent(task, entry, events) {
  const source = entry.type === 'merge' ? 'merge' : `check ${entry.type}`;
  if (entry.source !== source || !Array.isArray(entry.commands)) return false;
  if (entry.ok && !entry.commands.length) return false;
  return events.some((event) => event && event.cmd === entry.source && event.task === task.id
    && event.agent === entry.agent && event.detail
    && event.detail.type === entry.type && event.detail.source === entry.source
    && event.detail.sha === entry.sha && event.detail.ok === entry.ok
    && event.detail.revision === entry.revision && isDeepStrictEqual(event.detail.commands, entry.commands)
    && isDeepStrictEqual(event.detail.receipt, entry.receipt)
    && isDeepStrictEqual(event.detail.ci_policy, entry.ci_policy)
    && isDeepStrictEqual(event.detail.gate_policy, entry.gate_policy)
    && event.detail.tests_mode === entry.tests_mode
    && event.detail.confirmed_failure === entry.confirmed_failure);
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
  if (entry.agent === task.submitted_by) return false;
  if (entry.agent === 'owner') return true;
  return events.some((e) => e && e.cmd === 'spawn' && e.task === task.id && e.detail?.role === 'reviewer'
    && e.detail.agent === entry.agent && e.detail.revision === entry.revision && shaMatch(e.detail.sha, entry.sha));
}

function latestGateEvidence(task, type, events = []) {
  return task.evidence.findLast((e) => e.type === type && e.revision === task.revision
    && shaMatch(e.sha, task.sha) && eligibleGateEvidence(task, e, events));
}

function ciInputs(st, task) {
  return { sha: task.sha, kind: task.kind, override: task.ci_local,
    local: st?.project.ci?.local, base: st ? require('./stack').targetBase(st, task) : null };
}

function prepareCI(st, task) {
  if (!st?.project.ci?.local || !task.sha) return null;
  const inputs = ciInputs(st, task);
  const repo = S.findRepo(st.dir, process.cwd());
  return { inputs: structuredClone(inputs),
    current: require('./ci-local').snapshot(repo?.root, { ...st.project, base: inputs.base }, task.sha) };
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
    if (!latest.ok) return { type, ok: false, reason: `latest ${type} at ${sha7} failed${latest.summary ? `: ${latest.summary}` : ''}` };
    if (type === 'sources' && !latest.waived && st && latest.receipt?.min_sources !== require('./research').minimum(st.project)) {
      return { type, ok: false, reason: `research.min_sources changed; run tower-crane check sources ${task.id} again` };
    }
    const policyReason = gatePolicyMismatch(task, latest, st);
    if (policyReason) return { type, ok: false, reason: policyReason };
    if (type === 'ci' && (latest.receipt || st?.project.ci?.local != null) && !latest.waived && !merged) {
      const Local = require('./ci-local');
      const local = Local.resolve(st?.project.ci?.local, task);
      if (local.error) return { type, ok: false, reason: local.error };
      const prepared = preparedCI || prepareCI(st, task);
      if (!prepared || !isDeepStrictEqual(prepared.inputs, ciInputs(st, task))) {
        throw refuse(`${task.id}: local CI inputs changed after preparation; retry`);
      }
      const current = prepared.current;
      const reason = local.error || current.error || Local.mismatch(latest.receipt, current, local, latest.commands);
      if (reason) return { type, ok: false, reason };
    } else if (type === 'ci' && st && !latest.waived && !merged) {
      const reason = require('./ci-hosted').mismatch(latest.ci_policy, st.project, task.id);
      if (reason) return { type, ok: false, reason };
    }
    return { type, ok: true, waived: !!latest.waived, agent: latest.agent, reason: latest.waived ? `waived by ${latest.agent}` : `ok by ${latest.agent}` };
  });
  const missing = [...unsupportedTaskValues(task, st), ...gates.filter((g) => !g.ok).map((g) => `${g.type}: ${g.reason}`)];
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

function taskLine(st, t, now) {
  return `${t.id.padEnd(5)} ${displayStatus(st, t, now).padEnd(11)} ${t.size} ${t.kind.padEnd(8)} ${t.title}`;
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
  const needs = f.needs === undefined ? [] : taskNeeds(f.needs);
  const task = S.mutate(ctx, 'task add', (st, emit) => {
    const t = newTask(st, {
      title: f.title.trim(), kind: f.kind, needs, acceptance, size: f.size, tier: f.tier,
      depends_on: asList(f.dep).map((d) => normId(d, 'T')), needs_owner: f['needs-owner'] ? f['needs-owner'] : null,
      locks: [...new Set(asList(f.lock))], environment: f.environment?.trim() || null,
    });
    assertGraph(st, [t.id]);
    emit(t.id, { title: t.title });
    return t;
  });
  return { data: task, text: task.id };
}

function taskUpdate(ctx) {
  const f = ctx.flags;
  if (!Object.keys(f).length) throw usage('task update needs at least one change; see tower-crane task update --help');
  if (f.kind !== undefined) checkEnum('kind', f.kind, S.KINDS);
  if (f.size !== undefined) checkEnum('size', f.size, S.SIZES);
  if (f.tier !== undefined) checkTier(f.tier);
  const needs = f.needs === undefined ? null : taskNeeds(f.needs);
  if (f.status !== undefined && f.status !== 'cancelled') {
    throw usage('task update can only set --status cancelled; claim, submit, accept and rework move the other states');
  }
  let ciLocal;
  if (f['ci-local'] !== undefined) {
    const message = '--ci-local must be JSON with command or args and optional positive timeout in seconds, or null';
    try {
      ciLocal = JSON.parse(f['ci-local']);
    } catch {
      throw usage(message);
    }
    if (ciLocal !== null && !require('./ci-local').validOverride(ciLocal)) throw usage(message);
  }
  const task = S.mutate(ctx, 'task update', (st, emit, commit) => {
    const t = getTask(st, ctx.pos[0]);
    if (f.status !== undefined && !S.STATUSES.includes(t.status)) throw refuse(`${t.id}: unsupported status "${t.status}"; upgrade Tower Crane`);
    const liveClaim = t.status === 'in_progress' && t.claim && !leaseExpired(t, Date.now()) ? t.claim : null;
    const needsOwner = f['needs-owner'] === undefined ? undefined : f['needs-owner'].trim() || null;
    // Updating the reason must not bypass owner-done's check.
    const settings = [
      ...(f.kind !== undefined ? Authority.kindSettings(t, f.kind) : []),
      ...(f.tier !== undefined && (f.tier !== t.tier || t.tier_range) ? ['task.tier'] : []),
      ...(f['ci-local'] !== undefined ? ['ci.local'] : []),
      ...(needsOwner !== undefined && t.needs_owner && needsOwner !== t.needs_owner ? ['task.needs_owner'] : []),
      ...(f.status === 'cancelled' && t.needs_owner ? ['task.cancel_needs_owner'] : []),
      ...[['budget-hours', 'hours'], ['budget-tokens', 'tokens']].filter(([flag]) => f[flag] !== undefined)
        .map(([flag, key]) => require('./project').budgetSetting(t.budget?.[key] ?? null, f[flag])),
    ];
    const budgetFields = [['budget-hours', 'hours'], ['budget-tokens', 'tokens']].filter(([flag]) => f[flag] !== undefined);
    const target = { task: t.id, ...(f.kind !== undefined ? { kind: f.kind } : {}), ...(f.status !== undefined ? { status: f.status } : {}) };
    const change = { ...target, ...Object.fromEntries(budgetFields
      .filter(([flag, key]) => Authority.classOf(require('./project').budgetSetting(t.budget?.[key] ?? null, f[flag])) === Authority.OWNER)
      .map(([flag]) => [flag, f[flag]])) };
    const ownerChange = { ...target, ...Object.fromEntries(budgetFields.map(([flag]) => [flag, f[flag]])) };
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
    if (needsOwner !== undefined) {
      t.needs_owner = changes.needs_owner = needsOwner;
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
      t.revision += 1;
      changes.revision = t.revision;
    }
    const interrupted = liveClaim && material.length;
    if (interrupted) settings.push('task.interrupt');
    const ownerWrite = {
      settings: [
        ...(f.kind !== undefined ? ['task.downgrade'] : []),
        ...(f.status === 'cancelled' ? ['task.cancel_needs_owner'] : []),
        ...(budgetFields.length ? ['budget.raise'] : []),
      ], change: ownerChange,
    };
    // Combine the changed fields and interruption into one settings audit.
    Authority.enforce(ctx, st, settings, { change, ownerWrite, emit, commit });
    // Bumped first, so the interrupt event carries the revision the task now has.
    if (interrupted) interruptClaim(ctx, st, emit, t, `requirements changed: ${material.join(', ')}`, liveClaim, false);
    emit(t.id, changes);
    return { t, bump };
  });
  if (f.status === 'cancelled') require('./worktree').retireTask(ctx, [{ id: task.t.id, sha: task.t.sha, revision: task.t.revision }]);
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
  const task = S.mutate(ctx, 'task note', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    note(t, ctx.agent, text);
    emit(t.id, { text });
    return t;
  });
  return { data: task.notes[task.notes.length - 1], text: `noted on ${task.id}` };
}

function describeTask(st, t, now) {
  const display = displayStatus(st, t, now);
  const out = {
    ...t,
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
    `status: ${t.status}${display(d)}  kind: ${t.kind}  size: ${t.size}  tier: ${t.tier}  revision: ${t.revision}`,
  ];
  if (t.tier_range) lines.push(`tier range: ${t.tier_range.min}..${t.tier_range.max}`);
  if (t.depends_on.length) {
    lines.push(`depends on: ${t.depends_on.map((id) => {
      const dep = st.tasks.tasks.find((x) => x.id === id);
      return `${id} (${dep ? dep.status : 'missing'})`;
    }).join(', ')}`);
  }
  if (t.needs_owner) lines.push(`needs owner: ${t.needs_owner}`);
  if (t.needs.length) lines.push(`needs: ${t.needs.join(', ')}`);
  if (t.locks.length) lines.push(`locks: ${t.locks.join(', ')}`);
  if (t.environment) lines.push(`environment: ${t.environment}`);
  if (t.ci_local != null) lines.push(`ci.local override: ${JSON.stringify(t.ci_local)}`);
  if (d.blocked_by.length) lines.push(`blocked: ${d.blocked_by.join('; ')}`);
  lines.push('acceptance:', ...t.acceptance.map((a) => `  - ${a}`));
  if (t.claim) lines.push(`claim: ${t.claim.agent} until ${shortTime(t.claim.until)}${d.lease_expired ? ' (expired)' : ''}`);
  if (d.run) lines.push(`phase: ${P.phaseText(d.run)}`);
  if (t.branch || t.pr || t.sha) lines.push(`branch: ${t.branch || '-'}  pr: ${t.pr ? `#${t.pr}` : '-'}  sha: ${t.sha || '-'}${t.submitted_by ? `  submitted by ${t.submitted_by}` : ''}`);
  if (t.stack) lines.push(`stack: after ${t.stack.parent}, PR base ${t.stack.base}, ${t.stack.linked ? 'linked' : 'pending link'}${t.stack_disabled ? ' (unavailable)' : ''}`);
  if (t.github_stack != null) lines.push(`GitHub stack: ${JSON.stringify(t.github_stack)}`);
  if (d.gates) lines.push(`gates: ${d.gates.gates.map((g) => `${g.type} ${g.ok ? 'ok' : 'missing'}`).join(', ')}`);
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
        depends_on: deps, needs_owner: entry.needs_owner ? entry.needs_owner : null,
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
    fs.mkdirSync(path.dirname(target), { recursive: true });
    S.writeAtomic(target, text);
    emit(t.id, { bytes: Buffer.byteLength(text) });
    return { id: t.id, path: target };
  });
  if (B.hasSection(text, 'reviewer') && !B.hasSection(text, 'worker')) {
    process.stderr.write('tower-crane: brief has a ## Reviewer section without a ## Worker section\n');
  }
  return { data: out, text: `brief for ${out.id} written to ${out.path}` };
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
// writer that did not hold the lock.
function logDrift(st) {
  const issues = [];
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

function validate(ctx) {
  const st = S.loadState(ctx.stateDir);
  const issues = planIssues(st);
  // A ladder that cannot run is a broken plan: spawn would refuse it.
  let layers = null;
  try {
    layers = L.resolve(st.project, ctx.env);
    for (const e of L.check(st.project, ctx.env)) issues.push({ task: null, kind: 'ladder', message: e });
  } catch (e) {
    issues.push({ task: null, kind: 'ladder', message: e.message });
  }
  const warnings = layers ? ladderWarnings(st, layers, ctx.env) : [];
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
    ready: r.map(({ task, unblocks }) => ({ id: task.id, title: task.title, kind: task.kind, size: task.size, tier: task.tier, locks: task.locks, environment: task.environment, status: effectiveStatus(task, now), unblocks })),
    exited_claims: P.exitedClaims(st),
  };
  const lines = r.length
    ? r.map(({ task, unblocks }) => `${task.id.padEnd(5)} ${task.size} ${task.kind.padEnd(8)} ${task.title}${unblocks ? `  (unblocks ${unblocks})` : ''}${effectiveStatus(task, now) === 'rework' ? '  [rework]' : ''}`)
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
    if (isRetiring(t)) throw refuse(`${t.id}'s worktree is being removed after its merge or cancel; claim it once the removal ends`);
    const lease = leaseMinutes(ctx, st);
    const eff = claimReadiness(st, t, now, ctx.agent);
    if (t.status === 'in_progress' && !leaseExpired(t, now)) {
      t.claim.until = new Date(now + lease * 60000).toISOString();
      emit(t.id, { until: t.claim.until, from: t.claim.from, renewed: true });
      return t;
    }
    const previous = t.status === 'in_progress' ? t.claim.agent : null;
    t.claim = { agent: ctx.agent, since: new Date(now).toISOString(), until: new Date(now + lease * 60000).toISOString(), from: eff };
    t.status = 'in_progress';
    emit(t.id, { until: t.claim.until, from: eff, ...(previous ? { took_over_from: previous } : {}) });
    return t;
  });
  return { data: task, text: `claimed ${task.id} for ${task.claim.agent} until ${shortTime(task.claim.until)}` };
}

// Every observer reads the same holders from the event log: a sandboxed
// claimer cannot see peer pids, so a probe would let spawn and claim disagree.
function workerHolders(st, now) {
  // An unfamiliar status cannot release an existing lease while its worker
  // may still be finishing an edit without supervision.
  const holders = st.tasks.tasks.filter((t) => t.claim
    && (t.status === 'in_progress' || !S.STATUSES.includes(t.status))
    && !(Date.parse(t.claim.until) <= now))
    .map((t) => ({ task: t.id, agent: t.claim.agent, kind: 'lease' }));
  const pending = new Map();
  const key = (e) => JSON.stringify([e.task, e.detail.agent, e.detail.attempt]);
  // A worker claims within minutes; a reservation unclaimed for a whole lease
  // since its monitor last wrote, or past a scheduled backoff, cannot belong to
  // a live dispatch. Once lapsed it stays lapsed: another holder may have
  // taken the slot.
  const horizon = st.project.limits.lease_minutes * 60000;
  for (const e of st.events) {
    // Spawns recorded before reservations existed carry no marker and hold nothing.
    if (e.cmd === 'spawn' && e.detail.role === 'worker' && e.detail.reserved === true && !e.detail.claim_since) {
      pending.set(key(e), { task: e.task, agent: e.detail.agent, pid: e.detail.pid, until: Date.parse(e.at) + horizon });
    } else if (e.cmd === 'interrupt' && e.detail.role === 'worker' && e.detail.active) {
      // Clearing the lease cannot free the slot before supervised cleanup ends.
      pending.set(key(e), { task: e.task, agent: e.detail.agent, pid: e.detail.pid, until: Date.parse(e.at) + horizon });
    } else if (e.cmd === 'claim') {
      for (const [id, slot] of pending) {
        if (slot.task === e.task && slot.agent === (e.detail.holder || e.agent)) pending.delete(id);
      }
    } else if (['spawn retry', 'spawn fallback', 'spawn phase'].includes(e.cmd) && pending.has(key(e))) {
      // Session receipts replay an earlier attempt's detail, so only the
      // monitor's own records move the pid or the horizon.
      const slot = pending.get(key(e));
      // The monitor records active false once the attempt is over with no retry pending.
      if (e.detail.active === false || Date.parse(e.at) >= slot.until) pending.delete(key(e));
      else {
        const backoff = e.cmd === 'spawn phase' && Number.isFinite(e.detail.backoff_ms) ? e.detail.backoff_ms : 0;
        Object.assign(slot, { pid: e.detail.pid ?? slot.pid, until: Math.max(slot.until, Date.parse(e.at) + backoff + horizon) });
      }
    } else if (['spawn exit', 'worker-exited'].includes(e.cmd)) {
      const spawn = P.exitSpawn(e, st.events);
      if (spawn && pending.get(key(spawn))?.pid === e.detail.pid) pending.delete(key(spawn));
    }
  }
  for (const slot of pending.values()) {
    if (slot.until <= now) continue;
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

function release(ctx) {
  if (ctx.flags.dead) return require('./actions').release(ctx);
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('release needs --reason so the next agent knows why');
  const task = S.mutate(ctx, 'release', (st, emit, commit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'in_progress' || !t.claim) throw refuse(`${t.id} is ${t.status}, not in progress`);
    const exited = P.exitedClaims(st, st.events, { includeTail: false }).find((c) => c.id === t.id);
    if (ctx.deadOnly && !exited) throw refuse(`${t.id}: claim is no longer verified exited`);
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
    const holder = t.claim.agent;
    t.status = t.claim.from || 'todo';
    t.claim = null;
    note(t, ctx.agent, `released claim held by ${holder}: ${reason}`);
    if (recovery) note(t, ctx.agent, `exited spawn: pid ${recovery.pid}; log: ${recovery.log || '(none)'}; exit code: ${recovery.code ?? 'unknown'}; size: ${recovery.size ?? 'unknown'} bytes`);
    emit(t.id, { reason, holder, status: t.status, ...(recovery ? { exited_spawn: recovery } : {}) });
    return t;
  });
  return { data: task, text: `released ${task.id}; it is ${task.status} again` };
}

function interruptClaim(ctx, st, emit, t, reason, claim = t.claim, audit = true) {
  Authority.enforce(ctx, st, ['task.interrupt'], { emit: audit ? emit : null, quiet: !audit });
  if (!claim) throw refuse(`${t.id} is ${t.status}, not in progress`);
  const run = P.runPhase(st, { ...t, status: 'in_progress', claim });
  t.status = t.status === 'cancelled' ? 'cancelled' : claim.from || 'todo';
  t.claim = null;
  note(t, ctx.agent, `interrupted claim held by ${claim.agent}: ${reason}`);
  const active = run?.active !== false && !!run?.monitor_pid && P.processState({
    pid: run.monitor_pid, host: run.host, start_ticks: run.monitor_start_ticks,
  }) !== 'exited';
  emit(t.id, { ...(run || {}), holder: claim.agent, claim, status: t.status, revision: t.revision, reason,
    phase: active ? 'stopping' : 'stopped', active }, 'interrupt');
}

function interrupt(ctx) {
  const task = S.mutate(ctx, 'interrupt', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    interruptClaim(ctx, st, emit, t, 'dispatch interrupted');
    return t;
  });
  return { data: task, text: `interrupted ${task.id}; claim released, revision ${task.revision} and worktree kept` };
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

function submit(ctx) {
  const f = ctx.flags;
  if (!f.sha) throw usage('submit needs --sha with the commit to review');
  if (!SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  if (f.pr !== undefined && f.pr < 1) throw usage('--pr must be a pull request number');
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
  const scope = submitScope(ctx, f.sha);
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
    const previousSha = t.sha;
    const previousClaim = t.claim;
    t.status = 'submitted';
    t.sha = f.sha.toLowerCase();
    if (submittedBranch !== undefined) t.branch = submittedBranch;
    if (f.pr !== undefined) t.pr = f.pr;
    t.submitted_by = ctx.agent;
    t.claim = null;
    if (f.summary) note(t, ctx.agent, `submitted: ${f.summary}`);
    if (scope?.outside?.length) note(t, ctx.agent, Scope.line(scope));
    const spawned = st.events.some((e) => e.cmd === 'spawn' && e.task === t.id && e.detail.agent === ctx.agent);
    emit(t.id, { previous_sha: previousSha, sha: t.sha, branch: t.branch, pr: t.pr, summary: f.summary || null,
      ...(spawned && previousClaim ? { claim: previousClaim } : {}), scope });
    return t;
  });
  return { data: { ...task, scope }, text: [`submitted ${task.id} at ${task.sha.slice(0, 7)}`, Scope.line(scope)].filter(Boolean).join('\n') };
}

// The submitted diff against the paths the task names, read before the
// state lock. A head or base git cannot read leaves the scope unchecked,
// never the submit refused.
function submitScope(ctx, sha) {
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
    const diff = require('./reviewer').diffOf(repo, project, { ...task, sha });
    return Scope.check({ task, brief: Scope.briefText(briefPath(st.dir, task.id)), files: diff.files, tree: diff.tree, project: st.project });
  } catch (e) {
    return { error: e.message };
  }
}

async function evidence(ctx) {
  const f = ctx.flags;
  if (!S.EVIDENCE_TYPES.includes(f.type)) throw usage(`--type must be one of ${S.EVIDENCE_TYPES.join(', ')}`);
  if (!!f.ok === !!f.fail) throw usage('evidence needs exactly one of --ok or --fail');
  if (SOFTWARE_GATES.includes(f.type)) {
    const command = f.type === 'merge' ? 'merge' : `check ${f.type}`;
    throw refuse(`only tower-crane ${command} records ${f.type} evidence; run that command for ${ctx.pos[0]}`);
  }
  // A worker can move the submitted head while a reviewer is still working.
  if (f.type === 'review' && f.sha === undefined) throw usage('review evidence needs --sha with the commit reviewed');
  if (f.sha !== undefined && !SHA_RE.test(f.sha)) throw usage(`--sha must be a commit hash (7 to 64 hex characters), got "${f.sha}"`);
  const entry = S.mutate(ctx, 'evidence', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    const sha = f.sha ? f.sha.toLowerCase() : t.sha;
    if (!sha) throw refuse(`${t.id} has no submitted sha yet; pass --sha for the commit this evidence is about`);
    const e = { type: f.type, ok: !!f.ok, sha, agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary: f.summary || null, ref: f.ref || null, revision: t.revision };
    t.evidence.push(e);
    emit(t.id, { type: e.type, ok: e.ok, sha: e.sha });
    return { task: t.id, ...e };
  });
  if (entry.type === 'review' && !entry.ok) await require('./escalation').recover({ ...ctx, pos: [entry.task], flags: {} });
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
    if (!entry && !attempted && (type !== 'tests' || f.cmd || st.project.gates?.tests_cmd || require('./tests-policy').resolve(st.project, task.kind).mode === 'none')) {
      await require('./check').runGate({ ...ctx, flags: type === 'tests' ? { cmd: f.cmd, 'proof-cmd': f['proof-cmd'] } : {} }, type);
      st = S.loadState(ctx.stateDir);
      task = getTask(st, task.id);
      if (task.sha !== original.sha || task.revision !== original.revision || task.status !== 'submitted') {
        throw refuse(`${task.id} changed while its software gates ran; retry accept`);
      }
    }
    const gate = gateReport(task, st.events, st).gates.find((g) => g.type === type);
    if (!gate?.ok) break;
  }
  const software = require('./reviewer').softwareReport(st, task);
  const passed = software.gates.every((g) => g.ok || waive.includes(g.type));
  // Review evidence that cannot count must not stand in for the reviewer it would replace.
  const review = task.evidence.some((e) => e.type === 'review' && e.revision === task.revision && shaMatch(e.sha, task.sha)
    && eligibleGateEvidence(task, e, st.events));
  if (passed && !review && !waive.includes('review')) {
    // A waiver stays atomic with acceptance; it cannot authorize a dispatch
    // that a refused accept would leave without an audit record.
    if (!software.ok) throw refuse(`${task.id}: software gates must pass before review dispatch; this accept's waivers are recorded only with acceptance`);
    const active = st.events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail.role === 'reviewer'
      && e.detail.sha === task.sha && e.detail.revision === task.revision && !require('./spawn-session').exitedAttempt(e, st.events));
    const started = active ? { data: active.detail } : await require('./spawn').spawn({ ...ctx, pos: [], flags: { task: task.id, role: 'review' } });
    return { data: { ...task, review_pending: true, reviewer: started.data.agent }, text: `${task.id}: software gates passed; review pending with ${started.data.agent}` };
  }
  const preparedCI = prepareCI(st, task);
  const result = S.mutate(ctx, 'accept', (st, emit) => {
    const t = getTask(st, ctx.pos[0]);
    if (t.status !== 'submitted') throw refuse(`${t.id} is ${t.status}; only submitted tasks can be accepted`);
    if (t.sha !== original.sha || t.revision !== original.revision) throw refuse(`${t.id} changed while accepting; retry accept`);
    let approved = null;
    const who = Authority.role(ctx, st.events);
    const { settings, change } = waive.length ? waiver(st) : { settings: [], change: null };
    const owner = settings.filter((k) => Authority.classOf(k) === Authority.OWNER);
    // A board request from the owner goes through the same approval.
    if (owner.length && (who === 'orchestrator' || ctx.requestApproval)) {
      approved = Authority.approval(st, owner, change);
      if (!approved) throw refuse(`${t.id}: the owner's approval of this waiver was used or changed while accepting; retry accept`);
      Authority.apply(ctx, approved);
    }
    for (const [i, type] of waive.entries()) {
      // Operational waivers stand on their own, even in an approved request.
      const approvedBy = approved && Authority.classOf(settings[i]) === Authority.OWNER ? approved.id : null;
      t.evidence.push({ type, ok: true, waived: true, sha: t.sha, agent: ctx.agent, at: nowIso(), summary: f.reason.trim(), ref: null, revision: t.revision, ...(approvedBy ? { approved_by: approvedBy } : {}) });
    }
    const report = gateReport(t, st.events, st, preparedCI);
    if (!report.ok) throw refuse(`${t.id} cannot be accepted yet: ${report.missing.join('; ')}`);
    t.status = 'accepted';
    if (who === 'owner') {
      Authority.applyOwner(ctx, st, settings, change, emit);
      Authority.applyOwner(ctx, st, settings.map(key => key === 'waive.review' ? 'waive.review_live' : key), change, emit);
    }
    if (waive.length) Authority.audit(ctx, who, settings, emit, approved);
    emit(t.id, { sha: t.sha, revision: t.revision, standards: st.project.standards, waived: waive });
    return { task: t, report };
  });
  return { data: result.task, text: `accepted ${result.task.id} at ${result.task.sha.slice(0, 7)} (${result.report.gates.map((g) => `${g.type} ${g.reason}`).join(', ')})` };
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
  if (ctx.flags['from-review'] && !ctx.fromReview) return require('./actions').rework(ctx);
  let reason = (ctx.flags.reason || '').trim();
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
    }
    // A caller that judged an earlier state leaves a changed task alone.
    const stale = ctx.expect?.(st);
    if (stale) return { stale };
    if (ctx.expected && (t.sha !== ctx.expected.sha || t.revision !== ctx.expected.revision
      || ctx.expected.base !== undefined && require('./stack').targetBase(st, t) !== ctx.expected.base)) {
      throw refuse(`${t.id} changed during conflict detection; retry on its current head`);
    }
    requireSupportedTask(t, st);
    if (isRetiring(t)) throw refuse(`${t.id}'s worktree is being removed after its merge or cancel; send it back once the removal ends`);
    if (t.status !== 'submitted' && t.status !== 'accepted') throw refuse(`${t.id} is ${t.status}; only submitted or accepted tasks can be sent back`);
    const escalation = require('./escalation');
    const worker = st.events.findLast((e) => e.task === t.id && e.cmd === 'spawn' && e.detail.role === 'worker');
    const failed = escalation.failure(st, t, worker);
    t.status = 'rework';
    t.claim = null;
    note(t, ctx.agent, `rework: ${reason}`);
    appendBriefNote(st.dir, t, `${shortTime(nowIso())} ${ctx.agent}: ${reason}`);
    emit(t.id, { reason, sha: t.sha });
    escalation.recordFailure(st, emit, t, ctx.agent, failed, false);
    return t;
  });
  if (task.stale) return { stale: task.stale, data: null, text: `${ctx.pos[0]} not sent back: ${task.stale}`, code: 1 };
  return { data: task, text: `${task.id} sent back for rework` };
}

function priceSpend(entry, project) {
  if (entry.model) entry.model = L.modelIdentity(entry.model);
  entry.cost_usd = entry.model ? require('./reviewer').cost(entry, project.review?.prices?.[entry.model]) : null;
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

// Usage a resumed session added after its baseline; unknown without one.
function usageSince(parsed, baseline) {
  if (!parsed || !baseline) return baseline === undefined ? parsed : null;
  const out = { ...parsed };
  for (const key of ['tokens', 'input', 'cached', 'output']) {
    out[key] = parsed[key] !== null && baseline[key] !== null && parsed[key] >= baseline[key] ? parsed[key] - baseline[key] : null;
  }
  return out.tokens === null ? null : out;
}

function collectRoute(st, emit, t, ev, dispatch) {
  const source = spawnSource(ev.detail.agent, dispatch.detail.resumed, dispatch.detail.attempt, ev.detail.route_index, ev.cmd === 'spawn retry' ? ev.detail.retry : null);
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
    source,
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

function spend(ctx) {
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
  if (f['from-spawn']) require('./stack').observe(ctx);
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
    note(t, ctx.agent, `owner done: ${was}${ctx.flags.note ? `; ${ctx.flags.note}` : ''}`);
    emit(t.id, { was, note: ctx.flags.note || null });
    return t;
  });
  return { data: task, text: `${task.id} no longer waits on the owner` };
}

module.exports = {
  SIZE_HOURS, GATE_TYPES, normId, getTask, isRetiring, briefPath, leaseExpired, effectiveStatus, blockReasons, unsupportedTaskValues, requireSupportedTask, isReady, readyTasks,
  blockedTasks, displayStatus, requiredGates, latestGateEvidence, eligibleGateEvidence, gateReport, prepareCI, planIssues, findCycles, unblockCounts,
  describeTask, checkWorkers, workerHolders, claimReadiness, gatePolicyMismatch,
  taskAdd, taskUpdate, setTiers, taskNote, taskShow, taskList, planImport, briefSet, briefGet, validate,
  ready, claim, renew, release, interrupt, submit, evidence, accept, rework, spend, collectSpawn, ownerDone,
  spawnSource, usageSince, recordLive, liveSpend, liveText, missingUsage, budgetBreaches, breachText, LIVE_STALE,
};
