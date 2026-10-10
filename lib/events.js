'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const Processes = require('./processes');
const { refuse, usage } = require('./util');

// Watch notifications can be dropped. This also checks detached process exits,
// which have no filesystem notification on Windows.
const FALLBACK_MS = 1000;
const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';

// Bookkeeping that arrives with every tool call or lease tick. A default wait
// skips it so the orchestrator never needs a type list; --types all restores
// the full stream.
const QUIET = new Set(['hook progress', 'hook report', 'hook inbox', 'renew', 'spend', 'spend live', 'spawn session', 'inbox snapshot', 'inbox ack']);

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
  require('./stack').observe(ctx);
  const observed = sources(st, st.events, Date.now());
  const candidates = require('./escalation').candidates(st);
  if (!observed.length && !candidates.length) return;
  try {
    S.mutate(ctx, 'observe', (current, emit) => {
      observe(current, emit, undefined, ctx);
    }, 0);
    const ids = new Set([...observed.map((e) => e.task), ...candidates]);
    for (const id of ids) {
      if (T.getTask(st, id).tier_range) await require('./escalation').recover({ ...ctx, pos: [id], flags: {} });
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
// unread until the next append finishes it or separates it after a crash.
function readFrom(file, after) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < after) throw refuse('events.jsonl shrank; the event log must be append-only');
    const rows = [];
    let offset = after;
    let pending = Buffer.alloc(0);
    while (offset < size) {
      const chunk = Buffer.alloc(Math.min(65536, size - offset));
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!n) break;
      offset += n;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        after += end + 1;
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        try {
          const e = JSON.parse(line);
          if (e && typeof e.cmd === 'string') rows.push({ ...e, type: e.type || S.eventType(e), to: e.to === undefined ? (e.cmd === 'msg' ? e.detail.to : 'orchestrator') : e.to, offset: after });
        } catch {
          // A crash can leave one broken audit record; later records still count.
        }
      }
    }
    return { rows, offset: after };
  } catch (e) {
    if (e.code === 'ENOENT' && after === 0) return { rows: [], offset: 0 };
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function cursor(file, value) {
  const size = sizeOf(file);
  if (value === undefined || value === 'now') return readFrom(file, 0).offset;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > size) throw usage('--after offset is outside events.jsonl');
    if (n) {
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
  return owner || e.agent !== agent || e.via === 'automation' || ['worker-exited', 'stall', 'inbox item'].includes(e.type);
}

// Pushes carry ids and kinds, never detail. The inbox supplies current
// findings without requiring the session to reconstruct event history.
function wake(e) {
  const out = { id: e.id, type: e.type, to: e.to, agent: e.agent, task: e.task ?? null, offset: e.offset };
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
    `Run \`tower-crane inbox\` for findings and resolving commands.${last?.offset ? ` Cursor: ${last.offset}.` : ''}`].join('\n');
}

// After a byte offset: the wakes for agent waiting as recipient, and the
// offset that reading stopped at.
function pending(stateDir, after, filter) {
  const batch = readFrom(path.join(stateDir, 'events.jsonl'), after);
  return { rows: batch.rows.filter((e) => wakes(e, filter)), offset: batch.offset };
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
  const filter = { recipient, agent: ctx.agent, task, types };
  const file = path.join(ctx.stateDir, 'events.jsonl');
  let after = cursor(file, f.after);
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
    let inboxAt = 0;
    const close = () => {
      finished = true;
      if (watcher) watcher.close();
      clearInterval(fallback);
      clearTimeout(deadline);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      process.removeListener(OUTPUT_PIPE_CLOSED, interrupt);
    };
    const done = (data, code = 0) => {
      close();
      process.stdout.write(JSON.stringify(data) + '\n');
      resolve({ printed: true, code });
    };
    const interrupt = () => {
      close();
      resolve({ printed: true, code: 130 });
    };
    // Startup snapshots precede state reconciliation. Observe lifecycle sources
    // in the subsequent blocking wait so taking a cursor cannot consume them.
    if (timeout === 0 && (f.after === undefined || f.after === 'now')) {
      done({ type: 'timeout', offset: after }, 2);
      return;
    }
    const check = async () => {
      if (finished) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        await detect(ctx);
        if (finished) return;
        const batch = readFrom(file, after);
        after = batch.offset;
        if (startup && !f.observe) {
          const reconcile = require('./automation').backlog(ctx);
          if (reconcile !== null) {
            startup = false;
            pending = reconcile;
          }
        }
        if (!f.observe) pending = await require('./automation').consume(ctx, [...pending, ...batch.rows]);
        // Remote-only findings have no local filesystem notification. One
        // refresh per minute bounds GitHub traffic even with busy hook writes.
        if (f.inbox && Date.now() >= inboxAt) {
          inboxAt = Date.now() + 60000;
          await require('./inbox').observe(ctx);
          again = true;
        }
        if (finished) return;
        for (const e of batch.rows) {
          if (!wakes(e, filter)) continue;
          if (!f.follow) {
            done(e);
            return;
          }
          process.stdout.write(JSON.stringify(wake(e)) + '\n');
        }
      } catch (e) {
        close();
        reject(e);
      } finally {
        checking = false;
        if (expired && !finished) done({ type: 'timeout', offset: after }, 2);
        if (again && !finished) { again = false; void check(); }
      }
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    // A follower's reader went away; nobody is left to wake.
    process.once(OUTPUT_PIPE_CLOSED, interrupt);
    // Install before checking, covering writes during watch setup as well.
    try {
      watcher = fs.watch(ctx.stateDir, (event, name) => {
        if (!name || ['events.jsonl', 'tasks.json', 'decisions.json', 'project.json'].includes(String(name))) check();
      });
      watcher.on('error', () => {
        watcher.close();
        watcher = null;
      });
    } catch {
      // The stat and process check below also runs when directory watch is absent.
    }
    fallback = setInterval(check, FALLBACK_MS);
    if (f.follow) process.stdout.write(JSON.stringify({ type: 'ready', offset: after }) + '\n');
    if (timeout !== undefined) deadline = setTimeout(() => {
      expired = true;
      if (!checking) void check();
    }, timeout * 1000);
    check();
  });
}

module.exports = { message, wait, observe, canObserve, sources, show, wakes, wake, pending, notice, readFrom, QUIET };
