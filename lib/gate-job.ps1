# A Windows gate command in a job object (lib/gates/common.js treeExec):
#   powershell -File gate-job.ps1 COMMAND_LINE_BASE64 PARENT_PID REPORT
#
# Windows has no process groups, and a process whose parent exited leaves taskkill /T's tree, so a
# detached grandchild of a test outlives its gate. This wrapper starts the command suspended,
# puts it in a job object with kill-on-close before it runs a single instruction, and lets it run.
# Every process it starts joins the job, orphans included. When the command exits, the wrapper
# terminates the job, waits until no process is left in it and writes {"empty": true|false,
# "remaining": N} to REPORT, then exits with the command's code. When the gate kills the wrapper,
# or PARENT_PID (the gate) exits, closing the job's last handle stops whatever it still holds.
param(
  [Parameter(Mandatory)][string]$CommandLine,
  [Parameter(Mandatory)][int]$Parent,
  [Parameter(Mandatory)][string]$Report
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class GateJob {
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref StartupInfo startup, out ProcessInformation info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static IntPtr Job;

  static uint Active() {
    Accounting a;
    if (!QueryInformationJobObject(Job, 1, out a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return a.ActiveProcesses;
  }

  static bool ParentAlive(int parent) {
    try { return !Process.GetProcessById(parent).HasExited; } catch (ArgumentException) { return false; } catch { return true; }
  }

  // Runs the command line in the job; returns its exit code, or -1 when the parent exited first.
  public static int Run(string commandLine, int parent) {
    Job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (Job == IntPtr.Zero) throw new Win32Exception();
    var limit = new ExtendedLimit();
    limit.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(Job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Win32Exception();
    var startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.dwFlags = 0x100; // STARTF_USESTDHANDLES: the command writes to the gate's pipes.
    startup.hStdInput = GetStdHandle(-10);
    startup.hStdOutput = GetStdHandle(-11);
    startup.hStdError = GetStdHandle(-12);
    ProcessInformation info;
    // CREATE_SUSPENDED | CREATE_NO_WINDOW: it joins the job before it can start anything.
    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000,
      IntPtr.Zero, null, ref startup, out info)) throw new Win32Exception();
    try {
      if (!AssignProcessToJobObject(Job, info.hProcess)) {
        TerminateJobObject(Job, 1);
        throw new Win32Exception();
      }
      if (ResumeThread(info.hThread) == 0xFFFFFFFF) throw new Win32Exception();
      while (WaitForSingleObject(info.hProcess, 500) != 0) {
        if (!ParentAlive(parent)) return -1;
      }
      uint code;
      GetExitCodeProcess(info.hProcess, out code);
      return (int)code;
    } finally {
      CloseHandle(info.hThread);
      CloseHandle(info.hProcess);
    }
  }

  // Stops what the command left in the job; returns how many processes are still in it.
  public static uint Stop(int waitMs) {
    TerminateJobObject(Job, 1);
    var clock = Stopwatch.StartNew();
    uint left = Active();
    while (left > 0 && clock.ElapsedMilliseconds < waitMs) {
      System.Threading.Thread.Sleep(20);
      left = Active();
    }
    return left;
  }
}
'@

$line = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandLine))
$code = [GateJob]::Run($line, $Parent)
# The gate's own budget for a command's cleanup (TERM_GRACE_MS in lib/gates/common.js).
$left = [GateJob]::Stop(5000)
$text = '{"empty":' + $(if ($left -eq 0) { 'true' } else { 'false' }) + ',"remaining":' + $left + '}'
[IO.File]::WriteAllText($Report + '.tmp', $text)
Move-Item -LiteralPath ($Report + '.tmp') -Destination $Report -Force
if ($code -lt 0) { $code = 1 }
[Environment]::Exit($code)
