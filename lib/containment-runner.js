'use strict';

const fs = require('node:fs');
const path = require('node:path');
const C = require('./containment');

const [settings, inherited, unitName, file, ...args] = process.argv.slice(2);
let group;
let setup = true;
function publish(extra = {}) {
  const report = process.env.TOWER_CRANE_CONTAINMENT_REPORT;
  if (!report) return;
  const tmp = report + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ unit: unitName, group, ...extra }), { mode: 0o600 });
  fs.renameSync(tmp, report);
}
try {
  const { fleet = false, xdg_runtime_dir, ...limits } = JSON.parse(settings);
  if (typeof fleet !== 'boolean' || (xdg_runtime_dir !== undefined && xdg_runtime_dir !== null && typeof xdg_runtime_dir !== 'string')
    || C.errors(limits).length) throw new Error('invalid limits');
  group = C.currentGroup();
  if (inherited) {
    // A nested systemd-run would move out of its parent's capped scope.
    // Delegated children retain every ancestor's aggregate kernel limits.
    if (group !== inherited && !group.startsWith(inherited + path.sep)) throw new Error('inherited scope mismatch');
    group = path.join(inherited, `nested-${unitName}`);
    fs.mkdirSync(group);
    fs.writeFileSync(path.join(group, 'pids.max'), String(limits.tasks_max));
    fs.writeFileSync(path.join(group, 'memory.max'), String(limits.memory_max_bytes));
    fs.writeFileSync(path.join(group, 'memory.swap.max'), '0');
    fs.writeFileSync(path.join(group, 'cgroup.procs'), String(process.pid));
  }
  // An ancestor with group killing enabled would kill healthy sibling attempts.
  fs.writeFileSync(path.join(group, 'memory.oom.group'), fleet ? '0' : '1');
  // Move the runner into a leaf before enabling controllers for nested work.
  const leaf = path.join(group, 'runner');
  fs.mkdirSync(leaf);
  fs.writeFileSync(path.join(leaf, 'cgroup.procs'), String(process.pid));
  fs.writeFileSync(path.join(group, 'cgroup.subtree_control'), '+pids +memory');
  publish();
  setup = false;
  const executable = file.includes('/') ? file : (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)
    .map((dir) => path.resolve(dir, file)).find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  if (!executable) throw Object.assign(new Error(`executable not found: ${file}`), { code: 'ENOENT' });
  const env = { ...process.env, [C.MARK]: group, TOWER_CRANE_SCOPED: '1' };
  // The wrapper's transport setting must not change the command's environment.
  if (xdg_runtime_dir === null) delete env.XDG_RUNTIME_DIR;
  else if (xdg_runtime_dir !== undefined) env.XDG_RUNTIME_DIR = xdg_runtime_dir;
  // Preload code may start processes; it runs only after the scope is ready.
  if (env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS) env.NODE_OPTIONS = env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_NODE_OPTIONS;
  delete env.TOWER_CRANE_CONTAINMENT_REPORT;
  process.execve(executable, [file, ...args], env);
} catch (error) {
  publish({
    ...(setup ? { reason: 'resource-scope-failed' } : { errorCode: error.code || 'ERR_LAUNCH' }),
    error: error.message });
  process.exitCode = 1;
}
