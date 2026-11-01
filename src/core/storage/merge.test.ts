import { describe, expect, it } from 'vitest'
import { MAX_IMPROVED_KEPT } from '../history/types'
import type { SuggestionRecord } from '../history/types'
import { comparisonContext } from '../history/testkit'
import { toMeasureContext } from '../history/contextKey'
import { deepEqual, mergeAbandon, mergePiece, mergeSuggestionState, preferPackage } from './merge'
import { makePackage, makePiece } from './testkit'

describe('deepEqual', () => {
  it('compares JSON-like values structurally', () => {
    expect(deepEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
  })
})

describe('mergePiece', () => {
  const pkg = makePackage('v1')
  const local = makePiece(pkg, { lastOpenedAt: 100, createdAt: 50, lastMultiplier: 1 })

  it('takes the newer record and keeps the earliest creation time', () => {
    const merged = mergePiece(local, { ...local, lastOpenedAt: 200, createdAt: 80, lastMultiplier: 2 })
    expect(merged).toMatchObject({ lastOpenedAt: 200, lastMultiplier: 2, createdAt: 50 })
  })

  it('keeps the local record when it is newer or equal', () => {
    expect(mergePiece(local, { ...local, lastOpenedAt: 100, lastMultiplier: 3 }).lastMultiplier).toBe(1)
    expect(mergePiece(local, { ...local, lastOpenedAt: 10, lastMultiplier: 3 }).lastMultiplier).toBe(1)
  })

  it('fills a missing tempo and composer from the other side', () => {
    const withTempo = { ...local, userTempo: { beatBpm: 80, beatUnit: { n: 1, d: 4 } }, composer: 'Someone' }
    const { composer: _c, ...bare } = local
    expect(mergePiece(bare, withTempo)).toMatchObject({ userTempo: { beatBpm: 80 }, composer: 'Someone' })
    expect(mergePiece({ ...withTempo, lastOpenedAt: 999 }, bare)).toMatchObject({ userTempo: { beatBpm: 80 } })
  })

  it('does not resurrect userTempo or composer from another score version', () => {
    const old = makePiece(makePackage('v-old'), {
      id: 'p',
      lastOpenedAt: 100,
      userTempo: { beatBpm: 80, beatUnit: { n: 1, d: 4 } },
      composer: 'Old composer',
    })
    const { composer: _c, ...replaced } = makePiece(makePackage('v-new'), { id: 'p', lastOpenedAt: 200 })
    expect(mergePiece(replaced, old).userTempo).toBeUndefined()
    expect(mergePiece(old, replaced).userTempo).toBeUndefined()
    expect(mergePiece(replaced, old).composer).toBeUndefined()
    expect(mergePiece(old, replaced)).toMatchObject({ scoreVersionId: 'v-new', lastOpenedAt: 200 })
  })
})

describe('mergeSuggestionState', () => {
  const context = toMeasureContext(comparisonContext())
  const suggestion = (id: string, over: Partial<SuggestionRecord> = {}): SuggestionRecord => ({
    id,
    kind: 'traversal',
    status: 'active',
    measureContextKey: 'k',
    context,
    coreFrom: 1,
    coreTo: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

  it('unions by id, the more recently updated copy winning, and keeps the local disable switch', () => {
    const merged = mergeSuggestionState(
      { pieceId: 'p', disabled: true, suggestions: [suggestion('a', { updatedAt: 5 }), suggestion('b')] },
      {
        pieceId: 'p',
        disabled: false,
        suggestions: [suggestion('a', { updatedAt: 9, status: 'improved', improvedAt: 9 }), suggestion('c')],
      },
    )
    expect(merged.disabled).toBe(true)
    expect(merged.suggestions.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
    expect(merged.suggestions.find((s) => s.id === 'a')?.status).toBe('improved')
  })

  it('keeps only the newest improved entries', () => {
    const improved = Array.from({ length: MAX_IMPROVED_KEPT + 3 }, (_, i) =>
      suggestion(`i${i}`, { status: 'improved', improvedAt: i, coreFrom: i, coreTo: i }),
    )
    const merged = mergeSuggestionState(
      { pieceId: 'p', disabled: false, suggestions: [suggestion('active'), ...improved.slice(0, 6)] },
      { pieceId: 'p', disabled: false, suggestions: improved.slice(6) },
    )
    expect(merged.suggestions.filter((s) => s.status === 'improved')).toHaveLength(MAX_IMPROVED_KEPT)
    expect(merged.suggestions.some((s) => s.id === 'active')).toBe(true)
    expect(merged.suggestions.some((s) => s.id === 'i0')).toBe(false)
  })
})

describe('mergeAbandon', () => {
  const event = (at: number, reason: 'user-stop' | 'user-restart' = 'user-restart') => ({
    pieceId: 'p',
    measureContextKey: 'k',
    occ: 3,
    at,
    reason,
  })

  it('unions events, drops duplicates and keeps the newest five in time order', () => {
    const local = { pieceId: 'p', measureContextKey: 'k', occ: 3, events: [event(10), event(30), event(50)] }
    const incoming = {
      pieceId: 'p',
      measureContextKey: 'k',
      occ: 3,
      events: [event(10), event(20), event(40), event(60, 'user-stop')],
    }
    expect(mergeAbandon(local, incoming).events.map((e) => e.at)).toEqual([20, 30, 40, 50, 60])
  })
})

describe('preferPackage', () => {
  it('replaces only when the incoming package carries more user input', () => {
    const plain = makePackage('v')
    const confirmed = makePackage('v', 't', { confirmed: true })
    const both = makePackage('v', 't', { confirmed: true, tempo: true })
    expect(preferPackage(plain, confirmed)).toBe(confirmed)
    expect(preferPackage(confirmed, plain)).toBe(confirmed)
    expect(preferPackage(confirmed, both)).toBe(both)
    expect(preferPackage(plain, makePackage('v', 'other'))).toBe(plain)
  })

  it('with equal user input follows the side whose piece records win', () => {
    const local = makePackage('v', 'local', { confirmed: true, tempo: true })
    const incoming = makePackage('v', 'incoming', { confirmed: true, tempo: true })
    expect(preferPackage(local, incoming, true)).toBe(incoming)
    expect(preferPackage(local, incoming, false)).toBe(local)
    // Never trade a reviewed package for an unreviewed one, whichever piece wins.
    expect(preferPackage(local, makePackage('v'), true)).toBe(local)
  })
})
