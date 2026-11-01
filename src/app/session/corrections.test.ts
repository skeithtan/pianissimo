import { describe, expect, it } from 'vitest'
import type { Timeline } from '../../core/engine'
import type { AttemptRecord, GroupOutcome, PassageRange } from '../../core/model/practice'
import type { NamingSettings } from '../../core/model/settings'
import type { Step } from '../../core/music/pitch'
import { type Rational, rat } from '../../core/music/rational'
import { LATE_MARK_MS, SPREAD_MARK_MS, correctionMarks, type CorrectionScore } from './corrections'

const NAMING: NamingSettings = {
  system: 'letter',
  seventh: 'si',
  showOctave: false,
  alwaysShowEffectiveAccidentals: true,
  simplifyEnharmonics: false,
}

/** A performed note with only the fields `correctionMarks` reads. */
const note = (onset: Rational, step: Step, alter: number, octave: number, keyFifths = 0) => ({
  onset,
  sounding: { step, alter, octave },
  ottavaShift: 0,
  accidentalContext: { keyFifths, carried: [] },
})

/** Two bars of a whole note each. */
const score = {
  occurrences: [
    { start: rat(0), duration: rat(1) },
    { start: rat(1), duration: rat(1) },
  ],
  totalDuration: rat(2),
  notes: [
    note(rat(0), 'F', 1, 4), // 0: F♯4
    note(rat(1, 4), 'C', 0, 4), // 1: C4 } a chord
    note(rat(1, 4), 'E', 0, 5), // 2: E5 }
    note(rat(1, 2), 'F', 0, 4, 1), // 3: F♮4 in G major
    note(rat(3, 4), 'B', -1, 4), // 4: B♭4
    note(rat(1), 'C', 0, 5), // 5: C5, bar 2
    note(rat(3, 2), 'D', 0, 5), // 6: D5, bar 2
  ],
} as unknown as CorrectionScore

/** Only the fields `correctionMarks` reads. */
const timeline = {
  groups: [
    { notes: [0], pitches: [66], notesByPitch: [[0]] },
    { notes: [1, 2], pitches: [60, 76], notesByPitch: [[1], [2]] },
    { notes: [3], pitches: [65], notesByPitch: [[3]] },
    { notes: [4], pitches: [70], notesByPitch: [[4]] },
    { notes: [5], pitches: [72], notesByPitch: [[5]] },
    // A tie continuation sounding into bar 2 from note 4 (whose head is in bar 1), with note 6.
    { notes: [4, 6], pitches: [70, 74], notesByPitch: [[4], [6]] },
  ],
} as unknown as Timeline

const WHOLE: PassageRange = { fromOcc: 0, toOcc: 1 }
const record = (groups?: GroupOutcome[], passage: PassageRange = WHOLE): AttemptRecord =>
  ({ groups, context: { passage } }) as unknown as AttemptRecord
const outcome = (
  group: number,
  wrongAttacks: number,
  earlyAttacks: number,
  lateMs: number,
  extra: Partial<GroupOutcome> = {},
): GroupOutcome => ({ group, wrongAttacks, earlyAttacks, lateMs, ...extra })
const marks = (groups: GroupOutcome[], naming = NAMING, passage = WHOLE) =>
  correctionMarks(record(groups, passage), timeline, score, naming)

describe('correctionMarks', () => {
  it('gives one mark per group with a problem, the worst one: wrong, then too soon, then too late', () => {
    expect(
      marks([
        outcome(0, 0, 0, 0),
        outcome(1, 3, 1, 900), // two wrong keys and an early press, late too: wrong wins
        outcome(2, 1, 1, 900), // only an early press (counted in wrongAttacks): too soon
        outcome(3, 0, 0, LATE_MARK_MS),
      ]),
    ).toEqual([
      { notes: [1, 2], kind: 'wrong', text: 'Wrong notes' },
      { notes: [3], kind: 'early', text: 'Too soon' },
      { notes: [4], kind: 'late', text: 'Too late' },
    ])
  })

  it('a single wrong key is singular; a little late is not marked', () => {
    expect(marks([outcome(0, 1, 0, 0), outcome(2, 0, 0, LATE_MARK_MS - 1)])).toEqual([
      { notes: [0], kind: 'wrong', text: 'Wrong note' },
    ])
  })

  it('the first group, reported 0 ms late by the engine, gets no late mark', () => {
    expect(marks([outcome(0, 0, 0, 0)])).toEqual([])
  })

  it('older records without per-group outcomes and unknown groups give no marks', () => {
    expect(correctionMarks(record(), timeline, score, NAMING)).toEqual([])
    expect(marks([outcome(9, 2, 0, 0)])).toEqual([])
  })

  describe('naming the slip', () => {
    it('one semitone off on the same letter is a wrong accidental, naming the target as the score spells it', () => {
      expect(
        marks([
          outcome(0, 1, 0, 0, { wrongPitches: [65] }), // F for F♯
          outcome(2, 1, 0, 0, { wrongPitches: [66] }), // F♯ for F♮ (G major: the natural is shown)
          outcome(3, 1, 0, 0, { wrongPitches: [71] }), // B for B♭
        ]),
      ).toEqual([
        { notes: [0], kind: 'accidental', text: 'F♯, not F' },
        { notes: [3], kind: 'accidental', text: 'F♮, not F♯' },
        { notes: [4], kind: 'accidental', text: 'B♭, not B' },
      ])
    })

    it('honors the naming settings (fixed do, octaves)', () => {
      const naming: NamingSettings = { ...NAMING, system: 'fixed-do', showOctave: true }
      expect(marks([outcome(0, 1, 0, 0, { wrongPitches: [65] })], naming)).toEqual([
        { notes: [0], kind: 'accidental', text: 'fa♯4, not fa4' },
      ])
    })

    it('one semitone off on another letter is a plain wrong key', () => {
      // A (69) for B♭ (70): a semitone, but A is not a B.
      expect(marks([outcome(3, 1, 0, 0, { wrongPitches: [69] })])).toEqual([
        { notes: [4], kind: 'wrong', text: 'Wrong note' },
      ])
    })

    it('twelve or twenty-four semitones off is a wrong octave, with the way to the right one', () => {
      expect(
        marks([
          outcome(0, 1, 0, 0, { wrongPitches: [54] }), // F♯3 for F♯4: up
          outcome(1, 1, 0, 0, { wrongPitches: [84] }), // C6: E5 is not an octave, C4 two octaves down
          outcome(4, 1, 0, 0, { wrongPitches: [61] }), // 11 off: plain wrong
        ]),
      ).toEqual([
        { notes: [0], kind: 'octave', text: 'Wrong octave ↑' },
        { notes: [1, 2], kind: 'octave', text: 'Wrong octave ↓' },
        { notes: [5], kind: 'wrong', text: 'Wrong note' },
      ])
    })

    it('several wrong keys take an accidental over an octave over plain wrong, else plain wrong', () => {
      expect(
        marks([
          outcome(1, 3, 0, 0, { wrongPitches: [62, 48, 59] }), // other, octave (C3 for C4), B by C (a semitone, not a C)
          outcome(0, 3, 0, 0, { wrongPitches: [50, 78, 65] }), // other, octave (F♯5), accidental (F)
          outcome(4, 2, 0, 0, { wrongPitches: [50, 51] }),
        ]),
      ).toEqual([
        { notes: [1, 2], kind: 'octave', text: 'Wrong octave ↑' },
        { notes: [0], kind: 'accidental', text: 'F♯, not F' },
        { notes: [5], kind: 'wrong', text: 'Wrong notes' },
      ])
    })

    it('the wrong pitches, when recorded, are the count of plain wrong keys', () => {
      // Tie-end presses in `wrongAttacks` are not wrong keys.
      expect(marks([outcome(0, 2, 0, 0, { wrongPitches: [], tieEndPresses: 2 })])).toEqual([
        { notes: [0], kind: 'tie', text: 'Tied, hold it' },
      ])
      // Without wrong pitches (the engine before them), tie-end presses are taken off too.
      expect(marks([outcome(0, 2, 0, 0, { tieEndPresses: 2 })])).toEqual([
        { notes: [0], kind: 'tie', text: 'Tied, hold it' },
      ])
    })
  })

  it('a chord spread over SPREAD_MARK_MS or more is marked "Together"; a single note never', () => {
    expect(
      marks([
        outcome(0, 0, 0, 0, { spreadMs: 500 }), // one note: no chord to spread
        outcome(1, 0, 0, 0, { spreadMs: SPREAD_MARK_MS }),
        outcome(5, 0, 0, 0, { spreadMs: SPREAD_MARK_MS - 1 }),
      ]),
    ).toEqual([{ notes: [1, 2], kind: 'spread', text: 'Together' }])
  })

  it('a re-attacked tie is "Tied, hold it"', () => {
    expect(marks([outcome(2, 0, 0, 0, { tieEndPresses: 1 })])).toEqual([
      { notes: [3], kind: 'tie', text: 'Tied, hold it' },
    ])
  })

  it('priority: accidental > octave > wrong > tie > spread > early > late', () => {
    const all = { spreadMs: 400, tieEndPresses: 1 }
    const first = (o: GroupOutcome) => marks([o])[0]?.kind
    expect(first(outcome(1, 4, 1, 900, { ...all, wrongPitches: [59, 48, 62] }))).toBe('octave')
    expect(first(outcome(0, 4, 1, 900, { ...all, wrongPitches: [54, 65, 62] }))).toBe('accidental')
    expect(first(outcome(1, 2, 1, 900, { ...all, wrongPitches: [62] }))).toBe('wrong')
    expect(first(outcome(1, 1, 1, 900, { ...all, wrongPitches: [] }))).toBe('tie')
    expect(first(outcome(1, 1, 1, 900, { ...all, tieEndPresses: 0 }))).toBe('spread')
    expect(first(outcome(1, 1, 1, 900, { spreadMs: 10 }))).toBe('early')
    expect(first(outcome(1, 0, 0, 900, { spreadMs: 10 }))).toBe('late')
  })

  it('never rings notes outside the attempt passage; a mark with none left is dropped', () => {
    // A loop on bar 2: the tie head (note 4, bar 1) is outside, its partner (note 6) inside.
    const bar2: PassageRange = { fromOcc: 1, toOcc: 1 }
    expect(marks([outcome(3, 1, 0, 0), outcome(4, 1, 0, 0), outcome(5, 1, 0, 0)], NAMING, bar2)).toEqual([
      { notes: [5], kind: 'wrong', text: 'Wrong note' },
      { notes: [6], kind: 'wrong', text: 'Wrong note' },
    ])
    // An exact loop start inside bar 2 (after C5) drops the C5 group.
    expect(marks([outcome(4, 1, 0, 0)], NAMING, { fromOcc: 1, toOcc: 1, start: rat(5, 4) })).toEqual([])
    // A passage that does not fit the score filters nothing.
    expect(marks([outcome(0, 1, 0, 0)], NAMING, { fromOcc: 4, toOcc: 7 })).toEqual([
      { notes: [0], kind: 'wrong', text: 'Wrong note' },
    ])
  })
})
