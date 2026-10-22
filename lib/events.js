'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const Processes = require('./processes');
const { EventReader, cutBack, cutsSize, parseCursor, formatCursor, cutsAfterRead } = require('./event-reader');
const { refuse, usage } = require('./util');

// Watch notifications can be dropped. This also checks detached process exits,
// which have no filesystem notification on Windows.
const FALLBACK_MS = 1000;
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

function sources(st, events, now) {
  const seen = new Set(events.filter((e) => e.detail && e.detail.source).map((e) => e.detail.source));
  const out = [];
  const exited = new Map(Processes.exitedWorkers(st, events, { includeTail: false }).map((c) => [c.id, c]));
  for (const t of st.tasks.tasks) {
    const exit = exited.get(t.id);
    if (exit) {
      const source = JSON.stringify(['worker-exited', t.id, exit.agent, t.claim ? t.claim.since : exit.spawn, exit.pid]);
      const spawn = events.findLast((e) => ['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && e.task === t.id
        && e.detail.agent === exit.agent && e.detail.pid === exit.pid);
      if (!seen.has(source)) out.push({ task: t.id, type: 'worker-exited', detail: { ...exit, attempt: Processes.spawnAttempt(spawn, events), source } });
      continue;
    }
    if (t.status !== 'in_progress' || !t.claim) continue;
    if (Processes.supervised(st, t, events)) continue;
    let progress = Date.parse(t.claim.since);
    let interval = Date.parse(t.claim.until) - progress;
    for (const e of events) {
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
    if (!seen.has(source)) out.push({ task: t.id, type: 'stall', detail: { agent: t.claim.agent, until: t.claim.until, progress_at: new Date(progress).toISOString(), source } });
  }
  return out;
}

function canObserve(ctx, events, spawn) {
  if (['owner', 'orchestrator'].includes(ctx.agent)) return true;
  const job = events.findLast((e) => e.cmd === 'spawn' && e.detail.agent === ctx.agent);
  if (job?.detail.role === 'orchestrator') return true;
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
  if (!canObserve(ctx, st.events, spawn)) return;
  for (const e of sources(st, st.events, Date.now())) {
    emit(e.task, e.detail, e.type);
    if (e.type === 'worker-exited') require('./escalation').capRespawns(st, emit, e.task, { cmd: e.type, task: e.task, detail: e.detail }, ctx?.agent);
    if (e.type !== 'worker-exited' || (spawn?.task === e.task && spawn.detail.agent === e.detail.agent)) continue;
    const ev = st.events.findLast((x) => x.cmd === 'spawn' && x.task === e.task
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
  if (!canObserve(ctx, st.events)) return;
  await require('./stack').observe(ctx);
  if (ctx.automationSignal?.aborted) return;
  const observed = sources(st, st.events, Date.now());
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

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

// Offsets count bytes, including the newline. Leave an incomplete final record
// unread until the next append finishes it or separates it after a crash. An
// offset inside bytes lock recovery cut off reads from where the cut left the
// log (cutBack); `since` is the cuts file's length when it was taken. `cuts`
// is that length before reading, for the cursors handed out from it.
function readFrom(file, after, since = null) {
  let fd;
  let cuts = cutsSize(file);
  try {
    after = cutBack(file, after, since);
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < after) throw refuse('events.jsonl shrank; the event log must be append-only');
    const rows = [];
    let offset = after;
    const start = after;
    let pending = Buffer.alloc(0);
    let last = null;
    while (offset < size) {
      const chunk = Buffer.alloc(Math.min(65536, size - offset));
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!n) break;
      offset += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        after += end + 1;
        last = pending.subarray(0, end + 1);
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        try {
          const e = parseEvent(line, after);
          if (e) rows.push(e);
        } catch {
          // A crash can leave one broken audit record; later records still count.
        }
      }
    }
    cuts = cutsAfterRead(file, fd, cuts, start, after, last);
    return { rows, offset: after, cuts };
  } catch (e) {
    if (e.code === 'ENOENT' && after === 0) return { rows: [], offset: 0, cuts };
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseEvent(line, offset) {
  const e = JSON.parse(line);
  if (!e || typeof e.cmd !== 'string') return null;
  return { ...e, type: e.type || S.eventType(e), to: e.to === undefined ? (e.cmd === 'msg' ? e.detail.to : 'orchestrator') : e.to, offset };
}

// The offset to read after, and the cuts file's length when it was taken, so
// a reader started from it later also goes back for a cut recorded between.
function cursor(file, value) {
  if (value === undefined || value === 'now') {
    const end = readFrom(file, 0);
    return { offset: end.offset, cuts: end.cuts };
  }
  const cuts = cutsSize(file);
  return { offset: cursorOffset(file, value), cuts };
}

// A cursor that carries the cuts file's length resolves exactly; a plain
// offset falls back to what its bytes say (cutBack).
function cursorOffset(file, value) {
  const size = sizeOf(file);
  if (value === undefined || value === 'now') return readFrom(file, 0).offset;
  if (/^\d+(:\d+)?$/.test(value)) {
    const parsed = parseCursor(value);
    if (!parsed) throw usage('--after offset is outside events.jsonl');
    const given = parsed.offset;
    if (parsed.cuts !== null && parsed.cuts > cutsSize(file)) throw usage('--after cursor counts more cuts than events.cuts.jsonl holds');
    const n = cutBack(file, given, parsed.cuts);
    if (n > size) throw usage('--after offset is outside events.jsonl');
    // A cut leaves the log where an append began, which may be after a
    // fragment rather than a newline.
    if (n && n === given) {
      const fd = fs.openSync(file, 'r');
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, n - 1);
        if (byte[0] !== 10) throw usage('--after offset must follow a complete event line');
      } finally {
        fs.closeSync(fd);
      }
    }
    return n;
  }
  const found = readFrom(file, 0).rows.find((e) => e.id === value);
  if (!found) throw usage(`unknown event id ${value}`);
  return found.offset;
}

// The log's end as a cursor. Taken when a wait starts, before orchestrator
// process discovery, so events written during discovery are still delivered.
function startCursor(stateDir) {
  return cursor(path.join(stateDir, 'events.jsonl'), 'now');
}

// Whether event e wakes agent, waiting as recipient. A message to the agent's
// own name reaches it too, and owner input reaches the orchestrator whoever
// it was addressed to.
function wakes(e, { recipient = 'orchestrator', agent, task = null, types = null, directMessages = false }) {
  const owner = e.agent === 'owner';
  // Direct instructions must reach a task agent even during a filtered wait.
  if (directMessages && e.cmd === 'msg' && e.to === agent) return true;
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
  const batch = readFrom(path.join(stateDir, 'events.jsonl'), from.offset, from.cuts);
  const rows = batch.rows.filter((e) => wakes(e, filter)).map((e) => ({ ...e, cursor: formatCursor(e.offset, batch.cuts) }));
  return { rows, offset: batch.offset, cursor: formatCursor(batch.offset, batch.cuts) };
}

function show(ctx) {
  const id = ctx.pos[0];
  S.loadState(ctx.stateDir);
  const found = readFrom(path.join(ctx.stateDir, 'events.jsonl'), 0).rows.find((e) => e.id === id);
  if (!found) throw usage(`unknown event id ${id}`);
  const text = [`${found.id} ${found.type} ${found.at} by ${found.agent}${found.task ? ` on ${found.task}` : ''} to ${found.to}`, JSON.stringify(found.detail, null, 2)].join('\n');
  return { data: found, text };
}

function wait(ctx) {
  const release = S.retainEvents(ctx.stateDir);
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
  const directMessages = ctx.agent !== 'owner' && !require('./authority').isOrchestrator(ctx.agent, S.readEvents(ctx.stateDir));
  const filter = { recipient, agent: ctx.agent, task, types, directMessages };
  const file = path.join(ctx.stateDir, 'events.jsonl');
  const start = ctx.startCursor ?? cursor(file, f.after);
  let after = start.offset;
  const reader = new EventReader(file, { after, cuts: start.cuts, parse: parseEvent, restores: true });
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
        const observer = f.observe && require('./authority').role(ctx, S.readEvents(ctx.stateDir)) === 'orchestrator'
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
        if (!name || ['events.jsonl', 'tasks.json', 'decisions.json', 'project.json'].includes(String(name))) wakeBoth();
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
