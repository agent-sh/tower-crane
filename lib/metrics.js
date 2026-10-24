'use strict';

// Efficiency metrics from the event log alone. The report streams
// events.jsonl up to its size when it starts, parses only the event types it
// uses, and keeps a compact record per task, so it runs without the state
// lock, never loads the state and writes nothing.
const fs = require('node:fs');
const path = require('node:path');
const Cause = require('./rework-cause');
const { usage } = require('./util');

const WANTED = new Set(['task add', 'plan import', 'claim', 'release', 'submit', 'rework', 'accept', 'merge',
  'check tests', 'check clean', 'check ci', 'evidence', 'head check', 'gate run', 'review dispatch deferred',
  'spawn', 'spawn exit', 'spend', 'spend live', 'stack sync']);

const HOUR = 3600e3;
// A failing test counts as another task's too when that task failed it within this distance.
const CROSS_TASK_MS = 24 * HOUR;
const GATES = ['tests', 'clean', 'review', 'ci', 'head_check'];
const PHASES = ['queued', 'working', 'waiting_for_gates', 'gating', 'reviewing', 'rework_waiting', 'accepted_to_merged'];

const DEFINITIONS = {
  window: 'tasks with an ok merge event at or after since and before until; each such task is reported with its whole history, also before since',
  cohort: 'with --claimed-after, only tasks whose first claim is at or after that time count, in every metric; tasks never claimed are excluded',
  percentile: 'nearest rank: the value at position ceil(p * n) in ascending order',
  merges: 'merge events with ok true, one per task and sha, by the local day of the first such event',
  gate_runs: 'per merged task, whole history: tests, clean and ci count check events with a verdict (ci polls still pending excluded), review counts review evidence, head_check counts head check events',
  governor_deferrals: 'gate run attempts that ended in error because the host governor deferred or stopped them, and deferred review dispatches',
  tests_wall_ms: 'per merged task, the sum of tests gate runs from their running to their done phase',
  tests_cpu_ms: 'CPU time of tests gate runs; no receipt records it yet, so it is null with its coverage',
  reworks: 'rework events: recorded cause, else classified from the reason text and the gate evidence of the same head; tests and head_check reworks whose every failing test failed in another task (not a stack parent or child) within 24 hours are cross_task',
  head_check_culprit: 'a head check rework has a culprit when a failing test file it names is among the files the task changed (from its latest tests gate receipt)',
  tc_caused: `causes Tower Crane, the host or the base produced: ${[...Cause.TC].join(', ')}, and head_check without a culprit`,
  reworks_raised: 'every rework event raised in the window, for any task the cohort admits, merged or not',
  tokens: 'per merged task, the final spend entry per spawn source (the last spend or spend live event) plus every manual entry; worker, reviewer and other by agent name prefix',
  tokens_complete: 'percentiles over merged tasks with no live entry and no entry of unknown tokens (a manual report of minutes alone claims no tokens and does not count as unknown); known_lower_bound sums the known entries of every merged task',
  entries_without_tokens: 'spend entries with no token count, never counted as zero: live (not finalized), spawn (usage not collected) and manual (minutes only, or a manual breakdown without a total)',
  lead_time: 'first task add (else the first event of the task) to its first ok merge in the window, split by the transitions claim, release, submit, rework, accept and merge',
  phases: {
    queued: 'created or released before any submit, until a claim',
    working: 'claimed until submit, release or rework',
    waiting_for_gates: 'submitted time not covered by a gate run or a review session: the gate queue, governor deferrals and pending CI',
    gating: 'submitted or accepted time covered by tests, clean or final review gate runs, or by head checks that record started_at',
    reviewing: 'submitted time covered by a reviewer session and not already gating',
    rework_waiting: 'after a rework or a release that follows a submit, until the next claim',
    accepted_to_merged: 'accepted until merged, not gating: the merge queue and the merge itself',
  },
  phases_partition: 'the phases of a task add up to its lead time',
  waiting_share: 'queued + waiting_for_gates + rework_waiting + accepted_to_merged, over the summed lead time',
  submits: 'submit events per merged task',
  first_pass_ms: 'first claim to first submit',
};

function parseTime(text, flag, now) {
  const rel = /^(\d+(?:\.\d+)?)([dhm])$/.exec(text);
  if (rel) return now - Number(rel[1]) * { d: 24 * HOUR, h: HOUR, m: 60e3 }[rel[2]];
  const at = Date.parse(text);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(at)) throw usage(`--${flag} must be an ISO time or a relative age such as 7d, 12h or 30m, got ${text}`);
  return at;
}

function pct(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.max(0, Math.ceil(p * v.length) - 1)];
}

function stats(values) {
  if (!values.length) return { n: 0, p50: null, p90: null, mean: null, sum: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { n: values.length, p50: pct(values, 0.5), p90: pct(values, 0.9), mean: Math.round((sum / values.length) * 100) / 100, sum };
}

// Failing test names without the runner's duration suffix.
function testName(name) {
  return String(name).replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '').trim();
}

// Failing tests named in a gate or head check summary: the gate's list, or
// node:test's failing-tests block with the file of each.
function failures(text) {
  text = String(text || '');
  const names = new Set();
  const files = new Set();
  const list = /Failing tests:\n((?:- .*\n?)+)/.exec(text);
  if (list) for (const line of list[1].split('\n')) if (line.startsWith('- ')) names.add(testName(line.slice(2)));
  // A summary keeps the output's last lines, which can start inside that block.
  for (const line of text.split('\n')) {
    const at = /^test at (.+?):\d+:\d+$/.exec(line.trim());
    if (at) files.add(at[1].replace(/\\/g, '/').replace(/^.*?\b(test\/)/, '$1'));
    else if (line.startsWith('✖ ') && !/^✖ failing tests:/.test(line)) names.add(testName(line.slice(2)));
  }
  return { names: [...names], files: [...files] };
}

function task(tasks, id) {
  let t = tasks.get(id);
  if (!t) {
    t = { id, created: null, firstClaim: null, firstSubmit: null, submits: 0, transitions: [], reworks: [], merges: [],
      gates: { tests: 0, clean: 0, review: 0, ci: 0, head_check: 0 }, deferrals: { tests: 0, clean: 0, review: 0 },
      runs: new Map(), reviewers: new Map(), headChecks: [], spend: new Map(), manual: [], checks: new Map(), changed: null };
    tasks.set(id, t);
  }
  return t;
}

// One pass over the log up to `size`. Lines are found in the bytes and only
// those of a wanted event type are decoded and parsed; a final fragment
// without a newline is a torn append and is left out.
const CMD = Buffer.from('"cmd":"');
function scan(file, onEvent) {
  const fd = fs.openSync(file, 'r');
  const log = { bytes: 0, lines: 0, parsed: 0, unreadable: 0, torn_last_line: false };
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 1 << 20));
    const line = (bytes) => {
      log.lines++;
      const i = bytes.indexOf(CMD);
      if (i === -1) return;
      const cmd = bytes.toString('latin1', i + CMD.length, bytes.indexOf(34, i + CMD.length));
      if (!WANTED.has(cmd)) return;
      let event;
      try { event = JSON.parse(bytes.toString('utf8')); } catch { log.unreadable++; return; }
      log.parsed++;
      onEvent(event);
    };
    let carry = null;
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (!n) break;
      pos += n;
      const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        if (end > start) line(chunk.subarray(start, end));
        start = end + 1;
      }
      // The read buffer is reused, so a partial line is copied out.
      carry = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
    }
    log.bytes = pos;
    if (carry && carry.toString('utf8').trim()) log.torn_last_line = true;
  } finally {
    fs.closeSync(fd);
  }
  return log;
}

function collect(file) {
  const tasks = new Map();
  const failed = new Map();
  const relatives = new Map();
  const relate = (a, b) => {
    for (const [x, y] of [[a, b], [b, a]]) (relatives.get(x) || relatives.set(x, new Set()).get(x)).add(y);
  };
  const failing = (id, at, names) => {
    for (const name of names) (failed.get(name) || failed.set(name, []).get(name)).push({ task: id, at });
  };
  const log = scan(file, (e) => {
    if (!e.task || typeof e.task !== 'string') return;
    const t = task(tasks, e.task);
    const d = e.detail || {};
    const at = Date.parse(e.at);
    if (Number.isNaN(at)) return;
    t.created ??= at;
    switch (e.cmd) {
      case 'task add': case 'plan import': t.created = Math.min(t.created, at); break;
      case 'claim':
        t.firstClaim ??= at;
        t.transitions.push([at, 'claim']);
        break;
      case 'release': t.transitions.push([at, 'release']); break;
      case 'submit':
        t.submits++;
        t.firstSubmit ??= at;
        t.transitions.push([at, 'submit']);
        break;
      case 'rework':
        t.reworks.push({ at, detail: d, checks: new Map(t.checks), changed: t.changed });
        t.transitions.push([at, 'rework']);
        break;
      case 'accept': t.transitions.push([at, 'accept']); break;
      case 'merge':
        if (d.ok === true && !t.merges.some((m) => m.sha === d.sha)) {
          t.merges.push({ at, sha: d.sha });
          t.transitions.push([at, 'merge']);
        }
        break;
      case 'check tests': case 'check clean': case 'check ci': {
        const type = e.cmd.slice(6);
        if (type === 'ci' && d.pending) break;
        t.gates[type]++;
        if (d.ok === false) {
          t.checks.set(`${type}:${String(d.sha).slice(0, 10)}`, { summary: d.summary || '', main_failure: d.main_failure, timeout: d.timeout,
            infrastructure_failure: d.infrastructure_failure, runner_crash: d.runner_crash });
          if (type === 'tests') failing(t.id, at, (d.test_failure?.names || []).map(testName));
        }
        if (type === 'tests' && Array.isArray(d.receipt?.changed_files)) t.changed = d.receipt.changed_files;
        break;
      }
      case 'evidence': if (d.type === 'review') t.gates.review++; break;
      case 'head check':
        t.gates.head_check++;
        t.headChecks.push({ at, started: d.started_at ? Date.parse(d.started_at) : null });
        if (d.ok === false) failing(t.id, at, failures(d.summary).names);
        break;
      case 'gate run': {
        const run = t.runs.get(d.source) || t.runs.set(d.source, { type: d.type, start: null, end: null, phase: null }).get(d.source);
        if (d.phase === 'running') run.start ??= at;
        else if (d.phase === 'done' || d.phase === 'error') {
          run.end = at;
          run.phase = d.phase;
          if (d.phase === 'error' && /by the host governor/.test(d.error || '') && t.deferrals[d.type] !== undefined) t.deferrals[d.type]++;
        }
        break;
      }
      case 'review dispatch deferred': t.deferrals.review++; break;
      case 'spawn':
        if (d.role === 'reviewer' && d.agent) {
          const r = t.reviewers.get(d.agent) || t.reviewers.set(d.agent, { start: at, end: null }).get(d.agent);
          r.start = Math.min(r.start, at);
        }
        break;
      case 'spawn exit': {
        const r = t.reviewers.get(d.agent);
        if (r) r.end = Math.max(r.end ?? at, at);
        break;
      }
      case 'spend': case 'spend live': {
        const entry = { agent: d.agent || e.agent, tokens: d.tokens ?? null, input: d.input ?? null, rung: d.rung || null,
          harness: d.harness || null, source: d.source || 'manual', live: e.cmd === 'spend live' && !!d.live };
        if (entry.source === 'manual') t.manual.push(entry);
        else t.spend.set(entry.source, entry);
        break;
      }
      case 'stack sync': if (d.parent) relate(t.id, d.parent); break;
      default: break;
    }
  });
  return { tasks, failed, relatives, log };
}

// Each rework's cause, its culprit for a head check, and whether Tower Crane caused it.
function classify(t, rework, { base, failed, relatives }) {
  const d = rework.detail;
  const gateEvidence = (type) => rework.checks.get(`${type}:${String(d.sha).slice(0, 10)}`) || null;
  let cause = Cause.CAUSES.includes(d.cause) ? d.cause : Cause.fromReason(d, { base, gateEvidence });
  const named = failures(d.reason);
  if ((cause === 'tests' || cause === 'head_check') && named.names.length) {
    const near = relatives.get(t.id) || new Set();
    const elsewhere = (name) => (failed.get(name) || []).some((f) => f.task !== t.id && !near.has(f.task)
      && Math.abs(f.at - rework.at) <= CROSS_TASK_MS);
    if (named.names.every(elsewhere)) cause = 'cross_task';
  }
  let culprit = null;
  if (cause === 'head_check') {
    const changed = new Set((rework.changed || []).map((f) => f.replace(/\\/g, '/')));
    culprit = named.files.some((f) => changed.has(f));
  }
  const tc = Cause.TC.has(cause) || (cause === 'head_check' && culprit === false);
  return { at: rework.at, cause, culprit, tc };
}

// Merges [start, end) intervals.
function union(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlap(spans, a, b) {
  let total = 0;
  for (const [x, y] of spans) total += Math.max(0, Math.min(b, y) - Math.max(a, x));
  return total;
}

function minus(spans, cut) {
  const out = [];
  for (const [a, b] of spans) {
    let pieces = [[a, b]];
    for (const [x, y] of cut) {
      pieces = pieces.flatMap(([p, q]) => (y <= p || x >= q ? [[p, q]] : [[p, Math.max(p, x)], [Math.min(q, y), q]]).filter(([m, n]) => n > m));
    }
    out.push(...pieces);
  }
  return out;
}

function phases(t, mergedAt) {
  const gating = union([...[...t.runs.values()].filter((r) => r.phase === 'done' && r.start != null).map((r) => [r.start, r.end]),
    ...t.headChecks.filter((h) => h.started != null).map((h) => [h.started, h.at])]);
  const reviewing = minus(union([...t.reviewers.values()].filter((r) => r.end != null).map((r) => [r.start, r.end])), gating);
  const out = Object.fromEntries(PHASES.map((p) => [p, 0]));
  let state = 'queued';
  let since = t.created;
  let submitted = false;
  const transitions = [...t.transitions].sort((a, b) => a[0] - b[0]);
  for (const [at, kind] of transitions) {
    if (at > mergedAt) break;
    // An earlier merge of another head is history, not this task's end.
    if (kind === 'merge' && at < mergedAt) continue;
    const end = at;
    if (state === 'submitted') {
      const g = overlap(gating, since, end);
      const r = overlap(reviewing, since, end);
      out.gating += g;
      out.reviewing += r;
      out.waiting_for_gates += end - since - g - r;
    } else if (state === 'accepted') {
      const g = overlap(gating, since, end);
      out.gating += g;
      out.accepted_to_merged += end - since - g;
    } else out[state] += end - since;
    since = end;
    if (kind === 'merge') break;
    if (kind === 'claim') state = 'working';
    else if (kind === 'release') state = submitted ? 'rework_waiting' : 'queued';
    else if (kind === 'submit') { state = 'submitted'; submitted = true; }
    else if (kind === 'rework') state = 'rework_waiting';
    else if (kind === 'accept') state = 'accepted';
  }
  const lead = mergedAt - t.created;
  const waiting = out.queued + out.waiting_for_gates + out.rework_waiting + out.accepted_to_merged;
  return { ...out, lead, waiting };
}

function causeCounts(list) {
  const by = Object.fromEntries(Cause.CAUSES.map((c) => [c, 0]));
  for (const r of list) by[r.cause]++;
  const tc = list.filter((r) => r.tc).length;
  return { total: list.length, by_cause: by, tc_caused: tc, tc_share: list.length ? Math.round((tc / list.length) * 1000) / 1000 : null };
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesOnly(entry) {
  return entry.source === 'manual' && entry.tokens == null && entry.input == null;
}

function roleOf(agent) {
  if (/^worker-/.test(agent || '')) return 'worker';
  if (/^reviewer-/.test(agent || '')) return 'reviewer';
  return 'other';
}

function report(stateDir, { since, until, claimedAfter = null, byDay = false }) {
  const file = path.join(stateDir, 'events.jsonl');
  if (!fs.existsSync(file)) throw usage(`no event log at ${file}`);
  let base = 'main';
  try { base = JSON.parse(fs.readFileSync(path.join(stateDir, 'project.json'), 'utf8')).base || base; } catch { /* the default base */ }
  base = String(base).replace(/^origin\//, '');
  const { tasks, failed, relatives, log } = collect(file);
  const admitted = (t) => claimedAfter == null || (t.firstClaim != null && t.firstClaim >= claimedAfter);
  const inWindow = (ms) => ms >= since && ms < until;
  const mergedAll = [...tasks.values()].filter((t) => t.merges.some((m) => inWindow(m.at)));
  const merged = mergedAll.filter(admitted);
  const ctx = { base, failed, relatives };

  const mergeRows = merged.flatMap((t) => t.merges.filter((m) => inWindow(m.at)));
  const days = new Map();
  const daily = (key) => days.get(key) || days.set(key, { day: key, merges: 0, reworks: 0, tc_caused: 0, tokens_known: 0 }).get(key);
  for (const m of mergeRows) daily(dayOf(m.at)).merges++;

  const perTask = merged.map((t) => {
    const mergedAt = Math.min(...t.merges.filter((m) => inWindow(m.at)).map((m) => m.at));
    const entries = [...t.spend.values(), ...t.manual];
    const known = entries.filter((x) => x.tokens != null && !x.live);
    const tokens = known.reduce((n, x) => n + x.tokens, 0);
    // A manual report of minutes alone claims no token use; a spawn without usage or a live reading is unknown.
    const unknown = entries.filter((x) => x.live || (x.tokens == null && !minutesOnly(x)));
    daily(dayOf(mergedAt)).tokens_known += tokens;
    const testsWall = [...t.runs.values()].filter((r) => r.type === 'tests' && r.phase === 'done' && r.start != null)
      .map((r) => r.end - r.start);
    return {
      t, mergedAt, reworks: t.reworks.filter((r) => r.at <= mergedAt).map((r) => classify(t, r, ctx)),
      entries, tokens, complete: !unknown.length, phases: phases(t, mergedAt), testsWall,
    };
  });

  const raisedAll = [...tasks.values()].flatMap((t) => t.reworks.filter((r) => inWindow(r.at)).map((r) => ({ t, r })));
  const raised = raisedAll.filter(({ t }) => admitted(t)).map(({ t, r }) => classify(t, r, ctx));
  for (const r of raised) {
    const row = daily(dayOf(r.at));
    row.reworks++;
    if (r.tc) row.tc_caused++;
  }

  const groups = new Map();
  const without = { live: 0, spawn: 0, manual: 0 };
  let entryCount = 0;
  for (const p of perTask) {
    for (const x of p.entries) {
      entryCount++;
      if (x.live) without.live++;
      else if (x.tokens == null) without[x.source === 'manual' ? 'manual' : 'spawn']++;
      if (x.tokens == null || x.live) continue;
      const key = `${roleOf(x.agent)}|${x.rung || 'unknown'}|${x.harness || 'unknown'}`;
      const g = groups.get(key) || groups.set(key, { role: roleOf(x.agent), rung: x.rung || 'unknown', harness: x.harness || 'unknown', tokens: 0, entries: 0 }).get(key);
      g.tokens += x.tokens;
      g.entries++;
    }
  }
  const byRole = { worker: 0, reviewer: 0, other: 0 };
  for (const g of groups.values()) byRole[g.role] += g.tokens;

  const reworksMerged = perTask.flatMap((p) => p.reworks);
  const phaseStats = Object.fromEntries(PHASES.map((ph) => [ph, stats(perTask.map((p) => p.phases[ph]))]));
  const leadSum = perTask.reduce((n, p) => n + p.phases.lead, 0);
  const waitSum = perTask.reduce((n, p) => n + p.phases.waiting, 0);
  const testsRuns = perTask.flatMap((p) => p.testsWall);
  const cohort = {
    claimed_after: claimedAfter == null ? null : new Date(claimedAfter).toISOString(),
    excluded_merged_tasks: mergedAll.length - merged.length,
    excluded_reworks_raised: raisedAll.length - raised.length,
  };
  const sortedDays = [...days.values()].filter((d) => d.merges || d.reworks).sort((a, b) => a.day.localeCompare(b.day));
  const windowDays = Math.max(1, (until - since) / (24 * HOUR));

  return {
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, base },
    cohort,
    log: { file, ...log },
    merges: { total: mergeRows.length, tasks: merged.length, per_day_mean: Math.round((mergeRows.length / windowDays) * 100) / 100,
      ...(byDay ? {} : { per_day: sortedDays.filter((d) => d.merges).map((d) => ({ day: d.day, merges: d.merges })) }) },
    gate_runs: {
      per_task: Object.fromEntries(GATES.map((g) => [g, stats(perTask.map((p) => p.t.gates[g]))])),
      governor_deferrals: Object.fromEntries(['tests', 'clean', 'review'].map((g) => [g, perTask.reduce((n, p) => n + p.t.deferrals[g], 0)])),
      tests_wall_ms: { per_task: stats(perTask.map((p) => p.testsWall.reduce((a, b) => a + b, 0))), per_run: stats(testsRuns) },
      tests_cpu_ms: { value: null, runs_recorded: 0, runs: testsRuns.length },
      head_check_timed: perTask.reduce((n, p) => n + p.t.headChecks.filter((h) => h.started != null).length, 0),
    },
    reworks: {
      merged_tasks: { ...causeCounts(reworksMerged), per_task: stats(perTask.map((p) => p.reworks.length)),
        head_check_culprit: { yes: reworksMerged.filter((r) => r.culprit === true).length, no: reworksMerged.filter((r) => r.culprit === false).length } },
      raised_in_window: causeCounts(raised),
    },
    tokens: {
      complete_tasks: perTask.filter((p) => p.complete).length,
      partial_tasks: perTask.filter((p) => !p.complete).length,
      per_task: stats(perTask.filter((p) => p.complete).map((p) => p.tokens)),
      known_lower_bound: stats(perTask.map((p) => p.tokens)),
      by_role: byRole,
      by_group: [...groups.values()].sort((a, b) => b.tokens - a.tokens),
      entries: { total: entryCount, with_tokens: entryCount - without.live - without.spawn - without.manual, without_tokens: without },
    },
    lead_time: { total: stats(perTask.map((p) => p.phases.lead)), phases: phaseStats,
      waiting_share: leadSum ? Math.round((waitSum / leadSum) * 1000) / 1000 : null },
    submits: { per_task: stats(perTask.map((p) => p.t.submits)),
      first_pass_ms: stats(perTask.filter((p) => p.t.firstClaim != null && p.t.firstSubmit != null && p.t.firstSubmit >= p.t.firstClaim)
        .map((p) => p.t.firstSubmit - p.t.firstClaim)) },
    ...(byDay ? { by_day: sortedDays } : {}),
    definitions: DEFINITIONS,
  };
}

function dur(ms) {
  if (ms == null) return '-';
  const m = ms / 60e3;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 48 * 60) return `${Math.round(m / 6) / 10}h`;
  return `${Math.round(m / 144) / 10}d`;
}

function big(n) {
  if (n == null) return '-';
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10}G`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

const share = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);

function table(rows) {
  const width = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] || 0, String(c).length)), []);
  return rows.map((r) => r.map((c, i) => (i ? String(c).padStart(width[i]) : String(c).padEnd(width[i]))).join('  ').trimEnd()).join('\n');
}

function text(r) {
  const out = [];
  out.push(`metrics ${r.window.since} .. ${r.window.until} (days in ${r.window.timezone})`);
  out.push(r.cohort.claimed_after
    ? `cohort: first claim at or after ${r.cohort.claimed_after}; excluded ${r.cohort.excluded_merged_tasks} merged tasks and ${r.cohort.excluded_reworks_raised} reworks raised`
    : 'cohort: all tasks');
  out.push(`log: ${r.log.bytes} bytes, ${r.log.lines} lines, ${r.log.parsed} parsed${r.log.torn_last_line ? ', torn last line left out' : ''}${r.log.unreadable ? `, ${r.log.unreadable} unreadable` : ''}`);
  out.push('');
  out.push(`merged: ${r.merges.tasks} tasks, ${r.merges.total} merges, ${r.merges.per_day_mean} per day`);
  if (r.merges.per_day) out.push(`per day: ${r.merges.per_day.map((d) => `${d.day} ${d.merges}`).join(', ') || '-'}`);
  if (r.by_day) {
    out.push(table([['day', 'merges', 'reworks', 'tc', 'tokens'],
      ...r.by_day.map((d) => [d.day, d.merges, d.reworks, d.tc_caused, big(d.tokens_known)])]));
  }
  out.push('');
  const g = r.gate_runs;
  out.push(table([['gate runs per merged task', 'p50', 'p90', 'mean', 'sum'],
    ...GATES.map((k) => [k, g.per_task[k].p50 ?? '-', g.per_task[k].p90 ?? '-', g.per_task[k].mean ?? '-', g.per_task[k].sum])]));
  out.push(`governor deferrals: tests ${g.governor_deferrals.tests}, clean ${g.governor_deferrals.clean}, review ${g.governor_deferrals.review}`);
  out.push(`tests wall per merged task p50 ${dur(g.tests_wall_ms.per_task.p50)} p90 ${dur(g.tests_wall_ms.per_task.p90)}; per run p50 ${dur(g.tests_wall_ms.per_run.p50)} (${g.tests_wall_ms.per_run.n} runs); tests CPU not recorded (0 of ${g.tests_cpu_ms.runs} runs)`);
  out.push('');
  const m = r.reworks.merged_tasks;
  const w = r.reworks.raised_in_window;
  out.push(table([['rework cause', 'merged tasks', 'raised in window'],
    ...Cause.CAUSES.filter((c) => m.by_cause[c] || w.by_cause[c]).map((c) => [`${c}${Cause.TC.has(c) ? ' (tc)' : ''}`, m.by_cause[c], w.by_cause[c]]),
    ['total', m.total, w.total], ['tc caused', `${m.tc_caused} (${share(m.tc_share)})`, `${w.tc_caused} (${share(w.tc_share)})`]]));
  out.push(`reworks per merged task p50 ${m.per_task.p50 ?? '-'} p90 ${m.per_task.p90 ?? '-'} mean ${m.per_task.mean ?? '-'}; head checks with a culprit ${m.head_check_culprit.yes}, without ${m.head_check_culprit.no}`);
  out.push('');
  const tk = r.tokens;
  out.push(`tokens per merged task (${tk.complete_tasks} complete, ${tk.partial_tasks} partial): p50 ${big(tk.per_task.p50)} p90 ${big(tk.per_task.p90)} sum ${big(tk.per_task.sum)}; known lower bound over all p50 ${big(tk.known_lower_bound.p50)} p90 ${big(tk.known_lower_bound.p90)} sum ${big(tk.known_lower_bound.sum)}`);
  out.push(`by role: worker ${big(tk.by_role.worker)}, reviewer ${big(tk.by_role.reviewer)}, other ${big(tk.by_role.other)}`);
  out.push(table([['role', 'rung', 'harness', 'tokens', 'entries'], ...tk.by_group.map((x) => [x.role, x.rung, x.harness, big(x.tokens), x.entries])]));
  out.push(`spend entries: ${tk.entries.total}, ${tk.entries.with_tokens} with tokens; without: ${tk.entries.without_tokens.live} live, ${tk.entries.without_tokens.spawn} spawn, ${tk.entries.without_tokens.manual} manual`);
  out.push('');
  const l = r.lead_time;
  out.push(table([['lead time per merged task', 'p50', 'p90', 'sum'], ['total', dur(l.total.p50), dur(l.total.p90), dur(l.total.sum)],
    ...PHASES.map((p) => [p, dur(l.phases[p].p50), dur(l.phases[p].p90), dur(l.phases[p].sum)])]));
  out.push(`waiting share: ${share(l.waiting_share)}`);
  const s = r.submits;
  out.push(`submits per merged task p50 ${s.per_task.p50 ?? '-'} p90 ${s.per_task.p90 ?? '-'} mean ${s.per_task.mean ?? '-'}; first pass p50 ${dur(s.first_pass_ms.p50)} p90 ${dur(s.first_pass_ms.p90)}`);
  out.push('definitions: tower-crane metrics --json');
  return out.join('\n');
}

function metrics(ctx) {
  const now = Date.now();
  const f = ctx.flags;
  const since = parseTime(f.since ?? '7d', 'since', now);
  const until = f.until === undefined ? now : parseTime(f.until, 'until', now);
  if (until <= since) throw usage('--until must be later than --since');
  if (f.by !== undefined && f.by !== 'day') throw usage('--by takes day');
  const claimedAfter = f['claimed-after'] === undefined ? null : parseTime(f['claimed-after'], 'claimed-after', now);
  const data = report(ctx.stateDir, { since, until, claimedAfter, byDay: f.by === 'day' });
  return { data, text: text(data) };
}

module.exports = { metrics, report, failures, pct, parseTime, DEFINITIONS };
