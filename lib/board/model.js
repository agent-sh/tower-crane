'use strict';

// The board's view model: everything the rooms draw, computed once from the
// state and the event log through the same functions the CLI uses. Nothing
// here writes, and nothing here knows about HTML.

const S = require('../state');
const T = require('../tasks');
const L = require('../ladder');
const P = require('../processes');
const Authority = require('../authority');
const Runaway = require('../runaway');
const TestsPolicy = require('../tests-policy');
const { byId, shaMatch } = require('../util');

const PHASES = ['claimed', 'working', 'submitted', 'gates', 'accepted', 'merged'];
const HISTORY_LIMIT = 400;
const DIGEST_LIMIT = 80;
// A lease this close to its end is flagged on its row.
const LEASE_WARN_MS = 10 * 60e3;
// Readings drawn in an agent row's burn spark.
const SPARK = 24;
// A budget this far spent is a Now item (docs/human-experience.md 3.2).
const BUDGET_NOW = 90;

// What each event means to a person reading the board. kind groups events for
// History's filters; quiet events stay out of the board's digest.
const KINDS = {
  claim: 'flow', submit: 'flow', accept: 'flow', rework: 'flow', release: 'flow', spawn: 'flow', merge: 'gates', 'check merge': 'gates',
  'check tests': 'gates', 'check clean': 'gates', 'check sources': 'gates', 'check ci': 'gates', evidence: 'gates',
  ask: 'decisions', answer: 'decisions', 'decision withdraw': 'decisions', 'decision note': 'messages', 'owner-done': 'owner',
  msg: 'messages', 'task note': 'messages', 'worker-exited': 'trouble', stall: 'trouble', 'budget stop': 'trouble', 'msg refused': 'trouble',
  'project set': 'settings', 'ladder set': 'settings', 'ladder harness': 'settings', 'ladder save-user': 'settings', setting: 'settings',
};
const QUIET = new Set(['renew', 'spend', 'spend live', 'brief set', 'worktree', 'spawn exit', 'role set', 'init', 'hook progress', 'spawn phase']);

// The digest's groups, in reading order, and the events each holds.
const GROUPS = [
  ['trouble', 'Trouble', (x) => x.kind === 'trouble'],
  ['decided', 'Decisions', (x) => x.cmd === 'ask' || x.cmd === 'answer' || x.cmd === 'decision withdraw'],
  ['accepted', 'Accepted and merged', (x) => x.cmd === 'accept' || ((x.cmd === 'merge' || x.cmd === 'check merge') && x.tone === 'done')],
  ['back', 'Sent back', (x) => x.cmd === 'rework' || x.tone === 'fault'],
  ['submitted', 'Submitted', (x) => x.cmd === 'submit'],
  ['settings', 'Settings changed', (x) => x.kind === 'settings' || (x.cmd === 'task update' && /tier|budget/.test(x.text))],
  ['messages', 'Messages', (x) => x.kind === 'messages' || x.kind === 'owner'],
  ['gates', 'Gates and reviews', (x) => x.kind === 'gates'],
  ['started', 'Started and released', (x) => ['claim', 'release', 'spawn'].includes(x.cmd)],
  ['plan', 'Plan changes', () => true],
];

// The words an owner-required request reads as: what it changes, and how to
// read the current value from the project.
const SETTING_WORDS = {
  'merge-admin': ['admin merges', (p) => (p.merge && p.merge.admin ? 'on' : 'off'), (v) => (String(v) === 'true' ? 'on' : 'off')],
  'budget-tokens': ['the token budget', (p) => (p.budget.tokens == null ? 'no limit' : compact(p.budget.tokens)), (v) => (v == null || v === 'null' ? 'no limit' : compact(Number(v)))],
  'budget-hours': ['the hours budget', (p) => (p.budget.hours == null ? 'no limit' : `${p.budget.hours} h`), (v) => (v == null || v === 'null' ? 'no limit' : `${v} h`)],
  'research-min-sources': ['the research source minimum', (p) => String((p.research && p.research.min_sources) || 10), String],
};

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
      if (d.escalation && !d.escalation.settings.includes('budget.raise')) return `${e.agent} asked${id ? ` ${id}` : ''} to ${clip(requestChange(d.escalation, st && st.project), 200)}`;
      if (d.escalation) return `${e.agent} asked${id ? ` ${id}` : ''}: ${clip(requestSentence(d.escalation, st && st.project, e.agent), 200)}`;
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
    case 'stall': return `${t} stalled: no progress from ${d.agent || e.agent}`;
    case 'task add': return `${e.agent} added ${t}${d.title ? `: ${clip(d.title, 120)}` : ''}`;
    case 'plan import': return `${e.agent} imported ${t}${d.title ? `: ${clip(d.title, 120)}` : ''}`;
    case 'task update': return `${e.agent} updated ${t}${d.tier ? ` (tier ${d.tier})` : ''}${d.budget ? ` (budget ${[d.budget.tokens != null && `${compact(d.budget.tokens)} tokens`, d.budget.hours != null && `${d.budget.hours} h`].filter(Boolean).join(', ') || 'none'})` : ''}`;
    case 'project set': return `${e.agent} changed ${Object.keys(d).filter((k) => !['via', 'authority', 'mode'].includes(k)).join(', ') || 'project settings'}`;
    case 'ladder set': return `${e.agent} changed the ${d.rung || ''} rung`.replace('  ', ' ');
    case 'ladder harness': return `${e.agent} set the default harness to ${d.harness}`;
    case 'ladder save-user': return `${e.agent} saved the ladder to the user file`;
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
  return String(Math.round(n));
}

// An escalation as the sentence the owner approves: who asks, what changes,
// from what to what.
function requestSentence(esc, project, asker = 'the orchestrator') {
  const change = esc.change || {};
  if (esc.settings.includes('budget.raise') && change.scope) {
    const what = change.what === 'hours' ? 'hours' : 'token';
    const where = change.scope === 'project' ? 'the project' : change.scope;
    return `${where} was stopped at its ${what} budget of ${change.what === 'hours' ? `${change.limit} h` : compact(change.limit)}; raise it to let it run again`;
  }
  return `${asker} asks to ${requestChange(esc, project)}`;
}

function requestChange(esc, project) {
  const parts = Object.entries(esc.change || {}).map(([flag, value]) => {
    const w = SETTING_WORDS[flag];
    if (!w || !project) return `set ${flag} to ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    return `${w[0]}: ${w[1](project)} to ${w[2](value)}`;
  });
  return `change ${parts.join('; ') || esc.settings.join(', ')}`;
}

function eventItem(e, i, st) {
  const d = e.detail || {};
  const kind = KINDS[e.cmd] || 'plan';
  let tone = '';
  if (e.cmd === 'rework' || e.cmd === 'worker-exited' || e.cmd === 'stall' || e.cmd === 'budget stop' || e.cmd === 'msg refused') tone = 'fault';
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
    quiet: QUIET.has(e.cmd) || (e.cmd === 'evidence' && d.type === 'note') || (e.cmd === 'task update' && !d.tier && !d.budget),
    owner: e.agent === 'owner',
    text: describeEvent(e, st),
  };
}

// Where a task sits in claim, work, submit, gates, accept, merge.
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
  if (last.cmd.startsWith('check ')) return { step: 1, label: `running the ${last.cmd.slice(6)} gate` };
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

// What a pass of each gate proves, in one sentence, under the project's policy.
function proved(type, st, task) {
  const mode = TestsPolicy.resolve(st.project, task.kind).mode;
  switch (type) {
    case 'tests': return mode === 'prove' ? 'the tests pass at this commit, and the changed tests fail without the change' : mode === 'run-only' ? 'the tests pass at this commit' : 'no tests are required for this kind';
    case 'clean': return 'the cleanup tool found nothing high against the base';
    case 'review': return 'a clean-context reviewer checked the acceptance at this commit';
    case 'ci': return 'the required CI checks passed at this commit';
    case 'sources': return 'every cited quote was fetched again and matched its page';
    case 'merge': return 'the pull request merged';
    default: return '';
  }
}

function gatePips(task, events, report, st) {
  const required = T.requiredGates(task);
  const evidence = (type) => T.latestGateEvidence(task, type, events)
    || task.evidence.findLast((e) => e.type === type && e.revision === task.revision && shaMatch(e.sha, task.sha)
      && (e.type !== 'review' || T.eligibleGateEvidence(task, e, events)));
  const list = report ? report.gates.map((g) => {
    const latest = evidence(g.type);
    let state = 'missing';
    if (g.ok) state = g.waived ? 'waived' : 'pass';
    else if (latest && latest.ok === false) state = 'fail';
    return { type: g.type, state, reason: g.reason, latest };
  }) : required.map((type) => {
    const latest = task.sha ? T.latestGateEvidence(task, type, events) : null;
    let state = 'missing';
    if (latest) state = latest.waived ? 'waived' : latest.ok ? 'pass' : 'fail';
    return { type, state, reason: latest ? `${latest.ok ? 'ok' : 'failed'} by ${latest.agent}` : task.sha ? `no ${type} evidence at ${task.sha.slice(0, 7)}` : 'nothing submitted yet', latest };
  });
  return list.map(({ latest, ...g }) => ({
    ...g,
    proved: st ? proved(g.type, st, task) : '',
    sha: latest && latest.sha ? latest.sha : null,
    agent: latest ? latest.agent : null,
    at: latest ? latest.at : null,
    command: latest && Array.isArray(latest.commands) && latest.commands.length ? [latest.commands[0].command, ...(latest.commands[0].args || [])].join(' ') : null,
    waiver: latest && latest.waived ? { reason: latest.summary || latest.reason || '', agent: latest.agent, at: latest.at } : null,
  }));
}

// One line that answers "can this merge, and if not, what is missing".
function verdict(gates) {
  const failed = gates.filter((g) => g.state === 'fail').map((g) => g.type);
  const missing = gates.filter((g) => g.state === 'missing').map((g) => g.type);
  if (!failed.length && !missing.length) return { ok: true, text: 'ready to accept' };
  return { ok: false, text: [failed.length && `failed: ${failed.join(', ')}`, missing.length && `missing: ${missing.join(', ')}`].filter(Boolean).join('; ') };
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
      const gate = T.gateReport({ ...task, evidence: [e] }, events, st).gates.find((x) => x.type === 'sources');
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

// How a message reaches an agent on its harness (docs/cli.md, messages).
function delivery(harness) {
  if (['claude', 'codex', 'pi', 'opencode'].includes(harness)) return 'delivered into the session at its next tool call';
  if (harness === 'agy') return 'queued: agy has no delivery adapter yet';
  if (harness === 'command') return 'queued for the next resume unless its adapter reads the hook binding';
  return 'recorded for the agent; it reads it with tower-crane wait';
}

// The agent's live readings since its claim, oldest first: tokens and time.
function readings(events, task, agent, since) {
  return events.filter((e) => e.cmd === 'spend live' && e.task === task && (e.detail.agent || e.agent) === agent && (!since || e.at >= since))
    .map((e) => ({ at: e.at, tokens: e.detail.tokens }));
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

  // ---- spend ----
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
  const liveAll = tasks.flatMap((t) => T.liveSpend({ ...t, spend: spendOf(t) }, now));
  const run = Runaway.runaways(st, now, events);
  const norms = run.norms;
  // The current burn of running agents, from their own readings over at most
  // the last hour; without live agents, what was recorded in the last hour.
  let rate = null;
  let rateFrom = null;
  const counted = liveAll.filter((l) => l.state === 'live' && l.tokens != null);
  if (counted.length) {
    rate = 0;
    for (const l of counted) {
      const r = readings(events, l.task, l.agent, null).filter((x) => x.tokens != null && now - Date.parse(x.at) <= 3600e3);
      if (r.length >= 2) rate += ((r.at(-1).tokens - r[0].tokens) / Math.max(1, Date.parse(r.at(-1).at) - Date.parse(r[0].at))) * 3600e3;
    }
    rateFrom = 'live';
  } else {
    const hour = events.filter((e) => e.cmd === 'spend' && e.detail && e.detail.tokens && now - Date.parse(e.at) <= 3600e3);
    if (hour.length) { rate = hour.reduce((n, e) => n + e.detail.tokens, 0); rateFrom = 'recorded'; }
  }
  const budgetTokens = st.project.budget ? st.project.budget.tokens : null;
  const budgetHours = st.project.budget ? st.project.budget.hours : null;
  const projection = budgetTokens && rate > 0 ? Math.max(0, budgetTokens - tokens) / rate * 3600e3 : null;
  const freshest = counted.length ? Math.max(...counted.map((l) => l.age_s)) : null;
  const top = tasks.filter((t) => spendOf(t).tokens > 0)
    .map((t) => {
      const tier = norms.tiers[t.tier] || {};
      const i = L.TIERS.indexOf(t.tier);
      return { id: t.id, title: t.title, tier: t.tier, tokens: spendOf(t).tokens, median: tier.median || null, cheaper: live(t) && i > 0 && i < 3 ? L.TIERS[i - 1] : null, status: display.get(t.id) };
    })
    .sort((a, b) => b.tokens - a.tokens).slice(0, 3);
  const spend = {
    minutes, hours: Math.round((minutes / 60) * 10) / 10, tokens,
    input: tasks.reduce((s, t) => s + (spendOf(t).input || 0), 0),
    cached: tasks.reduce((s, t) => s + (spendOf(t).cached || 0), 0),
    output: tasks.reduce((s, t) => s + (spendOf(t).output || 0), 0),
    budget_hours: budgetHours,
    budget_tokens: budgetTokens,
    spawns_without_usage: spawnsWithout,
    live: liveAll,
    not_counted: liveAll.filter((l) => l.state !== 'live' || l.tokens == null).length,
    rate_per_hour: rate, rate_from: rateFrom, projection_ms: projection, fresh_s: freshest,
    top, norms,
    by_rung: [...L.RUNGS, 'unrecorded'].filter((n) => byRung.has(n)).map((n) => ({ ...byRung.get(n), rung: rungFor(ladder, n) })),
    by_model: [...byModel.values()].sort((a, b) => b.tokens - a.tokens || b.minutes - a.minutes),
    by_task: tasks.filter((t) => spendOf(t).tokens || spendOf(t).minutes).map((t) => ({ id: t.id, title: t.title, status: display.get(t.id), tier: t.tier, reworks: reworks.get(t.id) || 0, ...spendOf(t) }))
      .sort((a, b) => b.tokens - a.tokens || b.minutes - a.minutes),
  };

  // ---- the queue: Now, then Your turn ----
  const queue = [];
  const blocking = (ids) => ids.map((id) => byKey.get(id)).filter(Boolean).map((t) => ({ id: t.id, title: t.title, now: live(t) && depsDone(t), waits: t.depends_on.filter((d) => byKey.get(d) && byKey.get(d).status !== 'accepted') }));
  for (const d of st.decisions.decisions.filter((x) => x.status === 'open').sort(byId)) {
    const blocks = blocking(d.blocks);
    const urgent = blocks.some((b) => b.now);
    queue.push({
      key: d.id, kind: d.escalation ? 'approval' : 'decision', tier: urgent && !d.escalation ? 'now' : 'turn', at: d.asked_at,
      id: d.id, question: d.question, options: d.options, recommendation: d.recommendation, why: d.why, asked_by: d.asked_by, notes: d.notes || [], blocks,
      escalation: d.escalation || null,
      sentence: d.escalation ? requestSentence(d.escalation, st.project, d.asked_by) : null,
      settings: d.escalation ? d.escalation.settings.map((k) => ({ key: k, class: Authority.classOf(k), use: Authority.TABLE[k] ? Authority.TABLE[k][1] : '' })) : [],
    });
  }
  for (const t of tasks.filter((x) => x.needs_owner && live(x))) {
    queue.push({ key: `owner-${t.id}`, kind: 'owner', tier: 'turn', at: (ev(t).findLast((e) => e.cmd === 'task add' || e.cmd === 'task update') || {}).at || null, id: t.id, title: t.title, needs: t.needs_owner, now: depsDone(t), unblocks: unblocks.get(t.id) || 0 });
  }
  // Messages addressed to the owner since the owner last wrote anything.
  const lastOwner = events.findLast((e) => e.agent === 'owner');
  for (const [i, e] of events.entries()) {
    if (e.cmd !== 'msg' || !e.detail || e.detail.to !== 'owner' || (lastOwner && e.at <= lastOwner.at)) continue;
    const t = e.task ? byKey.get(e.task) : null;
    queue.push({ key: `msg-${e.id || `M${i}`}`, kind: 'message', tier: 'turn', at: e.at, agent: e.agent, task: e.task || null, text: String(e.detail.text || ''), reply: !!(t && t.claim && t.claim.agent === e.agent) });
  }
  const exited = new Map(P.exitedClaims(st, events, { includeTail: false }).map((x) => [x.id, x]));
  const stops = new Map();
  for (const t of tasks) {
    if (t.status !== 'in_progress' || !t.claim) continue;
    const stop = ev(t).findLast((e) => e.cmd === 'budget stop' && e.at >= (t.claim.since || '') && (e.detail.agent || e.agent) === t.claim.agent);
    if (stop) stops.set(t.id, stop);
  }
  for (const [id, x] of exited) {
    const t = byKey.get(id);
    if (stops.has(id)) continue;
    queue.push({ key: `stuck-${id}-exited`, kind: 'stuck', tier: 'now', at: null, id, title: t.title, agent: x.agent, text: `${x.agent} exited without submitting${x.code != null ? ` (exit ${x.code})` : ''}`, fix: ['release', id, '--reason', 'spawned process exited without submit', '--agent', 'owner'] });
  }
  for (const f of run.flags) {
    if (exited.has(f.task) || stops.has(f.task)) continue;
    const t = byKey.get(f.task);
    const supervised = P.supervised(st, t, ev(t));
    const lease = f.rule === 'lease' && !f.supervised;
    queue.push({
      key: `${lease ? 'stuck' : 'runaway'}-${f.task}-${f.rule}`, kind: lease ? 'stuck' : 'runaway', tier: 'now', at: f.since || null, id: f.task, title: f.title, agent: f.agent, rule: f.rule, text: f.text,
      stop: supervised && f.rule !== 'lease',
      fix: lease ? ['release', f.task, '--reason', 'lease ran out', '--agent', 'owner'] : null,
    });
  }
  for (const b of [
    { what: 'Token budget', used: tokens, limit: budgetTokens, flag: '--budget-tokens', unit: 'tokens' },
    { what: 'Hours budget', used: minutes / 60, limit: budgetHours, flag: '--budget-hours', unit: 'hours' },
  ]) {
    if (!(b.limit > 0)) continue;
    const percent = Math.round((b.used / b.limit) * 100);
    if (percent < BUDGET_NOW) continue;
    queue.push({ key: `budget-${b.flag}`, kind: 'budget', tier: 'now', at: null, ...b, percent, projection_ms: b.unit === 'tokens' ? projection : null, not_counted: spend.not_counted });
  }
  const tierOrder = { now: 0, turn: 1 };
  const weight = (q) => (q.kind === 'decision' && q.blocks.some((b) => b.now) ? 0 : q.kind === 'owner' && q.now ? 1 : 2);
  queue.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || weight(a) - weight(b) || String(a.at || '').localeCompare(String(b.at || '')));

  // ---- the floor: one row per agent at work ----
  const flagged = new Map();
  for (const f of run.flags) flagged.set(f.task, [...(flagged.get(f.task) || []), f.rule]);
  const floor = [];
  for (const t of tasks) {
    if (t.status !== 'in_progress' || !t.claim) continue;
    const since = Date.parse(t.claim.since || t.claim.until);
    const until = Date.parse(t.claim.until);
    const left = until - now;
    const lease = { since: t.claim.since, until: t.claim.until, left, frac: until > since ? Math.max(0, Math.min(1, left / (until - since))) : 0, warn: left < LEASE_WARN_MS };
    const rung = rungOfClaim(t, ev(t), ladder);
    const l = liveAll.find((x) => x.task === t.id && x.agent === t.claim.agent);
    const series = readings(ev(t), t.id, t.claim.agent, t.claim.since).filter((x) => x.tokens != null).slice(-SPARK - 1);
    const spark = series.slice(1).map((x, i) => Math.max(0, x.tokens - series[i].tokens));
    // The stale limit travels with the reading, so an open page can age it.
    const entry = (t.spend && t.spend.entries || []).filter((e) => e.live && e.agent === t.claim.agent).at(-1);
    const staleMs = entry && entry.live && entry.live.interval_ms ? T.LIVE_STALE * entry.live.interval_ms : null;
    const usage = l ? { state: l.state, tokens: l.tokens, age_s: l.age_s, at: l.at, stale_ms: staleMs, spark: l.state === 'live' ? spark : [] } : { state: 'exit', tokens: null, age_s: null, spark: [] };
    const stop = stops.get(t.id);
    const ex = exited.get(t.id);
    const supervised = P.supervised(st, t, ev(t));
    let stopped = null;
    if (stop) stopped = ex || !supervised ? 'exited' : 'stopping';
    floor.push({
      id: t.id, title: t.title, agent: t.claim.agent, tier: t.tier, rung, phase: phaseOf(t, ev(t), null), run: runOf(st, t, ev(t)), lease,
      expired: T.leaseExpired(t, now), last: lastWord(t, ev(t)), spend: spendOf(t), usage, flags: flagged.get(t.id) || [], exited: !!ex,
      supervised, stoppable: supervised && !stop && l && l.tokens != null, stopped, stop_breaches: stop ? stop.detail.breaches || [] : [],
      delivery: delivery(rung && rung.spawned ? rung.harness : null), reworks: reworks.get(t.id) || 0,
    });
  }
  // Live claims first, by lease end.
  floor.sort((a, b) => Number(!!a.stopped) - Number(!!b.stopped) || a.lease.left - b.lease.left);
  // Tasks a budget stop left waiting on the owner, after the claim is gone.
  const waiting = [];
  for (const d of st.decisions.decisions) {
    if (d.status !== 'open' || !d.escalation || !d.escalation.settings.includes('budget.raise')) continue;
    const id = d.escalation.change && d.escalation.change.scope;
    const t = byKey.get(id);
    if (t && !(t.status === 'in_progress' && t.claim)) waiting.push({ id, title: t.title, decision: d.id, text: requestSentence(d.escalation, st.project) });
  }

  // ---- review: submitted work and the waivers behind accepted work ----
  const review = [];
  for (const t of tasks.filter((x) => x.status === 'submitted')) {
    const report = reports.get(t.id) || null;
    const gates = gatePips(t, ev(t), report, st);
    const rev = t.evidence.filter((e) => e.type === 'review' && shaMatch(e.sha, t.sha)).at(-1) || null;
    const submit = ev(t).findLast((e) => e.cmd === 'submit');
    review.push({
      id: t.id, title: t.title, sha: t.sha, pr: t.pr, submitted_by: t.submitted_by, at: submit ? submit.at : null, gates, verdict: verdict(gates), acceptance: t.acceptance,
      review: rev ? { ok: rev.ok, agent: rev.agent, at: rev.at, ref: rev.ref || null, summary: String(rev.summary || ''), finding: String(rev.summary || '').split(/(?<=[.;])\s+/)[0] } : null,
      reworks: reworks.get(t.id) || 0, summary: submit && submit.detail.summary ? String(submit.detail.summary) : '',
      missing: gates.filter((g) => g.state !== 'pass' && g.state !== 'waived').map((g) => g.type),
    });
  }
  review.sort((a, b) => Number(a.verdict.ok) - Number(b.verdict.ok) || String(a.at).localeCompare(String(b.at)));
  const waivers = [];
  for (const e of events) {
    if (e.cmd !== 'accept' || !e.detail || !(e.detail.waived || []).length) continue;
    const t = byKey.get(e.task);
    // The reason is on the waived evidence the accept recorded.
    const entry = t && t.evidence.find((x) => x.waived && x.at === e.at && e.detail.waived.includes(x.type));
    waivers.push({ id: e.task, title: t ? t.title : e.task, gates: e.detail.waived, reason: entry ? String(entry.summary || '') : '', agent: e.agent, at: e.at, sha: e.detail.sha || null });
  }
  waivers.reverse();

  const ready = T.readyTasks(st, now).map(({ task, unblocks: n }) => ({ id: task.id, title: task.title, tier: task.tier, kind: task.kind, size: task.size, unblocks: n, rework: task.status === 'rework', held: task.status === 'in_progress' }));
  const blocked = T.blockedTasks(st, now).map(({ task, reasons }) => ({ id: task.id, title: task.title, tier: task.tier, reasons, owner: !!task.needs_owner || reasons.some((r) => r.startsWith('waits for decision')) }));

  const items = events.map((e, i) => eventItem(e, i, st));
  const history = items.slice(-HISTORY_LIMIT).reverse();
  const digest = items.filter((x) => !x.quiet).slice(-DIGEST_LIMIT).reverse();
  for (const x of digest) x.group = GROUPS.find(([, , fn]) => fn(x))[0];

  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.depends_on) if (dependents.has(d)) dependents.get(d).push(t.id);
  const sheets = tasks.map((t) => {
    const report = reports.get(t.id) || null;
    const row = floor.find((r) => r.id === t.id) || null;
    return {
      id: t.id, title: t.title, kind: t.kind, size: t.size, tier: t.tier, revision: t.revision, status: display.get(t.id), stored: t.status,
      acceptance: t.acceptance, needs: t.needs_owner, claim: t.claim, expired: T.leaseExpired(t, now), branch: t.branch, pr: t.pr, sha: t.sha, submitted_by: t.submitted_by, stack: t.stack, github_stack: t.github_stack,
      blockers: ['todo', 'rework'].includes(T.effectiveStatus(t, now)) ? T.blockReasons(st, t, now) : [],
      decisions: st.decisions.decisions.filter((d) => d.blocks.includes(t.id)).map((d) => ({ id: d.id, question: d.question, status: d.status, answer: d.answer })),
      depends_on: t.depends_on.map((id) => ({ id, title: byKey.get(id) ? byKey.get(id).title : '(missing)', status: display.get(id) || 'blocked' })),
      dependents: dependents.get(t.id).map((id) => ({ id, title: byKey.get(id).title, status: display.get(id) })),
      gates: t.sha || t.status === 'submitted' || t.status === 'accepted' ? gatePips(t, ev(t), report, st) : null,
      report,
      phase: phaseOf(t, ev(t), report), run: runOf(st, t, ev(t)),
      ledger: ledger(t, ev(t), st),
      thread: thread(t, ev(t)),
      spend: spendOf(t),
      reworks: reworks.get(t.id) || 0,
      unblocks: unblocks.get(t.id) || 0,
      rung: rungFor(ladder, t.tier),
      row,
    };
  });

  const nowCount = queue.filter((q) => q.tier === 'now').length;
  const working = floor.filter((r) => !r.stopped && !r.expired && !r.exited).length;
  const sentence = {
    need: queue.length, now: nowCount, turn: queue.length - nowCount, working, review: review.length,
    budget: budgetTokens ? Math.round((tokens / budgetTokens) * 100) : budgetHours ? Math.round((minutes / 60 / budgetHours) * 100) : null,
    budget_what: budgetTokens ? 'tokens' : budgetHours ? 'hours' : null,
    not_counted: spend.not_counted,
  };

  return {
    project: { name: st.project.name, goal: st.project.goal, repo: st.project.repo, base: st.project.base },
    generated_at: new Date(now).toISOString(),
    now,
    ladder,
    total: tasks.length,
    counts,
    display,
    queue,
    floor,
    waiting,
    review,
    waivers,
    sentence,
    attention: { count: queue.length, now: nowCount },
    answered: st.decisions.decisions.filter((d) => d.status !== 'open').sort(byId).reverse(),
    ready,
    blocked,
    digest,
    groups: GROUPS.map(([key, label]) => ({ key, label })),
    history,
    events_total: events.length,
    spend,
    sheets,
    tasks,
  };
}

module.exports = { build, compact, PHASES, describeEvent, requestSentence, HISTORY_LIMIT, KINDS };
