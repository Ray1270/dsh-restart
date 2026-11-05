/**
 * dsh-restart — Client half (browser module).
 *
 * Four jobs, all in the page:
 *
 *   1. a restart entry in the Windows window-caption menubar, right beside 应用
 *      and 编辑 — where an app-wide action belongs
 *   2. a refresh entry next to it: reload the page without touching the Host,
 *      which is what a client-plugin change actually needs
 *   3. the same pair in the Session header utilities for every surface without
 *      that caption bar (macOS, Linux, the plain browser); it steps aside as
 *      soon as the caption entries are really on screen
 *   4. putting the user back into the Session they were in before either action
 *
 * Restart and refresh are deliberately different shapes. A restart kills the
 * shell and everything in flight, so it takes two clicks and shows what it
 * would interrupt. A refresh only reloads this page — server-side work keeps
 * running — so one click is the right weight. The only casualty is the unsent
 * composer draft, and the tooltip says so instead of a modal stealing the click.
 *
 * The restart hand-off is server-side on purpose: the port changes on every
 * restart, so the origin changes too and localStorage does not survive it. The
 * refresh hand-off is the opposite case: the origin stays, so a localStorage
 * marker is enough and the Host never has to hear about a reload.
 *
 * The caption menubar is not part of the Web client: the Desktop preload draws
 * it into an open shadow root at the top of the window. A page module may only
 * extend it by appending siblings, which is what happens here. The shape is
 * probed, never assumed: without the host element or its shadow root the
 * surface simply does not mount and the header pair stays.
 *
 * Written as a plain browser module (no JSX, no bundler) in the same
 * `window.__ModuleLoader__` form the shipped client bundles use.
 */

window.__ModuleLoader__.load({
  id: '@ray1270/dsh-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** How long the second click stays armed. */
    const ARM_WINDOW_MS = 4000
    /** How long to keep asking whether the restart actually took effect. */
    const EFFECT_TIMEOUT_MS = 12000
    /** How long a failure stays readable before the label relaxes back. */
    const FAIL_HOLD_MS = 6000
    /** How long to wait before a reload, long enough to repaint the label. */
    const REFRESH_DELAY_MS = 80
    /** How long a refresh marker stays believable; a reload is not a slow trip. */
    const REFRESH_MARKER_TTL_MS = 2 * 60 * 1000

    /** Attribute the Desktop preload puts on the caption menubar host. */
    const CAPTION_HOST_ATTRIBUTE = 'data-windows-menu'
    /** Attribute this module puts on the wrapper it appends there. */
    const CAPTION_GROUP_ATTRIBUTE = 'data-dsh-restart-caption-group'
    /** Attribute this module puts on the restart button. */
    const CAPTION_BUTTON_ATTRIBUTE = 'data-dsh-restart-caption'
    /** Attribute this module puts on the refresh button. */
    const CAPTION_REFRESH_ATTRIBUTE = 'data-dsh-refresh-caption'
    /** localStorage key carrying the Session across a reload (same origin). */
    const REFRESH_MARKER_KEY = '@ray1270/dsh-restart:resume'

    const COLOR_MUTED = 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.85))'
    const COLOR_DANGER = 'var(--dsw-alias-state-error-primary, #d43a3a)'
    const COLOR_OK = 'var(--dsw-alias-state-success-primary, #1a9e55)'
    const COLOR_BORDER = 'var(--dsw-alias-separator-primary, rgba(128,128,128,0.35))'

    const REFRESH_TITLE = '刷新界面：重新加载页面，仍停在当前会话'

    /* ------------------------------------------------------------------ *
     * One restart interaction, shared by both surfaces.
     * ------------------------------------------------------------------ */

    /**
     * The state machine behind a restart entry.
     *
     * Phases: idle → checking → arming → running → failed. `failed` holds an
     * explanation for a few seconds and then relaxes back to idle, so a
     * transient problem does not leave a permanently red control.
     *
     * @param getSessionId - resolves the open Session at click time; the caption
     *   surface has no slot props, so the Session is read from the header
     *   control's tracking instead of captured when the machine is built.
     */
    function createRestartMachine(getSessionId) {
      let state = { phase: 'idle', activeWork: null, message: null }
      const listeners = new Set()
      let armTimer = null
      let relaxTimer = null
      let disposed = false

      const publish = (patch) => {
        if (disposed) return
        state = { ...state, ...patch }
        for (const listener of [...listeners]) {
          try {
            listener(state)
          } catch (error) {
            console.error('dsh-restart: state listener failed', error)
          }
        }
      }

      const clearArm = () => {
        if (armTimer !== null) clearTimeout(armTimer)
        armTimer = null
      }

      const clearRelax = () => {
        if (relaxTimer !== null) clearTimeout(relaxTimer)
        relaxTimer = null
      }

      const fail = (message) => {
        clearArm()
        clearRelax()
        publish({ phase: 'failed', activeWork: null, message })
        relaxTimer = setTimeout(() => {
          relaxTimer = null
          publish({ phase: 'idle', message: null })
        }, FAIL_HOLD_MS)
      }

      const disarm = () => {
        clearArm()
        publish({ phase: 'idle', activeWork: null, message: null })
      }

      /** Second click: the user has seen the counts and means it. */
      const execute = async () => {
        clearArm()
        const sessionId = typeof getSessionId === 'function' ? getSessionId() : null
        publish({ phase: 'running', message: null })
        let scheduledAt = 0
        try {
          const response = await fetch('/api/dsh-restart/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: typeof sessionId === 'string' ? sessionId : null, force: true }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          scheduledAt = Date.now()
        } catch (error) {
          fail(`重启请求失败：${error && error.message ? error.message : String(error)}`)
          return
        }

        // The application should disappear shortly. If it still answers well past
        // the helper's delay, the restart silently did not happen and saying so is
        // better than a spinner that never resolves.
        const watch = async () => {
          if (Date.now() - scheduledAt > EFFECT_TIMEOUT_MS) {
            fail('重启没有生效，应用仍在运行（详见 ~/.dsh/dsh-restart/helper.log）')
            return
          }
          try {
            const response = await fetch('/api/dsh-restart/status', { cache: 'no-store' })
            if (response.ok) {
              setTimeout(watch, 800)
              return
            }
            // Anything but 200 means the Host is going down; stop watching.
          } catch {
            // A refused connection is the expected outcome: the page is about to die.
          }
        }
        setTimeout(watch, 2500)
      }

      /** First click: pre-flight only. */
      const preflight = async () => {
        publish({ phase: 'checking', message: null })
        try {
          const response = await fetch('/api/dsh-restart/status', { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (payload?.canRestart !== true) {
            fail(payload?.reason ?? '当前环境不支持重启')
            return
          }
          publish({ phase: 'arming', activeWork: payload.activeWork ?? null })
          armTimer = setTimeout(disarm, ARM_WINDOW_MS)
        } catch (error) {
          fail(`无法连接 Host：${error && error.message ? error.message : String(error)}`)
        }
      }

      return {
        get state() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        click() {
          if (state.phase === 'checking' || state.phase === 'running') return
          if (state.phase === 'arming') {
            void execute()
            return
          }
          void preflight()
        },
        dispose() {
          disposed = true
          clearArm()
          clearRelax()
          listeners.clear()
        },
      }
    }

    const workCount = (state) => state.activeWork?.total ?? 0

    const HEADER_TITLE = (state, interrupting) => {
      if (state.phase === 'arming') {
        return interrupting > 0
          ? `重启会中断 ${interrupting} 项进行中的任务（再点一次确认，${ARM_WINDOW_MS / 1000} 秒内有效）`
          : `再点一次确认重启（${ARM_WINDOW_MS / 1000} 秒内有效）`
      }
      if (state.phase === 'running') return '正在重启 DeepSeek Harness'
      if (state.phase === 'checking') return '正在检查是否可以重启'
      if (state.phase === 'failed') return state.message ?? '重启不可用'
      return '重启 DeepSeek Harness'
    }

    /* ------------------------------------------------------------------ *
     * Refresh: a reload, not a restart.
     * ------------------------------------------------------------------ */

    /** The refresh marker, or null when there is none, it is stale, or storage is closed. */
    function readRefreshMarker() {
      if (typeof localStorage === 'undefined') return null
      try {
        const raw = localStorage.getItem(REFRESH_MARKER_KEY)
        if (raw === null) return null
        const marker = JSON.parse(raw)
        const usable = marker !== null
          && typeof marker === 'object'
          && typeof marker.sessionId === 'string'
          && marker.sessionId.length > 0
          && typeof marker.at === 'number'
        if (!usable || Date.now() - marker.at > REFRESH_MARKER_TTL_MS) {
          localStorage.removeItem(REFRESH_MARKER_KEY)
          return null
        }
        return marker
      } catch {
        // Storage may be closed (private mode, disabled cookies). Nothing to restore.
        return null
      }
    }

    function writeRefreshMarker(sessionId) {
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(REFRESH_MARKER_KEY, JSON.stringify({ sessionId, at: Date.now() }))
      } catch (error) {
        // The reload still happens; it just lands on the home page. Not worth
        // failing the click over, but it should be explainable in the console.
        console.warn('dsh-restart: could not remember the Session across a refresh', error)
      }
    }

    function clearRefreshMarker() {
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.removeItem(REFRESH_MARKER_KEY)
      } catch {
        /* nothing to clear */
      }
    }

    /**
     * Reload the page and ask the next load to reopen the Session.
     *
     * Client-side only: a reload keeps the origin, so the hand-off fits in
     * localStorage and the Host never has to know a refresh happened. A missing
     * Session (home page) reloads the same way, just without a target.
     *
     * @param getSessionId - resolves the open Session at click time.
     * @returns whether a reload was scheduled; false when this realm has no page.
     */
    function refreshPage(getSessionId) {
      const sessionId = typeof getSessionId === 'function' ? getSessionId() : null
      if (typeof sessionId === 'string' && sessionId.length > 0) writeRefreshMarker(sessionId)
      if (typeof location === 'undefined' || typeof location.reload !== 'function') return false
      setTimeout(() => {
        try {
          location.reload()
        } catch (error) {
          console.error('dsh-restart: the page could not be reloaded', error)
        }
      }, REFRESH_DELAY_MS)
      return true
    }

    /* ------------------------------------------------------------------ *
     * Surface 1: the Session header pair (fallback seat).
     * ------------------------------------------------------------------ */

    const STYLE_BUTTON = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '26px',
      padding: '0 8px',
      border: '1px solid transparent',
      borderRadius: '6px',
      background: 'transparent',
      color: COLOR_MUTED,
      font: 'inherit',
      fontSize: '12px',
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'color 120ms ease, border-color 120ms ease, background-color 120ms ease, opacity 120ms ease',
    }

    /* ------------------------------------------------------------------ *
     * Cross-surface state.
     * ------------------------------------------------------------------ */

    /** Whether the caption entries are really on screen; the header seat retreats while they are. */
    const captionLive = {
      value: false,
      listeners: new Set(),
      set(next) {
        if (captionLive.value === next) return
        captionLive.value = next
        for (const listener of [...captionLive.listeners]) {
          try {
            listener(next)
          } catch (error) {
            console.error('dsh-restart: caption listener failed', error)
          }
        }
      },
      subscribe(listener) {
        captionLive.listeners.add(listener)
        return () => captionLive.listeners.delete(listener)
      },
    }

    /**
     * The open Session, as reported by the header seat.
     *
     * The header slot is the only surface that receives `sessionId`; the caption
     * menubar is global. The header component keeps this value current for as
     * long as a Conversation is on screen (it renders nothing once the caption
     * entries took over), which makes a restart or refresh started from the
     * caption bar land back on the same Session.
     */
    const sessionTracker = { current: null }

    function useCaptionLive() {
      const [live, setLive] = React.useState(captionLive.value)
      React.useEffect(() => captionLive.subscribe(setLive), [])
      return live
    }

    /**
     * The header pair: 刷新 and 重启, same words as the caption bar.
     *
     * @param props - standard Session slot face; `sessionId` drives both hand-offs.
     */
    function HeaderActions(props) {
      const propsRef = React.useRef(props)
      propsRef.current = props

      const machineRef = React.useRef(null)
      if (machineRef.current === null) {
        machineRef.current = createRestartMachine(() => propsRef.current?.sessionId)
      }
      const machine = machineRef.current

      const caption = useCaptionLive()
      const [state, setState] = React.useState(machine.state)
      const [refreshing, setRefreshing] = React.useState(false)

      React.useEffect(() => machine.subscribe(setState), [])

      React.useEffect(() => () => machine.dispose(), [])

      React.useEffect(() => {
        const sessionId = props?.sessionId ?? null
        sessionTracker.current = sessionId
        return () => {
          if (sessionTracker.current === sessionId) sessionTracker.current = null
        }
      }, [props?.sessionId])

      // The caption entries are the primary seat; the header keeps only its
      // Session tracking once they are on screen.
      if (caption) return null

      const refresh = () => {
        if (refreshing) return
        setRefreshing(true)
        if (!refreshPage(() => propsRef.current?.sessionId)) {
          setRefreshing(false)
          return
        }
        // A blocked or cancelled reload must not leave a label that never resolves.
        setTimeout(() => setRefreshing(false), 5000)
      }

      const interrupting = workCount(state)
      const label = (() => {
        if (state.phase === 'arming') return interrupting > 0 ? `确认重启 · ${interrupting} 项进行中` : '确认重启'
        if (state.phase === 'running') return '重启中'
        if (state.phase === 'checking') return '检查中'
        if (state.phase === 'failed' && state.message) return state.message.length > 24 ? `${state.message.slice(0, 24)}…` : state.message
        if (state.phase === 'failed') return '重启失败'
        return '重启'
      })()

      const color = state.phase === 'arming' || state.phase === 'failed'
        ? COLOR_DANGER
        : state.phase === 'running'
          ? COLOR_OK
          : COLOR_MUTED

      const title = HEADER_TITLE(state, interrupting)

      return h(
        'span',
        {
          'data-dsh-quick-actions': '',
          style: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
        },
        h(
          'button',
          {
            type: 'button',
            onClick: refresh,
            title: REFRESH_TITLE,
            'aria-label': REFRESH_TITLE,
            'data-dsh-refresh-control': refreshing ? 'running' : 'idle',
            disabled: refreshing,
            style: {
              ...STYLE_BUTTON,
              color: COLOR_MUTED,
              cursor: refreshing ? 'default' : 'pointer',
              opacity: refreshing ? 0.7 : 1,
            },
          },
          refreshing ? '刷新中' : '刷新',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => machine.click(),
            title,
            'aria-label': title,
            'data-dsh-restart-control': state.phase,
            disabled: state.phase === 'running' || state.phase === 'checking',
            style: {
              ...STYLE_BUTTON,
              color,
              borderColor: state.phase === 'arming' || state.phase === 'failed' ? COLOR_BORDER : 'transparent',
              background: state.phase === 'arming' ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
              cursor: state.phase === 'running' || state.phase === 'checking' ? 'default' : 'pointer',
              opacity: state.phase === 'running' || state.phase === 'checking' ? 0.75 : 1,
            },
          },
          h('span', { style: { maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Surface 2: the Windows caption menubar.
     * ------------------------------------------------------------------ */

    /** The caption restart label; counts stay visible so a restart is never blind. */
    function captionLabel(state) {
      const interrupting = workCount(state)
      if (state.phase === 'arming') return interrupting > 0 ? `确认重启 · ${interrupting} 项` : '确认重启'
      if (state.phase === 'running') return '重启中'
      if (state.phase === 'checking') return '检查中'
      if (state.phase === 'failed') return '重启失败'
      return '重启'
    }

    function captionTitle(state) {
      const interrupting = workCount(state)
      if (state.phase === 'arming') {
        return interrupting > 0
          ? `再点一次确认：重启会中断 ${interrupting} 项进行中的任务（${ARM_WINDOW_MS / 1000} 秒内有效）`
          : `再点一次确认重启（${ARM_WINDOW_MS / 1000} 秒内有效）`
      }
      if (state.phase === 'running') return '正在重启 DeepSeek Harness'
      if (state.phase === 'checking') return '正在检查是否可以重启'
      if (state.phase === 'failed') return state.message ?? '重启不可用'
      return '重启 DeepSeek Harness'
    }

    function paintCaptionButton(button, state) {
      const danger = state.phase === 'arming' || state.phase === 'failed'
      button.textContent = captionLabel(state)
      button.title = captionTitle(state)
      button.setAttribute('aria-label', button.title)
      button.dataset.dshRestartPhase = state.phase
      button.style.color = danger ? COLOR_DANGER : ''
      button.style.background = state.phase === 'arming' ? 'color-mix(in srgb, currentColor 8%, transparent)' : ''
      button.style.opacity = state.phase === 'checking' || state.phase === 'running' ? '0.7' : ''
    }

    const REFRESH_LABELS = { idle: '刷新', running: '刷新中', failed: '刷新失败' }

    function paintCaptionRefresh(button, phase) {
      button.dataset.dshRefreshPhase = phase
      button.textContent = REFRESH_LABELS[phase] ?? REFRESH_LABELS.idle
      button.style.color = phase === 'failed' ? COLOR_DANGER : ''
      button.style.opacity = phase === 'running' ? '0.7' : ''
    }

    /**
     * The caption refresh button.
     *
     * One click, no arming: nothing server-side stops when the page reloads, so
     * the second click would only be ceremony. The label turns busy for the few
     * milliseconds before the reload and relaxes again if the reload never comes.
     */
    function createCaptionRefresh(getSessionId) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute(CAPTION_REFRESH_ATTRIBUTE, '')
      button.title = REFRESH_TITLE
      button.setAttribute('aria-label', REFRESH_TITLE)
      paintCaptionRefresh(button, 'idle')

      let relaxTimer = null
      button.addEventListener('click', () => {
        if (button.dataset.dshRefreshPhase === 'running') return
        paintCaptionRefresh(button, 'running')
        if (relaxTimer !== null) clearTimeout(relaxTimer)
        relaxTimer = setTimeout(() => {
          relaxTimer = null
          paintCaptionRefresh(button, 'idle')
        }, FAIL_HOLD_MS)
        if (refreshPage(getSessionId)) return
        paintCaptionRefresh(button, 'failed')
      })
      return button
    }

    /** The open shadow root the Desktop preload draws its caption menubar into, if any. */
    function findCaptionShadow() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      for (const host of document.querySelectorAll(`[${CAPTION_HOST_ATTRIBUTE}]`)) {
        const shadow = host.shadowRoot
        if (shadow !== null && shadow !== undefined) return shadow
      }
      return null
    }

    /**
     * Append 刷新 and 重启 to the caption menubar.
     *
     * The preload mounts that bar when the frame is ready, which may be before or
     * after this module runs, so a missing bar is waited for instead of treated
     * as failure. Only direct children of `body` are watched: the bar is mounted
     * there, and a subtree observer would walk the whole streaming conversation
     * on every mutation.
     *
     * @param getSessionId - resolves the open Session when an entry is used.
     * @returns disposer, or null when the page has no document at all.
     */
    function mountCaptionSurface(getSessionId) {
      if (typeof document === 'undefined') return null

      let group = null
      let refreshButton = null
      let button = null
      let machine = null
      let observer = null
      let disposed = false

      const attach = () => {
        if (disposed || group !== null) return
        const shadow = findCaptionShadow()
        if (shadow === null) return
        // A reloaded module may find the entries its previous generation left
        // behind; that generation is about to be disposed, so replace them
        // instead of adopting nodes whose owner still holds a reference.
        for (const stale of shadow.querySelectorAll(`[${CAPTION_GROUP_ATTRIBUTE}]`)) stale.remove()
        for (const stale of shadow.querySelectorAll(`[${CAPTION_BUTTON_ATTRIBUTE}], [${CAPTION_REFRESH_ATTRIBUTE}]`)) stale.remove()

        group = document.createElement('div')
        group.setAttribute(CAPTION_GROUP_ATTRIBUTE, '')
        // Matches the preload's own item rhythm: 2px between menu items, same
        // font, height and hover from the shadow stylesheet, one gap away from 编辑.
        group.style.display = 'flex'
        group.style.gap = '2px'
        group.style.marginLeft = '2px'

        refreshButton = createCaptionRefresh(getSessionId)

        button = document.createElement('button')
        button.type = 'button'
        button.setAttribute(CAPTION_BUTTON_ATTRIBUTE, '')
        button.style.cursor = 'default'

        machine = createRestartMachine(getSessionId)
        machine.subscribe((state) => paintCaptionButton(button, state))
        paintCaptionButton(button, machine.state)
        button.addEventListener('click', () => machine.click())

        group.append(refreshButton, button)
        shadow.appendChild(group)
        captionLive.set(true)
        observer?.disconnect()
        observer = null
      }

      attach()
      if (group === null && typeof document.body?.appendChild === 'function') {
        observer = new MutationObserver(attach)
        observer.observe(document.body, { childList: true })
      }

      return {
        dispose() {
          disposed = true
          observer?.disconnect()
          observer = null
          machine?.dispose()
          machine = null
          button = null
          refreshButton = null
          group?.remove()
          group = null
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Session hand-off.
     * ------------------------------------------------------------------ */

    /**
     * Reopen the Session the user was in before a restart or a refresh.
     *
     * Runs once per page load. The refresh marker is checked first because it is
     * the newest intent and costs nothing: it lives in localStorage, since a
     * reload keeps the origin. A restart marker lives on the Host (file), since
     * the port — and with it the origin — changes. Either way the marker is
     * short-lived and single-use; every failure path just leaves the user on the
     * home page, which is where a reload or restart lands anyway. `openSession`
     * is retried because the workspace and Session catalog mount after the first
     * client plugins do.
     *
     * @param ctx - client root context (services: uiWorkspace).
     */
    function restorePendingSession(ctx) {
      const MAX_ROUNDS = 20
      let finished = false

      const readRestartMarker = async () => {
        const response = await fetch('/api/dsh-restart/pending', { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const pending = await response.json()
        const sessionId = pending?.sessionId
        return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
      }

      const round = async (index) => {
        if (finished) return
        const retry = () => {
          if (index < MAX_ROUNDS) setTimeout(() => void round(index + 1), 700)
        }

        let sessionId = null
        let origin = 'restart'
        const refresh = readRefreshMarker()
        if (refresh !== null) {
          sessionId = refresh.sessionId
          origin = 'refresh'
        } else {
          try {
            sessionId = await readRestartMarker()
          } catch {
            retry()
            return
          }
          if (sessionId === null) return
        }

        const workspace = ctx.get('uiWorkspace')
        if (!workspace || typeof workspace.openSession !== 'function') {
          retry()
          return
        }
        try {
          workspace.openSession(sessionId)
        } catch {
          retry()
          return
        }
        finished = true
        if (origin === 'refresh') {
          clearRefreshMarker()
          return
        }
        // Consumed only after the navigation was accepted: a failed open leaves
        // the marker behind for the next load instead of eating it.
        fetch('/api/dsh-restart/pending/consume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
      }

      // Give the shell a moment to finish mounting panels before navigating.
      setTimeout(() => void round(0), 1200)
    }

    function apply(ctx) {
      const slots = ctx.slots
      const caption = mountCaptionSurface(() => sessionTracker.current)
      ctx.effect(() => () => caption?.dispose(), 'dsh-restart caption control')
      ctx.effect(
        () => slots.inject('conversation.session.header.utilities', () => slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-restart',
            order: 900,
            label: () => '刷新与重启',
          },
          HeaderActions,
        )),
        'dsh-restart header control',
      )
      restorePendingSession(ctx)
    }

    return { inject: ['slots'], apply }
  },
})
