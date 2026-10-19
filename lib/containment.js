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
let pageBytes;

function currentGroup(pid = 'self') {
  const entry = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((s) => s.startsWith('0::'));
  if (!entry) throw new Error('cgroup v2 unavailable');
  return path.join(ROOT, entry.slice(3));
}

function inheritedGroup(env) {
  if (process.platform === 'linux') {
    try {
      for (let dir = currentGroup(); dir.startsWith(ROOT + path.sep); dir = path.dirname(dir)) {
        if (OWN_GROUP.test(path.basename(dir))) return dir;
      }
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

function resolve(project = {}) {
  return defaults(capacity(), undefined, project.resources);
}

function resolveGate(project = {}, host = capacity()) {
  // Gates run at executor concurrency, rather than at agent CPU-slot concurrency.
  return defaults(host, project.gates?.executors ?? 2, project.resources);
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
    + '$cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)); '
    + '"$($_.ProcessId) $($_.ParentProcessId) $start $($_.WorkingSetSize) $cmd" }';
  const args = win ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : ['-axo', 'pid=,ppid=,pgid=,rss=,lstart=,command='];
  const output = await new Promise((accept, reject) => {
    cp.execFile(win ? 'powershell.exe' : 'ps', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : accept(stdout));
  });
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, parent, group, rss, ...start] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: win ? null : Number(group),
      rss: Number(rss) * (win ? 1 : 1024), start: win ? Number(group) : start.slice(0, 5).join(' '),
      command: win ? Buffer.from(start[0] || '', 'base64').toString('utf8') : start.slice(5).join(' ') };
  });
}

function descendants(rows, pid, known) {
  const selected = new Set(rows.filter((r) => pid != null && (r.pid === pid || r.group === pid)
    || known.get(r.pid) === r.start).map((r) => r.pid));
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
  } else if (pid) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The group may already be gone. */ }
  }
  for (const row of rows) {
    if (process.platform === 'linux') {
      try {
        const text = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
        if (text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19] !== row.start) continue;
      } catch { continue; }
    } else {
      const current = cp.spawnSync('ps', ['-p', String(row.pid), '-o', 'lstart='],
        { encoding: 'utf8', timeout: 2000 });
      if (current.status !== 0 || current.stdout.trim().split(/\s+/).join(' ') !== row.start) continue;
    }
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* A sampled process may have exited. */ }
  }
}

function managed(rows, gateMarks, previous = new Map(), rootPid) {
  const P = require('./processes');
  const selected = new Set();
  for (const row of rows) {
    let command = row.command;
    let names = row.envNames || [];
    if (process.platform === 'linux' && !row.envNames) {
      try { names = fs.readFileSync(`/proc/${row.pid}/environ`, 'utf8').split('\0').map(s => s.split('=', 1)[0]); }
      catch { /* Only processes owned by this user need their markers read. */ }
      try { command = fs.readFileSync(`/proc/${row.pid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
      catch { /* A process may exit while the snapshot is classified. */ }
    }
    if (previous.get(row.pid) === row.start || names.includes(P.SUPERVISOR_MARK)
      || P.managedCommand(command) || names.some(name => /^TOWERCRANE_GATE_RUN_/i.test(name) && !gateMarks.includes(name))) {
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
  for (const row of result) previous.set(row.pid, row.start);
  return result;
}

function removeGroup(group) {
  try { fs.rmdirSync(path.join(group, 'runner')); fs.rmdirSync(group); }
  catch { /* Its ancestor removes a remaining empty delegated group. */ }
}

function guardRemaining(state) {
  const known = new Map(state.rows.map(row => [row.pid, row.start]));
  let busy = false;
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
      reason = state.group ? limitReason(state.group, state.baseline)
        : rows.length > state.limits.tasks_max ? 'resource-tasks-max'
          : rows.reduce((sum, row) => sum + row.rss, 0) > state.limits.memory_max_bytes ? 'resource-memory-max' : null;
      if (state.unit && !rows.length && !reason && !fs.existsSync(state.group)) {
        const result = cp.spawnSync('systemctl', ['--user', 'show', state.unit, '-p', 'Result', '--value'],
          { encoding: 'utf8', timeout: 2000, windowsHide: true });
        if (result.stdout?.trim() === 'oom-kill') reason = 'resource-memory-max';
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
      if (state.group) removeGroup(state.group);
      if (process.connected) process.disconnect();
    }
    busy = false;
  };
  const timer = setInterval(tick, INTERVAL_MS);
  return tick();
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
    reportDir = fs.mkdtempSync(path.join(cache, 'tower-crane-containment-'));
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
    detached: opts.detached ?? true, env: kernel ? { ...env, NODE_OPTIONS: undefined,
      TOWER_CRANE_CONTAINMENT_NODE_OPTIONS: env.NODE_OPTIONS ?? '',
      TOWER_CRANE_CONTAINMENT_REPORT: reportFile } : env });
  child.containment = { backend: kernel ? 'cgroup' : 'watchdog', ...limits, ...(kernel && !inherited ? { unit } : {}) };
  let group;
  let baseline = { tasks: 0, memory: 0 };
  let stopped = false;
  let busy = false;
  let rows = [];
  const known = new Map();
  const kept = new Map();
  const gateMarks = Object.keys(env).filter(name => /^TOWERCRANE_GATE_RUN_/i.test(name));
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
    if (child.pid) stopProcesses(rows, exited ? null : child.pid);
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
    if (busy || stopped || finishing || !child.pid) return;
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
        if (opts.preserveManaged !== false) managed(rows, gateMarks, kept, child.pid);
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
        const reason = limitReason(group, baseline);
        if (reason) fail(reason);
      }
      if (!child.resourceReason && opts.preserveManaged !== false && child.pid) {
        try {
          const snapshot = await processes();
          rows = group ? snapshot.filter(row => {
            try { const dir = currentGroup(row.pid); return dir === group || dir.startsWith(group + path.sep); }
            catch { return false; }
          }) : descendants(snapshot, child.pid, known);
          const retained = managed(rows, gateMarks, kept, child.pid);
          if (retained.length) {
            const keep = new Set(retained.map(row => row.pid));
            stopProcesses(rows.filter(row => !keep.has(row.pid)), null);
            const keeper = cp.spawn(process.execPath, [path.join(__dirname, 'containment-keeper.js'),
              JSON.stringify({ rows: retained.map(({ pid, parent, start, rss }) => ({ pid, parent, start, rss })),
                group, unit: group && !inherited ? unit : undefined, limits, baseline })], {
              env: { ...process.env, NODE_OPTIONS: undefined }, detached: true,
              stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            });
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
            return;
          }
        } catch { fail('resource-monitor-failed'); }
      }
      stopGroup();
      stopped = true;
      clearInterval(timer);
      // A detached descendant sampled before exit still belongs to this attempt.
      if (group && inherited) {
        const cleanup = setTimeout(() => {
          removeGroup(group);
        }, INTERVAL_MS);
        cleanup.unref();
      }
    } finally { finishDone(); }
  };
  child.once('exit', (code, signal) => {
    exited = true;
    try { readReport(); } catch { fail('resource-monitor-failed'); }
    if (kernel && !inherited && !child.resourceReason && (signal === 'SIGKILL' || code === 137)) {
      const result = cp.spawnSync('systemctl', ['--user', 'show', unit, '-p', 'Result', '--value'],
        { encoding: 'utf8', timeout: 2000, windowsHide: true });
      if (result.stdout?.trim() === 'oom-kill') fail('resource-memory-max');
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

module.exports = { spawn, fixtureLaunch, scopeArguments, defaults, resolve, resolveGate, errors, capacity, budgetGroup, callerSlice, canScope, currentGroup, counters, limitReason, scopeMetrics, managed, guardRemaining, MARK };
