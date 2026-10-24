'use strict';

// Conflict hotspots: a task that keeps going back for conflicts on the same
// file is racing other merges it cannot outrun. Past a threshold the conflict
// rework still records the files, but it opens an orchestrator decision that
// blocks the task, so neither refill nor a waiting owner reworks it again
// until someone chooses a merge pause, a split or another round.

// On 2026-10-23 this project's event log held 380 conflict reworks over 136
// tasks. The file each task conflicted on most often came back once for 82
// tasks, twice for 26, three times for 19 and four or more times for 9
// (T499: docs/state.md 18 times). The 90th percentile is 3; a project with
// fewer than MIN_SAMPLES tasks of its own uses it (docs/state.md#conflict-hotspots).
const DEFAULT_THRESHOLD = 3;
const MIN_SAMPLES = 10;
const QUANTILE = 0.9;
const OPTIONS = ['merge pause', 'split', 'keep reworking'];

const Cause = require('./rework-cause');

const CONFLICT = new Set(['conflict_base', 'conflict_parent']);
// Conflict reworks without a `conflicts` list name their files only in the
// reason: a conflict with the base or a parent's PR branch, or a stack sync
// that could not merge a parent's resubmitted head.
const REASONS = [/ conflicts with [^:]+: (.+?)\. (?:Merge the base|The merge is prepared)/,
  /; resolve conflicts in: (.+?)\. Preserve the child commits/];

// Why a rework event sent the task back (lib/rework-cause.js). The cause the
// event recorded wins; a manual rework, or one older than recorded causes, is
// read from its reason, since the orchestrator often relays a conflict by hand.
function causeOf(event, base = 'main') {
  const d = event.detail || {};
  if (d.cause && d.cause !== 'manual') return d.cause;
  if (Array.isArray(d.conflicts)) return 'conflict_base';
  if (d.gate) return Cause.ofGate(d.gate, { summary: String(d.reason || '').replace(/^\S+ failed at \S+: /, '') });
  return Cause.fromReason(d, { base });
}

// The files a rework event sent back for conflicts with the base or a stack
// parent, [] when the conflict named none (a CI CONFLICTING state), or null
// for any other rework.
function files(event, base) {
  if (event.cmd !== 'rework' || !CONFLICT.has(causeOf(event, base))) return null;
  if (Array.isArray(event.detail?.conflicts)) return event.detail.conflicts;
  for (const re of REASONS) {
    const m = re.exec(event.detail?.reason || '');
    if (m) return m[1].split(', ');
  }
  return [];
}

// The threshold from the project's own history: the nearest-rank 90th
// percentile of each task's most conflicted file count.
function calibrate(events, base) {
  const per = new Map();
  for (const e of events) {
    const list = e.task && files(e, base);
    if (!list?.length) continue;
    const counts = per.get(e.task) || new Map();
    per.set(e.task, counts);
    for (const f of new Set(list)) counts.set(f, (counts.get(f) || 0) + 1);
  }
  const worst = [...per.values()].map((counts) => Math.max(...counts.values())).sort((a, b) => a - b);
  if (worst.length < MIN_SAMPLES) return { threshold: DEFAULT_THRESHOLD, samples: worst.length, from: 'default' };
  return { threshold: worst[Math.ceil(QUANTILE * worst.length) - 1], samples: worst.length, from: 'project' };
}

function decisions(st, id) {
  return st.decisions.decisions.filter((d) => d.hotspot?.task === id);
}

// Conflict counts per file since the task's last hotspot decision, with the
// files of the rework being written now.
function counts(st, task, current = []) {
  const since = decisions(st, task.id).at(-1)?.asked_at || '';
  const out = new Map();
  const add = (list) => { for (const f of new Set(list)) out.set(f, (out.get(f) || 0) + 1); };
  for (const e of st.events) {
    if (e.task !== task.id || e.at <= since) continue;
    const list = files(e, st.project?.base);
    if (list) add(list);
  }
  add(current);
  return out;
}

// Called in the conflict rework's write, before its handback check: the
// decision it opens blocks the task, which holds both refill and the owner.
function trip(st, emit, task, current, agent) {
  if (decisions(st, task.id).some((d) => d.status === 'open')) return null;
  const norm = calibrate(st.events, st.project?.base);
  const hot = [...counts(st, task, current)].filter(([, n]) => n > norm.threshold)
    .map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  if (!hot.length) return null;
  const basis = norm.from === 'project'
    ? `the 90th percentile of this project's ${norm.samples} tasks with conflict reworks`
    : `the default from Tower Crane's own history; this project has ${norm.samples} task${norm.samples === 1 ? '' : 's'} with conflict reworks, needs ${MIN_SAMPLES}`;
  const named = hot.map((h) => `${h.file} ${h.count} times`).join(', ');
  return require('./decisions').create(st, emit, agent, {
    question: `${task.id} was sent back for conflicts on ${named}, past the threshold of ${norm.threshold} (${basis}). Land it in a merge pause (merge pause ${task.id} --minutes N --reason R), split the task, or keep reworking?`,
    options: OPTIONS, recommendation: 'merge pause', blocks: [task.id], kind: 'technical',
    why: 'other merges keep changing these files faster than this task resubmits',
    hotspot: { task: task.id, files: hot, threshold: norm.threshold, samples: norm.samples, from: norm.from },
  });
}

// The hot files of tasks still open, most recent decision first, for status.
function hot(st) {
  const open = new Set(st.tasks.tasks.filter((t) => !['accepted', 'cancelled'].includes(t.status)).map((t) => t.id));
  const latest = new Map();
  for (const d of st.decisions.decisions) if (d.hotspot && open.has(d.hotspot.task)) latest.set(d.hotspot.task, d);
  const byFile = new Map();
  for (const d of [...latest.values()].sort((a, b) => b.asked_at.localeCompare(a.asked_at))) {
    for (const { file, count } of d.hotspot.files) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id: d.hotspot.task, count, decision: d.id, status: d.status });
    }
  }
  return [...byFile].map(([file, tasks]) => ({ file, tasks }));
}

function describe(list) {
  return list.map(({ file, tasks }) => `${file} (${tasks.map((t) => `${t.id} ${t.count} conflict reworks, ${t.decision}${t.status === 'open' ? ' open' : ''}`).join('; ')})`).join('; ');
}

module.exports = { files, causeOf, CONFLICT, calibrate, counts, trip, hot, describe, DEFAULT_THRESHOLD, MIN_SAMPLES, OPTIONS };
