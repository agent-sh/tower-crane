'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');

// Exercise the real PowerShell walk with a fixed process snapshot. Transient
// shells precede the persistent caller, so per-parent CIM queries are visible.
const exec = cp.execFileSync;
cp.execFileSync = function ancestrySnapshot(command, args, options) {
  if (command !== 'powershell.exe') return exec.call(this, command, args, options);
  const prefix = `
$taskGate = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $env:ANCESTRY_GATE)
function Get-CimInstance {
  param($ClassName, $Property, $Filter)
  [IO.File]::AppendAllText($env:ANCESTRY_CALLS, "query\\n")
  $rows = @(ConvertFrom-Json ([IO.File]::ReadAllText($env:ANCESTRY_ROWS)))
  foreach ($row in $rows) { $row.CreationDate = [datetime]$row.CreationDate }
  [IO.File]::WriteAllText($env:ANCESTRY_READY, '')
  $null = $taskGate.WaitOne()
  if ($Filter) {
    $pidValue = [int]($Filter -replace '^ProcessId=', '')
    return @($rows | Where-Object { $_.ProcessId -eq $pidValue })
  }
  return $rows
}
`;
  const at = args.indexOf('-Command') + 1;
  const replaced = [...args];
  replaced[at] = prefix + args[at] + '\n$taskGate.Dispose()';
  fs.writeFileSync(process.env.ANCESTRY_OPTIONS, JSON.stringify({ timeout: options.timeout }));
  return exec.call(this, command, replaced, options);
};
