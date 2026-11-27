import { decimal, msg } from '../../i18n/messages'
import type { ResultDetails } from '../../app/session'
import { TimingDrift, timingFeedbackThreshold } from '../../app/session/timingDrift'
import { barLabel, DEFAULT_RHYTHM_TOLERANCE_MS } from '../../core/engine'
import type { TimingDirection } from '../../core/model/practice'
import { toNumber } from '../../core/music/rational'
import { missedText } from './format'

export interface TimingPoint {
  readonly group: number
  readonly position: number
  readonly offset: number | null
  readonly missed: boolean
}

export interface TimingBar {
  readonly occ: number
  readonly label: string
  readonly start: number
  readonly duration: number
  readonly points: readonly TimingPoint[]
  readonly direction: TimingDirection | null
}

export interface TimingReviewData {
  readonly bars: ReadonlyMap<number, TimingBar>
  readonly tolerance: number
  readonly nearBeat: number
  /**
   * Scoring counted a group early, late or missed. Scoring measures a group's completion while the
   * plot shows its first attack, so a rolled chord can start on the beat and still be scored late:
   * the review then never says that every attack was near the beat.
   */
  readonly scoredOff: boolean
}

/** The pass's original timeline keeps exact loop boundaries and repeat occurrences in order. */
export function buildTimingReview(details: ResultDetails): TimingReviewData | null {
  const attempt = details.records.find((record) => record.id === details.attemptId)
  if (
    !attempt ||
    attempt.kind === 'run' ||
    attempt.context.transport !== 'strict' ||
    attempt.completion !== 'completed' ||
    !Array.isArray(attempt.groups)
  )
    return null

  const { timeline } = details
  const outcomes = new Map(attempt.groups.map((group) => [group.group, group]))
  const tolerance = attempt.rhythm?.toleranceMs ?? DEFAULT_RHYTHM_TOLERANCE_MS
  const nearBeat = timingFeedbackThreshold(tolerance)
  const bars = new Map<number, TimingBar>()
  let measured = false
  let scoredOff = false
  for (const measure of timeline.measures) {
    const occ = timeline.model.occurrences[measure.occ]
    if (!occ) continue
    const drift = new TimingDrift()
    const points: TimingPoint[] = []
    let direction: TimingDirection | null = null
    let needsReview = false
    for (const index of measure.groups) {
      const group = timeline.groups[index]
      if (!group) continue
      const outcome = outcomes.get(index)
      const missed = outcome?.missed === true
      const value = outcome?.onsetOffsetMs ?? outcome?.offsetMs
      const offset = !missed && value !== undefined && Number.isFinite(value) ? value : null
      // As `core/history` scores it: the completion against the tolerance.
      const completion = outcome?.offsetMs
      if (missed || (completion !== undefined && Math.abs(completion) > tolerance)) scoredOff = true
      points.push({ group: index, position: toNumber(group.position), offset, missed })
      if (offset !== null || missed) measured = true
      if (missed || (offset !== null && Math.abs(offset) > nearBeat)) needsReview = true
      if (offset === null) {
        drift.reset()
      } else {
        drift.observe(offset, tolerance)
        if (Math.abs(offset) > nearBeat && drift.direction) direction = drift.direction
      }
    }
    if (needsReview)
      bars.set(measure.occ, {
        occ: measure.occ,
        label: barLabel(timeline.model, measure.occ),
        start: toNumber(occ.start),
        duration: toNumber(occ.duration),
        points,
        direction,
      })
  }
  return measured ? { bars, tolerance, nearBeat, scoredOff } : null
}

export function timingBarTitle(bar: TimingBar): string {
  if (bar.direction === 'rushing') return msg('Rushing')
  return bar.direction === 'dragging' ? msg('Dragging') : msg('Timing slipped')
}

export function timingBarDetail(bar: TimingBar, nearBeat: number): string {
  const early: number[] = []
  const late: number[] = []
  let onBeat = 0
  let missed = 0
  for (const point of bar.points) {
    if (point.missed) missed++
    if (point.offset === null) continue
    if (point.offset < -nearBeat) early.push(-point.offset)
    else if (point.offset > nearBeat) late.push(point.offset)
    else onBeat++
  }
  const parts: string[] = []
  if (early.length) parts.push(msg('{0} early, by {1} ms', early.length, offsetRange(early)))
  if (onBeat) parts.push(msg('{0} on the beat', onBeat))
  if (late.length) parts.push(msg('{0} late, by {1} ms', late.length, offsetRange(late)))
  if (missed) parts.push(missedText(missed))
  return parts.join(' · ')
}

/** "48" or "48–110": the smallest and largest offset, in the language's numerals. */
function offsetRange(values: readonly number[]): string {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return min === max ? decimal(min) : `${decimal(min)}–${decimal(max)}`
}
