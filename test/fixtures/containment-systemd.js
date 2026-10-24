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
// The fence's slice, or a project's slice directly below it.
const FENCE = /^test-fence(?:-towercrane_[0-9a-f]{12})?\.slice$/;

function apply(properties) {
  if (properties.OOMPolicy !== 'continue') throw new Error('OOMPolicy must be continue');
  // systemd writes memory.oom.group=0 for OOMPolicy=continue; the runner sets it after.
  writeAtomic(path.join(group, 'memory.oom.group'), '0');
  fs.appendFileSync(log, JSON.stringify(properties) + '\n');
}

if (require.main !== module) {
  // The bootstrap exercises real runner code against a private disk hierarchy.
  C.currentGroup = () => group;
  C.counters = () => ({ tasks: 0, memory: 0 });
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
    if (!FENCE.test(slice)) throw new Error('wrong scope slice');
    apply({ ...properties, Slice: slice });
    let command = args.slice(separator + 1);
    if (version >= 254 && !literal) {
      command = command.map((arg) => arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || ''));
    }
    process.execve(command[0], [command[0], '--require', __filename, ...command.slice(1)], process.env);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
