/**
 * Light / dark / system theme. The choice lives in settings (`view.theme`) and is applied as the
 * `data-theme` attribute on the root element, which the design tokens in global.css react to.
 * "system" removes `data-theme` so `prefers-color-scheme` decides.
 */
import { effect } from '@preact/signals'
import { DEFAULT_SETTINGS, type ViewSettings } from '../core/model/settings'
import { settings, settingsLoading } from './state'

const CACHE_KEY = 'pianissimo.theme'

export function applyTheme(theme: ViewSettings['theme'], root: HTMLElement = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** Score paper follows the theme unless pinned light (`data-score-paper`, see global.css). */
export function applyScorePaper(paper: ViewSettings['scorePaper'], root: HTMLElement = document.documentElement): void {
  if (paper === 'light') root.setAttribute('data-score-paper', 'light')
  else root.removeAttribute('data-score-paper')
}

function readCachedTheme(): ViewSettings['theme'] | null {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : null
  } catch {
    return null
  }
}

function cacheTheme(theme: ViewSettings['theme']): void {
  try {
    localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // Private windows and blocked storage: the setting itself still persists through storage.
  }
}

/**
 * Keep the root's `data-theme` in step with settings. The last theme is cached in localStorage (a per-device convenience) so the first paint is already right while
 * settings load from IndexedDB. Returns a stop function.
 */
export function startThemeSync(root: HTMLElement = document.documentElement): () => void {
  const cached = readCachedTheme()
  if (cached) applyTheme(cached, root)
  // Started before the settings load began (boot order): the untouched defaults are not the
  // user's choice, so the first run keeps the cached theme instead of overwriting it.
  let skipDefaults = cached !== null && settings.peek() === DEFAULT_SETTINGS
  return effect(() => {
    const current = settings.value
    const { theme, scorePaper } = current.view
    // Until stored settings arrive these are only defaults; keep the cached theme on screen.
    if (settingsLoading.value) return
    const skip = skipDefaults && current === DEFAULT_SETTINGS
    skipDefaults = false
    if (skip) return
    applyTheme(theme, root)
    applyScorePaper(scorePaper, root)
    cacheTheme(theme)
  })
}
