'use strict';

// Windows hands a freed pid out again only after its other free pids, so a
// test that needs a process at an exited process's pid creates suspended
// processes, which cost no start, and ends each one until Windows gives out
// that pid. The process left holding it stays suspended until the caller
// stops it.

const cp = require('node:child_process');

const SOURCE = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class PidReuse {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo { public int cb; public string reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, input, output, error; }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, System.Text.StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Take(int want, int ms, string exe) {
    var clock = Stopwatch.StartNew();
    int tries = 0;
    while (clock.ElapsedMilliseconds < ms) {
      var si = new StartupInfo(); si.cb = Marshal.SizeOf(si);
      ProcessInfo pi;
      if (!CreateProcessW(exe, new System.Text.StringBuilder("\\"" + exe + "\\""), IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, null, ref si, out pi)) return "error " + Marshal.GetLastWin32Error() + " " + tries;
      tries++;
      CloseHandle(pi.thread);
      if (pi.pid == want) { CloseHandle(pi.process); return "taken " + tries; }
      TerminateProcess(pi.process, 0);
      WaitForSingleObject(pi.process, 5000);
      CloseHandle(pi.process);
    }
    return "missed " + tries;
  }
}`;

// { taken, tries, detail }: whether a suspended process now holds pid.
function takePid(pid, { ms = 90000 } = {}) {
  const script = `Add-Type -TypeDefinition @'\n${SOURCE}\n'@\n[Console]::Out.WriteLine([PidReuse]::Take(${Number(pid)}, ${Number(ms)}, "$env:SystemRoot\\System32\\cmd.exe"))`;
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: ms + 120000 }); // wait-allow: the creation loop has its own bound; this bounds PowerShell
  const line = String(r.stdout || '').trim().split(/\r?\n/).at(-1) || '';
  return { taken: line.startsWith('taken '), tries: Number(line.split(' ').at(-1)),
    detail: line || `${r.status} ${r.error?.code || ''} ${String(r.stderr || '').slice(0, 300)}` };
}

module.exports = { takePid };
