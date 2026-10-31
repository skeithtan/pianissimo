import { describe, expect, it } from 'vitest'
import { contextKey } from '../model/practice'
import { ingestAttempt } from './ingest'
import { selectSuggestions } from './selection'
import { MKEY, attemptOf, attemptRecord, comparisonContext, fresh, occurrences, play, traversal } from './testkit'
import type { Outcome } from './testkit'
import { barKey } from './types'
import type { PieceHistory } from './types'

const BAR = 12
const SCORE = occurrences(40)

const active = (h: PieceHistory) => h.suggestions.filter((s) => s.status === 'active')
const improved = (h: PieceHistory) => h.suggestions.filter((s) => s.status === 'improved')
const streakOf = (h: PieceHistory, occ = BAR, key = MKEY) => h.bars[barKey(key, occ)]?.cleanStreak ?? 0
const shown = (h: PieceHistory) => selectSuggestions(h, SCORE, { scoreVersionId: 'v1', enabled: true })

const flagged = (): PieceHistory => play(fresh(), BAR, ['error', 'error', 'error'])

describe('suggestion recovery', () => {
  it('resolves a flagged bar after three consecutive clean unassisted complete traversals', () => {
    let h = flagged()
    expect(active(h)).toHaveLength(1)

    h = play(h, BAR, ['clean'])
    expect(active(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress).toMatchObject({ clean: 1, target: 3, text: '1 of 3 clean passes' })

    h = play(h, BAR, ['clean'])
    expect(active(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress.text).toBe('2 of 3 clean passes')

    h = play(h, BAR, ['clean'])
    expect(active(h)).toHaveLength(0)
    expect(improved(h)).toHaveLength(1)
    expect(improved(h)[0]?.improvedAt).toBeGreaterThan(0)
  })

  it.each<Outcome>(['assisted', 'label', 'keyboard'])(
    'an assisted success (%s) neither resolves nor counts toward the streak',
    (assistedOutcome) => {
      let h = play(flagged(), BAR, ['clean', 'clean', assistedOutcome])
      expect(streakOf(h)).toBe(0)
      expect(active(h)).toHaveLength(1)
      h = play(h, BAR, ['clean', 'clean'])
      expect(active(h)).toHaveLength(1)
      expect(streakOf(h)).toBe(2)
      h = play(h, BAR, ['clean'])
      expect(active(h)).toHaveLength(0)
      expect(improved(h)).toHaveLength(1)
    },
  )

  it('an error-bearing traversal resets the streak', () => {
    const h = play(flagged(), BAR, ['clean', 'clean', 'error'])
    expect(streakOf(h)).toBe(0)
    expect(active(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress.text).toBe('0 of 3 clean passes')
  })

  it('practice at another tempo, speed, hand selection or hand assignment cannot resolve the original context', () => {
    const slower = comparisonContext({ multiplier: 0.75 })
    const rightOnly = comparisonContext({ hands: 'right' })
    const otherMap = comparisonContext({ tempoMapId: 'tm2' })
    const reassigned = comparisonContext({ handsId: 'h2' })
    let h = flagged()
    for (const context of [slower, rightOnly, otherMap, reassigned]) {
      h = play(h, BAR, ['clean', 'clean', 'clean', 'clean'], { context })
    }
    expect(active(h)).toHaveLength(1)
    expect(improved(h)).toHaveLength(0)
    expect(streakOf(h)).toBe(0)
    // The other contexts keep their own, separate histories.
    expect(h.bars).toHaveProperty([barKey(`v1|both|h1|tm1|0.7500|roll-v1|free|match-v1`, BAR)])
    expect(Object.keys(h.bars)).toHaveLength(5)
  })

  it('errors at another tempo do not erase the suggestion and flag a separate context', () => {
    const slower = comparisonContext({ multiplier: 0.5 })
    let h = flagged()
    h = play(h, BAR, ['error', 'error', 'error'], { context: slower })
    const list = active(h)
    expect(list).toHaveLength(2)
    expect(new Set(list.map((s) => s.context.multiplier))).toEqual(new Set([1, 0.5]))
  })

  it('practice on another score version never mixes into the history of this one', () => {
    const other = comparisonContext({ scoreVersionId: 'v2' })
    let h = flagged()
    h = play(h, BAR, ['clean', 'clean', 'clean'], { context: other })
    expect(active(h).filter((s) => s.context.scoreVersionId === 'v1')).toHaveLength(1)
    expect(shown(h).active).toHaveLength(1)
  })

  describe('partial traversals', () => {
    it('never advance the streak', () => {
      const h = play(flagged(), BAR, ['clean', 'clean', 'partial', 'partial', 'partial'])
      expect(streakOf(h)).toBe(2)
      expect(active(h)).toHaveLength(1)
    })

    it('cannot resolve a bar on their own', () => {
      const h = play(flagged(), BAR, ['partial', 'partial', 'partial', 'partial'])
      expect(streakOf(h)).toBe(0)
      expect(active(h)).toHaveLength(1)
    })

    it('break the streak when a mistake was observed', () => {
      const h = play(flagged(), BAR, ['clean', 'clean', 'partial-error'])
      expect(streakOf(h)).toBe(0)
      expect(active(h)).toHaveLength(1)
    })

    it('break the streak when assistance was revealed', () => {
      const h = play(flagged(), BAR, ['clean', 'clean', 'partial-hint'])
      expect(streakOf(h)).toBe(0)
    })

    it('a partial pass at the end does not turn two clean passes into three', () => {
      let h = play(flagged(), BAR, ['clean', 'partial', 'clean'])
      expect(streakOf(h)).toBe(2)
      h = play(h, BAR, ['partial'])
      expect(active(h)).toHaveLength(1)
    })
  })

  it('keeps the suggestion active when the rolling window falls below the detection threshold', () => {
    const h = play(flagged(), BAR, ['assisted', 'assisted', 'assisted', 'assisted'])
    const bar = h.bars[barKey(MKEY, BAR)]
    expect(bar?.recent.filter((s) => s.errorBearing)).toHaveLength(1)
    expect(active(h)).toHaveLength(1)
    expect(improved(h)).toHaveLength(0)
  })

  it('counts loop-boundary reattacks as nothing: a boundary-only traversal is clean', () => {
    const boundary = { ...traversal(BAR, 'clean'), wrongAttacks: 3, wrongAttacksExcludingBoundary: 0 }
    let h = flagged()
    for (let i = 0; i < 3; i += 1) {
      h = ingestAttempt(h, attemptRecord({ createdAt: 5_000 + i, measures: [boundary] }), 5_000 + i).history
    }
    expect(improved(h)).toHaveLength(1)
  })

  it('every flagged bar of a merged suggestion needs its own three clean passes', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) {
      h = ingestAttempt(
        h,
        attemptOf(
          [
            [BAR, 'error'],
            [BAR + 1, 'error'],
          ],
          { createdAt: 100 + i },
        ),
        100 + i,
      ).history
    }
    expect(active(h)).toHaveLength(1)
    expect(active(h)[0]).toMatchObject({ coreFrom: BAR, coreTo: BAR + 1 })

    h = play(h, BAR, ['clean', 'clean', 'clean'])
    expect(active(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress.text).toBe('0 of 3 clean passes')

    h = play(h, BAR + 1, ['clean', 'clean'])
    expect(active(h)).toHaveLength(1)
    expect(shown(h).active[0]?.progress.clean).toBe(2)

    h = play(h, BAR + 1, ['clean'])
    expect(active(h)).toHaveLength(0)
    expect(improved(h)).toHaveLength(1)
  })

  it('clean passes in one attempt covering both bars resolve a merged suggestion', () => {
    let h = fresh()
    for (let i = 0; i < 3; i += 1) {
      h = ingestAttempt(
        h,
        attemptOf(
          [
            [BAR, 'error'],
            [BAR + 1, 'error'],
          ],
          { createdAt: 100 + i },
        ),
        100 + i,
      ).history
    }
    for (let i = 0; i < 3; i += 1) {
      h = ingestAttempt(
        h,
        attemptOf(
          [
            [BAR, 'clean'],
            [BAR + 1, 'clean'],
          ],
          { createdAt: 200 + i },
        ),
        200 + i,
      ).history
    }
    expect(improved(h)).toHaveLength(1)
    expect(active(h)).toHaveLength(0)
  })

  it('context bars do not need to be mastered', () => {
    let h = flagged()
    h = ingestAttempt(
      h,
      attemptOf(
        [
          [BAR - 1, 'error'],
          [BAR + 1, 'error'],
        ],
        { createdAt: 300 },
      ),
      300,
    ).history
    h = play(h, BAR, ['clean', 'clean', 'clean'])
    expect(improved(h)).toHaveLength(1)
    expect(active(h)).toHaveLength(0)
  })

  it('shows the resolved suggestion in the Improved section with the full progress', () => {
    const h = play(flagged(), BAR, ['clean', 'clean', 'clean'])
    const view = shown(h)
    expect(view.active).toHaveLength(0)
    expect(view.improved).toHaveLength(1)
    expect(view.improved[0]).toMatchObject({
      status: 'improved',
      prompt: '',
      progress: { clean: 3, target: 3 },
      evidence: 'Improved: 3 clean passes in a row on bar 13.',
    })
  })

  it('new recurring errors can flag the passage again while the Improved entry stays', () => {
    let h = play(flagged(), BAR, ['clean', 'clean', 'clean'])
    expect(active(h)).toHaveLength(0)
    h = play(h, BAR, ['error', 'error'])
    expect(active(h)).toHaveLength(0)
    h = play(h, BAR, ['error'])
    expect(active(h)).toHaveLength(1)
    expect(improved(h)).toHaveLength(1)
    expect(active(h)[0]?.id).not.toBe(improved(h)[0]?.id)
  })

  it('is not advanced twice by re-ingesting an earlier attempt', () => {
    let h = flagged()
    const a = attemptOf([[BAR, 'clean']], { id: 'again-a', createdAt: 900 })
    const b = attemptOf([[BAR, 'clean']], { id: 'again-b', createdAt: 910 })
    h = ingestAttempt(h, a, 900).history
    h = ingestAttempt(h, b, 910).history
    h = ingestAttempt(h, a, 920).history
    expect(streakOf(h)).toBe(2)
    expect(active(h)).toHaveLength(1)
  })

  it('uses complete traversals from interrupted attempts and from ordinary reading', () => {
    let h = flagged()
    h = ingestAttempt(
      h,
      attemptOf([[BAR, 'clean']], { completion: 'interrupted', interruptReason: 'pause', createdAt: 700 }),
      700,
    ).history
    h = ingestAttempt(h, attemptOf([[BAR, 'clean']], { kind: 'reading', createdAt: 710 }), 710).history
    expect(streakOf(h)).toBe(2)
    h = ingestAttempt(h, attemptOf([[BAR, 'clean']], { createdAt: 720 }), 720).history
    expect(improved(h)).toHaveLength(1)
  })

  it('records nothing for Preview', () => {
    const preview = comparisonContext({ hands: 'none' })
    const a = attemptOf([[BAR, 'error']], { context: preview, contextKey: contextKey(preview) })
    const result = ingestAttempt(fresh(), a, 1)
    expect(result.changes.bars).toHaveLength(0)
    expect(Object.keys(result.history.bars)).toHaveLength(0)
  })
})
