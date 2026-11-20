import { msg } from '../../i18n/messages'
import type { ResultDetails } from '../../app/session'
import { TimingDrift, timingFeedbackThreshold } from '../../app/session/timingDrift'
import { barLabel, DEFAULT_RHYTHM_TOLERANCE_MS } from '../../core/engine'
import type { TimingDirection } from '../../core/model/practice'
import { toNumber } from '../../core/music/rational'

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
}

/** The pass's original timeline keeps exact loop boundaries and repeat occurrences in order. */
export function buildTimingReview(details: ResultDetails): TimingReviewData | null {
  const attempt = details.records.at(-1)
  if (
    attempt?.id !== details.attemptId ||
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
  return measured ? { bars, tolerance, nearBeat } : null
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
  if (early.length) parts.push(offsetRange(early, 'early'))
  if (onBeat) parts.push(msg('{0} on the beat', onBeat))
  if (late.length) parts.push(offsetRange(late, 'late'))
  if (missed) parts.push(msg('{0} missed', missed))
  return parts.join(' · ')
}

function offsetRange(values: readonly number[], direction: 'early' | 'late'): string {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return msg('{0} {1}, by {2} ms', values.length, direction, min === max ? min : `${min}–${max}`)
}
