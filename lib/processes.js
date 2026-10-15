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
  // Windows has no process groups, so the harness's own exit stands for its group's.
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

// A spawn's run marker names its agent's own processes. A launch an agent
// starts (a task it dispatches, the gates its wait runs) is not that agent's
// to stop, so it starts without the marker. A gate's marker stays inherited:
// whatever a gate command starts, a nested gate or supervisor included, is
// that gate's, and its cleanup must still reach it.
const SPAWN_MARK = /^TOWERCRANE_SPAWN_RUN_/i;
// Every supervisor carries SUPERVISOR_MARK, which its harness does not
// inherit. An agent's output release never enters a supervisor or what runs
// below it: that is another task's agent, even when the agent started it.
const SUPERVISOR_MARK = 'TOWERCRANE_SUPERVISOR';
function withoutRunMarks(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SPAWN_MARK.test(name)
    && name.toUpperCase() !== SUPERVISOR_MARK));
}

// Linux: the processes a command or harness started that left its process group. A process
// started detached is in a new session, which the group kill misses, and when its parent
// exits first it is reparented away from the command. Each run marks its environment with a
// variable of its own, which descendants inherit unless they clear their environment; the
// processes of the group and the marked ones, with every descendant still linked to them by
// parent, are the command's. Read before any signal, parent links still hold; the marked ones
// are found after their parent is gone too.
// With spareSupervisors, a supervisor and everything below it are left out.
function strays(pgid, mark, { spareSupervisors = false } = {}) {
  if (process.platform !== 'linux' || !mark) return [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return []; }
  const procs = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) continue;
      let marked = false;
      let supervisor = false;
      try {
        const environ = `\0${fs.readFileSync(`/proc/${name}/environ`, 'latin1')}`;
        marked = environ.includes(`\0${mark}=`);
        supervisor = spareSupervisors && environ.includes(`\0${SUPERVISOR_MARK}=`);
      } catch { /* Not ours to read. */ }
      procs.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), marked, supervisor });
    } catch {
      // The process exited while the list was read.
    }
  }
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  const found = new Set();
  const queue = procs.filter((p) => p.marked || p.pgid === pgid);
  while (queue.length) {
    const p = queue.pop();
    if (found.has(p) || p.supervisor) continue;
    found.add(p);
    queue.push(...(children.get(p.pid) || []));
  }
  // The group signal reaches its own members.
  return [...found].filter((p) => p.pgid !== pgid).map((p) => p.pid);
}

// Windows keeps an exited parent's pid on its children and can give that pid
// to a new process. So after a harness exits, its children are the processes
// naming its pid that started while it ran (from and to, epoch ms), and a
// deeper one is a child of a live process found here that started after it.
// A child whose own parent already exited cannot be traced. The clocks behind
// Date.now() and a process creation time tick at up to 15.6 ms, so the window
// takes a few ticks either side. Returns their rows, parents first, so a stop
// in this order reaches a parent before it can start another child.
const WINDOWS_CLOCK_MS = 100;
function windowsTree(rows, pid, from, to) {
  const children = new Map();
  for (const r of rows) children.set(r.parent, [...(children.get(r.parent) || []), r]);
  const found = [];
  const seen = new Set();
  const queue = (children.get(pid) || []).filter((r) => r.pid !== pid
    && r.start >= from - WINDOWS_CLOCK_MS && r.start <= to + WINDOWS_CLOCK_MS);
  // libuv puts a child that is not detached, such as the supervisor of a
  // foreground spawn --wait, in a job that closes, and kills it, when its
  // parent dies. So the parent of a supervisor is spared too.
  const holdsSupervisor = (p) => (children.get(p.pid) || []).some((c) => c.supervisor && c.start >= p.start - WINDOWS_CLOCK_MS);
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid) || p.supervisor || holdsSupervisor(p)) continue;
    seen.add(p.pid);
    found.push(p);
    for (const c of children.get(p.pid) || []) if (c.pid !== p.pid && c.start >= p.start - WINDOWS_CLOCK_MS) queue.push(c);
  }
  return found;
}

// The script travels encoded, so no quoting or line break of the Windows
// command line can change it.
function powershell(execFile, script, timeout) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      });
  });
}

// One CIM snapshot of every process: pid, parent pid, creation time in epoch
// ms, and whether it is a supervisor. Windows does not show another process's
// environment, so a supervisor is known by its command line, which runs
// lib/spawn-monitor.js from wherever the tool is, under any quoting and either
// slash. An agent could name that file in a command of its own to keep a
// process from being stopped, but it can as well leave the process
// untraceable by letting its parent exit; this release cleans up after agents,
// it does not contain one, and it closes the pipes either way.
const SUPERVISOR_COMMAND = /(?:^|[\\/"'\s])spawn-monitor\.js(?=["'\s]|$)/i;
function supervisorCommand(commandLine) {
  return typeof commandLine === 'string' && SUPERVISOR_COMMAND.test(commandLine);
}

async function windowsProcesses(execFile, timeout) {
  const script = '$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | Where-Object { $_.CreationDate } | ForEach-Object { '
    + '[pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; '
    + 'start = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); command = $_.CommandLine } }); '
    + 'ConvertTo-Json -InputObject $rows -Compress -Depth 2';
  const rows = JSON.parse((await powershell(execFile, script, timeout)).join(''));
  return rows.filter((r) => [r.pid, r.parent, r.start].every(Number.isSafeInteger))
    .map((r) => ({ pid: r.pid, parent: r.parent, start: r.start, supervisor: supervisorCommand(r.command) }));
}

// Stops each { pid, start } in order, in one PowerShell call that does not
// block the caller. Each process is opened first and stopped through that
// handle only if it still has the snapshot's creation time, so a pid Windows
// gave to a new process after the snapshot is left alone. The CIM time has
// microseconds and the handle's 100 ns, so both are compared in whole ms, one
// apart at most. The targets go in as one flat list of pid and time pairs,
// which PowerShell cannot unroll, whatever their number. Every target reports
// its outcome: stopped, gone (exited before its turn), reused (another process
// has the pid) or failed; a target that is gone does not fail the call.
//
// A Windows command line holds at most 32,767 characters. A target is at most
// 10 + 13 digits and two commas, 50 bytes of UTF-16 and 67 characters encoded;
// the script around them is under 2,000 encoded. So 400 targets a call keep the
// command line under 29,000 characters, with room for the program's path.
const WINDOWS_STOP_CHUNK = 400;
async function windowsStop(execFile, targets, timeout) {
  const valid = targets.filter((t) => Number.isSafeInteger(t.pid) && t.pid > 0 && Number.isSafeInteger(t.start));
  const outcomes = [];
  for (let i = 0; i < valid.length; i += WINDOWS_STOP_CHUNK) {
    outcomes.push(...await windowsStopChunk(execFile, valid.slice(i, i + WINDOWS_STOP_CHUNK), timeout));
  }
  return outcomes;
}

async function windowsStopChunk(execFile, valid, timeout) {
  const script = [
    `$t = @(${valid.map((t) => `${t.pid},${t.start}`).join(',')})`,
    'for ($i = 0; $i -lt $t.Count; $i += 2) {',
    '  $p = $null; $r = "gone"',
    '  try {',
    '    $p = [System.Diagnostics.Process]::GetProcessById([int]$t[$i]); $null = $p.Handle',
    '    $s = ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
    '    if ([Math]::Abs($s - [long]$t[$i + 1]) -le 1) { $p.Kill(); $r = "stopped" } else { $r = "reused" }',
    '  } catch {',
    '    $r = "failed"; try { if (-not $p -or $p.HasExited) { $r = "gone" } } catch { }',
    '  } finally { if ($p) { $p.Dispose() } }',
    '  [Console]::Out.WriteLine("$($t[$i]) $r")',
    '}',
    'exit 0',
  ].join('\n');
  const outcomes = new Map((await powershell(execFile, script, timeout)).map((line) => line.split(/\s+/))
    .filter(([pid, outcome]) => /^\d+$/.test(pid) && outcome).map(([pid, outcome]) => [Number(pid), outcome]));
  return valid.map((t) => ({ pid: t.pid, outcome: outcomes.get(t.pid) || 'unreported' }));
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

module.exports = { identity, processState, processGroupState, exited, spawnAttempt, exitSpawn, exitedClaims, exitedWorkers, exitLines, logTail, TAIL_LINES, TAIL_BYTES, runPhase, phaseText, supervised, interruptHeld, cpuTicks, strays, withoutRunMarks, SUPERVISOR_MARK, supervisorCommand, windowsTree, windowsProcesses, windowsStop };
