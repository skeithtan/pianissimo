/**
 * Per-group outcomes for the teacher corrections (DECISIONS E15–E16): wrong pitches, chord
 * spread and tie-end presses; those of reading traversals feed a Wait run's result (U142).
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS, STRIKE_GAP_MS } from './engine'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { EngineConfig } from './types'

const B3 = 59
const C4 = 60
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
    d.tap(B3, B3, C4).wait(200).tap(F4)
    d.engine.interrupt('user-stop', d.now)
    const r = d.records()[0]!
    expect(r.completion).toBe('abandoned')
    expect(r.groups!.map((g) => [g.group, g.wrongAttacks, g.wrongPitches])).toEqual([
      [0, 2, [B3, B3]],
      [1, 1, [F4]],
    ])
  })
})

describe('reading traversals (U142)', () => {
  const m = buildScore({
    notes: [
      { at: 0, midi: C4 },
      { at: 1, midi: C4 },
      { at: 1, midi: E4 },
      { at: 2, midi: F4 },
      { at: 3, midi: G4 },
    ],
  })
  const timeline = (multiplier = 1) => buildTimeline(m, { hands: 'right', range: null, multiplier })
  const reading = (over: Partial<EngineConfig> = {}) =>
    new EngineDriver(timeline(), { mode: 'reading', pieceId: 'p', transport: 'free', ...over })

  it('carry the outcome of every group reached, from where they began', () => {
    const d = reading({ startGroup: 1 })
    d.tap(B3, C4, E4)
    d.engine.seek(0, d.now)
    d.flush()
    const [r] = d.records()
    expect(r).toMatchObject({ kind: 'reading', interruptReason: 'seek', passed: false, groupsFirstPass: 0 })
    expect(r!.groups).toEqual([
      {
        group: 1,
        wrongAttacks: 1,
        earlyAttacks: 0,
        lateMs: 0,
        wrongPitches: [B3],
        extraPitches: [B3],
        spreadMs: 0,
        tieEndPresses: 0,
      },
      { group: 2, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, wrongPitches: [], spreadMs: 0, tieEndPresses: 0 },
    ])
    expect(r!.onsets.map((o) => o.group)).toEqual([1])
  })

  it('a speed change splits the group it is at: each part has its own presses', () => {
    const d = reading()
    d.tap(C4).wait(200).tap(D5, C4)
    d.engine.reconfigure({ reason: 'tempo-change', timeline: timeline(0.5), transport: 'free' }, d.now)
    d.flush()
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [C4], phase: 'running' })
    d.tap(E4)
    d.engine.interrupt('seek', d.now)
    const [before, after] = d.records()
    expect(before!.groups!.map((g) => [g.group, g.wrongPitches])).toEqual([
      [0, []],
      [1, [D5]],
    ])
    expect(before!.onsets.map((o) => o.group)).toEqual([0])
    expect(after!.groups!.map((g) => [g.group, g.wrongPitches])).toEqual([
      [1, []],
      [2, []],
    ])
    expect(after!.onsets.map((o) => o.group)).toEqual([1])
    // Not right the first time: the wrong key came before the split.
    expect(after!.groupsFirstPass).toBe(0)
  })

  it('a split group left half played is reached in both parts, completed in neither', () => {
    const d = reading()
    d.tap(C4).wait(200).tap(C4)
    d.engine.reconfigure({ reason: 'tempo-change', timeline: timeline(0.5), transport: 'free' }, d.now)
    d.tap(C4) // a replay: the traversal has begun
    d.engine.seek(3, d.now)
    d.flush()
    expect(d.records().map((r) => [r.groups!.map((g) => g.group), r.onsets.map((o) => o.group)])).toEqual([
      [[0, 1], [0]],
      [[1], []],
    ])
  })

  it('a pause is neither lateness nor spread of the group it interrupted', () => {
    const d = reading({ transport: 'accompaniment', transportEta: () => 0 })
    d.engine.transportArrived(0, d.now)
    d.tap(C4)
    d.now += 1000
    d.engine.transportArrived(1, d.now)
    d.now += 400
    d.tap(C4)
    d.now += 50
    d.engine.pause(d.now)
    d.now += 60_000
    d.engine.resume(d.now)
    d.now += 100
    d.tap(E4)
    d.engine.interrupt('seek', d.now)
    expect(d.records()[0]!.groups![1]).toMatchObject({ group: 1, lateMs: 550, spreadMs: 150 })
  })

  it('a key pressed with the piece’s final chord is counted; a pause ends the hold first', () => {
    const d = reading({ finalSlipMs: CHORD_SLIP_MS })
    d.tap(C4).tap(C4, E4).tap(F4).tap(G4)
    expect(d.state).toMatchObject({ phase: 'running', inputComplete: true, groupIndex: 3 })
    d.wait(CHORD_SLIP_MS / 2).tap(D5)
    d.wait(CHORD_SLIP_MS)
    expect(d.state.phase).toBe('completed')
    expect(d.records()[0]).toMatchObject({ completion: 'completed', wrongAttacks: 1, groupsFirstPass: 3 })

    const paused = reading({ finalSlipMs: CHORD_SLIP_MS })
    paused.tap(C4).tap(C4, E4).tap(F4).tap(G4)
    paused.engine.pause(paused.now)
    paused.flush()
    expect(paused.state.phase).toBe('completed')
    expect(paused.records()[0]).toMatchObject({ completion: 'completed', wrongAttacks: 0 })
  })

  it('a reading passage (a lead-in) is not held: the attempt it leads into takes over at once', () => {
    const t = buildTimeline(m, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const d = new EngineDriver(t, {
      mode: 'reading',
      pieceId: 'p',
      transport: 'free',
      finalSlipMs: CHORD_SLIP_MS,
    })
    d.tap(C4).tap(C4, E4).tap(F4).tap(G4)
    expect(d.state.phase).toBe('completed')
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

describe('extraPitches (with the stroke vs alone)', () => {
  const chord = buildScore({
    notes: [
      { at: 0, midi: C4 },
      { at: 0, midi: E4 },
      { at: 1, midi: G4 },
    ],
  })

  it('a neighbor key with a chord in both orders (20 ms apart) is extra', () => {
    // Wrong key 20 ms after a right key, before the chord completes.
    const after = scored(chord)
    after.tap(C4).wait(20).tap(F4).wait(20).tap(E4).tap(G4)
    expect(after.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [F4], extraPitches: [F4] })

    // Wrong key 20 ms before the first right key.
    const before = scored(chord)
    before.tap(F4).wait(20).tap(C4, E4).tap(G4)
    expect(before.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [F4], extraPitches: [F4] })
  })

  it('a wrong key alone 300 ms before the right one is not extra (extraPitches: [])', () => {
    const d = scored(chord)
    d.tap(F4).wait(300).tap(C4, E4).tap(G4)
    const g0 = d.records()[0]!.groups![0]!
    expect(g0.wrongPitches).toEqual([F4])
    expect(g0.extraPitches).toEqual([])
  })

  it('a chord slip is extra on the previous group', () => {
    const d = scored(chord)
    d.tap(C4, E4).wait(20).tap(F4).wait(200).tap(G4)
    const r = d.records()[0]!
    expect(r.groups![0]).toMatchObject({ wrongPitches: [F4], extraPitches: [F4] })
    expect(r.groups![1]!.wrongPitches).toEqual([])
    expect('extraPitches' in r.groups![1]!).toBe(false)
  })

  it('wrong key then right key 59 ms later is extra; 61 ms later is not', () => {
    const inside = scored(chord)
    inside.tap(F4).wait(59).tap(C4, E4).tap(G4)
    expect(inside.records()[0]!.groups![0]!.extraPitches).toEqual([F4])

    const outside = scored(chord)
    outside.tap(F4).wait(61).tap(C4, E4).tap(G4)
    expect(outside.records()[0]!.groups![0]!.extraPitches).toEqual([])
  })

  it('an ahead expiry is judged by its own press time', () => {
    // G4 (next group) pressed 20 ms after C4 of group 0, then expires after 120 ms grace -> extra.
    const withRight = scored(chord)
    // The strike with the wrong key ended (P33): the chord is struck again whole.
    withRight.tap(C4).wait(20).tap(G4).wait(200).tap(C4, E4).tap(G4)
    expect(withRight.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [G4], extraPitches: [G4] })

    // G4 pressed 20 ms BEFORE C4 of group 0, then expires -> still extra (right strike was 20 ms after press).
    const beforeRight = scored(chord)
    beforeRight.tap(G4).wait(20).tap(C4).wait(200).tap(C4, E4).tap(G4)
    expect(beforeRight.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [G4], extraPitches: [G4] })

    // G4 pressed alone, no right strike within 60 ms -> not extra.
    const alone = scored(chord)
    alone.tap(G4).wait(200).tap(C4, E4).tap(G4)
    expect(alone.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [G4], extraPitches: [] })
  })

  it('a group with no wrong key has no extraPitches field', () => {
    const d = scored(chord)
    d.tap(C4, E4).tap(G4)
    const r = d.records()[0]!
    expect('extraPitches' in r.groups![0]!).toBe(false)
    expect('extraPitches' in r.groups![1]!).toBe(false)
  })

  it('a right strike discarded inside a retry window still counts as together with the wrong key', () => {
    const d = scored(chord)
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    // Guarded F4 triggers the retry window (the rest of the strike, P33); C4 20 ms later is
    // discarded by it, but still counts as a right strike -> F4 is extra.
    d.tap(F4).wait(20).tap(C4).wait(STRIKE_GAP_MS).tap(C4, E4).wait(100).tap(G4)
    expect(d.records()[0]!.groups![0]).toMatchObject({ wrongPitches: [F4], extraPitches: [F4] })
  })

  it('prunes aged-out undecided wrong presses so a later wrong key with the chord is still extra', () => {
    const d = scored(chord)
    const D4 = 62
    for (let i = 0; i < 8; i++) d.tap(B3).wait(200)
    d.tap(D4).wait(10).tap(C4, E4).tap(G4)
    expect(d.records()[0]!.groups![0]!.extraPitches).toEqual([D4])
  })
})

describe('lateHand for two-hand chords', () => {
  const C3 = 48
  const E3 = 52
  const G3 = 55

  function scoredBoth(model: ReturnType<typeof buildScore>): EngineDriver {
    const t = buildTimeline(model, { hands: 'both', range: null, multiplier: 1 })
    return new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
  }

  it('records lateHand when every accepted attack of one hand came before every accepted attack of the other', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C3, hand: 'L' },
        { at: 0, midi: G3, hand: 'L' },
        { at: 0, midi: C4, hand: 'R' },
        { at: 0, midi: E4, hand: 'R' },
        { at: 1, midi: C3, hand: 'L' },
        { at: 1, midi: G4, hand: 'R' },
      ],
    })
    const d = scoredBoth(m)
    // Group 0: both R notes (1000, 1010) before both L notes (1030, 1040) -> lateHand: 'L'.
    d.tap(C4).wait(10).tap(E4).wait(20).tap(C3).wait(10).tap(G3)
    // Group 1: L (1050) before R (1070) -> lateHand: 'R'.
    d.wait(10).tap(C3).wait(20).tap(G4)
    const r = d.records()[0]!
    expect(r.groups![0]!.lateHand).toBe('L')
    expect(r.groups![1]!.lateHand).toBe('R')
  })

  it('omits lateHand when the hands are interleaved', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C3, hand: 'L' },
        { at: 0, midi: E3, hand: 'L' },
        { at: 0, midi: C4, hand: 'R' },
      ],
    })
    const d = scoredBoth(m)
    // L (C3) -> R (C4) -> L (E3): interleaved.
    d.tap(C3).wait(15).tap(C4).wait(15).tap(E3)
    const g0 = d.records()[0]!.groups![0]!
    expect('lateHand' in g0).toBe(false)
  })

  it('omits lateHand for a one-hand chord', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4, hand: 'R' },
        { at: 0, midi: E4, hand: 'R' },
        { at: 0, midi: G4, hand: 'R' },
      ],
    })
    const d = scoredBoth(m)
    d.tap(C4).wait(20).tap(E4).wait(20).tap(G4)
    const g0 = d.records()[0]!.groups![0]!
    expect('lateHand' in g0).toBe(false)
  })

  it('omits lateHand when a pitch is shared by notes of both hands', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C3, hand: 'L' },
        { at: 0, midi: C4, hand: 'L' },
        { at: 0, midi: C4, hand: 'R' },
        { at: 0, midi: E4, hand: 'R' },
      ],
    })
    const d = scoredBoth(m)
    d.tap(E4).wait(20).tap(C4).wait(20).tap(C3)
    const g0 = d.records()[0]!.groups![0]!
    expect('lateHand' in g0).toBe(false)
  })

  it('computes lateHand cleanly from the post-retry stroke after a retry reset', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C3, hand: 'L' },
        { at: 0, midi: C4, hand: 'R' },
        { at: 1, midi: G4, hand: 'R' },
      ],
    })
    const d = scoredBoth(m)
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    // First stroke: L (C3) then guarded F4 20 ms later -> retry clears accept timing.
    d.tap(C3).wait(20).tap(F4)
    // Post-retry stroke: R (C4) before L (C3) -> lateHand must be 'L', not polluted by pre-retry C3.
    d.wait(STRIKE_GAP_MS).tap(C4).wait(25).tap(C3).wait(100).tap(G4)
    expect(d.records()[0]!.groups![0]!.lateHand).toBe('L')
  })
})
