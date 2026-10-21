'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = '/sys/fs/cgroup';
const INTERVAL_MS = 100;
const TERM_GRACE_MS = 5000;
const MARK = 'TOWER_CRANE_CONTAINMENT';
const OWN_GROUP = /^(?:nested-)?tower-crane-\d+-[a-f0-9]{16}\.scope$/;
const OWN_UNIT = /tower-crane-(\d+)-[a-f0-9]{16}\.scope/;
const REPORT_DIR = /^tower-crane-containment-(\d+)-/;
const LEGACY_REPORT_DIR = /^tower-crane-containment-[a-zA-Z0-9]{6}$/;
const SWEEP_INTERVAL_MS = 60000;
// Old reports have no owner identity. A reboot proves their supervisor is gone.
const sweptAt = new Map();
// Mandatory caps follow owner properties on the systemd-run line, so these owner keys never apply.
const MANDATORY = ['TasksMax', 'MemoryMax', 'MemorySwapMax', 'OOMPolicy', 'Delegate', 'Slice'];
let pageBytes;

function currentGroup(pid = 'self') {
  const entry = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((s) => s.startsWith('0::'));
  if (!entry) throw new Error('cgroup v2 unavailable');
  return path.join(ROOT, entry.slice(3));
}

// The innermost cgroup below the caller's slice that someone capped or delegated.
// systemd's DefaultTasksMax puts pids.max on every scope, so it alone marks no fence.
function fenceGroup(group = currentGroup()) {
  for (let dir = group; dir.startsWith(ROOT + path.sep) && !dir.endsWith('.slice'); dir = path.dirname(dir)) {
    if (Number.isFinite(number(path.join(dir, 'memory.max')))) return dir;
    try {
      const controllers = fs.readFileSync(path.join(dir, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/);
      if (['memory', 'pids'].every((name) => controllers.includes(name))) return dir;
    } catch { /* A cgroup without controller files is not a fence. */ }
  }
  return undefined;
}

function inheritedGroup(env) {
  if (process.platform === 'linux') {
    try {
      const here = currentGroup();
      for (let dir = here; dir.startsWith(ROOT + path.sep); dir = path.dirname(dir)) {
        if (OWN_GROUP.test(path.basename(dir))) return dir;
      }
      // A sibling scope in the slice would leave the caller's own fence.
      const fence = fenceGroup(here);
      if (fence) return fence;
    } catch { /* The marker also covers explicitly prepared safety scopes. */ }
  }
  return process.platform === 'linux' ? env[MARK] : undefined;
}

function delegated(group) {
  if (!group) return false;
  try {
    const here = currentGroup();
    if (here !== group && !here.startsWith(group + path.sep)) return false;
    fs.accessSync(path.join(group, 'cgroup.subtree_control'), fs.constants.W_OK);
    fs.accessSync(group, fs.constants.W_OK);
    const controllers = fs.readFileSync(path.join(group, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/);
    return ['memory', 'pids'].every((name) => controllers.includes(name));
  } catch { return false; }
}

function callerSlice(group = currentGroup()) {
  const slice = group.split('/').filter((name) => name.endsWith('.slice')).at(-1);
  if (!slice) throw new Error('caller has no systemd slice');
  return slice;
}

function canScope(env = process.env) {
  if (process.platform !== 'linux') return false;
  const group = inheritedGroup(env);
  if (group) return delegated(group);
  try { callerSlice(); } catch { return false; }
  return systemdAvailable();
}

function number(file) {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : Infinity;
  } catch { return Infinity; }
}

function budgetGroup(group) {
  const parts = group.split('/');
  const owned = parts.findIndex((name) => OWN_GROUP.test(name));
  // Attempt caps still apply in the kernel, but must not recursively divide
  // a new project's defaults each time an agent or gate initializes it.
  return owned < 0 ? group : parts.slice(0, owned).join('/');
}

function kernelTasks() {
  return Math.min(number('/proc/sys/kernel/threads-max'), number('/proc/sys/kernel/pid_max'));
}

function capacity() {
  let memory = os.totalmem();
  let tasks = process.platform === 'linux' ? kernelTasks() : Infinity;
  if (process.platform === 'linux') {
    try {
      for (let dir = budgetGroup(currentGroup()); dir.startsWith(ROOT); dir = path.dirname(dir)) {
        memory = Math.min(memory, number(path.join(dir, 'memory.max')));
        tasks = Math.min(tasks, number(path.join(dir, 'pids.max')));
        if (dir === ROOT) break;
      }
    } catch { /* Hosts without cgroup v2 use their physical capacity. */ }
  }
  return { memory, tasks };
}

function defaults(host = capacity(), slots = Math.max(1, Math.ceil(os.availableParallelism() / 4)), overrides = {}) {
  // Leave half the effective host/slice budget to other activities, then divide
  // the rest across concurrent launches.
  const tasks = Number.isFinite(host.tasks) ? host.tasks : process.platform === 'linux' ? kernelTasks() : Infinity;
  if (overrides.tasks_max === undefined && process.platform === 'linux' && !Number.isFinite(tasks)) {
    throw Object.assign(new Error('resource-monitor-failed: cannot read the host PID/thread budget'), { code: 'resource-monitor-failed' });
  }
  return {
    tasks_max: overrides.tasks_max ?? (Number.isFinite(tasks) ? Math.max(1, Math.floor(tasks / (2 * slots))) : 256),
    memory_max_bytes: overrides.memory_max_bytes ?? Math.max(1, Math.floor(host.memory / (2 * slots))),
  };
}

function resolve(project = {}, role, host = capacity()) {
  const explicit = project.resources || {};
  // An orchestrator's workers, reviewers and gate commands nest inside its
  // scope; the per-launch defaults split that same half of the budget.
  const fleet = defaults(host, 1, explicit);
  if (role === 'orchestrator') return fleet;
  const agent = defaults(host, undefined, explicit);
  if (role !== 'reviewer') return agent;
  // A reviewer's scope also holds the test probes it runs, as large as a gate command.
  const gate = resolveGate(project, host);
  return Object.fromEntries(Object.keys(agent).map((key) => [key,
    explicit[key] ?? Math.min(fleet[key], agent[key] + gate[key])]));
}

function resolveGate(project = {}, host = capacity()) {
  // Gates run at executor concurrency, rather than at agent CPU-slot concurrency.
  return defaults(host, project.gates?.executors ?? 2, project.resources);
}

function overridden(scope = {}) {
  return MANDATORY.filter((key) => Object.hasOwn(scope || {}, key));
}

function errors(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['resources must be an object'];
  return Object.entries(value).flatMap(([key, v]) => {
    if (!['tasks_max', 'memory_max_bytes'].includes(key)) return [`resources.${key} is unknown`];
    return Number.isSafeInteger(v) && v > 0 ? [] : [`resources.${key} must be a positive integer`];
  });
}

let manager;
function systemdAvailable() {
  if (manager === undefined) {
    manager = process.platform === 'linux' && fs.existsSync(path.join(ROOT, 'cgroup.controllers'))
      && cp.spawnSync('systemctl', ['--user', 'show-environment'], {
        stdio: 'ignore', timeout: 2000, windowsHide: true,
      }).status === 0;
  }
  return manager;
}

function counters(dir) {
  const read = (name) => {
    try {
      return Object.fromEntries(fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n')
        .map((line) => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
    } catch { return {}; }
  };
  const localMemory = fs.existsSync(path.join(dir, 'memory.events.local'));
  const memory = read(localMemory ? 'memory.events.local' : 'memory.events');
  return {
    tasks: read(fs.existsSync(path.join(dir, 'pids.events.local')) ? 'pids.events.local' : 'pids.events').max || 0,
    // A child's smaller cap must not fail its healthy parent orchestrator.
    memory: localMemory ? (memory.oom || 0) + (memory.oom_group_kill || 0) : memory.oom_kill || 0,
  };
}

function limitReason(dir, baseline, fleet = false) {
  const now = counters(dir);
  if (!fleet && now.memory > baseline.memory) return 'resource-memory-max';
  if (now.tasks > baseline.tasks) return 'resource-tasks-max';
  return null;
}

// How often a cgroup reached its own memory.max.
function capEvents(dir) {
  try {
    const line = fs.readFileSync(path.join(dir, 'memory.events.local'), 'utf8').split('\n').find((l) => l.startsWith('max '));
    return Number(line?.split(/\s+/)[1]) || 0;
  } catch { return 0; }
}

// With OOMPolicy=continue the manager keeps no oom-kill Result and removes an
// emptied scope's cgroup within milliseconds, so the scope's own OOM is read while
// the scope exists. The kernel counts an OOM before it kills, but notifies a file
// at most every 10 ms, so a cap event starts a window of reads every millisecond
// that spans two such intervals: an OOM counted inside the first is announced by
// the end of the second. A scope that stays at its cap opens at most one window
// per sampler interval, and an emptied scope stops the reads.
const CAP_POLL_MS = 1;
const CAP_WINDOW_MS = 20;
function watchOom(group, baseline, found, fleet = false) {
  let watcher;
  let timer = null;
  let stopped = false;
  let cap = 0;
  let opened = -Infinity;
  const stop = () => {
    stopped = true;
    watcher?.close();
    clearInterval(timer);
  };
  const read = () => {
    if (stopped) return;
    const reason = limitReason(group, baseline, fleet);
    if (reason) {
      stop();
      found(reason);
      return;
    }
    let events = '';
    try { events = fs.readFileSync(path.join(group, 'cgroup.events'), 'utf8'); } catch { /* Removed. */ }
    if (!/^populated 1$/m.test(events)) {
      stop();
      return;
    }
    const now = performance.now();
    if (timer && now - opened >= CAP_WINDOW_MS) {
      clearInterval(timer);
      timer = null;
    }
    const seen = capEvents(group);
    if (seen <= cap) return;
    cap = seen;
    if (!timer && now - opened >= INTERVAL_MS) {
      opened = now;
      timer = setInterval(read, CAP_POLL_MS);
      timer.unref();
    }
  };
  try {
    watcher = fs.watch(path.join(group, 'memory.events.local'), read);
    watcher.on('error', stop);
    watcher.unref();
  } catch { /* The sampler still reads the counters. */ }
  return stop;
}

function scopeMetrics(dir) {
  const peak = (file) => {
    try {
      const value = Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    } catch { return undefined; }
  };
  return {
    pids_peak: peak('pids.peak'),
    memory_peak_bytes: peak('memory.peak'),
    refused_forks: counters(dir).tasks,
  };
}

function linuxProcesses() {
  if (pageBytes === undefined) {
    const result = cp.spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 2000 });
    pageBytes = Number(result.stdout?.trim());
    if (!Number.isSafeInteger(pageBytes) || pageBytes < 1) throw new Error('cannot read host page size');
  }
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (['Z', 'X'].includes(fields[0])) continue;
      rows.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), state: fields[0],
        start: fields[19], rss: Number(fields[21]) * pageBytes });
    } catch (e) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) throw e;
    }
  }
  return rows;
}

async function processes() {
  if (process.platform === 'linux') return linuxProcesses();
  const win = process.platform === 'win32';
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '
    + '$start = ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); '
    + '$cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)); '
    + '"$($_.ProcessId) $($_.ParentProcessId) $start $($_.WorkingSetSize) $cmd" }';
  const args = win ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-axo', 'pid=,ppid=,pgid=,rss=,lstart=,command='];
  const output = await new Promise((accept, reject) => {
    cp.execFile(win ? 'powershell.exe' : 'ps', args, { encoding: 'utf8', timeout: win ? windowsWait() : 2000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : accept(stdout));
  });
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, group, rss, ...start] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: win ? null : Number(group),
      rss: Number(rss) * (win ? 1 : 1024), start: win ? Number(group) : start.slice(0, 5).join(' '),
      command: win ? Buffer.from(start[0] || '', 'base64').toString('utf8') : start.slice(5).join(' ') };
  });
}

// A cold Windows runner's CIM query takes many seconds, so the snapshot and the
// stop wait as long as the other CIM snapshots do.
function windowsWait() {
  return require('./state').LOCK_WAIT_MS;
}

function descendants(rows, pid, known) {
  // Windows does not reparent: an exited root's children still name its pid, and
  // the ones that started after its launch, which spawn records in known, are its own.
  const launched = process.platform === 'win32' && !rows.some((r) => r.pid === pid) ? known.get(pid) : undefined;
  const P = require('./processes');
  const orphan = (r) => launched !== undefined && r.parent === pid && r.start >= launched - P.WINDOWS_CLOCK_MS;
  const selected = new Set(rows.filter((r) => pid != null && (r.pid === pid || r.group === pid || orphan(r))
    || known.get(r.pid) === r.start).map((r) => r.pid));
  // A Windows row that names a parent started after it is the orphan of an
  // earlier process with that pid, such as a detached supervisor whose
  // dispatch exited, and stopping this tree must not reach it.
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const childOf = (row) => selected.has(row.parent)
    && (process.platform !== 'win32' || row.start >= byPid.get(row.parent).start - P.WINDOWS_CLOCK_MS);
  let changed;
  do {
    changed = false;
    for (const row of rows) if (!selected.has(row.pid) && childOf(row)) {
      selected.add(row.pid);
      changed = true;
    }
  } while (changed);
  const result = rows.filter((r) => selected.has(r.pid));
  for (const row of result) known.set(row.pid, row.start);
  return result;
}

function stopProcesses(rows, pid, spared = new Set(), signal = 'SIGKILL') {
  if (process.platform === 'win32') {
    rows = rows.filter(row => !spared.has(row.pid));
    const targets = new Map(rows.map(row => [row.pid, row]));
    const hasParent = row => targets.has(row.parent) && targets.get(row.parent).start <= row.start;
    const children = new Map();
    for (const row of rows) if (hasParent(row)) children.set(row.parent, [...(children.get(row.parent) || []), row]);
    const queue = rows.filter(row => !hasParent(row));
    const ordered = [];
    const seen = new Set();
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      ordered.push(row);
      queue.push(...(children.get(row.pid) || []));
    }
    // PID reuse can leave cycles even after newer-parent links are dropped.
    for (const row of rows) if (!seen.has(row.pid)) {
      seen.add(row.pid);
      ordered.push(row);
    }
    // A tree kill on a non-kept ancestor would also stop retained descendants.
    return require('./processes').windowsStop(cp.execFile, ordered, windowsWait(), spared.size === 0).catch(() => {});
  }
  let starts;
  if (process.platform !== 'linux') {
    const snapshot = cp.spawnSync('ps', ['-axo', 'pid=,lstart='], { encoding: 'utf8', timeout: 2000 });
    starts = new Map((snapshot.stdout || '').trim().split('\n').map(line => {
      const [id, ...start] = line.trim().split(/\s+/);
      return [Number(id), start.join(' ')];
    }));
  }
  const matches = row => {
    if (process.platform === 'linux') {
      try {
        const text = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
        return text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === row.start;
      } catch { return false; }
    }
    return starts.get(row.pid) === row.start;
  };
  if (signal !== 'SIGKILL') {
    for (const row of rows) if (!spared.has(row.pid) && matches(row)) {
      try { process.kill(row.pid, signal); } catch { /* Ended or no longer signalable. */ }
    }
    return;
  }
  if (process.platform === 'linux') {
    // Freeze live parents before the final snapshot so their last forks join the kill.
    const known = new Map();
    const failedStops = new Map();
    const clock = require('node:perf_hooks').performance;
    // Cleanup must yield within a monitoring interval even when a stop never settles.
    const deadline = clock.now() + INTERVAL_MS;
    let fresh = rows;
    while (fresh.length && clock.now() < deadline) {
      for (const row of fresh) if (!spared.has(row.pid) && matches(row)) {
        known.set(row.pid, row.start);
        try { process.kill(row.pid, 'SIGSTOP'); }
        catch { failedStops.set(row.pid, row.start); }
      }
      let snapshot;
      try { snapshot = linuxProcesses(); } catch { break; }
      const frozen = new Set(known.keys());
      const found = descendants(snapshot.filter(row => !spared.has(row.pid)), pid, known);
      // A pending stop needs another snapshot; a rejected stop cannot make progress.
      fresh = found.filter(row => failedStops.get(row.pid) !== row.start
        && (!frozen.has(row.pid) || !['T', 't', 'D'].includes(row.state)));
      rows = found;
    }
  }
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The group may already be gone. */ }
  }
  for (const row of rows) {
    if (!matches(row)) continue;
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* A sampled process may have exited. */ }
  }
}

function gone(pid) {
  return require('./processes').processState({ pid: Number(pid) }) === 'exited';
}

// A supervisor killed before its attempt closed leaves its report directory,
// and an OOM leaves its scope failed; both name the supervisor's pid.
function sweep(cache, manager = systemdAvailable()) {
  let names = [];
  try { names = fs.readdirSync(cache); } catch { /* No cache yet means nothing to sweep. */ }
  for (const name of names) {
    const pid = REPORT_DIR.exec(name)?.[1];
    if (pid ? !gone(pid) : !LEGACY_REPORT_DIR.test(name)) continue;
    if (!pid) {
      try {
        if (Date.now() - fs.statSync(path.join(cache, name)).mtimeMs <= os.uptime() * 1000) continue;
      } catch { continue; }
    }
    try { fs.rmSync(path.join(cache, name), { recursive: true, force: true }); } catch { /* A directory it cannot remove must not fail this launch. */ }
  }
  if (!manager) return;
  const listed = cp.spawnSync('systemctl', ['--user', 'list-units', '--all', '--state=failed', '--plain', '--no-legend', 'tower-crane-*.scope'],
    { encoding: 'utf8', timeout: 2000, windowsHide: true });
  let units = (listed.stdout || '').split('\n').map((line) => OWN_UNIT.exec(line)).filter((m) => m && gone(m[1])).map((m) => m[0]);
  // A keeper outlives its supervisor and still has to read its unit's Result.
  if (units.length) units = units.filter((unit) => !keeperUnits().has(unit));
  if (units.length) cp.spawnSync('systemctl', ['--user', 'reset-failed', ...units], { stdio: 'ignore', timeout: 2000, windowsHide: true });
}

function sweepDue(cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), manager) {
  const now = Date.now();
  if (sweptAt.has(cache) && now - sweptAt.get(cache) < SWEEP_INTERVAL_MS) return;
  sweptAt.set(cache, now);
  sweep(cache, manager);
}

function keeperUnits() {
  const units = new Set();
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { /* Without /proc no keeper can be told apart. */ }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let command;
    try { command = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
    if (!command.includes('containment-keeper.js')) continue;
    for (const match of command.matchAll(new RegExp(OWN_UNIT, 'g'))) units.add(match[0]);
  }
  return units;
}

// The manager marks a scope failed after its processes are gone, so wait for it to settle before resetting it.
function settle(unit, deadline = Date.now() + 5000) {
  cp.execFile('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8', timeout: 2000, windowsHide: true }, (error, stdout) => {
    const state = error ? '' : stdout.trim();
    if (state === 'failed') cp.execFile('systemctl', ['--user', 'reset-failed', unit], { timeout: 2000, windowsHide: true }, () => {});
    else if (['active', 'activating', 'deactivating'].includes(state) && Date.now() < deadline) setTimeout(settle, INTERVAL_MS, unit, deadline);
  });
}

function managed(rows, identities = [], rootPid) {
  const selected = new Set();
  for (const row of rows) {
    if (identities.some(id => id.pid === row.pid && id.start === row.start)) {
      selected.add(row.pid);
      // A foreground supervisor's parent holds its Windows job handle.
      if (process.platform === 'win32' && row.parent !== rootPid && rows.some(r => r.pid === row.parent)) selected.add(row.parent);
    }
  }
  let changed;
  do {
    changed = false;
    for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) {
      selected.add(row.pid);
      changed = true;
    }
  } while (changed);
  const result = rows.filter(row => selected.has(row.pid));
  return result;
}

async function processIdentity(pid = process.pid) {
  if (process.platform === 'linux') {
    const start = require('./processes').identity(pid).start_ticks;
    return start ? { pid, start } : null;
  }
  const row = (await processes()).find(row => row.pid === pid);
  return row ? { pid, start: row.start } : null;
}

function recorded(stateDir) {
  if (!stateDir) return [];
  const P = require('./processes');
  const records = [];
  for (const event of require('./state').readEvents(stateDir)) {
    const detail = event.detail;
    if (!detail || !['spawn', 'spawn retry', 'spawn fallback'].includes(event.cmd)
      || detail.host && detail.host !== os.hostname()) continue;
    const start = detail.monitor_start_ticks ?? detail.monitor_start_time;
    if (detail.monitor_pid && start !== undefined) records.push({ pid: detail.monitor_pid, start, kind: 'supervisor' });
  }
  const dir = path.join(stateDir, 'controllers');
  let names;
  try { names = fs.readdirSync(dir); } catch { return records; }
  for (const name of names) {
    if (!/^\d+-[a-f0-9]{16}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (record.host === os.hostname() && ['wait', 'check', 'accept', 'merge'].includes(record.command)
        && record.role === 'orchestrator' && Number.isInteger(record.pid) && record.start !== undefined) {
        if (P.processState({ pid: record.pid, host: record.host, ...(process.platform === 'linux' ? { start_ticks: record.start } : {}) }) === 'exited') {
          fs.rmSync(path.join(dir, name), { force: true });
        } else records.push(record);
      }
    } catch { /* A missing or unreadable identity grants no retention. */ }
  }
  return records;
}

async function registerController(ctx, command) {
  const S = require('./state');
  if (!['wait', 'check tests', 'check clean', 'check ci', 'check sources', 'accept', 'merge'].includes(command)
    || ctx.orchestratorLeasePending || require('./authority').role(ctx, S.readEvents(ctx.stateDir)) !== 'orchestrator') return () => {};
  S.loadState(ctx.stateDir);
  const identity = await processIdentity();
  if (!identity) throw new Error('cannot record controller process identity');
  const dir = path.join(ctx.stateDir, 'controllers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
  S.writeAtomic(file, JSON.stringify({ ...identity, host: os.hostname(), command: command.split(' ')[0], role: 'orchestrator' }));
  return () => {
    try { fs.rmSync(file, { force: true }); } catch { /* The state may have been removed while the command ran. */ }
  };
}

function removeGroup(group) {
  // A launcher can exit before its delayed cleanup removes an empty nested group.
  try {
    for (const entry of fs.readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory()) removeGroup(path.join(group, entry.name));
    }
  } catch { /* Setup can end before the runner leaf exists. */ }
  try { fs.rmdirSync(group); }
  catch { /* Its ancestor removes a remaining empty delegated group. */ }
}

function guardRemaining(state) {
  const known = new Map(state.rows.map(row => [row.pid, row.start]));
  let busy = false;
  // As in spawn: the manager removes the emptied scope before a tick could read its OOM.
  let seen = null;
  const stopOomWatch = state.unit && state.group ? watchOom(state.group, state.baseline, (reason) => { seen ||= reason; }, state.fleet) : null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    let rows = [];
    let reason;
    try {
      const snapshot = await processes();
      rows = state.group ? snapshot.filter(row => {
        try { const dir = currentGroup(row.pid); return dir === state.group || dir.startsWith(state.group + path.sep); }
        catch { return false; }
      }) : descendants(snapshot, null, known);
      const live = new Map(rows.map(row => [row.pid, row.start]));
      for (const [pid, start] of known) if (live.get(pid) !== start) known.delete(pid);
      reason = seen || (state.group ? limitReason(state.group, state.baseline, state.fleet)
        : rows.length > state.limits.tasks_max ? 'resource-tasks-max'
          : rows.reduce((sum, row) => sum + row.rss, 0) > state.limits.memory_max_bytes ? 'resource-memory-max' : null);
      if (state.unit && !rows.length && !reason && !fs.existsSync(state.group)) {
        const result = cp.spawnSync('systemctl', ['--user', 'show', state.unit, '-p', 'Result', '--value'],
          { encoding: 'utf8', timeout: 2000, windowsHide: true });
        if (!state.fleet && result.stdout?.trim() === 'oom-kill') reason = 'resource-memory-max';
      }
    } catch { reason = 'resource-monitor-failed'; rows = state.rows; }
    if (reason) {
      if (process.connected) {
        try { process.send({ reason }, () => {}); } catch { /* Its original caller may have exited. */ }
      }
      if (state.group) {
        try { fs.writeFileSync(path.join(state.group, 'cgroup.kill'), '1'); }
        catch { stopProcesses(rows, null); }
      } else stopProcesses(rows, null);
      process.exitCode = 1;
    }
    if (reason || !rows.length) {
      clearInterval(timer);
      stopOomWatch?.();
      if (state.group) removeGroup(state.group);
      // Result is read above, so the keeper resets its scope only now.
      if (state.unit) settle(state.unit);
      if (process.connected) process.disconnect();
    }
    busy = false;
  };
  const timer = setInterval(tick, INTERVAL_MS);
  return tick();
}

function fixtureLaunch(env = process.env) {
  return !!(process.env.NODE_TEST_CONTEXT || globalThis[Symbol.for('tower-crane.test-fixture')])
    && env.TOWER_CRANE_TEST_CONTAINMENT !== '1';
}

function scopeArguments(unit, slice, limits, scope = {}) {
  return ['--user', '--scope', '--quiet', '--expand-environment=no', `--unit=${unit}`, `--slice=${slice}`,
    ...Object.entries(scope).filter(([key]) => key !== 'Slice').flatMap(([key, value]) => ['-p', `${key}=${value}`]),
    '-p', `TasksMax=${limits.tasks_max}`, '-p', `MemoryMax=${limits.memory_max_bytes}`,
    '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue', '-p', 'Delegate=yes', '--'];
}

function launchPlan(file, args, opts = {}, unit = `tower-crane-${process.pid}-${crypto.randomBytes(8).toString('hex')}.scope`) {
  const env = opts.env || process.env;
  const limits = opts.resources || resolve();
  const inherited = inheritedGroup(env);
  const kernel = canScope(env);
  if (!kernel && !inherited && Object.keys(opts.scope || {}).length) {
    throw Object.assign(new Error('resource-scope-failed: configured outer scope requires cgroup v2 and a reachable systemd user manager'),
      { code: 'resource-scope-failed' });
  }
  const warning = !kernel && inherited
    ? `watchdog fallback inside non-delegated fence ${inherited}; the owner's scope properties were not applied`
    : undefined;
  let argv = [file, ...args];
  if (kernel) {
    require('./runtime').requireFile(path.join(__dirname, 'containment-runner.js'));
    const slice = callerSlice();
    const optionalScope = Object.keys(opts.scope || {}).length > 0;
    const target = inherited || (optionalScope ? '' : `@${unit}:${slice}`);
    argv = [process.execPath, path.join(__dirname, 'containment-runner.js'), JSON.stringify({ ...limits, fleet: !!opts.fleet }), target, unit, ...argv];
    if (!inherited && optionalScope) argv = ['systemd-run', ...scopeArguments(unit, slice, limits, opts.scope), ...argv];
  }
  return { argv, limits, inherited, kernel, unit, warning };
}

function spawn(file, args, opts = {}) {
  const env = opts.env || process.env;
  // Fixture hooks must reach the real CLI unchanged; the dedicated resource
  // probes opt in so they still exercise the launcher under the test fence.
  if (fixtureLaunch(env)) {
    const settings = require('./spawn-settings');
    const argv = settings.scopeCommand({ scope: opts.scope }, [file, ...args]);
    return cp.spawn(argv[0], argv.slice(1), { ...opts, shell: false,
      env: { ...env, ...(settings.scoped({ scope: opts.scope }) ? { TOWER_CRANE_SCOPED: '1' } : {}) } });
  }
  if (opts.shell) throw new Error('containment.spawn requires an executable and argv; gate shells are resolved before launch');
  const { argv, limits, inherited, kernel, unit, warning } = launchPlan(file, args, opts);
  let reportDir;
  let reportFile;
  if (kernel) {
    const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    fs.mkdirSync(cache, { recursive: true });
    sweepDue(cache);
    reportDir = fs.mkdtempSync(path.join(cache, `tower-crane-containment-${process.pid}-`));
    fs.chmodSync(reportDir, 0o700);
    reportFile = path.join(reportDir, 'report.json');
  }
  const launched = Date.now();
  const child = cp.spawn(argv[0], argv.slice(1), { ...opts, shell: false,
    detached: opts.detached ?? true, env: kernel ? { ...env, NODE_OPTIONS: undefined,
      TOWER_CRANE_CONTAINMENT_NODE_OPTIONS: env.NODE_OPTIONS ?? '',
      TOWER_CRANE_CONTAINMENT_REPORT: reportFile } : env });
  child.containment = { backend: kernel ? 'cgroup' : 'watchdog', ...limits,
    ...(warning ? { fence: inherited, warning } : {}), ...(kernel && !inherited ? { unit } : {}) };
  if (warning) process.stderr.write(`tower-crane: ${warning}\n`);
  let group;
  const nestedGroup = kernel && inherited ? path.join(inherited, `nested-${unit}`) : undefined;
  const baseline = { tasks: 0, memory: 0 };
  let stopped = false;
  let busy = false;
  let rows = [];
  // A root that exits before the first snapshot still has its launch time here.
  const known = new Map(process.platform === 'win32' && child.pid ? [[child.pid, launched]] : []);
  let exited = false;
  let finishing = false;
  let finishDone;
  child.containmentDone = new Promise(resolve => { finishDone = resolve; });
  const captureMetrics = () => {
    if (!group) return;
    for (const [key, value] of Object.entries(scopeMetrics(group))) {
      if (value !== undefined) child.containment[key] = Math.max(child.containment[key] || 0, value);
    }
  };
  const stopGroup = () => {
    const target = group || nestedGroup;
    if (target) {
      if (!fs.existsSync(target)) return;
      try { fs.writeFileSync(path.join(target, 'cgroup.kill'), '1'); return; } catch { /* Older kernels and delegation may not expose cgroup.kill. */ }
      if (!inherited) {
        const result = cp.spawnSync('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
          { stdio: 'ignore', timeout: 2000 });
        if (result.status === 0) return;
      }
      try {
        rows = linuxProcesses().filter((row) => {
          try { const member = currentGroup(row.pid); return member === target || member.startsWith(target + path.sep); }
          catch { return false; }
        });
      } catch { /* The existing group and last snapshot remain stoppable. */ }
    }
    if (kernel && !inherited && !group) {
      cp.spawnSync('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
        { stdio: 'ignore', timeout: 2000 });
    }
    const stopping = child.pid ? stopProcesses(rows, exited ? null : child.pid) : undefined;
    if (process.platform === 'win32' && !exited && !rows.some(row => row.pid === child.pid)) child.kill('SIGKILL');
    return stopping;
  };
  const fail = (reason) => {
    if (child.resourceReason) return;
    child.resourceReason = reason;
    child.emit('resourceLimit', reason);
    stopGroup();
  };
  let stopOomWatch;
  let lastReport;
  const readReport = () => {
    if (!reportFile) return;
    let text;
    try { text = fs.readFileSync(reportFile, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (text === lastReport) return;
    const report = JSON.parse(text);
    lastReport = text;
    if (report.unit !== unit) throw new Error('containment report unit mismatch');
    const validGroup = inherited ? report.group === path.join(inherited, `nested-${unit}`)
      : typeof report.group === 'string' && report.group.startsWith(ROOT + path.sep) && path.basename(report.group) === unit;
    // Reports must never redirect cgroup.kill to an ancestor or sibling.
    if (!group && validGroup) {
      group = report.group;
      child.containment.group = group;
      child.emit('containmentReady', child.containment);
      // The manager removes only a scope; a nested group stays until this launch removes it.
      if (!inherited) stopOomWatch = watchOom(group, baseline, fail, opts.fleet);
    }
    if (report.reason && report.error) child.containment.error = report.error;
    if (report.errorCode) child.emit('error', Object.assign(new Error(report.error), { code: report.errorCode }));
    if (['resource-tasks-max', 'resource-memory-max', 'resource-scope-failed', 'resource-monitor-failed'].includes(report.reason)) fail(report.reason);
  };
  const sample = async () => {
    if (busy || stopped || finishing || !child.pid) return;
    busy = true;
    try {
      readReport();
      if (group) {
        captureMetrics();
        const reason = limitReason(group, baseline, opts.fleet);
        if (reason) fail(reason);
      } else if (!kernel) {
        const snapshot = await processes();
        if (stopped) return;
        rows = descendants(snapshot, child.pid, known);
        if (rows.length > limits.tasks_max) fail('resource-tasks-max');
        else if (rows.reduce((sum, r) => sum + r.rss, 0) > limits.memory_max_bytes) fail('resource-memory-max');
      }
    } catch { fail('resource-monitor-failed'); }
    finally { busy = false; }
  };
  const timer = setInterval(sample, INTERVAL_MS);
  timer.unref();
  const finish = async () => {
    if (stopped || finishing) return;
    finishing = true;
    clearInterval(timer);
    try {
      try { readReport(); } catch { fail('resource-monitor-failed'); }
      if (stopped) return;
      if (group) {
        captureMetrics();
        const reason = limitReason(group, baseline, opts.fleet);
        if (reason) fail(reason);
      }
      if (!child.resourceReason && child.pid) {
        try {
          const owned = async () => {
            const snapshot = await processes();
            return group ? snapshot.filter(row => {
              try { const dir = currentGroup(row.pid); return dir === group || dir.startsWith(group + path.sep); }
              catch { return false; }
            }) : descendants(snapshot, child.pid, known);
          };
          rows = await owned();
          let retained = opts.preserveManaged !== false
            ? managed(rows, opts.retained?.() || recorded(opts.stateDir), child.pid) : [];
          if (exited && process.platform !== 'win32') {
            const deadline = require('node:perf_hooks').performance.now() + TERM_GRACE_MS;
            const signalled = new Map();
            for (;;) {
              retained = managed(rows, retained, child.pid);
              const keep = new Set(retained.map(row => row.pid));
              const leftovers = rows.filter(row => !keep.has(row.pid));
              if (!leftovers.length || child.resourceReason) break;
              const fresh = leftovers.filter(row => signalled.get(row.pid) !== row.start);
              stopProcesses(fresh, null, keep, 'SIGTERM');
              for (const row of fresh) signalled.set(row.pid, row.start);
              if (require('node:perf_hooks').performance.now() >= deadline) {
                if (keep.size) stopProcesses(leftovers, null, keep);
                else stopGroup();
                break;
              }
              await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
              readReport();
              rows = await owned();
              const reason = group ? limitReason(group, baseline, opts.fleet)
                : rows.length > limits.tasks_max ? 'resource-tasks-max'
                  : rows.reduce((sum, row) => sum + row.rss, 0) > limits.memory_max_bytes ? 'resource-memory-max' : null;
              if (reason) fail(reason);
            }
          }
          if (child.resourceReason) retained = [];
          if (retained.length) {
            const keep = new Set(retained.map(row => row.pid));
            const stopping = process.platform === 'win32'
              ? stopProcesses(rows.filter(row => !keep.has(row.pid)), null, keep) : undefined;
            const keeper = cp.spawn(process.execPath, [path.join(__dirname, 'containment-keeper.js'),
              JSON.stringify({ rows: retained.map(({ pid, parent, start, rss }) => ({ pid, parent, start, rss })),
                group, unit: group && !inherited ? unit : undefined, limits, baseline, fleet: !!opts.fleet })], {
              // A keeper outlives removable worktrees, tool copies, homes and test directories.
              cwd: path.parse(__dirname).root, env: { ...process.env, NODE_OPTIONS: undefined }, detached: true,
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
            require('./runtime').hold(path.resolve(__dirname, '..'), keeper.pid);
            child.containment.retained = retained.map(row => row.pid);
            child.containment.keeper_pid = keeper.pid;
            keeper.on('message', message => { if (message.reason) fail(message.reason); });
            keeper.once('error', () => fail('resource-monitor-failed'));
            keeper.once('exit', (code, signal) => {
              if ((code || signal) && !child.resourceReason) fail('resource-monitor-failed');
            });
            keeper.unref();
            keeper.channel?.unref();
            stopped = true;
            clearInterval(timer);
            await stopping;
            return;
          }
        } catch { if (opts.preserveManaged !== false) fail('resource-monitor-failed'); }
      }
      const stopping = !exited || child.resourceReason || process.platform === 'win32' ? stopGroup() : undefined;
      stopped = true;
      clearInterval(timer);
      // A keeper that took over the scope reads its Result later and settles it then.
      if (kernel && !inherited) settle(unit);
      // A detached descendant sampled before exit still belongs to this attempt.
      if (kernel && inherited) {
        const cleanup = setTimeout(() => {
          removeGroup(group || nestedGroup);
        }, INTERVAL_MS);
        cleanup.unref();
      }
      await stopping;
    } finally {
      stopOomWatch?.();
      finishDone();
    }
  };
  child.once('exit', (code, signal) => {
    exited = true;
    try { readReport(); } catch { fail('resource-monitor-failed'); }
    // Before the slower Result read: the manager may remove the emptied scope meanwhile.
    if (group && !child.resourceReason) {
      const reason = limitReason(group, baseline, opts.fleet);
      if (reason) fail(reason);
    }
    if (kernel && !inherited && !child.resourceReason && (signal === 'SIGKILL' || code === 137)) {
      const result = cp.spawnSync('systemctl', ['--user', 'show', unit, '-p', 'Result', '--value'],
        { encoding: 'utf8', timeout: 2000, windowsHide: true });
      if (!opts.fleet && result.stdout?.trim() === 'oom-kill') fail('resource-memory-max');
    }
    if (kernel && !group && !child.resourceReason) fail('resource-scope-failed');
    finish();
  });
  child.once('error', finish);
  child.once('close', () => {
    if (reportDir) fs.rmSync(reportDir, { recursive: true, force: true });
  });
  return child;
}

module.exports = { spawn, launchPlan, fixtureLaunch, scopeArguments, defaults, descendants, resolve, resolveGate, overridden, errors, capacity, budgetGroup, callerSlice, canScope, currentGroup, inheritedGroup, fenceGroup, counters, limitReason, watchOom, scopeMetrics, managed, recorded, registerController, processIdentity, stopProcesses, guardRemaining, sweep, sweepDue, settle, MARK, SWEEP_INTERVAL_MS };
