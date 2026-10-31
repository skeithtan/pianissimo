/**
 * Where the cursor is drawn for a performance position (spec "Practice screen": the cursor moves
 * through the music; DECISIONS R12).
 *
 * Knots are every onset anchor of every measure, in one global, strictly increasing position
 * order. A measure's end is *not* a knot: the last onset of a bar glides straight on to the first
 * onset of the next bar, so the cursor never jumps from a barline to the next bar's first note
 * (the engraving puts left padding, and at changes a clef/key/meter, between them) and never slows
 * down towards the barline first. Only the very end of the piece maps to the final barline.
 *
 * `at` interpolates linearly between knots. `smoothAt` uses monotone cubic interpolation: it
 * keeps speed continuous while passing exactly through every onset, so a note reaches the
 * stationary cursor at its musical time and remains aligned when practice waits for input. Both are monotone and O(log knots) per call; nothing
 * here touches the DOM.
 */
import type { OccurrenceGeometry } from '../types'

const EPS = 1e-9

export class CursorPath {
  /** Knot positions (whole notes), strictly increasing. */
  private readonly p: Float64Array
  /** Knot x (layout px), non-decreasing. */
  private readonly x: Float64Array
  /** Monotone cubic slopes at each knot (px per whole note). */
  private readonly slope: Float64Array

  constructor(occurrences: readonly Pick<OccurrenceGeometry, 'start' | 'duration' | 'anchors' | 'x1'>[]) {
    const ps: number[] = []
    const xs: number[] = []
    const push = (p: number, x: number): void => {
      const n = ps.length
      if (n > 0 && p <= ps[n - 1]! + EPS) {
        // Same position (grace notes, float drift between bars): keep the later, rightmost x.
        xs[n - 1] = Math.max(xs[n - 1]!, x)
        return
      }
      ps.push(p)
      xs.push(n > 0 ? Math.max(xs[n - 1]!, x) : x)
    }
    occurrences.forEach((o, i) => {
      const a = o.anchors
      // The final anchor is the measure's own barline; skip it except at the end of the piece.
      const last = i === occurrences.length - 1 ? a.length : a.length - 1
      for (let k = 0; k < last; k++) push(o.start + a[k]![0], a[k]![1])
      if (a.length === 0) push(o.start, o.x1)
    })
    if (ps.length === 0) push(0, 0)
    this.p = Float64Array.from(ps)
    this.x = Float64Array.from(xs)
    this.slope = new Float64Array(ps.length)
    for (let k = 0; k < ps.length; k++) {
      const prev = k > 0 ? (xs[k]! - xs[k - 1]!) / (ps[k]! - ps[k - 1]!) : null
      const next = k + 1 < ps.length ? (xs[k + 1]! - xs[k]!) / (ps[k + 1]! - ps[k]!) : null
      if (prev === null || next === null) this.slope[k] = prev ?? next ?? 0
      else if (prev > 0 && next > 0) {
        const before = ps[k]! - ps[k - 1]!
        const after = ps[k + 1]! - ps[k]!
        const w1 = 2 * after + before
        const w2 = after + 2 * before
        this.slope[k] = (w1 + w2) / (w1 / prev + w2 / next)
      }
    }
  }

  /** Number of knots (tests, diagnostics). */
  get knots(): number {
    return this.p.length
  }

  /** Exact x: linear between onset knots, constant beyond the first and last. */
  at(pos: number): number {
    const p = this.p
    const n = p.length
    if (!(pos > p[0]!)) return this.x[0]!
    if (pos >= p[n - 1]!) return this.x[n - 1]!
    const k = this.segment(pos)
    const p0 = p[k]!
    const x0 = this.x[k]!
    return x0 + ((pos - p0) / (p[k + 1]! - p0)) * (this.x[k + 1]! - x0)
  }

  /** Smooth monotone position, exact at every onset and constant outside the score. */
  smoothAt(pos: number): number {
    const p = this.p
    if (!(pos > p[0]!) || pos >= p[p.length - 1]!) return this.at(pos)
    const k = this.segment(pos)
    const width = p[k + 1]! - p[k]!
    const t = (pos - p[k]!) / width
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * this.x[k]! +
      (t3 - 2 * t2 + t) * width * this.slope[k]! +
      (-2 * t3 + 3 * t2) * this.x[k + 1]! +
      (t3 - t2) * width * this.slope[k + 1]!
    )
  }

  /** Index k with p[k] ≤ pos < p[k + 1], for p[0] < pos < p[n − 1]. */
  private segment(pos: number): number {
    const p = this.p
    let lo = 0
    let hi = p.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (p[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
}
