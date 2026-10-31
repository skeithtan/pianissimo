import { describe, expect, it } from 'vitest'
import { buildScore, quarters } from '../engine/testkit'
import { rat } from '../music/rational'
import {
  beatText,
  describePassage,
  edgeText,
  isWholeBars,
  lastOnsetIn,
  normalizePassage,
  onsetPositions,
  passageBounds,
  passageFromBounds,
  passageKey,
  positionText,
  samePassage,
} from './passage'

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const C3 = 48

/** Three 4/4 bars: right-hand quarters in bars 1–2, a left-hand half note on beat 3 of bar 1. */
const score = buildScore({
  notes: [
    ...[C4, D4, E4, F4, C4, D4, E4, F4].map((midi, at) => ({ at, midi })),
    { at: 2, dur: 2, midi: C3, hand: 'L' },
    { at: 9.5, dur: 0.5, midi: E4 },
  ],
  bars: 3,
})

describe('passage bounds and normalization (U21)', () => {
  it('whole bars span barline to barline; exact edges narrow them', () => {
    expect(passageBounds(score, null)).toEqual({ start: rat(0), end: rat(3) })
    expect(passageBounds(score, { fromOcc: 1, toOcc: 1 })).toEqual({ start: rat(1), end: rat(2) })
    expect(passageBounds(score, { fromOcc: 0, toOcc: 1, start: quarters(2), end: quarters(6) })).toEqual({
      start: quarters(2),
      end: quarters(6),
    })
    expect(() => passageBounds(score, { fromOcc: 0, toOcc: 0, start: quarters(3), end: quarters(2) })).toThrow(
      RangeError,
    )
  })

  it('builds passages from bounds, keeping edges only inside a bar', () => {
    expect(passageFromBounds(score, quarters(0), quarters(8))).toEqual({ fromOcc: 0, toOcc: 1 })
    expect(passageFromBounds(score, quarters(2), quarters(8))).toEqual({ fromOcc: 0, toOcc: 1, start: quarters(2) })
    expect(passageFromBounds(score, quarters(1), quarters(3))).toEqual({
      fromOcc: 0,
      toOcc: 0,
      start: quarters(1),
      end: quarters(3),
    })
    expect(passageFromBounds(score, quarters(3), quarters(3))).toBeNull()
  })

  it('normalizes stored and edited passages', () => {
    // Clamped and ordered bars, as before.
    expect(normalizePassage(score, { fromOcc: 5, toOcc: -2 })).toEqual({ fromOcc: 0, toOcc: 2 })
    expect(normalizePassage(score, null)).toBeNull()
    // An edge on a barline is dropped, so whole bars keep their key.
    expect(normalizePassage(score, { fromOcc: 1, toOcc: 1, start: quarters(4), end: quarters(8) })).toEqual({
      fromOcc: 1,
      toOcc: 1,
    })
    // An edge outside its bar (stale record) falls back to the whole bar.
    expect(normalizePassage(score, { fromOcc: 1, toOcc: 1, start: quarters(1) })).toEqual({ fromOcc: 1, toOcc: 1 })
    // Inverted edges keep the bars only.
    expect(normalizePassage(score, { fromOcc: 0, toOcc: 0, start: quarters(3), end: quarters(2) })).toEqual({
      fromOcc: 0,
      toOcc: 0,
    })
    // A garbage edge is ignored.
    expect(normalizePassage(score, { fromOcc: 0, toOcc: 0, start: { n: 1.5, d: 4 } })).toEqual({ fromOcc: 0, toOcc: 0 })
    const sub = { fromOcc: 0, toOcc: 1, start: quarters(1), end: quarters(6) }
    expect(normalizePassage(score, sub)).toEqual(sub)
    expect(isWholeBars(sub)).toBe(false)
  })

  it('compares exact edges by value', () => {
    expect(samePassage({ fromOcc: 0, toOcc: 0 }, { fromOcc: 0, toOcc: 0 })).toBe(true)
    expect(samePassage({ fromOcc: 0, toOcc: 0, start: rat(1, 4) }, { fromOcc: 0, toOcc: 0, start: rat(2, 8) })).toBe(
      true,
    )
    expect(samePassage({ fromOcc: 0, toOcc: 0, start: rat(1, 4) }, { fromOcc: 0, toOcc: 0 })).toBe(false)
    expect(samePassage(null, null)).toBe(true)
    expect(samePassage(null, { fromOcc: 0, toOcc: 0 })).toBe(false)
  })

  it('keys whole bars exactly as before and note-level loops apart', () => {
    expect(passageKey({ fromOcc: 4, toOcc: 7 })).toBe('4-7')
    expect(passageKey({ fromOcc: 4, toOcc: 7, start: rat(17, 4) })).toBe('4-7@17/4..')
    expect(passageKey({ fromOcc: 4, toOcc: 7, end: rat(15, 2) })).toBe('4-7@..15/2')
    expect(passageKey({ fromOcc: 4, toOcc: 7, start: rat(17, 4), end: rat(15, 2) })).toBe('4-7@17/4..15/2')
  })
})

describe('passage words (U22)', () => {
  it('counts beats in the meter, with fractions and pickups', () => {
    expect(beatText(score, quarters(0))).toBe('1')
    expect(beatText(score, quarters(6))).toBe('3')
    expect(beatText(score, quarters(9.5))).toBe('2½')
    expect(beatText(score, rat(13, 48))).toBe('2.08')
    const compound = buildScore({ notes: [{ at: 0, dur: 3, midi: C4 }], meter: [6, 8] })
    // 6/8 counts dotted quarters: the second half of the bar is beat 2.
    expect(beatText(compound, rat(3, 8))).toBe('2')
    const built = buildScore({ notes: [{ at: 0, midi: C4 }], bars: [1, 4] })
    const pickup = { ...built, sourceMeasures: built.sourceMeasures.map((m, i) => ({ ...m, implicit: i === 0 })) }
    // A one-quarter pickup in 4/4 sits on beat 4.
    expect(beatText(pickup, quarters(0))).toBe('4')
    expect(positionText(score, quarters(6))).toBe('Bar 2, beat 3')
  })

  it('collects the hands’ onsets and finds a loop’s last note', () => {
    expect(onsetPositions(score, 'left')).toEqual([quarters(2)])
    expect(onsetPositions(score, 'right')).toHaveLength(9)
    expect(onsetPositions(score, 'none')).toEqual(onsetPositions(score, 'both'))
    expect(lastOnsetIn(score, 'right', quarters(0), quarters(3))).toEqual(quarters(2))
    expect(lastOnsetIn(score, 'left', quarters(4), quarters(8))).toEqual(quarters(4))
  })

  it('never snaps to cue notes (I13)', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 1, midi: 62, cue: true },
        { at: 2, midi: 64 },
      ],
    })
    expect(onsetPositions(m, 'both')).toEqual([quarters(0), quarters(2)])
  })

  it('describes whole bars as before and note-level loops by their notes', () => {
    expect(describePassage(score, null)).toBe('Whole piece')
    expect(describePassage(score, { fromOcc: 1, toOcc: 1 })).toBe('Bar 2')
    expect(describePassage(score, { fromOcc: 0, toOcc: 2 })).toBe('Bars 1–3')
    expect(describePassage(score, { fromOcc: 0, toOcc: 1, start: quarters(2) })).toBe('Bar 1, beat 3 – bar 2')
    expect(describePassage(score, { fromOcc: 0, toOcc: 1, end: quarters(6) })).toBe('Bar 1 – bar 2, beat 2')
    expect(describePassage(score, { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(3) })).toBe(
      'Bar 1, beats 2–3',
    )
    expect(describePassage(score, { fromOcc: 0, toOcc: 0, start: quarters(1), end: quarters(2) })).toBe('Bar 1, beat 2')
    expect(edgeText(score, { fromOcc: 0, toOcc: 1, start: quarters(2) }, 'start', 'right')).toBe('Bar 1, beat 3')
    expect(edgeText(score, { fromOcc: 0, toOcc: 1, start: quarters(2) }, 'end', 'right')).toBe('Bar 2')
    expect(edgeText(score, { fromOcc: 0, toOcc: 1, end: quarters(7) }, 'end', 'right')).toBe('Bar 2, beat 3')
  })
})
