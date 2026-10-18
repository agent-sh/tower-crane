'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const C = require('../../lib/containment');
const group = process.env.TC_FAKE_CGROUP;
const log = process.env.TC_FAKE_SYSTEMD_LOG;
const types = { PIDs: 'au', Slice: 's', TasksMax: 't', MemoryMax: 't', MemorySwapMax: 't',
  OOMPolicy: 's', Delegate: 'b' };

function apply(properties) {
  if (properties.OOMPolicy !== 'kill') throw new Error('OOMPolicy must be kill');
  fs.writeFileSync(path.join(group, 'memory.oom.group'), '1');
  fs.appendFileSync(log, JSON.stringify(properties) + '\n');
}

if (require.main !== module) {
  // The bootstrap exercises real runner code against a private disk hierarchy.
  C.currentGroup = () => group;
  C.counters = () => ({ tasks: 0, memory: 0 });
  const spawnSync = cp.spawnSync;
  cp.spawnSync = (file, args, opts) => {
    if (file !== 'busctl') return spawnSync(file, args, opts);
    try {
      let at = args.indexOf('ssa(sv)a(sa(sv))');
      if (at < 0) throw new Error('invalid StartTransientUnit signature');
      at += 3;
      const count = Number(args[at++]);
      const properties = {};
      for (let n = 0; n < count; n++) {
        const name = args[at++];
        const type = args[at++];
        if (!types[name] || type !== types[name]) throw new Error(`Cannot set property ${name}, or unknown property`);
        if (type === 'au') {
          const length = Number(args[at++]);
          properties[name] = args.slice(at, at + length);
          at += length;
        } else properties[name] = args[at++];
      }
      if (properties.Slice !== 'test-fence.slice' || properties.PIDs?.[0] !== String(process.pid)) {
        throw new Error('wrong slice or scope pid');
      }
      apply(properties);
      return { status: 0, stdout: '', stderr: '' };
    } catch (error) { return { status: 1, stdout: '', stderr: error.message }; }
  };
} else {
  try {
    const args = process.argv.slice(2);
    const separator = args.indexOf('--');
    const properties = {};
    for (let n = 0; n < separator; n++) {
      if (args[n] !== '-p') continue;
      const assignment = args[++n];
      const equal = assignment.indexOf('=');
      const name = assignment.slice(0, equal);
      if (!['CPUQuota', ...Object.keys(types).filter((key) => !['PIDs', 'Slice'].includes(key))].includes(name)) {
        throw new Error(`Unknown assignment: ${assignment}`);
      }
      properties[name] = assignment.slice(equal + 1);
    }
    if (!args.includes('--slice=test-fence.slice')) throw new Error('wrong scope slice');
    apply(properties);
    const command = args.slice(separator + 1);
    const result = cp.spawnSync(command[0], ['--require', __filename, ...command.slice(1)], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
