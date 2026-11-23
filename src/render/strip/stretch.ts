/**
 * The motion of a pinch after the fingers lift (DECISIONS U150, U152): it coasts at the speed it
 * was released with, at any zoom, and slows down; past the zoom limits it springs back. While the
 * fingers are down it gives past the limits with growing resistance. Pure, in log zoom (so zooming
 * in and out feel the same); what is drawn past the limits is never the zoom itself.
 */

/** The most the score stretches past a limit, log zoom (about 1.3 times). */
const REACH = 0.26
/** How much of the fingers' travel the stretch follows at first. */
const GIVE = 0.55
/** The spring's rate past a limit, per second (critically damped). */
const RATE = 17
/** A coasting zoom loses its speed over this time constant, s: it travels on speed × COAST. */
const COAST = 0.15
/** Slower than this (log zoom per second) a released pinch stays where it is. */
const MIN_SPEED = 0.3
const MAX_SPEED = 6
/** At rest: this slow (log zoom per second), and this close to a limit it springs to (log zoom). */
const REST_SPEED = 0.03
const REST = 0.0008
/** The release speed is measured over the last moves, ms; fingers that rested this long have none. */
const TRAIL_MS = 100
const HELD_MS = 60
const SUBSTEP_MS = 4

/** The stretch factor drawn when the fingers ask for `raw` and the limit allows `zoom`. */
export function stretchFor(raw: number, zoom: number): number {
  const over = Math.log(raw / zoom)
  const d = (1 - 1 / ((Math.abs(over) * GIVE) / REACH + 1)) * REACH
  return over === 0 ? 1 : Math.exp(Math.sign(over) * d)
}

/** The `raw / zoom` that `stretch` is drawn for: a pinch that catches the bounce continues from it. */
export function stretchSource(stretch: number): number {
  const y = Math.min(Math.abs(Math.log(stretch)), REACH * 0.98)
  return Math.exp(Math.sign(Math.log(stretch)) * (REACH / GIVE) * (1 / (1 - y / REACH) - 1))
}

/** How fast the drawn zoom moves for a finger speed of 1 at this stretch (1 within the limits). */
export function stretchSlope(stretch: number): number {
  const over = Math.abs(Math.log(stretchSource(stretch)))
  return over === 0 ? 1 : GIVE / ((over * GIVE) / REACH + 1) ** 2
}

/** Fingers' speed in log zoom per second, from what they asked for lately. */
export class PinchSpeed {
  private readonly trail: { t: number; u: number }[] = []

  add(t: number, raw: number): void {
    this.trail.push({ t, u: Math.log(raw) })
    while (this.trail.length > 2 && t - this.trail[0]!.t > TRAIL_MS) this.trail.shift()
  }

  /** The speed at a release at `t`; 0 when slow or held. */
  at(t: number): number {
    const a = this.trail[0]
    const b = this.trail[this.trail.length - 1]
    if (!a || !b || t - b.t > HELD_MS || b.t - a.t < 8) return 0
    const v = ((b.u - a.u) / (b.t - a.t)) * 1000
    return Math.abs(v) < MIN_SPEED ? 0 : Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v))
  }
}

/** A released zoom: the log of what is drawn, and its speed per second. */
export interface ZoomMotion {
  u: number
  v: number
}

/** Moves `m` on by `ms` between the log zoom limits `lo` and `hi`; false once it rests (within them). */
export function stepZoom(m: ZoomMotion, lo: number, hi: number, ms: number): boolean {
  for (let left = ms; left > 0; left -= SUBSTEP_MS) {
    const dt = Math.min(left, SUBSTEP_MS) / 1000
    const limit = m.u > hi ? hi : m.u < lo ? lo : null
    if (limit === null) {
      m.v *= Math.exp(-dt / COAST)
      m.u += m.v * dt
      if (Math.abs(m.v) < REST_SPEED && m.u >= lo && m.u <= hi) return false
      continue
    }
    const e = Math.exp(-RATE * dt)
    const x = m.u - limit
    const c = (m.v + RATE * x) * dt
    m.u = limit + (x + c) * e
    m.v = (m.v - RATE * c) * e
    if (Math.abs(m.u - limit) < REST && Math.abs(m.v) < REST_SPEED) {
      m.u = limit
      return false
    }
  }
  return true
}
