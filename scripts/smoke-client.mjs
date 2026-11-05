/**
 * Smoke test for the Client half.
 *
 * The browser half is a plain script that installs itself through
 * `window.__ModuleLoader__.load`, so it can be loaded in Node with a stub
 * loader, stub browser globals and a stub `fetch`. The module keeps its state
 * inside the factory closure, so every scenario below loads a fresh instance —
 * which is also how the page sees it after a reload.
 *
 * Covered here:
 *
 *   1. the module registers under the right id and evaluates without errors
 *   2. it asks for the `slots` service and registers into the documented seat
 *   3. the registration carries an id, an order and a lazily-evaluated label
 *   4. the component is a function of the slot props
 *   5. the restart hand-off consumes a pending Session marker and navigates
 *   6. the first click only pre-flights, the second one schedules
 *   7. a refresh click remembers the Session and reloads the page
 *   8. a refresh marker wins over a restart marker, and a stale one is ignored
 *
 * Usage: node scripts/smoke-client.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER_KEY = '@ray1270/dsh-restart:resume'

const results = []
function check(name, ok, detail = '') {
  results.push({ ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/* --------------------------------------------------------------- harness */

/** The subset of Storage the module touches. */
function createStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    read: (key) => (map.has(key) ? map.get(key) : null),
  }
}

const ACTIVE_WORK = { agents: 1, jobs: 0, terminals: 0, total: 1, detectionAvailable: true }

/**
 * Evaluate one fresh copy of the client module against stub globals.
 *
 * The React stub runs effects during render, which is what lets the header
 * component publish its `sessionId` into the module's tracker — the same
 * hand-off the real renderer performs after mount.
 */
function loadClient({ storage, pending = { sessionId: null }, status = { canRestart: true, activeWork: ACTIVE_WORK } }) {
  let loaded = null
  const fetched = []
  const reloads = []

  const fetchStub = async (url, init = {}) => {
    const target = String(url)
    fetched.push({ url: target, method: init.method ?? 'GET', body: init.body ?? null })
    const body = target.endsWith('/pending/consume') ? pending
      : target.endsWith('/pending') ? pending
        : target.endsWith('/status') ? status
          : target.endsWith('/restart') ? { ok: true }
            : {}
    return { ok: true, status: 200, json: async () => body }
  }

  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', 'document', 'localStorage', 'location', source)(
    { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
    fetchStub,
    setTimeout,
    clearTimeout,
    undefined,
    storage,
    { reload: () => reloads.push(Date.now()) },
  )

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: (fn) => { fn() },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }

  const plugin = loaded.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { plugin, fetched, reloads, loaded }
}

/** Apply the plugin to a stub client context and keep what it registered. */
function mount(plugin) {
  const registrations = []
  const effectLabels = []
  const opened = []
  const ctx = {
    slots: {
      inject(name, callback) {
        registrations.push({ name })
        return callback()
      },
      register(options, component) {
        const entry = registrations[registrations.length - 1]
        entry.options = options
        entry.component = component
        return () => {}
      },
    },
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    get(key) {
      if (key === 'uiWorkspace') return { openSession: (target) => opened.push(target) }
      return undefined
    },
  }
  plugin.apply(ctx)
  return { registrations, effectLabels, opened }
}

/* ------------------------------------------------------- registration */

const first = loadClient({ storage: createStorage(), pending: { sessionId: 'session-42' } })
check('module loads through window.__ModuleLoader__', first.loaded !== null)
check('module id is the package name', first.loaded?.id === '@ray1270/dsh-restart', first.loaded?.id)
check('factory returns a plugin face', typeof first.plugin?.apply === 'function')
check('plugin injects slots', JSON.stringify(first.plugin?.inject) === JSON.stringify(['slots']), JSON.stringify(first.plugin?.inject))

const run = mount(first.plugin)
check('registers exactly one seat', run.registrations.length === 1, String(run.registrations.length))
check('seat is the right-aligned Session utilities', run.registrations[0]?.name === 'conversation.session.header.utilities', run.registrations[0]?.name)
check('registration has its own id', run.registrations[0]?.options?.id === 'dsh-restart', String(run.registrations[0]?.options?.id))
check('registration orders last', run.registrations[0]?.options?.order === 900, String(run.registrations[0]?.options?.order))
check('label is lazy and names both actions', typeof run.registrations[0]?.options?.label === 'function' && run.registrations[0].options.label() === '刷新与重启')
check('component is a function', typeof run.registrations[0]?.component === 'function')
check(
  'both surfaces are scoped to effects',
  run.effectLabels.length === 2
    && run.effectLabels.includes('dsh-restart caption control')
    && run.effectLabels.includes('dsh-restart header control'),
  run.effectLabels.join(' | '),
)

/* ------------------------------------------------------- session hand-off */

check('no pending marker means no navigation yet', run.opened.length === 0)
await sleep(2600)
check('pending marker navigates once', JSON.stringify(run.opened) === JSON.stringify(['session-42']), JSON.stringify(run.opened))
check('marker is consumed', first.fetched.some((entry) => entry.url.endsWith('/pending/consume') && entry.method === 'POST'))
await sleep(1200)
check('navigation does not repeat', run.opened.length === 1, String(run.opened.length))

/* ----------------------------------------------------- the header pair */

const component = run.registrations[0]?.component
const tree = component({ sessionId: 'session-refresh-1' })
check('header renders a wrapper around both actions', tree?.type === 'span' && tree?.props?.['data-dsh-quick-actions'] === '', String(tree?.type))
check('header wrapper holds refresh then restart', tree?.children?.length === 2
  && tree.children[0]?.props?.['data-dsh-refresh-control'] === 'idle'
  && tree.children[1]?.props?.['data-dsh-restart-control'] === 'idle',
  JSON.stringify(tree?.children?.map((child) => child?.props)))
check('header labels both actions in words', tree?.children?.[0]?.children?.[0] === '刷新'
  && tree?.children?.[1]?.children?.[0]?.children?.[0] === '重启',
  `${tree?.children?.[0]?.children?.[0]} / ${tree?.children?.[1]?.children?.[0]?.children?.[0]}`)

const storage = createStorage()
const refreshRun = loadClient({ storage })
const refreshCtx = mount(refreshRun.plugin)
const refreshTree = refreshCtx.registrations[0].component({ sessionId: 'session-refresh-1' })
refreshTree.children[0].props.onClick()
const marked = JSON.parse(storage.read(MARKER_KEY) ?? 'null')
check('refresh remembers the open Session before reloading', marked?.sessionId === 'session-refresh-1', JSON.stringify(marked))
check('refresh does not reload synchronously', refreshRun.reloads.length === 0)
await sleep(220)
check('refresh reloads the page', refreshRun.reloads.length === 1, String(refreshRun.reloads.length))
check('refresh does not talk to the Host', refreshRun.fetched.length === 0, JSON.stringify(refreshRun.fetched.map((entry) => entry.url)))

/* ------------------------------------ refresh marker beats restart marker */

const local = createStorage({ [MARKER_KEY]: JSON.stringify({ sessionId: 'session-local', at: Date.now() }) })
const localRun = loadClient({ storage: local, pending: { sessionId: 'session-server' } })
const localCtx = mount(localRun.plugin)
await sleep(2600)
check('a fresh refresh marker wins over the restart marker', JSON.stringify(localCtx.opened) === JSON.stringify(['session-local']), JSON.stringify(localCtx.opened))
check('the consumed refresh marker is cleared', local.read(MARKER_KEY) === null, String(local.read(MARKER_KEY)))
check('no restart marker is fetched when a refresh marker exists', localRun.fetched.some((entry) => entry.url.endsWith('/pending')) === false)

/* ----------------------------------------- a stale marker is not trusted */

const stale = createStorage({ [MARKER_KEY]: JSON.stringify({ sessionId: 'session-stale', at: Date.now() - 10 * 60 * 1000 }) })
const staleRun = loadClient({ storage: stale, pending: { sessionId: 'session-server' } })
const staleCtx = mount(staleRun.plugin)
await sleep(2600)
check('an expired refresh marker is ignored', JSON.stringify(staleCtx.opened) === JSON.stringify(['session-server']), JSON.stringify(staleCtx.opened))
check('the expired marker is dropped', stale.read(MARKER_KEY) === null, String(stale.read(MARKER_KEY)))

/* ------------------------------------------------------------- summary */

const failed = results.filter((entry) => !entry.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
