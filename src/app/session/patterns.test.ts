import { describe, expect, it } from 'vitest'
import { buildTimeline, type Timeline } from '../../core/engine'
import { buildScore, type NoteSpec } from '../../core/engine/testkit'
import { DEFAULT_SETTINGS } from '../../core/model/settings'
import type { AttemptRecord, GroupOutcome } from '../../core/model/practice'
import type { AccidentalContext, PerformedNote, ScoreModel } from '../../core/model/score'
import { mistakePatterns } from './patterns'

const C3 = 48
const E3 = 52
const G3 = 55
const C4 = 60
const Cs4 = 61
const D4 = 62
const E4 = 64
const F4 = 65
const Fs4 = 66
const G4 = 67
const A4 = 69
const B4 = 71
const C5 = 72
const D5 = 74
const E5 = 76
const F5 = 77

function withContext(
  model: ScoreModel,
  patch: (note: PerformedNote, index: number) => Partial<PerformedNote> | null,
): ScoreModel {
  return {
    ...model,
    notes: model.notes.map((n, i) => {
      const p = patch(n, i)
      return p ? { ...n, ...p } : n
    }),
  }
}

function makeRecord(
  timeline: Timeline,
  groups: readonly GroupOutcome[] | undefined,
  kind: 'scored' | 'reading' = 'scored',
): AttemptRecord {
  return {
    id: 'a1',
    pieceId: 'p1',
    createdAt: 0,
    kind,
    context: { ...timeline.context, transport: 'free' },
    contextKey: 'k',
    completion: 'completed',
    wrongAttacks: (groups ?? []).reduce((s, g) => s + g.wrongAttacks, 0),
    groupsTotal: timeline.groups.length,
    groupsFirstPass: timeline.groups.length,
    expectedTimeSec: null,
    notatedDurationSec: null,
    assistance: {
      level: 'none',
      persistentLabelNotes: [],
      persistentLabelGroups: [],
      hintRequests: 0,
      autoHints: 0,
      hintGroups: [],
      keyboardShown: false,
      labelSettings: { mode: DEFAULT_SETTINGS.labels.mode, rulesJson: '[]' },
    },
    passed: false,
    onsets: [],
    measures: [],
    ...(groups !== undefined ? { groups } : {}),
  }
}

function out(group: number, wrongPitches: readonly number[], extraPitches?: readonly number[]): GroupOutcome {
  return {
    group,
    wrongAttacks: wrongPitches.length,
    earlyAttacks: 0,
    lateMs: 0,
    wrongPitches,
    ...(extraPitches !== undefined ? { extraPitches } : {}),
  }
}

describe('mistakePatterns', () => {
  const keyG: AccidentalContext = { keyFifths: 1, carried: [] }
  const gMajorBase = buildScore({
    notes: [Fs4, A4, Fs4, A4, Fs4, A4, Fs4].map((midi, at) => ({ at, midi })),
    bars: 2,
  })
  const gMajor = withContext(gMajorBase, (n) => (n.written.step === 'F' ? { accidentalContext: keyG } : null))
  const gTimeline = buildTimeline(gMajor, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })

  it('enforces the minimum count (3) and half-of-of share thresholds', () => {
    // 2 of 3 key-signature misses -> not a pattern (< 3).
    const twoOfThree = makeRecord(gTimeline, [out(0, [F4]), out(2, [F4]), out(1, [C4])])
    expect(mistakePatterns(twoOfThree, gTimeline, gMajor)).toEqual([])

    // 3 of 5 key-signature misses -> pattern with step F and alter +1.
    const threeOfFive = makeRecord(gTimeline, [out(0, [F4]), out(2, [F4]), out(4, [F4]), out(1, [C4]), out(3, [C4])])
    expect(mistakePatterns(threeOfFive, gTimeline, gMajor)).toEqual([
      { kind: 'cause', cause: 'key-signature', count: 3, of: 5, step: 'F', alter: 1 },
    ])

    // 3 of 6 (exact half) -> pattern.
    const threeOfSix = makeRecord(gTimeline, [
      out(0, [F4]),
      out(2, [F4]),
      out(4, [F4]),
      out(1, [C4]),
      out(3, [C4]),
      out(5, [C4]),
    ])
    expect(mistakePatterns(threeOfSix, gTimeline, gMajor)).toEqual([
      { kind: 'cause', cause: 'key-signature', count: 3, of: 6, step: 'F', alter: 1 },
    ])

    // 3 of 7 (less than half) -> not a pattern.
    const threeOfSeven = makeRecord(gTimeline, [
      out(0, [F4]),
      out(2, [F4]),
      out(4, [F4]),
      out(1, [C4, D4]),
      out(3, [C4, D4]),
    ])
    expect(mistakePatterns(threeOfSeven, gTimeline, gMajor)).toEqual([])
  })

  it('counts duplicate presses in wrongPitches once per press', () => {
    // F4 pressed twice at group 0 and once at group 2 (3 of 4 total presses).
    const record = makeRecord(gTimeline, [out(0, [F4, F4]), out(2, [F4]), out(1, [C4])])
    expect(mistakePatterns(record, gTimeline, gMajor)).toEqual([
      { kind: 'cause', cause: 'key-signature', count: 3, of: 4, step: 'F', alter: 1 },
    ])
  })

  it('reports the most frequent step/alter for accidental causes and alter 0 for stale-accidental', () => {
    // D major (2 sharps: F♯ and C♯): 3 misses on F♯ and 1 miss on C♯ -> step F, alter +1.
    const keyD: AccidentalContext = { keyFifths: 2, carried: [] }
    const dMajorBase = buildScore({
      notes: [Fs4, Cs4, Fs4, Fs4].map((midi, at) => ({ at, midi })),
      bars: 1,
    })
    const dMajor = withContext(dMajorBase, () => ({ accidentalContext: keyD }))
    const dTimeline = buildTimeline(dMajor, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const dRecord = makeRecord(dTimeline, [out(0, [F4]), out(1, [C4]), out(2, [F4]), out(3, [F4])])
    expect(mistakePatterns(dRecord, dTimeline, dMajor)).toEqual([
      { kind: 'cause', cause: 'key-signature', count: 4, of: 4, step: 'F', alter: 1 },
    ])

    // Stale accidental: bar 1 has F♯4 then A4 (spacer), bar 2 has three plain F4s pressed as F♯4 -> written alter 0.
    const staleModel = buildScore({
      notes: [
        { at: 0, midi: Fs4 },
        { at: 1, midi: A4 },
        { at: 4, midi: F4 },
        { at: 5, midi: A4 },
        { at: 6, midi: F4 },
        { at: 7, midi: F4 },
      ],
      bars: 2,
    })
    const staleTl = buildTimeline(staleModel, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const staleRec = makeRecord(staleTl, [out(2, [Fs4]), out(4, [Fs4]), out(5, [Fs4])])
    expect(mistakePatterns(staleRec, staleTl, staleModel)).toEqual([
      { kind: 'cause', cause: 'stale-accidental', count: 3, of: 3, step: 'F', alter: 0 },
    ])
  })

  it('reports hand patterns only in both-hands timelines and breaks ties in favor of cause', () => {
    const notes: NoteSpec[] = [
      { at: 0, midi: C5, hand: 'R' },
      { at: 0, midi: C3, hand: 'L' },
      { at: 1, midi: E5, hand: 'R' },
      { at: 1, midi: E3, hand: 'L' },
      { at: 2, midi: G4, hand: 'R' },
      { at: 2, midi: G3, hand: 'L' },
      { at: 3, midi: B4, hand: 'R' },
      { at: 3, midi: C3, hand: 'L' },
    ]
    const model = buildScore({ notes, bars: 1 })
    const bothTl = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })

    // 3 octave errors on LH (C4 for C3, E4 for E3, G4? wait: G4 is in group 2! Use C2/E2/G2 = 36/40/43).
    // Actually: C2=36 (octave of C3), E2=40 (octave of E3), G2=43 (octave of G3) -> all 3 are octave + hand L.
    const tied = makeRecord(bothTl, [out(0, [36]), out(1, [40]), out(2, [43])])
    expect(mistakePatterns(tied, bothTl, model)).toEqual([
      { kind: 'cause', cause: 'octave', count: 3, of: 3 },
      { kind: 'hand', hand: 'L', count: 3, of: 3 },
    ])

    // Same score in single-hand timeline: never reports a hand pattern.
    const leftTl = buildTimeline(model, { hands: 'left', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    expect(mistakePatterns(tied, leftTl, model)).toEqual([{ kind: 'cause', cause: 'octave', count: 3, of: 3 }])
  })

  it('reports hunting based on places with a wrong key, orders strongest first, and caps at two', () => {
    const notes: NoteSpec[] = [
      { at: 0, midi: C5, hand: 'R' },
      { at: 0, midi: C3, hand: 'L' },
      { at: 1, midi: D5, hand: 'R' },
      { at: 1, midi: E3, hand: 'L' },
      { at: 2, midi: F5, hand: 'R' },
      { at: 2, midi: G3, hand: 'L' },
      { at: 3, midi: A4, hand: 'R' },
      { at: 3, midi: C3, hand: 'L' },
    ]
    const model = buildScore({ notes, bars: 1 })
    const bothTl = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })

    // 3 places, all hunting (2 distinct wrong keys per place, none extra), all 6 presses on LH,
    // and 4 of 6 presses are octave errors -> hunting (3/3 = 100%) & hand L (6/6 = 100%) beat cause (4/6 = 67%).
    // C2=36, C4=60 (both octave of C3,Wait: C4 is 12 from C3 and 12 from C5; use 36 and 38 for group 0).
    // Group 0: [36 (oct C3), 38 (D2, null, near C3)] -> LH, 1 octave
    // Group 1: [40 (oct E3), 42 (F♯2, null, near E3)] -> LH, 1 octave
    // Group 2: [43 (oct G3), 31 (oct G3, 24 below)] -> LH, 2 octaves
    // Total: 6 presses (6/6 hand L = 100%, 4/6 octave = 67%), 3 wrong places (3/3 hunting = 100%).
    // Hand L has count 6 vs hunting count 3 at equal 100% share -> hand L first, hunting second, capped at 2.
    const record = makeRecord(bothTl, [out(0, [36, 38], []), out(1, [40, 42], []), out(2, [43, 31], [])])
    expect(mistakePatterns(record, bothTl, model)).toEqual([
      { kind: 'hand', hand: 'L', count: 6, of: 6 },
      { kind: 'hunting', count: 3, of: 3 },
    ])

    // Hunting does not trigger when < half of wrong places (3 hunting of 7 wrong places).
    const sevenModel = buildScore({
      notes: [C4, E4, G4, B4, D5, F5, A4].map((midi, at) => ({ at, midi })),
      bars: 2,
    })
    const sevenTl = buildTimeline(sevenModel, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const sevenRec = makeRecord(sevenTl, [
      out(0, [C3, D4], []),
      out(1, [C3, D4], []),
      out(2, [C3, D4], []),
      out(3, [C3], []),
      out(4, [C3], []),
      out(5, [C3], []),
      out(6, [C3], []),
    ])
    expect(mistakePatterns(sevenRec, sevenTl, sevenModel).find((p) => p.kind === 'hunting')).toBeUndefined()
  })

  it('returns none for reading records or records without groups', () => {
    const reading = makeRecord(gTimeline, [out(0, [F4]), out(2, [F4]), out(4, [F4])], 'reading')
    expect(mistakePatterns(reading, gTimeline, gMajor)).toEqual([])

    const noGroups = makeRecord(gTimeline, undefined, 'scored')
    expect(mistakePatterns(noGroups, gTimeline, gMajor)).toEqual([])
  })
})
