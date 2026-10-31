import { describe, expect, it } from 'vitest'
import { rat } from '../music/rational'
import { buildScore, quarters } from './testkit'
import { buildTimeline, groupAtOrAfter, transportGates } from './timeline'
import { handAssignmentId } from '../model/practice'

const C4 = 60
const D4 = 62
const E4 = 64
const G4 = 67
const C3 = 48
const E3 = 52
const G3 = 55

const both = { hands: 'both', range: null, multiplier: 1 } as const

describe('buildScore testkit', () => {
  it('builds ordered notes with ties, occurrences and ottava written pitches', () => {
    const m = buildScore({
      notes: [
        { at: 0, dur: 4, midi: C4 },
        { at: 4, dur: 2, midi: C4, cont: true },
        { at: 4, midi: 84 },
      ],
      ottavas: [{ staff: 0, start: 4, end: 8, shift: 1 }],
    })
    expect(m.occurrences).toHaveLength(2)
    expect(m.notes.map((n) => n.midi)).toEqual([C4, C4, 84])
    expect(m.notes[1]!.tieContinuation).toBe(true)
    expect(m.notes[1]!.tieHead).toBe(0)
    expect(m.notes[0]!.soundingDuration).toEqual(quarters(6))
    expect(m.notes[2]!.written.octave).toBe(5)
    expect(m.notes[2]!.sounding.octave).toBe(6)
    expect(m.ottavas[0]!.notes).toEqual([1, 2])
  })
})

describe('onset groups (spec: Score following)', () => {
  it('groups distinct pitches at one position and orders groups by position', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: E4 },
        { at: 0, midi: C3 },
        { at: 1, midi: G4 },
        { at: 1, midi: E3, dur: 0.5 },
        { at: 1.5, midi: G3, dur: 0.5 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.groups.map((g) => g.pitches)).toEqual([[C3, E4], [E3, G4], [G3]])
    expect(t.groups.map((g) => g.position)).toEqual([quarters(0), quarters(1), quarters(1.5)])
    expect(t.status).toBe('ok')
  })

  it('a pitch shared by two voices is required once but marks both noteheads', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: G4, voice: '1' },
        { at: 0, midi: G4, voice: '2', dur: 2 },
        { at: 0, midi: C4, voice: '2', dur: 2 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.groups).toHaveLength(1)
    expect(t.groups[0]!.pitches).toEqual([C4, G4])
    expect(t.groups[0]!.notesByPitch[1]).toHaveLength(2)
    expect(t.groups[0]!.notes).toHaveLength(3)
  })

  it('tie continuations are not required and tie-only positions are skipped', () => {
    const m = buildScore({
      notes: [
        { at: 0, dur: 2, midi: C4 },
        { at: 2, dur: 2, midi: C4, cont: true },
        { at: 4, dur: 1, midi: D4 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.groups.map((g) => g.pitches)).toEqual([[C4], [D4]])
    expect(t.noteToGroup.has(1)).toBe(false)
    expect(t.labelToGroup.get(1)).toBe(0)
    // The tie end (beat 3) sounds through while D4 is next: pressing C4 then is a tie-end press.
    expect(t.groups.map((g) => g.tiedPitches)).toEqual([[], [C4]])
  })

  it('tied pitches: a tie end goes to the first group at or after it, never one attacking that pitch', () => {
    const m = buildScore({
      notes: [
        { at: 0, dur: 2, midi: C4 },
        { at: 0, midi: E3, hand: 'L' },
        { at: 1, midi: G3, hand: 'L' },
        { at: 2, dur: 1, midi: C4, cont: true },
        { at: 2, midi: E4 },
        { at: 3, midi: C4 },
        { at: 3, dur: 1, midi: G4 },
        { at: 4, dur: 1, midi: G4, cont: true },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.groups.map((g) => [g.pitches, g.tiedPitches])).toEqual([
      [[E3, C4], []],
      [[G3], []],
      [[E4], [C4]],
      [[C4, G4], []],
    ])
    // A tie end after the last group belongs to no group.
    const right = buildTimeline(m, { ...both, hands: 'right' })
    expect(right.groups.map((g) => g.tiedPitches)).toEqual([[], [C4], []])
  })

  it('pedalDown follows the sustain marks at or before each onset; null without sustain marks', () => {
    const notes = [0, 1, 2, 3, 4, 5].map((at) => ({ at, midi: C4 + at }))
    const m = buildScore({
      notes,
      pedals: [
        { at: 1, type: 'start' },
        { at: 3, type: 'stop' },
        { at: 3, type: 'start' }, // a change written as stop + start: down
        { at: 4, type: 'continue' },
        { at: 5, type: 'stop' },
        { at: 0, type: 'start', kind: 'soft' }, // never decides the sustain state
      ],
    })
    expect(buildTimeline(m, both).groups.map((g) => g.pedalDown)).toEqual([false, true, true, true, true, false])
    // A loop inside a pedal span starts with the pedal down.
    const loop = buildTimeline(m, { ...both, range: { fromOcc: 0, toOcc: 1, start: quarters(2), end: quarters(5) } })
    expect(loop.groups.map((g) => g.pedalDown)).toEqual([true, true, true])
    const soft = buildScore({ notes, pedals: [{ at: 0, type: 'start', kind: 'soft' }] })
    expect(buildTimeline(soft, both).groups.every((g) => g.pedalDown === null)).toBe(true)
    expect(buildTimeline(buildScore({ notes }), both).groups.every((g) => g.pedalDown === null)).toBe(true)
  })

  it('rests produce no group: the cursor moves to the next playable onset', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 3, midi: D4 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.groups.map((g) => g.position)).toEqual([quarters(0), quarters(3)])
  })

  it('hand selection keeps only learner voices and lists automatic positions with unisons', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: E4, hand: 'R' },
        { at: 0, midi: C3, hand: 'L' },
        { at: 1, midi: E3, hand: 'L' },
        { at: 2, midi: G4, hand: 'R' },
        { at: 2, midi: G4, hand: 'L', staff: 1, voice: '6' },
      ],
    })
    const right = buildTimeline(m, { hands: 'right', range: null, multiplier: 1 })
    expect(right.groups.map((g) => g.pitches)).toEqual([[E4], [G4]])
    expect(right.automatic.map((a) => [a.notes.length, a.unisonWithLearner.length, a.learnerGroup])).toEqual([
      [1, 0, 0],
      [1, 0, null],
      [0, 1, 1],
    ])
    const left = buildTimeline(m, { hands: 'left', range: null, multiplier: 1 })
    expect(left.groups.map((g) => g.pitches)).toEqual([[C3], [E3], [G4]])
    expect(buildTimeline(m, both).automatic).toEqual([])
  })

  it('grace notes are never required', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: D4, grace: true },
        { at: 0, midi: C4 },
      ],
    })
    expect(buildTimeline(m, both).groups[0]!.pitches).toEqual([C4])
  })

  it('cue notes are neither required nor automatic (I13)', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: D4, cue: true },
        { at: 0, midi: C4 },
        { at: 1, midi: C3, hand: 'L', cue: true },
      ],
    })
    expect(buildTimeline(m, both).groups.map((g) => g.pitches)).toEqual([[C4]])
    const right = buildTimeline(m, { hands: 'right', range: null, multiplier: 1 })
    expect(right.groups.map((g) => g.pitches)).toEqual([[C4]])
    expect(right.automatic).toEqual([])
  })

  it('measures list their groups; groupAtOrAfter and gates follow positions', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 2, midi: D4 },
        { at: 9, midi: E4 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.measures.map((x) => x.groups)).toEqual([[0, 1], [], [2]])
    expect(groupAtOrAfter(t, quarters(1))).toBe(1)
    expect(groupAtOrAfter(t, quarters(2))).toBe(1)
    expect(groupAtOrAfter(t, quarters(10))).toBe(3)
    expect(transportGates(t)).toEqual([quarters(0), quarters(2), quarters(9)])
  })
})

describe('loop boundaries (spec: Repeating passages)', () => {
  const m = buildScore({
    notes: [
      { at: 0, dur: 4, midi: C4 },
      { at: 4, dur: 2, midi: C4, cont: true },
      { at: 2, dur: 4, midi: C3 },
      { at: 4, dur: 1, midi: E4 },
      { at: 6, dur: 2, midi: G4 },
    ],
  })

  it('a held note crossing the loop start becomes a flagged boundary reattack; a tie attacked before it does not', () => {
    const t = buildTimeline(m, { hands: 'both', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1 })
    const first = t.groups[0]!
    expect(first.position).toEqual(quarters(4))
    expect(first.pitches).toEqual([C3, E4])
    expect(first.boundaryNotes.map((i) => m.notes[i]!.midi)).toEqual([C3])
    expect(first.tiedPitches).toEqual([C4])
    expect(first.synthetic).toBe(false)
    // The tie continuation reveals no group's attack inside the loop.
    expect(t.labelToGroup.has(m.notes.findIndex((n) => n.tieContinuation))).toBe(false)
  })

  it('a two-bar loop from bar 2 ignores a tie from bar 1: nothing to press, a press is a tie-end press', () => {
    const m3 = buildScore({
      notes: [
        { at: 0, midi: E4 },
        { at: 2, dur: 2, midi: C4 },
        { at: 2, dur: 2, midi: G4 },
        { at: 4, dur: 2, midi: C4, cont: true },
        { at: 4, dur: 2, midi: G4, cont: true },
        { at: 5, midi: D4 },
        { at: 8, midi: E4 },
      ],
    })
    const loop = buildTimeline(m3, { hands: 'both', range: { fromOcc: 1, toOcc: 2 }, multiplier: 1 })
    // The tied chord's attack lies before the loop: no group at the loop start.
    expect(loop.groups.map((g) => [g.position, g.pitches, g.tiedPitches, g.synthetic])).toEqual([
      [quarters(5), [D4], [C4, G4], false],
      [quarters(8), [E4], [], false],
    ])
    expect(loop.groups.every((g) => g.boundaryNotes.length === 0)).toBe(true)
    // The full piece is unchanged: the tie head is attacked in bar 1, its end is a tie end.
    const full = buildTimeline(m3, both)
    expect(full.groups.map((g) => [g.pitches, g.tiedPitches])).toEqual([
      [[E4], []],
      [[C4, G4], []],
      [[D4], [C4, G4]],
      [[E4], []],
    ])
  })

  it('a group made only of boundary reattacks is synthetic', () => {
    const m2 = buildScore({
      notes: [
        { at: 2, dur: 4, midi: C3 },
        { at: 6, dur: 2, midi: D4 },
      ],
    })
    const t = buildTimeline(m2, { hands: 'both', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1 })
    expect(t.groups.map((g) => [g.pitches, g.synthetic])).toEqual([
      [[C3], true],
      [[D4], false],
    ])
  })

  it('no boundary group when the passage starts the piece', () => {
    const t = buildTimeline(m, { hands: 'both', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    expect(t.groups.every((g) => g.boundaryNotes.length === 0)).toBe(true)
  })

  it('rejects invalid ranges', () => {
    expect(() => buildTimeline(m, { hands: 'both', range: { fromOcc: 1, toOcc: 0 }, multiplier: 1 })).toThrow(
      RangeError,
    )
    expect(() => buildTimeline(m, { hands: 'both', range: { fromOcc: 0, toOcc: 9 }, multiplier: 1 })).toThrow(
      RangeError,
    )
    expect(() => buildTimeline(m, { hands: 'both', range: null, multiplier: 0 })).toThrow(RangeError)
  })
})

describe('reference timing (spec: Results and timing, Tempo mathematics)', () => {
  const fourQuarters = buildScore({ notes: [0, 1, 2, 3].map((at) => ({ at, midi: C4 + at })) })

  it('four quarter attacks at quarter = 60: 3 s attack span, 4 s notated', () => {
    const t = buildTimeline(fourQuarters, both)
    expect(t.expectedSpanSec).toBeCloseTo(3)
    expect(t.notatedDurationSec).toBeCloseTo(4)
    expect(t.timingUnscoredReason).toBeNull()
  })

  it('0.5× doubles and 2× halves expected and notated durations', () => {
    const half = buildTimeline(fourQuarters, { ...both, multiplier: 0.5 })
    const twice = buildTimeline(fourQuarters, { ...both, multiplier: 2 })
    expect(half.expectedSpanSec).toBeCloseTo(6)
    expect(twice.expectedSpanSec).toBeCloseTo(1.5)
    expect(half.notatedDurationSec).toBeCloseTo(8)
    expect(twice.notatedDurationSec).toBeCloseTo(2)
    expect(half.context.multiplier).toBe(0.5)
  })

  it('a complete 6/8 bar at dotted quarter = 60 lasts 2 s', () => {
    const m = buildScore({
      meter: [6, 8],
      tempo: { bpm: 60, unit: rat(3, 8) },
      notes: [0, 0.5, 1, 1.5, 2, 2.5].map((at) => ({ at, dur: 0.5, midi: C4 })),
    })
    const t = buildTimeline(m, both)
    expect(t.notatedDurationSec).toBeCloseTo(2)
    expect(t.expectedSpanSec).toBeCloseTo((2 * 5) / 6)
  })

  it('a final marked roll contributes its reference spread, scaled with the multiplier', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: C3, roll: 1, offset: 0 },
        { at: 1, midi: G3, roll: 1, offset: 0.06 },
        { at: 1, midi: E4, roll: 1, offset: 0.12, staff: 0 },
      ],
    })
    expect(buildTimeline(m, both).expectedSpanSec).toBeCloseTo(1.12)
    expect(buildTimeline(m, { ...both, multiplier: 0.5 }).expectedSpanSec).toBeCloseTo(2.24)
    expect(buildTimeline(m, { ...both, multiplier: 2 }).expectedSpanSec).toBeCloseTo(0.56)
    // Right hand alone: its only roll member is the latest attack.
    expect(buildTimeline(m, { hands: 'right', range: null, multiplier: 1 }).expectedSpanSec).toBeCloseTo(1.12)
  })

  it('a single onset group has no tempo ratio, even when rolled', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C3, roll: 1, offset: 0 },
        { at: 0, midi: E4, roll: 1, offset: 0.12 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.expectedSpanSec).toBeNull()
    expect(t.notatedDurationSec).toBeCloseTo(4)
  })

  it('final sustain and trailing rests are excluded from the span', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4, dur: 3 },
      ],
      bars: 2,
    })
    const t = buildTimeline(m, both)
    expect(t.expectedSpanSec).toBeCloseTo(1)
    expect(t.notatedDurationSec).toBeCloseTo(8)
  })

  it('without a numerical tempo nothing is timed and scored practice is blocked', () => {
    const m = buildScore({
      tempo: null,
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
      ],
    })
    const t = buildTimeline(m, both)
    expect(t.expectedSpanSec).toBeNull()
    expect(t.notatedDurationSec).toBeNull()
    expect(t.groups[0]!.onsetSec).toBeNull()
    expect(t.timingUnscoredReason).toMatch(/tempo/i)
    expect(t.blockers.map((b) => b.kind)).toEqual(['tempo-missing'])
    expect(t.scoredAllowed).toBe(false)
  })

  it('a fermata inside the span leaves timing unscored; one on the final attack does not', () => {
    const notes = [0, 1, 2, 3].map((at) => ({ at, midi: C4 }))
    const inside = buildScore({ notes, timingIssues: [{ kind: 'fermata', occ: 0, at: 1, text: 'fermata' }] })
    const t1 = buildTimeline(inside, both)
    expect(t1.expectedSpanSec).toBeNull()
    expect(t1.timingUnscoredReason).toMatch(/Fermata in bar 1/)
    const last = buildScore({ notes, timingIssues: [{ kind: 'fermata', occ: 0, at: 3, text: 'fermata' }] })
    expect(buildTimeline(last, both).expectedSpanSec).toBeCloseTo(3)
    const verbal = buildScore({ notes, timingIssues: [{ kind: 'verbal-tempo', occ: 0, at: 0, text: 'rit.' }] })
    expect(buildTimeline(verbal, both).expectedSpanSec).toBeNull()
  })
})

describe('scored-practice blockers', () => {
  it('a hand with no required onsets in the passage is explained', () => {
    const m = buildScore({ notes: [{ at: 0, midi: C4, hand: 'R' }] })
    const t = buildTimeline(m, { hands: 'left', range: null, multiplier: 1 })
    expect(t.status).toBe('no-required-onsets')
    expect(t.blockers[0]!.message).toMatch(/left-hand part has no notes to play in bar 1/)
  })

  it('unsupported regions and unconfirmed cross-staff voices block scoring', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 4, midi: D4 },
      ],
      unsupported: [{ kind: 'grace', fromOcc: 1, toOcc: 1, message: 'Grace notes' }],
      ambiguousVoices: ['P1:1'],
    })
    const t = buildTimeline(m, both)
    expect(t.blockers.map((b) => b.kind)).toEqual(['unsupported-region', 'hands-unconfirmed'])
    const firstBar = buildTimeline(m, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    expect(firstBar.blockers.map((b) => b.kind)).toEqual(['hands-unconfirmed'])
  })

  it('the comparison context names version, passage, hands, tempo map, speed, roll policy and rules', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 4, midi: D4 },
      ],
    })
    const t = buildTimeline(m, { hands: 'right', range: { fromOcc: 1, toOcc: 1 }, multiplier: 1.5 })
    expect(t.context).toEqual({
      scoreVersionId: 'test-score-v1',
      passage: { fromOcc: 1, toOcc: 1 },
      hands: 'right',
      handsId: handAssignmentId(m.hands),
      tempoMapId: '0/1@60',
      multiplier: 1.5,
      rollPolicy: m.meta.rollPolicyVersion,
      matchingRules: 'match-v2-early-grace-120ms',
    })
    expect(t.rangeSelected).toBe(true)
  })
})

describe('ottava applicability (spec: Ottava scope and visibility)', () => {
  const m = buildScore({
    notes: [
      { at: 0, midi: 72, hand: 'R' },
      { at: 0, midi: C3, hand: 'L' },
      { at: 1, midi: 74, hand: 'R' },
      { at: 2, midi: E3, hand: 'L' },
      { at: 3, midi: 76, hand: 'R' },
    ],
    ottavas: [
      { staff: 0, start: 0, end: 3, shift: 1 },
      { staff: 1, start: 1, end: 4, shift: -1 },
    ],
  })

  it('both hands: every span active at the position, including a resting staff', () => {
    const t = buildTimeline(m, both)
    expect(t.groups.map((g) => g.ottavas)).toEqual([[0], [0, 1], [0, 1], [1]])
  })

  it('half-open scope: a span ending at a position does not apply there', () => {
    const t = buildTimeline(m, both)
    expect(t.groups[3]!.position).toEqual(quarters(3))
    expect(t.groups[3]!.ottavas).toEqual([1])
  })

  it('one hand: only spans over the selected part', () => {
    const right = buildTimeline(m, { hands: 'right', range: null, multiplier: 1 })
    expect(right.groups.map((g) => g.ottavas)).toEqual([[0], [0], []])
    const left = buildTimeline(m, { hands: 'left', range: null, multiplier: 1 })
    expect(left.groups.map((g) => g.ottavas)).toEqual([[], [1]])
  })
})
