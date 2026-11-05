/**
 * Smoke test for the Host half.
 *
 * There is no live Host in a test shell, so this builds the smallest cordis-shaped
 * context the module actually touches and drives the real handlers. What it
 * proves:
 *
 *   1. the module exports the standard plugin face
 *   2. `apply` registers exactly the documented routes, under `ctx.effect`
 *   3. `/status` answers with the documented shape
 *   4. a CLI Host (no Electron) refuses the restart instead of pretending to work
 *   5. active-work counting is fail-open and counts what it should
 *   6. the pending-session marker is written once and consumed once
 *
 * Usage: node scripts/smoke-host.mjs
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const results = []
function check(name, ok, detail = '') {
  results.push({ ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/* A Home of its own, so the test never touches the real ~/.dsh/dsh-restart. */
const home = await mkdtemp(join(tmpdir(), 'dsh-restart-smoke-'))
process.env.DSH_HOME = home

const plugin = await import('../lib/index.js')
check('exports a name', typeof plugin.name === 'string' && plugin.name.length > 0, plugin.name)
check('exports apply', typeof plugin.apply === 'function')
check('injects webServer', Array.isArray(plugin.inject) && plugin.inject.includes('webServer'))

/* ------------------------------------------------------------ fake services */

function fakeCtx({ agents = [], jobs = [], terminals = [] } = {}) {
  const routes = []
  const effects = []
  const services = {
    agents: { list: () => agents },
    jobs: { list: (owner) => (owner === undefined ? jobs : jobs.filter((job) => job.owner === owner.id)) },
    terminals: { list: () => terminals },
  }
  return {
    routes,
    effects,
    get: (key) => services[key],
    effect(fn, label) {
      effects.push({ fn, label })
      const disposer = fn()
      if (typeof disposer === 'function') return disposer
      return () => {}
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
  }
}

/* Fake req/res that capture a JSON reply. */
function invoke(handler, { method = 'GET', body, origin, host = '127.0.0.1:5000' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const req = {
    method,
    headers,
    on(event, fn) {
      if (event === 'end') {
        this._end = fn
      }
      if (event === 'data' && body !== undefined) fn(Buffer.from(body))
      if (event === 'data' && body === undefined) { /* empty */ }
      return this
    },
    destroy() {},
  }
  let ended = false
  const fireEnd = () => {
    if (ended) return
    ended = true
    queueMicrotask(() => req._end?.())
  }
  const res = {
    status: null,
    payload: null,
    writeHead(status) { this.status = status },
    end(text) { this.payload = text === undefined ? null : JSON.parse(text) },
  }
  const done = Promise.resolve(handler(req, res))
  // The real handlers attach their streams synchronously; drain the body now.
  fireEnd()
  return done.then(() => ({ status: res.status, body: res.payload }))
}

/* ------------------------------------------------------------------- route 1 */

const ctx1 = fakeCtx()
plugin.apply(ctx1, {})

const paths = ctx1.routes.map((route) => route.path).sort()
const expected = [
  '/api/dsh-restart/pending',
  '/api/dsh-restart/pending/consume',
  '/api/dsh-restart/restart',
  '/api/dsh-restart/status',
]
check('registers the four routes', JSON.stringify(paths) === JSON.stringify(expected), paths.join(', '))
check('every route is exact', ctx1.routes.every((route) => route.kind === 'exact'))
check('every route is scoped to an effect', ctx1.effects.length === 4)

const route = (path) => ctx1.routes.find((entry) => entry.path === path).handler

const statusReply = await invoke(route('/api/dsh-restart/status'))
check('GET /status answers 200', statusReply.status === 200, String(statusReply.status))
check('status carries the PIDs', typeof statusReply.body?.hostPid === 'number', String(statusReply.body?.hostPid))
check('status reports the active work block', typeof statusReply.body?.activeWork?.total === 'number')
check(
  'a CLI host cannot restart',
  statusReply.body?.canRestart === false && typeof statusReply.body?.reason === 'string',
  statusReply.body?.reason,
)

const restarted = await invoke(route('/api/dsh-restart/restart'), { method: 'POST', body: '{}' })
check('POST /restart refuses on a CLI host', restarted.status === 503, String(restarted.status))

const crossed = await invoke(route('/api/dsh-restart/restart'), {
  method: 'POST',
  body: '{}',
  origin: 'http://evil.example',
})
check('cross-origin POST is refused', crossed.status === 403, String(crossed.status))

const wrongMethod = await invoke(route('/api/dsh-restart/restart'), { method: 'GET' })
check('wrong method is refused', wrongMethod.status === 405, String(wrongMethod.status))

/* ------------------------------------------------------- active work counts */

const busy = fakeCtx({
  agents: [
    { id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
    { id: 'a2', status: 'idle', inbox: { nextTurn: ['m'], nextStep: [] } },
    { id: 'a3', status: 'idle', inbox: { nextTurn: [], nextStep: [] } },
  ],
  jobs: [
    { id: 'j1', status: 'running' },
    { id: 'j2', status: 'stopping' },
    { id: 'j3', status: 'finished' },
  ],
  terminals: [{ sessionId: 't1', status: { kind: 'running' } }, { sessionId: 't2', status: { kind: 'exited' } }],
})
plugin.apply(busy, {})
const busyStatus = await invoke(busy.routes.find((entry) => entry.path === '/api/dsh-restart/status').handler)
check('counts a running agent', busyStatus.body?.activeWork?.agents === 2, String(busyStatus.body?.activeWork?.agents))
check('counts running and stopping jobs', busyStatus.body?.activeWork?.jobs === 2, String(busyStatus.body?.activeWork?.jobs))
check('counts a running terminal', busyStatus.body?.activeWork?.terminals === 1, String(busyStatus.body?.activeWork?.terminals))

/* A Host without the services must still answer (fail-open safety net). */
const blindRoutes = []
const blind = {
  get: () => undefined,
  effect(fn) { fn(); return () => {} },
  logger: () => ({ info() {}, warn() {}, error() {} }),
  webServer: { register(spec) { blindRoutes.push(spec); return () => {} } },
}
plugin.apply(blind, {})
const blindStatus = await invoke(blindRoutes.find((entry) => entry.path === '/api/dsh-restart/status').handler)
check('missing services still answer', blindStatus.status === 200, String(blindStatus.status))
check('missing services fail open', blindStatus.body?.activeWork?.total === 0 && blindStatus.body?.activeWork?.detectionAvailable === false)

/* ------------------------------------------------------- pending marker path */

const stateDir = join(home, 'dsh-restart')
await mkdir(stateDir, { recursive: true })
await writeFile(join(stateDir, 'pending-restore.json'), JSON.stringify({ sessionId: 's-123', at: Date.now() }), 'utf8')

const ctx2 = fakeCtx()
plugin.apply(ctx2, {})
const pendingReply = await invoke(ctx2.routes.find((entry) => entry.path === '/api/dsh-restart/pending').handler)
check('a fresh marker is reported', pendingReply.body?.sessionId === 's-123', JSON.stringify(pendingReply.body))

const consumeReply = await invoke(ctx2.routes.find((entry) => entry.path === '/api/dsh-restart/pending/consume').handler, { method: 'POST' })
check('consume returns the session once', consumeReply.body?.sessionId === 's-123')
check('consume deletes the marker', !existsSync(join(stateDir, 'pending-restore.json')))

const secondConsume = await invoke(ctx2.routes.find((entry) => entry.path === '/api/dsh-restart/pending/consume').handler, { method: 'POST' })
check('a second consume finds nothing', secondConsume.body?.sessionId === null, JSON.stringify(secondConsume.body))

await writeFile(
  join(stateDir, 'pending-restore.json'),
  JSON.stringify({ sessionId: 'stale', at: Date.now() - 31 * 60 * 1000 }),
  'utf8',
)
const staleReply = await invoke(ctx2.routes.find((entry) => entry.path === '/api/dsh-restart/pending').handler)
check('an expired marker is ignored', staleReply.body?.sessionId === null, JSON.stringify(staleReply.body))

/* ------------------------------------------------------------ helper presence */

const helperPath = join(import.meta.dirname, '..', 'lib', 'helper.ps1')
check('helper script ships with the package', existsSync(helperPath))

/* ------------------------------------------- the WMI hand-off, without Windows */

const sample = {
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  helperPath: 'C:\\Users\\Ray\\.dsh\\profiles\\desktop\\node_modules\\@ray1270\\dsh-restart\\lib\\helper.ps1',
  shellPid: 4242,
  hostPid: 5252,
  shellPath: 'D:\\dsh\\DeepSeek Harness.exe',
  stateDir: 'C:\\Users\\Ray\\.dsh\\dsh-restart',
  delayMs: 1200,
  hostGraceMs: 8000,
  killTimeoutMs: 15000,
}
const commandLine = plugin.buildHelperCommandLine(sample)
check('the command line quotes the executable', commandLine.startsWith('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile'))
check('the command line keeps the spaced paths whole', commandLine.includes('-ShellPath "D:\\dsh\\DeepSeek Harness.exe"'))
check('the command line carries both pids', commandLine.includes('-ShellPid 4242') && commandLine.includes('-HostPid 5252'))
check('the command line names the helper once', commandLine.split(sample.helperPath).length === 2)

const embeddedQuote = plugin.buildHelperCommandLine({ ...sample, shellPath: 'C:\\odd folder\\a"b.exe' })
check('an embedded quote is escaped', embeddedQuote.includes('-ShellPath "C:\\odd folder\\a\\"b.exe"'), embeddedQuote)

const launcher = plugin.buildWmiLauncherScript(commandLine, 'C:\\Users\\Ray\\.dsh\\dsh-restart\\launch-result.json')
check('the launcher asks WMI to create the process', launcher.includes('Invoke-CimMethod -ClassName Win32_Process -MethodName Create'))
check('the launcher carries the command line as base64', launcher.includes(Buffer.from(commandLine, 'utf8').toString('base64')))
check('the launcher carries the result path as base64', launcher.includes(Buffer.from('C:\\Users\\Ray\\.dsh\\dsh-restart\\launch-result.json', 'utf8').toString('base64')))
check('the launcher writes a JSON result', launcher.includes('WriteAllText($resultPath'))
check('the launcher fails its exit code when WMI refused', launcher.includes('if ($payload.ok) { exit 0 } else { exit 1 }'))
check(
  'the launcher asks WMI to create the helper with a hidden window',
  launcher.includes('Win32_ProcessStartup') && launcher.includes('ShowWindow = [uint16]0'),
)
check('the launcher hands that startup record to the create call', launcher.includes('ProcessStartupInformation'))
check('the launcher reports whether the window could be hidden', launcher.includes('windowHidden'))

await rm(home, { recursive: true, force: true }).catch(() => {})

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
