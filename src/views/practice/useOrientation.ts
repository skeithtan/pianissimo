/**
 * Screen orientation for the practice score (DECISIONS "Portrait page mode"): portrait shows the
 * page view (systems, moving cursor), landscape the strip. Any device; `matchMedia` decides.
 */
import type { RefObject } from 'preact'
import { useEffect, useLayoutEffect, useState } from 'preact/hooks'

export type Orientation = 'portrait' | 'landscape'

const query = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(orientation: portrait)') : null

export function useOrientation(): Orientation {
  const [portrait, setPortrait] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const mq = query()
    if (!mq) return undefined
    const update = () => setPortrait(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return portrait ? 'portrait' : 'landscape'
}

/**
 * The element's width in CSS px, 0 until it is first measured (then the window width when the
 * element has no layout, as in tests). Updates on resize.
 */
export function useStageWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => setWidth(Math.round(el.clientWidth) || window.innerWidth || 820)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}
