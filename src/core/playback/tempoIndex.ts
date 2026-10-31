/**
 * Constant-time-ish conversion between performance positions and seconds at 1× for the
 * scheduler. Same formula as `core/music/tempo.ts` (seconds = 240 × whole notes ÷ quarter
 * BPM per segment), with cumulative segment starts so each lookup is a binary search instead
 * of a walk over every earlier segment. The speed multiplier is applied by the transport.
 */
import { type Rational, toNumber } from '../music/rational'
import type { TempoMapData } from '../music/tempo'

export class TempoIndex {
  private readonly startPos: Float64Array
  private readonly startSec: Float64Array
  private readonly qbpm: Float64Array

  constructor(map: TempoMapData) {
    const segs = map.segments
    if (segs.length === 0) throw new Error('Tempo map is empty: a practice tempo is required')
    this.startPos = new Float64Array(segs.length)
    this.startSec = new Float64Array(segs.length)
    this.qbpm = new Float64Array(segs.length)
    let sec = 0
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!
      if (!(s.quarterBpm > 0) || !Number.isFinite(s.quarterBpm)) {
        throw new RangeError(`Invalid tempo ${s.quarterBpm} in segment ${i}`)
      }
      const pos = i === 0 ? 0 : toNumber(s.start)
      if (i > 0) sec += (240 * (pos - this.startPos[i - 1]!)) / this.qbpm[i - 1]!
      this.startPos[i] = pos
      this.startSec[i] = sec
      this.qbpm[i] = s.quarterBpm
    }
  }

  /** Seconds at 1× from performance position 0 to `pos`. */
  sec(pos: Rational | number): number {
    const p = typeof pos === 'number' ? pos : toNumber(pos)
    const i = upperIndex(this.startPos, p)
    return this.startSec[i]! + (240 * (p - this.startPos[i]!)) / this.qbpm[i]!
  }

  /** Float performance position (whole notes) reached at `sec` seconds at 1×. */
  pos(sec: number): number {
    const i = upperIndex(this.startSec, sec)
    return this.startPos[i]! + ((sec - this.startSec[i]!) * this.qbpm[i]!) / 240
  }
}

/** Index of the last element ≤ x (0 when x precedes everything). */
function upperIndex(a: Float64Array, x: number): number {
  let lo = 0
  let hi = a.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (a[mid]! <= x) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
