/**
 * Retry when an extra key repeats on the second pass of an automatic Repeat run (DECISIONS P26),
 * and its interaction with the early-press grace (E12) and retry window.
 */
import { describe, expect, it } from 'vitest'
import { CHORD_SLIP_MS, STRIKE_GAP_MS } from './engine'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { EngineConfig } from './types'

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69

// Bar 1: C–E chord, then G, then A.
const model = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 0, midi: E4 },
    { at: 1, midi: G4 },
    { at: 2, midi: A4 },
  ],
  bars: 1,
})

function scored(over: Partial<EngineConfig> = {}, score = model): EngineDriver {
  const t = buildTimeline(score, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
  return new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free', ...over })
}

/** Complete pass 1 with a chord slip `wrong` on group 0, then start pass 2. */
function secondPassWithSlip(
  d: EngineDriver,
  wrong: number,
  options: { continueRepeat?: boolean } = { continueRepeat: true },
): void {
  d.tap(C4, E4).wait(20).tap(wrong).tap(G4).tap(A4)
  expect(d.records()).toHaveLength(1)
  expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([wrong])
  d.engine.restart(d.now, options)
  d.engine.markPrepared(d.now)
  d.flush()
  expect(d.state.phase).toBe('ready')
}

/**
 * Minimal session-like accompaniment transport: holds at each gate until the engine emits
 * `input-complete` for that group, then schedules the next gate `gapMs` later. `eta` returns null
 * while any earlier gate is unreleased.
 */
class SessionTransport {
  readonly #gapMs: number
  readonly #released = new Set<number>()
  readonly #arrived = new Set<number>()
  readonly #due = new Map<number, number>()
  #seen = 0

  constructor(gapMs: number) {
    this.#gapMs = gapMs
  }

  arriveAt(d: EngineDriver, group: number): void {
    this.#arrived.add(group)
    this.#due.set(group, d.now)
    d.engine.transportArrived(group, d.now)
    d.flush()
    this.sync(d)
  }

  sync(d: EngineDriver): void {
    d.flush()
    while (this.#seen < d.log.length) {
      const ev = d.log[this.#seen++]!
      if (ev.type === 'input-complete' && !this.#released.has(ev.group)) {
        this.#released.add(ev.group)
        const g = ev.group
        if (!this.#arrived.has(g)) {
          let blockedEarlier = false
          for (let j = 0; j < g; j++) {
            if (!this.#arrived.has(j)) {
              blockedEarlier = true
              break
            }
          }
          if (!blockedEarlier) {
            this.#arrived.add(g)
            this.#due.set(g, d.now)
            d.engine.transportArrived(g, d.now)
            d.flush()
          }
        }
        this.#due.set(g + 1, d.now + this.#gapMs)
      }
    }
    for (const [g, at] of [...this.#due].sort((a, b) => a[0] - b[0])) {
      if (!this.#arrived.has(g) && at <= d.now) {
        this.#arrived.add(g)
        d.engine.transportArrived(g, at)
        d.flush()
      }
    }
  }

  eta = (group: number, at: number): number | null => {
    if (this.#arrived.has(group)) return 0
    for (let j = 0; j < group; j++) {
      if (!this.#released.has(j)) return null
    }
    const due = this.#due.get(group)
    return due === undefined ? null : Math.max(0, due - at)
  }

  reset(d: EngineDriver): void {
    d.flush()
    this.#released.clear()
    this.#arrived.clear()
    this.#due.clear()
    this.#seen = d.log.length
  }
}

/** Complete pass 1 in accompaniment with a chord slip `wrong` on group 0, then start pass 2. */
function secondPassAccompaniment(
  d: EngineDriver,
  transport: SessionTransport,
  wrong: number,
  gapMs: number,
  tailGroups: readonly number[] = [G4, A4],
): void {
  transport.arriveAt(d, 0)
  d.tap(C4, E4)
  transport.sync(d)
  d.wait(20).tap(wrong)
  d.wait(gapMs - 20)
  transport.sync(d)
  for (let i = 0; i < tailGroups.length; i++) {
    d.tap(tailGroups[i]!)
    transport.sync(d)
    if (i + 1 < tailGroups.length) {
      d.wait(gapMs)
      transport.sync(d)
    }
  }
  expect(d.records()).toHaveLength(1)
  expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([wrong])
  d.engine.restart(d.now, { continueRepeat: true })
  d.engine.markPrepared(d.now)
  d.flush()
  transport.reset(d)
  expect(d.state.phase).toBe('ready')
}

describe('retry when an extra key repeats (P26)', () => {
  it('holds the group when the same extra key repeats before the right keys, then completes on clean re-strike', () => {
    const d = scored()
    secondPassWithSlip(d, F4)

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      acceptedPitches: [],
    })

    // Still inside the retry window, the rest of the strike (P33): right keys are discarded.
    d.wait(CHORD_SLIP_MS - 1).tap(C4, E4)
    expect(d.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      acceptedPitches: [],
    })

    // Clean re-strike once that strike ended completes the group once the confirmation hold elapses.
    d.wait(STRIKE_GAP_MS).tap(C4, E4)
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    d.tap(G4).tap(A4)
    const r = d.records()[1]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
  })

  it('triggers the same retry when the repeated extra arrives just after the right keys (inside the hold)', () => {
    const d = scored()
    secondPassWithSlip(d, F4)

    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    expect(d.engine.nextDeadline()).toBe(d.now + CHORD_SLIP_MS)

    d.wait(20).tap(F4)
    expect(d.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      acceptedPitches: [],
    })

    // Advancing past the original hold does not complete the invalidated stroke.
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })

    d.wait(STRIKE_GAP_MS - CHORD_SLIP_MS)
      .tap(C4, E4)
      .wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })
    d.tap(G4).tap(A4)
    expect(d.records()[1]).toMatchObject({ completion: 'completed', wrongAttacks: 1 })
  })

  it('does not trigger retry for a different wrong key at a guarded group', () => {
    const d = scored()
    secondPassWithSlip(d, F4)

    d.tap(D4, C4, E4)
    expect(d.state.retryGroup).toBe(false)
    expect(d.state.groupIndex).toBe(0)

    d.wait(CHORD_SLIP_MS)
    expect(d.state.groupIndex).toBe(1)
    d.tap(G4).tap(A4)
    expect(d.records()[1]).toMatchObject({ completion: 'completed', wrongAttacks: 1 })
    expect(d.records()[1]!.groups![0]!.wrongPitches).toEqual([D4])
  })

  it('does not retry without continueRepeat', () => {
    const d = scored()
    secondPassWithSlip(d, F4, {})

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })
  })

  it('does not retry in strict transport', () => {
    const d = scored({ transport: 'strict', rhythm: { toleranceMs: 150 } })
    d.engine.startRunning(d.now)
    d.engine.transportArrived(0, d.now)
    d.tap(F4, C4, E4)
    d.engine.transportArrived(1, d.now + 1000)
    d.now += 1000
    d.tap(G4)
    d.engine.transportArrived(2, d.now + 1000)
    d.now += 1000
    d.tap(A4)
    expect(d.records()).toHaveLength(1)
    expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.engine.startRunning(d.now)
    d.engine.transportArrived(0, d.now)
    d.flush()

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })
  })

  it('caps the confirmation hold at half the gap to the next onset', () => {
    // Sixteenths at quarter = 240: 62.5 ms apart, so half the gap is 31.25 ms (< CHORD_SLIP_MS = 60).
    const fast = buildScore({
      notes: [
        { at: { n: 0, d: 16 }, midi: C4 },
        { at: { n: 0, d: 16 }, midi: E4 },
        { at: { n: 1, d: 16 }, midi: G4 },
        { at: { n: 2, d: 16 }, midi: A4 },
      ],
      tempo: { bpm: 240 },
      bars: 1,
    })
    const d = scored({}, fast)
    // Pass 1: F4 before the chord completes so group 0 records F4.
    d.tap(F4, C4, E4).tap(G4).tap(A4)
    expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.wait(300)
    expect(d.state.phase).toBe('ready')

    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    expect(d.engine.nextDeadline()).toBe(d.now + 31.25)

    d.wait(31)
    expect(d.state.groupIndex).toBe(0)
    d.wait(0.25)
    expect(d.state.groupIndex).toBe(1)
  })
})

describe('confirmation hold preserves the early-press grace', () => {
  it('accepts a next-group press made within 120 ms before the chord completes despite the 60 ms hold', () => {
    const d = scored()
    secondPassWithSlip(d, F4)
    d.take()

    const t0 = d.now
    d.down(C4)
    d.wait(10).down(G4) // t0 + 10, original deadline = t0 + 130
    d.wait(70).down(E4) // t0 + 80, opens hold until t0 + 140
    // nextDeadline must point to the confirmation hold end (t0 + 140), not the unextended grace deadline (t0 + 130).
    expect(d.engine.nextDeadline()).toBe(t0 + 80 + CHORD_SLIP_MS)

    // Tick at the original grace deadline (t0 + 130) must not expire G4.
    d.wait(50)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])

    // Tick at the end of the confirmation hold (t0 + 140) completes group 0 and accepts G4 into group 1.
    d.wait(10)
    const evs = d.take()
    expect(evs.filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0, pendingPitches: [] })

    // Move past the extended grace deadline and finish the pass.
    d.wait(100).tap(A4)
    expect(d.records()[1]).toMatchObject({ completion: 'completed', wrongAttacks: 0, passed: true })
  })

  it('handles the boundary where the original grace deadline equals confirmation.until', () => {
    const d = scored()
    secondPassWithSlip(d, F4)
    d.take()

    const t0 = d.now
    d.down(C4).down(G4) // t0, original deadline = t0 + 120
    d.wait(60).down(E4) // t0 + 60, confirmation.until = t0 + 120 === original deadline
    expect(d.engine.nextDeadline()).toBe(t0 + 120)

    d.wait(60) // tick at t0 + 120
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0, pendingPitches: [] })
  })

  it('still expires a next-group press whose 120 ms grace already elapsed before the chord completed', () => {
    const d = scored()
    secondPassWithSlip(d, F4)
    d.take()

    d.down(C4).down(G4)
    d.wait(120).down(E4) // at t0 + 120, G4 already expired as 'ahead'
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual([[0, G4, 'ahead']])
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], wrongAttacks: 1 })
  })

  it('accompaniment: sixteenths 100 ms apart keep the early-press grace after a held chord', () => {
    // Sixteenths at quarter = 150: 100 ms apart.
    const sixteenths = buildScore({
      notes: [
        { at: { n: 0, d: 16 }, midi: C4 },
        { at: { n: 0, d: 16 }, midi: E4 },
        { at: { n: 1, d: 16 }, midi: G4 },
        { at: { n: 2, d: 16 }, midi: A4 },
      ],
      tempo: { bpm: 150 },
      bars: 1,
    })

    // Unguarded baseline: C4 at 0, G4 at 2, E4 at 10 -> gate 1 at 110, G4 accepted, no wrong attack.
    const tUnguarded = new SessionTransport(100)
    const unguarded = scored({ transport: 'accompaniment', transportEta: tUnguarded.eta }, sixteenths)
    tUnguarded.arriveAt(unguarded, 0)
    unguarded.take()
    unguarded.down(C4)
    unguarded.wait(2).down(G4)
    unguarded.wait(8).down(E4)
    tUnguarded.sync(unguarded)
    unguarded.wait(100)
    tUnguarded.sync(unguarded)
    expect(unguarded.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(unguarded.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0 })

    // Guarded: same input sequence; hold is 50 ms (half of 100 ms gap), gate 1 arrives at 160.
    const transport = new SessionTransport(100)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta }, sixteenths)
    secondPassAccompaniment(d, transport, F4, 100)
    transport.arriveAt(d, 0)
    d.take()

    d.down(C4)
    d.wait(2).down(G4)
    d.wait(8).down(E4)
    transport.sync(d)
    d.wait(50) // hold ends at +60, releases gate 0 -> gate 1 due at +160
    transport.sync(d)
    d.wait(100) // gate 1 arrives at +160
    transport.sync(d)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0, pendingPitches: [] })
  })

  it('accompaniment: quarters 1000 ms apart credit the hold so a press 70 ms before the beat is accepted', () => {
    // Unguarded baseline: chord at 0, G4 at 930 (70 ms before gate 1 at 1000) -> accepted.
    const tUnguarded = new SessionTransport(1000)
    const unguarded = scored({ transport: 'accompaniment', transportEta: tUnguarded.eta })
    tUnguarded.arriveAt(unguarded, 0)
    unguarded.take()
    unguarded.tap(C4, E4)
    tUnguarded.sync(unguarded)
    unguarded.wait(930).tap(G4)
    expect(unguarded.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(unguarded.state).toMatchObject({ groupIndex: 1, inputComplete: true, wrongAttacks: 0 })

    // Guarded: chord at 0, hold ends at 60 -> gate 1 due at 1060; G4 at 930 must still be accepted.
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta })
    secondPassAccompaniment(d, transport, F4, 1000)
    transport.arriveAt(d, 0)
    d.take()

    d.tap(C4, E4)
    transport.sync(d)
    d.wait(CHORD_SLIP_MS) // hold ends at +60, gate 1 due at +1060
    transport.sync(d)
    d.wait(930 - CHORD_SLIP_MS).tap(G4) // t = +930 (130 ms before gate 1, within 120 + 60 credit)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 1, inputComplete: true, wrongAttacks: 0 })
  })

  it('accompaniment: a press too early even with the hold credit is still judged early', () => {
    // Unguarded baseline: G4 at 870 (130 ms before gate 1 at 1000) -> 'early'.
    const tUnguarded = new SessionTransport(1000)
    const unguarded = scored({ transport: 'accompaniment', transportEta: tUnguarded.eta })
    tUnguarded.arriveAt(unguarded, 0)
    unguarded.take()
    unguarded.tap(C4, E4)
    tUnguarded.sync(unguarded)
    unguarded.wait(870).tap(G4)
    const unguardedWrong = unguarded
      .take()
      .filter((e) => e.type === 'wrong')
      .map((e) => [e.group, e.pitch, e.reason])
    expect(unguardedWrong).toEqual([[1, G4, 'early']])

    // Guarded: hold ends at 60 -> gate 1 due at 1060; G4 at 870 is 190 ms before gate 1 (>= 180) -> 'early'.
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta })
    secondPassAccompaniment(d, transport, F4, 1000)
    transport.arriveAt(d, 0)
    d.take()

    d.tap(C4, E4)
    transport.sync(d)
    d.wait(CHORD_SLIP_MS)
    transport.sync(d)
    d.wait(870 - CHORD_SLIP_MS).tap(G4)
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual(unguardedWrong)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], wrongAttacks: 1 })
  })

  it('accompaniment: hold credit does not leak to the group two steps after the held one', () => {
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta })
    secondPassAccompaniment(d, transport, F4, 1000)
    transport.arriveAt(d, 0)
    d.take()

    // Group 0 held until +60 -> gate 1 at +1060.
    d.tap(C4, E4)
    transport.sync(d)
    d.wait(CHORD_SLIP_MS)
    transport.sync(d)
    // Group 1 played at gate 1 (+1060) -> gate 2 at +2060.
    d.wait(1000)
    transport.sync(d)
    d.tap(G4)
    transport.sync(d)
    expect(d.state.groupIndex).toBe(2)

    // Group 2: press A4 130 ms before gate 2 (+1930) -> ordinary 120 ms grace applies, so 'early'.
    d.wait(870).tap(A4)
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual([[2, A4, 'early']])
  })

  it('accompaniment: credits the hold even when the guarded group completes before its gate arrives (early release)', () => {
    const quartersScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
        { at: 3, midi: A4 },
      ],
      bars: 1,
    })

    // Unguarded baseline: C4 at 0 (gate 1 at 1000), E4 at 930 (fast-forwards -> gate 2 at 1930), G4 at 1860 -> accepted.
    const tU = new SessionTransport(1000)
    const u = scored({ transport: 'accompaniment', transportEta: tU.eta }, quartersScore)
    tU.arriveAt(u, 0)
    u.take()
    u.tap(C4)
    tU.sync(u)
    u.wait(930).tap(E4)
    tU.sync(u)
    u.wait(930).tap(G4)
    expect(u.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(u.state).toMatchObject({ groupIndex: 2, inputComplete: true, wrongAttacks: 0 })

    // Guarded group 1: pass 1 slips F4 on group 1.
    const t = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: t.eta }, quartersScore)
    t.arriveAt(d, 0)
    d.tap(C4)
    t.sync(d)
    d.wait(1000)
    t.sync(d)
    d.tap(E4)
    t.sync(d)
    d.wait(20).tap(F4)
    d.wait(980)
    t.sync(d)
    d.tap(G4)
    t.sync(d)
    d.wait(1000)
    t.sync(d)
    d.tap(A4)
    t.sync(d)
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    t.reset(d)
    t.arriveAt(d, 0)
    d.take()

    d.tap(C4) // t = 0 -> gate 1 due at 1000
    t.sync(d)
    d.wait(930).tap(E4) // t = 930 -> hold to 990 (before gate 1)
    t.sync(d)
    d.wait(60) // t = 990 -> hold ends, fast-forwards gate 1 -> gate 2 due at 1990
    t.sync(d)
    d.wait(870).tap(G4) // t = 1860 (ETA 130, within 120 + 60 credit)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, inputComplete: true, wrongAttacks: 0 })
  })

  it('accompaniment: credits the hold across two consecutive guarded groups when the second completes early', () => {
    const quartersScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
        { at: 3, midi: A4 },
      ],
      bars: 1,
    })

    // Unguarded baseline: C4 at 0, E4 at 999 (gate 2 at 1999), G4 at 1934 (ETA 65) -> accepted.
    const tU = new SessionTransport(1000)
    const u = scored({ transport: 'accompaniment', transportEta: tU.eta }, quartersScore)
    tU.arriveAt(u, 0)
    u.take()
    u.tap(C4)
    tU.sync(u)
    u.wait(999).tap(E4)
    tU.sync(u)
    u.wait(935).tap(G4)
    expect(u.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(u.state).toMatchObject({ groupIndex: 2, inputComplete: true, wrongAttacks: 0 })

    // Pass 1: wrong key F4 on both group 0 and group 1.
    const t = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: t.eta }, quartersScore)
    t.arriveAt(d, 0)
    d.tap(C4)
    t.sync(d)
    d.wait(20).tap(F4)
    d.wait(980)
    t.sync(d)
    d.tap(E4)
    t.sync(d)
    d.wait(20).tap(F4)
    d.wait(980)
    t.sync(d)
    d.tap(G4)
    t.sync(d)
    d.wait(1000)
    t.sync(d)
    d.tap(A4)
    t.sync(d)
    expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([F4])
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    t.reset(d)
    t.arriveAt(d, 0)
    d.take()

    d.tap(C4) // t = 0 -> hold to 60 -> gate 1 due at 1060
    t.sync(d)
    d.wait(60)
    t.sync(d)
    d.wait(939).tap(E4) // t = 999 -> hold to 1059 (1 ms before gate 1)
    t.sync(d)
    d.wait(60) // t = 1059 -> hold ends, fast-forwards gate 1 -> gate 2 due at 2059
    t.sync(d)
    d.wait(875).tap(G4) // t = 1934 (ETA 125, within 120 + 60 credit)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, inputComplete: true, wrongAttacks: 0 })
  })

  it('accompaniment: measures hold credit from when the hold opened, not a backdated pending attack', () => {
    // Sixteenths 100 ms apart: [C4, E4], [G4] (guarded), [A4], [D4].
    const sixteenths = buildScore({
      notes: [
        { at: { n: 0, d: 16 }, midi: C4 },
        { at: { n: 0, d: 16 }, midi: E4 },
        { at: { n: 1, d: 16 }, midi: G4 },
        { at: { n: 2, d: 16 }, midi: A4 },
        { at: { n: 3, d: 16 }, midi: D4 },
      ],
      tempo: { bpm: 150 },
      bars: 1,
    })

    // Unguarded baseline: C4 at 0, G4 at 2, E4 at 10 (gate 1 at 110), A4 at 15 -> at 110 G4 completes (gate 2 at 210), A4 is 'early'.
    const tU = new SessionTransport(100)
    const u = scored({ transport: 'accompaniment', transportEta: tU.eta }, sixteenths)
    tU.arriveAt(u, 0)
    u.take()
    u.down(C4)
    u.wait(2).down(G4)
    u.wait(8).down(E4)
    tU.sync(u)
    u.wait(5).down(A4)
    u.wait(95) // t = 110: gate 1 arrives, pending G4 completes group 1 -> gate 2 due at 210
    tU.sync(u)
    u.wait(100) // t = 210: gate 2 arrives
    tU.sync(u)
    const unguardedWrong = u
      .take()
      .filter((e) => e.type === 'wrong')
      .map((e) => [e.group, e.pitch, e.reason])
    expect(unguardedWrong).toEqual([[2, A4, 'early']])

    // Guarded group 1: pass 1 slips F4 on group 1.
    const t = new SessionTransport(100)
    const d = scored({ transport: 'accompaniment', transportEta: t.eta }, sixteenths)
    t.arriveAt(d, 0)
    d.tap(C4, E4)
    t.sync(d)
    d.wait(100)
    t.sync(d)
    d.tap(G4)
    t.sync(d)
    d.wait(20).tap(F4)
    d.wait(80)
    t.sync(d)
    d.tap(A4)
    t.sync(d)
    d.wait(100)
    t.sync(d)
    d.tap(D4)
    t.sync(d)
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    t.reset(d)
    t.arriveAt(d, 0)
    d.take()

    d.down(C4)
    d.wait(2).down(G4)
    d.wait(8).down(E4) // t = 10 -> gate 1 due at 110
    t.sync(d)
    d.wait(5).down(A4) // t = 15
    d.wait(95) // t = 110: gate 1 arrives, pending G4 opens hold with backdated attack 10 (until 60), resolves at once
    t.sync(d)
    d.wait(0) // resolve immediately-due hold at t = 110 -> delay is 0, gate 2 due at 210
    t.sync(d)
    d.wait(100) // t = 210: gate 2 arrives; A4 (195 ms early) must still be 'early'
    t.sync(d)
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual(unguardedWrong)
  })

  it('accompaniment: credits the hold when a non-first gate arrives before the tick that would resolve the hold', () => {
    const quartersScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
        { at: 3, midi: A4 },
      ],
      bars: 1,
    })

    // Pass 1: wrong key F4 on group 1.
    const t = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: t.eta }, quartersScore)
    t.arriveAt(d, 0)
    d.tap(C4)
    t.sync(d)
    d.wait(1000)
    t.sync(d)
    d.tap(E4)
    t.sync(d)
    d.wait(20).tap(F4)
    d.wait(980)
    t.sync(d)
    d.tap(G4)
    t.sync(d)
    d.wait(1000)
    t.sync(d)
    d.tap(A4)
    t.sync(d)
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    t.reset(d)
    const t0 = d.now
    t.arriveAt(d, 0)
    d.take()

    d.tap(C4) // t0 -> gate 1 due at t0 + 1000
    t.sync(d)
    d.wait(950).tap(E4) // t0 + 950 -> hold to t0 + 1010
    t.sync(d)

    // Deliver gate 1 arrival at t0 + 1015 BEFORE any tick at t0 + 1010.
    // transportArrived resolves the hold while #transportGate is still 0 (< 1), then advances to group 2.
    d.now = t0 + 1015
    d.engine.transportArrived(1, t0 + 1015)
    t.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0 })

    // Gate 2 is due at t0 + 2015; pressing G4 at t0 + 1885 (ETA 130, within 120 + 65 credit) must be accepted.
    d.wait(870).tap(G4)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, inputComplete: true, wrongAttacks: 0 })
  })

  it('transportArrived confirms a due hold before expiring pending presses', () => {
    // Accompaniment without ETA, group 0 guarded, gate 0 reached:
    // C4 at 0, G4 at 10, E4 at 125 (hold to 185, G4 deadline -> 190), then transportArrived(1, 191) before tick at 185.
    const d = scored({ transport: 'accompaniment' })
    d.engine.transportArrived(0, d.now)
    d.tap(C4, E4).wait(20).tap(F4)
    d.engine.transportArrived(1, d.now + 1000)
    d.now += 1000
    d.tap(G4)
    d.engine.transportArrived(2, d.now + 1000)
    d.now += 1000
    d.tap(A4)
    expect(d.records()).toHaveLength(1)

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    const t0 = d.now
    d.engine.transportArrived(0, t0)
    d.take()

    d.down(C4)
    d.now = t0 + 10
    d.down(G4)
    d.now = t0 + 125
    d.down(E4) // hold until t0 + 185, G4 deadline extended to t0 + 190

    // transportArrived(1, t0 + 191) arrives before any tick at t0 + 185.
    d.now = t0 + 191
    d.engine.transportArrived(1, t0 + 191)
    d.flush()
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0, pendingPitches: [] })
  })

  it('extends pending deadlines in place so #settlePending still visits a tie-end press behind the completing press', () => {
    // Group 0: [C4, D4] (D4 dur 2); group 1: [E4] at beat 1; group 2: [G4] at beat 2 with D4 tied in; group 3: [A4].
    const tiedScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: D4, dur: 2, voice: '2' },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
        { at: 2, midi: D4, dur: 1, voice: '2', cont: true },
        { at: 3, midi: A4 },
      ],
      bars: 1,
    })
    const d = scored({}, tiedScore)
    // Pass 1: wrong key F4 on group 2 (G4) so group 2 is guarded.
    d.tap(C4, D4).tap(E4).tap(G4).wait(20).tap(F4).tap(A4)
    expect(d.records()[0]!.groups![2]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()

    d.tap(C4, D4)
    expect(d.state.groupIndex).toBe(1)
    d.take()

    // With group 1 current: G4 at 0, D4 at 5, E4 at 10.
    d.down(G4)
    d.wait(5).down(D4)
    d.wait(5).down(E4)
    // Per E16, group 2 is still current during its hold, so the pending tied D4 is recorded as group 2's tie-end press.
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual([[2, D4, 'tie-end']])

    d.wait(CHORD_SLIP_MS).tap(A4)
    const r = d.records()[1]!
    expect(r.groups![2]!.tieEndPresses).toBe(1)
    expect(r.wrongAttacks).toBe(0)
  })

  it('a retry triggered during the hold drops a pending press whose deadline was extended', () => {
    const d = scored()
    secondPassWithSlip(d, F4)
    d.take()

    d.down(C4)
    d.wait(10).down(G4) // pending for group 1
    d.wait(70).down(E4) // opens hold and extends G4's deadline
    expect(d.state.pendingPitches).toEqual([G4])

    // Repeated extra F4 during the hold triggers retry and clears pending presses.
    d.wait(20).tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, pendingPitches: [] })

    // Re-strike cleanly after retry window: group 1 must NOT be auto-completed by the dropped G4.
    d.wait(STRIKE_GAP_MS).tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], pendingPitches: [] })
  })

  it('handles two consecutive guarded groups', () => {
    const d = scored()
    // Pass 1: wrong key F4 on group 0 and D4 on group 1.
    d.tap(C4, E4).wait(20).tap(F4).wait(100).tap(G4).wait(20).tap(D4).tap(A4)
    expect(d.records()[0]!.groups![0]!.wrongPitches).toEqual([F4])
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([D4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    d.take()

    // Pass 2: C4 at 0, G4 at 10 (pending for group 1), E4 at 80 (opens hold on group 0 until 140).
    d.down(C4)
    d.wait(10).down(G4)
    d.wait(70).down(E4)
    d.wait(CHORD_SLIP_MS) // group 0 completes -> G4 accepted into group 1 -> opens hold on group 1!
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [G4], wrongAttacks: 0 })

    // Group 1 is now in its own confirmation hold; pressing A4 early is buffered and accepted after group 1's hold.
    d.wait(10).down(A4)
    d.wait(CHORD_SLIP_MS)
    expect(d.records()[1]).toMatchObject({ completion: 'completed', wrongAttacks: 0, passed: true })
  })
})

describe('next-group pitch inside the retry window', () => {
  it('silently discards a next-group pitch pressed during the retry window without a second wrong attack', () => {
    const d = scored()
    secondPassWithSlip(d, F4)
    d.take()

    // Trigger retry with repeated extra F4.
    d.tap(C4, E4).wait(20).tap(F4)
    const retryStart = d.now
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true })
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual([[0, F4, 'pitch']])

    // Next group's pitch (G4) arrives inside the retry window: silently discarded, does not extend retryAfter.
    d.wait(30).tap(G4)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, wrongAttacks: 1, pendingPitches: [] })

    // At retryStart + STRIKE_GAP_MS (the rest of the strike, P33; not measured from G4, proving retryAfter
    // was not extended), a clean strike works.
    d.wait(STRIKE_GAP_MS - 30)
    expect(d.now).toBe(retryStart + STRIKE_GAP_MS)
    d.tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    d.tap(G4).tap(A4)
    const r = d.records()[1]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
  })

  it('silently discards a next-group tied pitch pressed during the retry window', () => {
    // Group 0: [C4, D4] with D4 held for 2 quarters; group 1: [E4] at beat 1;
    // group 2: [G4] at beat 2 with D4 tied in (cont: true), putting D4 in group 2's tiedPitches.
    const tiedScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: D4, dur: 2, voice: '2' },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
        { at: 2, midi: D4, dur: 1, voice: '2', cont: true },
      ],
      bars: 1,
    })
    const d = scored({}, tiedScore)
    // Pass 1: wrong key F4 on group 1 (E4).
    d.tap(C4, D4).tap(E4).wait(20).tap(F4).tap(G4)
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()
    expect(d.state.phase).toBe('ready')

    d.tap(C4, D4).wait(CHORD_SLIP_MS + 1)
    d.take()
    // Group 1 (E4) is guarded; trigger retry with F4.
    d.tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: true })
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => e.pitch),
    ).toEqual([F4])

    // D4 is in group 2's tiedPitches (not in group 1's pitches or tiedPitches).
    d.wait(20).tap(D4)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state.wrongAttacks).toBe(1)

    d.wait(CHORD_SLIP_MS - 20)
      .tap(E4)
      .wait(CHORD_SLIP_MS)
      .tap(G4)
    const r = d.records()[1]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1 })
    expect(r.groups![1]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
  })

  it('still records a tie-end press of the current group during the retry window even if the next group requires that pitch', () => {
    // Group 0: [C4, D4]; group 1: [E4] with D4 tied in; group 2: [D4] (re-struck); group 3: [A4].
    const tiedNextScore = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: D4, dur: 1, voice: '2' },
        { at: 1, midi: E4 },
        { at: 1, midi: D4, dur: 1, voice: '2', cont: true },
        { at: 2, midi: D4, dur: 1, voice: '2' },
        { at: 3, midi: A4 },
      ],
      bars: 1,
    })
    const d = scored({}, tiedNextScore)
    // Pass 1: wrong key F4 on group 1 (E4).
    d.tap(C4, D4).tap(E4).wait(20).tap(F4).tap(D4).tap(A4)
    expect(d.records()[0]!.groups![1]!.wrongPitches).toEqual([F4])

    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.flush()

    d.tap(C4, D4).wait(100)
    d.take()
    // Group 1 (E4) is guarded; trigger retry with F4.
    d.tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: true })
    d.take()

    // 20 ms later (inside retry window), D4 is tied into group 1 AND required by group 2 -> must record tie-end on group 1.
    d.wait(20).tap(D4)
    expect(
      d
        .take()
        .filter((e) => e.type === 'wrong')
        .map((e) => [e.group, e.pitch, e.reason]),
    ).toEqual([[1, D4, 'tie-end']])

    d.wait(CHORD_SLIP_MS - 20)
      .tap(E4)
      .wait(CHORD_SLIP_MS)
      .tap(D4)
      .tap(A4)
    const r = d.records()[1]!
    expect(r.groups![1]).toMatchObject({ tieEndPresses: 1, wrongAttacks: 1, wrongPitches: [F4] })
  })
})

describe('session-supplied wrong-key guard (setGuard, P38)', () => {
  it('holds and retries on a first pass with no continueRepeat', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)

    // Press the chord then the guarded extra key inside the confirmation hold.
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    expect(d.engine.nextDeadline()).toBe(d.now + CHORD_SLIP_MS)

    d.wait(20).tap(F4)
    expect(d.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      acceptedPitches: [],
    })

    // Still inside retry window: right keys are discarded.
    d.wait(CHORD_SLIP_MS - 1).tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })

    // Clean re-strike once that strike ended (P33) completes after the confirmation hold.
    d.wait(STRIKE_GAP_MS).tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    d.tap(G4).tap(A4)
    const r = d.records()[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
  })

  it('survives a manual restart and an abandoned pass followed by restart', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)

    // Manual restart before playing anything.
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.flush()
    expect(d.state.phase).toBe('ready')

    // Start a pass, hit the guarded key, then abandon with user-stop and restart.
    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })
    d.engine.interrupt('user-stop', d.now)
    d.flush()
    expect(d.state.phase).toBe('interrupted')

    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.wait(300)
    expect(d.state.phase).toBe('ready')

    // Guard is still active after the abandoned pass and manual restart.
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    d.wait(20).tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })
  })

  it('clears on reconfigure with a new timeline and restores when setGuard is called with the new timeline', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)

    // Reconfigure without a new timeline keeps the guard.
    d.engine.reconfigure({ reason: 'setting-change' }, d.now)
    d.engine.markPrepared(d.now)
    d.flush()
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    d.wait(CHORD_SLIP_MS)
    expect(d.state.groupIndex).toBe(1)

    // Reconfigure with a new timeline (e.g. slower speed multiplier) drops the guard.
    const slower = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 0.75 })
    d.engine.reconfigure({ reason: 'tempo-change', timeline: slower }, d.now)
    d.engine.markPrepared(d.now)
    d.flush()
    expect(d.state.phase).toBe('ready')

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // Restoring the guard with the new timeline activates it again.
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.wait(300)
    expect(d.state.phase).toBe('ready')
    d.engine.setGuard(new Map([[0, new Set([F4])]]), slower)

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })
  })

  it('ignores setGuard when the timeline is not the engine current timeline object, and has no effect in reading mode', () => {
    const d = scored()
    const other = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    d.engine.setGuard(new Map([[0, new Set([F4])]]), other)

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // In reading mode the guard has no effect (though it is stored for a later scored switch).
    const readingTimeline = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const r = new EngineDriver(readingTimeline, { mode: 'reading', pieceId: 'p', transport: 'free' })
    r.engine.setGuard(new Map([[0, new Set([F4])]]), readingTimeline)
    r.tap(F4, C4, E4)
    expect(r.state).toMatchObject({ groupIndex: 1, retryGroup: false })
  })

  it('applies setGuard clears and updates made in reading mode when switching back to scored on the same timeline', () => {
    // Direction 1: scored -> setGuard -> reading -> setGuard(null) -> scored: guard is cleared.
    const d = scored()
    const tl = d.engine.timeline
    d.engine.setGuard(new Map([[0, new Set([F4])]]), tl)
    d.engine.reconfigure({ reason: 'mode-change', mode: 'reading' }, d.now)
    d.engine.setGuard(null, tl)
    d.engine.reconfigure({ reason: 'mode-change', mode: 'scored' }, d.now)
    d.engine.markPrepared(d.now)
    d.flush()
    expect(d.state.phase).toBe('ready')

    d.tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // Direction 2: reading -> setGuard -> scored on the same timeline: guard is in force.
    const tl2 = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 0 }, multiplier: 1 })
    const r = new EngineDriver(tl2, { mode: 'reading', pieceId: 'p', transport: 'free' })
    r.engine.setGuard(new Map([[0, new Set([F4])]]), tl2)
    r.engine.reconfigure({ reason: 'mode-change', mode: 'scored' }, r.now)
    r.engine.markPrepared(r.now)
    r.flush()
    expect(r.state.phase).toBe('ready')

    r.tap(C4, E4)
    expect(r.state.groupIndex).toBe(0)
    r.wait(20).tap(F4)
    expect(r.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })
  })

  it('treats an empty set for a group as not guarded (no hold)', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set()]]), d.engine.timeline)

    d.tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })
  })

  it('resolves an already-open confirmation hold on schedule when the guard is cleared mid-hold', () => {
    const d = scored()
    const tl = d.engine.timeline
    d.engine.setGuard(new Map([[0, new Set([F4])]]), tl)

    // Open confirmation hold on group 0.
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    const holdUntil = d.now + CHORD_SLIP_MS
    expect(d.engine.nextDeadline()).toBe(holdUntil)

    // Clear guard while the hold is open: F4 is now an ordinary wrong key (no retry), and the hold finishes on schedule.
    d.engine.setGuard(null, tl)
    d.wait(20).tap(F4)
    expect(d.state).toMatchObject({
      groupIndex: 0,
      retryGroup: false,
      acceptedPitches: [C4, E4],
      wrongAttacks: 1,
    })

    d.wait(CHORD_SLIP_MS - 20)
    expect(d.now).toBe(holdUntil)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, wrongAttacks: 1 })
  })

  it('holds and retries on a first pass in accompaniment transport', () => {
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta })
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    transport.arriveAt(d, 0)
    d.take()

    // Chord + guarded extra key inside the hold triggers retry.
    d.tap(C4, E4)
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 0, inputComplete: false })

    d.wait(20).tap(F4)
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })

    // Clean re-strike after the retry window completes group 0 once the hold elapses.
    d.wait(STRIKE_GAP_MS).tap(C4, E4)
    transport.sync(d)
    expect(d.state.groupIndex).toBe(0)

    d.wait(CHORD_SLIP_MS)
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // Finish the pass cleanly.
    d.wait(1000)
    transport.sync(d)
    d.tap(G4)
    transport.sync(d)
    d.wait(1000)
    transport.sync(d)
    d.tap(A4)
    transport.sync(d)
    const r = d.records()[0]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4] })
  })

  it('has no effect in strict transport and clears when passed null', () => {
    const strict = scored({ transport: 'strict', rhythm: { toleranceMs: 150 } })
    strict.engine.setGuard(new Map([[0, new Set([F4])]]), strict.engine.timeline)
    strict.engine.startRunning(strict.now)
    strict.engine.transportArrived(0, strict.now)
    strict.flush()

    strict.tap(F4, C4, E4)
    expect(strict.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // Passing null clears an active guard.
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    d.engine.setGuard(null, d.engine.timeline)

    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })
  })

  it('treats a group guarded by both continueRepeat and setGuard as one guard with no double hold', () => {
    const d = scored()
    // Pass 1 slips F4 on group 0 -> continueRepeat sets #previousWrongKeys for group 0 = {F4}.
    secondPassWithSlip(d, F4)
    // Also guard group 0 via setGuard with D4 (and F4).
    d.engine.setGuard(new Map([[0, new Set([F4, D4])]]), d.engine.timeline)

    // Clean chord completes after exactly one CHORD_SLIP_MS hold (no double hold).
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(0)
    expect(d.engine.nextDeadline()).toBe(d.now + CHORD_SLIP_MS)
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false })

    // With both sources active (continueRepeat has F4, setGuard has D4), either pitch triggers retry.
    const d2 = scored()
    secondPassWithSlip(d2, F4)
    d2.engine.setGuard(new Map([[0, new Set([D4])]]), d2.engine.timeline)
    d2.tap(C4, E4).wait(20).tap(D4)
    expect(d2.state).toMatchObject({ groupIndex: 0, retryGroup: true, acceptedPitches: [] })
  })
})

describe('once more when a guarded wrong key is pressed alone', () => {
  const Fs4 = 66
  const singleNoteScore = buildScore({
    notes: [
      { at: 0, midi: Fs4 },
      { at: 1, midi: G4 },
      { at: 2, midi: A4 },
    ],
    bars: 1,
  })

  it('single note: lone guarded F then F# takes back the first stroke (onceMore: true), second F# completes after hold', () => {
    const d = scored({}, singleNoteScore)
    // Pass 1: F4 pressed alone before F#4.
    d.tap(F4).wait(200).tap(Fs4).tap(G4).tap(A4)
    expect(d.records()[0]!.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4], extraPitches: [] })

    // Pass 2 via continueRepeat.
    d.engine.restart(d.now, { continueRepeat: true })
    d.engine.markPrepared(d.now)
    d.wait(300)
    expect(d.state.phase).toBe('ready')
    d.take()

    // Guarded F4 pressed alone.
    d.tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })

    // First clean F#4 (well past CHORD_SLIP_MS): taken back, does not complete or open a hold.
    d.wait(150).tap(Fs4)
    const firstEvs = d.take()
    expect(firstEvs.some((e) => e.type === 'accepted')).toBe(true)
    expect(firstEvs.some((e) => e.type === 'input-complete' || e.type === 'advanced')).toBe(false)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [] })
    // No confirmation hold deadline; only the auto-hint expiry remains.
    expect(d.engine.nextDeadline()).toBe(d.state.hint!.expiresAt)

    // Waiting past CHORD_SLIP_MS does not advance.
    d.wait(CHORD_SLIP_MS + 20)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true })

    // Second clean F#4: opens the confirmation hold, completes after CHORD_SLIP_MS.
    const secondAt = d.now
    d.tap(Fs4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [Fs4] })
    expect(d.engine.nextDeadline()).toBe(secondAt + CHORD_SLIP_MS)

    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    d.tap(G4).tap(A4)
    const r = d.records()[1]!
    expect(r).toMatchObject({ completion: 'completed', wrongAttacks: 1, passed: false })
    expect(r.groups![0]).toMatchObject({ wrongAttacks: 1, wrongPitches: [F4], extraPitches: [] })
  })

  it('guarded wrong key pressed together with a chord completes in one clean re-strike and onceMore is never true', () => {
    const d = scored()
    secondPassWithSlip(d, F4)

    // F4 together with C4, E4 (same timestamp -> together).
    d.tap(F4, C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false })

    // One clean re-strike after retry window completes after hold; onceMore never becomes true.
    d.wait(STRIKE_GAP_MS).tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [C4, E4] })
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('a guarded key in the same strike as the right keys, 100 ms apart (P33), asks for one clean strike, not two', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    d.tap(F4).wait(100).tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })
    d.wait(STRIKE_GAP_MS).tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('chord with a lone guarded wrong key: partial stroke stays in retry, full first stroke triggers onceMore, second completes', () => {
    const d = scored()
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)

    // Guarded F4 pressed alone via setGuard on pass 1.
    d.tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false })

    // Partial clean stroke (C4 only), a strike of its own (P33): accepted, onceMore stays false.
    d.wait(STRIKE_GAP_MS + 50).tap(C4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [C4] })

    // Completing the first clean stroke (E4): taken back, onceMore becomes true.
    d.wait(20).tap(E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [] })

    // Second clean chord completes after confirmation hold.
    d.wait(100).tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [C4, E4] })
    d.wait(CHORD_SLIP_MS)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('wrong key during the once-more stage: alone requires two clean strokes again; together requires only one', () => {
    // Subcase A: wrong key pressed ALONE during onceMore -> two clean strokes needed again.
    const alone = scored()
    alone.engine.setGuard(new Map([[0, new Set([F4])]]), alone.engine.timeline)
    alone
      .tap(F4)
      .wait(STRIKE_GAP_MS + 50)
      .tap(C4, E4)
    expect(alone.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true })

    // Press D4 alone during onceMore.
    alone.wait(STRIKE_GAP_MS + 50).tap(D4)
    expect(alone.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })

    // First clean stroke after D4 is taken back again.
    alone.wait(STRIKE_GAP_MS + 50).tap(C4, E4)
    expect(alone.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [] })

    // Second clean stroke completes after hold.
    alone.wait(100).tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(alone.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    // Subcase B: wrong key pressed TOGETHER with a right key during onceMore -> one clean stroke suffices.
    const together = scored()
    together.engine.setGuard(new Map([[0, new Set([F4])]]), together.engine.timeline)
    together
      .tap(F4)
      .wait(STRIKE_GAP_MS + 50)
      .tap(C4, E4)
    expect(together.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true })

    // Press C4 then D4 20 ms later (together) during onceMore.
    together.wait(150).tap(C4).wait(20).tap(D4)
    expect(together.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })

    // One clean stroke after the retry window completes after hold.
    together.wait(STRIKE_GAP_MS).tap(C4, E4)
    expect(together.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      onceMore: false,
      acceptedPitches: [C4, E4],
    })
    together.wait(CHORD_SLIP_MS)
    expect(together.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('accompaniment: releases the gate only at final completion and credits the hold to the next group', () => {
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta }, singleNoteScore)
    d.engine.setGuard(new Map([[0, new Set([F4])]]), d.engine.timeline)
    transport.arriveAt(d, 0)
    d.take()

    // Lone guarded F4 -> retry.
    d.tap(F4)
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, inputComplete: false })

    // First clean F#4 -> taken back; gate 0 must NOT be released yet.
    d.wait(150).tap(Fs4)
    transport.sync(d)
    expect(d.take().some((e) => e.type === 'input-complete')).toBe(false)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, inputComplete: false })

    // Second clean F#4 -> opens hold, releases gate 0 only after CHORD_SLIP_MS.
    d.wait(150).tap(Fs4)
    transport.sync(d)
    expect(d.take().some((e) => e.type === 'input-complete')).toBe(false)
    expect(d.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, inputComplete: false })

    d.wait(CHORD_SLIP_MS) // hold ends at +60 -> gate 0 released, gate 1 due at +1060
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    // Press G4 at +930 (130 ms before gate 1 at +1060): accepted via 60 ms hold credit!
    d.wait(930 - CHORD_SLIP_MS).tap(G4)
    expect(d.take().filter((e) => e.type === 'wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 1, inputComplete: true, wrongAttacks: 1 })
  })

  it('unguarded group and strict transport are unchanged (onceMore stays false)', () => {
    const unguarded = scored({}, singleNoteScore)
    unguarded.tap(F4).wait(150).tap(Fs4)
    expect(unguarded.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    const strict = scored({ transport: 'strict', rhythm: { toleranceMs: 150 } }, singleNoteScore)
    strict.engine.setGuard(new Map([[0, new Set([F4])]]), strict.engine.timeline)
    strict.engine.startRunning(strict.now)
    strict.engine.transportArrived(0, strict.now)
    strict.flush()
    strict.tap(F4).wait(100).tap(Fs4)
    expect(strict.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('accompaniment: a guarded key brushed together with a too-early stroke counts as together (not alone)', () => {
    const score = buildScore({
      notes: [
        { at: 0, midi: A4 },
        { at: 1, midi: C4 },
        { at: 1, midi: E4 },
        { at: 2, midi: G4 },
      ],
      bars: 1,
    })
    const transport = new SessionTransport(1000)
    const d = scored({ transport: 'accompaniment', transportEta: transport.eta }, score)
    d.engine.setGuard(new Map([[1, new Set([F4])]]), d.engine.timeline)
    transport.arriveAt(d, 0)
    d.tap(A4)
    transport.sync(d)
    expect(d.state.groupIndex).toBe(1)

    // Gate 1 due at +1000; C4 and E4 at +700 are both 'early', F4 at +705 is brushed with them.
    d.wait(700).tap(C4, E4)
    d.wait(5).tap(F4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: true, onceMore: false })

    // Arrive at gate 1 (+1000): one clean chord completes after confirmation hold (onceMore never true).
    d.wait(295)
    transport.sync(d)
    d.tap(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 1, retryGroup: true, onceMore: false, acceptedPitches: [C4, E4] })
    d.wait(CHORD_SLIP_MS)
    transport.sync(d)
    expect(d.state).toMatchObject({ groupIndex: 2, retryGroup: false, onceMore: false })

    d.wait(1000)
    transport.sync(d)
    d.tap(G4)
    transport.sync(d)
    expect(d.records()[0]!.groups![1]).toMatchObject({
      earlyAttacks: 2,
      wrongPitches: [F4],
      extraPitches: [F4],
    })
  })

  it('boundary around CHORD_SLIP_MS (59, 60, 61 ms) after a guarded key', () => {
    // 59 ms: inside retry window (discarded) AND within CHORD_SLIP_MS -> together; next clean stroke completes in one.
    const at59 = scored({}, singleNoteScore)
    at59.engine.setGuard(new Map([[0, new Set([F4])]]), at59.engine.timeline)
    at59.tap(F4).wait(59).tap(Fs4)
    expect(at59.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })
    at59.wait(1).tap(Fs4)
    expect(at59.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [Fs4] })
    at59.wait(CHORD_SLIP_MS)
    expect(at59.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    // 60 ms: retry window over AND within CHORD_SLIP_MS -> together; this stroke completes in one.
    const at60 = scored({}, singleNoteScore)
    at60.engine.setGuard(new Map([[0, new Set([F4])]]), at60.engine.timeline)
    at60.tap(F4).wait(60).tap(Fs4)
    expect(at60.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [Fs4] })
    at60.wait(CHORD_SLIP_MS)
    expect(at60.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    // 61 ms: past CHORD_SLIP_MS -> lone; first stroke taken back (onceMore: true), second completes.
    const at61 = scored({}, singleNoteScore)
    at61.engine.setGuard(new Map([[0, new Set([F4])]]), at61.engine.timeline)
    at61.tap(F4).wait(61).tap(Fs4)
    expect(at61.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [] })
    at61.wait(100).tap(Fs4).wait(CHORD_SLIP_MS)
    expect(at61.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })

  it('an expired ahead press of a guarded key triggers retry (two strokes if alone, one if together)', () => {
    // Alone: G4 (next group) guarded on group 0, pressed alone and expires as 'ahead' -> needs two clean strokes.
    const alone = scored()
    alone.engine.setGuard(new Map([[0, new Set([G4])]]), alone.engine.timeline)
    alone.tap(G4).wait(120)
    expect(alone.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[0, G4, 'ahead']])
    expect(alone.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false })

    alone.wait(100).tap(C4, E4)
    expect(alone.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: true, acceptedPitches: [] })
    alone.wait(100).tap(C4, E4).wait(CHORD_SLIP_MS)
    expect(alone.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })

    // Together: C4 pressed, then guarded G4 20 ms later, then expires as 'ahead' -> one clean stroke suffices.
    const together = scored()
    together.engine.setGuard(new Map([[0, new Set([G4])]]), together.engine.timeline)
    together.tap(C4).wait(20).tap(G4).wait(120)
    expect(together.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[0, G4, 'ahead']])
    expect(together.state).toMatchObject({ groupIndex: 0, retryGroup: true, onceMore: false, acceptedPitches: [] })

    together.wait(100).tap(C4, E4)
    expect(together.state).toMatchObject({
      groupIndex: 0,
      retryGroup: true,
      onceMore: false,
      acceptedPitches: [C4, E4],
    })
    together.wait(CHORD_SLIP_MS)
    expect(together.state).toMatchObject({ groupIndex: 1, retryGroup: false, onceMore: false })
  })
})
