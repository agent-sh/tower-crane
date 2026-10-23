'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('./containment');

const [settings, inherited, unitName, file, ...args] = process.argv.slice(2);
let group;
let setup = true;
const CPU_UNAVAILABLE = ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EBUSY'];
function hasCpu(dir) {
  try { return fs.readFileSync(path.join(dir, 'cgroup.controllers'), 'utf8').trim().split(/\s+/).includes('cpu'); }
  catch (error) { if (CPU_UNAVAILABLE.includes(error.code)) return false; throw error; }
}
function cpu(dir, weight) {
  if (!hasCpu(dir)) return false;
  try {
    fs.writeFileSync(path.join(dir, weight === undefined ? 'cgroup.subtree_control' : 'cpu.weight'),
      weight === undefined ? '+cpu' : String(weight));
    return true;
  } catch (error) { if (CPU_UNAVAILABLE.includes(error.code)) return false; throw error; }
}
function publish(extra = {}) {
  const report = process.env.TOWER_CRANE_CONTAINMENT_REPORT;
  if (!report) return;
  const tmp = report + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ unit: unitName, group, ...extra }), { mode: 0o600 });
  fs.renameSync(tmp, report);
}
try {
  const { fleet = false, xdg_runtime_dir, cpuWeight = require('./governor').cpuWeight(), ...limits } = JSON.parse(settings);
  if (typeof fleet !== 'boolean' || (xdg_runtime_dir !== undefined && xdg_runtime_dir !== null && typeof xdg_runtime_dir !== 'string')
    || C.errors(limits).length
    || !Number.isInteger(cpuWeight) || cpuWeight < 1 || cpuWeight > 10000) throw new Error('invalid limits');
  const niceOnly = inherited === '!nice';
  if (!niceOnly) group = C.currentGroup();
  let cpuApplied = !niceOnly && hasCpu(group) && fs.existsSync(path.join(group, 'cpu.weight'));
  if (inherited && !niceOnly) {
    // A nested systemd-run would move out of its parent's capped scope.
    // Delegated children retain every ancestor's aggregate kernel limits.
    if (group !== inherited && !group.startsWith(inherited + path.sep)) throw new Error('inherited scope mismatch');
    const parentCpu = cpu(inherited);
    group = path.join(inherited, `nested-${unitName}`);
    fs.mkdirSync(group);
    fs.writeFileSync(path.join(group, 'pids.max'), String(limits.tasks_max));
    fs.writeFileSync(path.join(group, 'memory.max'), String(limits.memory_max_bytes));
    fs.writeFileSync(path.join(group, 'memory.swap.max'), '0');
    cpuApplied = parentCpu && cpu(group, cpuWeight);
    fs.writeFileSync(path.join(group, 'cgroup.procs'), String(process.pid));
  }
  if (!niceOnly) {
    // An ancestor with group killing enabled would kill healthy sibling attempts.
    fs.writeFileSync(path.join(group, 'memory.oom.group'), fleet ? '0' : '1');
    // Move the runner into a leaf before enabling controllers for nested work.
    const leaf = path.join(group, 'runner');
    fs.mkdirSync(leaf);
    fs.writeFileSync(path.join(leaf, 'cgroup.procs'), String(process.pid));
    fs.writeFileSync(path.join(group, 'cgroup.subtree_control'), '+pids +memory');
    cpu(group);
  }
  let priority;
  let warning;
  let cpuBackend = cpuApplied ? 'cgroup' : 'nice';
  if (!cpuApplied) {
    try {
      priority = os.getPriority();
      if (!niceOnly) {
        const target = Math.min(19, priority + require('./governor').cpuNice(cpuWeight));
        if (priority !== target) os.setPriority(target);
        priority = target;
      }
    } catch (error) {
      cpuBackend = 'native';
      warning = `CPU weight could not be applied: ${error.message}`;
    }
  }
  publish({ cpu_weight_backend: cpuBackend, ...(priority !== undefined ? { nice: priority } : {}), ...(warning ? { warning } : {}) });
  setup = false;
  let denied = false;
  const executable = file.includes('/') ? file : (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter)
    .map((dir) => path.resolve(dir, file)).find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return true;
        denied = true;
      } catch (error) { if (error.code === 'EACCES') denied = true; }
      return false;
    });
  if (!executable) throw Object.assign(new Error(`cannot execute: ${file}`), { code: denied ? 'EACCES' : 'ENOENT' });
  const env = { ...process.env, ...(!niceOnly ? { [C.MARK]: group, TOWER_CRANE_SCOPED: '1' } : {}) };
  // The wrapper's transport setting must not change the command's environment.
  if (xdg_runtime_dir === null) delete env.XDG_RUNTIME_DIR;
  else if (xdg_runtime_dir !== undefined) env.XDG_RUNTIME_DIR = xdg_runtime_dir;
  // Preload code may start processes; it runs only after the scope is ready.
  if (env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS) env.NODE_OPTIONS = env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_REPORT;
  try { process.execve(executable, [file, ...args], env); }
  catch (error) {
    if (error.code !== 'ENOEXEC') throw error;
    process.execve('/bin/sh', ['/bin/sh', executable, ...args], env);
  }
} catch (error) {
  publish({
    ...(setup ? { reason: 'resource-scope-failed' } : { errorCode: error.code || 'ERR_LAUNCH' }),
    error: error.message });
  process.exitCode = 1;
}
