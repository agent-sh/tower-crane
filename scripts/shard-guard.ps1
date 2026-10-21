# The Windows CI shard's outer watchdog: `pwsh -File scripts/shard-guard.ps1 npm test`.
#
# test/shard-watchdog.js runs inside the tree it watches, so a frozen node process or VM
# stops it too, and a job its limit cancels keeps no log. This process is the test step's
# own parent instead. It starts the command in a Windows job object, which caps the
# processes and committed memory the tests can take and holds every process they start,
# orphans included. Once a minute it posts the shard's progress to a check run, so the
# last state reaches GitHub while the run is still going. At its deadline it dumps the
# job's processes with handle and memory counts, stops them with taskkill /T /F and the
# job, and exits 1, so the step ends normally and the artifact upload after it runs.
#
# Environment:
#   TC_SHARD_GUARD_DEADLINE_MIN    minutes before the guard stops the tests (default 38)
#   TC_SHARD_GUARD_MAX_PROCESSES   job active process limit, 0 for none
#   TC_SHARD_GUARD_MAX_MEMORY_MB   job committed memory limit, 0 for none
#   TC_TEST_SHARD_LOG_DIR          where guard.log goes, beside test/run.js's progress.log
#   TC_SHARD_PROGRESS_CHECK        check run name; with the token, sha and GITHUB_REPOSITORY it posts progress
#   TC_SHARD_PROGRESS_SHA          the commit the check run belongs to
#   TC_SHARD_PROGRESS_TOKEN        a token that can write check runs; the tests never see it

param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Command)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ShardJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MemoryStatus {
    public uint Length, MemoryLoad;
    public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ExtendedLimit info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

  // Closing the guard's handle, however the guard ends, stops whatever the job still holds.
  public static IntPtr Create(uint maxProcesses, ulong maxMemoryBytes) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var info = new ExtendedLimit();
    info.Basic.LimitFlags = 0x2000;
    if (maxProcesses > 0) { info.Basic.LimitFlags |= 0x8; info.Basic.ActiveProcessLimit = maxProcesses; }
    if (maxMemoryBytes > 0) { info.Basic.LimitFlags |= 0x200; info.JobMemoryLimit = new UIntPtr(maxMemoryBytes); }
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Win32Exception();
    return job;
  }
  public static void Assign(IntPtr job, IntPtr process) { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); }
  public static bool Terminate(IntPtr job) { return TerminateJobObject(job, 1); }
  // Active processes, processes started, peak committed bytes of the job and of its largest process.
  public static ulong[] Usage(IntPtr job) {
    Accounting a; ExtendedLimit e;
    QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
    QueryInformationJobObject(job, 9, out e, Marshal.SizeOf(typeof(ExtendedLimit)), IntPtr.Zero);
    return new ulong[] { a.ActiveProcesses, a.TotalProcesses, e.PeakJobMemoryUsed.ToUInt64(), e.PeakProcessMemoryUsed.ToUInt64() };
  }
  public static long[] Pids(IntPtr job) {
    int capacity = 8192, size = 8 + capacity * IntPtr.Size;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      Marshal.WriteInt64(buffer, 0);
      // A full buffer fails with ERROR_MORE_DATA but still lists the ids that fit.
      QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero);
      int count = Math.Min(Marshal.ReadInt32(buffer, 4), capacity);
      var pids = new long[count];
      for (int i = 0; i < count; i++) pids[i] = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static MemoryStatus Memory() {
    var status = new MemoryStatus(); status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
    GlobalMemoryStatusEx(ref status);
    return status;
  }
}
'@

$started = [DateTime]::UtcNow
$deadlineMin = [double]($env:TC_SHARD_GUARD_DEADLINE_MIN ? $env:TC_SHARD_GUARD_DEADLINE_MIN : 38)
$maxProcesses = [uint32]($env:TC_SHARD_GUARD_MAX_PROCESSES ? $env:TC_SHARD_GUARD_MAX_PROCESSES : 0)
$maxMemoryMb = [uint64]($env:TC_SHARD_GUARD_MAX_MEMORY_MB ? $env:TC_SHARD_GUARD_MAX_MEMORY_MB : 0)
$logDir = $env:TC_TEST_SHARD_LOG_DIR
$logFile = $null
if ($logDir) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir 'guard.log'
}
$mib = { param($bytes) [math]::Round([double]$bytes / 1MB) }

function Write-Log([string]$line) {
  $text = "$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) guard: $line"
  if ($logFile) { try { [IO.File]::AppendAllText($logFile, "$text`n") } catch { } }
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

function Format-Machine {
  $m = [ShardJob]::Memory()
  $procs = @(Get-Process -ErrorAction SilentlyContinue)
  $handles = [long]($procs | Measure-Object HandleCount -Sum).Sum
  $disks = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { "$($_.Name.TrimEnd('\')) $(& $mib $_.AvailableFreeSpace) MiB free" }) -join ', '
  "free memory $(& $mib $m.AvailPhys) MiB of $(& $mib $m.TotalPhys), free commit $(& $mib $m.AvailPageFile) MiB of $(& $mib $m.TotalPageFile); system $($procs.Count) processes, $handles handles; disks $disks"
}

# progress.log is test/run.js's file reporter output; node keeps it open for appending.
function Read-Files {
  $text = ''
  $path = $logDir ? (Join-Path $logDir 'progress.log') : $null
  if ($path -and (Test-Path -LiteralPath $path)) {
    try {
      $stream = [IO.FileStream]::new($path, 'Open', 'Read', 'ReadWrite, Delete')
      try { $text = [IO.StreamReader]::new($stream).ReadToEnd() } finally { $stream.Dispose() }
    } catch { }
  }
  # Node names files by absolute path, its drive letter not always in the case Get-Location has.
  $root = '^' + [regex]::Escape((Get-Location).Path.TrimEnd('\') + '\')
  $order = [Collections.Generic.List[string]]::new()
  $ended = [Collections.Generic.HashSet[string]]::new()
  foreach ($line in $text -split "`r?`n") {
    if ($line -match '^file (started|ended): (.+)$') {
      $kind = $Matches[1]
      $file = ($Matches[2] -replace $root, '').Replace('\', '/')
      if ($kind -eq 'started') { if (-not $order.Contains($file)) { $order.Add($file) } } else { [void]$ended.Add($file) }
    }
  }
  [pscustomobject]@{
    Started = $order.Count
    Ended = $ended.Count
    Running = @($order | Where-Object { -not $ended.Contains($_) })
    Tail = (($text -split "`r?`n") | Where-Object { $_ } | Select-Object -Last 30) -join "`n"
  }
}

# Get-Process refuses an empty id list, and a job is empty once its processes end.
function Get-JobProcesses {
  $pids = [ShardJob]::Pids($job)
  if ($pids.Count) { Get-Process -Id $pids -ErrorAction SilentlyContinue }
}

# Sampled: active processes each second, handles each minute. The job itself records the memory peaks.
$peakActive = 0
$peakHandles = 0
function Format-Job {
  $usage = [ShardJob]::Usage($job)
  $procs = @(Get-JobProcesses)
  $handles = [long]($procs | Measure-Object HandleCount -Sum).Sum
  $private = [long]($procs | Measure-Object PrivateMemorySize64 -Sum).Sum
  if ($handles -gt $script:peakHandles) { $script:peakHandles = $handles }
  "job $($usage[0]) processes, $handles handles, $(& $mib $private) MiB committed; peaks $script:peakActive processes, $script:peakHandles handles, $(& $mib $usage[2]) MiB committed (largest process $(& $mib $usage[3]) MiB); $($usage[1]) processes started"
}

$token = $env:TC_SHARD_PROGRESS_TOKEN
$posting = [bool]($token -and $env:TC_SHARD_PROGRESS_CHECK -and $env:TC_SHARD_PROGRESS_SHA -and $env:GITHUB_REPOSITORY)
$checkUrl = $null
$api = $env:GITHUB_API_URL ? $env:GITHUB_API_URL : 'https://api.github.com'
$runUrl = $env:GITHUB_RUN_ID ? "$($env:GITHUB_SERVER_URL)/$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)" : ''
$cut = { param($text, $max) $text.Length -gt $max ? $text.Substring(0, $max - 3) + '...' : $text }
# A test file's node process puts the file last, after a long list of flags.
$ends = { param($text, $max) $text.Length -gt $max ? $text.Substring(0, 100) + ' ... ' + $text.Substring($text.Length - ($max - 105)) : $text }

# The check run is completed and neutral from the start: a runner that freezes before the
# last update cannot leave a pending check behind, and the test job keeps the verdict.
function Send-Progress([string]$title, [string]$summary) {
  if (-not $script:posting) { return }
  $headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
  $output = @{ title = (& $cut $title 200); summary = (& $cut $summary 60000) }
  try {
    if (-not $script:checkUrl) {
      $body = @{ name = $env:TC_SHARD_PROGRESS_CHECK; head_sha = $env:TC_SHARD_PROGRESS_SHA; status = 'completed'; conclusion = 'neutral'; output = $output }
      $made = Invoke-RestMethod -Method Post -Uri "$api/repos/$($env:GITHUB_REPOSITORY)/check-runs" -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 4) -TimeoutSec 20
      $script:checkUrl = $made.url
      Write-Log "progress check run: $($made.html_url)"
    } else {
      Invoke-RestMethod -Method Patch -Uri $script:checkUrl -Headers $headers -ContentType 'application/json' -Body (@{ output = $output } | ConvertTo-Json -Depth 4) -TimeoutSec 20 | Out-Null
    }
  } catch {
    Write-Log "progress post failed: $($_.Exception.Message)"
    # A fork PR's token cannot write checks; the log file and job log still have the progress.
    if (-not $script:checkUrl -and [int]$_.Exception.Response.StatusCode -in 401, 403, 404) {
      $script:posting = $false
      Write-Log 'progress posting off: the token cannot create check runs'
    }
  }
}

function Write-Report([string]$state) {
  $files = Read-Files
  $minutes = [math]::Round(([DateTime]::UtcNow - $started).TotalMinutes, 1)
  $running = $files.Running.Count ? ($files.Running -join ', ') : 'none'
  $title = "$state at $minutes min: $($files.Ended)/$($files.Started) files ended; running: $running"
  $jobLine = Format-Job
  $machine = Format-Machine
  Write-Log "$title; $jobLine; $machine"
  $fence = '```'
  Send-Progress $title (@(
    "Shard $($env:TC_TEST_SHARD), updated $([DateTime]::UtcNow.ToString('u')), $minutes of $deadlineMin min. $runUrl",
    '', "- Files: $($files.Ended) ended of $($files.Started) started", "- Running: $running", "- $jobLine", "- Machine: $machine",
    '', 'Last progress lines:', $fence, $files.Tail, $fence
  ) -join "`n")
}

# Bounded, so a sick machine cannot hold the guard past the step limit.
function Invoke-Bounded([string]$file, [string[]]$arguments, [int]$seconds) {
  $psi = [Diagnostics.ProcessStartInfo]::new($file)
  foreach ($a in $arguments) { $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($seconds * 1000)) { try { $p.Kill() } catch { }; return "$file did not finish in $seconds s" }
  "$($out.Result)$($err.Result)"
}

function Write-Dump {
  $pids = [ShardJob]::Pids($job)
  Write-Log "job processes (pid, name, handles, threads, committed, working set, started):"
  foreach ($p in @(Get-JobProcesses)) {
    # A process that ends meanwhile cannot report its start time.
    try { $since = $p.StartTime.ToUniversalTime().ToString('HH:mm:ss') } catch { $since = '?' }
    Write-Log ("  {0} {1} handles {2} threads {3} committed {4} MiB ws {5} MiB started {6}" -f $p.Id, $p.ProcessName, $p.HandleCount, $p.Threads.Count, (& $mib $p.PrivateMemorySize64), (& $mib $p.WorkingSet64), $since)
  }
  # Command lines name each test file's process; CIM is the slow part, so it comes second and is bounded.
  $cim = Start-ThreadJob { Get-CimInstance Win32_Process -OperationTimeoutSec 30 | Select-Object ProcessId, ParentProcessId, CommandLine }
  if (Wait-Job $cim -Timeout 40) {
    $set = [Collections.Generic.HashSet[long]]::new([long[]]$pids)
    Write-Log 'job process command lines (pid, parent, command):'
    foreach ($row in @(Receive-Job $cim | Where-Object { $set.Contains([long]$_.ProcessId) })) {
      Write-Log "  $($row.ProcessId) $($row.ParentProcessId) $(& $ends "$($row.CommandLine)" 500)"
    }
  } else { Write-Log 'process command lines: CIM did not answer in 40 s' }
  # A storm outside the job, such as a system service, shows here.
  $all = @(Get-Process -ErrorAction SilentlyContinue)
  Write-Log 'system processes with the most handles:'
  foreach ($p in @($all | Sort-Object HandleCount -Descending | Select-Object -First 10)) { Write-Log "  $($p.Id) $($p.ProcessName) handles $($p.HandleCount) committed $(& $mib $p.PrivateMemorySize64) MiB" }
  Write-Log 'system processes with the most committed memory:'
  foreach ($p in @($all | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 10)) { Write-Log "  $($p.Id) $($p.ProcessName) committed $(& $mib $p.PrivateMemorySize64) MiB handles $($p.HandleCount)" }
}

$job = [ShardJob]::Create($maxProcesses, $maxMemoryMb * 1MB)
# cmd waits for one line on stdin before it runs the command, so the job holds the
# command's first process before it can start any other.
$psi = [Diagnostics.ProcessStartInfo]::new($env:ComSpec)
$psi.Arguments = "/d /s /c `"set /p TC_SHARD_GO= & $($Command -join ' ')`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
foreach ($name in @($psi.Environment.Keys | Where-Object { $_ -like 'TC_SHARD_*' })) { [void]$psi.Environment.Remove($name) }
$child = [Diagnostics.Process]::Start($psi)
[ShardJob]::Assign($job, $child.Handle)
$child.StandardInput.WriteLine('go')
$child.StandardInput.Close()
$limits = "limits $($maxProcesses ? $maxProcesses : 'no') processes, $($maxMemoryMb ? "$maxMemoryMb MiB" : 'no memory limit')"
Write-Log "guard $PID for $($Command -join ' ') (pid $($child.Id)): deadline $deadlineMin min; $limits; $(Format-Machine)"

$deadline = $started.AddMinutes($deadlineMin)
$nextBeat = [DateTime]::UtcNow
$atLimit = $false
$stopped = $false
while (-not $child.WaitForExit(1000)) {
  $active = [int]([ShardJob]::Usage($job)[0])
  if ($active -gt $peakActive) { $peakActive = $active }
  if ($maxProcesses -and $active -ge $maxProcesses -and -not $atLimit) { Write-Log "job reached its limit of $maxProcesses processes; new processes fail to start" }
  $atLimit = $maxProcesses -and $active -ge $maxProcesses
  if ([DateTime]::UtcNow -ge $deadline) { $stopped = $true; break }
  if ([DateTime]::UtcNow -ge $nextBeat) {
    try { Write-Report 'running' } catch { Write-Log "progress report failed: $($_.Exception.Message)" }
    $nextBeat = [DateTime]::UtcNow.AddSeconds(60)
  }
}

if ($stopped) {
  Write-Log "deadline of $deadlineMin min reached; $(Format-Machine)"
  $files = Read-Files
  Write-Log "files still running: $($files.Running.Count ? ($files.Running -join ' ') : 'none')"
  try { Write-Dump } catch { Write-Log "process dump failed: $($_.Exception.Message)" }
  Write-Log "job: $(Format-Job)"
  try { $out = Invoke-Bounded 'taskkill.exe' @('/T', '/F', '/PID', "$($child.Id)") 30 } catch { $out = "taskkill failed: $($_.Exception.Message)" }
  foreach ($line in @($out -split "`r?`n" | Where-Object { $_.Trim() })) { Write-Log "  taskkill: $line" }
  # The job also holds what taskkill /T cannot reach: processes whose parent is gone.
  if (-not [ShardJob]::Terminate($job)) { Write-Log 'TerminateJobObject failed' }
  [void]$child.WaitForExit(10000)
  $left = @(Get-JobProcesses)
  Write-Log ($left.Count ? "still running after the stop: $(($left | ForEach-Object { "$($_.Id) $($_.ProcessName)" }) -join ', ')" : 'every job process stopped')
  try { Write-Report 'stopped at the deadline' } catch { Write-Log "progress report failed: $($_.Exception.Message)" }
  Write-Log 'stopped the shard'
  [Environment]::Exit(1)
}

$code = $child.ExitCode
$left = @(Get-JobProcesses)
if ($left.Count) { Write-Log "left running after the command, now stopped: $(($left | ForEach-Object { "$($_.Id) $($_.ProcessName)" }) -join ', ')" }
try { Write-Report "exited $code" } catch { Write-Log "progress report failed: $($_.Exception.Message)" }
[void][ShardJob]::Terminate($job)
[Environment]::Exit($code)
