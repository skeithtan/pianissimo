/**
 * Per-group outcomes for the teacher corrections (DECISIONS E15–E17): wrong pitches, chord
 * spread, tie-end presses and the sustain pedal against the score's marks.
 */
import { describe, expect, it } from 'vitest'
import { CC_SUSTAIN } from '../midi/types'
import { PEDAL_GRACE_MS } from './engine'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { EngineConfig } from './types'

const B3 = 59
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const D5 = 74

function scored(model: ReturnType<typeof buildScore>, over: Partial<EngineConfig> = {}): EngineDriver {
  const t = buildTimeline(model, { hands: 'right', range: null, multiplier: 1 })
  return new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free', ...over })
}

describe('wrong pitches', () => {
  it('lists every wrong key of a group in order, repeats included (too-early pitches: see accompaniment)', () => {
    const m = buildScore({ notes: [0, 1, 2].map((at) => ({ at, midi: C4 + 2 * at })) })
    const d = scored(m)
    d.tap(B3, B3, C4).tap(F4)
    d.engine.interrupt('user-stop', d.now)
    const r = d.records()[0]!
    expect(r.completion).toBe('abandoned')
    expect(r.groups!.map((g) => [g.group, g.wrongAttacks, g.wrongPitches])).toEqual([
      [0, 2, [B3, B3]],
      [1, 1, [F4]],
    ])
  })
})

describe('tie-end presses', () => {
  // G4 whole note tied into beat 1 of bar 2, where D5 is the next attack.
  const tied = buildScore({
    notes: [
      { at: 0, dur: 4, midi: G4 },
      { at: 1, midi: E4 },
      { at: 2, midi: F4 },
      { at: 4, dur: 1, midi: G4, cont: true },
      { at: 4, midi: D5 },
    ],
  })

  it('the timeline exposes the tied pitch on the group of its tie end', () => {
    const t = buildTimeline(tied, { hands: 'right', range: null, multiplier: 1 })
    expect(t.groups.map((g) => g.tiedPitches)).toEqual([[], [], [], [G4]])
  })

  it('a press of a pitch tied into the current group is a tie-end press only', () => {
    const d = scored(tied)
    d.tap(G4, E4, F4)
    d.tap(G4)
    expect(d.state).toMatchObject({ groupIndex: 3, wrongAttacks: 0, groupHasError: false, groupWrongAttacks: 0 })
    expect(d.of('wrong').map((e) => e.reason)).toEqual(['tie-end'])
    expect(d.of('hint-shown')).toEqual([]) // the automatic hint threshold (1) is not fed
    d.tap(D5)
    const r = d.records()[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 0, passed: true, groupsFirstPass: 4 })
    expect(r.groups!.map((g) => g.tieEndPresses)).toEqual([0, 0, 0, 1])
    expect(r.measures.every((m) => m.wrongAttacks === 0)).toBe(true)
  })

  it('within the early grace before its group, it counts there; otherwise it is a wrong key', () => {
    const d = scored(tied)
    d.tap(G4, E4)
    d.tap(G4) // F4 is current: the tie end is due at the next group
    d.now += 50
    d.tap(F4) // the next group comes within the grace
    expect(d.state.groupIndex).toBe(3)
    expect(d.of('wrong').map((e) => [e.group, e.reason])).toEqual([[3, 'tie-end']])

    const late = scored(tied)
    late.tap(G4, E4)
    late.tap(G4)
    late.wait(200) // the grace ends while F4 is still current
    expect(late.of('wrong').map((e) => [e.group, e.reason])).toEqual([[2, 'pitch']])
    late.tap(F4, D5)
    const r = late.records()[0]!
    expect(r.groups!.map((g) => [g.wrongPitches, g.tieEndPresses])).toEqual([
      [[], 0],
      [[], 0],
      [[G4], 0],
      [[], 0],
    ])
  })

  it('a next-group pitch that is also tied into the current group expires as a tie-end press, not "ahead"', () => {
    const m = buildScore({
      notes: [
        { at: 0, dur: 2, midi: C4 },
        { at: 2, dur: 1, midi: C4, cont: true },
        { at: 2, midi: E4, voice: '2' },
        { at: 3, midi: C4 },
      ],
    })
    const d = scored(m)
    d.tap(C4)
    expect(d.engine.timeline.groups[1]!.tiedPitches).toEqual([C4])
    d.tap(C4)
    d.wait(200)
    expect(d.of('wrong').map((e) => [e.group, e.reason])).toEqual([[1, 'tie-end']])
    d.tap(E4, C4)
    expect(d.records()[0]).toMatchObject({ completion: 'completed', wrongAttacks: 0 })
  })
})

describe('sustain pedal', () => {
  // Pedal down from beat 2 to beat 4 (stop at beat 4): up, down, down, up.
  const pedaled = buildScore({
    notes: [C4, D4, E4, F4].map((midi, at) => ({ at, midi })),
    pedals: [
      { at: 1, type: 'start' },
      { at: 3, type: 'stop' },
    ],
  })

  it('compares the pedal at completion; a change toward the score within the grace still counts', () => {
    const d = scored(pedaled)
    d.tap(C4) // up as written
    d.now += 500
    d.tap(D4) // pedal still up: missing…
    d.now += PEDAL_GRACE_MS - 50
    d.cc(CC_SUSTAIN, 127) // …but pressed just after the attack: ok
    d.now += 500
    d.cc(CC_SUSTAIN, 0)
    d.tap(E4) // lifted: missing
    d.now += PEDAL_GRACE_MS + 50
    d.cc(CC_SUSTAIN, 127) // too late to count
    d.now += 500
    d.tap(F4) // still down where the score lifts: extra (the record is built at once)
    d.now += 20
    d.cc(CC_SUSTAIN, 0)
    const r = d.records()[0]!
    expect(r.groups!.map((g) => g.pedal)).toEqual(['ok', 'ok', 'missing', 'extra'])
  })

  it('a pedal lifted after the grace does not undo an ok; a wrong-way change keeps the mismatch', () => {
    const d = scored(pedaled)
    d.cc(CC_SUSTAIN, 127)
    d.tap(C4) // down where the score wants it up: extra…
    d.now += 40
    d.cc(CC_SUSTAIN, 30) // …lifted (below the threshold) within the grace: ok
    d.now += 400
    d.tap(D4) // up where the score wants it down: missing
    d.now += 40
    d.cc(CC_SUSTAIN, 10) // still up: no change of state, still missing
    d.engine.interrupt('user-stop', d.now)
    expect(d.records()[0]!.groups!.map((g) => g.pedal)).toEqual(['ok', 'missing', 'none'])
  })

  it("'none' without sustain marks, with checking off, and for a group not completed", () => {
    const plain = scored(buildScore({ notes: [0, 1].map((at) => ({ at, midi: C4 + at })) }))
    plain.cc(CC_SUSTAIN, 127)
    plain.tap(C4, C4 + 1)
    expect(plain.records()[0]!.groups!.map((g) => g.pedal)).toEqual(['none', 'none'])

    const off = scored(pedaled, { checkPedal: false })
    off.tap(C4, D4, E4, F4)
    expect(off.records()[0]!.groups!.every((g) => g.pedal === 'none')).toBe(true)

    const patched = scored(pedaled)
    patched.tap(C4)
    patched.engine.updateSettings({ checkPedal: false }, patched.now)
    patched.tap(D4)
    patched.engine.interrupt('user-stop', patched.now)
    expect(patched.records()[0]!.groups!.map((g) => g.pedal)).toEqual(['ok', 'none', 'none'])
  })
})
