'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const C = require('../../lib/containment');
const [mode, file, depth = '0'] = process.argv.slice(2);

function hold() {
  // The fixture always ends on its own, including when containment is broken. A
  // Windows watchdog's CIM snapshot can take seconds, so it lives longer there.
  setTimeout(() => process.exit(0), process.platform === 'win32' ? 15000 : 3000); // wait-allow: finite fake harness lifetime
}

if (mode === 'nested-limit' || mode === 'nested-memory') {
  const memory = mode === 'nested-memory';
  const child = C.spawn(process.execPath, [__filename, memory ? 'memory' : 'storm', file], {
    stdio: 'inherit', resources: { tasks_max: memory ? 64 : C.canScope() ? 32 : 4,
      memory_max_bytes: (memory ? 96 : 512) * 1024 * 1024 },
  });
  child.on('error', () => process.exitCode = 1);
  child.on('exit', () => {
    process.stdout.write(`child: ${child.resourceReason}\nparent-survived\n`);
    setTimeout(() => {}, 300); // wait-allow: allow the parent's resource monitor to observe the child cap event
  });
} else if (mode === 'nested-storm') {
  const child = C.spawn(process.execPath, [__filename, 'storm', file], {
    stdio: 'inherit', resources: { tasks_max: 128, memory_max_bytes: 512 * 1024 * 1024 },
  });
  child.on('error', () => process.exitCode = 1);
  child.on('exit', (code) => process.exitCode = code);
} else if (mode === 'storm') {
  let count = 0;
  const timer = setInterval(() => {
    if (++count > 12) { clearInterval(timer); return; }
    const child = cp.spawn(process.execPath, [__filename, 'leaf', file], { stdio: 'ignore' });
    child.on('error', () => {});
  }, 40); // wait-allow: finite fork storm, at most twelve children
  hold();
} else if (mode === 'memory') {
  const blocks = [];
  const timer = setInterval(() => {
    blocks.push(Buffer.alloc(16 * 1024 * 1024, 1));
    if (blocks.length === 12) clearInterval(timer);
  }, 40); // wait-allow: bounded allocation, at most 192 MiB
  hold();
} else if (mode === 'nested') {
  const n = Number(depth);
  const record = { pid: process.pid, group: process.platform === 'linux' ? C.currentGroup() : null, inherited: process.env[C.MARK] || null };
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  if (n < 2) {
    const spawn = n === 0 ? C.spawn : cp.spawn;
    const child = spawn(process.execPath, [__filename, mode, file, String(n + 1)], {
      stdio: 'inherit', detached: true, resources: { tasks_max: 64, memory_max_bytes: 512 * 1024 * 1024 },
      ...(n === 0 ? { env: { PATH: process.env.PATH, TOWER_CRANE_TEST_CONTAINMENT: '1' } } : {}),
    });
    child.on('error', () => process.exitCode = 1);
    child.on('exit', (code) => process.exitCode = code);
  }
} else hold();
