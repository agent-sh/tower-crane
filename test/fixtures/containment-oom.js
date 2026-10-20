'use strict';

const fs = require('node:fs');
const path = require('node:path');
const C = require('../../lib/containment');
const G = require('../../lib/gates/common');
const MiB = 1024 ** 2;
const [mode, pressure = 'attempt'] = process.argv.slice(2);
process.env.TOWER_CRANE_TEST_CONTAINMENT = '1';

if (mode === 'fleet') {
  const fleet = process.env[C.MARK];
  const events = () => fs.readFileSync(path.join(fleet, 'memory.events.local'), 'utf8');
  const before = events();
  const sibling = C.spawn(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 10000)'], { // wait-allow: finite sibling isolation probe
    resources: { tasks_max: 64, memory_max_bytes: 96 * MiB }, stdio: ['ignore', 'pipe', 'inherit'],
  }); // wait-allow: finite sibling isolation probe
  sibling.stdout.once('data', async () => {
    const result = await G.treeExec(process.execPath, [path.join(__dirname, 'containment-harness.js'), 'memory', 'unused'], {
      resources: { tasks_max: 64, memory_max_bytes: (pressure === 'attempt' ? 96 : 384) * MiB },
      timeout: 10000, // wait-allow: bounded kernel OOM probe
    });
    const record = {
      pressure, fleet_oom_group: fs.readFileSync(path.join(fleet, 'memory.oom.group'), 'utf8').trim(),
      before, after: events(), attempt: { status: result.status, signal: result.signal, reason: result.resource_reason },
      parent_survived: true, sibling_survived: sibling.exitCode === null && sibling.signalCode === null,
    };
    sibling.kill('SIGKILL');
    await new Promise(resolve => sibling.once('close', resolve));
    console.log(JSON.stringify(record));
  });
} else {
  (async () => {
    if (!C.canScope()) throw new Error('kernel OOM probe requires a delegated cgroup and user manager');
    const records = [];
    for (const pressure of ['attempt', 'fleet']) {
      const child = C.spawn(process.execPath, [__filename, 'fleet', pressure], {
        fleet: true, preserveManaged: false,
        resources: { tasks_max: 192, memory_max_bytes: (pressure === 'attempt' ? 384 : 192) * MiB },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const output = [];
      child.stdout.on('data', data => output.push(data));
      await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      await child.containmentDone;
      records.push({ ...JSON.parse(Buffer.concat(output).toString()), fleet_reason: child.resourceReason || null, containment: child.containment });
    }
    console.log(JSON.stringify(records, null, 2));
    if (records.some(row => !row.parent_survived || !row.sibling_survived || row.fleet_reason
      || row.attempt.reason !== 'resource-memory-max')) process.exitCode = 1;
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
