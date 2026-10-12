'use strict';

const fs = require('node:fs');
const os = require('node:os');
const S = require('./state');
const { byId } = require('./util');

const TAIL_LINES = 20;
const TAIL_BYTES = 8192;

function linuxProcess(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The executable name can contain spaces and parentheses, so fields start
    // after its closing parenthesis.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], start_ticks: fields[19], cpu_ticks: Number(fields[11]) + Number(fields[12]) };
  } catch {
    return null;
  }
}

function identity(pid) {
  const info = linuxProcess(pid);
  return { host: os.hostname(), ...(info ? { start_ticks: info.start_ticks } : {}) };
}

function processState(spawn) {
  // A PID only identifies a process on the machine that started it.
  if (spawn.host && spawn.host !== os.hostname()) return 'unknown';
  if (!Number.isInteger(spawn.pid) || spawn.pid <= 0) return 'unknown';
  try { process.kill(spawn.pid, 0); }
  catch (e) { return e.code === 'ESRCH' ? 'exited' : 'unknown'; }
  const info = linuxProcess(spawn.pid);
  if (process.platform === 'linux' && !info) return 'unknown';
  // Detached children can remain zombies under an init that does not reap them.
  // A reused PID must not hide the exit of the process we actually started.
  return info && (['Z', 'X'].includes(info.state)
    || (spawn.start_ticks !== undefined && spawn.start_ticks !== info.start_ticks)) ? 'exited' : 'running';
}

function exited(spawn) {
  return processState(spawn) === 'exited';
}

function processGroupState(spawn) {
  const pgid = spawn.pgid || spawn.pid;
  if (spawn.host && spawn.host !== os.hostname()) return 'unknown';
  // Windows has no process groups. The lease gate exits only after the harness it started
  // does, so the gate's exit is the proof of exit there.
  if (process.platform === 'win32') return processState(spawn);
  if (!Number.isInteger(pgid) || pgid <= 0) return 'unknown';
  // Without /proc, a signal to the group proves exit only when no member remains.
  if (process.platform !== 'linux') {
    try { process.kill(-pgid, 0); return 'unknown'; }
    catch (e) { return e.code === 'ESRCH' ? 'exited' : 'unknown'; }
  }
  try { process.kill(-pgid, 0); }
  catch (e) { return e.code === 'ESRCH' ? 'exited' : 'unknown'; }
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return 'unknown'; }
  let incomplete = false;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) === pgid && !['Z', 'X'].includes(fields[0])) return 'running';
    } catch (e) {
      if (!['ENOENT', 'ESRCH'].includes(e.code)) incomplete = true;
    }
  }
  // Zombies retain their group id but cannot execute or hold worktree resources.
  return incomplete ? 'unknown' : 'exited';
}

function spawnAttempt(spawn, events) {
  if (spawn.detail.attempt !== undefined) return spawn.detail.attempt;
  // Older spawns still have their position in the job's dispatch history.
  return events.slice(0, events.indexOf(spawn) + 1)
    .filter((e) => e.cmd === 'spawn' && e.task === spawn.task && e.detail.role === spawn.detail.role).length;
}

function exitSpawn(receipt, events) {
  for (let i = events.indexOf(receipt) - 1; i >= 0; i--) {
    const e = events[i];
    if (!['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) || e.task !== receipt.task
      || e.detail.agent !== receipt.detail.agent || e.detail.pid !== receipt.detail.pid) continue;
    if (receipt.detail.attempt === undefined || receipt.detail.attempt === spawnAttempt(e, events)) return e;
  }
  return null;
}

function logTail(log) {
  if (!log) return '';
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.toString('utf8', 0, n);
    // Skip a partial first line when the byte limit cuts through a large log.
    if (offset && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1);
    return text.replace(/\r?\n$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  } catch (e) {
    return `[log unavailable: ${e.code || e.message}]`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function runPhase(st, task, events = st.events || S.readEvents(st.dir)) {
  if (['accepted', 'cancelled'].includes(task.status)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.task !== task.id) continue;
    if (['release', 'submit', 'rework'].includes(e.cmd)) return null;
    if (e.cmd === 'claim' && task.claim && e.agent !== task.claim.agent) return null;
    if (['spawn phase', 'spawn', 'interrupt'].includes(e.cmd) && e.detail.phase) {
      if (task.claim && task.claim.agent !== e.detail.agent) return null;
      // A replacement claim cannot inherit an earlier supervisor under the same name.
      const job = events.findLast((x) => x.task === task.id && x.cmd === 'spawn' && x.detail.agent === e.detail.agent);
      if (task.claim && job) {
        const claims = events.filter((x) => x.task === task.id && x.cmd === 'claim' && !x.detail.renewed && Date.parse(x.at) >= Date.parse(job.at));
        if (claims.length > 1 || job.detail.claim_since && job.detail.claim_since !== task.claim.since) return null;
      }
      return { ...e.detail, at: e.at };
    }
  }
  return null;
}

function supervised(st, task, events) {
  const run = runPhase(st, task, events);
  return !!run?.monitor_pid && (run.active ?? ['running', 'retrying'].includes(run.phase)) && processState({
    pid: run.monitor_pid, host: run.host, start_ticks: run.monitor_start_ticks,
  }) !== 'exited';
}

// Observers decide from the event log, not a probe: a sandboxed claimer cannot
// see a live monitor, so a probe would report it exited. An interrupted
// supervisor holds its task for one lease after its last record, as a worker slot does.
function interruptHeld(st, task, now = Date.now()) {
  const run = runPhase(st, task);
  return run?.phase === 'stopping' && run.active === true
    && Date.parse(run.at) + st.project.limits.lease_minutes * 60000 > now;
}

function phaseText(run) {
  if (!run) return '-';
  if (run.phase === 'retrying') return `retrying ${run.retry}`;
  if (run.phase === 'blocked') return `blocked: ${run.reason}`;
  return run.phase;
}

function cpuTicks(pid) {
  if (process.platform !== 'linux') return null;
  const info = linuxProcess(pid);
  if (!info) return null;
  let sum = info.cpu_ticks;
  try {
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    for (const child of children.split(/\s+/).filter(Boolean)) sum += cpuTicks(Number(child)) || 0;
  } catch { /* The child may exit between samples. */ }
  return sum;
}

function exitedClaims(st, events = S.readEvents(st.dir), { includeTail = true } = {}) {
  const pending = new Map(st.tasks.tasks
    .filter((t) => t.status === 'in_progress' && t.claim)
    .map((t) => [t.id, { task: t, sawClaim: false, spawn: null, exits: new Map() }]));
  if (!pending.size) return [];
  const found = [];
  function finish(id, p) {
    pending.delete(id);
    const detail = p.spawn?.detail;
    if (supervised(st, p.task, events)) return;
    if (detail && (p.exits.has(p.spawn) || exited(detail))) {
      let size = null;
      if (detail.log) {
        try { size = fs.statSync(detail.log).size; } catch { /* The log may be missing or unreadable. */ }
      }
      const code = p.exits.get(p.spawn);
      found.push({
        id, agent: detail.agent, pid: detail.pid, log: detail.log || null,
        code: Number.isInteger(code) ? code : null, size,
        ...(includeTail ? { tail: logTail(detail.log) } : {}),
      });
    }
  }
  for (let i = events.length - 1; i >= 0 && pending.size; i--) {
    const e = events[i];
    const p = pending.get(e.task);
    if (!p) continue;
    const detail = e.detail || {};
    if (['spawn exit', 'worker-exited'].includes(e.cmd) && detail.agent === p.task.claim.agent) {
      const spawn = exitSpawn(e, events);
      if (spawn && !p.exits.has(spawn)) p.exits.set(spawn, detail.code);
    }
    if (['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && detail.agent === p.task.claim.agent && Number.isInteger(detail.pid) && detail.pid > 0) {
      if (!p.spawn) p.spawn = e;
      // A spawn before the latest claim may belong to an earlier lease held
      // by the same agent. Defer it until its lifecycle boundary is known.
      if (!p.sawClaim) finish(e.task, p);
    } else if (['release', 'submit', 'rework', 'interrupt'].includes(e.cmd)) {
      finish(e.task, p);
    } else if (e.cmd === 'claim' && !e.detail.renewed) {
      // Workers commonly claim after spawn. Stop at an earlier claim or
      // lifecycle boundary so a released worker's PID cannot taint a new claim.
      // A renewal extends the lease its holder already has, so it starts none.
      if (p.sawClaim) {
        // A replacement can start during another worker's expired lease,
        // but the same identity must not inherit its previous lease's spawn.
        if (e.agent !== p.task.claim.agent) finish(e.task, p);
        else pending.delete(e.task);
      } else if (e.agent !== p.task.claim.agent) pending.delete(e.task);
      else p.sawClaim = true;
    }
  }
  for (const [id, p] of pending) finish(id, p);
  return found.sort(byId);
}

function exitedWorkers(st, events = S.readEvents(st.dir), options = {}) {
  const found = exitedClaims(st, events, options);
  // A harness can fail before it claims. Stop at recovery boundaries so an
  // earlier spawn cannot report against a replacement.
  const pending = new Map(st.tasks.tasks.filter((t) => ['todo', 'rework'].includes(t.status)).map((t) => [t.id, { exits: new Map() }]));
  for (let i = events.length - 1; i >= 0 && pending.size; i--) {
    const e = events[i];
    const p = pending.get(e.task);
    if (!p) continue;
    const detail = e.detail || {};
    if (['spawn exit', 'worker-exited'].includes(e.cmd)) {
      const spawn = exitSpawn(e, events);
      if (spawn && !p.exits.has(spawn)) p.exits.set(spawn, detail.code);
    }
    if (['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && detail.role === 'worker' && Number.isInteger(detail.pid) && detail.pid > 0) {
      pending.delete(e.task);
      if (supervised(st, st.tasks.tasks.find((t) => t.id === e.task), events)) continue;
      if (p.exits.has(e) || exited(detail)) {
        let size = null;
        if (detail.log) {
          try { size = fs.statSync(detail.log).size; } catch { /* The log may be unavailable. */ }
        }
        const code = p.exits.get(e);
        found.push({
          id: e.task, agent: detail.agent, pid: detail.pid, log: detail.log || null,
          code: Number.isInteger(code) ? code : null, size, spawn: e.id || e.at,
          ...(options.includeTail === false ? {} : { tail: logTail(detail.log) }),
        });
      }
    } else if (['release', 'submit', 'rework', 'claim', 'interrupt'].includes(e.cmd)) {
      pending.delete(e.task);
    }
  }
  return found.sort(byId);
}

function exitLines(claims) {
  if (!claims.length) return [];
  const lines = ['exited without submit:'];
  for (const c of claims) {
    lines.push(`  ${c.id} (${c.agent}, pid ${c.pid})`,
      `    log: ${c.log || '(foreground output; no log)'}`);
    if (c.log) {
      lines.push(`    tail (last ${TAIL_LINES} lines, at most ${TAIL_BYTES} bytes):`,
        ...(c.tail || '(empty)').split('\n').map((line) => `      ${line}`));
    }
    lines.push(`    recover: tower-crane release ${c.id} --reason "spawned process exited without submit"`);
  }
  return lines;
}

module.exports = { identity, processState, processGroupState, exited, spawnAttempt, exitSpawn, exitedClaims, exitedWorkers, exitLines, runPhase, phaseText, supervised, interruptHeld, cpuTicks };
