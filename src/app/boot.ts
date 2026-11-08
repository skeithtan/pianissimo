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
import { flushSettings, setConnectionStatus, settingsLoading } from './state'
import { startThemeSync } from './theme'

export function startShell(): void {
  // Stored settings load in startServices(); until then settings are only defaults, so nothing
  // that waits for them (the theme sync) acts on them. setSettingsPersistence clears it.
  settingsLoading.value = true
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

  // No page zoom (U83): Safari's own pinch (iPhone, iPad, a Mac trackpad) would scale the whole
  // app; only the score zooms, through its own handlers. touch-action on the root (global.css)
  // covers other browsers and double-tap zoom.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false })

  void preloadView(currentView.value).catch(() => undefined)
  void startServices()
}
