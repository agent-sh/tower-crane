'use strict';

const cp = require('node:child_process');

// The spawning parent still holds the child's handle while querying its
// creation time, so the PID cannot identify a replacement during this query.
function startTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid process PID');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $process = [System.Diagnostics.Process]::GetProcessById(${pid})
  $null = $process.Handle
  [Console]::Out.WriteLine($process.StartTime.ToFileTimeUtc().ToString())
} catch [System.ArgumentException] {
} catch [System.InvalidOperationException] {
} finally {
  if ($process) { $process.Dispose() }
}
# A caught missing-process error can leave PowerShell's exit status at 1.
exit 0
`;
  // A cold PowerShell query on a busy runner needs the same budget as a test CLI call.
  const value = cp.execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
  if (value && !/^\d+$/.test(value)) throw new Error('invalid Windows process creation time');
  return value || null;
}

module.exports = { startTime };
