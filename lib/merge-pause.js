'use strict';

// A merge pause lands one conflict magnet: from the named task's submit, the
// merge line merges only that task (and the stack below it) until it merges,
// is sent back or reaches the deadline, so the base stops moving under it.
// The pause is computed from its events on each read; `merge pause end`
// records when it ended, and the reconcile events written with it wake the
// merges it held.

const S = require('./state');
const T = require('./tasks');
const { refuse, usage, shortTime } = require('./util');
const { randomUUID } = require('node:crypto');

const MAX_MINUTES = (2 ** 31 - 1) / 60000;

function merged(st, task) {
  return require('./stack').merged(st, task);
}

// The latest pause not cleared or recorded as ended, with its phase: `armed`
// until the task submits, `holding` from that submit (or from the command,
// when the task was already submitted or accepted), `ended` once it merged,
// was cancelled, went back to rework or passed its deadline.
function current(st, now = Date.now()) {
  let set = null;
  let at = -1;
  st.events.forEach((e, i) => {
    if (e.cmd === 'merge pause') {
      set = e.detail.clear ? null : e;
      at = i;
    } else if (e.cmd === 'merge pause end' && set && e.task === set.task) set = null;
  });
  if (!set) return null;
  const task = st.tasks.tasks.find((t) => t.id === set.task);
  let since = set.detail.holding ? set.at : null;
  let ended = null;
  for (let i = at + 1; i < st.events.length && !ended; i++) {
    const e = st.events[i];
    if (e.task !== set.task) continue;
    if (!since && e.cmd === 'submit') since = e.at;
    else if (since && e.cmd === 'rework') ended = { why: 'reworked', at: e.at };
  }
  const until = since ? new Date(Date.parse(since) + set.detail.minutes * 60000).toISOString() : null;
  if (!ended && task && merged(st, task)) ended = { why: 'merged' };
  if (!ended && (!task || task.status === 'cancelled')) ended = { why: 'cancelled' };
  if (!ended && until && now >= Date.parse(until)) ended = { why: 'deadline', at: until };
  return { task: set.task, reason: set.detail.reason, minutes: set.detail.minutes, set_at: set.at, by: set.agent,
    phase: ended ? 'ended' : since ? 'holding' : 'armed', since, until, ...(ended ? { ended } : {}) };
}

// The pause that holds merges now, or null.
function holding(st, now = Date.now()) {
  const p = current(st, now);
  return p?.phase === 'holding' ? p : null;
}

// The paused task, armed or holding: its gate reactions go first.
function first(st, now = Date.now()) {
  const p = current(st, now);
  return p && p.phase !== 'ended' ? p.task : null;
}

// Whether the pause holds a merge-line entry: one that neither carries the
// paused task nor sits below it in its stack.
function holds(st, members, p = holding(st)) {
  if (!p) return null;
  const own = new Set(require('./stack').chain(st, T.getTask(st, p.task)).map((t) => t.id));
  return members.some((m) => own.has(m.id)) ? null : p;
}

function describe(p) {
  if (p.phase === 'holding') return `${p.task} holds other merges until ${shortTime(p.until)}: ${p.reason}`;
  if (p.phase === 'armed') return `${p.task} armed: from its next submit it holds other merges for ${p.minutes} min: ${p.reason}`;
  return `${p.task} ended (${p.ended.why}): ${p.reason}`;
}

// Records a pause's end and queues the merges it held: their reactions
// finished while it held, and nothing else wakes them on a running wait host.
function end(st, emit, p, why) {
  emit(p.task, { why, set_at: p.set_at, since: p.since, until: p.until, reason: p.reason }, 'merge pause end');
  const startup = randomUUID();
  for (const t of st.tasks.tasks) {
    if (t.status === 'accepted' && t.pr && !merged(st, t)) emit(t.id, { sha: t.sha, revision: t.revision, startup }, 'automation reconcile');
  }
}

// Records the end of a pause whose end is computed but not yet recorded. The
// wait host calls it on each refill pass and at the deadline.
function expire(ctx) {
  const before = current(S.loadState(ctx.stateDir));
  if (before?.phase !== 'ended') return false;
  return S.mutate(ctx, 'merge pause end', (st, emit) => {
    const p = current(st);
    if (p?.phase !== 'ended') return false;
    end(st, emit, p, p.ended.why);
    return true;
  });
}

// The deadline of a holding pause, for the wait host's timer.
function deadline(st) {
  return holding(st)?.until || null;
}

// Operational: `merge pause ID --minutes N --reason R` or `--clear`.
function pause(ctx) {
  const f = ctx.flags;
  const clear = !!f.clear;
  const reason = (f.reason || '').trim();
  if (clear && (f.reason !== undefined || f.minutes !== undefined)) throw usage('--clear cannot be combined with --reason or --minutes');
  if (!clear && (!reason || f.minutes === undefined)) throw usage('merge pause needs --minutes N and --reason R, or --clear');
  if (!clear && !(f.minutes > 0 && f.minutes <= MAX_MINUTES)) throw usage(`--minutes must be a positive number of minutes up to ${Math.floor(MAX_MINUTES)}`);
  let id;
  S.mutate(ctx, 'merge pause', (st, emit) => {
    const who = require('./authority').enforce(ctx, st, ['merge.pause'], { emit });
    const task = T.getTask(st, ctx.pos[0]);
    id = task.id;
    const p = current(st);
    const live = p && p.phase !== 'ended' ? p : null;
    if (clear) {
      if (live?.task !== task.id) throw refuse(`${task.id} has no merge pause to clear`);
      emit(task.id, { clear: true, authority: who });
      if (live.phase === 'holding') end(st, emit, live, 'cleared');
      return;
    }
    if (live && live.task !== task.id) throw refuse(`merges are already paused for ${live.task}; clear that pause first with merge pause ${live.task} --clear`);
    if (task.status === 'cancelled' || merged(st, task)) throw refuse(`${task.id} is ${task.status === 'cancelled' ? 'cancelled' : 'merged'}; a merge pause needs a task that will still merge`);
    // A new pause hides an ended one the wait host has not recorded yet.
    if (p?.phase === 'ended') end(st, emit, p, p.ended.why);
    emit(task.id, { reason, minutes: f.minutes, holding: ['submitted', 'accepted'].includes(task.status), authority: who });
  });
  const p = current(S.loadState(ctx.stateDir));
  return { data: clear ? null : p, text: clear ? `${id}: merge pause cleared` : `merge pause: ${describe(p)}` };
}

module.exports = { current, holding, first, holds, describe, expire, deadline, pause };
