import { describe, expect, it } from 'vitest'
import type { ResultDetails } from '../../app/session'
import { buildTimeline } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { attemptRecord, comparisonContext } from '../../core/history/testkit'
import type { GroupOutcome } from '../../core/model/practice'
import { buildTimingReview, timingBarDetail } from './timingReview'

const timeline = buildTimeline(buildScore({ notes: [0, 1, 2, 3, 4, 5].map((at) => ({ at, midi: 60 + at })) }), {
  hands: 'both',
  range: null,
  multiplier: 1,
})

function details(
  groups: readonly GroupOutcome[],
  transport: 'strict' | 'free' = 'strict',
  toleranceMs = 150,
): ResultDetails {
  const record = attemptRecord({ context: comparisonContext({ transport }), groups, rhythm: { toleranceMs } })
  return { attemptId: record.id, records: [record], timeline, marks: new Map() }
}

function group(index: number, fields: Partial<GroupOutcome>): GroupOutcome {
  return { group: index, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, ...fields }
}

describe('Keep time review strip', () => {
  it('reads the first attack where available and falls back to the older completion offset', () => {
    const review = buildTimingReview(
      details([
        group(0, { offsetMs: 70, onsetOffsetMs: -8 }),
        group(1, { offsetMs: -48 }),
        group(2, { offsetMs: -88 }),
        group(3, { offsetMs: -110 }),
        group(4, { missed: true }),
        group(5, { offsetMs: 55 }),
      ]),
    )
    expect([...review!.bars.keys()]).toEqual([0, 1])
    expect(review?.bars.get(0)?.direction).toBe('rushing')
    expect(review?.bars.get(0)?.points.map((point) => point.offset)).toEqual([-8, -48, -88, -110])
    expect(review?.bars.get(1)?.direction).toBeNull()
    expect(review?.bars.get(1)?.points[0]).toMatchObject({ offset: null, missed: true })
    expect(timingBarDetail(review!.bars.get(0)!, review!.nearBeat)).toBe('3 early, by 48–110 ms · 1 on the beat')
    expect(timingBarDetail(review!.bars.get(1)!, review!.nearBeat)).toBe('1 late, by 55 ms · 1 missed')
  })

  it('lists missed attacks and skips bars without measurements', () => {
    const review = buildTimingReview(details([group(4, { missed: true })]))
    expect([...review!.bars.keys()]).toEqual([1])
    expect(timingBarDetail(review!.bars.get(1)!, review!.nearBeat)).toBe('1 missed')
    expect(buildTimingReview(details([group(0, { offsetMs: 20 })], 'free'))).toBeNull()
    expect(buildTimingReview(details([]))).toBeNull()
  })

  it('starts folded when every measured attack is within the near-beat window', () => {
    const review = buildTimingReview(
      details([group(0, { offsetMs: 65, onsetOffsetMs: 0 }), group(1, { offsetMs: -30 }), group(2, { offsetMs: 30 })]),
    )
    expect(review?.bars.size).toBe(0)
  })

  it.each([
    { tolerance: 150, offset: -31 },
    { tolerance: 150, offset: 31 },
    { tolerance: 40, offset: 21 },
  ])('lists the bar for a single $offset ms offset with a ±$tolerance ms scoring window', ({ tolerance, offset }) => {
    const review = buildTimingReview(
      details([group(0, { offsetMs: 0 }), group(4, { offsetMs: offset })], 'strict', tolerance),
    )
    expect([...review!.bars.keys()]).toEqual([1])
  })
})
