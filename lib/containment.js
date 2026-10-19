'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = '/sys/fs/cgroup';
const INTERVAL_MS = 100;
const MARK = 'TOWER_CRANE_CONTAINMENT';
const OWN_GROUP = /^(?:nested-)?tower-crane-\d+-[a-f0-9]{16}\.scope$/;
const OWN_UNIT = /tower-crane-(\d+)-[a-f0-9]{16}\.scope/;
const REPORT_DIR = /^tower-crane-containment-(\d+)-/;
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
  return env[MARK];
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

function limitReason(dir, baseline) {
  const now = counters(dir);
  if (now.memory > baseline.memory) return 'resource-memory-max';
  if (now.tasks > baseline.tasks) return 'resource-tasks-max';
  return null;
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
      rows.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
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
    + '"$($_.ProcessId) $($_.ParentProcessId) $start $($_.WorkingSetSize)" }';
  const args = win ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='];
  const output = await new Promise((accept, reject) => {
    cp.execFile(win ? 'powershell.exe' : 'ps', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : accept(stdout));
  });
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, group, rss, ...start] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: win ? null : Number(group),
      rss: Number(rss) * (win ? 1 : 1024), start: win ? Number(group) : start.join(' ') };
  });
}

function descendants(rows, pid, known) {
  const selected = new Set(rows.filter((r) => r.pid === pid || r.group === pid || known.get(r.pid) === r.start).map((r) => r.pid));
  let changed;
  do {
    changed = false;
    for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) {
      selected.add(row.pid);
      changed = true;
    }
  } while (changed);
  const result = rows.filter((r) => selected.has(r.pid));
  for (const row of result) known.set(row.pid, row.start);
  return result;
}

function stopProcesses(rows, pid) {
  if (process.platform === 'win32') {
    require('./processes').windowsStop(cp.execFile, rows, 2000).catch(() => {});
    return;
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The group may already be gone. */ }
  }
  for (const row of rows) {
    if (process.platform === 'linux') {
      try {
        const text = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
        if (text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== row.start) continue;
      } catch { continue; }
    }
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* A sampled process may have exited. */ }
  }
}

function gone(pid) {
  try { process.kill(Number(pid), 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

// A supervisor killed before its attempt closed leaves its report directory,
// and an OOM leaves its scope failed; both name the supervisor's pid.
function sweep(cache, manager = systemdAvailable()) {
  let names = [];
  try { names = fs.readdirSync(cache); } catch { /* No cache yet means nothing to sweep. */ }
  for (const name of names) {
    const pid = REPORT_DIR.exec(name)?.[1];
    if (pid && gone(pid)) fs.rmSync(path.join(cache, name), { recursive: true, force: true });
  }
  if (!manager) return;
  const listed = cp.spawnSync('systemctl', ['--user', 'list-units', '--all', '--state=failed', '--plain', '--no-legend', 'tower-crane-*.scope'],
    { encoding: 'utf8', timeout: 2000, windowsHide: true });
  const units = (listed.stdout || '').split('\n').map((line) => OWN_UNIT.exec(line)).filter((m) => m && gone(m[1])).map((m) => m[0]);
  if (units.length) cp.spawnSync('systemctl', ['--user', 'reset-failed', ...units], { stdio: 'ignore', timeout: 2000, windowsHide: true });
}

// The manager marks a scope failed after its processes are gone, so wait for it to settle before resetting it.
function settle(unit, deadline = Date.now() + 5000) {
  cp.execFile('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8', timeout: 2000, windowsHide: true }, (error, stdout) => {
    const state = error ? '' : stdout.trim();
    if (state === 'failed') cp.execFile('systemctl', ['--user', 'reset-failed', unit], { timeout: 2000, windowsHide: true }, () => {});
    else if (['active', 'activating', 'deactivating'].includes(state) && Date.now() < deadline) setTimeout(settle, INTERVAL_MS, unit, deadline);
  });
}

function fixtureLaunch(env = process.env) {
  return !!(process.env.NODE_TEST_CONTEXT || env.TC_ACCOUNT_HOME) && env.TOWER_CRANE_TEST_CONTAINMENT !== '1';
}

function scopeArguments(unit, slice, limits, scope = {}) {
  return ['--user', '--scope', '--quiet', '--expand-environment=no', `--unit=${unit}`, `--slice=${slice}`,
    ...Object.entries(scope).filter(([key]) => key !== 'Slice').flatMap(([key, value]) => ['-p', `${key}=${value}`]),
    '-p', `TasksMax=${limits.tasks_max}`, '-p', `MemoryMax=${limits.memory_max_bytes}`,
    '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=kill', '-p', 'Delegate=yes', '--'];
}

let swept = false;

function spawn(file, args, opts = {}) {
  const env = opts.env || process.env;
  // Fixture hooks must reach the real CLI unchanged; the dedicated resource
  // probes opt in so they still exercise the launcher under the test fence.
  if (fixtureLaunch(env)) {
    const argv = require('./spawn-settings').scopeCommand({ scope: opts.scope }, [file, ...args]);
    return cp.spawn(argv[0], argv.slice(1), { ...opts, shell: false });
  }
  if (opts.shell) throw new Error('containment.spawn requires an executable and argv; gate shells are resolved before launch');
  const limits = opts.resources || resolve();
  const inherited = inheritedGroup(env);
  const kernel = canScope(env);
  if (!kernel && !inherited && Object.keys(opts.scope || {}).length) {
    throw Object.assign(new Error('resource-scope-failed: configured outer scope requires cgroup v2 and a reachable systemd user manager'),
      { code: 'resource-scope-failed' });
  }
  const unit = `tower-crane-${process.pid}-${crypto.randomBytes(8).toString('hex')}.scope`;
  let reportDir;
  let reportFile;
  let argv = [file, ...args];
  if (kernel) {
    const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    fs.mkdirSync(cache, { recursive: true });
    if (!swept) {
      swept = true;
      sweep(cache);
    }
    reportDir = fs.mkdtempSync(path.join(cache, `tower-crane-containment-${process.pid}-`));
    fs.chmodSync(reportDir, 0o700);
    reportFile = path.join(reportDir, 'report.json');
    // Stay in the caller's slice; app.slice would evade its shared cap.
    const slice = callerSlice();
    const optionalScope = Object.keys(opts.scope || {}).length > 0;
    const target = inherited || (optionalScope ? '' : `@${unit}:${slice}`);
    argv = [process.execPath, path.join(__dirname, 'containment-runner.js'), JSON.stringify(limits), target, unit, ...argv];
    if (!inherited && optionalScope) {
      argv = ['systemd-run', ...scopeArguments(unit, slice, limits, opts.scope), ...argv];
    }
  }
  const child = cp.spawn(argv[0], argv.slice(1), { ...opts, shell: false,
    detached: process.platform !== 'win32', env: kernel ? { ...env, NODE_OPTIONS: undefined,
      TOWER_CRANE_CONTAINMENT_NODE_OPTIONS: env.NODE_OPTIONS ?? '',
      TOWER_CRANE_CONTAINMENT_REPORT: reportFile } : env });
  child.containment = { backend: kernel ? 'cgroup' : 'watchdog', ...limits, ...(kernel && !inherited ? { unit } : {}) };
  let group;
  let baseline = { tasks: 0, memory: 0 };
  let stopped = false;
  let busy = false;
  let rows = [];
  const known = new Map();
  const captureMetrics = () => {
    if (!group) return;
    for (const [key, value] of Object.entries(scopeMetrics(group))) {
      if (value !== undefined) child.containment[key] = Math.max(child.containment[key] || 0, value);
    }
  };
  const stopGroup = () => {
    if (group) {
      if (!fs.existsSync(group)) return;
      try { fs.writeFileSync(path.join(group, 'cgroup.kill'), '1'); return; } catch { /* Older kernels and delegation may not expose cgroup.kill. */ }
      if (!inherited) {
        const result = cp.spawnSync('systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
          { stdio: 'ignore', timeout: 2000 });
        if (result.status === 0) return;
      }
      try {
        rows = linuxProcesses().filter((row) => {
          try { const member = currentGroup(row.pid); return member === group || member.startsWith(group + path.sep); }
          catch { return false; }
        });
      } catch { /* The existing group and last snapshot remain stoppable. */ }
    }
    if (child.pid) stopProcesses(rows, child.pid);
  };
  const fail = (reason) => {
    if (child.resourceReason) return;
    child.resourceReason = reason;
    child.emit('resourceLimit', reason);
    if (process.platform === 'win32') child.kill('SIGKILL');
    stopGroup();
  };
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
    }
    if (report.reason && report.error) child.containment.error = report.error;
    if (report.errorCode) child.emit('error', Object.assign(new Error(report.error), { code: report.errorCode }));
    if (['resource-tasks-max', 'resource-memory-max', 'resource-scope-failed', 'resource-monitor-failed'].includes(report.reason)) fail(report.reason);
  };
  const sample = async () => {
    if (busy || stopped || !child.pid) return;
    busy = true;
    try {
      readReport();
      if (group) {
        captureMetrics();
        const reason = limitReason(group, baseline);
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
  const finish = () => {
    if (stopped) return;
    try { readReport(); } catch { fail('resource-monitor-failed'); }
    if (stopped) return;
    if (group) {
      captureMetrics();
      const reason = limitReason(group, baseline);
      if (reason) fail(reason);
      stopGroup();
    }
    stopped = true;
    clearInterval(timer);
    // A detached descendant sampled before exit still belongs to this attempt.
    if (!kernel && child.pid) stopProcesses(rows, child.pid);
    if (group && inherited) {
      const cleanup = setTimeout(() => {
        try { fs.rmdirSync(path.join(group, 'runner')); fs.rmdirSync(group); } catch { /* The ancestor scope removes any remaining empty groups. */ }
      }, INTERVAL_MS);
      cleanup.unref();
    }
  };
  child.once('exit', (code, signal) => {
    try { readReport(); } catch { fail('resource-monitor-failed'); }
    if (kernel && !inherited && !child.resourceReason && (signal === 'SIGKILL' || code === 137)) {
      const result = cp.spawnSync('systemctl', ['--user', 'show', unit, '-p', 'Result', '--value'],
        { encoding: 'utf8', timeout: 2000, windowsHide: true });
      if (result.stdout?.trim() === 'oom-kill') fail('resource-memory-max');
    }
    if (kernel && !group && !child.resourceReason) fail('resource-scope-failed');
    finish();
    if (kernel && !inherited) settle(unit);
  });
  child.once('error', finish);
  child.once('close', () => {
    if (reportDir) fs.rmSync(reportDir, { recursive: true, force: true });
  });
  return child;
}

module.exports = { spawn, fixtureLaunch, scopeArguments, defaults, resolve, resolveGate, overridden, errors, capacity, budgetGroup, callerSlice, canScope, currentGroup, fenceGroup, counters, limitReason, scopeMetrics, sweep, settle, MARK };
