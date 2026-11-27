import { describe, expect, it } from 'vitest'
import { buildTimeline, type Timeline } from '../../core/engine'
import { buildScore, pos, type NoteSpec } from '../../core/engine/testkit'
import type { GroupOutcome } from '../../core/model/practice'
import type { AccidentalContext, ClefEvent, PerformedNote, ScoreModel } from '../../core/model/score'
import type { Spelling } from '../../core/music/pitch'
import { isHunting, pressCause } from './causes'

const C3 = 48
const D3 = 50
const E3 = 52
const Fs3 = 54
const G3 = 55
const A2 = 45
const C4 = 60
const Cs4 = 61
const D4 = 62
const E4 = 64
const F4 = 65
const Fs4 = 66
const G4 = 67
const A4 = 69
const Bb4 = 70
const B4 = 71
const C5 = 72
const Fs5 = 78
const C6 = 84
const C7 = 96

function withNotePatches(
  model: ScoreModel,
  patches: Readonly<
    Record<number, Partial<Pick<PerformedNote, 'accidentalContext' | 'written' | 'sounding' | 'clef'>>>
  >,
  clefs?: readonly ClefEvent[],
): ScoreModel {
  return {
    ...model,
    notes: model.notes.map((n, i) => (patches[i] ? { ...n, ...patches[i] } : n)),
    ...(clefs ? { clefs } : {}),
  }
}

function rightTimeline(model: ScoreModel): Timeline {
  return buildTimeline(model, {
    hands: 'right',
    range: { fromOcc: 0, toOcc: model.occurrences.length - 1 },
    multiplier: 1,
  })
}

function outcome(wrongPitches?: readonly number[], extraPitches?: readonly number[]): GroupOutcome {
  return {
    group: 0,
    wrongAttacks: wrongPitches?.length ?? 0,
    earlyAttacks: 0,
    lateMs: 0,
    ...(wrongPitches !== undefined ? { wrongPitches } : {}),
    ...(extraPitches !== undefined ? { extraPitches } : {}),
  }
}

describe('pressCause', () => {
  it('identifies jumped-ahead and lets it beat accidental, replayed-previous and other-hand', () => {
    // Bar 1: G major; group 0 = F4, group 1 = F♯4 (key-sig), group 2 = F4; LH plays F4 at group 1.
    const base = buildScore({
      notes: [
        { at: 0, midi: F4, hand: 'R' },
        { at: 1, midi: Fs4, hand: 'R' },
        { at: 1, midi: F4, hand: 'L' },
        { at: 2, midi: F4, hand: 'R' },
      ],
      bars: 1,
    })
    const keyG: AccidentalContext = { keyFifths: 1, carried: [] }
    const model = withNotePatches(base, { 1: { accidentalContext: keyG } })
    const timeline = rightTimeline(model)

    // At group 1 (F♯4), F4 is in next group (2), prev group (0), other hand (at 1), AND 1 semitone same-letter.
    expect(pressCause({ pitch: F4, group: 1, timeline, model })).toBe('jumped-ahead')

    // At group 0 (F4), pressing Fs4 (in group 1) is jumped-ahead.
    expect(pressCause({ pitch: Fs4, group: 0, timeline, model })).toBe('jumped-ahead')
  })

  it('identifies replayed-previous and lets it beat accidental and other-hand', () => {
    const base = buildScore({
      notes: [
        { at: 0, midi: F4, hand: 'R' },
        { at: 1, midi: Fs4, hand: 'R' },
        { at: 1, midi: F4, hand: 'L' },
        { at: 2, midi: A4, hand: 'R' },
      ],
      bars: 1,
    })
    const keyG: AccidentalContext = { keyFifths: 1, carried: [] }
    const model = withNotePatches(base, { 1: { accidentalContext: keyG } })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: F4, group: 1, timeline, model })).toBe('replayed-previous')
  })

  it('identifies other-hand in one-hand practice and ignores other-hand notes at other positions', () => {
    const model = buildScore({
      notes: [
        { at: 0, midi: C4, hand: 'R' },
        { at: 0, midi: C3, hand: 'L' }, // octave below R, but played by L at this position
        { at: 1, midi: E4, hand: 'R' },
        { at: 1, midi: G3, hand: 'L' },
      ],
      bars: 1,
    })
    const timeline = rightTimeline(model)

    // At group 0, C3 is in L at position 0 (also an octave from C4 -> other-hand wins).
    expect(pressCause({ pitch: C3, group: 0, timeline, model })).toBe('other-hand')
    // At group 0, G3 is in L at position 1, not position 0 -> not other-hand.
    expect(pressCause({ pitch: G3, group: 0, timeline, model })).toBeNull()
  })

  it('identifies key-signature misses for sharp and flat keys', () => {
    const base = buildScore({
      notes: [
        { at: 0, midi: Fs4 },
        { at: 1, midi: Bb4 },
      ],
      bars: 1,
    })
    const bbSpelling: Spelling = { step: 'B', alter: -1, octave: 4 }
    const model = withNotePatches(base, {
      0: { accidentalContext: { keyFifths: 1, carried: [] } },
      1: {
        written: bbSpelling,
        sounding: bbSpelling,
        accidentalContext: { keyFifths: -1, carried: [] },
      },
    })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: F4, group: 0, timeline, model })).toBe('key-signature')
    expect(pressCause({ pitch: B4, group: 1, timeline, model })).toBe('key-signature')
  })

  it('identifies printed-accidental for printed sharps and printed naturals', () => {
    const base = buildScore({
      notes: [
        { at: 0, midi: Fs4 }, // C major, printed F♯
        { at: 1, midi: A4 }, // spacer so group 0 and group 2 are not adjacent
        { at: 2, midi: F4 }, // G major, printed F♮ canceling key signature
      ],
      bars: 1,
    })
    const model = withNotePatches(base, {
      0: { accidentalContext: { keyFifths: 0, carried: [] } },
      2: { accidentalContext: { keyFifths: 1, carried: [] } },
    })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: F4, group: 0, timeline, model })).toBe('printed-accidental')
    expect(pressCause({ pitch: Fs4, group: 2, timeline, model })).toBe('printed-accidental')
  })

  it('identifies carried-accidental when an earlier accidental in the bar still applies', () => {
    const base = buildScore({
      notes: [
        { at: 0, midi: Fs4 }, // printed F♯
        { at: 1, midi: A4 }, // spacer so group 2 is not adjacent to group 0
        { at: 2, midi: Fs4 }, // carried F♯
      ],
      bars: 1,
    })
    const model = withNotePatches(base, {
      2: { accidentalContext: { keyFifths: 0, carried: [['F', 4, 1]] } },
    })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: F4, group: 2, timeline, model })).toBe('carried-accidental')
  })

  it('identifies stale-accidental only from the previous occurrence on the same staff', () => {
    // Bar 1 (occ 0): F♯5 on staff 0, C♯4 on staff 1.
    // Bar 2 (occ 1): plain F4 on staff 0, plain C4 on staff 0.
    // Bar 3 (occ 2): plain F4 on staff 0 (two bars after occ 0 -> not stale).
    const notes: NoteSpec[] = [
      { at: 0, midi: Fs5, staff: 0, hand: 'R' },
      { at: 0, midi: Cs4, staff: 1, hand: 'L' },
      { at: 4, midi: F4, staff: 0, hand: 'R' },
      { at: 5, midi: C4, staff: 0, hand: 'R' },
      { at: 8, midi: F4, staff: 0, hand: 'R' },
    ]
    const model = buildScore({ notes, bars: 3 })
    const timeline = rightTimeline(model)

    // Group 1 is bar 2's F4 (staff 0): previous bar had F♯5 on staff 0 -> stale-accidental.
    expect(pressCause({ pitch: Fs4, group: 1, timeline, model })).toBe('stale-accidental')
    // Group 2 is bar 2's C4 (staff 0): previous bar's C♯4 was on staff 1, not staff 0 -> null.
    expect(pressCause({ pitch: Cs4, group: 2, timeline, model })).toBeNull()
    // Group 3 is bar 3's F4 (staff 0): F♯5 was two bars ago (occ 0), not occ 1 -> null.
    expect(pressCause({ pitch: Fs4, group: 3, timeline, model })).toBeNull()
  })

  it('falls through from plain same-letter semitone slip to octave when a chord has an octave match', () => {
    // Chord [F4, F♯5] in C major, no previous bar: pressing F♯4 is 1 semitone from plain F4
    // (no accidental cause) and 12 semitones from F♯5 -> falls through to octave.
    const model = buildScore({
      notes: [
        { at: 0, midi: F4 },
        { at: 0, midi: Fs5 },
      ],
      bars: 1,
    })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: Fs4, group: 0, timeline, model })).toBe('octave')
  })

  it('identifies clef misreads right after a clef change (with key signature) and not without one', () => {
    // Staff 0 starts in F4 (occ 0), switches to G2 at bar 2 (occ 1).
    // At occ 1, occ 3 (2 bars after change), occ 4 (3 bars after change): B4 (middle line of G2;
    // middle line of F4 is D3, pitch class D).
    const base = buildScore({
      notes: [
        { at: 0, midi: G3, staff: 0, hand: 'R' },
        { at: 4, midi: B4, staff: 0, hand: 'R' }, // occ 1 (0 bars after change)
        { at: 12, midi: B4, staff: 0, hand: 'R' }, // occ 3 (2 bars after change)
        { at: 16, midi: B4, staff: 0, hand: 'R' }, // occ 4 (3 bars after change)
      ],
      bars: 5,
    })
    const clefs: ClefEvent[] = [
      { at: pos(0), occ: 0, staff: 0, clef: { sign: 'F', line: 4, octaveChange: 0 }, key: 'F4' },
      { at: pos(4), occ: 1, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
    ]
    const model = withNotePatches(
      base,
      { 0: { clef: 'F4' }, 1: { clef: 'G2' }, 2: { clef: 'G2' }, 3: { clef: 'G2' } },
      clefs,
    )
    const timeline = rightTimeline(model)

    // Right after clef change (occ 1): D3 or D4 (same pitch class D) -> clef.
    expect(pressCause({ pitch: D3, group: 1, timeline, model })).toBe('clef')
    expect(pressCause({ pitch: D4, group: 1, timeline, model })).toBe('clef')
    // 2 occurrences after change (occ 3): still clef.
    expect(pressCause({ pitch: D3, group: 2, timeline, model })).toBe('clef')
    // 3 occurrences after change (occ 4): too old -> null.
    expect(pressCause({ pitch: D3, group: 3, timeline, model })).toBeNull()

    // Without a clef change (only first clef G2): B4 pressed as D3 -> null.
    const noChange = buildScore({ notes: [{ at: 0, midi: B4 }], bars: 1 })
    expect(pressCause({ pitch: D3, group: 0, timeline: rightTimeline(noChange), model: noChange })).toBeNull()

    // Key signature applied to clef misread: G major, G2 -> F4 at occ 1; A2 (1st space of F4)
    // read in G2 is F (1st space of G2) + G major key sig = F♯.
    const baseKey = buildScore({
      notes: [
        { at: 0, midi: G4, staff: 0, hand: 'R' },
        { at: 4, midi: A2, staff: 0, hand: 'R' },
      ],
      bars: 2,
    })
    const keyModel = withNotePatches(baseKey, { 1: { clef: 'F4', accidentalContext: { keyFifths: 1, carried: [] } } }, [
      { at: pos(0), occ: 0, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
      { at: pos(4), occ: 1, staff: 0, clef: { sign: 'F', line: 4, octaveChange: 0 }, key: 'F4' },
    ])
    expect(pressCause({ pitch: Fs3, group: 1, timeline: rightTimeline(keyModel), model: keyModel })).toBe('clef')
    // Plain F4 does not match F♯ in G major.
    expect(pressCause({ pitch: F4, group: 1, timeline: rightTimeline(keyModel), model: keyModel })).toBeNull()
  })

  it('ignores unparseable clefs and restated identical clefs', () => {
    const base = buildScore({
      notes: [
        { at: 0, midi: C4, staff: 0, hand: 'R' },
        { at: 4, midi: B4, staff: 0, hand: 'R' },
      ],
      bars: 2,
    })
    const unparseable = withNotePatches(base, {}, [
      { at: pos(0), occ: 0, staff: 0, clef: { sign: 'percussion', line: 3, octaveChange: 0 }, key: 'percussion' },
      { at: pos(4), occ: 1, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
    ])
    expect(pressCause({ pitch: D3, group: 1, timeline: rightTimeline(unparseable), model: unparseable })).toBeNull()

    const restated = withNotePatches(base, {}, [
      { at: pos(0), occ: 0, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
      { at: pos(4), occ: 1, staff: 0, clef: { sign: 'G', line: 2, octaveChange: 0 }, key: 'G2' },
    ])
    expect(pressCause({ pitch: D3, group: 1, timeline: rightTimeline(restated), model: restated })).toBeNull()
  })

  it('identifies octave (12 or 24 semitones) and returns null otherwise', () => {
    const model = buildScore({ notes: [{ at: 0, midi: C4 }], bars: 1 })
    const timeline = rightTimeline(model)

    expect(pressCause({ pitch: C5, group: 0, timeline, model })).toBe('octave')
    expect(pressCause({ pitch: C3, group: 0, timeline, model })).toBe('octave')
    expect(pressCause({ pitch: C6, group: 0, timeline, model })).toBe('octave')
    expect(pressCause({ pitch: C7, group: 0, timeline, model })).toBeNull()
    expect(pressCause({ pitch: E3, group: 0, timeline, model })).toBeNull()
    expect(pressCause({ pitch: E4, group: 99, timeline, model })).toBeNull()
  })
})

describe('isHunting', () => {
  it('is true for two or more distinct wrong pitches not in extraPitches', () => {
    expect(isHunting(outcome([F4, G4], []))).toBe(true)
    expect(isHunting(outcome([F4, G4]))).toBe(true)
    expect(isHunting(outcome([F4, G4, A4], [G4]))).toBe(true)
  })

  it('is false for repeated same pitch, fewer than two non-extra pitches, or no wrong pitches', () => {
    expect(isHunting(outcome([F4, F4], []))).toBe(false)
    expect(isHunting(outcome([F4, G4], [G4]))).toBe(false)
    expect(isHunting(outcome([F4], []))).toBe(false)
    expect(isHunting(outcome([], []))).toBe(false)
    expect(isHunting(outcome(undefined, undefined))).toBe(false)
  })
})
