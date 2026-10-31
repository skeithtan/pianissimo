/**
 * Fade-out-then-unmount utilities (spec "Mistake feedback and hints": things that disappear fade
 * through opacity instead of vanishing). The element stays mounted while its opacity transitions
 * to 0 and is removed afterwards; turning `visible` back on mid-fade cancels the removal and the
 * opacity returns from wherever it had reached.
 */
import type { ComponentChildren, CSSProperties } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { fadeDuration, HINT_FADE_MS } from './motion'

export type FadePhase = 'hidden' | 'entering' | 'visible' | 'leaving'

export interface FadePresence {
  /** Render the element only while true. */
  readonly mounted: boolean
  readonly phase: FadePhase
  /** Inline style implementing the fade; spread it onto the element. */
  readonly style: CSSProperties
}

/**
 * Keep an element mounted for `ms` after `visible` turns false so it can fade out. A newly
 * shown element renders at opacity 0 for one frame and then fades in. Reduced motion shortens
 * the fade but keeps it.
 */
export function useFadePresence(visible: boolean, ms: number = HINT_FADE_MS): FadePresence {
  const duration = fadeDuration(ms)
  const [phase, setPhase] = useState<FadePhase>(visible ? 'visible' : 'hidden')

  useEffect(() => {
    if (visible) {
      setPhase((p) => (p === 'hidden' ? 'entering' : p === 'leaving' ? 'visible' : p))
      return
    }
    setPhase((p) => (p === 'hidden' ? p : 'leaving'))
    const timer = setTimeout(() => setPhase((p) => (p === 'leaving' ? 'hidden' : p)), duration)
    return () => clearTimeout(timer)
  }, [visible, duration])

  useEffect(() => {
    if (phase !== 'entering') return
    const frame = requestAnimationFrame(() => setPhase('visible'))
    return () => cancelAnimationFrame(frame)
  }, [phase])

  return {
    mounted: phase !== 'hidden',
    phase,
    style: {
      opacity: phase === 'visible' ? 1 : 0,
      transition: `opacity ${duration}ms var(--ease-standard, ease)`,
      ...(phase === 'leaving' ? { pointerEvents: 'none' } : {}),
    },
  }
}

/** Wrapper that fades its children in and out as `show` changes. */
export function Fade({
  show,
  ms = HINT_FADE_MS,
  children,
  class: className,
}: {
  show: boolean
  ms?: number
  children: ComponentChildren
  class?: string | undefined
}) {
  const { mounted, style } = useFadePresence(show, ms)
  if (!mounted) return null
  return (
    <div class={className} style={style}>
      {children}
    </div>
  )
}

export interface FadeListEntry<T> {
  readonly item: T
  /** True while the item has left the source list and is fading out. */
  readonly leaving: boolean
}

/**
 * `useFadePresence` for a keyed list (toasts). Items that disappear from `items` stay in the
 * returned list, flagged `leaving`, for `ms`, so the caller can render them fading out.
 */
export function useFadeList<T extends { readonly id: number | string }>(
  items: readonly T[],
  ms: number = HINT_FADE_MS,
): readonly FadeListEntry<T>[] {
  const duration = fadeDuration(ms)
  const [leaving, setLeaving] = useState<readonly T[]>([])
  const previous = useRef<readonly T[]>(items)

  useEffect(() => {
    const present = new Set(items.map((i) => i.id))
    const gone = previous.current.filter((i) => !present.has(i.id))
    previous.current = items
    if (gone.length === 0) return
    setLeaving((l) => [...l.filter((i) => !present.has(i.id)), ...gone])
    const ids = new Set(gone.map((i) => i.id))
    // Not canceled on re-run: each batch of departures owns its own removal timer.
    setTimeout(() => setLeaving((l) => l.filter((i) => !ids.has(i.id))), duration)
  }, [items, duration])

  const live = new Set(items.map((i) => i.id))
  return [
    ...items.map((item) => ({ item, leaving: false })),
    ...leaving.filter((i) => !live.has(i.id)).map((item) => ({ item, leaving: true })),
  ]
}
