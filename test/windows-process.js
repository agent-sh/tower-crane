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
  # A process exiting during the snapshot has a null StartTime.
  $identity = [pscustomobject]@{ Id = $process.Id; StartTime = $process.StartTime }
  if ($null -ne $identity.StartTime) {
    $identity.StartTime = $identity.StartTime.ToFileTimeUtc().ToString()
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $identity -Compress))
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
  const identity = value ? JSON.parse(value) : null;
  if (identity === null || identity.StartTime === null) return null;
  if (identity.Id !== pid || typeof identity.StartTime !== 'string' || !/^\d+$/.test(identity.StartTime)) {
    throw new Error('invalid Windows process creation time');
  }
  return identity.StartTime;
}

module.exports = { startTime };
