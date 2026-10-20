'use strict';

// The shard deadline, in a process of its own: test/run.js starts it detached and
// holds its stdin open. A runner whose own event loop is blocked cannot fire a timer,
// so this process dumps the runner's process tree and stops it instead. When the
// runner exits, its end of the pipe closes and this process exits with it.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { killPid } = require('./signals');

const { root, started, deadlineMin, logDir, shard, files } = JSON.parse(process.argv[2]);
const logFile = logDir ? path.join(logDir, 'watchdog.log') : null;
// The log file is what the CI artifact keeps; stderr reaches the job log when GitHub keeps one.
function log(line, { quiet = false } = {}) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (logFile) try { fs.appendFileSync(logFile, text); } catch { /* stderr still has it */ }
  if (!quiet) try { process.stderr.write(text); } catch { /* the runner's stderr is gone */ }
}
const machine = () => `free memory ${Math.round(os.freemem() / 2 ** 20)} MiB of ${Math.round(os.totalmem() / 2 ** 20)}, load ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`;

// The processes below ROOT, from one snapshot, leaving out this watchdog and what it
// started, and on Windows the ones created since SINCE whose parent is gone: Windows
// does not reparent, so a child of an exited test process can no longer be reached from ROOT.
function processTree(since) {
  const win = process.platform === 'win32';
  const out = win
    ? cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '
      + '"$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) $($_.CommandLine)" }'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20, windowsHide: true }) // wait-allow: one snapshot, inside the minutes the deadline leaves before the step limit
    : cp.spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 }); // wait-allow: one snapshot, inside the minutes the deadline leaves before the step limit
  if (out.error) log(`process snapshot failed: ${out.error.message}`);
  const rows = (out.stdout || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((f) => f.length > 2)
    .map(([pid, parent, time, ...rest]) => ({ pid: Number(pid), parent: Number(parent), time, text: [time, ...rest].join(' ') }));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (row.pid !== process.pid && !tree.has(row.pid) && tree.has(row.parent)) { tree.add(row.pid); grew = true; }
    }
  }
  const live = new Set(rows.map((row) => row.pid));
  return {
    snapshot: rows.length > 0,
    tree: rows.filter((row) => tree.has(row.pid)),
    orphans: win ? rows.filter((row) => !tree.has(row.pid) && !live.has(row.parent) && Number(row.time) >= since) : [],
  };
}

function taskkill(args) {
  const out = cp.spawnSync('taskkill', ['/F', ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true }); // wait-allow: one stop call, inside the minutes the deadline leaves before the step limit
  for (const line of `${out.stdout || ''}${out.stderr || ''}${out.error ? out.error.message : ''}`.split(/\r?\n/)) {
    if (line.trim()) log(`  taskkill: ${line.trim()}`);
  }
}

function stop() {
  log(`shard deadline of ${deadlineMin} min reached; ${machine()}`);
  const { snapshot, tree, orphans } = processTree(started);
  log(`processes still running (pid, parent, ${process.platform === 'win32' ? 'created at ms' : 'elapsed'}, command):`);
  for (const row of tree) log(`  ${row.pid} ${row.parent} ${row.text}`);
  if (orphans.length) log('started during the run, parent gone:');
  for (const row of orphans) log(`  ${row.pid} ${row.parent} ${row.text}`);
  const rest = [...tree, ...orphans].filter((row) => row.pid !== root);
  if (process.platform === 'win32') {
    // taskkill /T on the runner would also stop this watchdog, its child.
    if (rest.length) taskkill(['/T', ...rest.flatMap((row) => ['/PID', String(row.pid)])]);
    taskkill([...(snapshot ? [] : ['/T']), '/PID', String(root)]);
  } else {
    for (const row of [...rest, { pid: root }]) try { killPid(row.pid, 'SIGKILL'); } catch { /* It ended meanwhile. */ }
  }
  log('stopped the shard');
  process.exit(1);
}

log(`watchdog ${process.pid} for runner ${root}${shard ? `, shard ${shard}` : ''}: deadline ${deadlineMin} min from ${new Date(started).toISOString()}; ${machine()}`);
if (files?.length) log(`files: ${files.join(' ')}`);
const deadline = setTimeout(stop, Math.max(0, started + deadlineMin * 60000 - Date.now())); // wait-allow: the shard deadline CI sets under its step limit
// A minute-by-minute record shows a machine running out of memory or time before the deadline.
const beat = logFile && setInterval(() => log(`alive; ${machine()}`, { quiet: true }), 60000); // wait-allow: a progress line while the shard runs
process.stdin.on('error', () => {});
process.stdin.on('close', () => { clearTimeout(deadline); clearInterval(beat); });
process.stdin.resume();
