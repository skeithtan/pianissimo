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
 * The Connection setup is not a page: it is a modal over whichever view is current, so it has an
 * entry in `overlayScreens` (lazy, like the heavy views) and no `ViewName`.
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
  results: {
    title: 'Results',
    chrome: 'bar',
    load: () => import('../views/results/ResultsView').then((m) => ({ default: m.ResultsView })),
  },
}

/** Screens shown in a modal over the current view instead of replacing it. */
export type OverlayScreenName = 'connection'

/** Everything `LazyView` can render. */
export type ScreenName = ViewName | OverlayScreenName

export const overlayScreens: Readonly<Record<OverlayScreenName, ViewEntry>> = {
  connection: {
    title: 'Connection and Pedal Setup',
    chrome: 'none',
    load: () => import('../views/connection/ConnectionView').then((m) => ({ default: m.ConnectionView })),
  },
}

export function screenEntry(name: ScreenName): ViewEntry {
  return name === 'connection' ? overlayScreens.connection : views[name]
}
