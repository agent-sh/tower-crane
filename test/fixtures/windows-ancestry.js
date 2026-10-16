'use strict';

const cp = require('node:child_process');
const { writeAtomic, readPublished, updateJson } = require('../atomic-file');

// A loaded provider can supply a snapshot while individual parent lookups
// time out. Drive the real CLI through that boundary on either platform.
if (process.env.ANCESTRY_PROVIDER_SNAPSHOT === '1') {
  const commands = require('../../lib/commands');
  const exec = commands.execFileSync;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  commands.execFileSync = function providerSnapshot(command, args, options) {
    if (command !== 'powershell.exe') return exec(command, args, options);
    if (/\bGet-CimInstance\b[^\n;]*-Filter\b/.test(args.join('\n'))) {
      throw Object.assign(new Error('parent lookup exceeded the provider budget'), { code: 'ETIMEDOUT' });
    }
    return JSON.stringify([{ ProcessId: process.ppid, ParentProcessId: 1,
      Name: 'node.exe', CommandLine: 'node harness', CreationDate: 'stable-start' }]);
  };
  return;
}

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
  # Wrapping the JSON array's pipeline output nests it on Windows PowerShell.
  $rows = ConvertFrom-Json ([IO.File]::ReadAllText($env:ANCESTRY_ROWS))
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
  // A real snapshot holds the CLI's own process, where the walk starts.
  // Most calls find their row already there and leave the file alone.
  const own = (rows) => rows.some((row) => row.ProcessId === process.pid);
  if (!own(JSON.parse(readPublished(process.env.ANCESTRY_ROWS, 'utf8')))) {
    updateJson(process.env.ANCESTRY_ROWS, (rows) => (own(rows) ? rows : [{ ProcessId: process.pid, ParentProcessId: process.ppid,
      Name: 'node.exe', CommandLine: `node ${process.argv.slice(1).join(' ')}`, CreationDate: rows[0]?.CreationDate }, ...rows]));
  }
  const at = args.indexOf('-Command') + 1;
  const replaced = [...args];
  replaced[at] = prefix + args[at] + '\n$taskGate.Dispose()';
  writeAtomic(process.env.ANCESTRY_OPTIONS, JSON.stringify({ timeout: options.timeout }));
  return exec.call(this, command, replaced, options);
};
