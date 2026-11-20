/**
 * The Keep time count-in: a bar of clicks, shortened at slow speeds. The session schedules it.
 */
import type { MeterEvent, ScoreModel } from '../../core/model/score'
import { type Rational, cmp, rat, toNumber } from '../../core/music/rational'
import { segmentAt, type TempoMapData } from '../../core/music/tempo'

export interface CountInPlan {
  /** Clicks in the count-in. */
  readonly beats: number
  /** Real milliseconds per click at the speed multiplier. */
  readonly beatMs: number
}

/** Beats when the score has no meter at the start position. */
export const COUNT_IN_DEFAULT_BEATS = 4
const MAX_COUNT_IN_MS = 5000

function meterAt(meters: readonly MeterEvent[], pos: Rational): MeterEvent | undefined {
  let found: MeterEvent | undefined
  for (const m of meters) {
    if (cmp(m.at, pos) <= 0) found = m
    else break
  }
  return found
}

/**
 * Use the opening meter and practice tempo. Trim a bar to the whole beats that fit in five
 * seconds. If fewer than two beats fit and the full bar is too long, use two subdivisions so
 * there is still a pulse leading into the downbeat.
 */
export function countInPlan(model: ScoreModel, tempo: TempoMapData, start: Rational, multiplier: number): CountInPlan {
  const meter = meterAt(model.meters, start)
  let beats = COUNT_IN_DEFAULT_BEATS
  let beat = rat(1, 4)
  let subdivisions = 2
  if (meter && meter.beats > 0 && meter.beatType > 0) {
    const compound = meter.beats > 4 && meter.beats % 3 === 0
    subdivisions = compound ? 3 : 2
    const unit = compound ? 3 : 1
    beats = meter.beats / unit
    beat = rat(unit, meter.beatType)
  }
  const quarterBpm = segmentAt(tempo, start).quarterBpm
  // Convert the beat's length in whole notes using the tempo map's formula.
  const beatMs = (240_000 * toNumber(beat)) / (quarterBpm * multiplier)
  const wholeBeats = Math.min(beats, Math.floor(MAX_COUNT_IN_MS / beatMs))
  if (wholeBeats === beats || wholeBeats >= 2) return { beats: wholeBeats, beatMs }

  const subdivisionMs = beatMs / subdivisions
  const halvings = Math.max(0, Math.ceil(Math.log2((2 * subdivisionMs) / MAX_COUNT_IN_MS)))
  return { beats: 2, beatMs: subdivisionMs / 2 ** halvings }
}
