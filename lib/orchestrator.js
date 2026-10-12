'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const S = require('./state');
const A = require('./authority');
const { refuse, nowIso } = require('./util');

const READS = new Set(['authority', 'bench gates', 'bench tokens', 'project show', 'ladder show', 'browser-kit show', 'task show', 'task list', 'brief get', 'validate', 'ready', 'decisions', 'status', 'event', 'inbox', 'serve']);
const SESSION_ENV = ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
let ancestry;

function parents() {
  if (ancestry) return ancestry;
  let rows;
  if (process.platform === 'linux') {
    rows = [];
    let pid = process.ppid;
    const seen = new Set();
    while (pid > 1 && !seen.has(pid)) {
      seen.add(pid);
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        rows.push({ pid, parent: Number(fields[1]), name, start: fields[19],
          transient: /^(ba|da|z|k|fi)?sh$/.test(name) && args.some((a) => /^-[a-z]*c$/.test(a)) });
        pid = Number(fields[1]);
      } catch { break; }
    }
  } else {
    // Parent inspection happens before taking the state lock.
    const { execFileSync } = require('./commands');
    try {
      if (process.platform === 'win32') {
        // One CIM snapshot avoids a provider round trip for every ancestor.
        // Only the caller's chain leaves PowerShell, keeping pipe output bounded.
        const script = `$ErrorActionPreference='Stop'; $taskProcesses=@{};
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ForEach-Object {
  $taskProcesses[[int]$_.ProcessId]=$_
};
$taskParentPid=${process.ppid}; $taskParents=@(); $taskSeen=@{};
while ($taskParentPid -gt 1 -and !$taskSeen.ContainsKey($taskParentPid)) {
  $taskSeen[$taskParentPid]=$true;
  $taskParent=$taskProcesses[$taskParentPid];
  if (!$taskParent) { break }
  $taskStart=if ($taskParent.CreationDate) { $taskParent.CreationDate.ToUniversalTime().Ticks.ToString() } else { $null };
  $taskParents+=([pscustomobject]@{ ProcessId=$taskParent.ProcessId; ParentProcessId=$taskParent.ParentProcessId;
    Name=$taskParent.Name; CreationDate=$taskStart; CommandLine=$taskParent.CommandLine });
  $taskParentPid=[int]$taskParent.ParentProcessId
}
ConvertTo-Json -InputObject @($taskParents) -Compress`;
        rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
          script],
        { encoding: 'utf8', timeout: S.LOCK_WAIT_MS })).map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name, start: p.CreationDate,
          transient: /^(cmd|powershell|pwsh)\.exe$/i.test(p.Name) && /(?:\/c|-Command)\b/i.test(p.CommandLine || '') }));
      } else {
        rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10000 })
          .trim().split('\n').map((line) => {
            const [, pid, parent, name, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
            return { pid: Number(pid), parent: Number(parent), name,
              transient: /^(ba|da|z|k|fi)?sh$/.test(path.basename(name)) && /(?:^|\s)-[a-z]*c(?:\s|$)/.test(args) };
          });
      }
      const byPid = new Map(rows.map((p) => [p.pid, p]));
      rows = [];
      let pid = process.ppid;
      while (pid > 1 && byPid.has(pid)) {
        const p = byPid.get(pid);
        byPid.delete(pid);
        rows.push(p);
        pid = p.parent;
      }
    } catch (e) {
      if (process.platform === 'win32') throw refuse(`cannot determine the calling orchestrator process: ${e.code || e.message}; retry the command`);
      rows = [];
    }
  }
  // Tool shells change per command; the harness or interactive shell survives.
  const stable = rows.filter((p) => !p.transient);
  ancestry = stable.length ? stable : [{ pid: process.ppid, fallback: true }];
  return ancestry;
}

function identity(ctx) {
  if (ctx.orchestratorSession) return ctx.orchestratorSession;
  const chain = parents();
  const host = os.hostname();
  const harness = SESSION_ENV.find((key) => ctx.env?.[key]?.trim());
  const harness_session_id = harness ? ctx.env[harness].trim() : null;
  let pidns = null;
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* No pid namespaces on this platform. */ }
  // Resumed copies can share a harness id, so bind it to the live process too.
  // An ancestor exiting or changing its display metadata cannot replace the caller.
  const caller = { pid: chain[0].pid, start: chain[0].start ?? null };
  const key = JSON.stringify({ host, pidns, harness_session_id, caller });
  const lease = { session_id: createHash('sha256').update(key).digest('hex'), harness_session_id,
    pid: chain[0].pid, host, agent: ctx.agent };
  if (pidns) lease.pidns = pidns;
  if (process.platform === 'linux' && typeof chain[0].start === 'string') lease.start_ticks = chain[0].start;
  // Only a persistent caller can release by exiting; a fallback shell exits after every command.
  if (!chain[0].fallback) lease.persistent = true;
  return lease;
}

// A holder whose process has exited on this host releases the lease at once,
// so a restarted session never waits out lease_minutes behind a dead pid.
function holderExited(lease) {
  if (lease.persistent !== true || lease.host !== os.hostname()) return false;
  let pidns = null;
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* No pid namespaces on this platform. */ }
  // Linux holders must prove the same pid namespace; a missing one may be another container.
  if (process.platform === 'linux' && (!pidns || lease.pidns !== pidns)) return false;
  return require('./processes').processState({ pid: lease.pid, host: lease.host, start_ticks: lease.start_ticks }) === 'exited';
}

function live(st) {
  const lease = st.tasks.orchestrator_lease;
  return Boolean(lease) && Date.now() - Date.parse(lease.heartbeat) < st.project.limits.lease_minutes * 60000
    && !holderExited(lease);
}

function held(lease) {
  return `${lease.agent} session ${lease.harness_session_id || lease.session_id} (pid ${lease.pid} on ${lease.host}, heartbeat ${lease.heartbeat})`;
}

function blocked(lease) {
  return refuse(`orchestrator lease held by ${held(lease)}; reads remain open. Have that session run tower-crane orchestrator release, wait for the idle lease to expire, or ask the owner to run tower-crane orchestrator takeover --agent owner`);
}

function guard(ctx, st, write, renew = true) {
  if (A.role(ctx, st.events) !== 'orchestrator') return;
  const lease = st.tasks.orchestrator_lease;
  if (ctx.env?.TOWER_CRANE_VIA === 'automation') {
    // Expiry leaves a captured holder in place until a native session replaces it.
    const active = lease && !holderExited(lease) && (ctx.orchestratorSession || live(st)) ? lease : null;
    if (!Object.hasOwn(ctx, 'orchestratorSession')) ctx.orchestratorSession = active;
    if ((ctx.orchestratorSession?.session_id ?? null) !== (active?.session_id ?? null)) {
      throw refuse('orchestrator lease changed during automation; resume under the current holder');
    }
    // Worker completions cannot acquire a lease or keep an idle session alive.
    return;
  }
  const mine = identity(ctx);
  if (live(st) && lease.session_id !== mine.session_id) {
    if (write) throw blocked(lease);
    return;
  }
  if (!renew) {
    if (lease?.session_id === mine.session_id) return;
    if (ctx.orchestratorLeaseSession !== undefined) {
      throw refuse('orchestrator lease changed during command; start a new command under the current holder');
    }
  }
  // Reads can renew an existing holder but never acquire a vacant lease.
  if (!write && (!lease || lease.session_id !== mine.session_id)) return;
  st.tasks.orchestrator_lease = { ...mine, heartbeat: nowIso() };
}

function command(ctx, name) {
  if (name === 'init' || name === 'mcp' || name.startsWith('orchestrator ')) return;
  if (name === 'wait') ctx.orchestratorLeasePending = false;
  // Ordinary workers and owner reads do not need a heartbeat transaction.
  if (A.role(ctx, S.readEvents(ctx.stateDir)) !== 'orchestrator') return;
  if (ctx.env?.TOWER_CRANE_VIA !== 'automation') identity(ctx);
  const write = (!READS.has(name) || name === 'inbox' && ctx.flags.ack !== undefined)
    && !(name === 'spawn' && ctx.flags['dry-run'])
    && !(name === 'wait' && ctx.flags.observe);
  try {
    S.withLock(ctx.stateDir, () => {
      const st = S.loadState(ctx.stateDir);
      const before = S.json(st.tasks.orchestrator_lease ?? null);
      guard(ctx, st, write);
      if (ctx.env?.TOWER_CRANE_VIA !== 'automation' && st.tasks.orchestrator_lease?.session_id === identity(ctx).session_id) {
        ctx.orchestratorLeaseSession = st.tasks.orchestrator_lease.session_id;
      }
      if (S.json(st.tasks.orchestrator_lease ?? null) !== before) {
        const tasks = require('./evidence-store').tasksJson(st.tasks, ctx.stateDir, true);
        S.writeAtomic(path.join(ctx.stateDir, 'tasks.json'), tasks);
      }
    }, name === 'wait' ? 0 : S.LOCK_WAIT_MS);
  } catch (e) {
    // Wait's deadline starts inside its event loop; it must not wait here first.
    if (name !== 'wait' || e.code !== 3) throw e;
    ctx.orchestratorLeasePending = write;
  }
}

function release(ctx) {
  identity(ctx);
  const data = S.mutate(ctx, 'orchestrator release', (st, emit) => {
    if (A.role(ctx, st.events) !== 'orchestrator') throw refuse('only the holding orchestrator session releases its lease');
    const lease = st.tasks.orchestrator_lease;
    if (lease && lease.session_id !== identity(ctx).session_id) throw blocked(lease);
    st.tasks.orchestrator_lease = null;
    emit(null, { holder: lease || null });
    return { released: lease || null };
  });
  return { data, text: 'orchestrator lease released' };
}

function takeover(ctx) {
  const data = S.mutate(ctx, 'orchestrator takeover', (st, emit) => {
    if (A.role(ctx, st.events) !== 'owner') throw refuse('only the owner may take over an orchestrator lease');
    const lease = st.tasks.orchestrator_lease;
    st.tasks.orchestrator_lease = null;
    emit(null, { holder: lease || null });
    return { released: lease || null };
  });
  return { data, text: 'orchestrator lease cleared; the next orchestrator write takes it' };
}

module.exports = { identity, live, guard, command, release, takeover };
