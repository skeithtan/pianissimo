/**
 * The strip's review frame after a completed Repeat pass (DECISIONS U97): the zoom and translate
 * that show the whole passage, or as much of it as the strip's minimum zoom allows, starting from
 * its first bar. Pure geometry: StripView blends between this frame and the playing frame.
 */

/** Screen px kept free at each side of the passage. */
export const REVIEW_MARGIN = 24

export interface ReviewInput {
  /** Passage start and end, layout px. */
  readonly x0: number
  readonly x1: number
  readonly viewportWidth: number
  /** The strip's height minus what the result card keeps for itself at the bottom (screen px). */
  readonly viewportHeight: number
  /** Staves plus their fit margins (layout px): both staves always stay in view. */
  readonly staffSpan: number
  /** Layout px the fixed clef / key / meter (and their fade) cover at the left edge. */
  readonly leftReserve: number
  /** The zoom while playing: the review never zooms in past it. */
  readonly playScale: number
  /** The lowest zoom the review goes to (legibility of the notation and the teacher's marks). */
  readonly minScale: number
  readonly margin?: number
}

export interface ReviewFrame {
  readonly scale: number
  /** Horizontal translate (screen px) of the content. */
  readonly tx: number
  /** Whether the whole passage is on screen. */
  readonly fits: boolean
}

/**
 * The largest zoom, at most the playing zoom, at which the passage fits between the fixed
 * signatures and the right edge (and both staves fit the height left above the card), never below
 * `minScale` unless the playing zoom already is. A passage that fits is centered in that room;
 * one that does not starts at its left edge.
 */
export function reviewFrame(i: ReviewInput): ReviewFrame {
  const margin = i.margin ?? REVIEW_MARGIN
  const width = Math.max(1, i.x1 - i.x0)
  const room = Math.max(1, i.viewportWidth - 2 * margin)
  const horizontal = room / (i.leftReserve + width)
  const vertical = i.viewportHeight > 0 && i.staffSpan > 0 ? i.viewportHeight / i.staffSpan : Infinity
  const floor = Math.min(i.minScale, i.playScale)
  const scale = Math.max(floor, Math.min(i.playScale, horizontal, vertical))
  const left = margin + i.leftReserve * scale
  const right = i.viewportWidth - margin
  const fits = left + width * scale <= right + 0.5
  const tx = fits ? (left + right) / 2 - ((i.x0 + i.x1) / 2) * scale : left - i.x0 * scale
  return { scale, tx, fits }
}

/**
 * Keeps a panned review in reach: the first cursor stop (`firstX`, layout px: nothing before the
 * opening clefs' end is browsed, U96) or the content's right edge can come to the middle, no farther.
 */
export function clampReviewTranslate(
  tx: number,
  firstX: number,
  contentWidth: number,
  viewportWidth: number,
  scale: number,
): number {
  const mid = viewportWidth / 2
  const max = mid - firstX * scale
  return Math.min(max, Math.max(Math.min(max, mid - contentWidth * scale), tx))
}

/** The review's ease (in and out): slow start, slow landing. */
export function reviewEase(k: number): number {
  const t = Math.min(1, Math.max(0, k))
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
