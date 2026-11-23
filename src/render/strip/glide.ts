/**
 * CSS timing functions in JavaScript (pure), for glides the strip draws frame by frame (the pinned
 * opening, U125) with the same curves its CSS transitions use.
 */

/** Progress (0..1) → eased progress. */
export type Easing = (t: number) => number

/** CSS `cubic-bezier(x1, y1, x2, y2)`. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const curveX = (u: number): number => ((ax * u + bx) * u + cx) * u
  const curveY = (u: number): number => ((ay * u + by) * u + cy) * u
  const slopeX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // Newton steps on x(u) = t, then bisection if they stall or leave [0, 1].
    let u = t
    for (let i = 0; i < 8; i++) {
      const err = curveX(u) - t
      if (Math.abs(err) < 1e-7) return curveY(u)
      const d = slopeX(u)
      if (Math.abs(d) < 1e-6) break
      const next = u - err / d
      if (next < 0 || next > 1) break
      u = next
    }
    let lo = 0
    let hi = 1
    u = t
    for (let i = 0; i < 40; i++) {
      const err = curveX(u) - t
      if (Math.abs(err) < 1e-7) break
      if (err > 0) hi = u
      else lo = u
      u = (lo + hi) / 2
    }
    return curveY(u)
  }
}

const KEYWORDS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

/** A CSS easing value (`cubic-bezier(…)` or a keyword); `fallback` for anything else. */
export function parseEasing(css: string, fallback: readonly [number, number, number, number]): Easing {
  const value = css.trim()
  const args = /^cubic-bezier\(([^)]*)\)$/.exec(value)?.[1]?.split(',').map(Number)
  const p = KEYWORDS[value] ?? (args?.length === 4 && args.every(Number.isFinite) ? args : fallback)
  return cubicBezier(p[0]!, p[1]!, p[2]!, p[3]!)
}
