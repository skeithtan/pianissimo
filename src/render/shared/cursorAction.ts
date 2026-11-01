/**
 * Where the cursor's round action button ("Repeat from here", U14) sits along the cursor line:
 * dead center in the gap between the staves (user), whatever notes or names are there. A single
 * staff has no gap: each view then keeps its line's middle. Both views use it (strip: fixed
 * line; page: moving cursor).
 */

/** The button's radius (screen px; the button is a 48 px circle). */
export const ACTION_RADIUS = 24

/** A vertical extent (layout y). */
export interface Span {
  readonly top: number
  readonly bottom: number
}

/**
 * The gap between two neighboring staves nearest the middle of the staves (layout y, from the
 * upper staff's bottom line to the lower staff's top line), or null for a single staff.
 */
export function staffGap(staves: readonly { readonly top: number; readonly bottom: number }[]): Span | null {
  if (staves.length < 2) return null
  const mid = (staves[0]!.top + staves[staves.length - 1]!.bottom) / 2
  let best: Span | null = null
  for (let i = 0; i + 1 < staves.length; i++) {
    const gap = { top: staves[i]!.bottom, bottom: staves[i + 1]!.top }
    if (!best || Math.abs((gap.top + gap.bottom) / 2 - mid) < Math.abs((best.top + best.bottom) / 2 - mid)) best = gap
  }
  return best
}
