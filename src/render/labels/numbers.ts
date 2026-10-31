/**
 * App-drawn measure numbers (DECISIONS R6: "12", "12 (pass 2)" above each bar). Each number box
 * starts just right of its barline at the default height above the top staff and moves up in
 * small steps until it clears every engraved mark and the numbers already placed, so numbers
 * never cover notation; label layout then treats the boxes as obstacles, so labels never cover
 * numbers.
 */
import { BoxGrid } from '../geom'
import type { Box } from '../types'

export interface NumberInput {
  /** Left barline x. */
  readonly x0: number
  /** Measured text box width. */
  readonly w: number
}

/** Default box top relative to the top staff line, its height and the upward search. */
export const NUMBER_OFFSET_Y = -19
const STEP = 3
const MAX_STEPS = 40

/** Number boxes in input order (see module doc). `obstacles` are the engraved marks. */
export function placeMeasureNumbers(
  numbers: readonly NumberInput[],
  obstacles: readonly Box[],
  topStaff: number,
  h: number,
): Box[] {
  const grid = new BoxGrid<Box>(64)
  const x0 = numbers.reduce((m, n) => Math.min(m, n.x0), Infinity)
  const x1 = numbers.reduce((m, n) => Math.max(m, n.x0 + 2 + n.w), -Infinity)
  // Only marks that can meet a number matter: above the top staff line, within the numbers' span.
  for (const o of obstacles) if (o.y < topStaff && o.x <= x1 && o.x + o.w >= x0) grid.add(o)
  return numbers.map((n) => {
    const base: Box = { x: n.x0 + 2, y: topStaff + NUMBER_OFFSET_Y, w: n.w, h }
    let placed = base
    for (let step = 0; step <= MAX_STEPS; step++) {
      const b = { ...base, y: base.y - step * STEP }
      if (!grid.hit(b)) {
        placed = b
        break
      }
    }
    grid.add(placed)
    return placed
  })
}
