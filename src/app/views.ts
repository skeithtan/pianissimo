/**
 * The view registry: the single place that says which component renders each main view. Replace
 * a placeholder by editing its entry only.
 *
 * - `component`: bundled with the shell. Use it for the Library, the first screen.
 * - `load`: a dynamic import, fetched on first use (and by `preloadView`). Use it for heavy
 *   views (Practice pulls in the engine, renderer and keyboard guide) so the library shell stays
 *   inside its 150 kB gzip budget.
 * - `chrome`: `'bar'` shows the app bar and the page scrolls inside `<main>`; `'none'` gives the
 *   view the whole viewport (Practice draws its own header and footer).
 *
 * The piano setup is not a page: it is part of Settings → Piano and sound, so it has an entry in
 * `overlayScreens` (lazy, like the heavy views) and no `ViewName`.
 */
import type { ComponentType } from 'preact'
import type { ViewName } from './navigation'
import { LibraryView } from '../views/library/LibraryView'

export type ViewChrome = 'bar' | 'none'

interface ViewBase {
  readonly title: string
  readonly chrome: ViewChrome
}

export type ViewEntry =
  | (ViewBase & { readonly component: ComponentType; readonly load?: undefined })
  | (ViewBase & { readonly load: () => Promise<{ default: ComponentType }>; readonly component?: undefined })

export const views: Readonly<Record<ViewName, ViewEntry>> = {
  library: {
    title: 'Library',
    chrome: 'bar',
    component: LibraryView,
  },
  practice: {
    title: 'Practice',
    chrome: 'none',
    load: () => import('../views/practice/PracticeView').then((m) => ({ default: m.PracticeView })),
  },
}

/** Lazy screens shown inside Settings instead of replacing the current view. */
export type OverlayScreenName = 'connection'

/** Everything `LazyView` can render. */
export type ScreenName = ViewName | OverlayScreenName

export const overlayScreens: Readonly<Record<OverlayScreenName, ViewEntry>> = {
  connection: {
    title: 'Piano and sound',
    chrome: 'none',
    load: () => import('../views/connection/ConnectionView').then((m) => ({ default: m.ConnectionView })),
  },
}

export function screenEntry(name: ScreenName): ViewEntry {
  return name === 'connection' ? overlayScreens.connection : views[name]
}
