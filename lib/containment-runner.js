'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('./containment');

const [settings, inherited, unitName, file, ...args] = process.argv.slice(2);
let group;
try {
  const limits = JSON.parse(settings);
  if (C.errors(limits).length) throw new Error('invalid limits');
  const register = inherited.startsWith('@');
  if (register) {
    const [unit, slice] = inherited.slice(1).split(':');
    // Register this pid before exec so the harness keeps the dispatch's pid.
    const properties = [
      ['PIDs', 'au', '1', String(process.pid)],
      ['Slice', 's', slice],
      ['TasksMax', 't', String(limits.tasks_max)],
      ['MemoryMax', 't', String(limits.memory_max_bytes)],
      ['MemorySwapMax', 't', '0'],
      ['MemoryOOMGroup', 'b', 'true'],
      ['Delegate', 'b', 'true'],
    ];
    const result = cp.spawnSync('busctl', ['--user', 'call', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit',
      'ssa(sv)a(sa(sv))', unit, 'fail', String(properties.length), ...properties.flat(), '0'],
    { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    const deadline = performance.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (path.basename(C.currentGroup()) !== unit) {
      if (performance.now() >= deadline) throw new Error('scope registration did not move its pid');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  group = C.currentGroup();
  if (inherited && !register) {
    // A nested systemd-run would move out of its parent's capped scope.
    // Delegated children retain every ancestor's aggregate kernel limits.
    if (group !== inherited && !group.startsWith(inherited + path.sep)) throw new Error('inherited scope mismatch');
    group = path.join(inherited, `nested-${unitName}`);
    fs.mkdirSync(group);
    fs.writeFileSync(path.join(group, 'pids.max'), String(limits.tasks_max));
    fs.writeFileSync(path.join(group, 'memory.max'), String(limits.memory_max_bytes));
    fs.writeFileSync(path.join(group, 'memory.swap.max'), '0');
    fs.writeFileSync(path.join(group, 'memory.oom.group'), '1');
    fs.writeFileSync(path.join(group, 'cgroup.procs'), String(process.pid));
  }
  // Move the runner into a leaf before enabling controllers for nested work.
  const leaf = path.join(group, 'runner');
  fs.mkdirSync(leaf);
  fs.writeFileSync(path.join(leaf, 'cgroup.procs'), String(process.pid));
  fs.writeFileSync(path.join(group, 'cgroup.subtree_control'), '+pids +memory');
  const baseline = C.counters(group);
  fs.writeSync(2, C.REPORT + JSON.stringify({ group, baseline }) + '\n');
  const executable = file.includes('/') ? file : (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)
    .map((dir) => path.resolve(dir, file)).find((candidate) => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
    });
  if (!executable) throw new Error(`executable not found: ${file}`);
  process.execve(executable, [file, ...args], { ...process.env, [C.MARK]: group });
} catch (error) {
  process.stderr.write(C.REPORT + JSON.stringify({ reason: 'resource-scope-failed', error: error.message }) + '\n');
  process.exitCode = 1;
}
