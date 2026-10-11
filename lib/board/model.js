'use strict';

// The board's view model: everything the views draw, computed once from the
// state and the event log through the same functions the CLI uses. Nothing
// here writes, and nothing here knows about HTML.

const S = require('../state');
const T = require('../tasks');
const L = require('../ladder');
const P = require('../processes');
const { byId, shaMatch } = require('../util');

const PHASES = ['claimed', 'working', 'submitted', 'gates', 'accepted', 'merged'];
const HISTORY_LIMIT = 400;
const DIGEST_LIMIT = 80;
// A lease this close to its end is flagged on its card.
const LEASE_WARN_MS = 10 * 60e3;
// Sent back this many times, a task is called stuck.
const REWORK_LOOP = 3;

// What each event means to a person reading the board. kind groups events for
// History's filters; quiet events stay out of the board's digest.
const KINDS = {
  claim: 'flow', submit: 'flow', accept: 'flow', rework: 'flow', release: 'flow', spawn: 'flow', merge: 'gates', 'check merge': 'gates',
  'check tests': 'gates', 'check clean': 'gates', 'check sources': 'gates', 'check ci': 'gates', evidence: 'gates',
  ask: 'decisions', answer: 'decisions', 'decision withdraw': 'decisions', 'decision note': 'messages', 'owner-done': 'owner',
  msg: 'messages', 'task note': 'messages', 'worker-exited': 'trouble', stall: 'trouble', 'budget stop': 'trouble', 'msg refused': 'trouble',
};
const QUIET = new Set(['renew', 'spend', 'spend live', 'brief set', 'worktree', 'spawn exit', 'role set', 'init', 'project set', 'ladder set', 'ladder harness', 'ladder save-user']);

function ladderOrError(project) {
  try {
    return L.resolve(project);
  } catch (e) {
    return { error: e.message };
  }
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// One sentence per event, in the CLI's words.
function describeEvent(e, st) {
  const d = e.detail || {};
  const t = e.task || '';
  const sha = (x) => (x ? String(x).slice(0, 7) : '');
  switch (e.cmd) {
    case 'claim': return `${e.agent} claimed ${t}`;
    case 'submit': return `${e.agent} submitted ${t} at ${sha(d.sha)}${d.summary ? `: ${clip(d.summary, 160)}` : ''}`;
    case 'accept': return `${t} accepted at ${sha(d.sha)}${d.waived && d.waived.length ? ` with ${d.waived.join(', ')} waived` : ''}`;
    case 'rework': return `${t} sent back: ${clip(d.reason, 200)}`;
    case 'release': return `${e.agent} released ${t}${d.reason ? `: ${clip(d.reason, 160)}` : ''}`;
    case 'spawn': return `${d.agent || e.agent} started on ${t} (${[d.harness, d.model || (d.profile && `profile ${d.profile}`)].filter(Boolean).join(' ')})`;
    case 'merge':
    case 'check merge': return d.ok ? `${t} merged` : `merge of ${t} refused`;
    case 'check tests':
    case 'check clean':
    case 'check sources':
    case 'check ci':
    case 'evidence': {
      const type = d.type || 'note';
      if (type === 'note') return `${e.agent} noted on ${t}`;
      return `${type} ${d.ok ? 'passed' : 'failed'} on ${t} at ${sha(d.sha)} (${e.agent})`;
    }
    case 'ask': {
      const id = d.decision || d.id || '';
      return `${e.agent} asked${id ? ` ${id}` : ''}: ${clip(d.question, 200)}`;
    }
    case 'answer': return `${d.decision || d.id || ''} answered: ${d.choice || d.answer || ''}${d.note ? ` (${clip(d.note, 120)})` : ''}`;
    case 'decision withdraw': return `${e.agent} withdrew ${d.decision || 'a decision'}: ${clip(d.reason, 200)}`;
    case 'decision note': return `${e.agent} on ${d.decision || 'a decision'}: ${clip(d.text, 200)}`;
    case 'owner-done': return `${e.agent} did ${t}'s owner task${d.note ? `: ${clip(d.note, 120)}` : ''}`;
    case 'msg': return `${e.agent}${d.to ? ` to ${d.to}` : ''}: ${clip(d.text, 220)}`;
    case 'msg refused': return `${e.agent} tried to message ${d.to || 'no one'}; the broker refused it`;
    case 'task note': return `${e.agent} on ${t}: ${clip(d.text, 220)}`;
    case 'worker-exited': return `${d.agent || e.agent} exited without submitting ${t}`;
    case 'stall': return `${t} stalled: no progress since its lease ran out`;
    case 'task add': return `${e.agent} added ${t}${d.title ? `: ${clip(d.title, 120)}` : ''}`;
    case 'plan import': return `${e.agent} imported ${t}${d.title ? `: ${clip(d.title, 120)}` : ''}`;
    case 'task update': return `${e.agent} updated ${t}${d.tier ? ` (tier ${d.tier})` : ''}`;
    case 'spend live': return `${t} ${d.agent || e.agent} running: ${d.tokens != null ? `${compact(d.tokens)} tokens so far` : 'usage unavailable'}`;
    case 'budget stop': return `${d.agent || e.agent} on ${t} stopped: ${(d.breaches || []).map(T.breachText).join('; ')}`;
    case 'spend': return `${t} spent ${d.tokens != null ? `${compact(d.tokens)} tokens` : ''}${d.minutes ? ` ${d.minutes} min` : ''}`.trim();
    default: return `${e.agent} ran ${e.cmd}${t ? ` on ${t}` : ''}`;
  }
}

function compact(n) {
  if (n == null) return '-';
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e2) / 10}k`;
  return String(n);
}

function eventItem(e, i, st) {
  const d = e.detail || {};
  const kind = KINDS[e.cmd] || 'plan';
  let tone = '';
  if (e.cmd === 'rework' || e.cmd === 'worker-exited' || e.cmd === 'stall' || e.cmd === 'msg refused') tone = 'fault';
  else if (d.ok === false && d.type && d.type !== 'note') tone = 'fault';
  else if (e.cmd === 'ask' || (e.cmd === 'msg' && d.to === 'owner')) tone = 'signal';
  else if (e.cmd === 'accept' || ((e.cmd === 'merge' || e.cmd === 'check merge') && d.ok)) tone = 'done';
  return {
    key: e.id || `L${i}`,
    at: e.at,
    agent: e.agent,
    cmd: e.cmd,
    task: e.task || null,
    decision: d.decision || d.id || null,
    kind,
    tone,
    quiet: QUIET.has(e.cmd) || (e.cmd === 'evidence' && d.type === 'note'),
    owner: e.agent === 'owner',
    text: describeEvent(e, st),
  };
}

// Where a task sits in claim, work, submit, gates, accept, merge, and what
// its holder did last.
function phaseOf(task, events, report) {
  if (task.status === 'accepted') {
    const merge = T.latestGateEvidence(task, 'merge', events);
    return merge && merge.ok ? { step: 5, label: 'merged' } : { step: 4, label: task.pr ? 'accepted, waiting to merge' : 'accepted' };
  }
  if (task.status === 'submitted') {
    if (report && report.ok) return { step: 3, label: 'gates pass, waiting to be accepted' };
    const missing = report ? report.gates.filter((g) => !g.ok).map((g) => g.type) : [];
    return { step: 3, label: missing.length ? `waiting for ${missing.join(', ')}` : 'waiting for gates' };
  }
  if (task.status !== 'in_progress' || !task.claim) return null;
  const since = Date.parse(task.claim.since || 0);
  const mine = events.filter((e) => e.task === task.id && e.agent === task.claim.agent && Date.parse(e.at) >= since && !['claim', 'renew'].includes(e.cmd));
  const last = mine[mine.length - 1];
  if (!last) return { step: 0, label: 'claimed, starting' };
  if (last.cmd.startsWith('check ')) return { step: 1, label: `running ${last.cmd.slice(6)} gate` };
  return { step: 1, label: 'working' };
}

function runOf(st, task, events) {
  const run = P.runPhase(st, task, events);
  return run ? { ...run, label: P.phaseText(run) } : null;
}

function lastWord(task, events) {
  const agent = task.claim ? task.claim.agent : task.submitted_by;
  if (!agent) return null;
  // Reclaims, even by the same agent, start a new working context.
  const claim = events.findLastIndex((e) => e.cmd === 'claim' && e.agent === agent);
  const since = task.claim ? task.claim.since : claim >= 0 ? events[claim].at : null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (i <= claim || (since && e.at < since)) break;
    if (e.task !== task.id || e.agent !== agent) continue;
    if (e.cmd === 'msg' || e.cmd === 'task note') return { text: String(e.detail.text || ''), at: e.at, agent: e.agent };
    if (e.cmd === 'submit' && e.detail.summary) return { text: String(e.detail.summary), at: e.at, agent: e.agent };
  }
  return null;
}

function rungFor(ladder, name) {
  if (!name || ladder.error || !ladder.ladder[name]) return null;
  const r = L.rungOf(ladder, name);
  return { name, harness: r.harness, model: r.model || (r.profile ? `profile ${r.profile}` : null), effort: r.effort || null };
}

// The rung a spawned claimant runs on, from its spawn event; else the tier's.
function rungOfClaim(task, events, ladder) {
  const agent = task.claim ? task.claim.agent : task.submitted_by;
  const spawn = events.findLast((e) => e.cmd === 'spawn' && e.task === task.id && e.detail && e.detail.agent === agent);
  if (spawn) {
    const d = spawn.detail;
    return { name: d.rung || task.tier, harness: d.harness, model: d.model || (d.profile ? `profile ${d.profile}` : null), effort: null, spawned: true };
  }
  return rungFor(ladder, task.tier);
}

function gatePips(task, events, report) {
  const required = T.requiredGates(task);
  if (report) {
    return report.gates.map((g) => {
      const latest = T.latestGateEvidence(task, g.type, events)
        || task.evidence.findLast((e) => e.type === g.type && e.revision === task.revision && shaMatch(e.sha, task.sha)
          && (e.type !== 'review' || T.eligibleGateEvidence(task, e, events)));
      let state = 'missing';
      if (g.ok) state = g.waived ? 'waived' : 'pass';
      else if (latest && latest.ok === false) state = 'fail';
      return { type: g.type, state, reason: g.reason };
    });
  }
  return required.map((type) => {
    const latest = task.sha ? T.latestGateEvidence(task, type, events) : null;
    let state = 'missing';
    if (latest) state = latest.waived ? 'waived' : latest.ok ? 'pass' : 'fail';
    return { type, state, reason: latest ? `${latest.ok ? 'ok' : 'failed'} by ${latest.agent}` : task.sha ? `no ${type} evidence at ${task.sha.slice(0, 7)}` : 'nothing submitted yet' };
  });
}

function spendOf(task) {
  const s = task.spend || {};
  return { minutes: s.minutes || 0, tokens: s.tokens || 0, input: s.input ?? null, cached: s.cached ?? null, output: s.output ?? null, entries: s.entries || [] };
}

// Evidence grouped by the commit it was recorded against, newest first, each
// entry marked with whether it counts toward acceptance now.
function ledger(task, events, st) {
  const groups = [];
  for (const [index, e] of task.evidence.entries()) {
    const sha = e.sha || '-';
    // Gates record full SHAs and reviewers sometimes short ones; both are the same commit.
    let g = groups.find((x) => x.sha === sha || shaMatch(x.sha, sha));
    if (!g) {
      g = { sha, key: sha, current: !!task.sha && shaMatch(sha, task.sha), entries: [] };
      groups.push(g);
    }
    if (sha.length > g.sha.length) g.sha = sha;
    let counts = g.current && e.revision === task.revision;
    let why = '';
    if (!g.current) why = 'older commit';
    else if (e.revision !== task.revision) why = `revision ${e.revision}`;
    else if (e.type === 'review' && !e.waived && e.agent === task.submitted_by) { counts = false; why = 'self-review'; }
    else if (e.type === 'review' && !T.eligibleGateEvidence(task, e, events)) { counts = false; why = 'not a spawned reviewer'; }
    else if (['tests', 'clean', 'sources', 'ci', 'merge'].includes(e.type) && !e.waived && !T.latestGateEvidence({ ...task, evidence: [e] }, e.type, events)) { counts = false; why = 'no gate proof'; }
    else if (['tests', 'clean'].includes(e.type) && e.ok && !e.waived) {
      const reason = T.gatePolicyMismatch(task, e, st);
      if (reason) { counts = false; why = reason; }
    } else if (e.type === 'sources' && e.ok && !e.waived) {
      const gate = T.gateReport({ ...task, evidence: [e] }, events, st).gates.find((g) => g.type === 'sources');
      if (gate && !gate.ok) { counts = false; why = gate.reason; }
    }
    g.entries.push({ ...e, key: `E${index}`, counts: counts && e.type !== 'note', why });
  }
  for (const g of groups) g.at = g.entries.reduce((m, e) => (e.at > m ? e.at : m), '');
  groups.sort((a, b) => (a.current === b.current ? String(b.at).localeCompare(String(a.at)) : a.current ? -1 : 1));
  for (const g of groups) g.entries.reverse();
  return groups;
}

function thread(task, events) {
  const out = [];
  for (const e of events) {
    if (e.task !== task.id) continue;
    if (e.cmd === 'msg' || e.cmd === 'task note') out.push({ at: e.at, agent: e.agent, to: e.detail.to || null, text: String(e.detail.text || ''), owner: e.agent === 'owner' });
    else if (e.cmd === 'rework') out.push({ at: e.at, agent: e.agent, text: `Sent back: ${e.detail.reason || ''}`, fault: true });
    else if (e.cmd === 'owner-done') out.push({ at: e.at, agent: e.agent, text: `Owner task done${e.detail.note ? `: ${e.detail.note}` : ''}`, owner: true });
  }
  if (!out.length) {
    // State copied without its log still has the task's notes.
    for (const n of task.notes || []) out.push({ at: n.at, agent: n.agent, text: n.text, owner: n.agent === 'owner' });
  }
  return out;
}

function build(st, { now = Date.now(), events = st.events || S.readEvents(st.dir) } = {}) {
  const tasks = [...st.tasks.tasks].sort(byId);
  const byKey = new Map(tasks.map((t) => [t.id, t]));
  // Each task's own events, found once: building the board runs under the
  // lock on every write, so per-task scans of the whole log add up.
  const byTask = new Map(tasks.map((t) => [t.id, []]));
  for (const e of events) if (e.task && byTask.has(e.task)) byTask.get(e.task).push(e);
  const ev = (t) => byTask.get(t.id);
  const ladder = ladderOrError(st.project);
  const display = new Map(tasks.map((t) => [t.id, T.displayStatus(st, t, now)]));
  const unblocks = T.unblockCounts(st);
  const reports = new Map(tasks.filter((t) => t.sha || t.status === 'submitted').map((t) => [t.id, T.gateReport(t, ev(t), st)]));
  const reworks = new Map();
  for (const e of events) if (e.cmd === 'rework' && e.task) reworks.set(e.task, (reworks.get(e.task) || 0) + 1);

  const counts = Object.fromEntries(['accepted', 'submitted', 'in_progress', 'rework', 'ready', 'blocked', 'cancelled'].map((s) => [s, 0]));
  for (const s of display.values()) counts[s] += 1;

  // A task is "otherwise ready" when only owner input holds it: every
  // dependency accepted. Blocking such a task blocks work now.
  const depsDone = (t) => t.depends_on.every((d) => byKey.get(d) && byKey.get(d).status === 'accepted');
  const live = (t) => t.status !== 'accepted' && t.status !== 'cancelled';

  const decisions = st.decisions.decisions.filter((d) => d.status === 'open').sort(byId).map((d) => {
    const blocks = d.blocks.map((id) => byKey.get(id)).filter(Boolean);
    return {
      id: d.id, question: d.question, options: d.options, recommendation: d.recommendation, why: d.why,
      asked_by: d.asked_by, asked_at: d.asked_at, notes: d.notes || [],
      blocks: blocks.map((t) => ({ id: t.id, title: t.title, now: live(t) && depsDone(t) })),
      urgent: blocks.some((t) => live(t) && depsDone(t)),
    };
  }).sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const answered = st.decisions.decisions.filter((d) => d.status !== 'open').sort(byId).reverse();

  const ownerTasks = tasks.filter((t) => t.needs_owner && live(t))
    .map((t) => ({ id: t.id, title: t.title, needs: t.needs_owner, urgent: depsDone(t) }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || byId(a, b));

  // Messages addressed to the owner since the owner last wrote anything.
  const lastOwner = events.findLast((e) => e.agent === 'owner');
  const toOwner = events.filter((e) => e.cmd === 'msg' && e.detail && e.detail.to === 'owner' && (!lastOwner || e.at > lastOwner.at))
    .map((e, i) => ({ key: e.id || `M${i}`, at: e.at, agent: e.agent, task: e.task || null, text: String(e.detail.text || '') }));

  const exited = new Map(P.exitedClaims(st, events, { includeTail: false }).map((x) => [x.id, x]));
  const stuck = [];
  for (const t of tasks) {
    if (t.status === 'in_progress' && t.claim) {
      const ex = exited.get(t.id);
      const stall = ev(t).findLast((e) => e.cmd === 'stall' && e.at >= (t.claim.since || ''));
      if (ex) stuck.push({ id: t.id, title: t.title, what: `${ex.agent} exited without submitting${ex.code != null ? ` (exit ${ex.code})` : ''}`, since: null, fix: `release ${t.id} --reason "spawned process exited without submit"` });
      else if (T.leaseExpired(t, now)) stuck.push({ id: t.id, title: t.title, what: `${t.claim.agent}'s lease ran out${stall ? ' with no progress' : ''}`, since: t.claim.until, fix: `release ${t.id} --reason "lease ran out" --agent owner` });
    }
    if (t.status === 'submitted') {
      const failed = (reports.get(t.id) || { gates: [] }).gates.filter((g) => !g.ok && /failed/.test(g.reason));
      if (failed.length) stuck.push({ id: t.id, title: t.title, what: `${failed.map((g) => g.type).join(', ')} failed at ${String(t.sha).slice(0, 7)}`, since: null, fix: `rework ${t.id} --reason "what to fix"` });
    }
    if (live(t) && (reworks.get(t.id) || 0) >= REWORK_LOOP) stuck.push({ id: t.id, title: t.title, what: `sent back ${reworks.get(t.id)} times`, since: null, fix: `task show ${t.id}` });
  }

  const working = [];
  for (const t of tasks) {
    if (t.status !== 'in_progress' && t.status !== 'submitted') continue;
    if (t.status === 'in_progress' && (!t.claim || T.leaseExpired(t, now))) continue;
    const report = reports.get(t.id) || null;
    const lease = t.claim ? (() => {
      const since = Date.parse(t.claim.since || t.claim.until);
      const until = Date.parse(t.claim.until);
      const left = until - now;
      return { since: t.claim.since, until: t.claim.until, left, frac: until > since ? Math.max(0, Math.min(1, left / (until - since))) : 0, warn: left < LEASE_WARN_MS };
    })() : null;
    working.push({
      id: t.id, title: t.title, status: t.status, tier: t.tier, agent: t.claim ? t.claim.agent : t.submitted_by,
      rung: rungOfClaim(t, ev(t), ladder), phase: phaseOf(t, ev(t), report), run: runOf(st, t, ev(t)), lease,
      last: lastWord(t, ev(t)), spend: spendOf(t), gates: report ? gatePips(t, ev(t), report) : null,
      sha: t.sha, pr: t.pr, stack: t.stack, github_stack: t.github_stack, reworks: reworks.get(t.id) || 0,
    });
  }
  // Live claims first, by lease end; then submitted, oldest first.
  working.sort((a, b) => (a.status === b.status ? (a.lease && b.lease ? a.lease.left - b.lease.left : byId(a, b)) : a.status === 'in_progress' ? -1 : 1));

  const ready = T.readyTasks(st, now).map(({ task, unblocks: n }) => ({ id: task.id, title: task.title, tier: task.tier, kind: task.kind, size: task.size, unblocks: n, rework: task.status === 'rework' }));
  const blocked = T.blockedTasks(st, now).map(({ task, reasons }) => ({ id: task.id, title: task.title, tier: task.tier, reasons, owner: !!task.needs_owner || reasons.some((r) => r.startsWith('waits for decision')) }));

  const items = events.map((e, i) => eventItem(e, i, st));
  const history = items.slice(-HISTORY_LIMIT).reverse();
  const digest = items.filter((x) => !x.quiet).slice(-DIGEST_LIMIT).reverse();

  // Spend, by task, rung and model.
  const byRung = new Map();
  const byModel = new Map();
  let spawnsWithout = 0;
  const add = (map, key, e) => {
    const r = map.get(key) || { key, tokens: 0, input: 0, cached: 0, output: 0, minutes: 0, entries: 0, known: 0 };
    r.entries += 1;
    r.minutes += e.minutes || 0;
    if (e.tokens != null) {
      r.known += 1;
      r.tokens += e.tokens;
      r.input += e.input || 0;
      r.cached += e.cached || 0;
      r.output += e.output || 0;
    }
    map.set(key, r);
  };
  for (const t of tasks) {
    for (const e of spendOf(t).entries) {
      add(byRung, e.rung || 'unrecorded', e);
      add(byModel, e.model || (e.profile ? `profile ${e.profile}` : 'unrecorded'), e);
      if (e.tokens === null && !e.live && String(e.source || '').startsWith('spawn:')) spawnsWithout += 1;
    }
  }
  const minutes = tasks.reduce((s, t) => s + spendOf(t).minutes, 0);
  const tokens = tasks.reduce((s, t) => s + spendOf(t).tokens, 0);
  const spend = {
    minutes, hours: Math.round((minutes / 60) * 10) / 10, tokens,
    input: tasks.reduce((s, t) => s + (spendOf(t).input || 0), 0),
    cached: tasks.reduce((s, t) => s + (spendOf(t).cached || 0), 0),
    output: tasks.reduce((s, t) => s + (spendOf(t).output || 0), 0),
    budget_hours: st.project.budget ? st.project.budget.hours : null,
    budget_tokens: st.project.budget ? st.project.budget.tokens : null,
    spawns_without_usage: spawnsWithout,
    live: tasks.flatMap((t) => T.liveSpend({ ...t, spend: spendOf(t) }, now)),
    by_rung: [...L.RUNGS, 'unrecorded'].filter((n) => byRung.has(n)).map((n) => ({ ...byRung.get(n), rung: rungFor(ladder, n) })),
    by_model: [...byModel.values()].sort((a, b) => b.tokens - a.tokens || b.minutes - a.minutes),
    by_task: tasks.filter((t) => spendOf(t).tokens || spendOf(t).minutes).map((t) => ({ id: t.id, title: t.title, status: display.get(t.id), tier: t.tier, reworks: reworks.get(t.id) || 0, ...spendOf(t) }))
      .sort((a, b) => b.tokens - a.tokens || b.minutes - a.minutes),
  };
  const budget = [
    { what: 'Tokens', used: tokens, limit: spend.budget_tokens, flag: '--budget-tokens', unit: 'tokens' },
    { what: 'Agent time', used: minutes / 60, limit: spend.budget_hours, flag: '--budget-hours', unit: 'hours' },
  ].filter((b) => b.limit > 0 && Math.round(b.used / b.limit * 100) >= 90)
    .map((b) => ({ ...b, percent: Math.round(b.used / b.limit * 100) }));

  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.depends_on) if (dependents.has(d)) dependents.get(d).push(t.id);
  const sheets = tasks.map((t) => {
    const report = reports.get(t.id) || null;
    return {
      id: t.id, title: t.title, kind: t.kind, size: t.size, tier: t.tier, revision: t.revision, status: display.get(t.id), stored: t.status,
      acceptance: t.acceptance, needs: t.needs_owner, claim: t.claim, expired: T.leaseExpired(t, now), branch: t.branch, pr: t.pr, sha: t.sha, submitted_by: t.submitted_by, stack: t.stack, github_stack: t.github_stack,
      blockers: ['todo', 'rework'].includes(T.effectiveStatus(t, now)) ? T.blockReasons(st, t, now) : [],
      decisions: st.decisions.decisions.filter((d) => d.blocks.includes(t.id)).map((d) => ({ id: d.id, question: d.question, status: d.status, answer: d.answer })),
      depends_on: t.depends_on.map((id) => ({ id, title: byKey.get(id) ? byKey.get(id).title : '(missing)', status: display.get(id) || 'blocked' })),
      dependents: dependents.get(t.id).map((id) => ({ id, title: byKey.get(id).title, status: display.get(id) })),
      gates: t.sha || t.status === 'submitted' || t.status === 'accepted' ? gatePips(t, ev(t), report) : null,
      report,
      phase: phaseOf(t, ev(t), report), run: runOf(st, t, ev(t)),
      ledger: ledger(t, ev(t), st),
      thread: thread(t, ev(t)),
      spend: spendOf(t),
      reworks: reworks.get(t.id) || 0,
      unblocks: unblocks.get(t.id) || 0,
      rung: rungFor(ladder, t.tier),
    };
  });

  return {
    project: { name: st.project.name, goal: st.project.goal, repo: st.project.repo, base: st.project.base },
    generated_at: new Date(now).toISOString(),
    now,
    ladder,
    total: tasks.length,
    counts,
    display,
    attention: { decisions, owner: ownerTasks, messages: toOwner, stuck, budget, count: decisions.length + ownerTasks.length + toOwner.length + budget.length },
    answered,
    working,
    ready,
    blocked,
    digest,
    history,
    events_total: events.length,
    spend,
    sheets,
    tasks,
  };
}

module.exports = { build, compact, PHASES, describeEvent, HISTORY_LIMIT };
