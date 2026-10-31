/**
 * Measure occurrences in performance order with their performance start positions.
 * `MeasureOccurrence.index` is also the measure's index in `ScorePackage.renderXml`.
 */
import { type Rational, ZERO, add } from '../music/rational'
import type { MeasureOccurrence, SourceMeasure } from '../model/score'
import type { UnfoldedMeasure } from './repeats'

export function buildOccurrences(
  unfolded: readonly UnfoldedMeasure[],
  measures: readonly SourceMeasure[],
): { occurrences: MeasureOccurrence[]; total: Rational } {
  const occurrences: MeasureOccurrence[] = []
  let start: Rational = ZERO
  unfolded.forEach((u, index) => {
    const sm = measures[u.m]
    if (!sm) return
    const o: { -readonly [K in keyof MeasureOccurrence]: MeasureOccurrence[K] } = {
      index,
      sourceMeasure: u.m,
      number: sm.number,
      pass: u.pass,
      start,
      duration: sm.duration,
    }
    if (u.ending !== undefined) o.endingNumber = u.ending
    occurrences.push(o)
    start = add(start, sm.duration)
  })
  return { occurrences, total: start }
}

/** True when occurrence `k` does not directly follow `k - 1` in the written score (a repeat jump). */
export function isJump(occurrences: readonly MeasureOccurrence[], k: number): boolean {
  const prev = occurrences[k - 1]
  const cur = occurrences[k]
  return prev !== undefined && cur !== undefined && cur.sourceMeasure !== prev.sourceMeasure + 1
}

/** Occurrence indices per source measure, in performance order. */
export function occurrencesByMeasure(occurrences: readonly MeasureOccurrence[], measureCount: number): number[][] {
  const out: number[][] = Array.from({ length: measureCount }, () => [])
  for (const o of occurrences) out[o.sourceMeasure]?.push(o.index)
  return out
}
