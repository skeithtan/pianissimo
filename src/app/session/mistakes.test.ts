import { describe, expect, it } from 'vitest'
import { EngineDriver, buildScore, type NoteSpec } from '../../core/engine/testkit'
import { buildTimeline } from '../../core/engine'
import { DEFAULT_SETTINGS, type NamingSettings } from '../../core/model/settings'
import type { AttemptRecord } from '../../core/model/practice'
import { REPEATED_MISTAKE_PASSES, repeatedMistakeLine, repeatedMistakes, type RepeatedMistake } from './mistakes'

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
