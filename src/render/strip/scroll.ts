/**
 * Pure strip geometry (spec "Practice screen"): musical position → x, x → measure, and the
 * scroll transform that keeps the cursor fixed one third across the viewport, including the
 * first and final notes. Empty space at the ends lets the music pass beneath the same anchor.
 */
import type { OccurrenceGeometry, PreparedLayout } from '../types'

/** Index of the occurrence containing performance position `pos` (whole notes, float). */
export function occAtPosition(
  occurrences: readonly Pick<OccurrenceGeometry, 'start' | 'duration'>[],
  pos: number,
): number {
  let lo = 0
  let hi = occurrences.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (occurrences[mid]!.start <= pos + 1e-9) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** x of a performance position, interpolated between onset anchors of its measure. */
export function positionToX(occurrences: readonly OccurrenceGeometry[], pos: number): number {
  const i = occAtPosition(occurrences, pos)
  const o = occurrences[i]
  if (!o) return 0
  const offset = Math.min(Math.max(pos - o.start, 0), o.duration)
  const a = o.anchors
  for (let k = 1; k < a.length; k++) {
    const [p1, x1] = a[k]!
    if (offset <= p1 + 1e-9) {
      const [p0, x0] = a[k - 1]!
      return p1 - p0 < 1e-12 ? x0 : x0 + ((offset - p0) / (p1 - p0)) * (x1 - x0)
    }
  }
  return o.x1
}

/** Occurrence whose barline range contains layout x (clamped to the first/last measure). */
export function occAtX(occurrences: readonly Pick<OccurrenceGeometry, 'x0' | 'x1'>[], x: number): number {
  let lo = 0
  let hi = occurrences.length - 1
  if (hi < 0) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (occurrences[mid]!.x0 <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface ScrollInput {
  /** Cursor x in layout px. */
  readonly cursorX: number
  readonly contentWidth: number
  readonly viewportWidth: number
  readonly scale: number
  /** Fraction of the viewport where the cursor rests (≈ 1/3). */
  readonly anchor?: number
}

/** Horizontal translate (screen px) placing every position at the same screen anchor. */
export function scrollTranslate(s: ScrollInput): number {
  return s.viewportWidth * (s.anchor ?? 1 / 3) - s.cursorX * s.scale
}

/** Free browsing can bring either end of the score under the fixed cursor. */
export function clampTranslate(
  tx: number,
  contentWidth: number,
  viewportWidth: number,
  scale: number,
  anchor = 1 / 3,
): number {
  const screenAnchor = viewportWidth * anchor
  return Math.min(screenAnchor, Math.max(screenAnchor - contentWidth * scale, tx))
}

/**
 * Vertical translate: center the content when it fits, otherwise center the staves and clamp so
 * the strip never shows past the content's top or bottom.
 */
export function verticalTranslate(
  layout: Pick<PreparedLayout, 'top' | 'height' | 'staves'>,
  viewportHeight: number,
  scale: number,
): number {
  const h = layout.height * scale
  if (h <= viewportHeight) return (viewportHeight - h) / 2
  const first = layout.staves[0]
  const last = layout.staves[layout.staves.length - 1]
  const mid = first && last ? ((first.top + last.bottom) / 2 - layout.top) * scale : h / 2
  return Math.min(0, Math.max(viewportHeight - h, viewportHeight / 2 - mid))
}

/** Translate after a zoom change that keeps layout x `anchorX` at the same screen x. */
export function zoomAround(tx: number, oldScale: number, newScale: number, anchorX: number): number {
  const screen = tx + anchorX * oldScale
  return screen - anchorX * newScale
}

/** Visible layout x range for a translate/scale. */
export function visibleRange(tx: number, scale: number, viewportWidth: number): { x0: number; x1: number } {
  return { x0: -tx / scale, x1: (viewportWidth - tx) / scale }
}
