/**
 * The pinch's give past the zoom limits (DECISIONS U150): the score stretches with growing
 * resistance, like a native zoom, and springs back on release. Display only: the zoom itself
 * never leaves its limits. Worked in log zoom, so zooming in and out feel the same.
 */

/** The most the score stretches past a limit, log zoom (about 1.3 times). */
const REACH = 0.26
/** How much of the fingers' travel the stretch follows at first. */
const GIVE = 0.55
/** The spring's rate, per second (critically damped). */
const RATE = 17
/** A stretch this small (log zoom) is none. */
const REST = 0.0008

/** The stretch factor drawn when the fingers ask for `raw` and the limit allows `zoom`. */
export function stretchFor(raw: number, zoom: number): number {
  const over = Math.log(raw / zoom)
  const d = (1 - 1 / ((Math.abs(over) * GIVE) / REACH + 1)) * REACH
  return over === 0 ? 1 : Math.exp(Math.sign(over) * d)
}

/** The `raw / zoom` that `stretch` is drawn for: a pinch that catches the spring continues from it. */
export function stretchSource(stretch: number): number {
  const y = Math.min(Math.abs(Math.log(stretch)), REACH * 0.98)
  return Math.exp(Math.sign(Math.log(stretch)) * (REACH / GIVE) * (1 / (1 - y / REACH) - 1))
}

/** The stretch `ms` after a release at `from`; exactly 1 once at rest. */
export function springBack(from: number, ms: number): number {
  const wt = (RATE * Math.max(0, ms)) / 1000
  const y = Math.log(from) * (1 + wt) * Math.exp(-wt)
  return Math.abs(y) < REST ? 1 : Math.exp(y)
}
