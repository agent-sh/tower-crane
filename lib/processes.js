'use strict';

const cp = require('node:child_process');
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

// Whether a child of this process has exited while a synchronous wait keeps
// the event loop from reaping it. Linux shows the zombie in /proc and Windows
// reports the exit to the signal check (processState). Elsewhere, as on
// macOS, the zombie still takes signals, so ps, which reads the kernel's
// process table as waitpid would, shows its Z state. A ps that fails or
// times out proves nothing, and the caller keeps waiting.
function childExited(pid, platform = process.platform, run = cp.spawnSync) {
  if (processState({ pid }) === 'exited') return true;
  return platform !== 'linux' && platform !== 'win32' && psZombie(pid, run);
}

function psZombie(pid, run = cp.spawnSync) {
  const r = run('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, windowsHide: true });
  return !r.error && r.status === 0 && String(r.stdout).trim().startsWith('Z');
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
  // Linux hands out no pid that a process group still uses as its id. A
  // process at the leader's pid that started at another time therefore got
  // the pid after the recorded group emptied, and the group found is its own.
  if (pgid === spawn.pid && spawn.start_ticks != null) {
    const leader = linuxProcess(pgid);
    if (leader && leader.start_ticks !== String(spawn.start_ticks)) return 'exited';
  }
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

// The supervisor records active: false on a spawn phase only after its harness
// has exited, its output is captured, its process group is gone and no retry
// is queued; a retry or route fallback records a new spawn with its own pid
// first. That record answers alike for every observer, while a pid probe can
// flip once Windows hands the pid to another process.
function phaseEnded(spawn, events) {
  const attempt = spawnAttempt(spawn, events);
  for (let i = events.indexOf(spawn) + 1; i < events.length; i++) {
    const e = events[i];
    if (e.cmd === 'spawn phase' && e.task === spawn.task && e.detail.active === false
      && e.detail.agent === spawn.detail.agent && e.detail.pid === spawn.detail.pid
      && e.detail.attempt === attempt) return true;
  }
  return false;
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
    if (detail && (p.exits.has(p.spawn) || phaseEnded(p.spawn, events) || exited(detail))) {
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
      if (p.exits.has(e) || phaseEnded(e, events) || exited(detail)) {
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
// mark may be a list, read in one pass over /proc.
function strays(pgid, mark, { spareSupervisors = false } = {}) {
  const marks = [].concat(mark).filter(Boolean);
  if (process.platform !== 'linux' || !marks.length) return [];
  return collect(scan(marks, spareSupervisors), pgid, marks);
}

// One /proc pass for many marks at once: returns a function from a list of
// those marks to strays(null, list), each answer read from the same pass.
function strayIndex(marks, { spareSupervisors = false } = {}) {
  const all = [...new Set([].concat(marks).filter(Boolean))];
  if (process.platform !== 'linux' || !all.length) return () => [];
  const procs = scan(all, spareSupervisors);
  const children = childrenOf(procs);
  return (list) => {
    const wanted = [].concat(list).filter(Boolean);
    return wanted.length ? collect(procs, null, wanted, children) : [];
  };
}

// Each live process with its parent, its group, which of marks its
// environment carries and whether it is a supervisor. A mark is a variable
// name, so each process's names are looked up once, whatever the number of marks.
function scan(marks, spareSupervisors) {
  const wanted = new Set(marks);
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return []; }
  const procs = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) continue;
      const carried = new Set();
      let supervisor = false;
      try {
        for (const entry of fs.readFileSync(`/proc/${name}/environ`, 'latin1').split('\0')) {
          const eq = entry.indexOf('=');
          if (eq < 0) continue;
          const variable = entry.slice(0, eq);
          if (wanted.has(variable)) carried.add(variable);
          else if (spareSupervisors && variable === SUPERVISOR_MARK) supervisor = true;
        }
      } catch { /* Not ours to read. */ }
      procs.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), carried, supervisor });
    } catch {
      // The process exited while the list was read.
    }
  }
  return procs;
}

function childrenOf(procs) {
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  return children;
}

// The members of group pgid and the processes carrying one of marks, with
// every descendant still linked to them by parent, less the group's members.
function collect(procs, pgid, marks, children = childrenOf(procs)) {
  const found = new Set();
  const queue = procs.filter((p) => p.pgid === pgid || marks.some((m) => p.carried.has(m)));
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
function powershell(execFile, script, timeout, maxBuffer = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer }, (error, stdout) => {
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

// A process's creation time, read by one definition for the snapshot and for
// the stop, so a live process always compares equal to itself. Windows takes
// it from CIM in epoch ms. Process.StartTime is no second source: on Linux,
// .NET adds the process's start in jiffies to a boot time each PowerShell
// derives once from CLOCK_REALTIME_COARSE minus CLOCK_BOOTTIME, so two
// PowerShell processes disagree by a coarse clock tick (1 to 4 ms) or more
// when that clock lags. PowerShell 7 on Linux, where the tests run this
// script, has no CIM; there the time is the kernel's start in clock ticks
// since boot, at the fixed USER_HZ of 100, in ms.
const STARTS = [
  'function CimStart($c) { ([DateTimeOffset]$c.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }',
  'function Starts($ids) {',
  '  $w = @{}; foreach ($id in $ids) { $w[[int]$id] = 1 }; $s = @{}',
  '  if ($IsLinux) { foreach ($id in $w.Keys) { try { $f = [IO.File]::ReadAllText("/proc/$id/stat"); $s[$id] = 10 * [long]$f.Substring($f.LastIndexOf(")") + 2).Split(" ")[19] } catch { } } }',
  '  else { Get-CimInstance Win32_Process -Property ProcessId,CreationDate | Where-Object { $_.CreationDate -and $w.ContainsKey([int]$_.ProcessId) } | ForEach-Object { $s[[int]$_.ProcessId] = CimStart $_ } }',
  '  $s',
  '}',
].join('\n');

// Only a command line that names spawn-monitor leaves PowerShell; the others
// can be long (a browser's run to kilobytes) and are not needed. A row without
// one is under 100 bytes, so WINDOWS_SNAPSHOT_BYTES holds 65,536 processes
// (6.25 MiB) plus 300 command lines at Windows' 32,767-character limit (9.4 MiB).
const WINDOWS_SNAPSHOT_BYTES = 16 * 1024 * 1024;
async function windowsProcesses(execFile, timeout) {
  const script = STARTS + '\n$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | Where-Object { $_.CreationDate } | ForEach-Object { '
    + '[pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; '
    + 'start = CimStart $_; '
    + "command = $(if ($_.CommandLine -like '*spawn-monitor*') { $_.CommandLine } else { $null }) } }); "
    + 'ConvertTo-Json -InputObject $rows -Compress -Depth 2';
  const rows = JSON.parse((await powershell(execFile, script, timeout, WINDOWS_SNAPSHOT_BYTES)).join(''));
  return rows.filter((r) => [r.pid, r.parent, r.start].every(Number.isSafeInteger))
    .map((r) => ({ pid: r.pid, parent: r.parent, start: r.start, supervisor: supervisorCommand(r.command) }));
}

// The creation times of the given pids that still run, as Map(pid, start),
// read the way the stop compares them.
async function windowsStarts(execFile, pids, timeout) {
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const script = `${STARTS}\n$s = Starts @(${valid.join(',')})\nforeach ($k in $s.Keys) { [Console]::Out.WriteLine("$k $($s[$k])") }\nexit 0`;
  return new Map((await powershell(execFile, script, timeout)).map((line) => line.split(/\s+/).map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isSafeInteger)));
}

// The pids of a recorded spawn, from its event detail, that do not read as
// exited: its supervisor's and its harness's.
function spawnPids(detail) {
  const monitor = processState({ host: detail.host, pid: detail.monitor_pid, start_ticks: detail.monitor_start_ticks });
  const harness = processGroupState({ host: detail.host, pid: detail.pid, start_ticks: detail.start_ticks });
  return [[monitor, detail.monitor_pid], [harness, detail.pid]].filter(([state]) => state !== 'exited').map(([, pid]) => pid);
}

// When Windows created the processes now at the given pids, as Map(pid, UTC
// epoch ms). Windows keeps a process's creation time as a UTC FILETIME, and
// this reads it as one: a local time read in the hour a daylight saving change
// repeats, or after a time zone change, can be an hour off, which would make
// a running process look created after its spawn. A pid that no longer runs,
// or that Windows does not let us read, is left out, and so is every pid when
// PowerShell fails or runs out of time.
const FILETIME_UNIX_EPOCH = 116444736000000000n;
function windowsCreated(pids, timeout, run = cp.spawnSync) {
  const valid = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!valid.length) return new Map();
  const script = `foreach ($id in @(${valid.join(',')})) { try { $t = [Diagnostics.Process]::GetProcessById($id).StartTime.ToFileTimeUtc(); [Console]::Out.WriteLine("$id $t") } catch { } }\nexit 0`;
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout });
  if (r.error || r.status !== 0) return new Map();
  const created = new Map();
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^\s*(\d+) (\d+)\s*$/.exec(line);
    if (m && valid.includes(Number(m[1]))) created.set(Number(m[1]), Number((BigInt(m[2]) - FILETIME_UNIX_EPOCH) / 10000n));
  }
  return created;
}

// Whether a recorded spawn's supervisor and harness both exited, from its
// event detail and the time `at` (epoch ms) the event was recorded, when both
// had started. Windows records no start time with a pid (identity), and on a
// busy host it gives a freed pid to a new process within seconds, so a pid
// that still answers the signal check proves nothing there. Its process is a
// new one when `created` (windowsCreated) says Windows created it after `at`;
// one with no time there may be the recorded process and counts as running.
function spawnGone(detail, at, created = new Map(), platform = process.platform) {
  const left = spawnPids(detail);
  if (!left.length) return true;
  if (platform !== 'win32' || (detail.host && detail.host !== os.hostname()) || !Number.isFinite(at)) return false;
  return left.every((pid) => created.get(pid) > at + WINDOWS_CLOCK_MS);
}

// Stops each { pid, start } in order, in one PowerShell call that does not
// block the caller. Every target is opened first, and Windows does not give
// the pid of a process with an open handle to another, so the creation times
// read next, by the snapshot's own definition, belong to the opened
// processes. Each is then stopped through its handle, parents first, only if
// its time equals the snapshot's, so a pid Windows gave to a new process after
// the snapshot is left alone. The targets go in as one flat list of pid and
// time pairs, which PowerShell cannot unroll, whatever their number. Every
// target reports its outcome: stopped, gone (exited before its turn), reused
// (another process has the pid) or failed; a target that is gone does not fail
// the call. PowerShell 7 kills an exited process without an error, so the
// handle is asked whether it exited first.
//
// A Windows command line holds at most 32,767 characters. A target is at most
// 10 + 13 digits and two commas, 50 bytes of UTF-16 and 67 characters encoded;
// the script around them is under 4,500 encoded. So 350 targets a call keep
// the command line under 28,000 characters, with room for the program's path.
const WINDOWS_STOP_CHUNK = 350;
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
    STARTS,
    `$t = @(${valid.map((t) => `${t.pid},${t.start}`).join(',')})`,
    '$open = @{}; $r = @{}',
    'try {',
    '  for ($i = 0; $i -lt $t.Count; $i += 2) {',
    '    $id = [int]$t[$i]; $p = $null',
    '    if ($open.ContainsKey($id) -or $r.ContainsKey($id)) { continue }',
    '    try { $p = [System.Diagnostics.Process]::GetProcessById($id); $null = $p.Handle; $open[$id] = $p }',
    '    catch { $r[$id] = "failed"; try { if (-not $p -or $p.HasExited) { $r[$id] = "gone" } } catch { }; if ($p) { $p.Dispose() } }',
    '  }',
    '  $s = Starts @($open.Keys)',
    '  for ($i = 0; $i -lt $t.Count; $i += 2) {',
    '    $id = [int]$t[$i]; $p = $open[$id]',
    '    if ($p -and -not $r.ContainsKey($id)) {',
    '      try {',
    '        if (-not $s.ContainsKey($id)) { $r[$id] = "failed"; if ($p.HasExited) { $r[$id] = "gone" } }',
    '        elseif ($s[$id] -eq [long]$t[$i + 1]) { if ($p.HasExited) { $r[$id] = "gone" } else { $p.Kill(); $r[$id] = "stopped" } } else { $r[$id] = "reused" }',
    '      } catch {',
    '        $r[$id] = "failed"; try { if ($p.HasExited) { $r[$id] = "gone" } } catch { }',
    '      }',
    '    }',
    '    [Console]::Out.WriteLine("$id $($r[$id])")',
    '  }',
    '} finally { foreach ($p in $open.Values) { $p.Dispose() } }',
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

module.exports = { identity, processState, processGroupState, exited, childExited, psZombie, spawnAttempt, exitSpawn, exitedClaims, exitedWorkers, exitLines, logTail, TAIL_LINES, TAIL_BYTES, runPhase, phaseText, supervised, interruptHeld, cpuTicks, strays, strayIndex, withoutRunMarks, SUPERVISOR_MARK, supervisorCommand, windowsTree, windowsProcesses, windowsStarts, windowsStop, spawnPids, windowsCreated, spawnGone };
