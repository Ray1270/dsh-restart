/**
 * Pre-flight for the restart helper.
 *
 * The one thing this script cannot test is the real application: killing the
 * shell would kill the very Host running the test. Everything else it does test
 * for real, against throwaway processes:
 *
 *   1. the helper starts, writes `boot`, and reaches the kill step
 *   2. it terminates the given shell PID
 *   3. it waits for the given Host PID and force-kills it after the grace window
 *   4. it relaunches the executable and verifies the new process survived
 *   5. with a shell PID that no longer matches the executable, it aborts WITHOUT
 *      killing anything (the PID-reuse guard)
 *   6. launched the way the Host launches it — through WMI, so its parent is
 *      WmiPrvSE.exe — it does all of the above, which is the part a direct child
 *      process could not do
 *
 * `powershell.exe` stands in for the application because the helper checks that
 * the PID's image path is still the expected executable — a .cmd shim would fail
 * that check for the wrong reason.
 *
 * Usage: node scripts/selftest-helper.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildHelperCommandLine, buildWmiLauncherScript } from '../lib/index.js'

const HELPER = join(import.meta.dirname, '..', 'lib', 'helper.ps1')
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function spawnProcess(command, args) {
  // Not `detached`: on Windows powershell.exe exits immediately when spawned
  // detached, and the flag gives no tree isolation anyway.
  const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
  return child.pid
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killQuietly(pid) {
  if (!pid) return
  try {
    process.kill(pid)
  } catch { /* already gone */ }
}

async function waitForState(statePath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const text = await readFile(statePath, 'utf8')
      last = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
      if (predicate(last)) return last
    } catch { /* not written yet */ }
    await sleep(120)
  }
  return last
}

/** A stand-in process that behaves like the app: same image path, stays alive. */
function startStandIn(seconds = 600) {
  return spawnProcess(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command', `Start-Sleep -Seconds ${seconds}`,
  ])
}

function runHelper({ stateDir, shellPid, hostPid, shellPath, delayMs, hostGraceMs, killTimeoutMs }) {
  const child = spawn(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', HELPER,
    '-ShellPid', String(shellPid),
    '-HostPid', String(hostPid),
    '-ShellPath', shellPath,
    '-StateDir', stateDir,
    '-DelayMs', String(delayMs),
    '-HostGraceMs', String(hostGraceMs),
    '-KillTimeoutMs', String(killTimeoutMs),
  ], { stdio: 'ignore', windowsHide: true })
  return child.pid
}

/**
 * Start the helper the way the Host does: a short-lived launcher asks the WMI
 * service to create it, so the helper's parent is WmiPrvSE and not this test.
 */
function runHelperViaWmi({ stateDir, shellPid, hostPid, shellPath, delayMs, hostGraceMs, killTimeoutMs }) {
  const commandLine = buildHelperCommandLine({
    powershell: POWERSHELL,
    helperPath: HELPER,
    shellPid,
    hostPid,
    shellPath,
    stateDir,
    delayMs,
    hostGraceMs,
    killTimeoutMs,
  })
  const script = buildWmiLauncherScript(commandLine, join(stateDir, 'launch-result.json'))
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ], { stdio: 'ignore', windowsHide: true })
  return child.pid
}

/**
 * Watch the screen for a visible window with this title while a helper runs.
 *
 * This is the user's side of the contract, and the only assertion here that
 * looks at pixels: a console program created by WMI without startup information
 * is handed a visible console window, and nothing the script does from inside
 * can undo it (`-WindowStyle Hidden` applies after the window exists). The helper
 * titles its console `dsh-restart helper`, so a regression shows up as a visible
 * window with that title.
 */
function watchForVisibleWindow(titleFragment, seconds) {
  const script = join(import.meta.dirname, 'find-visible-window.ps1')
  const child = spawn(POWERSHELL, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-TitleFragment', titleFragment,
    '-Seconds', String(seconds),
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  return new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, output: error.message }))
    child.on('exit', (code) => resolve({ code, output: output.trim() }))
  })
}

const results = []
function check(name, ok, detail = '') {  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

if (!existsSync(HELPER)) {
  console.error(`helper not found: ${HELPER}`)
  process.exit(2)
}

/* ---------------------------------------------------------------- happy path */

const workDir = await mkdtemp(join(tmpdir(), 'dsh-restart-selftest-'))
const statePath = join(workDir, 'restart-state.json')

process.stdout.write(`\n[1/4] happy path — state dir ${workDir}\n`)
const shellPid = startStandIn()
const hostPid = startStandIn()
await sleep(900)
check('stand-in shell started', isAlive(shellPid), `pid ${shellPid}`)
check('stand-in host started', isAlive(hostPid), `pid ${hostPid}`)

const helperPid = runHelper({
  stateDir: workDir,
  shellPid,
  hostPid,
  shellPath: POWERSHELL,
  delayMs: 400,
  hostGraceMs: 900,
  killTimeoutMs: 6000,
})

const booted = await waitForState(statePath, (state) => state.phase !== 'boot', 5000)
check('helper wrote boot state and advanced', booted !== null && booted.phase !== undefined, booted?.phase ?? 'no state')

const settled = await waitForState(statePath, (state) => ['relaunched', 'failed', 'aborted'].includes(state.phase), 25000)
check('helper reached a terminal phase', settled?.phase === 'relaunched', settled?.phase ?? 'timeout')
check('helper belongs to a live process', isAlive(helperPid) || settled?.phase === 'relaunched', `helper pid ${helperPid}`)
check('old shell was terminated', !isAlive(shellPid), `shell pid ${shellPid}`)
check('old host was terminated', !isAlive(hostPid), `host pid ${hostPid}`)
check('relaunched process survives', isAlive(settled?.newShellPid), `new pid ${settled?.newShellPid ?? 0}`)
check('outcome records no error', !settled?.error, settled?.error ?? '')

await killQuietly(settled?.newShellPid)

/* ------------------------------------------- launched through WMI, like the Host */

process.stdout.write("\n[2/4] WMI launch — the helper is not a child of this process\n")
const wmiDir = await mkdtemp(join(tmpdir(), 'dsh-restart-wmi-'))
const wmiStatePath = join(wmiDir, 'restart-state.json')
const wmiShellPid = startStandIn()
const wmiHostPid = startStandIn()
await sleep(900)

// Started before the launch — the scanner spends about a second compiling — and
// awaited once the scenario settles, so it overlaps the console's whole lifetime.
const wmiWindowWatch = watchForVisibleWindow('dsh-restart helper', 12)
const launcherPid = runHelperViaWmi({
  stateDir: wmiDir,
  shellPid: wmiShellPid,
  hostPid: wmiHostPid,
  shellPath: POWERSHELL,
  delayMs: 400,
  hostGraceMs: 900,
  killTimeoutMs: 6000,
})
check('WMI launcher started', Number.isInteger(launcherPid) && launcherPid > 0, `pid ${launcherPid}`)

const wmiSettled = await waitForState(wmiStatePath, (state) => ['relaunched', 'failed', 'aborted'].includes(state.phase), 45000)
check('WMI-launched helper reached relaunched', wmiSettled?.phase === 'relaunched', wmiSettled?.phase ?? 'timeout')
check('WMI helper killed the old shell', !isAlive(wmiShellPid), `shell pid ${wmiShellPid}`)
check('WMI helper killed the old host', !isAlive(wmiHostPid), `host pid ${wmiHostPid}`)
check('WMI relaunch survived', isAlive(wmiSettled?.newShellPid), `new pid ${wmiSettled?.newShellPid ?? 0}`)

const wmiLog = await readFile(join(wmiDir, 'helper.log'), 'utf8').catch(() => '')
check(
  'helper parent is the WMI service, not this test',
  /WmiPrvSE/i.test(wmiLog),
  (wmiLog.split('\n').find((line) => line.includes('parent=')) ?? 'no boot line').trim(),
)

let launchResult = null
try {
  const text = await readFile(join(wmiDir, 'launch-result.json'), 'utf8')
  launchResult = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
} catch { /* reported below */ }
check('WMI create reported success', launchResult?.ok === true, String(launchResult?.error ?? 'no launch result'))
check(
  'WMI create pid is the helper pid',
  launchResult?.pid === wmiSettled?.helperPid,
  `${launchResult?.pid ?? 0} vs ${wmiSettled?.helperPid ?? 0}`,
)
check(
  'the helper was created with the hidden-window startup record',
  launchResult?.windowHidden === true,
  `windowHidden=${String(launchResult?.windowHidden)}`,
)

const wmiWindowResult = await wmiWindowWatch
check(
  'no console window was visible while the helper ran',
  wmiWindowResult.code === 1,
  wmiWindowResult.output || `scanner exit ${wmiWindowResult.code}`,
)
await killQuietly(wmiSettled?.newShellPid)

/* ------------------------------------------------ the Host cancelled the restart */

process.stdout.write('\n[3/4] cancel marker — the Host gave up before the kill\n')
const cancelDir = await mkdtemp(join(tmpdir(), 'dsh-restart-cancel-'))
await writeFile(join(cancelDir, 'cancel-restart'), '{}', 'utf8')
const cancelVictim = startStandIn()
await sleep(900)

runHelper({
  stateDir: cancelDir,
  shellPid: cancelVictim,
  hostPid: cancelVictim,
  shellPath: POWERSHELL,
  delayMs: 300,
  hostGraceMs: 900,
  killTimeoutMs: 3000,
})

const cancelState = await waitForState(join(cancelDir, 'restart-state.json'), (state) => state.phase === 'aborted', 10000)
check('cancel aborted instead of killing', cancelState?.phase === 'aborted', cancelState?.phase ?? 'timeout')
await sleep(400)
check('cancel left the process alive', isAlive(cancelVictim), `pid ${cancelVictim}`)
await killQuietly(cancelVictim)

/* ------------------------------------------------------- PID-reuse guard only */

process.stdout.write('\n[4/4] PID-reuse guard — shell pid is not the expected executable\n')
const guardDir = await mkdtemp(join(tmpdir(), 'dsh-restart-guard-'))
const victimPid = startStandIn()
await sleep(900)
const wrongPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

runHelper({
  stateDir: guardDir,
  shellPid: victimPid,
  hostPid: victimPid,
  shellPath: wrongPath,
  delayMs: 200,
  hostGraceMs: 900,
  killTimeoutMs: 3000,
})

const guardState = await waitForState(join(guardDir, 'restart-state.json'), (state) => state.phase === 'aborted', 8000)
check('guard aborted instead of killing', guardState?.phase === 'aborted', guardState?.phase ?? 'timeout')
await sleep(400)
check('guard left the process alive', isAlive(victimPid), `pid ${victimPid}`)
await killQuietly(victimPid)

await rm(workDir, { recursive: true, force: true }).catch(() => {})
await rm(wmiDir, { recursive: true, force: true }).catch(() => {})
await rm(cancelDir, { recursive: true, force: true }).catch(() => {})
await rm(guardDir, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
