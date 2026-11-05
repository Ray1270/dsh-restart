<#
  dsh-restart — the detached process that actually restarts DeepSeek Harness.

  Why this file exists
  --------------------
  A plugin runs inside the Host child process. The Host cannot reasonably kill its
  own parent (the Electron shell) and then start a new one: whatever process does
  the killing dies with the application's process tree. So the Host starts THIS
  script through the Windows WMI service, hands it two PIDs, and gets out of the
  way.

  Why it is started by WMI and not by the Host
  -------------------------------------------
  A process the Host spawns itself is a descendant of the application, and the
  application's tree goes away with it. Measured: such a helper wrote `boot`,
  wrote `killing`, started the taskkill — and was terminated together with the
  shell before it could start the replacement. The app closed and never came
  back. `Win32_Process.Create` via WMI is performed by WmiPrvSE.exe, which is
  outside the tree, so the helper outlives the kill and can do the relaunch.
  (Its parent is WmiPrvSE.exe; helper.log records that.)

  Why the console window must not exist
  -------------------------------------
  WMI creates a process with no startup information, and a console program so
  created is handed a fresh, visible console window. The helper is powershell.exe,
  so that window was on screen for every restart. It cannot be hidden from inside:
  `-WindowStyle Hidden` applies after the console exists and did not prevent it
  (measured). The window is avoided at creation instead, by passing
  `Win32_ProcessStartup.ShowWindow = 0` to Win32_Process.Create, which the Host's
  launcher script does. The console title below exists so the self-test can look
  for that window on screen: a title nobody can see means the start was hidden.

  What it does, in order
  ----------------------
    1. write `boot` to restart-state.json   (the Host waits for this before replying 200)
    2. sleep DelayMs                        (lets the HTTP reply flush)
    3. abort if the Host wrote a cancel marker (it gave up on this launch)
    4. re-verify ShellPid still is ShellPath (defends against PID reuse)
    5. taskkill /F the shell ONLY           (no /T: the Host must exit on its own)
    6. wait for BOTH pids to disappear      (the Host disposes in <=5s)
    7. force-kill the Host only if it overstays HostGraceMs
    8. relaunch the executable              (retry once)
    9. record the outcome

  Why no /T on the kill
  ---------------------
  The Electron shell spawns the Host with an IPC channel. Terminating the shell
  alone closes that channel, and the Host's own `process.once('disconnect')`
  handler runs `application.shutdown.shutdown(0)` — a bounded, graceful dispose.
  `taskkill /T` would kill the Host too, which is exactly the graceful shutdown we
  want to keep.

  Why ELECTRON_RUN_AS_NODE must be removed
  ----------------------------------------
  Whenever this helper still inherits an environment that carries
  `ELECTRON_RUN_AS_NODE=1` (that is how the Host itself runs under the Electron
  binary), starting the executable with that flag set would launch a headless
  Node, not the application. Start-Process inherits the helper's environment, so
  the flag is stripped first. The WMI-started path does not normally carry it,
  but the removal costs nothing and the failure it prevents is baffling.

  Logs go to <StateDir>/helper.log and the machine-readable state to
  <StateDir>/restart-state.json. Nothing here is encoded or obfuscated on purpose:
  an antivirus flagging "hidden script kills an app and restarts it" should be
  able to read exactly what it does.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$ShellPid,
  [Parameter(Mandatory = $true)][int]$HostPid,
  [Parameter(Mandatory = $true)][string]$ShellPath,
  [Parameter(Mandatory = $true)][string]$StateDir,
  # Delay before killing, so the HTTP 200 reaches the browser first.
  [int]$DelayMs = 1200,
  # How long the Host may take to dispose before it is force-killed.
  [int]$HostGraceMs = 8000,
  # Hard ceiling on waiting for both processes to disappear.
  [int]$KillTimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'

$statePath = Join-Path $StateDir 'restart-state.json'
$logPath = Join-Path $StateDir 'helper.log'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log {
  param([string]$Message)
  try {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch { }
}

function Write-State {
  param(
    [string]$Phase,
    [string]$Error = $null,
    [int]$NewShellPid = 0
  )
  try {
    $payload = [ordered]@{
      phase        = $Phase
      helperPid    = $PID
      shellPid     = $ShellPid
      hostPid      = $HostPid
      shellPath    = $ShellPath
      newShellPid  = $NewShellPid
      error        = $Error
      at           = (Get-Date).ToString('o')
    }
    $json = $payload | ConvertTo-Json -Compress
    # Written without a BOM: the Host parses this file with JSON.parse, and
    # PowerShell 5.1's `Set-Content -Encoding UTF8` prepends one.
    [System.IO.File]::WriteAllText($statePath, $json, $script:Utf8NoBom)
  } catch { }
}

# Image path of a live process, or $null when it is gone / not readable.
function Get-ProcessPath {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return $process.Path
  } catch {
    return $null
  }
}

function Test-Alive {
  param([int]$ProcessId)
  return $null -ne (Get-ProcessPath -ProcessId $ProcessId)
}

function Test-SameExecutable {
  param([int]$ProcessId, [string]$ExpectedPath)
  $actual = Get-ProcessPath -ProcessId $ProcessId
  if ($null -eq $actual) { return $false }
  try {
    return ([System.IO.Path]::GetFullPath($actual) -eq [System.IO.Path]::GetFullPath($ExpectedPath))
  } catch {
    return $false
  }
}

function Stop-ProcessForcibly {
  param([int]$ProcessId)
  try {
    $taskkill = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', "$ProcessId", '/F') -NoNewWindow -Wait -PassThru
    Write-Log ("taskkill {0} -> exit {1}" -f $ProcessId, $taskkill.ExitCode)
    return $taskkill.ExitCode -eq 0
  } catch {
    Write-Log ("taskkill {0} threw: {1}" -f $ProcessId, $_.Exception.Message)
    return $false
  }
}

function Wait-ForExit {
  param([int]$ProcessId, [int]$TimeoutMs)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Alive -ProcessId $ProcessId)) { return $true }
    Start-Sleep -Milliseconds 150
  }
  return (-not (Test-Alive -ProcessId $ProcessId))
}

try {
  # The Host creates this directory, but the helper must not depend on that: a
  # missing directory would silently swallow every state write.
  if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  }
  # The state write comes first: the Host is waiting on it before it answers the
  # click. Everything below this point is diagnostics.
  Write-State -Phase 'boot'

  # Identity for the self-test, which asserts that no window with this title is
  # on screen while the helper runs. Harmless when there is no console.
  try { $host.UI.RawUI.WindowTitle = 'dsh-restart helper' } catch { }

  # Who started this process is the fact that decides whether it can survive the
  # kill, so it belongs in the log next to the PIDs. On the WMI path this is
  # WmiPrvSE.exe, not the Host.
  try {
    $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop
    $parent = Get-Process -Id $self.ParentProcessId -ErrorAction SilentlyContinue
    $parentName = if ($null -eq $parent) { 'unknown' } else { $parent.ProcessName }
    Write-Log ("boot pid={0} parent={1}({2}) shellPid={3} hostPid={4} shellPath='{5}'" -f $PID, $self.ParentProcessId, $parentName, $ShellPid, $HostPid, $ShellPath)
  } catch {
    Write-Log ("boot pid={0} shellPid={1} hostPid={2} shellPath='{3}'" -f $PID, $ShellPid, $HostPid, $ShellPath)
  }

  Start-Sleep -Milliseconds $DelayMs

  # The Host writes this when its launch could not be confirmed. Without the
  # check a late helper would tear down an application the UI just told the user
  # was still running.
  if (Test-Path -LiteralPath (Join-Path $StateDir 'cancel-restart')) {
    Write-Log 'aborted: the Host cancelled this restart before the kill'
    Write-State -Phase 'aborted' -Error 'cancelled by the Host before the kill'
    exit 7
  }

  # PID reuse guard: if the shell already restarted, this PID belongs to someone
  # else and killing it would be a disaster. Abort instead.
  if (-not (Test-SameExecutable -ProcessId $ShellPid -ExpectedPath $ShellPath)) {
    Write-Log ("aborted: pid {0} is not '{1}' anymore" -f $ShellPid, $ShellPath)
    Write-State -Phase 'aborted' -Error 'shell pid no longer matches the expected executable'
    exit 2
  }

  Write-State -Phase 'killing'
  $killed = Stop-ProcessForcibly -ProcessId $ShellPid
  if (-not $killed) {
    Write-Log 'shell kill failed; nothing was stopped'
    Write-State -Phase 'failed' -Error 'could not terminate the shell process'
    exit 3
  }

  # The Host exits on its own through the IPC disconnect handler; give it the
  # grace window before forcing anything.
  $hostExited = Wait-ForExit -ProcessId $HostPid -TimeoutMs $HostGraceMs
  if (-not $hostExited) {
    Write-Log ("host pid {0} still alive after {1}ms; forcing" -f $HostPid, $HostGraceMs)
    Stop-ProcessForcibly -ProcessId $HostPid | Out-Null
    Wait-ForExit -ProcessId $HostPid -TimeoutMs 3000 | Out-Null
  } else {
    Write-Log ("host pid {0} exited on its own" -f $HostPid)
  }

  $shellExited = Wait-ForExit -ProcessId $ShellPid -TimeoutMs $KillTimeoutMs
  if (-not $shellExited) {
    Write-Log ("shell pid {0} survived the kill; refusing to relaunch" -f $ShellPid)
    Write-State -Phase 'failed' -Error 'shell process survived the forced termination'
    exit 4
  }

  Write-State -Phase 'killed'

  # Inherited from the Host: starting the app with this set would run a headless
  # Node instead of the application.
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) { Remove-Item Env:ELECTRON_RUN_AS_NODE }
  if (Test-Path Env:ELECTRON_NO_ATTACH_CONSOLE) { Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE }

  $workingDirectory = Split-Path -Parent $ShellPath
  $newPid = 0
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    if (-not (Test-Path -LiteralPath $ShellPath)) {
      Write-Log ("relaunch aborted: '{0}' does not exist" -f $ShellPath)
      break
    }
    Write-State -Phase 'relaunching'
    try {
      $started = Start-Process -FilePath $ShellPath -WorkingDirectory $workingDirectory -PassThru
      $newPid = $started.Id
      Write-Log ("relaunched attempt={0} newPid={1}" -f $attempt, $newPid)
    } catch {
      Write-Log ("relaunch attempt {0} threw: {1}" -f $attempt, $_.Exception.Message)
    }
    # A second instance against a surviving lock quits itself; give the new
    # process a moment and relaunch once more if it folded immediately.
    Start-Sleep -Milliseconds 2500
    if ($newPid -ne 0 -and (Test-SameExecutable -ProcessId $newPid -ExpectedPath $ShellPath)) {
      Write-Log ("relaunch verified newPid={0}" -f $newPid)
      Write-State -Phase 'relaunched' -NewShellPid $newPid
      exit 0
    }
    Write-Log ("relaunch attempt {0} did not survive; retrying" -f $attempt)
  }

  Write-Log 'relaunch failed'
  Write-State -Phase 'failed' -Error 'the application did not come back up'
  exit 5
} catch {
  Write-Log ("unhandled: {0}" -f $_.Exception.Message)
  Write-State -Phase 'failed' -Error $_.Exception.Message
  exit 1
}
