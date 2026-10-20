'use strict';

// Temporary T465 probe, removed before submit: why the Windows nested fork storm misses its cap.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../lib/containment');
const G = require('../../lib/gates/common');

const HARNESS = path.join(__dirname, 'containment-harness.js');
const MiB = 1024 * 1024;
const [out, mode, memory] = process.argv.slice(2);

if (mode === 'nested') {
  // The harness's nested-storm, with the inner attempt's memory cap from argv.
  const child = C.spawn(process.execPath, [HARNESS, 'storm', 'unused'], {
    stdio: 'inherit', resources: { tasks_max: 128, memory_max_bytes: Number(memory) },
  });
  child.on('error', () => process.exitCode = 1);
  child.on('exit', (code) => {
    if (child.resourceReason) process.stderr.write(`inner attempt: ${child.resourceReason}\n`);
    process.exitCode = code;
  });
} else {
  const log = (line) => { fs.appendFileSync(out, line + '\n'); console.log(line); };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); // wait-allow: probe lets the twelve leaves start
  const snapshot = () => {
    const started = Date.now();
    const text = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'],
    { encoding: 'utf8', timeout: 60000, windowsHide: true }); // wait-allow: one CIM snapshot
    return { ms: Date.now() - started, rows: text.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)) };
  };
  const main = async () => {
    for (let i = 0; i < 3; i++) {
      const storm = cp.spawn(process.execPath, [HARNESS, 'storm', 'unused'], { stdio: 'ignore' });
      await pause(3000); // wait-allow: probe lets the twelve leaves start
      const { ms, rows } = snapshot();
      cp.spawnSync('taskkill', ['/pid', String(storm.pid), '/T', '/F'], { windowsHide: true });
      const tree = new Set([storm.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of rows) if (tree.has(parent) && !tree.has(pid)) { tree.add(pid); changed = true; }
      }
      const members = rows.filter(([pid]) => tree.has(pid));
      const sum = members.reduce((total, row) => total + row[2], 0);
      log(`working set ${i}: ${members.length} processes, ${sum} bytes (${Math.round(sum / MiB)} MiB), CIM snapshot ${ms} ms;`
        + ` per process MiB: ${members.map((row) => Math.round(row[2] / MiB)).join(' ')}`);
    }
    // As in the test: a sibling attempt's watchdog samples alongside.
    const sibling = C.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1800000)'], { // wait-allow: probe sibling, stopped at the end
      resources: { tasks_max: 64, memory_max_bytes: 512 * MiB }, stdio: 'ignore',
    });
    for (const [label, bytes] of [['inner 512 MiB', 512 * MiB], ['inner 4 GiB', 4096 * MiB]]) {
      let missed = 0;
      for (let round = 0; round < 20; round++) {
        const started = Date.now();
        const result = await G.exec({ exec: G.treeExec, project: { resources: { tasks_max: 4, memory_max_bytes: 512 * MiB } } },
          process.execPath, [__filename, out, 'nested', String(bytes)], {
            resources: { tasks_max: 4, memory_max_bytes: 512 * MiB }, timeout: 10000, // wait-allow: as the test's gate deadline
          });
        if (result.resource_reason !== 'resource-tasks-max') missed++;
        log(`${label} round ${round}: ${result.resource_reason} exit ${result.status} after ${Date.now() - started} ms`
          + ` ${result.error?.code || ''} ${result.stderr.trim()}`);
      }
      log(`${label}: ${missed} of 20 missed the outer cap`);
    }
    sibling.kill('SIGKILL');
  };
  main().catch((error) => { log(`probe error: ${error.stack}`); process.exitCode = 1; });
}
