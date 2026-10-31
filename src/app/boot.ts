/**
 * Start-up wiring that has no UI of its own: the URL router (so the first render already shows
 * the deep-linked page), theme, initial MIDI status from feature detection,
 * settings flush when the page is hidden, loading the first view's code, then the services:
 * settings from storage (memory fallback) and silent reconnection of a remembered MIDI route
 * when the browser already granted access.
 */
import { getFeatures } from './features'
import { preloadView } from './LazyView'
import { currentView } from './navigation'
import { startRouter } from './router'
import { startServices } from './services'
import { flushSettings, setConnectionStatus } from './state'
import { startThemeSync } from './theme'

export function startShell(): void {
  startRouter()
  startThemeSync()

  const midi = getFeatures().features.webMidi
  setConnectionStatus(
    midi.supported
      ? { state: 'disconnected' }
      : { state: 'unsupported', ...(midi.explanation ? { detail: midi.explanation } : {}) },
  )

  // Settings are debounced; write them before the page goes away or into the background.
  addEventListener('pagehide', () => void flushSettings())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSettings()
  })

  void preloadView(currentView.value).catch(() => undefined)
  void startServices()
}
