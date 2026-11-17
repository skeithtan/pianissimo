import { describe, expect, it } from 'vitest'
import { EngineDriver, buildScore, type NoteSpec } from '../../core/engine/testkit'
import { buildTimeline } from '../../core/engine'
import { DEFAULT_SETTINGS, type NamingSettings } from '../../core/model/settings'
import type { AttemptRecord } from '../../core/model/practice'
import { REPEATED_MISTAKE_PASSES, repeatedMistakeLine, repeatedMistakes, type RepeatedMistake } from './mistakes'
import { passesText, pressGhost, rankMistakes, wrongPressLine, type GroupMark, type WrongPress } from './ranking'

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
function passes(...plans: (readonly (readonly number[])[] | 'stop-after-1')[]): AttemptRecord[] {
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
    timeline.groups.forEach((g, gi) => {
      d.wait(300)
      for (const k of plan[gi] ?? []) d.tap(k)
      d.tap(...g.pitches)
    })
  })
  return d.records()
}

const slipAtFsharp = [[], [], [], [F4]] as const

describe('repeatedMistakes', () => {
  it(`names the same wrong key at the same group in ${REPEATED_MISTAKE_PASSES} passes running`, () => {
    const records = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp)
    expect(repeatedMistakes(records.slice(0, 2), timeline, model)).toEqual([])
    expect(repeatedMistakes(records, timeline, model)).toEqual<RepeatedMistake[]>([
      {
        group: 3,
        occ: 0,
        bar: '1',
        expectedPitches: [Fs4],
        expectedPitch: Fs4,
        expectedNote: timeline.groups[3]!.notes[0]!,
        wrongPitch: F4,
        passes: 3,
      },
    ])
  })

  it('counts every pass running, and a clean pass at the group ends the count', () => {
    const four = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp, slipAtFsharp)
    expect(repeatedMistakes(four, timeline, model)[0]?.passes).toBe(4)
    const broken = passes(slipAtFsharp, slipAtFsharp, [], slipAtFsharp, slipAtFsharp)
    expect(repeatedMistakes(broken, timeline, model)).toEqual([])
  })

  it('a pass stopped before the group neither counts nor breaks; another wrong key does not count', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, 'stop-after-1', slipAtFsharp)
    expect(repeatedMistakes(records, timeline, model)[0]?.passes).toBe(3)
    const other = passes(slipAtFsharp, [[], [], [], [G4]], slipAtFsharp)
    expect(repeatedMistakes(other, timeline, model)).toEqual([])
  })

  it('only the latest attempt’s mistakes, only its comparison context, only scored records', () => {
    const records = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp, [])
    expect(repeatedMistakes(records, timeline, model)).toEqual([])
    const r = passes(slipAtFsharp, slipAtFsharp, slipAtFsharp)
    const otherContext = { ...r[0]!, contextKey: 'elsewhere' }
    expect(repeatedMistakes([otherContext, r[1]!, r[2]!], timeline, model)).toEqual([])
    expect(repeatedMistakes([...r, { ...r[2]!, kind: 'reading' }], timeline, model)).toEqual([])
  })

  it('several habits: most passes first, then score order', () => {
    const both = [[], [C4], [], [F4]] as const
    const records = passes(slipAtFsharp, both, both, both)
    expect(repeatedMistakes(records, timeline, model).map((m) => [m.group, m.wrongPitch, m.passes])).toEqual([
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
      return repeatedMistakes(d.records(), t, chord)[0]!.expectedPitch
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
})

describe('rankMistakes (U99)', () => {
  const none = new Map<number, GroupMark>()
  const rank = (records: AttemptRecord[], marks: ReadonlyMap<number, GroupMark> = none) =>
    rankMistakes(records, timeline, model, marks)

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
      { pitch: F4, kind: 'accidental', expectedPitch: Fs4, expectedNote: timeline.groups[3]!.notes[0], passes: 3 },
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

  it('only the latest scored record of its comparison context, as for the pill', () => {
    const records = passes([[], [], [], [F4]], [[], [], [], [F4]], [[], [], [], [F4]])
    const other = { ...records[0]!, contextKey: 'elsewhere' }
    expect(rank([other, records[1]!, records[2]!])[0]!.level).toBe('habit')
    expect(rank([...records, { ...records[2]!, kind: 'reading' }])).toEqual([])
    expect(rank([])).toEqual([])
  })
})

describe('wrongPressLine and pressGhost (U99)', () => {
  const press = (pitch: number, expectedPitch: number, kind: WrongPress['kind'], passes = 1): WrongPress => {
    const k = notes.findIndex((n) => n.midi === expectedPitch)
    return { pitch, kind, expectedPitch, expectedNote: timeline.groups[k]!.notes[0]!, passes }
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
    const p: WrongPress = { pitch: 86, kind: 'neighbor', expectedPitch: 84, expectedNote: 0, passes: 1 }
    expect(pressGhost(p, [0], score)).toMatchObject({ steps: 1, accidental: '' })
    expect(pressGhost({ ...p, expectedNote: 5 }, [0], score)).toBeNull()
  })
})
