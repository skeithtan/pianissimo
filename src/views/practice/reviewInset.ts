/**
 * The strip's review keeps the overlays clear of the score (DECISIONS U97): the height from the
 * strip's bottom edge to the top of the result dock, and from the strip's top edge to the bottom of
 * the top overlay column (the Repeat panel and banners), each plus a small gap, are handed to the
 * score view (`StripHandle.setReviewInset`) whenever one of them changes size (the card appears,
 * gains a note line, leaves; a banner comes or goes; the strip itself grows or shrinks). They are
 * measured against the strip's own root, which starts lower than the stage while the timing-cue row
 * is on: the overlay column moves down with it, so a move without a resize changes nothing. A view
 * created later is measured and observed again (`attach`).
 */
import type { RefObject } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type { StripHandle } from './env'

/** Space kept between an overlay and the reviewed staves (px). */
export const REVIEW_CARD_GAP = 8

/** Screen px the review keeps free under the score for the dock, 0 without a card. */
export function reviewInsetFor(stripBottom: number, dockTop: number, dockHeight: number): number {
  if (!(dockHeight > 0)) return 0
  return Math.max(0, Math.round(stripBottom - dockTop + REVIEW_CARD_GAP))
}

/** Screen px the review keeps free above the score for the top overlays, 0 without any. */
export function reviewTopFor(stripTop: number, overlayBottom: number, overlayHeight: number): number {
  if (!(overlayHeight > 0)) return 0
  return Math.max(0, Math.round(overlayBottom - stripTop + REVIEW_CARD_GAP))
}

export interface ReviewInsets {
  bottom: number
  top: number
}

/** The score view's root (`render/strip`, `render/page`) inside the stage's strip host. */
const VIEW_ROOT = '[data-testid="strip-host"] .pn-strip'

/** The rectangle the review frame is fitted in: the score view's root, else the stage. */
export function reviewFrame(stage: Element): DOMRect {
  return (stage.querySelector(VIEW_ROOT) ?? stage).getBoundingClientRect()
}

export interface ReviewInsetHandle extends RefObject<ReviewInsets> {
  /** A score view was mounted: measure against its root (and follow its size) from now on. */
  attach(): void
}

export function useReviewInset(
  dock: RefObject<HTMLElement | null>,
  overlays: RefObject<HTMLElement | null>,
  strip: RefObject<StripHandle | null>,
  /** The score view: `page` keeps the result in a row of its own (nothing measured). */
  layout?: string,
): ReviewInsetHandle {
  const handle = useRef<ReviewInsetHandle | null>(null)
  const attach = useRef<() => void>(() => undefined)
  handle.current ??= {
    current: { bottom: 0, top: 0 },
    attach: () => attach.current(),
  }
  const insets = handle.current
  useEffect(() => {
    const el = dock.current
    const over = overlays.current
    // The page has a row of its own for the result and does not zoom: nothing to keep free.
    if (layout === 'page') insets.current = { bottom: 0, top: 0 }
    if (!el || layout === 'page' || typeof ResizeObserver === 'undefined') {
      attach.current = () => strip.current?.setReviewInset?.(insets.current.bottom, insets.current.top)
      return
    }
    const measure = (force = false) => {
      const stage = el.parentElement
      if (!stage) return
      const s = reviewFrame(stage)
      const d = el.getBoundingClientRect()
      const o = over?.getBoundingClientRect()
      const bottom = reviewInsetFor(s.bottom, d.top, d.height)
      const top = o ? reviewTopFor(s.top, o.bottom, o.height) : 0
      const now = insets.current
      if (!force && bottom === now.bottom && top === now.top) return
      insets.current = { bottom, top }
      strip.current?.setReviewInset?.(bottom, top)
    }
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    if (over) observer.observe(over)
    let root: Element | null = null
    attach.current = () => {
      const next = el.parentElement?.querySelector(VIEW_ROOT) ?? null
      if (next !== root) {
        if (root) observer.unobserve(root)
        root = next
        if (root) observer.observe(root)
      }
      measure(true)
    }
    attach.current()
    return () => {
      observer.disconnect()
      attach.current = () => undefined
    }
  }, [dock, overlays, strip, layout])
  return insets
}
