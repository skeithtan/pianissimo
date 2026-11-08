/**
 * App shell: renders the current view from the registry (`views.ts`), the compact app bar for
 * non-practice views, the toast area and the two overlays, Settings and the Connection setup
 * modal. Overlays sit on top of the mounted view, so the selected score and passage are never
 * lost. The URL follows all of this (`router.ts`).
 */
import { useEffect, useRef } from 'preact/hooks'
import { ConnectionModal } from '../views/connection/ConnectionModal'
import { SettingsOverlay } from '../views/settings/SettingsOverlay'
import { AppBar } from './AppBar'
import { CapabilityBanner } from './CapabilityBanner'
import { getFeatures, type FeatureReport } from './features'
import { LazyView } from './LazyView'
import { currentView } from './navigation'
import { NoticeArea } from './NoticeArea'
import { views } from './views'
import { wakeLock } from './wakeLock'
import styles from './App.module.css'

export function App({ features = getFeatures() }: { features?: FeatureReport }) {
  const view = currentView.value
  const entry = views[view]
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)

  // A piano never touches the screen, so keep it awake while practicing, or while a piece plays
  // on a phone propped on the music stand (Study, U72).
  useEffect(() => {
    if (view !== 'practice' && view !== 'study') return
    const owner = `view:${view}`
    wakeLock.hold(owner)
    return () => wakeLock.drop(owner)
  }, [view])

  // The tab title (and the browser's Back-button history list) names the page.
  useEffect(() => {
    document.title = view === 'library' ? 'Pianissimo' : `${entry.title} · Pianissimo`
  }, [view, entry.title])

  // After navigating, move focus to the new view so keyboard and screen-reader users start there.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    main.current?.focus({ preventScroll: true })
  }, [view])

  return (
    <div class={styles.shell}>
      {entry.chrome === 'bar' ? <AppBar /> : null}
      {view === 'library' ? <CapabilityBanner report={features} /> : null}
      <main
        ref={main}
        class={styles.main}
        data-chrome={entry.chrome}
        data-view={view}
        tabIndex={-1}
        aria-label={entry.title}
      >
        <LazyView name={view} />
      </main>
      <NoticeArea />
      <SettingsOverlay features={features} />
      <ConnectionModal />
    </div>
  )
}
