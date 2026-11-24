/**
 * One test per row of the spec's "Score following" situation table, plus the acceptance rows
 * Wrong note, Chord recovery, Wide rolled chords, Attack memory and sequence, Played versus
 * held display and Sustain and ties.
 */
import { describe, expect, it } from 'vitest'
import { CC_SUSTAIN } from '../midi/types'
import type { ScoreSpec } from './testkit'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { LearnerHands } from './timeline'

const A2 = 45
const C3 = 48
const E3 = 52
const C4 = 60
const D4 = 62
const E4 = 64
const G4 = 67
const C5 = 72

function reading(spec: ScoreSpec, hands: LearnerHands = 'both'): EngineDriver {
  const t = buildTimeline(buildScore(spec), { hands, range: null, multiplier: 1 })
  return new EngineDriver(t, { mode: 'reading', pieceId: 'p', transport: 'free' })
}

describe('Score following situation table', () => {
  it('Single note: requires a fresh press of the expected sounding pitch and octave', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
      ],
    })
    d.tap(C5)
    expect(d.state.groupIndex).toBe(0)
    expect(d.of('wrong')).toHaveLength(1)
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
  })

  it('Block chord: any order, remembered after release, input completes once', () => {
    const d = reading({ notes: [C4, E4, G4].map((midi) => ({ at: 0, midi })).concat([{ at: 1, midi: D4 }]) })
    d.tap(G4)
    expect(d.state.acceptedPitches).toEqual([G4])
    expect(d.state.heldKeys).toEqual([])
    d.tap(C4)
    expect(d.state.acceptedPitches).toEqual([C4, G4])
    expect(d.state.missingPitches).toEqual([E4])
    d.tap(E4)
    expect(d.of('input-complete')).toEqual([{ type: 'input-complete', group: 0, time: d.now }])
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
  })

  it('Marked rolled chord: wide cross-staff roll completes with successive released presses', () => {
    const d = reading({
      notes: [
        { at: 0, midi: A2, roll: 1, offset: 0 },
        { at: 0, midi: E3, roll: 1, offset: 0.04 },
        { at: 0, midi: C4, roll: 1, offset: 0.08, staff: 0, hand: 'L' },
        { at: 0, midi: G4, roll: 1, offset: 0.12, staff: 0 },
        { at: 1, midi: D4 },
      ],
    })
    for (const n of [A2, E3, C4]) {
      d.down(n)
      d.now += 2000
      d.up(n)
    }
    expect(d.state.inputComplete).toBe(false)
    d.tap(G4)
    expect(d.of('input-complete')).toHaveLength(1)
    expect(d.of('wrong')).toHaveLength(0)
  })

  // DECISIONS P33: a roll is one strike spread over time, bottom to top or top to bottom.
  describe('Marked rolled chord with a wrong key', () => {
    const rolled = (): EngineDriver =>
      reading({
        notes: [
          ...[A2, E3, C4, G4].map((midi, i) => ({ at: 0, midi, roll: 1, offset: 0.04 * i })),
          { at: 1, midi: D4 },
        ],
      })

    it.each([
      ['up', [A2, E3, 61, C4, G4]],
      ['down', [G4, 61, C4, E3, A2]],
    ])('a slip in an unhurried roll %s advances', (_, keys) => {
      const d = rolled()
      for (const k of keys) d.wait(220).tap(k)
      expect(d.state).toMatchObject({ groupIndex: 1, wrongAttacks: 1 })
    })

    it('the roll’s own first notes count at once when the next group repeats them', () => {
      const d = reading({
        notes: [
          ...[A2, E3, C4, G4].map((midi, i) => ({ at: 0, midi, roll: 1, offset: 0.04 * i })),
          { at: 1, midi: A2 },
          { at: 2, midi: D4 },
        ],
      })
      for (const k of [A2, E3, 61, C4, G4, A2]) d.wait(220).tap(k)
      expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 1 })
    })

    it('a roll that stops at a wrong key is rolled again whole', () => {
      const d = rolled()
      d.down(A2).wait(100).down(E3).wait(100).tap(61).wait(1000).tap(C4).wait(100).tap(G4).wait(1000)
      expect(d.state.groupIndex).toBe(0)
      d.up(A2, E3)
      for (const k of [A2, E3, C4, G4]) d.wait(100).tap(k)
      expect(d.state.groupIndex).toBe(1)
    })
  })

  it('Reattack within an incomplete group: no progress, no error, cannot prefill a later group', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: C4 },
      ],
    })
    d.tap(C4).tap(C4)
    expect(d.of('replay')).toHaveLength(1)
    expect(d.of('wrong')).toHaveLength(0)
    expect(d.state.acceptedPitches).toEqual([C4])
    d.tap(E4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
    d.tap(C4)
    expect(d.state.phase).toBe('completed')
  })

  it('Partly correct chord: accepted pitches marked apart from physical keys; silence and release are no errors', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 0, midi: G4 },
      ],
    })
    d.down(C4)
    expect(d.state.acceptedPitches).toEqual([C4])
    expect(d.state.heldKeys).toEqual([C4])
    d.up(C4).wait(60_000)
    expect(d.state.acceptedPitches).toEqual([C4])
    expect(d.state.heldKeys).toEqual([])
    expect(d.state.wrongAttacks).toBe(0)
    expect(d.state.missingPitches).toEqual([E4, G4])
  })

  it('Wrong extra key: counted once immediately, never satisfies a later target, the group is struck again', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: D4 },
        { at: 2, midi: D4 },
      ],
    })
    d.down(C4).up(C4).down(G4)
    expect(d.of('wrong').map((w) => w.reason)).toEqual(['pitch'])
    expect(d.state.heldWrongKeys).toEqual([G4])
    // A next-group pitch is judged after the grace window: still held, it is an "ahead" error.
    d.down(D4).wait(150)
    expect(d.of('wrong').map((w) => w.reason)).toEqual(['pitch', 'ahead'])
    expect(d.state.acceptedPitches).toEqual([])
    expect(d.state.heldWrongKeys).toEqual([D4, G4])
    // Both required keys in one stroke complete the group, also over held wrong keys.
    d.up(G4).wait(1000).tap(E4, C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.wrongAttacks).toBe(2)
    // The still-held D4 is the next target but needs a fresh attack.
    expect(d.state.acceptedPitches).toEqual([])
    expect(d.state.heldWrongKeys).toEqual([D4])
    d.up(D4)
    expect(d.state.wrongAttacks).toBe(2)
    expect(d.state.heldWrongKeys).toEqual([])
    d.tap(D4)
    expect(d.state.groupIndex).toBe(2)
  })

  // DECISIONS P33: one hand right and held, the other corrected.
  describe.each(['reading', 'scored'] as const)('%s: after a wrong key both hands strike again', (mode) => {
    const twoHands = buildScore({
      notes: [
        { at: 0, midi: C3, hand: 'L' },
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
      ],
      bars: 1,
    })
    function driver(): EngineDriver {
      const range = mode === 'scored' ? { fromOcc: 0, toOcc: 0 } : null
      const t = buildTimeline(twoHands, { hands: 'both', range, multiplier: 1 })
      return new EngineDriver(t, { mode, pieceId: 'p', transport: 'free', prepared: true })
    }

    // The held hand came this long after (negative: before) the wrong key.
    it.each([-100, -20, 0, 20, 100])('the held hand does not count (%i ms)', (lead) => {
      const d = driver()
      if (lead < 0) d.down(C3).wait(-lead).down(E4)
      else d.down(E4).wait(lead).down(C3)
      d.wait(1000).up(E4).wait(300).down(C4).wait(1000)
      expect(d.state).toMatchObject({ groupIndex: 0, acceptedPitches: [C4], missingPitches: [C3] })
      d.up(C3).wait(200).down(C3)
      expect(d.state).toMatchObject({ groupIndex: 1, wrongAttacks: 1 })
    })

    it.each([
      [C3, C4],
      [C4, C3],
    ])('then both hands together advance cleanly, whichever lands first (%i)', (first, second) => {
      const d = driver()
      d.down(C3).down(E4).wait(500).up(E4).wait(300).down(C4).wait(1000).up(C3, C4).wait(300)
      d.down(first).wait(100).down(second)
      expect(d.state).toMatchObject({ groupIndex: 1, wrongAttacks: 1, acceptedPitches: [], groupHasError: false })
      // Once: the same key again is a press at the next group.
      d.wait(20).up(C4).down(C4).wait(200)
      expect(d.state.wrongAttacks).toBe(2)
    })

    it('nor when the corrected key goes down before the wrong one is up', () => {
      const d = driver()
      d.down(E4).wait(100).down(C3).wait(1000).down(C4).wait(100).up(E4).wait(1000)
      expect(d.state).toMatchObject({ groupIndex: 0, acceptedPitches: [] })
      d.up(C3, C4).wait(200).down(C3).wait(500).down(C4)
      expect(d.state.groupIndex).toBe(1)
    })

    // [key, ms after the one before]: hands up to 120 ms apart, a slip anywhere, a left hand waiting already.
    it.each([
      [
        [C3, 0],
        [E4, 15],
        [C4, 15],
      ],
      [
        [E4, 0],
        [C3, 15],
        [C4, 15],
      ],
      [
        [C3, 0],
        [C4, 15],
        [E4, 15],
      ],
      [
        [E4, 0],
        [C4, 5],
        [C3, 120],
      ],
      [
        [C3, 0],
        [E4, 100],
        [C4, 10],
      ],
      [
        [C3, 0],
        [E4, 2000],
        [C4, 10],
      ],
    ])('all the right keys and a slip in one strike advance (%#)', (...keys) => {
      const d = driver()
      for (const [k, gap] of keys) d.wait(gap!).down(k!)
      expect(d.state).toMatchObject({ groupIndex: 1, wrongAttacks: 1 })
    })
  })

  it('Repeated untied pitch: a held note cannot satisfy the next occurrence', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: C4 },
        { at: 2, midi: D4 },
      ],
    })
    d.down(C4)
    expect(d.state.groupIndex).toBe(1)
    d.wait(5000)
    expect(d.state.groupIndex).toBe(1)
    d.up(C4).down(C4)
    expect(d.state.groupIndex).toBe(2)
  })

  it('Tied continuation: no further attack is demanded', () => {
    const d = reading({
      notes: [
        { at: 0, dur: 4, midi: C4 },
        { at: 4, dur: 2, midi: C4, cont: true },
        { at: 4, midi: E4 },
        { at: 6, midi: D4 },
      ],
    })
    d.down(C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.missingPitches).toEqual([E4])
    d.tap(E4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.wrongAttacks).toBe(0)
  })

  it('Sustain resonance: tracked separately and never satisfies a fresh attack', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: C4 },
      ],
    })
    d.cc(CC_SUSTAIN, 127).tap(C4)
    expect(d.state.sustainDown).toBe(true)
    expect(d.state.groupIndex).toBe(1)
    d.wait(3000)
    expect(d.state.groupIndex).toBe(1)
    expect(d.of('accepted')).toHaveLength(1)
    d.cc(CC_SUSTAIN, 0)
    expect(d.state.sustainDown).toBe(false)
    expect(d.of('pedal').map((e) => e.down)).toEqual([true, false])
  })

  it('Shared pitch in two voices: one physical attack satisfies both notes', () => {
    const d = reading({
      notes: [
        { at: 0, midi: G4, voice: '1' },
        { at: 0, midi: G4, voice: '2', dur: 2 },
        { at: 1, midi: E4 },
      ],
    })
    d.tap(G4)
    expect(d.of('accepted')[0]!.notes).toHaveLength(2)
    expect(d.state.groupIndex).toBe(1)
  })

  it('Notes held from a previous group are not new wrong attacks', () => {
    const d = reading({
      notes: [
        { at: 0, dur: 4, midi: C3 },
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
        { at: 2, midi: E4 },
      ],
    })
    d.down(C3, C4).up(C4)
    d.tap(D4)
    d.wait(2000).tap(E4)
    d.up(C3)
    expect(d.state.wrongAttacks).toBe(0)
    expect(d.state.phase).toBe('completed')
  })

  it('Rest or tie-only position: the cursor moves to the next playable onset', () => {
    const d = reading({
      notes: [
        { at: 0, dur: 2, midi: C4 },
        { at: 2, dur: 1, midi: C4, cont: true },
        { at: 4, midi: E4 },
      ],
    })
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.targetNotes.map((i) => d.engine.timeline.model.notes[i]!.midi)).toEqual([E4])
  })

  it('Notes played ahead of the current incomplete group are errors and are not buffered', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: D4 },
        { at: 2, midi: G4 },
      ],
    })
    d.tap(C4).tap(D4)
    d.now += 150
    d.tap(G4)
    expect(d.of('wrong').map((w) => [w.reason, w.pitch])).toEqual([
      ['ahead', D4],
      ['pitch', G4],
    ])
    d.wait(100).tap(E4)
    expect(d.state.groupIndex).toBe(0)
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
  })
})

describe('Input contract', () => {
  it('every event is consumed at most once (by seq)', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
      ],
    })
    const ev = d.midi.on(D4, d.now)
    d.engine.input(ev)
    d.engine.input(ev)
    expect(d.state.wrongAttacks).toBe(1)
  })

  it('controllers never attack and zero-velocity Note On is a release', () => {
    const d = reading({ notes: [{ at: 0, midi: C4 }] })
    d.cc(64, 127).cc(67, 127).cc(1, 64)
    expect(d.state.clockStartedAt).toBeNull()
    d.down(C4)
    d.engine.input({ kind: 'noteon', seq: 1000, channel: 0, note: C4, velocity: 0, time: d.now, portId: 'x' })
    expect(d.state.heldKeys).toEqual([])
    expect(d.of('accepted')).toHaveLength(1)
  })

  it('All Notes Off from the instrument releases held keys without errors', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
      ],
    })
    d.down(E4).cc(123, 0)
    expect(d.state.heldKeys).toEqual([])
    expect(d.state.heldWrongKeys).toEqual([])
    expect(d.state.wrongAttacks).toBe(1)
  })
})

describe('Acceptance: Wrong note', () => {
  it('produces conspicuous feedback events and does not advance; repeats extend the wash monotonically', () => {
    const d = reading({ notes: [{ at: 0, midi: C4 }] })
    d.tap(D4)
    const first = d.state.wrongFeedbackUntil
    expect(first).toBe(d.now + 300)
    expect(d.state.groupHasError).toBe(true)
    expect(d.state.groupIndex).toBe(0)
    d.now += 100
    d.tap(E4)
    const second = d.state.wrongFeedbackUntil
    expect(second).toBe(d.now + 300)
    expect(second).toBeGreaterThan(first)
    expect(d.of('wrong').map((w) => w.feedbackUntil)).toEqual([first, second])
    // An out-of-order (earlier-stamped) wrong press never shortens the wash.
    d.engine.input(d.midi.on(G4, d.now - 250))
    expect(d.state.wrongFeedbackUntil).toBe(second)
  })

  it('the local marker clears on correct completion', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: D4 },
      ],
    })
    d.tap(G4).tap(C4)
    expect(d.state.groupHasError).toBe(true)
    d.tap(E4)
    expect(d.state.groupHasError).toBe(false)
  })

  it('several wrong keys in a chord count separately; holding or releasing adds none', () => {
    const d = reading({ notes: [{ at: 0, midi: C4 }] })
    d.down(D4, E4)
    d.wait(1000).up(D4, E4)
    expect(d.state.wrongAttacks).toBe(2)
    expect(d.state.groupWrongAttacks).toBe(2)
  })
})

describe('Acceptance: Chord recovery', () => {
  it('partial attacks survive release and a wrong attack; completion happens once with a wrong key held', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 0, midi: G4 },
        { at: 1, midi: D4 },
      ],
    })
    d.tap(C4).down(A2).tap(E4)
    expect(d.state.acceptedPitches).toEqual([C4, E4])
    d.tap(G4)
    expect(d.of('input-complete')).toHaveLength(1)
    expect(d.state.heldWrongKeys).toEqual([A2])
    d.tap(C4)
    expect(d.of('input-complete')).toHaveLength(1)
    expect(d.state.wrongAttacks).toBe(2)
  })
})

describe('Acceptance: Wide rolled chords (each hand)', () => {
  const spec: ScoreSpec = {
    notes: [
      { at: 0, midi: A2, roll: 1, offset: 0, hand: 'L' },
      { at: 0, midi: E3, roll: 1, offset: 0.06, hand: 'L' },
      { at: 0, midi: C4, roll: 1, offset: 0.12, hand: 'L' },
      { at: 0, midi: E4, roll: 2, offset: 0 },
      { at: 0, midi: G4, roll: 2, offset: 0.06 },
      { at: 1, midi: C5 },
    ],
  }
  for (const [hands, pitches] of [
    ['both', [A2, E3, C4, E4, G4]],
    ['left', [A2, E3, C4]],
    ['right', [E4, G4]],
  ] as const) {
    it(`${hands}: successive presses, releasing earlier keys first, complete the roll`, () => {
      const d = reading(spec, hands)
      for (const p of pitches) {
        d.down(p)
        d.now += 500
        d.up(p)
      }
      expect(d.of('input-complete').map((e) => e.group)).toEqual([0])
      expect(d.state.wrongAttacks).toBe(0)
    })
  }
})

describe('Acceptance: Played versus held display (state)', () => {
  it('accepted stays after release until advance; held and sustain are separate; advancing clears', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: D4 },
      ],
    })
    d.cc(CC_SUSTAIN, 100).down(C4)
    expect(d.state.acceptedNotes).toHaveLength(1)
    expect(d.state.heldKeys).toEqual([C4])
    d.up(C4)
    expect(d.state.acceptedPitches).toEqual([C4])
    expect(d.state.heldKeys).toEqual([])
    expect(d.state.sustain).toBe(100)
    d.tap(E4)
    expect(d.state.acceptedPitches).toEqual([])
  })

  it('snapshots are reused until something changes', () => {
    const d = reading({ notes: [{ at: 0, midi: C4 }] })
    const a = d.state
    expect(d.state).toBe(a)
    d.engine.tick(d.now + 1)
    expect(d.state).toBe(a)
    d.down(D4)
    expect(d.state).not.toBe(a)
    expect(d.state.version).toBeGreaterThan(a.version)
  })
})

describe('Acceptance: Attack memory and sequence; Sustain and ties', () => {
  it('a later untied repeat needs release and press; sustain and ties create no attacks', () => {
    const d = reading({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, dur: 2, midi: E4 },
        { at: 3, dur: 1, midi: E4, cont: true },
        { at: 3, midi: G4 },
        { at: 4, midi: C4 },
      ],
      bars: 2,
    })
    d.cc(CC_SUSTAIN, 127).tap(C4)
    d.tap(C4)
    expect(d.of('wrong')).toHaveLength(1)
    d.down(E4)
    expect(d.state.missingPitches).toEqual([G4])
    d.tap(G4)
    expect(d.state.groupIndex).toBe(3)
    d.up(E4).down(C4)
    expect(d.state.phase).toBe('completed')
  })
})
