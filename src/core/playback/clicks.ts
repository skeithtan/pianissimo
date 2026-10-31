/**
 * Metronome click positions for a performance range (spec "Results and timing": the
 * metronome uses the selected tempo factor; "Recommended defaults": off, an audible reference
 * that never forces advancement).
 *
 * The beat is the displayed metronome beat unit (score metronome mark or user tempo entry)
 * when it divides the bar, e.g. the dotted quarter of "♩. = 60" in 6/8; otherwise the meter's
 * beat (compound meters click dotted beats).
 * Pickup bars place their clicks where they fall in a full bar; only a full bar's first beat
 * is accented.
 */
import { type Rational, ZERO, add, cmp, div, eq, gt, lt, mul, rat, sub } from '../music/rational'
import type { MeterEvent, ScoreModel } from '../model/score'
import type { ClickEvent, PerformanceRange } from './types'

function meterAt(meters: readonly MeterEvent[], pos: Rational): MeterEvent | undefined {
  let found: MeterEvent | undefined
  for (const m of meters) {
    if (cmp(m.at, pos) <= 0) found = m
    else break
  }
  return found
}

function meterBeat(m: MeterEvent | undefined): Rational {
  if (!m) return rat(1, 4)
  const compound = m.beats > 3 && m.beats % 3 === 0 && m.beatType >= 8
  return compound ? rat(3, m.beatType) : rat(1, m.beatType)
}

function isMultiple(whole: Rational, unit: Rational): boolean {
  const k = div(whole, unit)
  return k.d === 1 && k.n > 0
}

/** The displayed metronome beat unit at `pos` (a bare `<sound tempo>` implies no beat unit). */
function tempoBeatAt(model: ScoreModel, pos: Rational): Rational | null {
  let unit: Rational | null = null
  for (const s of model.tempo.segments) {
    if (cmp(s.start, pos) > 0) break
    unit = s.source === 'sound' ? null : s.beatUnit
  }
  return unit
}

export function buildClickTrack(model: ScoreModel, range: PerformanceRange): ClickEvent[] {
  const out: ClickEvent[] = []
  for (const occ of model.occurrences) {
    const occEnd = add(occ.start, occ.duration)
    if (!lt(occ.start, range.end)) break
    if (!gt(occEnd, range.start)) continue
    const src = model.sourceMeasures[occ.sourceMeasure]
    const nominal = src?.nominalDuration ?? occ.duration
    const tempoBeat = tempoBeatAt(model, occ.start)
    const beat = tempoBeat && isMultiple(nominal, tempoBeat) ? tempoBeat : meterBeat(meterAt(model.meters, occ.start))
    const missing = sub(nominal, occ.duration)
    // A pickup's notes sit at the end of a notional full bar.
    const barStart = src?.implicit && gt(missing, ZERO) ? sub(occ.start, missing) : occ.start
    const beatsBefore = div(sub(occ.start, barStart), beat)
    for (let k = Math.ceil(beatsBefore.n / beatsBefore.d); ; k++) {
      const p = add(barStart, mul(rat(k), beat))
      if (!lt(p, occEnd)) break
      if (lt(p, range.start) || !lt(p, range.end)) continue
      out.push({ kind: 'click', position: p, offsetSec: 0, accent: k === 0 && eq(barStart, occ.start) })
    }
  }
  return out
}
