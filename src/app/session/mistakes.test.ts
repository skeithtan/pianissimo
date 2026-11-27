import { afterEach, describe, expect, it } from 'vitest'
import { EngineDriver, buildScore, type NoteSpec } from '../../core/engine/testkit'
import { buildTimeline, type Timeline } from '../../core/engine'
import { SpotMemory, type SpotVisit } from '../../core/history'
import { DEFAULT_SETTINGS, type NamingSettings } from '../../core/model/settings'
import { handAssignmentId, type AttemptRecord } from '../../core/model/practice'
import type { ScoreModel } from '../../core/model/score'
import en from '../../i18n/locales/en-US.json'
import fr from '../../i18n/locales/fr-FR.json'
import { readMessagesWith } from '../../i18n/messages'
import { REPEATED_MISTAKE_PASSES, repeatedMistakeLine, repeatedMistakes, type RepeatedMistake } from './mistakes'
import {
  passesText,
  patternLine,
  patternLines,
  pressGhost,
  rankMistakes,
  wrongPressLine,
  type GroupMark,
  type WrongPress,
} from './ranking'

afterEach(() => readMessagesWith(() => ({ language: 'en-US', strings: {} })))

const naming = DEFAULT_SETTINGS.naming
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const Fs4 = 66
const G4 = 67

// Bar 1: C D E F♯ (F♯ spelled as a sharp in the score).
const notes: NoteSpec[] = [C4, D4, E4, Fs4].map((midi, at) => ({ at, midi }))
const model = buildScore({ notes, bars: 1 })
const timeline = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })

/** Scored passes over bar 1; `wrong[i]` = keys pressed (before the right one) at group i, per pass. */
function passes(
  ...plans: (readonly (readonly number[])[] | 'stop-after-1' | 'abandon-at-3' | 'abandon-at-3-with-G4')[]
): AttemptRecord[] {
  const d = new EngineDriver(timeline, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
  plans.forEach((plan, i) => {
    if (i > 0) {
      d.engine.restart(d.now)
      d.engine.markPrepared(d.now)
    }
    if (plan === 'stop-after-1') {
      d.tap(C4)
      d.engine.interrupt('user-restart', d.now)
      return
    }
    if (plan === 'abandon-at-3' || plan === 'abandon-at-3-with-G4') {
      for (let gi = 0; gi < 3; gi++) {
        d.wait(300)
        d.tap(...timeline.groups[gi]!.pitches)
      }
      if (plan === 'abandon-at-3-with-G4') {
        d.wait(300)
        d.tap(G4)
      }
      d.engine.interrupt('user-restart', d.now)
      return
    }
    timeline.groups.forEach((g, gi) => {
      d.wait(300)
      const wrong = plan[gi] ?? []
      if (wrong.length > 0) {
        for (const k of wrong) d.tap(k)
        d.wait(100)
      }
      d.tap(...g.pitches)
    })
  })
  return d.records()
}

/** Fold `records` into a SpotMemory and return the per-group visit map for `tl`. */
function spotsOf(
  records: readonly AttemptRecord[],
  tl: Timeline = timeline,
  m: ScoreModel = model,
): ReadonlyMap<number, readonly SpotVisit[]> {
  const mem = new SpotMemory({
    scoreVersionId: m.scoreVersionId,
    handsId: handAssignmentId(m.hands),
    hands: tl.hands,
  })
  for (const r of records) mem.fold(r, tl, true)
  const out = new Map<number, readonly SpotVisit[]>()
  for (let i = 0; i < tl.groups.length; i++) {
    const visits = mem.history(tl.groups[i]!.position)
    if (visits.length > 0) out.set(i, visits)
  }
  return out
}

const slipAtFsharp = [[], [], [], [F4]] as const

describe('repeatedMistakes', () => {
  const repeated = (records: readonly AttemptRecord[], tl: Timeline = timeline, m: ScoreModel = model) =>
    repeatedMistakes(records.at(-1), tl, m, spotsOf(records, tl, m))

  it(`names the same wrong key at the same group in ${REPEATED_MISTAKE_PASSES} passes running`, () => {
    const records = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp)
    expect(repeated(records.slice(0, 2))).toEqual([])
    expect(repeated(records)).toEqual<RepeatedMistake[]>([
      {
        group: 3,
        occ: 0,
        bar: '1',
        expectedPitches: [Fs4],
        expectedPitch: Fs4,
        expectedNote: timeline.groups[3]!.notes[0]!,
        wrongPitch: F4,
        passes: 3,
        together: false,
      },
    ])
  })

  it('counts every pass running, and a clean pass at the group ends the count', () => {
    const four = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp, slipAtFsharp)
    expect(repeated(four)[0]?.passes).toBe(4)
    const broken = passes(slipAtFsharp, slipAtFsharp, [], slipAtFsharp, slipAtFsharp)
    expect(repeated(broken)).toEqual([])
  })

  it('a pass stopped before the group neither counts nor breaks; another wrong key does not count', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, 'stop-after-1', slipAtFsharp)
    expect(repeated(records)[0]?.passes).toBe(3)
    const other = passes(slipAtFsharp, [[], [], [], [G4]], slipAtFsharp)
    expect(repeated(other)).toEqual([])
  })

  it('a pass abandoned while sitting on the group with no presses neither breaks a run nor inflates passesReached', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, 'abandon-at-3', slipAtFsharp)
    // Confirm the abandoned pass did emit an outcome for group 3 with no presses and no onset.
    const abandoned = records[2]!
    expect(abandoned.groups?.some((g) => g.group === 3 && g.wrongAttacks === 0)).toBe(true)
    expect(abandoned.onsets.some((o) => o.group === 3)).toBe(false)

    expect(repeated(records)[0]?.passes).toBe(3)
    const ranked = rankMistakes(records.at(-1), timeline, model, new Map<number, GroupMark>(), spotsOf(records))
    expect(ranked[0]).toMatchObject({ group: 3, level: 'repeated', passesReached: 3 })
  })

  it('an abandoned pass that pressed a different wrong key at the group does end the run', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, 'abandon-at-3-with-G4', slipAtFsharp)
    expect(repeated(records)).toEqual([])
    const ranked = rankMistakes(records.at(-1), timeline, model, new Map<number, GroupMark>(), spotsOf(records))
    expect(ranked[0]).toMatchObject({ group: 3, level: 'trouble', passesReached: 4 })
  })

  it('only the latest attempt’s mistakes, only scored records, and a place with no memory behaves as this pass only', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp, [])
    expect(repeated(records)).toEqual([])
    const r = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp)
    expect(repeated([...r, { ...r[2]!, kind: 'reading' }])).toEqual([])
    expect(repeatedMistakes(r[2]!, timeline, model, new Map())).toEqual([])
    expect(repeatedMistakes(r[2]!, timeline, model, new Map(), 1)).toMatchObject([{ group: 3, passes: 1 }])
  })

  it('several habits: most passes first, then score order', () => {
    const both = [[], [C4], [], [F4]] as const
    const records = passes(slipAtFsharp, both, both, both)
    expect(repeated(records).map((m) => [m.group, m.wrongPitch, m.passes])).toEqual([
      [3, F4, 4],
      [1, C4, 3],
    ])
  })

  it('the stand-in: the same letter first, then the octave, then the nearest pitch', () => {
    const chord = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: Fs4 },
        { at: 0, midi: 72 },
      ],
      bars: 1,
    })
    const t = buildTimeline(chord, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const run = (wrong: number) => {
      const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
      for (let i = 0; i < 3; i++) {
        if (i > 0) {
          d.engine.restart(d.now)
          d.engine.markPrepared(d.now)
        }
        d.wait(400) // the hint's fade ends: Ready
        d.tap(wrong).tap(C4, Fs4, 72)
      }
      return repeated(d.records(), t, chord)[0]!.expectedPitch
    }
    expect(run(F4)).toBe(Fs4) // F for F♯
    expect(run(G4)).toBe(Fs4) // G is a semitone from F♯ but not on its letter: nearest, F♯
    expect(run(48)).toBe(C4) // C3: the octave below C4
    expect(run(84)).toBe(72) // C6: the nearer octave (C5)
    expect(run(69)).toBe(Fs4) // A4: F♯4 and C5 are both 3 away, the lower wins
  })
})

describe('repeatedMistakeLine', () => {
  const m = (wrongPitch: number, expectedPitch: number, passes = 3, bar = '12'): RepeatedMistake => {
    const k = notes.findIndex((n) => n.midi === expectedPitch)
    return {
      group: k,
      occ: 0,
      bar,
      expectedPitches: [expectedPitch],
      expectedPitch,
      expectedNote: timeline.groups[k]!.notes[0]!,
      wrongPitch,
      passes,
    }
  }

  it('reads like a teacher: "F instead of F♯ in bar 12, three passes running"', () => {
    expect(repeatedMistakeLine(m(F4, Fs4), model, naming)).toBe('F instead of F♯ in bar 12, three passes running')
  })

  it('a natural target gets its ♮ against a sharp on the same letter', () => {
    const natural = buildScore({ notes: [{ at: 0, midi: F4 }], bars: 1 })
    const slip: RepeatedMistake = { ...m(F4, Fs4), expectedPitch: F4, expectedNote: 0, wrongPitch: Fs4 }
    expect(repeatedMistakeLine(slip, natural, naming)).toBe('F♯ instead of F♮ in bar 12, three passes running')
  })

  it('another key keeps its own name; octaves only when the names would match', () => {
    expect(repeatedMistakeLine(m(G4, E4), model, naming)).toBe('G instead of E in bar 12, three passes running')
    expect(repeatedMistakeLine(m(48, C4), model, naming)).toBe('C3 instead of C4 in bar 12, three passes running')
  })

  it('counts in words up to ten, then digits; repeat passes keep their label', () => {
    expect(repeatedMistakeLine(m(F4, Fs4, 7, '12 (pass 2)'), model, naming)).toBe(
      'F instead of F♯ in bar 12 (pass 2), seven passes running',
    )
    expect(repeatedMistakeLine(m(F4, Fs4, 14), model, naming)).toBe('F instead of F♯ in bar 12, 14 passes running')
  })

  it('follows the naming settings (fixed do, octave display ignored)', () => {
    const doRe: NamingSettings = { ...naming, system: 'fixed-do', showOctave: true }
    expect(repeatedMistakeLine(m(F4, Fs4), model, doRe)).toBe('fa instead of fa♯ in bar 12, three passes running')
  })

  it('translates the count word when a non-English catalog is loaded', () => {
    const strings = Object.fromEntries(Object.entries(fr).map(([id, value]) => [en[id as keyof typeof en], value]))
    readMessagesWith(() => ({ language: 'fr-FR', strings }))
    const line = repeatedMistakeLine(m(F4, Fs4, 3), model, naming)
    expect(line).toContain('trois')
    expect(line).not.toMatch(/\bthree\b/i)
  })
})

describe('rankMistakes (U99)', () => {
  const none = new Map<number, GroupMark>()
  const rank = (records: AttemptRecord[], marks: ReadonlyMap<number, GroupMark> = none) =>
    rankMistakes(records.at(-1), timeline, model, marks, spotsOf(records))

  it('ranks by severity: three passes running, twice now, a place wrong again and again, then one-offs', () => {
    // Group 3 (F♯): F three passes running; group 2 (E): E♭ twice; group 1 (D): wrong in all three
    // passes but with different keys; group 0 (C): this pass only, the octave above and a far key.
    const records = passes([[], [61], [], [F4]], [[], [61], [63], [F4]], [[72, 30], [59], [63], [F4]])
    const ranked = rank(records)
    expect(ranked.map((m) => [m.group, m.level])).toEqual([
      [3, 'repeated'],
      [2, 'habit'],
      [1, 'trouble'],
      [0, 'replaced'],
    ])
    expect(ranked[0]!.reason).toBe('Same wrong key three passes running')
    expect(ranked[1]!.reason).toBe('Same wrong key twice now')
    expect(ranked[2]!.reason).toBe('Wrong here in three of the last three passes')
    expect(ranked[2]!.passesWrong).toBe(3)
    expect(ranked[3]!.reason).toBe('A wrong key in place of a written note')
    expect(ranked[0]!.presses).toEqual([
      {
        pitch: F4,
        kind: 'accidental',
        expectedPitch: Fs4,
        expectedNote: timeline.groups[3]!.notes[0],
        passes: 3,
        together: false,
        cause: 'printed-accidental',
      },
    ])
    expect(ranked[3]!.presses.map((p) => [p.pitch, p.kind])).toEqual([
      [30, 'extra'],
      [72, 'octave'],
    ])
    expect(ranked.every((m) => m.occ === 0 && m.bar === '1')).toBe(true)
  })

  it('a key that belongs to nothing ranks below one in place of a note; more keys first within a level', () => {
    const records = passes([[30], [63], [30, 90], []])
    expect(rank(records).map((m) => [m.group, m.level, m.presses.length])).toEqual([
      [1, 'replaced', 1], // E♭ by D: a neighbor key
      [2, 'extra', 2],
      [0, 'extra', 1],
    ])
  })

  it('places without a wrong key rank by their mark: missed above timing; a clean place is left out', () => {
    const records = passes([[], [], [], []])
    const marks = new Map<number, GroupMark>([
      [0, { notes: [0], kind: 'late', text: 'Too late' }],
      [2, { notes: [2], kind: 'missed', text: 'Missed' }],
    ])
    const ranked = rank(records, marks)
    expect(ranked.map((m) => [m.group, m.level, m.reason])).toEqual([
      [2, 'missed', 'The music moved on before it was played'],
      [0, 'timing', 'Too late'],
    ])
    expect(ranked[1]!.mark).toEqual({ kind: 'late', text: 'Too late' })
    expect(rank(records)).toEqual([])
  })

  it('only the latest scored record, and a place with no memory behaves as this pass only', () => {
    const records = passes([[], [], [], [F4]], [[], [], [], [F4]], [[], [], [], [F4]])
    expect(rankMistakes(records[2]!, timeline, model, none, new Map())).toMatchObject([
      {
        group: 3,
        level: 'replaced',
        passesWrong: 1,
        passesReached: 1,
        presses: [{ pitch: F4, passes: 1 }],
        history: ['wrong'],
      },
    ])
    expect(rank([...records, { ...records[2]!, kind: 'reading' }])).toEqual([])
    expect(rank([])).toEqual([])
  })

  it('records per-place visit history oldest first, capped at 8, and falls back to this pass when there is no memory', () => {
    // 10 passes at group 3: wrong, clean, wrong, wrong, clean, wrong, clean, wrong, wrong, wrong.
    const seq = [
      slipAtFsharp,
      [],
      slipAtFsharp,
      slipAtFsharp,
      [],
      slipAtFsharp,
      [],
      slipAtFsharp,
      slipAtFsharp,
      slipAtFsharp,
    ]
    const records = passes(...seq)
    const ranked = rank(records)
    expect(ranked[0]!.group).toBe(3)
    // Last 8 visits of the 10: drops the first two (wrong, clean).
    expect(ranked[0]!.history).toEqual(['wrong', 'wrong', 'clean', 'wrong', 'clean', 'wrong', 'wrong', 'wrong'])

    // A timing-only place with no memory has ['clean'] for this pass alone.
    const cleanRec = passes([])
    const lateMark = new Map<number, GroupMark>([[0, { notes: [0], kind: 'late', text: 'Too late' }]])
    const timingRanked = rankMistakes(cleanRec[0], timeline, model, lateMark, new Map())
    expect(timingRanked[0]!.history).toEqual(['clean'])
  })
})

describe('wrongPressLine and pressGhost (U99)', () => {
  const press = (
    pitch: number,
    expectedPitch: number,
    kind: WrongPress['kind'],
    passes = 1,
    over: Partial<WrongPress> = {},
  ): WrongPress => {
    const k = notes.findIndex((n) => n.midi === expectedPitch)
    return { pitch, kind, expectedPitch, expectedNote: timeline.groups[k]!.notes[0]!, passes, together: null, ...over }
  }

  it('words a replaced note, a wrong octave and an extra key with the naming settings', () => {
    expect(wrongPressLine(press(F4, Fs4, 'accidental'), model, naming)).toBe('You pressed F where F♯ is written')
    expect(wrongPressLine(press(G4, E4, 'neighbor'), model, naming)).toBe('You pressed G where E is written')
    expect(wrongPressLine(press(72, C4, 'octave'), model, naming)).toBe('You pressed C5; the note is C4')
    expect(wrongPressLine(press(63, C4, 'extra'), model, naming)).toBe('You pressed D♯4: it is not in the score here')
    const doRe: NamingSettings = { ...naming, system: 'fixed-do' }
    expect(wrongPressLine(press(F4, Fs4, 'accidental'), model, doRe)).toBe('You pressed fa where fa♯ is written')
    expect(passesText(3)).toBe('three passes running')
    expect(passesText(2)).toBe('twice now')
    expect(passesText(1)).toBe('')
  })

  it('places a ghost by its written position from the note it stood for, with the accidental a reader needs', () => {
    const place = timeline.groups[3]!.notes
    // F for F♯: the same line, a natural sign (the F♯ beside it carries its sharp).
    expect(pressGhost(press(F4, Fs4, 'accidental'), place, model)).toEqual({
      anchor: place[0],
      steps: 0,
      accidental: '♮',
      place,
    })
    // C5 for C4: an octave (seven steps) up, no accidental.
    const c = timeline.groups[0]!.notes
    expect(pressGhost(press(72, C4, 'octave'), c, model)).toMatchObject({ steps: 7, accidental: '' })
    // F♯1 far below: anchored on C4, 18 steps down, with its sharp (no key signature).
    expect(pressGhost(press(30, C4, 'extra'), c, model)).toMatchObject({ steps: -18, accidental: '♯' })
  })

  it('under an ottava, a ghost is placed as the printed notes there are', () => {
    // C6 sounding, written C5 under 8va; the wrong key D6 is written D5: one step up.
    const anchor = {
      index: 0,
      staff: 0,
      grace: false,
      cue: false,
      ottavaShift: 1,
      sounding: { step: 'C', alter: 0, octave: 6 },
      written: { step: 'C', alter: 0, octave: 5 },
      accidentalContext: { keyFifths: 0, carried: [] },
    }
    const score = { notes: [anchor] } as unknown as Pick<typeof model, 'notes'>
    const p: WrongPress = { pitch: 86, kind: 'neighbor', expectedPitch: 84, expectedNote: 0, passes: 1, together: null }
    expect(pressGhost(p, [0], score)).toMatchObject({ steps: 1, accidental: '' })
    expect(pressGhost({ ...p, expectedNote: 5 }, [0], score)).toBeNull()
  })
})

describe('review wording from stroke evidence, causes and patterns', () => {
  it('real engine records: a key grazed within 60 ms ranks extra and reads "You also pressed ... with ...", including pill line', () => {
    // Single note F♯4 (group 3): brush F4 20 ms before F♯4 three passes running.
    const d = new EngineDriver(timeline, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        d.engine.restart(d.now)
        d.engine.markPrepared(d.now)
      }
      d.wait(300)
      d.tap(C4).wait(300).tap(D4).wait(300).tap(E4).wait(300)
      d.tap(F4).wait(20).tap(Fs4)
    }
    const recs = d.records()
    const spots = spotsOf(recs)
    const rep = repeatedMistakes(recs.at(-1), timeline, model, spots)
    expect(rep).toHaveLength(1)
    expect(rep[0]!.together).toBe(true)
    expect(repeatedMistakeLine(rep[0]!, model, naming)).toBe('F with F♯ in bar 1, three passes running')

    // Single pass: grazed neighbor ranks extra (not replaced) and says "with F♯" (no cause sentence).
    const firstRanked = rankMistakes(recs[0], timeline, model, new Map<number, GroupMark>(), spotsOf(recs.slice(0, 1)))
    expect(firstRanked[0]!.level).toBe('extra')
    expect(firstRanked[0]!.presses[0]!.together).toBe(true)
    expect(wrongPressLine(firstRanked[0]!.presses[0]!, model, naming)).toBe('You also pressed F with F♯')
    const doRe: NamingSettings = { ...naming, system: 'fixed-do' }
    expect(wrongPressLine(firstRanked[0]!.presses[0]!, model, doRe)).toBe('You also pressed fa with fa♯')

    // Chord: grazed key reads "... with the chord" and ranks extra.
    const chordScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: G4 },
      ],
      bars: 1,
    })
    const chordTl = buildTimeline(chordScore, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const cd = new EngineDriver(chordTl, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    cd.tap(C4).wait(20).tap(F4).wait(20).tap(E4).wait(300).tap(G4)
    const chordRec = cd.records()[0]!
    const chordRanked = rankMistakes(chordRec, chordTl, chordScore, new Map(), spotsOf([chordRec], chordTl, chordScore))
    expect(chordRanked[0]!.level).toBe('extra')
    expect(chordRanked[0]!.presses[0]!.together).toBe(true)
    expect(wrongPressLine(chordRanked[0]!.presses[0]!, chordScore, naming)).toBe('You also pressed F with the chord')
  })

  it('real engine records: lone wrong keys get cause explanations, hunting, also classes, and lateHand', () => {
    // Score with key signature (1 sharp: F♯), printed flat (B♭4), carried B♭4, stale flat in bar 2 (B♮4),
    // jumped-ahead, replayed-previous, and two-hand spread chord.
    const rich = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: Fs4 }, // group 1: key signature F♯
        { at: 2, midi: 70 }, // group 2: printed B♭4
        { at: 3, midi: 70 }, // group 3: carried B♭4
        { at: 4, midi: E4 }, // group 4 (bar 2 beat 1): spacer so group 3/5 are not adjacent to each other
        { at: 5, midi: 71 }, // group 5 (bar 2 beat 2): B♮4 (stale B♭ from bar 1)
        { at: 6, midi: G4 }, // group 6: G4 (jumped-ahead to A4, replayed-previous B♮4, hunting)
        { at: 7, midi: 69 }, // group 7: A4
        { at: 8, midi: 60, hand: 'R', staff: 0 }, // group 8 (bar 3): two-hand chord
        { at: 8, midi: 48, hand: 'L', staff: 1 },
      ],
      bars: 3,
    })
    // Set keyFifths = 1 on note 1 (F♯4) so it is a key-signature sharp (not printed).
    const patchNote = (idx: number, patch: Partial<ScoreModel['notes'][number]>) => {
      Object.assign(rich.notes[idx]!, patch)
    }
    patchNote(1, { accidentalContext: { keyFifths: 1, carried: [] } })
    const bFlat = { step: 'B' as const, alter: -1, octave: 4 }
    patchNote(2, { written: bFlat, sounding: bFlat })
    patchNote(3, {
      written: bFlat,
      sounding: bFlat,
      accidentalContext: { keyFifths: 0, carried: [['B', 4, -1]] },
    })

    const tl = buildTimeline(rich, { hands: 'both', range: { fromOcc: 0, toOcc: 2 }, multiplier: 1 })
    const d = new EngineDriver(tl, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    // Group 0: C4 clean
    d.tap(C4)
    // Group 1 (F♯4, key-signature): F4 alone (> 60 ms before)
    d.wait(300).tap(F4).wait(150).tap(Fs4)
    // Group 2 (printed B♭4): B♮4 alone
    d.wait(300).tap(71).wait(150).tap(70)
    // Group 3 (carried B♭4): B♮4 alone
    d.wait(300).tap(71).wait(150).tap(70)
    // Group 4 (bar 2 E4): clean spacer
    d.wait(300).tap(E4)
    // Group 5 (bar 2 B♮4): B♭4 alone (stale from bar 1)
    d.wait(300).tap(70).wait(150).tap(71)
    // Group 6 (G4): A4 alone (jumped-ahead to group 7) + B♮4 alone (replayed-previous from group 5) -> also hunting!
    d.wait(300).tap(69).wait(150).tap(71).wait(150).tap(G4)
    // Group 7 (A4): clean
    d.wait(300).tap(69)
    // Group 8 (C4 RH + C3 LH): wrong key + spread with LH coming after RH (120 ms)
    d.wait(300).tap(61).wait(150).tap(60).wait(120).tap(48)

    const rec = d.records()[0]!
    const ranked = rankMistakes(rec, tl, rich, new Map(), spotsOf([rec], tl, rich))
    const byGroup = new Map(ranked.map((m) => [m.group, m]))

    expect(wrongPressLine(byGroup.get(1)!.presses[0]!, rich, naming)).toBe(
      'You pressed F where F♯ is written. The key signature has F♯.',
    )
    const fixedTi: NamingSettings = { ...naming, system: 'fixed-do', seventh: 'ti' }
    expect(wrongPressLine(byGroup.get(1)!.presses[0]!, rich, fixedTi)).toBe(
      'You pressed fa where fa♯ is written. The key signature has fa♯.',
    )
    expect(wrongPressLine(byGroup.get(2)!.presses[0]!, rich, naming)).toBe(
      'You pressed B where B♭ is written. The note has its own flat.',
    )
    expect(wrongPressLine(byGroup.get(3)!.presses[0]!, rich, naming)).toBe(
      'You pressed B where B♭ is written. The flat from earlier in this bar still applies.',
    )
    expect(wrongPressLine(byGroup.get(5)!.presses[0]!, rich, naming)).toBe(
      'You pressed B♭ where B♮ is written. The flat from the bar before does not apply here.',
    )
    // Group 6: jumped-ahead, replayed-previous, and hunting
    const g6Lines = byGroup.get(6)!.presses.map((p) => wrongPressLine(p, rich, naming))
    expect(g6Lines).toContain('You played the next note early.')
    expect(g6Lines).toContain('You played the previous note again.')
    expect(byGroup.get(6)!.hunting).toBe(true)
    // Group 8: wrong key + spread chord with lateHand === 'L' in `also`
    expect(byGroup.get(8)!.lateHand).toBe('L')
    expect(byGroup.get(8)!.also).toEqual([{ kind: 'spread', text: 'Together' }])
  })

  it('other-hand and clef causes, and octave adds nothing', () => {
    const twoHand = buildScore({
      notes: [
        { at: 0, midi: C4, hand: 'R', staff: 0 },
        { at: 0, midi: 48, hand: 'L', staff: 1 },
        { at: 1, midi: E4, hand: 'R', staff: 0 },
      ],
      bars: 1,
    })
    const rh = buildTimeline(twoHand, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const d = new EngineDriver(rh, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    // Press C3 (left hand's note) alone, then C4; at E4 press E5 (octave) alone.
    d.tap(48).wait(150).tap(C4).wait(300).tap(76).wait(150).tap(E4)
    const rec = d.records()[0]!
    const ranked = rankMistakes(rec, rh, twoHand, new Map(), spotsOf([rec], rh, twoHand))
    const byGroup = new Map(ranked.map((m) => [m.group, m]))
    expect(wrongPressLine(byGroup.get(0)!.presses[0]!, twoHand, naming)).toBe(
      "You pressed C3: it is the other hand's note here.",
    )
    expect(wrongPressLine(byGroup.get(1)!.presses[0]!, twoHand, naming)).toBe('You pressed E5; the note is E4')

    // Clef change: staff 0 changes from G2 to F4 in bar 2; playing B4 as if treble gives D3 in bass.
    const clefPress: WrongPress = {
      pitch: 71,
      kind: 'extra',
      expectedPitch: 50,
      expectedNote: 0,
      passes: 1,
      together: false,
      cause: 'clef',
      clef: 'F4',
    }
    expect(wrongPressLine(clefPress, model, naming)).toBe(
      'You pressed B4: it is not in the score here. Read in the clef before the change? This staff is in bass clef now.',
    )
  })

  it('older records without extraPitches keep today’s distance ranking and wording exactly', () => {
    const [fresh] = passes([[], [], [], [F4]])
    // Strip extraPitches from every group to simulate a stored record from before it existed.
    const older: AttemptRecord = {
      ...fresh!,
      groups: fresh!.groups!.map(({ extraPitches: _drop, ...rest }) => rest),
    }
    const ranked = rankMistakes(older, timeline, model, new Map(), spotsOf([older]))
    expect(ranked[0]!.level).toBe('replaced')
    expect(ranked[0]!.presses[0]!.together).toBeNull()
    expect(ranked[0]!.presses[0]!.cause).toBeUndefined()
    expect(wrongPressLine(ranked[0]!.presses[0]!, model, naming)).toBe('You pressed F where F♯ is written')
  })

  it('words pass-level patterns and caps at two sentences', () => {
    expect(patternLine({ kind: 'cause', cause: 'key-signature', count: 3, of: 4, step: 'F', alter: 1 }, naming)).toBe(
      "3 of your 4 wrong notes missed the key signature's F♯.",
    )
    expect(
      patternLine(
        { kind: 'cause', cause: 'key-signature', count: 3, of: 4, step: 'B', alter: -1 },
        { ...naming, system: 'fixed-do', seventh: 'ti' },
      ),
    ).toBe("3 of your 4 wrong notes missed the key signature's ti♭.")
    expect(patternLine({ kind: 'cause', cause: 'jumped-ahead', count: 3, of: 4 }, naming)).toBe(
      '3 of your 4 wrong notes were the next note, played early.',
    )
    expect(patternLine({ kind: 'hand', hand: 'L', count: 4, of: 5 }, naming)).toBe(
      '4 of your 5 wrong notes were in the left hand.',
    )
    expect(patternLine({ kind: 'hunting', count: 3, of: 4 }, naming)).toBe('At 3 of 4 places you tried several keys.')
    expect(
      patternLines(
        [
          { kind: 'cause', cause: 'jumped-ahead', count: 3, of: 4 },
          { kind: 'hand', hand: 'L', count: 3, of: 4 },
          { kind: 'hunting', count: 3, of: 4 },
        ],
        naming,
      ),
    ).toHaveLength(2)
  })
})

describe('hesitation ranking level (P40)', () => {
  it('ranks hesitation after trouble and before replaced when a place paused cleanly in at least 2 recent passes', () => {
    // Timeline at quarter = 60 bpm -> pauseThresholdMs = 500 ms.
    const base = passes([])[0]!
    const gatedRecord = (
      id: string,
      createdAt: number,
      groups: NonNullable<AttemptRecord['groups']>,
    ): AttemptRecord => ({
      ...base,
      id,
      createdAt,
      context: { ...base.context, transport: 'accompaniment' },
      passed: groups.every((g) => g.wrongAttacks === 0),
      groupsFirstPass: groups.filter((g) => g.wrongAttacks === 0).length,
      wrongAttacks: groups.reduce((s, g) => s + g.wrongAttacks, 0),
      groups,
    })

    const g = (group: number, opts: { wrong?: number[]; lateMs?: number } = {}) => ({
      group,
      wrongAttacks: opts.wrong?.length ?? 0,
      earlyAttacks: 0,
      lateMs: opts.lateMs ?? 0,
      wrongPitches: opts.wrong ?? [],
      ...(opts.wrong?.length ? { extraPitches: [] } : {}),
    })

    // Pass 1: group 1 wrong (61), group 2 paused cleanly (600 ms >= 500 ms).
    const r1 = gatedRecord('r1', 1000, [g(0), g(1, { wrong: [61] }), g(2, { lateMs: 600 }), g(3)])
    // Pass 2: group 1 wrong (63, trouble), group 2 fluent (0 ms).
    const r2 = gatedRecord('r2', 2000, [g(0), g(1, { wrong: [63] }), g(2, { lateMs: 0 }), g(3)])
    // Pass 3: group 1 wrong (60, trouble 3/3), group 2 paused cleanly (550 ms -> hesitation 2/3), group 3 wrong once (replaced).
    const r3 = gatedRecord('r3', 3000, [g(0), g(1, { wrong: [60] }), g(2, { lateMs: 550 }), g(3, { wrong: [F4] })])

    const ranked = rankMistakes(r3, timeline, model, new Map(), spotsOf([r1, r2, r3]))
    expect(ranked.map((m) => [m.group, m.level])).toEqual([
      [1, 'trouble'],
      [2, 'hesitation'],
      [3, 'replaced'],
    ])
    expect(ranked[1]!.reason).toBe('Paused here in two of the last three passes')
    expect(ranked[1]!.passesPaused).toBe(2)

    // Pass 4: completely fluent everywhere -> group 2 does not appear on a clean fluent pass.
    const r4 = gatedRecord('r4', 4000, [g(0), g(1), g(2, { lateMs: 100 }), g(3)])
    expect(rankMistakes(r4, timeline, model, new Map(), spotsOf([r1, r2, r3, r4]))).toEqual([])
  })
})
