import { describe, expect, it } from 'vitest'
import { barEvidence, compareEvidence, meetsFlagRule } from './detection'
import { ingestAttempt } from './ingest'
import { MKEY, attemptOf, attemptRecord, fresh, play, traversal } from './testkit'
import { barKey } from './types'
import type { BarEvidence } from './detection'

const BAR13 = 12
const flagged = (h: ReturnType<typeof fresh>) => h.suggestions.filter((s) => s.status === 'active')
const evidenceOf = (h: ReturnType<typeof fresh>, occ = BAR13) => barEvidence(h.bars[barKey(MKEY, occ)])

describe('flag rule', () => {
  it('flags a bar with three error-bearing complete passes out of five', () => {
    let h = play(fresh(), BAR13, ['clean', 'error', 'clean', 'error'])
    expect(flagged(h)).toHaveLength(0)
    h = play(h, BAR13, ['error'])
    expect(evidenceOf(h)).toMatchObject({ complete: 5, errors: 3 })
    expect(flagged(h)).toHaveLength(1)
    expect(flagged(h)[0]).toMatchObject({ kind: 'traversal', coreFrom: BAR13, coreTo: BAR13 })
  })

  it('does not flag two error passes out of five or three', () => {
    expect(flagged(play(fresh(), BAR13, ['error', 'error', 'clean']))).toHaveLength(0)
    expect(flagged(play(fresh(), BAR13, ['error', 'clean', 'error', 'clean', 'clean']))).toHaveLength(0)
  })

  it('does not flag one pass with many wrong notes: each traversal counts once', () => {
    const a = attemptRecord({
      measures: [
        { ...traversal(BAR13, 'error'), wrongAttacks: 40, wrongAttacksExcludingBoundary: 40, groupsWithErrors: 6 },
      ],
    })
    let h = ingestAttempt(fresh(), a, 1).history
    h = play(h, BAR13, ['clean', 'clean', 'clean', 'clean'])
    expect(evidenceOf(h)).toMatchObject({ complete: 5, errors: 1 })
    expect(flagged(h)).toHaveLength(0)
  })

  it('flags three of three complete passes (at least three needed, 60% or more)', () => {
    expect(flagged(play(fresh(), BAR13, ['error', 'error', 'error']))).toHaveLength(1)
  })

  it('uses a rolling window of the five most recent complete traversals', () => {
    // Windows never hold more than two errors, so the bar is never flagged.
    const h = play(fresh(), BAR13, ['error', 'error', 'clean', 'clean', 'clean', 'error', 'error'])
    expect(flagged(h)).toHaveLength(0)
    expect(h.bars[barKey(MKEY, BAR13)]?.recent).toHaveLength(5)
    const older = play(h, BAR13, ['error'])
    expect(evidenceOf(older)).toMatchObject({ complete: 5, errors: 3 })
    expect(flagged(older)).toHaveLength(1)
  })

  it('percentage boundaries use exact integer arithmetic', () => {
    const e = (errors: number, complete: number): BarEvidence => ({ errors, complete, lastErrorAt: 0 })
    expect(meetsFlagRule(e(3, 5))).toBe(true)
    expect(meetsFlagRule(e(3, 4))).toBe(true)
    expect(meetsFlagRule(e(3, 3))).toBe(true)
    expect(meetsFlagRule(e(2, 5))).toBe(false)
    expect(meetsFlagRule(e(2, 3))).toBe(false)
    expect(meetsFlagRule(e(0, 0))).toBe(false)
  })

  it('ignores loop-boundary reattacks when judging a traversal', () => {
    const boundaryOnly = { ...traversal(BAR13, 'clean'), wrongAttacks: 2, wrongAttacksExcludingBoundary: 0 }
    let h = fresh()
    for (let i = 0; i < 5; i += 1) {
      h = ingestAttempt(h, attemptRecord({ measures: [boundaryOnly] }), 100 + i).history
    }
    expect(evidenceOf(h)).toMatchObject({ complete: 5, errors: 0 })
    expect(flagged(h)).toHaveLength(0)
  })

  it('counts an assisted error-free traversal as available but not error-bearing', () => {
    const h = play(fresh(), BAR13, ['error', 'error', 'assisted', 'label', 'keyboard'])
    expect(evidenceOf(h)).toMatchObject({ complete: 5, errors: 2 })
    expect(flagged(h)).toHaveLength(0)
  })
})

describe('partial and unvisited bars', () => {
  it('unvisited bars provide no evidence and are never recorded', () => {
    const h = ingestAttempt(
      fresh(),
      attemptOf([
        [3, 'error'],
        [4, 'error'],
      ]),
      1,
    ).history
    expect(h.bars[barKey(MKEY, BAR13)]).toBeUndefined()
    expect(evidenceOf(h)).toEqual({ complete: 0, errors: 0, lastErrorAt: 0 })
    expect(flagged(h)).toHaveLength(0)
  })

  it('partial traversals never enter the percentages or reach the three-pass minimum', () => {
    const h = play(fresh(), BAR13, ['error', 'error', 'partial-error', 'partial-error', 'partial-error'])
    expect(evidenceOf(h)).toMatchObject({ complete: 2, errors: 2 })
    expect(flagged(h)).toHaveLength(0)
  })

  it('partial traversals do not dilute a qualifying bar either', () => {
    const h = play(fresh(), BAR13, ['error', 'partial', 'error', 'partial', 'error'])
    expect(evidenceOf(h)).toMatchObject({ complete: 3, errors: 3 })
    expect(flagged(h)).toHaveLength(1)
  })

  it('a partial traversal with no mistakes leaves no record at all', () => {
    const h = play(fresh(), BAR13, ['partial', 'partial'])
    expect(h.bars[barKey(MKEY, BAR13)]).toBeUndefined()
  })

  it('re-ingesting an attempt changes nothing', () => {
    const a = attemptOf([[BAR13, 'error']], { createdAt: 50 })
    const once = ingestAttempt(fresh(), a, 50)
    const twice = ingestAttempt(once.history, a, 51)
    expect(twice.changes.bars).toHaveLength(0)
    expect(twice.history).toBe(once.history)
  })
})

describe('evidence ordering', () => {
  const ev = (errors: number, complete: number, lastErrorAt = 0): BarEvidence => ({ errors, complete, lastErrorAt })

  it('ranks by recent proportion, then evidence count, then recency', () => {
    const list = [ev(3, 5, 9), ev(4, 4, 1), ev(5, 5, 1), ev(3, 5, 20), ev(3, 3, 1)]
    const sorted = [...list].sort(compareEvidence)
    expect(sorted.map((x) => `${x.errors}/${x.complete}@${x.lastErrorAt}`)).toEqual([
      '5/5@1',
      '4/4@1',
      '3/3@1',
      '3/5@20',
      '3/5@9',
    ])
  })
})
