import { describe, expect, it } from 'vitest'
import { formatHash, parseHash, readHistoryState, sameBase, sameRoute, type Route } from './routes'

describe('parseHash', () => {
  it('maps the documented hashes to routes', () => {
    expect(parseHash('')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#/')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#/practice/p1')).toEqual({ view: 'practice', pieceId: 'p1', overlay: null })
    expect(parseHash('#/practice')).toEqual({ view: 'practice', overlay: null })
    expect(parseHash('#/results/p1')).toEqual({ view: 'results', pieceId: 'p1', overlay: null })
    expect(parseHash('#/results/p1/a9')).toEqual({ view: 'results', pieceId: 'p1', attemptId: 'a9', overlay: null })
    expect(parseHash('#/consult/p1')).toEqual({ view: 'consult', pieceId: 'p1', overlay: null })
    expect(parseHash('#/consult')).toEqual({ view: 'consult', overlay: null })
    expect(parseHash('#/consult/p1?settings')).toEqual({ view: 'consult', pieceId: 'p1', overlay: 'settings' })
  })

  it('reads overlays from the query and the #/settings, #/connection aliases', () => {
    expect(parseHash('#/?settings')).toEqual({ view: 'library', overlay: 'settings' })
    expect(parseHash('#/practice/p1?connection')).toEqual({ view: 'practice', pieceId: 'p1', overlay: 'connection' })
    expect(parseHash('#/results/p1/a9?settings')).toEqual({
      view: 'results',
      pieceId: 'p1',
      attemptId: 'a9',
      overlay: 'settings',
    })
    expect(parseHash('#/connection')).toEqual({ view: 'library', overlay: 'connection' })
    expect(parseHash('#/settings')).toEqual({ view: 'library', overlay: 'settings' })
  })

  it('accepts a missing leading # and slash, and a trailing slash', () => {
    expect(parseHash('/practice/p1/')).toEqual({ view: 'practice', pieceId: 'p1', overlay: null })
    expect(parseHash('practice/p1')).toEqual({ view: 'practice', pieceId: 'p1', overlay: null })
  })

  it('falls back to the Library for anything unknown, never throwing', () => {
    expect(parseHash('#/nonsense')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#/library/p1')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#/?bogus&settings')).toEqual({ view: 'library', overlay: 'settings' })
    expect(parseHash('#//??')).toEqual({ view: 'library', overlay: null })
    expect(parseHash('#/practice/%E0%A4%A')).toEqual({ view: 'practice', pieceId: '%E0%A4%A', overlay: null })
  })

  it('decodes percent-encoded ids', () => {
    expect(parseHash('#/practice/a%2Fb%20c')).toEqual({ view: 'practice', pieceId: 'a/b c', overlay: null })
  })
})

describe('formatHash', () => {
  it('writes the canonical form', () => {
    expect(formatHash({ view: 'library', overlay: null })).toBe('#/')
    expect(formatHash({ view: 'practice', pieceId: 'p1', overlay: null })).toBe('#/practice/p1')
    expect(formatHash({ view: 'practice', overlay: null })).toBe('#/practice')
    expect(formatHash({ view: 'consult', pieceId: 'p1', overlay: null })).toBe('#/consult/p1')
    expect(formatHash({ view: 'consult', pieceId: 'p1', overlay: 'settings' })).toBe('#/consult/p1?settings')
    expect(formatHash({ view: 'consult', overlay: null })).toBe('#/consult')
    expect(formatHash({ view: 'results', pieceId: 'p1', attemptId: 'a9', overlay: null })).toBe('#/results/p1/a9')
    expect(formatHash({ view: 'library', overlay: 'connection' })).toBe('#/?connection')
    expect(formatHash({ view: 'practice', pieceId: 'p1', overlay: 'settings' })).toBe('#/practice/p1?settings')
  })

  it('never writes an attempt without a piece, and encodes ids', () => {
    expect(formatHash({ view: 'results', attemptId: 'a9', overlay: null })).toBe('#/results')
    expect(formatHash({ view: 'practice', pieceId: 'a/b c?', overlay: null })).toBe('#/practice/a%2Fb%20c%3F')
  })

  it('round-trips through parseHash', () => {
    const routes: Route[] = [
      { view: 'library', overlay: null },
      { view: 'library', overlay: 'settings' },
      { view: 'practice', pieceId: 'id with / and ? and #', overlay: 'connection' },
      { view: 'practice', overlay: null },
      { view: 'results', pieceId: '8f5c-1', attemptId: 'x y', overlay: null },
      { view: 'results', pieceId: '8f5c-1', overlay: 'settings' },
    ]
    for (const route of routes) expect(parseHash(formatHash(route))).toEqual(route)
  })
})

describe('route comparison', () => {
  it('sameBase ignores the overlay and, for the Library, any ids', () => {
    expect(sameBase({ view: 'library', overlay: null }, { view: 'library', overlay: 'settings' })).toBe(true)
    expect(
      sameBase(
        { view: 'practice', pieceId: 'a', overlay: null },
        { view: 'practice', pieceId: 'a', overlay: 'settings' },
      ),
    ).toBe(true)
    expect(
      sameBase({ view: 'practice', pieceId: 'a', overlay: null }, { view: 'practice', pieceId: 'b', overlay: null }),
    ).toBe(false)
    expect(sameBase({ view: 'practice', overlay: null }, { view: 'results', overlay: null })).toBe(false)
    expect(
      sameBase(
        { view: 'consult', pieceId: 'a', overlay: null },
        { view: 'consult', pieceId: 'a', overlay: 'settings' },
      ),
    ).toBe(true)
    expect(
      sameBase({ view: 'consult', pieceId: 'a', overlay: null }, { view: 'practice', pieceId: 'a', overlay: null }),
    ).toBe(false)
    expect(
      sameBase(
        { view: 'results', pieceId: 'a', attemptId: '1', overlay: null },
        { view: 'results', pieceId: 'a', overlay: null },
      ),
    ).toBe(false)
  })

  it('sameRoute also compares the overlay', () => {
    const a: Route = { view: 'practice', pieceId: 'a', overlay: null }
    expect(sameRoute(a, { ...a })).toBe(true)
    expect(sameRoute(a, { ...a, overlay: 'connection' })).toBe(false)
  })
})

describe('readHistoryState', () => {
  it('keeps a valid preset and the overlay flag', () => {
    const preset = { passage: { fromOcc: 2, toOcc: 5 }, hands: 'right', multiplier: 0.75 }
    expect(readHistoryState({ preset, overlayFrom: true })).toEqual({ preset, overlayFrom: true })
  })

  it('drops anything foreign, stale or malformed', () => {
    expect(readHistoryState(null)).toEqual({})
    expect(readHistoryState('x')).toEqual({})
    expect(readHistoryState({ preset: { hands: 'both', passage: { fromOcc: 'a' }, multiplier: Number.NaN } })).toEqual({
      preset: { hands: 'both' },
    })
    expect(readHistoryState({ preset: { hands: 'nope' }, overlayFrom: 'yes' })).toEqual({})
  })
})
