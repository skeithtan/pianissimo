import { afterEach, describe, expect, it } from 'vitest'
import type { ResultDetails } from '../../app/session'
import { buildTimeline } from '../../core/engine'
import { buildScore } from '../../core/engine/testkit'
import { attemptRecord, comparisonContext } from '../../core/history/testkit'
import type { GroupOutcome } from '../../core/model/practice'
import type { Language } from '../../core/model/language'
import en from '../../i18n/locales/en-US.json'
import es from '../../i18n/locales/es-ES.json'
import fr from '../../i18n/locales/fr-FR.json'
import ja from '../../i18n/locales/ja-JP.json'
import { readMessagesWith } from '../../i18n/messages'
import { timingText } from './format'
import { buildTimingReview, timingBarDetail } from './timingReview'

/** Reads a translated catalog as the app does (keyed by the English source). */
function speak(language: Language, catalog: Record<string, string>): void {
  const source = en as Record<string, string>
  const strings = Object.fromEntries(Object.entries(catalog).map(([id, text]) => [source[id]!, text]))
  readMessagesWith(() => ({ language, strings }))
}
afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

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

describe('Keep time review in other languages (P2, P5)', () => {
  const rushed = () =>
    buildTimingReview(
      details([
        group(0, { offsetMs: 70, onsetOffsetMs: -8 }),
        group(1, { offsetMs: -48 }),
        group(2, { offsetMs: -88 }),
        group(3, { offsetMs: -110 }),
        group(4, { missed: true }),
        group(5, { offsetMs: 55 }),
      ]),
    )!

  it('says early and late in the language, in one sentence each', () => {
    speak('fr-FR', fr)
    const review = rushed()
    expect(timingBarDetail(review.bars.get(0)!, review.nearBeat)).toBe('3 en avance, de 48–110 ms · 1 sur le temps')
    expect(timingBarDetail(review.bars.get(1)!, review.nearBeat)).toBe('1 en retard, de 55 ms · 1 manqué')
    speak('ja-JP', ja)
    expect(timingBarDetail(review.bars.get(0)!, review.nearBeat)).toBe('3回の打鍵が48–110 ms早い · 1音が拍どおり')
    expect(timingBarDetail(review.bars.get(1)!, review.nearBeat)).not.toMatch(/early|late/)
    speak('es-ES', es)
    expect(timingBarDetail(review.bars.get(0)!, review.nearBeat)).toBe(
      '3 antes de tiempo, por 48–110 ms · 1 en el pulso',
    )
  })

  it('counts one missed group in the singular where the language agrees it with the count', () => {
    const one = { groups: 8, onTime: 7, early: 0, late: 0, missed: 1 }
    const two = { ...one, onTime: 6, missed: 2 }
    expect(timingText(one)).toBe('On time 7 of 8 · 1 missed')
    speak('fr-FR', fr)
    expect(timingText(one)).toBe('Dans le temps\u00a0: 7 sur 8 · 1 manqué')
    expect(timingText(two)).toBe('Dans le temps\u00a0: 6 sur 8 · 2 manqués')
    speak('es-ES', es)
    expect(timingText(one)).toContain('1 omitido')
    expect(timingText(one)).not.toContain('omitidos')
    expect(timingText(two)).toContain('2 omitidos')
  })
})

describe('the folded summary agrees with the score (P10)', () => {
  it('a chord started on the beat but completed past a tight tolerance is not near the beat', () => {
    // ±40 ms: the near-beat window is 20 ms. The first group's first key is 5 ms late, its last
    // 60 ms late: scored late (core/history scores the completion), plotted on the beat.
    const review = buildTimingReview(
      details(
        [
          group(0, { offsetMs: 60, onsetOffsetMs: 5 }),
          group(1, { offsetMs: 4 }),
          group(2, { offsetMs: -6 }),
          group(3, { offsetMs: 10 }),
        ],
        'strict',
        40,
      ),
    )!
    expect(review.nearBeat).toBe(20)
    expect(review.bars.size).toBe(0)
    expect(review.scoredOff).toBe(true)
    // All on the beat by both measures: the summary may say so.
    const steady = buildTimingReview(
      details([group(0, { offsetMs: 12, onsetOffsetMs: 5 }), group(1, { offsetMs: 4 })], 'strict', 40),
    )!
    expect(steady.scoredOff).toBe(false)
  })
})
