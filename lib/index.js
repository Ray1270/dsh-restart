/**
 * dsh-restart — Host half.
 *
 * The Host runs as a child of the Electron shell, inside the application's own
 * process tree. That tree does not survive the shell: whatever the Host starts
 * dies when the application is terminated, so a helper spawned the ordinary way
 * is killed at the exact moment it is needed — it performs the kill and is
 * buried with the app before it can relaunch it. The helper is therefore
 * created by the Windows WMI service instead ({@link ./helper.ps1} runs as a
 * child of WmiPrvSE, outside the tree), which is what lets it outlive the kill.
 *
 * The division of labour:
 *
 *   Host half      pre-flight (active work), session hand-off, WMI launch + verify
 *   helper.ps1     sleep, kill the shell, wait for the Host, relaunch, report
 *   client half    the header button, the two-click confirmation, session restore
 *
 * Routes (all under the same origin as the GUI):
 *
 *   GET  /api/dsh-restart/status            readiness, PIDs, active work, last run
 *   POST /api/dsh-restart/restart           schedule a restart ({ sessionId, force })
 *   GET  /api/dsh-restart/pending           the session to reopen after a restart
 *   POST /api/dsh-restart/pending/consume   take that session exactly once
 *
 * @module dsh-restart
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-restart'

/** The routes need the Host web server; everything else is a soft dependency. */
export const inject = ['webServer']

const API_BASE = '/api/dsh-restart'

/** Marker left by a restart and consumed by the next page load. */
const PENDING_FILE = 'pending-restore.json'

/** Machine-readable outcome written by the helper. */
const STATE_FILE = 'restart-state.json'

/** Helper log; kept beside the state so a failure is explainable. */
const LOG_FILE = 'helper.log'

/** Outcome of the WMI create call, written by the short-lived launcher. */
const LAUNCH_FILE = 'launch-result.json'

/** Present when the Host gave up on a restart the helper has not killed for yet. */
const CANCEL_FILE = 'cancel-restart'

/**
 * How long the Host waits for the helper's first state write before giving up.
 *
 * Much longer than a direct spawn needs: the process is created by the WMI
 * service, so a provider lookup, the create call and the helper's own startup
 * all happen before `boot` is written.
 */
const HELPER_BOOT_TIMEOUT_MS = 15000

const DEFAULTS = Object.freeze({
  /** Pause before the helper kills the shell, so the HTTP reply flushes first. */
  delayMs: 1200,
  /** Grace for the Host's own bounded graceful shutdown before it is force-killed. */
  hostGraceMs: 8000,
  /** How long a pending session marker stays believable. */
  pendingTtlMinutes: 30,
  /** Master switch; false hides the button and refuses the route. */
  enabled: true,
  /** Hard ceiling on the helper's wait for both processes to disappear. */
  killTimeoutMs: 15000,
})

function readOptions(config) {
  const source = config ?? {}
  const number = (key, min, max) => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? value
      : DEFAULTS[key]
  }
  return {
    delayMs: number('delayMs', 0, 10000),
    hostGraceMs: number('hostGraceMs', 1000, 60000),
    pendingTtlMinutes: number('pendingTtlMinutes', 1, 24 * 60),
    enabled: source.enabled === undefined ? DEFAULTS.enabled : source.enabled === true,
    killTimeoutMs: number('killTimeoutMs', 1000, 120000),
  }
}

/** Directory holding the marker, the state and the log. */
function resolveStateDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'dsh-restart')
}

/**
 * Whether this Host runs under the desktop shell.
 *
 * The shell spawns the Host as the Electron binary in Node mode, so both facts
 * must hold: the binary is Electron, and Node mode is on. A CLI Host reads files
 * from the same Home but has no shell to restart.
 */
function detectDesktop() {
  const electron = process.versions?.electron
  if (typeof electron !== 'string' || electron.length === 0) {
    return { desktop: false, reason: 'not running under the Electron shell (CLI or headless Host)' }
  }
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    return { desktop: false, reason: 'Electron binary is not in Node mode, so this is not a Host process' }
  }
  if (!Number.isInteger(process.ppid) || process.ppid <= 0) {
    return { desktop: false, reason: 'the Host has no parent process to restart' }
  }
  return { desktop: true, reason: null }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * Same-origin guard for the destructive endpoint: browsers always send Origin on
 * a cross-origin POST, so a mismatch is a drive-by request. Non-browser clients
 * that send no Origin are the user's own tooling.
 */
function rejectCrossOrigin(req, res) {
  const origin = req.headers?.origin
  if (!origin) return false
  const host = String(req.headers?.host ?? '')
  let sameOrigin = false
  try {
    sameOrigin = host.length > 0 && new URL(origin).host === host.toLowerCase()
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: 'cross-origin request refused' })
  return true
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(file) {
  try {
    const text = await readFile(file, 'utf8')
    // PowerShell 5.1 helpers may leave a BOM behind; JSON.parse would choke on it.
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
  } catch {
    return null
  }
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * Quote one argument for a Windows command line.
 *
 * The only parser that sees this string is `CommandLineToArgvW` in the helper's
 * process — no shell is involved, because WMI calls CreateProcess directly.
 * Double quotes plus backslash-escaped embedded quotes is therefore the whole
 * contract, and it is enough for the paths this plugin passes.
 */
export function quoteArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

/**
 * The helper invocation the WMI service replays verbatim.
 *
 * Pure on purpose: the quoting is the fragile part of this hand-off, and a
 * wrong backslash here is invisible until the one restart that matters.
 */
export function buildHelperCommandLine({
  powershell,
  helperPath,
  shellPid,
  hostPid,
  shellPath,
  stateDir,
  delayMs,
  hostGraceMs,
  killTimeoutMs,
}) {
  return [
    quoteArgument(powershell),
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', quoteArgument(helperPath),
    '-ShellPid', String(shellPid),
    '-HostPid', String(hostPid),
    '-ShellPath', quoteArgument(shellPath),
    '-StateDir', quoteArgument(stateDir),
    '-DelayMs', String(delayMs),
    '-HostGraceMs', String(hostGraceMs),
    '-KillTimeoutMs', String(killTimeoutMs),
  ].join(' ')
}

/**
 * The PowerShell program that asks WMI to start the helper.
 *
 * Both variable strings arrive base64-encoded so nothing in a path (quotes,
 * spaces, non-ASCII characters) can break the script. The result is written to
 * a JSON file rather than stdout: the launcher is spawned with ignored stdio so
 * it can never hold the Host's pipes open, and a failed create must still be
 * explainable after the fact.
 *
 * The `Win32_ProcessStartup` record is not decoration. A bare
 * `Win32_Process.Create` calls CreateProcess with no startup information, so a
 * console program — the helper is powershell.exe — is given a fresh, visible
 * console window the moment it exists. Measured on this machine: a helper
 * created that way kept a console window on screen for its whole run (a black
 * box appears, the app closes a second later). `-WindowStyle Hidden` does not
 * prevent it; that switch hides a window after the console has already been
 * shown, which is why it was invisible in tests and obvious to the user. Passing
 * SW_HIDE through the startup record is what creates the process hidden in the
 * first place.
 *
 * The result file records whether that record could be built (`windowHidden`),
 * so a machine where it fails leaves a trace instead of a mystery window.
 */
export function buildWmiLauncherScript(commandLine, resultPath) {
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$line = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encode(commandLine)}'))`,
    `$resultPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encode(resultPath)}'))`,
    '$startup = $null',
    'try { $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 } } catch { $startup = $null }',
    'try {',
    '  $arguments = @{ CommandLine = $line }',
    '  if ($null -ne $startup) { $arguments.ProcessStartupInformation = $startup }',
    '  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments',
    '  $payload = [ordered]@{ ok = ($created.ReturnValue -eq 0); pid = [int]$created.ProcessId; returnValue = [int]$created.ReturnValue; windowHidden = ($null -ne $startup); error = $null; commandLine = $line; at = (Get-Date).ToString("o") }',
    '} catch {',
    '  $payload = [ordered]@{ ok = $false; pid = 0; returnValue = -1; windowHidden = ($null -ne $startup); error = $_.Exception.Message; commandLine = $line; at = (Get-Date).ToString("o") }',
    '}',
    '[System.IO.File]::WriteAllText($resultPath, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))',
    'if ($payload.ok) { exit 0 } else { exit 1 }',
  ].join('\n')
}

/**
 * Count work that a restart would interrupt.
 *
 * Mirrors the desktop shell's own admission check: a generating or tool-running
 * agent (including subagents and turns waiting for approval), queued inbox
 * messages, and running or stopping background jobs.
 *
 * Detection is fail-open on purpose. This is a safety net, not a lock: if a
 * service face is missing, refusing to restart would strand the user with a
 * button that never works. The failure is reported so the UI can say the count
 * is incomplete.
 */
export function collectActiveWork(ctx) {
  const counts = { agents: 0, jobs: 0, terminals: 0 }
  let detectionAvailable = true

  let agentList = []
  try {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') throw new Error('agents service is unavailable')
    const rows = agents.list()
    agentList = Array.isArray(rows) ? rows : []
    counts.agents = agentList.filter((agent) => agent && (
      agent.status === 'running'
      || (Array.isArray(agent.inbox?.nextTurn) && agent.inbox.nextTurn.length > 0)
      || (Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.length > 0)
    )).length
  } catch {
    detectionAvailable = false
  }

  try {
    const jobs = ctx.get('jobs')
    if (!jobs || typeof jobs.list !== 'function') throw new Error('jobs service is unavailable')
    const seen = new Set()
    for (const caller of [undefined, ...agentList]) {
      const rows = jobs.list(caller)
      for (const job of Array.isArray(rows) ? rows : []) {
        const key = String(job?.id)
        if (seen.has(key)) continue
        seen.add(key)
        if (job && (job.status === 'running' || job.status === 'stopping')) counts.jobs += 1
      }
    }
  } catch {
    detectionAvailable = false
  }

  try {
    const seen = new Set()
    const scan = (terminals, owner) => {
      if (!terminals || typeof terminals.list !== 'function') return
      for (const terminal of terminals.list(owner) ?? []) {
        const key = String(terminal?.sessionId)
        if (seen.has(key)) continue
        seen.add(key)
        if (terminal?.status?.kind === 'running') counts.terminals += 1
      }
    }
    for (const agent of agentList) {
      try {
        scan(agent?.ctx?.get?.('terminals'), agent)
      } catch {
        detectionAvailable = false
      }
    }
    scan(ctx.get('terminals'), undefined)
  } catch {
    detectionAvailable = false
  }

  return {
    ...counts,
    total: counts.agents + counts.jobs + counts.terminals,
    detectionAvailable,
  }
}

/** @param ctx - profile context carrying `webServer` */
export function apply(ctx, config) {
  const options = readOptions(config)
  const stateDir = resolveStateDir()
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'helper.ps1')
  const pendingPath = join(stateDir, PENDING_FILE)
  const statePath = join(stateDir, STATE_FILE)
  const logPath = join(stateDir, LOG_FILE)
  const launchPath = join(stateDir, LAUNCH_FILE)
  const cancelPath = join(stateDir, CANCEL_FILE)

  const desktop = detectDesktop()
  // console, not ctx.logger: the logger face differs between Host versions, and a
  // missing or differently-shaped service must never take this plugin's load down.
  const log = (level, message) => console[level](`[dsh-restart] ${message}`)
  if (!desktop.desktop) log('warn', `restart disabled: ${desktop.reason}`)
  if (!existsSync(helperPath)) log('warn', `helper script missing: ${helperPath}`)

  /** Set once a restart is in flight, so a second click cannot schedule another. */
  let scheduled = null

  async function readPending() {
    const marker = await readJson(pendingPath)
    if (!marker || typeof marker.sessionId !== 'string' || typeof marker.at !== 'number') return null
    if (Date.now() - marker.at > options.pendingTtlMinutes * 60 * 1000) {
      await rm(pendingPath, { force: true }).catch(() => {})
      return null
    }
    return marker
  }

  async function status() {
    const activeWork = collectActiveWork(ctx)
    const pendingRestore = await readPending()
    const lastRun = await readJson(statePath)
    const lastLaunch = await readJson(launchPath)
    const helperAvailable = existsSync(helperPath)
    const canRestart = options.enabled && desktop.desktop && helperAvailable && scheduled === null
    let reason = null
    if (!options.enabled) reason = 'the plugin is disabled by configuration'
    else if (!desktop.desktop) reason = desktop.reason
    else if (!helperAvailable) reason = `helper script missing: ${helperPath}`
    else if (scheduled !== null) reason = 'a restart is already scheduled'
    return {
      canRestart,
      reason,
      hostPid: process.pid,
      shellPid: desktop.desktop ? process.ppid : null,
      shellPath: desktop.desktop ? process.execPath : null,
      stateDir,
      logPath,
      activeWork,
      pendingRestore: pendingRestore === null ? null : { sessionId: pendingRestore.sessionId, at: pendingRestore.at },
      lastRun: lastRun === null ? null : {
        phase: lastRun.phase ?? null,
        at: lastRun.at ?? null,
        error: lastRun.error ?? null,
        newShellPid: lastRun.newShellPid ?? 0,
        hostPid: lastRun.hostPid ?? null,
        shellPid: lastRun.shellPid ?? null,
      },
      lastLaunch: lastLaunch === null ? null : {
        ok: lastLaunch.ok === true,
        pid: lastLaunch.pid ?? null,
        windowHidden: lastLaunch.windowHidden ?? null,
        error: lastLaunch.error ?? null,
        at: lastLaunch.at ?? null,
      },
    }
  }

  /**
   * Start the helper through the WMI service and wait for its first state write.
   *
   * The launcher itself is an ordinary child of this process, but it only asks
   * the service to create the helper and then exits. The helper is a child of
   * WmiPrvSE, on the other side of the process-tree boundary, which is the whole
   * reason it can kill the shell and still be alive to start the replacement.
   *
   * Waiting matters: a helper that never starts would otherwise be discovered
   * only after the application is already gone. The reply states whether the
   * helper is actually running, not merely that a spawn call returned.
   */
  async function spawnHelper() {
    await mkdir(stateDir, { recursive: true })
    await rm(statePath, { force: true }).catch(() => {})
    await rm(logPath, { force: true }).catch(() => {})
    await rm(launchPath, { force: true }).catch(() => {})
    await rm(cancelPath, { force: true }).catch(() => {})

    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const commandLine = buildHelperCommandLine({
      powershell,
      helperPath,
      shellPid: process.ppid,
      hostPid: process.pid,
      shellPath: process.execPath,
      stateDir,
      delayMs: options.delayMs,
      hostGraceMs: options.hostGraceMs,
      killTimeoutMs: options.killTimeoutMs,
    })

    let spawnError = null
    let launcher = null
    let launcherExited = null
    try {
      launcher = spawn(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        // The script goes in as UTF-16LE base64, so no argument in it needs
        // quoting and no path can be split by the command line.
        '-EncodedCommand', Buffer.from(buildWmiLauncherScript(commandLine, launchPath), 'utf16le').toString('base64'),
      ], {
        // Ignored stdio keeps the Host's pipes out of the launcher's hands.
        stdio: 'ignore',
        windowsHide: true,
        cwd: stateDir,
      })
      launcher.on('error', (error) => {
        // Without a listener, a spawn failure would be an unhandled 'error'
        // event and take the Host down.
        spawnError = error
      })
      launcher.on('exit', (code) => {
        launcherExited = code
      })
      launcher.unref()
    } catch (error) {
      spawnError = error
    }

    const deadline = Date.now() + HELPER_BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const state = await readJson(statePath)
      if (state && typeof state.phase === 'string') {
        const launch = await readJson(launchPath)
        // A helper created without the hidden-window record puts a console box on
        // screen. The restart still works, so this is a warning, not a refusal —
        // but it must be visible in the log instead of only in the task bar.
        if (launch !== null && launch.ok === true && launch.windowHidden === false) {
          log('warn', 'the helper was created without a hidden window; a console window will show')
        }
        return { started: true, state, launch, spawnError: null }
      }
      if (spawnError !== null) break
      // The launcher is short-lived: once it is gone and its result file says
      // the service refused, waiting out the rest of the budget would only make
      // a broken WMI call feel like a hang.
      if (launcherExited !== null) {
        const launch = await readJson(launchPath)
        if (launch !== null && launch.ok !== true) {
          return { started: false, state: null, launch, spawnError }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const launch = await readJson(launchPath)
    if (launcher !== null) {
      // The launcher may still be waiting on the service; the helper cannot
      // exist yet without its boot state, so stopping it here is safe.
      try { launcher.kill('SIGKILL') } catch { /* already gone */ }
    }
    return { started: false, state: null, launch, spawnError }
  }

  /**
   * Tell a helper that may still be sleeping not to kill anything.
   *
   * The helper is not this process's child, so it cannot be killed directly and
   * does not need to be: it checks this marker after its delay, before the kill.
   * Written only when the launch could not be confirmed, where the alternative
   * is a delayed helper tearing the application down after the UI said it would
   * not.
   */
  async function cancelHelper() {
    try {
      await writeFile(cancelPath, JSON.stringify({ at: Date.now() }), 'utf8')
    } catch { /* the state directory may be gone; nothing left to cancel */ }
  }

  const routes = [
    {
      path: `${API_BASE}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, await status())
        } catch (error) {
          sendJson(res, 500, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${API_BASE}/restart`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res)) return
        try {
          const raw = await readBody(req)
          const body = raw.length === 0 ? {} : (JSON.parse(raw) ?? {})
          const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null

          if (!options.enabled) {
            sendJson(res, 503, { error: 'the plugin is disabled by configuration' })
            return
          }
          if (!desktop.desktop) {
            sendJson(res, 503, { error: desktop.reason })
            return
          }
          if (!existsSync(helperPath)) {
            sendJson(res, 503, { error: `helper script missing: ${helperPath}` })
            return
          }
          if (scheduled !== null) {
            sendJson(res, 409, { error: 'a restart is already scheduled' })
            return
          }

          // The client confirms before it sends `force`. Without that flag an
          // interrupted agent is a refusal, not a warning.
          const activeWork = collectActiveWork(ctx)
          if (activeWork.total > 0 && body.force !== true) {
            sendJson(res, 409, {
              error: `active work would be interrupted (agents ${activeWork.agents} / jobs ${activeWork.jobs} / terminals ${activeWork.terminals})`,
              items: activeWork,
            })
            return
          }

          scheduled = { at: Date.now(), sessionId }
          if (sessionId !== null) {
            await mkdir(stateDir, { recursive: true })
            await writeJson(pendingPath, { sessionId, at: Date.now() })
          }

          const { started, state, launch, spawnError } = await spawnHelper()
          if (!started) {
            scheduled = null
            await cancelHelper()
            await rm(pendingPath, { force: true }).catch(() => {})
            const detail = launch?.error ?? spawnError?.message ?? 'no boot state from the helper'
            sendJson(res, 500, {
              error: `the restart helper did not start (${detail}); the application was left running`,
              detail,
              launch: launch ?? null,
              stateDir,
              logPath,
              launchPath,
            })
            return
          }

          sendJson(res, 200, {
            ok: true,
            helperPid: state.helperPid ?? null,
            launchedPid: launch?.pid ?? null,
            shellPid: process.ppid,
            hostPid: process.pid,
            delayMs: options.delayMs,
            sessionId,
          })
        } catch (error) {
          scheduled = null
          sendJson(res, 400, { error: error?.message ?? String(error) })
        }
      },
    },
    {
      path: `${API_BASE}/pending`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const marker = await readPending()
        sendJson(res, 200, marker === null ? { sessionId: null } : { sessionId: marker.sessionId, at: marker.at })
      },
    },
    {
      path: `${API_BASE}/pending/consume`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (rejectCrossOrigin(req, res)) return
        const marker = await readPending()
        if (marker !== null) await rm(pendingPath, { force: true }).catch(() => {})
        sendJson(res, 200, marker === null ? { sessionId: null } : { sessionId: marker.sessionId, at: marker.at })
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `dsh-restart ${route.path}`,
    )
  }
}

export default { name, inject, apply }
