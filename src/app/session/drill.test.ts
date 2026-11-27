import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../../core/engine'
import { buildScore, quarters } from '../../core/engine/testkit'
import { rat } from '../../core/music/rational'
import { drillRange } from './drill'

describe('drillRange', () => {
  // Two 4/4 bars of eighth notes: 16 onsets at 0, 0.5, 1, ..., 7.5 quarters (pitches 60..75).
  const eighths = buildScore({
    notes: Array.from({ length: 16 }, (_, i) => ({
      at: i * 0.5,
      dur: 0.5,
      midi: 60 + i,
    })),
    bars: 2,
  })

  it('loops from two onsets before the spot to the end of the onset after it inside a bar', () => {
    // Spot at index 3 (at 1.5 quarters, midi 63): onsets 1..4 (at 0.5, 1, 1.5, 2), exclusive end at onset 5 (2.5).
    // Passing a fresh Rational with equivalent value (6/16 === 3/8) also checks value equality.
    const range = drillRange(eighths, 'both', rat(6, 16))
    expect(range).toEqual({
      fromOcc: 0,
      toOcc: 0,
      start: quarters(0.5),
      end: quarters(2.5),
    })

    const timeline = buildTimeline(eighths, { hands: 'both', range, multiplier: 1 })
    expect(timeline.groups.map((g) => g.pitches)).toEqual([[61], [62], [63], [64]])
  })

  it('starts at the first onset when drilling the first or second onset', () => {
    // First onset (index 0, at 0 quarters): onsets 0, 1; exclusive end at onset 2 (1 quarter).
    // Start falls on barline 0, so `start` is omitted.
    expect(drillRange(eighths, 'both', quarters(0))).toEqual({
      fromOcc: 0,
      toOcc: 0,
      end: quarters(1),
    })

    // Second onset (index 1, at 0.5 quarters): onsets 0, 1, 2; exclusive end at onset 3 (1.5 quarters).
    expect(drillRange(eighths, 'both', quarters(0.5))).toEqual({
      fromOcc: 0,
      toOcc: 0,
      end: quarters(1.5),
    })
  })

  it('extends to the end of the piece for the last and second-to-last onsets', () => {
    // Last onset (index 15, at 7.5 quarters): onsets 13, 14, 15 (6.5, 7, 7.5); end is piece end (barline, omitted).
    const lastRange = drillRange(eighths, 'both', quarters(7.5))
    expect(lastRange).toEqual({
      fromOcc: 1,
      toOcc: 1,
      start: quarters(6.5),
    })
    const lastTimeline = buildTimeline(eighths, { hands: 'both', range: lastRange, multiplier: 1 })
    expect(lastTimeline.groups.map((g) => g.pitches)).toEqual([[73], [74], [75]])

    // Second-to-last onset (index 14, at 7 quarters): onsets 12, 13, 14, 15 (6..7.5); end is piece end (omitted).
    expect(drillRange(eighths, 'both', quarters(7))).toEqual({
      fromOcc: 1,
      toOcc: 1,
      start: quarters(6),
    })
  })

  it('keeps at least two onsets when the piece has only two onsets', () => {
    const twoNotes = buildScore({
      notes: [
        { at: 0, midi: 60 },
        { at: 2, midi: 64 },
      ],
      bars: 1,
    })
    expect(drillRange(twoNotes, 'both', quarters(0))).toEqual({ fromOcc: 0, toOcc: 0 })
    expect(drillRange(twoNotes, 'both', quarters(2))).toEqual({ fromOcc: 0, toOcc: 0 })
  })

  it('spans two bars when the spot is near a barline', () => {
    // Spot at index 8 (bar 2 beat 1, 4 quarters, midi 68):
    // two before = index 6 (bar 1, 3 quarters), one after = index 9 (bar 2, 4.5 quarters),
    // exclusive end = index 10 (bar 2, 5 quarters).
    const range = drillRange(eighths, 'both', quarters(4))
    expect(range).toEqual({
      fromOcc: 0,
      toOcc: 1,
      start: quarters(3),
      end: quarters(5),
    })
    const timeline = buildTimeline(eighths, { hands: 'both', range, multiplier: 1 })
    expect(timeline.groups.map((g) => g.pitches)).toEqual([[66], [67], [68], [69]])
  })

  it('counts only onsets of the selected hand when the other hand has notes in between', () => {
    // Right hand plays quarter notes (0, 1, 2, 3, 4, 5), left hand plays extra eighth notes in between.
    const twoHands = buildScore({
      notes: [
        { at: 0, midi: 60, hand: 'R' },
        { at: 0.5, dur: 0.5, midi: 48, hand: 'L' },
        { at: 1, midi: 62, hand: 'R' },
        { at: 1.5, dur: 0.5, midi: 50, hand: 'L' },
        { at: 2, midi: 64, hand: 'R' },
        { at: 2.5, dur: 0.5, midi: 52, hand: 'L' },
        { at: 3, midi: 65, hand: 'R' },
        { at: 3.5, dur: 0.5, midi: 53, hand: 'L' },
        { at: 4, midi: 67, hand: 'R' },
        { at: 5, midi: 69, hand: 'R' },
      ],
      bars: 2,
    })

    // Spot at 3 quarters (R index 3, midi 65): two R onsets before = 1 quarter (midi 62),
    // one R onset after = 4 quarters (midi 67), exclusive end = R onset at 5 quarters.
    const rightRange = drillRange(twoHands, 'right', quarters(3))
    expect(rightRange).toEqual({
      fromOcc: 0,
      toOcc: 1,
      start: quarters(1),
      end: quarters(5),
    })
    const rightTimeline = buildTimeline(twoHands, { hands: 'right', range: rightRange, multiplier: 1 })
    expect(rightTimeline.groups.map((g) => g.pitches)).toEqual([[62], [64], [65], [67]])

    // Left-hand-only position is not an onset for the right hand.
    expect(drillRange(twoHands, 'right', quarters(1.5))).toBeNull()

    // 'none' is treated as both hands (matches onsetPositions).
    expect(drillRange(twoHands, 'none', quarters(1.5))).toEqual(drillRange(twoHands, 'both', quarters(1.5)))
  })

  it('drops start and end when they fall on barlines', () => {
    // 4/4 quarter notes across 2 bars: onsets at 0, 1, 2, 3, 4, 5, 6, 7.
    // Spot at 2 quarters (index 2): start = index 0 (0, bar 1 start), end = index 4 (4, bar 1 end / bar 2 start).
    const quartersScore = buildScore({
      notes: Array.from({ length: 8 }, (_, i) => ({ at: i, midi: 60 + i })),
      bars: 2,
    })
    const range = drillRange(quartersScore, 'both', quarters(2))
    expect(range).toEqual({ fromOcc: 0, toOcc: 0 })
    expect(range).not.toHaveProperty('start')
    expect(range).not.toHaveProperty('end')
  })

  it('returns null when position is not an onset or the piece has fewer than two onsets', () => {
    expect(drillRange(eighths, 'both', quarters(0.25))).toBeNull()
    expect(drillRange(eighths, 'both', quarters(8))).toBeNull()

    const single = buildScore({
      notes: [{ at: 0, midi: 60 }],
      bars: 1,
    })
    expect(drillRange(single, 'both', quarters(0))).toBeNull()

    const empty = buildScore({ notes: [], bars: 1 })
    expect(drillRange(empty, 'both', quarters(0))).toBeNull()
  })
})
