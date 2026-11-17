/**
 * The strip's review keeps the overlays clear of the score (DECISIONS U97): the height from the
 * stage's bottom edge to the top of the result dock, and from the stage's top edge to the bottom
 * of the top overlay column (the Repeat panel and banners), each plus a small gap, are handed to
 * the score view (`StripHandle.setReviewInset`) whenever either changes size (the card appears,
 * gains a note line, leaves; a banner comes or goes). A view created later gets the last values.
 */
import type { RefObject } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { StripHandle } from './env'

/** Space kept between an overlay and the reviewed staves (px). */
export const REVIEW_CARD_GAP = 8

/** Screen px the review keeps free under the score for the dock, 0 without a card. */
export function reviewInsetFor(stageBottom: number, dockTop: number, dockHeight: number): number {
  if (!(dockHeight > 0)) return 0
  return Math.max(0, Math.round(stageBottom - dockTop + REVIEW_CARD_GAP))
}

/** Screen px the review keeps free above the score for the top overlays, 0 without any. */
export function reviewTopFor(stageTop: number, overlayBottom: number, overlayHeight: number): number {
  if (!(overlayHeight > 0)) return 0
  return Math.max(0, Math.round(overlayBottom - stageTop + REVIEW_CARD_GAP))
}

export interface ReviewInsets {
  bottom: number
  top: number
}

export function useReviewInset(
  dock: RefObject<HTMLElement | null>,
  overlays: RefObject<HTMLElement | null>,
  strip: RefObject<StripHandle | null>,
  /** The score view: `page` keeps the result in a row of its own (nothing measured). */
  layout?: string,
): RefObject<ReviewInsets> {
  const insets = useRef<ReviewInsets>({ bottom: 0, top: 0 })
  useEffect(() => {
    const el = dock.current
    const over = overlays.current
    // The page has a row of its own for the result and does not zoom: nothing to keep free.
    if (layout === 'page') insets.current = { bottom: 0, top: 0 }
    if (!el || layout === 'page' || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const stage = el.parentElement
      if (!stage) return
      const s = stage.getBoundingClientRect()
      const d = el.getBoundingClientRect()
      const o = over?.getBoundingClientRect()
      const bottom = reviewInsetFor(s.bottom, d.top, d.height)
      const top = o ? reviewTopFor(s.top, o.bottom, o.height) : 0
      const now = insets.current
      if (bottom === now.bottom && top === now.top) return
      insets.current = { bottom, top }
      strip.current?.setReviewInset?.(bottom, top)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (over) observer.observe(over)
    measure()
    return () => observer.disconnect()
  }, [dock, overlays, strip, layout])
  return insets
}
