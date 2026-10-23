'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../../lib/containment');
const { writeAtomic } = require('../atomic-file');
const group = process.env.TC_FAKE_CGROUP;
const log = process.env.TC_FAKE_SYSTEMD_LOG;
const version = Number(process.env.TC_FAKE_SYSTEMD_VERSION || 259);
const types = { PIDs: 'au', Slice: 's', TasksMax: 't', MemoryMax: 't', MemorySwapMax: 't',
  OOMPolicy: 's', Delegate: 'b', CPUWeight: 't' };

function apply(properties) {
  if (properties.OOMPolicy !== 'continue') throw new Error('OOMPolicy must be continue');
  // systemd writes memory.oom.group=0 for OOMPolicy=continue; the runner sets it after.
  writeAtomic(path.join(group, 'memory.oom.group'), '0');
  if ((process.env.TC_FAKE_CPU_CONTROLLERS ?? 'cpu memory pids').split(/\s+/).includes('cpu')) {
    writeAtomic(path.join(group, 'cpu.weight'), String(properties.CPUWeight));
  }
  fs.appendFileSync(log, JSON.stringify(properties) + '\n');
}

if (require.main !== module) {
  // The bootstrap exercises real runner code against a private disk hierarchy.
  C.currentGroup = () => group;
  C.counters = () => ({ tasks: 0, memory: 0 });
  const readControllers = fs.readFileSync;
  fs.readFileSync = (file, ...args) => group && String(file).startsWith(group + path.sep)
    && path.basename(String(file)) === 'cgroup.controllers'
    ? process.env.TC_FAKE_CPU_CONTROLLERS ?? 'cpu memory pids' : readControllers(file, ...args);
  const writeControl = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...args) => {
    const inside = group && String(file).startsWith(group + path.sep);
    const enable = inside && path.basename(String(file)) === 'cgroup.subtree_control' && String(data).split(/\s+/).includes('+cpu');
    const weight = inside && path.basename(String(file)) === 'cpu.weight';
    const unavailable = !(process.env.TC_FAKE_CPU_CONTROLLERS ?? 'cpu memory pids').split(/\s+/).includes('cpu');
    const code = enable ? process.env.TC_FAKE_CPU_ENABLE_ERROR : weight ? process.env.TC_FAKE_CPU_WEIGHT_ERROR : null;
    if ((enable || weight) && (code || unavailable)) throw Object.assign(new Error('CPU controller unavailable'), { code: code || 'ENOENT' });
    if (inside && path.basename(String(file)) === 'cgroup.subtree_control') {
      let previous = '';
      try { previous = readControllers(file, 'utf8'); } catch { /* A new fake cgroup starts with no child controllers. */ }
      const controllers = new Set(previous.trim().split(/\s+/).filter(Boolean));
      for (const token of String(data).trim().split(/\s+/)) {
        if (token.startsWith('+')) controllers.add(token.slice(1));
        else if (token.startsWith('-')) controllers.delete(token.slice(1));
      }
      return writeControl(file, [...controllers].join(' '), ...args);
    }
    return writeControl(file, data, ...args);
  };
  if (process.env.TC_FAKE_NO_MANAGER) {
    const readFileSync = fs.readFileSync;
    fs.readFileSync = (file, ...args) => file === '/proc/self/cgroup'
      ? '0::/user.slice/user-1000.slice/user@1000.service/agents.slice/unmanaged.scope\n'
      : readFileSync(file, ...args);
  }
  const spawnSync = cp.spawnSync;
  cp.spawnSync = (file, args, opts) => {
    if (process.env.TC_FAKE_NO_MANAGER && file === 'systemctl') return { status: 1, stdout: '', stderr: 'no user manager' };
    return spawnSync(file, args, opts);
  };
} else if (process.argv[2] === '--version') {
  console.log(`systemd ${version} (${version}-fixture)`);
} else {
  try {
    // Like systemd-run, an absent runtime directory leaves only the session bus.
    if (!process.env.XDG_RUNTIME_DIR) throw new Error('systemd-run could not reach the private socket; runtime directory is unset');
    const args = process.argv.slice(2);
    const separator = args.indexOf('--');
    const literal = args.slice(0, separator).includes('--expand-environment=no');
    // systemd-run before 254 has no --expand-environment and never expands --scope argv.
    if (version < 254 && literal) throw new Error("systemd-run: unrecognized option '--expand-environment=no'");
    const properties = {};
    for (let n = 0; n < separator; n++) {
      if (args[n] !== '-p') continue;
      const assignment = args[++n];
      const equal = assignment.indexOf('=');
      const name = assignment.slice(0, equal);
      if (!['CPUQuota', ...Object.keys(types).filter((key) => key !== 'PIDs')].includes(name)) {
        throw new Error(`Unknown assignment: ${assignment}`);
      }
      properties[name] = assignment.slice(equal + 1);
    }
    const slice = properties.Slice || args.find((arg) => arg.startsWith('--slice='))?.slice('--slice='.length);
    if (slice !== 'test-fence.slice') throw new Error('wrong scope slice');
    apply(properties);
    let command = args.slice(separator + 1);
    if (version >= 254 && !literal) {
      command = command.map((arg) => arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || ''));
    }
    process.execve(command[0], [command[0], '--require', __filename, ...command.slice(1)], process.env);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
