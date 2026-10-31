import { describe, expect, it } from 'vitest'
import { RECENT_TRAVERSALS } from './types'
import { applyTraversal, isAssisted, isErrorBearing } from './traversal'
import { MKEY, PIECE, traversal } from './testkit'
import type { BarRecord } from './types'

const source = (n: number) => ({ pieceId: PIECE, measureContextKey: MKEY, attemptId: `t${n}`, at: n * 10 })

describe('traversal classification', () => {
  it('ignores loop-boundary wrong attacks and counts any other wrong attack', () => {
    const boundary = { ...traversal(1, 'clean'), wrongAttacks: 2, wrongAttacksExcludingBoundary: 0 }
    expect(isErrorBearing(boundary)).toBe(false)
    expect(isErrorBearing(traversal(1, 'error', 7))).toBe(true)
  })

  it('treats every assistance source as assisted', () => {
    expect(isAssisted(traversal(1, 'clean'))).toBe(false)
    expect(isAssisted(traversal(1, 'assisted'))).toBe(true)
    expect(isAssisted(traversal(1, 'label'))).toBe(true)
    expect(isAssisted(traversal(1, 'keyboard'))).toBe(true)
  })
})

describe('applyTraversal', () => {
  it('starts a record on the first complete traversal', () => {
    const bar = applyTraversal(undefined, traversal(4, 'clean'), source(1))
    expect(bar).toMatchObject({ pieceId: PIECE, occ: 4, cleanStreak: 1, lastAttemptId: 't1' })
    expect(bar?.recent).toEqual([{ at: 10, attemptId: 't1', errorBearing: false, assisted: false }])
  })

  it('keeps only the five most recent complete traversals, oldest first', () => {
    let bar: BarRecord | undefined
    for (let i = 1; i <= 8; i += 1) bar = applyTraversal(bar, traversal(4, 'clean'), source(i))
    expect(bar?.recent).toHaveLength(RECENT_TRAVERSALS)
    expect(bar?.recent.map((s) => s.attemptId)).toEqual(['t4', 't5', 't6', 't7', 't8'])
    expect(bar?.cleanStreak).toBe(8)
  })

  it('returns nothing for a partial traversal with nothing to report', () => {
    expect(applyTraversal(undefined, traversal(4, 'partial'), source(1))).toBeUndefined()
    const bar = applyTraversal(undefined, traversal(4, 'clean'), source(1))
    expect(applyTraversal(bar, traversal(4, 'partial'), source(2))).toBeUndefined()
  })

  it('a partial traversal with mistakes only resets the streak and never enters the window', () => {
    let bar = applyTraversal(undefined, traversal(4, 'clean'), source(1))
    bar = applyTraversal(bar, traversal(4, 'partial-error'), source(2))
    expect(bar?.cleanStreak).toBe(0)
    expect(bar?.recent).toHaveLength(1)
    expect(applyTraversal(bar, traversal(4, 'partial-error'), source(3))).toBeUndefined()
  })

  it('an error-bearing or assisted complete traversal resets the streak but stays in the window', () => {
    let bar = applyTraversal(undefined, traversal(4, 'clean'), source(1))
    bar = applyTraversal(bar, traversal(4, 'clean'), source(2))
    bar = applyTraversal(bar, traversal(4, 'label'), source(3))
    expect(bar?.cleanStreak).toBe(0)
    expect(bar?.recent.map((s) => [s.errorBearing, s.assisted])).toEqual([
      [false, false],
      [false, false],
      [false, true],
    ])
  })
})
