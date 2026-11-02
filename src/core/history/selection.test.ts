import { describe, expect, it } from 'vitest'
import type { MeasureOccurrence } from '../model/score'
import { rat } from '../music/rational'
import { SessionDismissals, clearPracticeHistory, setSuggestionsDisabled } from './controls'
import { ingestAttempt } from './ingest'
import { describeContext, selectSuggestions } from './selection'
import { MKEY, abandon, attemptOf, comparisonContext, fresh, occurrences, play } from './testkit'
import type { Outcome } from './testkit'
import { toMeasureContext } from './contextKey'
import type { PieceHistory } from './types'

const SCORE = occurrences(60)
const pick = (h: PieceHistory, extra: Partial<Parameters<typeof selectSuggestions>[2]> = {}, occ = SCORE) =>
  selectSuggestions(h, occ, { scoreVersionId: 'v1', enabled: true, ...extra })

/** Play `outcomes` on a bar in the shared context. */
const bar = (h: PieceHistory, occ: number, outcomes: readonly Outcome[]) => play(h, occ, outcomes)

describe('merging and splitting', () => {
  it('merges adjacent flagged bars before ranking and keeps distant bars separate', () => {
    let h = fresh()
    for (const occ of [12, 13, 14, 30]) h = bar(h, occ, ['error', 'error', 'error'])
    const { active } = pick(h)
    expect(active).toHaveLength(2)
    const ranges = active.map((s) => `${s.core.fromOcc}-${s.core.toOcc}`).sort()
    expect(ranges).toEqual(['12-14', '30-30'])
  })

  it('adds one context bar on each side and distinguishes them from the difficult bars', () => {
    const h = bar(fresh(), 12, ['error', 'error', 'error'])
    const [s] = pick(h).active
    expect(s?.passage).toEqual({ fromOcc: 11, toOcc: 13 })
    expect(s?.bars.map((b) => [b.number, b.role])).toEqual([
      ['12', 'context'],
      ['13', 'difficult'],
      ['14', 'context'],
    ])
    expect(s?.prompt).toBe('Practice bars 12–14?')
    expect(s?.evidence).toBe('Mistakes in bar 13 on 3 of your last 3 comparable passes.')
  })

  it('uses the "3 of your last 5" wording once the window is full', () => {
    const h = bar(fresh(), 12, ['clean', 'error', 'clean', 'error', 'error'])
    expect(pick(h).active[0]?.evidence).toBe('Mistakes in bar 13 on 3 of your last 5 comparable passes.')
  })

  it('adds context only where the score has bars', () => {
    let h = bar(fresh(), 0, ['error', 'error', 'error'])
    expect(pick(h).active[0]?.passage).toEqual({ fromOcc: 0, toOcc: 1 })
    h = bar(fresh(), 59, ['error', 'error', 'error'])
    const [s] = pick(h).active
    expect(s?.passage).toEqual({ fromOcc: 58, toOcc: 59 })
    expect(s?.bars.map((b) => b.role)).toEqual(['context', 'difficult'])
    expect(s?.prompt).toBe('Practice bars 59–60?')
  })

  it.each([
    [6, [[0, 5]]],
    [
      7,
      [
        [0, 3],
        [4, 6],
      ],
    ],
    [
      12,
      [
        [0, 5],
        [6, 11],
      ],
    ],
    [
      13,
      [
        [0, 4],
        [5, 8],
        [9, 12],
      ],
    ],
  ])('splits a run of %i difficult bars so no passage exceeds eight bars', (count, expected) => {
    let h = fresh()
    const start = 20
    for (let i = 0; i < count; i += 1) h = bar(h, start + i, ['error', 'error', 'error'])
    const all = pick(h, { max: 99 }).active
    expect(all.map((s) => [s.core.fromOcc - start, s.core.toOcc - start]).sort((a, b) => a[0]! - b[0]!)).toEqual(
      expected,
    )
    for (const s of all) {
      expect(s.passage.toOcc - s.passage.fromOcc + 1).toBeLessThanOrEqual(8)
      expect(s.bars).toHaveLength(s.passage.toOcc - s.passage.fromOcc + 1)
    }
  })

  it('grows an existing suggestion when a neighboring bar is flagged later', () => {
    let h = bar(fresh(), 12, ['error', 'error', 'error'])
    const first = pick(h).active[0]
    h = bar(h, 13, ['error', 'error', 'error'])
    const { active } = pick(h)
    expect(active).toHaveLength(1)
    expect(active[0]?.core).toEqual({ fromOcc: 12, toOcc: 13 })
    expect(active[0]?.id).not.toBe(first?.id)
  })

  it('keeps the identity of an unchanged suggestion across later attempts', () => {
    let h = bar(fresh(), 12, ['error', 'error', 'error'])
    const before = pick(h).active[0]?.id
    h = bar(h, 40, ['error', 'error', 'error'])
    expect(pick(h).active.map((s) => s.id)).toContain(before)
  })

  it('describes an uneven cluster per bar', () => {
    let h = fresh()
    h = bar(h, 12, ['error', 'error', 'error'])
    h = ingestAttempt(
      h,
      attemptOf(
        [
          [13, 'error'],
          [13, 'error'],
        ],
        { createdAt: 20_000 },
      ),
      20_000,
    ).history
    h = bar(h, 13, ['error', 'error', 'error', 'error'])
    expect(pick(h).active[0]?.evidence).toMatch(
      /^Mistakes in bar 13 on 3 of your last 3 comparable passes, and in bar 14 on /,
    )
  })
})

describe('ranking', () => {
  const evidenceOrder = (h: PieceHistory) => pick(h, { max: 99 }).active.map((s) => s.core.fromOcc)

  it('ranks by the recent proportion of passes with mistakes, then evidence count, then recency', () => {
    let h = fresh()
    h = bar(h, 10, ['error', 'error', 'error', 'clean', 'clean']) // 3/5 = 60%
    h = bar(h, 20, ['error', 'error', 'error']) // 3/3 = 100%, fewer passes
    h = bar(h, 30, ['error', 'error', 'error', 'error', 'error']) // 5/5 = 100%, more evidence
    h = bar(h, 40, ['error', 'error', 'error', 'clean']) // 3/4 = 75%
    expect(evidenceOrder(h)).toEqual([30, 20, 40, 10])
  })

  it('breaks equal proportion and count by recency of the latest mistake', () => {
    let h = fresh()
    h = bar(h, 10, ['error', 'error', 'error'])
    h = bar(h, 20, ['error', 'error', 'error'])
    h = bar(h, 5, ['error', 'error', 'error'])
    expect(evidenceOrder(h)).toEqual([5, 20, 10])
  })

  it('never ranks by lifetime mistake totals', () => {
    let h = fresh()
    // Bar 10 has a long, bad history that has since improved to 3 of the last 5.
    h = bar(h, 10, Array<Outcome>(30).fill('error'))
    h = bar(h, 10, ['clean', 'clean'])
    // Bar 20 has only ever been played four times but is wrong every time.
    h = bar(h, 20, ['error', 'error', 'error', 'error'])
    expect(evidenceOrder(h)).toEqual([20, 10])
  })

  it('ranks a merged suggestion by its worst bar', () => {
    let h = fresh()
    h = bar(h, 10, ['error', 'error', 'error', 'clean', 'clean'])
    h = bar(h, 11, ['error', 'error', 'error', 'error', 'error'])
    h = bar(h, 30, ['error', 'error', 'error', 'error', 'clean'])
    expect(evidenceOrder(h)).toEqual([10, 30])
  })

  it('shows at most three suggestions', () => {
    let h = fresh()
    for (const occ of [5, 15, 25, 35, 45]) h = bar(h, occ, ['error', 'error', 'error'])
    expect(pick(h).active).toHaveLength(3)
    expect(pick(h, { max: 2 }).active).toHaveLength(2)
  })

  it('puts traversal-backed suggestions ahead of repeated-restart ones before cutting to three', () => {
    let h = fresh()
    for (const occ of [5, 15, 25, 35]) h = bar(h, occ, ['error', 'error', 'error'])
    for (let i = 0; i < 5; i += 1) h = abandon(h, 50, 'user-restart', 100 + i)
    const kinds = pick(h).active.map((s) => s.kind)
    expect(kinds).toEqual(['traversal', 'traversal', 'traversal'])
    const all = pick(h, { max: 10 }).active.map((s) => s.kind)
    expect(all[all.length - 1]).toBe('restart')
  })

  it('orders restart suggestions by count of events, then recency', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) h = abandon(h, 10, 'user-restart', 100 + i)
    for (let i = 0; i < 4; i += 1) h = abandon(h, 20, 'user-restart', 50 + i)
    for (let i = 0; i < 3; i += 1) h = abandon(h, 30, 'user-stop', 500 + i)
    expect(pick(h, { max: 10 }).active.map((s) => s.core.fromOcc)).toEqual([20, 30, 10])
  })
})

describe('suggestion hand and tempo', () => {
  it('opens at the hand selection and speed of the evidence, not the current settings', () => {
    const left = comparisonContext({ hands: 'left', multiplier: 0.75 })
    const h = play(fresh(), 12, ['error', 'error', 'error'], { context: left })
    const [s] = pick(h).active
    expect(s).toMatchObject({ hands: 'left', multiplier: 0.75, contextLabel: 'Left hand at 0.75×' })
    expect(s?.context).toEqual(toMeasureContext(left))
  })

  it('describes contexts', () => {
    expect(describeContext(toMeasureContext(comparisonContext()))).toBe('Both hands at 1×')
    expect(describeContext(toMeasureContext(comparisonContext({ hands: 'right', multiplier: 1.25 })))).toBe(
      'Right hand at 1.25×',
    )
    expect(describeContext(toMeasureContext(comparisonContext({ multiplier: 0.6 })))).toBe('Both hands at 0.6×')
  })

  it('keeps suggestions for another speed apart and lists both', () => {
    let h = bar(fresh(), 12, ['error', 'error', 'error'])
    h = play(h, 12, ['error', 'error', 'error'], { context: comparisonContext({ multiplier: 0.5 }) })
    const labels = pick(h)
      .active.map((s) => s.contextLabel)
      .sort()
    expect(labels).toEqual(['Both hands at 0.5×', 'Both hands at 1×'])
  })

  it('ignores other score versions entirely', () => {
    const h = play(fresh(), 12, ['error', 'error', 'error'], { context: comparisonContext({ scoreVersionId: 'v0' }) })
    expect(pick(h).active).toHaveLength(0)
    expect(pick(h, { scoreVersionId: 'v0' }).active).toHaveLength(1)
  })
})

describe('repeat passes and labels', () => {
  const withRepeat: MeasureOccurrence[] = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    sourceMeasure: i % 4,
    number: String((i % 4) + 1),
    pass: i < 4 ? 1 : 2,
    start: rat(i),
    duration: rat(1),
  }))

  it('labels the second pass of a repeated bar', () => {
    const h = play(fresh(), 5, ['error', 'error', 'error'])
    const [s] = pick(h, {}, withRepeat).active
    expect(s?.bars.map((b) => b.label)).toEqual(['1 (pass 2)', '2 (pass 2)', '3 (pass 2)'])
    expect(s?.evidence).toBe('Mistakes in bar 2 (pass 2) on 3 of your last 3 comparable passes.')
    expect(s?.prompt).toBe('Practice bars 1 (pass 2)–3 (pass 2)?')
  })

  it('keeps the first and second pass of a repeated bar as separate histories', () => {
    let h = play(fresh(), 1, ['error', 'error', 'error'])
    h = play(h, 5, ['clean', 'clean', 'clean'])
    const { active } = pick(h, {}, withRepeat)
    expect(active).toHaveLength(1)
    expect(active[0]?.core.fromOcc).toBe(1)
  })
})

describe('dismiss, disable and clear', () => {
  const flagged = () => bar(fresh(), 12, ['error', 'error', 'error'])

  it('hides a dismissed suggestion for the session only', () => {
    const h = flagged()
    const id = pick(h).active[0]?.id ?? ''
    const dismissals = new SessionDismissals()
    dismissals.dismiss(id)
    expect(pick(h, { dismissed: dismissals }).active).toHaveLength(0)
    // A new session starts with no dismissals: the persisted suggestion is back.
    expect(pick(h, { dismissed: new SessionDismissals() }).active).toHaveLength(1)
    dismissals.clear()
    expect(pick(h, { dismissed: dismissals }).active).toHaveLength(1)
  })

  it('a dismissal does not hide other suggestions or free a slot for restarts out of order', () => {
    let h = flagged()
    h = bar(h, 30, ['error', 'error', 'error'])
    const dismissals = new SessionDismissals()
    dismissals.dismiss(pick(h).active[0]?.id ?? '')
    expect(pick(h, { dismissed: dismissals }).active).toHaveLength(1)
  })

  it('disabling suggestions hides everything but keeps recording evidence', () => {
    let h = setSuggestionsDisabled(flagged(), true)
    expect(pick(h)).toEqual({ active: [], improved: [], disabled: true })
    h = play(h, 12, ['clean', 'clean', 'clean'])
    expect(Object.keys(h.bars)).toHaveLength(1)
    h = setSuggestionsDisabled(h, false)
    expect(pick(h).disabled).toBe(false)
    expect(pick(h).improved).toHaveLength(1)
  })

  it('the global setting disables suggestions too', () => {
    expect(pick(flagged(), { enabled: false })).toEqual({ active: [], improved: [], disabled: true })
  })

  it('clearing the practice history removes bars, suggestions and abandon events', () => {
    let h = flagged()
    h = play(h, 12, ['clean', 'clean', 'clean'])
    h = abandon(h, 40, 'user-restart', 5)
    h = setSuggestionsDisabled(h, true)
    const cleared = clearPracticeHistory(h)
    expect(cleared).toEqual({ pieceId: h.pieceId, disabled: true, bars: {}, suggestions: [], abandons: {} })
    expect(pick(setSuggestionsDisabled(cleared, false))).toEqual({ active: [], improved: [], disabled: false })
  })

  it('starts evidence over after clearing', () => {
    const cleared = clearPracticeHistory(flagged())
    expect(pick(play(cleared, 12, ['error', 'error'])).active).toHaveLength(0)
    expect(pick(play(cleared, 12, ['error', 'error', 'error'])).active).toHaveLength(1)
  })
})

describe('improved list', () => {
  it('lists resolved suggestions newest first and keeps at most ten', () => {
    let h = fresh()
    for (let i = 0; i < 12; i += 1) {
      const occ = 3 + i * 4
      h = bar(h, occ, ['error', 'error', 'error', 'clean', 'clean', 'clean'])
    }
    const { improved, active } = pick(h)
    expect(active).toHaveLength(0)
    expect(improved).toHaveLength(10)
    const times = h.suggestions.filter((s) => s.status === 'improved').map((s) => s.improvedAt ?? 0)
    expect(times.length).toBe(10)
    expect(improved[0]?.core.fromOcc).toBe(3 + 11 * 4)
    expect(improved.every((s) => s.status === 'improved')).toBe(true)
  })

  it('shows what a context-bar-free improvement covered', () => {
    const h = play(bar(fresh(), 12, ['error', 'error', 'error']), 12, ['clean', 'clean', 'clean'])
    const [s] = pick(h).improved
    expect(s?.bars.map((b) => b.role)).toEqual(['context', 'difficult', 'context'])
    expect(s?.context).toEqual(toMeasureContext(comparisonContext()))
    expect(MKEY).toBe(s?.measureContextKey)
  })
})
