'use strict';

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('./util').lazy('node:crypto');
const S = require('./state');
const A = require('./authority');
const { refuse, nowIso } = require('./util');

const READS = new Set(['authority', 'bench gates', 'bench tokens', 'project show', 'ladder show', 'browser-kit show', 'task show', 'task list', 'brief get', 'validate', 'ready', 'decisions', 'status', 'event', 'inbox', 'serve']);
const { SESSION_ENV } = require('./spawn-settings');
let ancestry;

const SHELL = /^(ba|da|z|k|fi)?sh$/;
const basename = (value) => (value || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
// A login shell's name starts with '-'; macOS ps prints it that way in comm too.
const shellName = (value) => basename(value).replace(/^-/, '');
const isShell = (value) => SHELL.test(shellName(value));

// Windows command lines follow CommandLineToArgvW: 2n backslashes before a quote
// give n backslashes and a quote mark, 2n+1 give n and a literal quote. In a run
// of quote marks every third one is literal, so "a""b" is a"b.
function commandLineArgs(line) {
  line ||= '';
  const space = (c) => c === ' ' || c === '\t';
  const args = [];
  let i = 0;
  while (space(line[i])) i++;
  if (i >= line.length) return args;
  // The program name ends at its closing quote or first space, without escapes.
  let current = '';
  if (line[i] === '"') {
    const end = line.indexOf('"', i + 1);
    current = line.slice(i + 1, end < 0 ? line.length : end);
    i = end < 0 ? line.length : end + 1;
  }
  while (i < line.length && !space(line[i])) current += line[i++];
  args.push(current);
  current = null;
  let quotes = 0;
  while (i < line.length) {
    const c = line[i];
    if (space(c) && !quotes) {
      if (current !== null) args.push(current);
      current = null;
      i++;
      continue;
    }
    current ??= '';
    if (c === '\\') {
      let n = 0;
      while (line[i] === '\\') { n++; i++; }
      if (line[i] !== '"') current += '\\'.repeat(n);
      else {
        current += '\\'.repeat(n >> 1);
        if (n % 2) { current += '"'; i++; }
      }
      continue;
    }
    if (c === '"') {
      quotes++;
      i++;
      while (line[i] === '"') {
        if (++quotes === 3) { current += '"'; quotes = 0; }
        i++;
      }
      if (quotes === 2) quotes = 0;
      continue;
    }
    current += c;
    i++;
  }
  if (current !== null) args.push(current);
  return args;
}

// Reads shell options the way the shell does: they end at the first operand.
function shellMode(args, program = args[0]) {
  const mode = { login: basename(args[0]).startsWith('-'), interactive: false, command: false, stdin: false, operand: false };
  const fish = shellName(program) === 'fish';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') { mode.operand = i + 1 < args.length; break; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (name === 'login') mode.login = true;
      else if (name === 'interactive') mode.interactive = true;
      else if (name === 'command') mode.command = true;
      else if (/^(rcfile|init-file|init-command)$/.test(name) && !a.includes('=')) i++;
      continue;
    }
    // fish's -C takes the init command, attached or as the next argument.
    const init = fish ? /^-([A-Za-z]*?)C(.*)$/.exec(a) : null;
    if (init) {
      mode.command ||= init[1].includes('c');
      mode.login ||= init[1].includes('l');
      mode.interactive ||= init[1].includes('i');
      if (!init[2]) i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === '-') {
        mode.command ||= a.includes('c');
        mode.login ||= a.includes('l');
        mode.interactive ||= a.includes('i');
        mode.stdin ||= a.includes('s');
      }
      // -o and -O take an option name as the next argument.
      if (/[oO]/.test(a)) i++;
      continue;
    }
    mode.operand = true;
    break;
  }
  return mode;
}

function sessionParent(p) {
  const args = p.args || commandLineArgs(p.commandLine);
  const name = basename(p.name);
  const harness = /^(claude|codex|opencode|agy|pi|gemini|aider|goose|cursor-agent)$/;
  if (harness.test(name) || harness.test(basename(args[0]))) return true;
  // Script-based harnesses can keep the runtime's process name.
  if (/^(node|bun|deno|python[\d.]*)$/.test(name)) {
    const entry = args.slice(1).find((a) => !a.startsWith('-')) || '';
    if (harness.test(basename(entry).replace(/\.([cm]?js|py)$/, ''))) return true;
    if (/[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?(?:claude-code|codex|opencode|agy|pi-coding-agent|gemini-cli|cursor-agent)[\\/]/.test(entry)) return true;
  }
  if (isShell(p.name)) {
    // A session shell reads commands from its terminal: a login or interactive
    // shell, or one with no command or script whose stdin is a terminal.
    const mode = shellMode(args, p.name);
    return !mode.command && (!mode.operand || mode.stdin) && (mode.login || mode.interactive || p.tty === true);
  }
  return /^(cmd|powershell|pwsh)$/.test(name) && !p.transient
    && !args.slice(1).some((a) => /^-File$/i.test(a) || !a.startsWith('-') && !a.startsWith('/'));
}

function terminal(pid) {
  try { return /^\/dev\/(pts\/\d+|tty[^/]*|console)$/.test(fs.readlinkSync(`/proc/${pid}/fd/0`)); } catch { return undefined; }
}

// Windows does not reparent: a parent created after its child is a reused pid.
function newer(parent, child) {
  return /^\d+$/.test(parent ?? '') && /^\d+$/.test(child ?? '') && BigInt(parent) > BigInt(child);
}

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
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const shell = isShell(name);
        rows.push({ pid, parent: Number(fields[1]), name, start: fields[19], args,
          transient: shell && shellMode(args, name).command, tty: shell ? terminal(pid) : undefined });
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
        // It starts at this process so the walk below can check its creation time.
        const script = `$ErrorActionPreference='Stop'; $taskProcesses=@{};
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ForEach-Object {
  $taskProcesses[[int]$_.ProcessId]=$_
};
$taskParentPid=${process.pid}; $taskParents=@(); $taskSeen=@{};
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
        { encoding: 'utf8', timeout: S.LOCK_WAIT_MS })).map((p) => {
          const args = commandLineArgs(p.CommandLine);
          return { pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name, start: p.CreationDate, args,
            transient: /^(cmd|powershell|pwsh)\.exe$/i.test(p.Name) && /(?:\/c|-Command)\b/i.test(p.CommandLine || '')
              || isShell(p.Name) && shellMode(args, p.Name).command };
        });
      } else {
        rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10000 })
          .trim().split('\n').map((line) => {
            const [, pid, parent, name, args] = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
            // ps joins arguments with spaces and does not quote them.
            const argv = args.split(/\s+/).filter(Boolean);
            return { pid: Number(pid), parent: Number(parent), name, args: argv,
              transient: isShell(name) && shellMode(argv, name).command };
          });
      }
      const byPid = new Map(rows.map((p) => [p.pid, p]));
      rows = [];
      let pid = process.ppid;
      let childStart = byPid.get(process.pid)?.start;
      while (pid > 1 && byPid.has(pid)) {
        const p = byPid.get(pid);
        if (newer(p.start, childStart)) break;
        byPid.delete(pid);
        rows.push(p);
        childStart = p.start;
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
  const harnessParent = chain.find(sessionParent);
  const parent = harnessParent || chain[0];
  const host = os.hostname();
  const harness = SESSION_ENV.find((key) => ctx.env?.[key]?.trim());
  const harness_session_id = harness ? ctx.env[harness].trim() : null;
  let pidns = null;
  try { pidns = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* No pid namespaces on this platform. */ }
  // Resumed copies can share a harness id, so bind it to the live process too.
  // Ancestors above the selected process do not contribute to its key.
  const caller = { pid: parent.pid, start: parent.start ?? null };
  const key = JSON.stringify({ host, pidns, harness_session_id, caller });
  const lease = { session_id: crypto.createHash('sha256').update(key).digest('hex'), harness_session_id,
    pid: parent.pid, host, agent: ctx.agent };
  if (pidns) lease.pidns = pidns;
  if (process.platform === 'linux' && typeof parent.start === 'string') lease.start_ticks = parent.start;
  // Only a recognized session ancestor releases by exiting; a caller fallback may be a per-command helper.
  lease.persistent = Boolean(harnessParent);
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

// Engine work binds to the recorded holder while its process lives, whether
// or not its heartbeat is fresh: idle expiry only lets a native session
// replace it, so a holder that returns to its own lease keeps its bindings.
function holder(st) {
  const lease = st.tasks.orchestrator_lease;
  return lease && !holderExited(lease) ? lease : null;
}

function held(lease) {
  return `${lease.agent} session ${lease.harness_session_id || lease.session_id} (pid ${lease.pid} on ${lease.host}, heartbeat ${lease.heartbeat})`;
}

function blocked(lease, mine) {
  if (lease.harness_session_id && lease.harness_session_id === mine.harness_session_id) {
    const inTree = lease.host === mine.host && (!lease.pidns || lease.pidns === mine.pidns)
      && parents().some((p) => p.pid === lease.pid && (!lease.start_ticks || p.start === lease.start_ticks));
    if (!inTree) {
      return refuse(`orchestrator lease held by ${held(lease)}; the caller carries the holder's session id but is outside the holder's process tree (detached); reads remain open. Run the command as a child of the holding session, or let tower-crane wait/automation run gates for it`);
    }
  }
  return refuse(`orchestrator lease held by ${held(lease)}; reads remain open. Have that session run tower-crane orchestrator release, wait for the idle lease to expire, or ask the owner to run tower-crane orchestrator takeover --agent owner`);
}

function guard(ctx, st, write, renew = true) {
  if (A.role(ctx, st.dir ? S.roles(st.dir) : st.events) !== 'orchestrator') return;
  const lease = st.tasks.orchestrator_lease;
  // In-process reactions set ctx.automation; a CLI child sets it only with
  // its agent home's key (lib/automation-key.js), never from the environment.
  if (ctx.automation === true) {
    const active = holder(st);
    if (!Object.hasOwn(ctx, 'orchestratorSession')) ctx.orchestratorSession = active;
    if ((ctx.orchestratorSession?.session_id ?? null) !== (active?.session_id ?? null)) {
      throw refuse('orchestrator lease changed during automation; resume under the current holder');
    }
    // Worker completions cannot acquire a lease or keep an idle session alive.
    return;
  }
  const mine = identity(ctx);
  if (live(st) && lease.session_id !== mine.session_id) {
    if (write) throw blocked(lease, mine);
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

// A heartbeat younger than a sixtieth of the lease window (a minute of the
// default hour) is not renewed, so idle expiry moves by at most that much.
const renewDue = (lease, project) => Date.now() - Date.parse(lease.heartbeat) >= project.limits.lease_minutes * 1000;

// Whether command entry needs the state lock. Most commands find the caller's
// own fresh lease, another live session's, or a vacant one a read does not
// take, and settle that from the files without the lock. Taking, renewing or
// replacing the lease happens under it.
function leaseTransaction(ctx, write) {
  // The lease is in the tasks envelope; no task is read.
  const st = S.docsView(ctx.stateDir);
  if (ctx.automation === true) {
    guard(ctx, st, write);
    return false;
  }
  const lease = st.tasks.orchestrator_lease;
  const mine = identity(ctx);
  if (live(st) && lease.session_id === mine.session_id) {
    ctx.orchestratorLeaseSession = lease.session_id;
    return renewDue(lease, st.project);
  }
  if (live(st)) {
    if (write) throw blocked(lease, mine);
    return false;
  }
  return write || lease?.session_id === mine.session_id;
}

function command(ctx, name) {
  if (name === 'init' || name === 'mcp' || name.startsWith('orchestrator ')) return;
  if (name === 'wait') ctx.orchestratorLeasePending = false;
  // Ordinary workers and owner reads do not need a heartbeat transaction.
  if (A.role(ctx, S.roles(ctx.stateDir)) !== 'orchestrator') return;
  if (ctx.automation !== true) identity(ctx);
  const write = (!READS.has(name) || name === 'inbox' && ctx.flags.ack !== undefined)
    && !(name === 'spawn' && ctx.flags['dry-run'])
    && !(name === 'wait' && ctx.flags.observe);
  if (!leaseTransaction(ctx, write)) return;
  // A read never waits for the lock: it tries once, and a busy lock leaves
  // the renewal to a later command. Wait's deadline starts inside its event
  // loop, so it must not wait here first either.
  const waitMs = write && name !== 'wait' ? S.lockWaitMs() : 0;
  try {
    S.withLock(ctx.stateDir, () => {
      const st = S.docsView(ctx.stateDir);
      const before = S.json(st.tasks.orchestrator_lease ?? null);
      guard(ctx, st, write);
      if (ctx.automation !== true && st.tasks.orchestrator_lease?.session_id === identity(ctx).session_id) {
        ctx.orchestratorLeaseSession = st.tasks.orchestrator_lease.session_id;
      }
      if (S.json(st.tasks.orchestrator_lease ?? null) !== before) S.writeTasksEnvelope(ctx.stateDir, st.tasks);
    }, waitMs, 'orchestrator lease');
  } catch (e) {
    if (waitMs || e.code !== 3) throw e;
    if (name === 'wait') ctx.orchestratorLeasePending = write;
  }
}

function release(ctx) {
  identity(ctx);
  const data = S.mutate(ctx, 'orchestrator release', (st, emit) => {
    if (A.role(ctx, st.events) !== 'orchestrator') throw refuse('only the holding orchestrator session releases its lease');
    const lease = st.tasks.orchestrator_lease;
    if (lease && lease.session_id !== identity(ctx).session_id) throw blocked(lease, identity(ctx));
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

module.exports = { identity, live, holder, guard, command, release, takeover, commandLineArgs };
