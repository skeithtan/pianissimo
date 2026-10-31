/**
 * Renders the current view from the registry, loading lazily imported views on demand. Loaded
 * components are cached for the life of the page. A slow load shows a quiet status after a short
 * delay (no flash for fast loads); a failed load (offline, or a stale chunk after a deploy)
 * offers a retry instead of a blank screen.
 */
import type { ComponentType } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Button } from '../ui/controls'
import { screenEntry, type ScreenName } from './views'
import styles from './LazyView.module.css'

const loaded = new Map<ScreenName, ComponentType>()
const pending = new Map<ScreenName, Promise<ComponentType>>()

/** The component for a view if it is already available without loading. */
function ready(name: ScreenName): ComponentType | null {
  return screenEntry(name).component ?? loaded.get(name) ?? null
}

/** Start loading a view's code (call when the learner is likely to go there next). */
export function preloadView(name: ScreenName): Promise<ComponentType> {
  const available = ready(name)
  if (available) return Promise.resolve(available)
  const existing = pending.get(name)
  if (existing) return existing
  const load = screenEntry(name).load
  if (!load) return Promise.reject(new Error(`View ${name} has no component`))
  const promise = load().then(
    (module) => {
      loaded.set(name, module.default)
      pending.delete(name)
      return module.default
    },
    (error: unknown) => {
      pending.delete(name)
      throw error
    },
  )
  pending.set(name, promise)
  return promise
}

/** Forget cached views. Tests only. */
export function resetViewCacheForTests(): void {
  loaded.clear()
  pending.clear()
}

export function LazyView({ name }: { name: ScreenName }) {
  const [, rerender] = useState(0)
  const [failed, setFailed] = useState<{ name: ScreenName; attempt: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  const Component = ready(name)

  useEffect(() => {
    if (ready(name)) {
      // The chunk finished loading (the boot preload of a deep-linked view) after this render
      // saw it missing but before this effect ran: render again, or the view stays blank.
      if (!Component) rerender((n) => n + 1)
      return
    }
    let live = true
    setSlow(false)
    const timer = setTimeout(() => live && setSlow(true), 250)
    preloadView(name).then(
      () => live && rerender((n) => n + 1),
      () => live && setFailed({ name, attempt }),
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [name, attempt])

  if (Component) return <Component />
  if (failed && failed.name === name && failed.attempt === attempt) {
    return (
      <div class={styles.status} role="alert">
        <p>This screen could not be loaded. Check your connection and try again.</p>
        <Button
          onClick={() => {
            setFailed(null)
            setAttempt((n) => n + 1)
          }}
        >
          Try again
        </Button>
      </div>
    )
  }
  return slow ? (
    <div class={styles.status} role="status">
      Loading…
    </div>
  ) : null
}
