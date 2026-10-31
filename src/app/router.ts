/**
 * Two-way sync between the navigation signals (the source of truth for what is on screen) and
 * the URL hash (`routes.ts`). Started once by `boot.ts`.
 *
 * - **URL → signals** on `popstate` / `hashchange`: Back, Forward, a typed hash, a link.
 * - **Signals → URL** after any navigation signal changes, coalesced per microtask so that, for
 *   example, `closeSettings(); openConnection()` is one overlay swap rather than two steps.
 *
 * History rules (so Back does what people expect):
 * - Showing another page pushes an entry.
 * - Opening an overlay pushes an entry (marked `overlayFrom`); closing it goes back, so Back,
 *   Escape and ✕ all leave the history in the same place (Forward would reopen the overlay).
 * - Swapping one overlay for another, closing an overlay that came from a deep link or reload,
 *   and changing a Practice preset in place rewrite the current entry instead.
 * - `history.back()` is asynchronous. While it is pending nothing else is written; when its
 *   `popstate` arrives the signals (which may have moved on) are written to the URL again.
 */
import { batch, effect } from '@preact/signals'
import {
  connectionOpen,
  currentView,
  practiceRequest,
  resultsRequest,
  settingsOpen,
  type PracticePreset,
} from './navigation'
import {
  formatHash,
  parseHash,
  readHistoryState,
  sameBase,
  samePreset,
  sameRoute,
  type HistoryState,
  type Route,
} from './routes'

/** The slice of `window` the router uses (tests pass a fake). */
export interface RouterWindow {
  readonly location: { readonly hash: string }
  readonly history: {
    readonly state: unknown
    pushState(state: unknown, unused: string, url: string): void
    replaceState(state: unknown, unused: string, url: string): void
    back(): void
  }
  addEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
  removeEventListener(type: 'popstate' | 'hashchange', listener: () => void): void
}

/** How long to wait for the `popstate` of our own `history.back()` before writing anyway. */
const BACK_TIMEOUT_MS = 1000

/** The route the navigation signals describe right now. */
export function routeFromSignals(): Route {
  const overlay = connectionOpen.value ? 'connection' : settingsOpen.value ? 'settings' : null
  switch (currentView.value) {
    case 'practice': {
      const request = practiceRequest.value
      return request ? { view: 'practice', pieceId: request.pieceId, overlay } : { view: 'practice', overlay }
    }
    case 'results': {
      const request = resultsRequest.value
      if (!request) return { view: 'results', overlay }
      return request.attemptId
        ? { view: 'results', pieceId: request.pieceId, attemptId: request.attemptId, overlay }
        : { view: 'results', pieceId: request.pieceId, overlay }
    }
    case 'library':
      return { view: 'library', overlay }
  }
}

function presetFromSignals(): PracticePreset | undefined {
  return currentView.value === 'practice' ? practiceRequest.value?.preset : undefined
}

function stateFor(preset: PracticePreset | undefined, overlayFrom: boolean): HistoryState {
  return { ...(preset ? { preset } : {}), ...(overlayFrom ? { overlayFrom: true } : {}) }
}

/** Make the signals describe `route` (and `preset`) without touching anything that already matches. */
export function applyRoute(route: Route, preset: PracticePreset | undefined): void {
  batch(() => {
    currentView.value = route.view
    if (route.view === 'practice') {
      const current = practiceRequest.peek()
      if (!route.pieceId) {
        if (current) practiceRequest.value = null
      } else if (!current || current.pieceId !== route.pieceId || !samePreset(current.preset, preset)) {
        practiceRequest.value = { pieceId: route.pieceId, ...(preset ? { preset } : {}) }
      }
    } else if (route.view === 'results') {
      const current = resultsRequest.peek()
      if (!route.pieceId) {
        if (current) resultsRequest.value = null
      } else if (!current || current.pieceId !== route.pieceId || current.attemptId !== route.attemptId) {
        resultsRequest.value = { pieceId: route.pieceId, ...(route.attemptId ? { attemptId: route.attemptId } : {}) }
      }
    }
    settingsOpen.value = route.overlay === 'settings'
    connectionOpen.value = route.overlay === 'connection'
  })
}

/**
 * Start mirroring navigation to the URL. Reads the current URL first, so the first render shows
 * what a reload or deep link asked for. Returns a stop function.
 */
export function startRouter(win: RouterWindow = window): () => void {
  let stopped = false
  let scheduled = false
  let awaitingBack = false
  /** Our `back()` never arrived: rewrite the overlay's entry instead of asking again. */
  let backFailed = false
  let backTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The hash `popstate` / `hashchange` last handled or we wrote. Browsers fire both events for
   * one fragment traversal; the second must not re-apply a URL the app has already moved past.
   */
  let seenHash = win.location.hash

  const push = (route: Route, state: HistoryState): void => {
    try {
      win.history.pushState(state, '', formatHash(route))
      seenHash = win.location.hash
    } catch {
      // Browsers cap history writes (Safari: SecurityError). The app keeps working; the URL lags.
    }
  }
  const replace = (route: Route, state: HistoryState): void => {
    try {
      win.history.replaceState(state, '', formatHash(route))
      seenHash = win.location.hash
    } catch {
      // See push.
    }
  }

  const fromUrl = (): void => {
    applyRoute(parseHash(win.location.hash), readHistoryState(win.history.state).preset)
  }

  const toUrl = (): void => {
    if (stopped || awaitingBack) return
    const next = routeFromSignals()
    const preset = presetFromSignals()
    const prev = parseHash(win.location.hash)
    const prevState = readHistoryState(win.history.state)

    if (sameRoute(prev, next)) {
      if (next.view === 'practice' && !samePreset(prevState.preset, preset)) {
        replace(next, stateFor(preset, prevState.overlayFrom === true))
      }
      return
    }
    if (sameBase(prev, next)) {
      if (!prev.overlay) {
        push(next, stateFor(preset, true))
      } else if (!next.overlay && prevState.overlayFrom && !backFailed) {
        awaitingBack = true
        backTimer = setTimeout(() => {
          awaitingBack = false
          backFailed = true
          schedule()
        }, BACK_TIMEOUT_MS)
        win.history.back()
      } else {
        // Closing a deep-linked overlay, or swapping one overlay for another.
        replace(next, stateFor(preset, next.overlay !== null && prevState.overlayFrom === true))
      }
      return
    }
    // Another page. If an overlay was open on top of the old page, it gives up its entry.
    if (prev.overlay && prevState.overlayFrom) replace(next, stateFor(preset, false))
    else push(next, stateFor(preset, false))
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      toUrl()
      backFailed = false
    })
  }

  const onUrlChange = (event: 'popstate' | 'hashchange'): void => {
    if (stopped) return
    if (event === 'hashchange' && win.location.hash === seenHash) return
    seenHash = win.location.hash
    if (awaitingBack) {
      // Our own back(): the URL is now the base page; let the signals (which win) catch up.
      awaitingBack = false
      clearTimeout(backTimer)
      schedule()
      return
    }
    fromUrl()
  }

  fromUrl()
  // Rewrite a hand-typed or aliased hash (`#/connection`, `#/nonsense`) to its canonical form.
  const initial = parseHash(win.location.hash)
  if (win.location.hash !== '' && win.location.hash !== formatHash(initial)) {
    try {
      win.history.replaceState(win.history.state, '', formatHash(initial))
      seenHash = win.location.hash
    } catch {
      // See push.
    }
  }

  const onPopState = (): void => onUrlChange('popstate')
  const onHashChange = (): void => onUrlChange('hashchange')
  win.addEventListener('popstate', onPopState)
  win.addEventListener('hashchange', onHashChange)
  const stopEffect = effect(() => {
    routeFromSignals()
    presetFromSignals()
    schedule()
  })

  return () => {
    stopped = true
    clearTimeout(backTimer)
    stopEffect()
    win.removeEventListener('popstate', onPopState)
    win.removeEventListener('hashchange', onHashChange)
  }
}
