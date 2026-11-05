<#
  Is there a visible top-level window with this title on screen?

  This exists for one assertion in the restart self-test: a console program
  created by WMI without startup information is handed a fresh, VISIBLE console
  window, and the user gets to watch a black box while the application closes.
  The helper titles its own console, so looking for that title is the same check
  the user performs with their eyes.

  Every visible window whose title contains the fragment is printed (title and
  owning process) so a failure names the window instead of just its existence.

  Exit codes: 0 = found, 1 = not found, 2 = this scanner itself failed.
#>

param(
  [Parameter(Mandatory = $true)][string]$TitleFragment,
  [int]$Seconds = 3
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class VisibleWindowScan {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Find(string fragment) {
    var hits = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var title = sb.ToString();
      if (title.IndexOf(fragment, StringComparison.Ordinal) < 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      hits.Add(pid + ":" + title);
      return true;
    }, IntPtr.Zero);
    return hits;
  }
}
'@

$deadline = (Get-Date).AddSeconds($Seconds)
do {
  $hits = [VisibleWindowScan]::Find($TitleFragment)
  if ($hits.Count -gt 0) {
    foreach ($hit in $hits) {
      $processId = [int]($hit.Split(':')[0])
      $title = $hit.Substring($hit.IndexOf(':') + 1)
      $name = 'gone'
      try { $name = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }
      Write-Output ("visible window: {0} ({1})" -f $title, $name)
    }
    exit 0
  }
  Start-Sleep -Milliseconds 40
} while ((Get-Date) -lt $deadline)

Write-Output "no visible window titled '$TitleFragment'"
exit 1
