/**
 * Chord slips (DECISIONS P24): a wrong key pressed with a chord belongs to that chord, whichever
 * order MIDI delivers the keys in, also for a pass's final chord.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS } from './engine'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { EngineConfig } from './types'

const C4 = 60
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69
const C3 = 48
const B2 = 47

// Bar 1: C–E chord, then G, then A; bar 2: C3 (left hand) and C4.
const model = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 0, midi: E4 },
    { at: 1, midi: G4 },
    { at: 3, midi: A4 },
    { at: 4, midi: C3, hand: 'L' },
    { at: 4, midi: C4 },
  ],
  bars: 2,
})

function scored(over: Partial<EngineConfig> = {}, range = { fromOcc: 0, toOcc: 1 }): EngineDriver {
  const t = buildTimeline(model, { hands: 'both', range, multiplier: 1 })
  return new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free', ...over })
}

describe('chord slips (P24)', () => {
  it('an extra key arriving just after the chord is a wrong attack of that chord', () => {
    const d = scored()
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(1)
    d.wait(CHORD_SLIP_MS).tap(F4)
    expect(d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[0, F4, 'pitch']])
    // The next group carries no error: no marker, no automatic hint (threshold 1), no count.
    expect(d.state).toMatchObject({ groupIndex: 1, groupHasError: false, groupWrongAttacks: 0, hint: null })
    expect(d.state.wrongAttacks).toBe(1)
    expect(d.state.wrongFeedbackUntil).toBeGreaterThan(d.now)
    d.tap(G4).tap(A4).tap(C3, C4)
    const r = d.records()[0]!
    expect(r.groups!.map((g) => [g.group, g.wrongAttacks, g.wrongPitches])).toEqual([
      [0, 1, [F4]],
      [1, 0, []],
      [2, 0, []],
      [3, 0, []],
    ])
    expect(r).toMatchObject({ wrongAttacks: 1, groupsFirstPass: 3, passed: false })
    expect(r.measures[0]).toMatchObject({ occ: 0, wrongAttacks: 1, groupsWithErrors: 1 })
  })

  it('the same as an extra key arriving before the chord’s last right key', () => {
    const d = scored()
    d.tap(C4, F4, E4).tap(G4).tap(A4).tap(C3, C4)
    const r = d.records()[0]!
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
    expect(r.groupsFirstPass).toBe(3)
  })

  it('a wrong key held from the chord is marked as held wrong', () => {
    const d = scored()
    d.tap(C4, E4).down(F4)
    expect(d.state.heldWrongKeys).toEqual([F4])
  })

  it('later than CHORD_SLIP_MS, or after a right key of the next group, it is the next group’s', () => {
    const late = scored()
    late
      .tap(C4, E4)
      .wait(CHORD_SLIP_MS + 1)
      .tap(F4)
    expect(late.of('wrong').map((w) => w.group)).toEqual([1])
    expect(late.state.groupHasError).toBe(true)

    const twice = scored()
    twice.tap(C4, E4).tap(F4, F4)
    // Both slips go to the chord: the next group's state is untouched by the first.
    expect(twice.of('wrong').map((w) => w.group)).toEqual([0, 0])
  })

  it('in a fast run the next note is never taken for a slip (nearer to its own moment)', () => {
    // Sixteenths at ♩ = 240: 62.5 ms apart.
    const run = buildScore({
      notes: [C4, E4, G4, A4].map((midi, i) => ({ at: { n: i, d: 16 }, midi })),
      tempo: { bpm: 240 },
      bars: 1,
    })
    const t = buildTimeline(run, { hands: 'right', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    d.tap(C4).wait(20).tap(F4) // 20 ms after C, 42.5 ms before E: with the C
    d.wait(40).tap(E4).wait(40).tap(F4) // 40 ms after E, 22.5 ms before G: a slip toward G
    expect(d.of('wrong').map((w) => w.group)).toEqual([0, 2])
  })

  it('accompaniment: the next gate’s ETA tells a slip from an early wrong key', () => {
    let eta = 500
    const d = scored({ transport: 'accompaniment', transportEta: () => eta })
    d.engine.transportArrived(0, d.now)
    d.tap(C4, E4).wait(10).tap(F4)
    eta = 30
    d.wait(30).tap(B2) // 40 ms after the chord, 30 ms before G's gate: G's mistake
    expect(d.of('wrong').map((w) => [w.group, w.pitch])).toEqual([
      [0, F4],
      [1, B2],
    ])
  })

  it('a chord ending a bar: the slip is the chord’s outcome, its bar evidence goes to the bar now current', () => {
    const d = scored({}, { fromOcc: 0, toOcc: 1 })
    d.tap(C4, E4).tap(G4).tap(A4).tap(F4).tap(C3, C4)
    const r = d.records()[0]!
    expect(r.groups![2]).toMatchObject({ group: 2, wrongPitches: [F4] })
    // Bar 1 had closed when the A completed it; bar 2 holds the count (no evidence is lost).
    expect(r.measures.map((m) => [m.occ, m.wrongAttacks])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })
})

describe('the final chord stays open for slips (finalSlipMs, P24)', () => {
  const lastBar = { fromOcc: 1, toOcc: 1 }

  it('a key pressed with the final chord is counted, and the attempt ends afterwards', () => {
    const d = scored({ finalSlipMs: CHORD_SLIP_MS }, lastBar)
    d.wait(100).tap(C3, C4)
    expect(d.state).toMatchObject({ phase: 'running', inputComplete: true, groupIndex: 0 })
    expect(d.engine.nextDeadline()).toBe(d.now + CHORD_SLIP_MS)
    d.wait(30).tap(B2)
    expect(d.records()).toEqual([])
    d.wait(CHORD_SLIP_MS - 30)
    const r = d.records()[0]!
    expect(d.state.phase).toBe('completed')
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false, groupsFirstPass: 0 })
    expect(r.groups![0]).toMatchObject({ wrongPitches: [B2] })
    // The completion time still ends at the chord's last right key.
    expect(r.completionTimeSec).toBe(0)
  })

  it('a clean final chord passes, ended by the next event or a tick after the hold', () => {
    const d = scored({ finalSlipMs: CHORD_SLIP_MS }, lastBar)
    d.tap(C3, C4)
    d.now += CHORD_SLIP_MS + 5
    d.up(C3) // no tick ran: the next event ends the attempt first
    expect(d.records()[0]).toMatchObject({ completion: 'completed', passed: true })
  })

  it('restart, seek or an interruption during the hold keeps the completed attempt', () => {
    const d = scored({ finalSlipMs: CHORD_SLIP_MS }, lastBar)
    d.tap(C3, C4)
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.flush()
    expect(d.records().map((r) => r.completion)).toEqual(['completed'])
    expect(d.state.phase).toBe('ready')
    d.tap(C3, C4)
    d.engine.interrupt('user-stop', d.now)
    expect(d.records().map((r) => r.completion)).toEqual(['completed', 'completed'])
  })

  it('without finalSlipMs (the default) the attempt ends at the final key', () => {
    const d = scored({}, lastBar)
    d.tap(C3, C4)
    expect(d.state.phase).toBe('completed')
  })

  it('strict: a missed final group is not held, a completed one is', () => {
    const t = buildTimeline(model, { hands: 'both', range: lastBar, multiplier: 1 })
    const d = new EngineDriver(t, {
      mode: 'scored',
      pieceId: 'p',
      prepared: true,
      transport: 'strict',
      rhythm: { toleranceMs: 150 },
      finalSlipMs: CHORD_SLIP_MS,
    })
    d.engine.startRunning(d.now)
    d.engine.transportArrived(0, d.now)
    d.tap(C3, C4)
    // The strict close never fires while the completed group is held.
    d.wait(CHORD_SLIP_MS)
    expect(d.records()[0]).toMatchObject({ completion: 'completed', missedGroups: 0 })
  })
})
