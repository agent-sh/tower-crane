'use strict';

const fs = require('node:fs');
const S = require('./state');
const T = require('./tasks');
const Processes = require('./processes');
const Db = require('./db');
const { EventReader, cutBack, cutsSize, parseCursor, formatCursor } = require('./event-reader');
const { refuse, usage } = require('./util');

// Watch notifications can be dropped. This also checks detached process exits,
// which have no filesystem notification on Windows.
const FALLBACK_MS = 1000;
// A commit writes the database's log; a checkpoint, a migration or a restore
// writes the others.
const STATE_FILES = new Set([Db.FILE, `${Db.FILE}-wal`, 'project.json']);
const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';

// Bookkeeping that arrives with every tool call or lease tick. A default wait
// skips it so the orchestrator never needs a type list; --types all restores
// the full stream.
const QUIET = new Set(['hook progress', 'hook report', 'hook inbox', 'renew', 'spend', 'spend live', 'spawn session', 'inbox snapshot', 'inbox ack', 'gate run']);

function message(ctx) {
  const to = (ctx.flags.to || '').trim();
  const text = ctx.pos.join(' ').trim();
  if (!to || !text) throw usage('msg needs --to NAME and TEXT');
  const data = S.mutate(ctx, 'msg', (st, emit) => {
    const id = ctx.flags.task || ctx.env.TOWER_CRANE_TASK;
    const task = id ? T.getTask(st, id).id : null;
    const detail = { to, text, ...(ctx.flags.steer ? { steer: true } : {}) };
    emit(task, detail);
    return { task, ...detail };
  });
  return { data, text: `message sent to ${to}` };
}

function sourceKey(type, t, suffix) {
  return JSON.stringify([type, t.id, t.claim.agent, t.claim.since, suffix]);
}

// `events` is the log, or a snapshot's indexed reads of it (st.log): exits
// are read from the lifecycle events of the tasks that can have one, and
// progress from the claimed task's own events. The sources this records name
// their task and are only on that task's `worker-exited` and `stall` events.
function sources(st, events, now) {
  const life = T.select(events, { tasks: st.tasks.tasks.filter((t) => ['in_progress', 'todo', 'rework'].includes(t.status)).map((t) => t.id), taskCmds: Processes.LIFE_CMDS });
  const seen = (t, source) => T.taskEvents(events, t.id, ['worker-exited', 'stall']).some((e) => e.detail && e.detail.source === source);
  const out = [];
  const exited = new Map(Processes.exitedWorkers(st, life, { includeTail: false }).map((c) => [c.id, c]));
  for (const t of st.tasks.tasks) {
    const exit = exited.get(t.id);
    if (exit) {
      const source = JSON.stringify(['worker-exited', t.id, exit.agent, t.claim ? t.claim.since : exit.spawn, exit.pid]);
      const spawn = life.findLast((e) => ['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && e.task === t.id
        && e.detail.agent === exit.agent && e.detail.pid === exit.pid);
      if (!seen(t, source)) out.push({ task: t.id, type: 'worker-exited', detail: { ...exit, attempt: Processes.spawnAttempt(spawn, life), source } });
      continue;
    }
    if (t.status !== 'in_progress' || !t.claim) continue;
    if (Processes.supervised(st, t, life)) continue;
    let progress = Date.parse(t.claim.since);
    let interval = Date.parse(t.claim.until) - progress;
    for (const e of T.taskEvents(events, t.id)) {
      const at = Date.parse(e.at);
      const claimant = e.agent === t.claim.agent
        || (e.cmd === 'claim' && (e.detail.resumed || e.detail.took_over_from || e.detail.rollback) && e.detail.holder === t.claim.agent);
      if (e.task !== t.id || !claimant || at < Date.parse(t.claim.since)) continue;
      if (['claim', 'renew'].includes(e.cmd)) interval = Date.parse(e.detail.until) - at;
      else if (!['stall', 'worker-exited'].includes(e.cmd)) progress = Math.max(progress, at || 0);
    }
    const deadline = Math.max(Date.parse(t.claim.until), progress + interval);
    if (now < deadline) continue;
    const source = sourceKey('stall', t, [t.claim.until, progress]);
    if (!seen(t, source)) out.push({ task: t.id, type: 'stall', detail: { agent: t.claim.agent, until: t.claim.until, progress_at: new Date(progress).toISOString(), source } });
  }
  return out;
}

// `events` is the log, or a snapshot's indexed reads of it (st.log), which
// answer the agent's roles without reading every event.
function canObserve(ctx, events, spawn) {
  if (['owner', 'orchestrator'].includes(ctx.agent)) return true;
  const role = typeof events.spawnRoles === 'function' ? events.spawnRoles(ctx.agent).at(-1)
    : events.findLast((e) => e.cmd === 'spawn' && e.detail.agent === ctx.agent)?.detail.role;
  if (role === 'orchestrator') return true;
  // A collector CLI is a direct child of its recorded monitor, outside the
  // agent's sandbox. Workers sharing that agent name must not probe peers.
  const detail = spawn?.detail;
  return detail?.monitor_pid === process.ppid && Processes.processState({
    pid: detail.monitor_pid, host: detail.host, start_ticks: detail.monitor_start_ticks,
  }) === 'running';
}

function observe(st, emit, spawn, ctx) {
  // Foreground exits, detached collectors and waiters share one locked path.
  if (spawn) T.collectSpawn(st, emit, spawn);
  const log = st.log || st.events;
  if (!canObserve(ctx, log, spawn)) return;
  for (const e of sources(st, log, Date.now())) {
    emit(e.task, e.detail, e.type);
    if (e.type === 'worker-exited') require('./escalation').capRespawns(st, emit, e.task, { cmd: e.type, task: e.task, detail: e.detail }, ctx?.agent);
    if (e.type !== 'worker-exited' || (spawn?.task === e.task && spawn.detail.agent === e.detail.agent)) continue;
    const ev = T.taskEvents(log, e.task, ['spawn']).findLast((x) => x.cmd === 'spawn' && x.task === e.task
      && x.detail.agent === e.detail.agent);
    if (ev) {
      try { T.collectSpawn(st, emit, ev); } catch {
        // Exit wakeups still reach the orchestrator; the collector retries usage.
      }
    }
  }
}

async function detect(ctx) {
  // Avoid taking the write lock on idle checks. Recheck under it before emitting,
  // so concurrent waiters cannot emit twice or report an already submitted task.
  const st = S.loadState(ctx.stateDir);
  if (!canObserve(ctx, st.log)) return;
  await require('./stack').observe(ctx);
  if (ctx.automationSignal?.aborted) return;
  const observed = sources(st, st.log, Date.now());
  const candidates = require('./escalation').candidates(st);
  if (!observed.length && !candidates.length) return;
  try {
    S.mutate(ctx, 'observe', (current, emit) => {
      observe(current, emit, undefined, ctx);
    }, 0);
    const ids = new Set([...observed.map((e) => e.task), ...candidates]);
    for (const id of ids) {
      if (!T.getTask(st, id).tier_range) continue;
      try {
        await require('./escalation').recover({ ...ctx, pos: [id], flags: {} });
      } catch (e) {
        // A refused recovery must leave other tasks' reactions and refill running.
        if (![1, 2, 'EACCES', 'EPERM'].includes(e.code)) throw e;
        process.stderr.write(`tower-crane: recovery ${id}: ${e.message}\n`);
      }
    }
  } catch (e) {
    // A writer owns the lock. Retry on the next notification or fallback tick
    // without blocking the timeout or interrupt handlers.
    if (e.code !== 3) throw e;
  }
}

// The events committed after cursor `after`, each with the cursor after it
// as `offset`, and the cursor reading stopped at. A cursor inside bytes lock
// recovery cut off the file layout's log reads from where the cut left it
// (cutBack); `since` is the cuts count it was taken with. `cuts` is the cuts
// count for the cursors handed out from it; no cut happens after migration.
function readFrom(dir, after, since = null) {
  after = cutBack(dir, after, since);
  const end = Db.end(dir);
  if (end < after) throw refuse('the event log is shorter than its cursor; events are only ever added');
  const rows = [];
  let offset = after;
  for (const r of Db.eventsAfter(dir, after)) {
    offset = r.pos;
    try {
      const e = parseEvent(r.body, r.pos);
      if (e) rows.push(e);
    } catch {
      // A row a parser refuses never stops the ones after it.
    }
  }
  return { rows, offset, cuts: cutsSize(dir) };
}

function parseEvent(line, offset) {
  const e = JSON.parse(line);
  if (!e || typeof e.cmd !== 'string') return null;
  return { ...e, type: e.type || S.eventType(e), to: e.to === undefined ? (e.cmd === 'msg' ? e.detail.to : 'orchestrator') : e.to, offset };
}

// The cursor to read after, and the cuts count when it was taken.
function cursor(dir, value) {
  if (value === undefined || value === 'now') return { offset: Db.end(dir), cuts: cutsSize(dir) };
  return { offset: cursorOffset(dir, value), cuts: cutsSize(dir) };
}

// A cursor that carries the cuts count resolves exactly; a plain offset falls
// back to what its bytes say (cutBack).
function cursorOffset(dir, value) {
  const end = Db.end(dir);
  if (/^\d+(:\d+)?$/.test(value)) {
    const parsed = parseCursor(value);
    if (!parsed) throw usage('--after offset is outside the event log');
    const given = parsed.offset;
    if (parsed.cuts !== null && parsed.cuts > cutsSize(dir)) throw usage('--after cursor counts more cuts than the state records');
    const n = cutBack(dir, given, parsed.cuts);
    if (n > end) throw usage('--after offset is outside the event log');
    // A cut leaves the log where an append began, which may be after a
    // fragment rather than a newline.
    if (n && n === given && !Db.endsLine(dir, n)) throw usage('--after offset must follow a complete event line');
    return n;
  }
  const found = Db.eventById(dir, value);
  if (!found) throw usage(`unknown event id ${value}`);
  return found.pos;
}

// The log's end as a cursor. Taken when a wait starts, before orchestrator
// process discovery, so events written during discovery are still delivered.
function startCursor(stateDir) {
  S.open(stateDir);
  return cursor(stateDir, 'now');
}

// Whether event e wakes agent, waiting as recipient. A message to the agent's
// own name reaches it too, and owner input reaches the orchestrator whoever
// it was addressed to.
function wakes(e, { recipient = 'orchestrator', agent, task = null, types = null }) {
  const owner = e.agent === 'owner';
  if (e.to !== recipient && !(e.cmd === 'msg' && e.to === agent) && !(owner && recipient === 'orchestrator')) return false;
  if (task && e.task !== task && !(e.detail?.blocks || []).includes(task)) return false;
  if (types ? !types.has('all') && !types.has(e.type) : QUIET.has(e.type)) return false;
  // Owner input, automatic results and worker observations must reach the
  // same-identity waiter.
  return owner || e.agent !== agent || e.via === 'automation' || ['worker-exited', 'stall', 'inbox item', 'main ci'].includes(e.type);
}

// Pushes carry ids and kinds, never detail. The inbox supplies current
// findings without requiring the session to reconstruct event history.
function wake(e) {
  const out = { id: e.id, type: e.type, to: e.to, agent: e.agent, task: e.task ?? null, offset: e.offset, ...(e.cursor ? { cursor: e.cursor } : {}) };
  if (e.detail?.decision) out.decision = e.detail.decision;
  if (e.detail?.steer === true) out.steer = true;
  return out;
}

// The text a harness pushes into a session: one line per wake, then how to
// read them. The Claude Code mod, hooks/tower-crane.mjs, writes the same text.
function notice(rows, agent) {
  const lines = rows.map((w) => `- ${w.id}: ${w.type}${w.decision ? ` ${w.decision}` : ''}${w.task ? ` ${w.task}` : ''} from ${w.agent}`);
  const last = rows.at(-1);
  return [`Tower Crane: ${rows.length} new event${rows.length === 1 ? '' : 's'} for ${agent}.`, ...lines,
    `Run \`tower-crane inbox\` for findings and resolving commands.${last?.offset ? ` Cursor: ${last.cursor ?? last.offset}.` : ''}`].join('\n');
}

// After a cursor (a byte offset, or OFFSET:CUTS): the wakes for agent waiting
// as recipient, each with its cursor, and the cursor reading stopped at.
function pending(stateDir, after, filter) {
  const from = parseCursor(after ?? 0) ?? { offset: 0, cuts: null };
  const batch = readFrom(stateDir, from.offset, from.cuts);
  const rows = batch.rows.filter((e) => wakes(e, filter)).map((e) => ({ ...e, cursor: formatCursor(e.offset, batch.cuts) }));
  return { rows, offset: batch.offset, cursor: formatCursor(batch.offset, batch.cuts) };
}

function show(ctx) {
  const id = ctx.pos[0];
  S.open(ctx.stateDir);
  const row = Db.eventById(ctx.stateDir, id);
  const found = row && parseEvent(row.body, row.pos);
  if (!found) throw usage(`unknown event id ${id}`);
  const text = [`${found.id} ${found.type} ${found.at} by ${found.agent}${found.task ? ` on ${found.task}` : ''} to ${found.to}`, JSON.stringify(found.detail, null, 2)].join('\n');
  return { data: found, text };
}

function wait(ctx) {
  const release = S.retainEvents(ctx.stateDir, { long: true });
  try {
    return waitFor(ctx).finally(release);
  } catch (e) {
    release();
    throw e;
  }
}

function waitFor(ctx) {
  S.loadState(ctx.stateDir);
  const f = ctx.flags;
  const timeout = f.timeout;
  if (timeout !== undefined && (timeout < 0 || timeout * 1000 > 2147483647)) throw usage('--timeout must be between 0 and 2147483.647 seconds');
  const recipient = f.for === undefined ? 'orchestrator' : f.for.trim();
  if (!recipient) throw usage('--for needs a recipient');
  const task = f.task ? T.getTask(S.loadState(ctx.stateDir), f.task).id : null;
  const types = f.types === undefined ? null : new Set(f.types.split(',').map((s) => s.trim()).filter(Boolean));
  if (types && !types.size) throw usage('--types needs comma-separated event types');
  if (f.follow && timeout !== undefined) throw usage('--follow runs until interrupted; drop --timeout');
  if (f.own) {
    if (!task) throw usage('wait --own needs --task with the task you submitted');
    for (const name of ['follow', 'observe', 'inbox', 'types', 'for', 'after']) {
      if (f[name] !== undefined) throw usage(`wait --own takes no --${name}: it reports what the owner of --task does next`);
    }
  }
  const filter = { recipient, agent: ctx.agent, task, types };
  const start = ctx.startCursor ?? cursor(ctx.stateDir, f.after);
  let after = start.offset;
  const reader = new EventReader(ctx.stateDir, { after, parse: parseEvent, restores: true });
  const drain = new AbortController();
  const force = new AbortController();
  const waitShutdown = { signal: null, drained: 0 };
  ctx = { ...ctx, automationSignal: drain.signal, gateSignal: force.signal, waitShutdown };
  // An owner's wait only reads: it runs no reactions, dispatch or observation.
  const observe = f.observe || f.own;
  // A wait that runs reactions keeps the host governor's tick going, so this
  // project's work is measured and stopped past the stop line while it waits.
  const unwatch = observe ? null : require('./governor').watch(ctx);
  return new Promise((resolve, reject) => {
    let watcher;
    let fallback;
    let deadline;
    let finished = false;
    let checking = false;
    let again = false;
    let expired = false;
    let pending = [];
    let startup = true;
    let ciAt = 0;
    let inboxAt = 0;
    let ownAt = 0;
    let mainAt = 0;
    const refill = {};
    let refilling = false;
    let refillAgain = false;
    // The event log's size when the running refill read the state.
    let refillFrom = -1;
    const logSize = () => {
      try {
        return fs.statSync(file).size;
      } catch {
        return -1;
      }
    };
    let holdTimer;
    // The wake or error a pass found. Either ends the wait once no refill or
    // reaction is still running, as when both ran inside one pass.
    let woken = null;
    let failure = null;
    const stopWatching = () => {
      if (watcher) watcher.close();
      clearInterval(fallback);
      clearTimeout(deadline);
      clearTimeout(holdTimer);
    };
    const close = () => {
      finished = true;
      unwatch?.();
      stopWatching();
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener(OUTPUT_PIPE_CLOSED, interrupt);
    };
    const done = (data, code = 0) => {
      close();
      process.stdout.write(JSON.stringify(data) + '\n');
      resolve({ printed: true, code });
    };
    const stopped = () => {
      close();
      if (waitShutdown.signal) {
        const data = { reason: 'signal', signal: waitShutdown.signal, drained: waitShutdown.drained };
        process.stdout.write(ctx.json || f.follow ? JSON.stringify(data) + '\n'
          : `stopped by ${data.signal} after draining ${data.drained} gate${data.drained === 1 ? '' : 's'}\n`);
      }
      resolve({ printed: true, code: 0 });
    };
    const interrupt = (signal) => {
      if (drain.signal.aborted) {
        force.abort();
        return;
      }
      waitShutdown.signal = signal || null;
      drain.abort(new Error('wait interrupted; retry on the next wait'));
      stopWatching();
      process.stderr.write('tower-crane: wait draining; signal again to stop running gates\n');
      settle();
    };
    // The wait ends only when neither path is mid-reaction or mid-dispatch.
    const settle = () => {
      if (finished || checking || refilling) return;
      if (failure) {
        close();
        reject(failure);
      } else if (woken) done(woken);
      else if (drain.signal.aborted) stopped();
      else if (expired && f.own) done({ type: 'timeout', outcome: 'wait', task }, 2);
      else if (expired) done({ type: 'timeout', offset: after, cursor: formatCursor(after, reader.cuts) }, 2);
    };
    // Refill runs on its own path, beside a pass whose gate reaction can run
    // for most of an hour, so free worker slots fill while gates run. The
    // dispatch lock still takes one dispatch at a time across hosts; this
    // flag keeps one refill at a time in this host.
    const fail = (e) => {
      failure ??= e;
      stopWatching();
    };
    // pass is the refill after a pass's reactions: a rework or merge they
    // made fills its slot before the wait ends, even past its deadline or a
    // wake, as when the refill ran inside the pass. A pass that wrote nothing
    // since the running refill read the state leaves that refill to cover it.
    const fill = async (pass = false) => {
      if (observe || finished || failure || drain.signal.aborted || ctx.orchestratorLeasePending) return;
      if (refilling && pass && logSize() === refillFrom) pass = false;
      if (!pass && (woken || expired)) return;
      if (refilling) { refillAgain = refillAgain === 'pass' || pass ? 'pass' : true; return; }
      refilling = true;
      refillFrom = logSize();
      try {
        await require('./automation').refillWorkers(ctx, refill);
        // An ending rework hold dispatches on this timer, without another event.
        clearTimeout(holdTimer);
        if (refill.hold && !finished && !failure && !expired) holdTimer = setTimeout(fill, Math.max(0, Date.parse(refill.hold) - Date.now()));
      } catch (e) {
        fail(e);
      } finally {
        refilling = false;
        if (refillAgain && !finished) {
          const again = refillAgain === 'pass';
          refillAgain = false;
          void fill(again);
        }
        settle();
      }
    };
    const onSigint = () => interrupt('SIGINT');
    const onSigterm = () => interrupt('SIGTERM');
    // Startup snapshots precede state reconciliation. Observe lifecycle sources
    // in the subsequent blocking wait so taking a cursor cannot consume them.
    if (timeout === 0 && !f.own && (f.after === undefined || f.after === 'now')) {
      done({ type: 'timeout', offset: after, cursor: formatCursor(after, reader.cuts) }, 2);
      return;
    }
    const check = async () => {
      if (finished || woken || failure || drain.signal.aborted) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        if (ctx.orchestratorLeasePending) {
          require('./orchestrator').command(ctx, 'wait');
          if (ctx.orchestratorLeasePending) return;
        }
        // Observer bookkeeping is engine work, not a competing native writer.
        const observer = f.observe && require('./authority').role(ctx, S.roles(ctx.stateDir)) === 'orchestrator'
          ? { ...ctx, automation: true } : ctx;
        if (f.follow && !f.inbox && recipient === 'orchestrator' && !task && Date.now() >= mainAt) {
          mainAt = Date.now() + 60000;
          try { await require('./main-ci').refresh(observer, S.loadState(ctx.stateDir)); }
          catch (e) { process.stderr.write(`${e.message}\n`); }
        }
        if (!f.own) await detect(observer);
        if (finished || drain.signal.aborted) return;
        const batch = reader.read();
        after = batch.offset;
        // The cuts the reader has applied, with which its offsets resolve exactly.
        const cuts = reader.cuts;
        // Restored history stays out of wakes and reactions.
        const rows = batch.rows.filter((e) => !batch.restored.has(e));
        if (!observe && (startup || Date.now() >= ciAt)) {
          const reconcile = require('./automation').backlog(ctx, !startup);
          if (reconcile !== null) {
            startup = false;
            ciAt = Date.now() + 60000;
            pending.push(...reconcile);
          }
        }
        if (!observe) {
          pending = await require('./automation').consume(ctx, [...pending, ...rows]);
          // A reaction can free or create a slot (rework, merge), so refill
          // runs again after it; one already running repeats once it ends.
          void fill(true);
        }
        // Remote-only findings have no local filesystem notification. One
        // refresh per minute bounds GitHub traffic even with busy hook writes.
        if (!drain.signal.aborted && f.inbox && Date.now() >= inboxAt) {
          inboxAt = Date.now() + 60000;
          await require('./inbox').observe(observer);
          again = true;
        }
        if (finished || drain.signal.aborted) return;
        // An owner wakes on what it must do, read from the state: on each
        // event, and at least once a minute for the idle limit, which no
        // event marks.
        if (f.own) {
          if (rows.length || Date.now() >= ownAt) {
            const Ownership = require('./ownership');
            const st = S.loadState(ctx.stateDir);
            ownAt = Date.now() + Math.min(60000, Ownership.limits(st.project).idle_minutes * 15000);
            const outcome = Ownership.outcome(st, T.getTask(st, task), ctx.agent);
            if (outcome) woken = { type: 'own', ...outcome };
          }
          return;
        }
        for (const e of rows) {
          if (!wakes(e, filter)) continue;
          const at = { ...e, cursor: formatCursor(e.offset, cuts) };
          if (!f.follow) {
            woken = at;
            return;
          }
          process.stdout.write(JSON.stringify(wake(at)) + '\n');
        }
      } catch (e) {
        fail(e);
      } finally {
        checking = false;
        if (again && !finished && !woken && !failure && !drain.signal.aborted && !expired) { again = false; void check(); }
        settle();
      }
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    // A follower's reader went away; nobody is left to wake.
    process.once(OUTPUT_PIPE_CLOSED, interrupt);
    // A state change can free or create a worker slot: an exit, submit,
    // rework, answered decision or task update.
    const wakeBoth = () => {
      require('./containment').sweepDue();
      void check();
      void fill();
    };
    // Install before checking, covering writes during watch setup as well.
    try {
      watcher = fs.watch(ctx.stateDir, (event, name) => {
        if (!name || STATE_FILES.has(String(name))) wakeBoth();
      });
      watcher.on('error', () => {
        watcher.close();
        watcher = null;
      });
    } catch {
      // The stat and process check below also runs when directory watch is absent.
    }
    fallback = setInterval(wakeBoth, FALLBACK_MS);
    if (f.follow) process.stdout.write(JSON.stringify({ type: 'ready', offset: after, cursor: formatCursor(after, reader.cuts) }) + '\n');
    if (timeout !== undefined) deadline = setTimeout(() => {
      expired = true;
      // The pass running now, or the one started here, is the last: a tick,
      // watch event or hold timer that started another pass or refill while a
      // refill ran on would carry the wait past its deadline.
      stopWatching();
      if (!checking) void check();
    }, timeout * 1000);
    wakeBoth();
  });
}

module.exports = { message, wait, startCursor, observe, canObserve, sources, show, wakes, wake, pending, notice, readFrom, parseEvent, QUIET };
