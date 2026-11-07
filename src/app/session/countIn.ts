/**
 * The Keep time count-in (rhythm mode, DECISIONS P13): one bar of clicks before the transport
 * starts, so the learner enters on time. Pure: the session schedules the beats.
 */
import type { MeterEvent, ScoreModel } from '../../core/model/score'
import { type Rational, cmp, rat, toNumber } from '../../core/music/rational'
import { segmentAt, type TempoMapData } from '../../core/music/tempo'

export interface CountInPlan {
  /** Beats counted in (one bar). */
  readonly beats: number
  /** Real milliseconds per beat at the speed multiplier. */
  readonly beatMs: number
}

/** Beats when the score has no meter at the start position. */
export const COUNT_IN_DEFAULT_BEATS = 4

function meterAt(meters: readonly MeterEvent[], pos: Rational): MeterEvent | undefined {
  let found: MeterEvent | undefined
  for (const m of meters) {
    if (cmp(m.at, pos) <= 0) found = m
    else break
  }
  return found
}

/**
 * One bar at `start`: the meter numerator there, a compound numerator (above 4 and divisible by 3,
 * 6/8, 9/8, 12/8) counted in dotted beats (numerator ÷ 3); 4 quarter beats without a meter. The
 * beat lasts its written length at the tempo in effect at `start`, divided by the speed.
 */
export function countInPlan(model: ScoreModel, tempo: TempoMapData, start: Rational, multiplier: number): CountInPlan {
  const meter = meterAt(model.meters, start)
  let beats = COUNT_IN_DEFAULT_BEATS
  let beat = rat(1, 4)
  if (meter && meter.beats > 0 && meter.beatType > 0) {
    const compound = meter.beats > 4 && meter.beats % 3 === 0
    beats = compound ? meter.beats / 3 : meter.beats
    beat = rat(compound ? 3 : 1, meter.beatType)
  }
  const quarterBpm = segmentAt(tempo, start).quarterBpm
  // 240 s per whole note at one quarter per second (the tempo map's formula).
  const beatMs = (240_000 * toNumber(beat)) / (quarterBpm * multiplier)
  return { beats, beatMs }
}
