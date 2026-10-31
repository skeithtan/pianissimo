/**
 * Accompaniment waiting and timing (engine side of the engine ↔ transport seam).
 *
 * The fake transport implements the agreed protocol on a real-time clock: when musical time
 * reaches gate i it calls onGateReached(i) and holds there unless gate i was released;
 * releaseGate(i) resumes from the held position (re-anchored to now, no burst), or, before
 * arrival, fast-forwards so the gate is reached now (synchronously reported). It also answers
 * the engine's `transportEta` query.
 */
import { describe, expect, it } from 'vitest'
import { type Rational, toNumber } from '../music/rational'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline, transportGates } from './timeline'

const C3 = 48
const E3 = 52
const G3 = 55
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65

class TimedTransport {
  readonly #pos: readonly number[]
  readonly #msPerWhole: number
  readonly #onGate: (i: number, at: number) => void
  readonly #released = new Set<number>()
  #anchorAt: number
  #anchorPos = 0
  #next = 0
  holding: number | null = null

  constructor(
    gates: readonly Rational[],
    msPerWhole: number,
    startAt: number,
    onGate: (i: number, at: number) => void,
  ) {
    this.#pos = gates.map(toNumber)
    this.#msPerWhole = msPerWhole
    this.#anchorAt = startAt
    this.#onGate = onGate
  }

  #arrival(i: number): number {
    return this.#anchorAt + (this.#pos[i]! - this.#anchorPos) * this.#msPerWhole
  }

  eta(group: number, at: number): number | null {
    if (group < this.#next) return 0
    if (this.holding !== null) return null
    for (let j = this.#next; j < group; j++) if (!this.#released.has(j)) return null
    return Math.max(0, this.#arrival(group) - at)
  }

  advance(now: number): void {
    while (this.holding === null && this.#next < this.#pos.length) {
      const at = this.#arrival(this.#next)
      if (at > now) return
      const i = this.#next++
      this.#onGate(i, at)
      if (!this.#released.has(i)) {
        this.holding = i
        this.#anchorAt = at
        this.#anchorPos = this.#pos[i]!
      }
    }
  }

  releaseGate(i: number, now: number): void {
    this.#released.add(i)
    if (this.holding === i) {
      this.holding = null
      this.#anchorAt = now
      this.#anchorPos = this.#pos[i]!
      return
    }
    if (this.holding !== null || i < this.#next) return
    for (let j = this.#next; j < i; j++) if (!this.#released.has(j)) return
    if (this.#arrival(i) <= now) return
    // Early release: fast-forward so gate i is now.
    this.#anchorAt = now
    this.#anchorPos = this.#pos[i]!
    this.advance(now)
  }

  seek(position: Rational, now: number): void {
    const p = toNumber(position)
    this.#released.clear()
    this.holding = null
    const next = this.#pos.findIndex((x) => x >= p)
    this.#next = next < 0 ? this.#pos.length : next
    this.#anchorAt = now
    this.#anchorPos = p
  }
}

// Right hand learns; the left hand (automatic) has an introduction and plays between onsets.
// Quarter = 60: gates at 2000, 3000, 4000, 5000 ms after the start when nothing holds.
const model = buildScore({
  notes: [
    { at: 0, midi: C3, hand: 'L' },
    { at: 1, midi: E3, hand: 'L' },
    { at: 2, midi: C4 },
    { at: 2, midi: G3, hand: 'L' },
    { at: 3, midi: D4 },
    { at: 3.5, midi: E3, hand: 'L', dur: 0.5 },
    { at: 4, midi: E4 },
    { at: 4, midi: C4 },
    { at: 5, midi: F4 },
  ],
})
const START = 1000

function session(): { d: EngineDriver; transport: TimedTransport; at: (t: number) => void } {
  const t = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
  let releaseAt: number | null = null
  const holder: { d?: EngineDriver } = {}
  const transport = new TimedTransport(transportGates(t), 4000, START, (i, at) => {
    releaseAt = at
    holder.d!.engine.transportArrived(i, at)
    holder.d!.flush()
    releaseAt = null
  })
  const d = new EngineDriver(
    t,
    { mode: 'scored', pieceId: 'p', prepared: true, transportEta: (g, at) => transport.eta(g, at) },
    START,
  )
  holder.d = d
  expect(d.engine.transport).toBe('accompaniment')
  // Session wiring: onGateReached(i) → engine.transportArrived(i); input-complete → releaseGate(i).
  const drain = d.flush.bind(d)
  d.flush = () => {
    const evs = drain()
    for (const e of evs) if (e.type === 'input-complete') transport.releaseGate(e.group, releaseAt ?? d.now)
    return evs
  }
  const at = (time: number): void => {
    d.now = time
    transport.advance(time)
    d.engine.tick(time)
    d.flush()
  }
  return { d, transport, at }
}

describe('Acceptance: Accompaniment waiting', () => {
  it('the transport waits at an incomplete learner group and resumes on completion without a burst', () => {
    const { d, transport, at } = session()
    at(5000)
    expect(transport.holding).toBe(0)
    expect(d.state.transportGate).toBe(0)
    d.tap(C4)
    expect(transport.holding).toBeNull()
    expect(d.state.groupIndex).toBe(1)
    expect(transport.eta(1, 5000)).toBe(1000)
    at(5999)
    expect(transport.holding).toBeNull()
    at(7000)
    expect(transport.holding).toBe(1)
  })

  it('a correct attack within the grace before its gate is accepted and fast-forwards the transport', () => {
    const { d, transport, at } = session()
    at(2900)
    d.tap(C4)
    expect(d.of('input-complete').map((e) => e.group)).toEqual([0])
    expect(d.of('waiting-for-transport')).toEqual([{ type: 'waiting-for-transport', group: 0 }])
    // The release moved the transport to the gate at once; the engine passed the group.
    expect(d.state).toMatchObject({ groupIndex: 1, transportGate: 0, waitingForTransport: false })
    expect(transport.eta(1, 2900)).toBe(1000)
    at(3000)
    expect(transport.holding).toBeNull()
    at(3900)
    expect(transport.holding).toBe(1)
  })

  it('a correct pitch earlier than the grace is "too early" and does not move the transport', () => {
    const { d, transport, at } = session()
    at(2500)
    d.tap(C4)
    expect(d.of('wrong').map((w) => w.reason)).toEqual(['early'])
    expect(d.state.acceptedPitches).toEqual([])
    at(3000)
    expect(transport.holding).toBe(0)
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
  })

  it('attacks for later groups beyond the grace are never accepted or buffered', () => {
    const { d, at } = session()
    at(2950)
    d.tap(C4).tap(D4)
    at(3000)
    expect(d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[1, D4, 'early']])
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
    at(3900)
    d.tap(D4)
    expect(d.state.groupIndex).toBe(2)
  })

  it('input completes exactly once per group even with the gate reached first', () => {
    const { d, at } = session()
    at(3500)
    d.tap(C4)
    at(4600)
    d.tap(D4, D4)
    expect(d.of('input-complete').map((e) => e.group)).toEqual([0, 1])
    expect(d.of('advanced').map((e) => e.from)).toEqual([0, 1])
  })

  it('free (both-hands) mode ignores transport arrivals and advances immediately', () => {
    const t = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transportEta: () => 10_000 })
    expect(d.engine.transport).toBe('free')
    d.engine.transportArrived(5, d.now)
    expect(d.state.transportGate).toBe(-1)
    d.tap(C3)
    expect(d.state.groupIndex).toBe(1)
  })
})

describe('Acceptance: Accompaniment timing', () => {
  it('an automatic introduction before the first press does not start the clock', () => {
    const { d, at } = session()
    expect(d.state.phase).toBe('ready')
    at(2900)
    expect(d.state.clockStartedAt).toBeNull()
    expect(d.state.phase).toBe('ready')
  })

  it('an early first press during the introduction starts the clock and is graded against the first group', () => {
    const { d, at } = session()
    at(1100)
    d.down(E4)
    expect(d.state.clockStartedAt).toBe(1100)
    at(1200)
    d.down(C4)
    expect(d.of('wrong').map((w) => [w.group, w.reason])).toEqual([
      [0, 'pitch'],
      [0, 'early'],
    ])
  })

  it('an early final attack within the grace ends the measured time and completes at once', () => {
    const { d, at } = session()
    at(3000)
    d.tap(C4)
    at(4000)
    d.tap(D4)
    at(5000)
    d.tap(C4, E4)
    at(5950)
    d.down(F4)
    expect(d.state.phase).toBe('completed')
    const r = d.records()[0]!
    expect(r.completionTimeSec).toBeCloseTo(2.95)
    expect(r.onsets.map((o) => o.t)).toEqual([0, 1, 2, 2.95])
    expect(r.context.transport).toBe('accompaniment')
    expect(r.wrongAttacks).toBe(0)
  })

  it('interrupting before the final group completes is not a completion', () => {
    const { d, at } = session()
    at(3000)
    d.tap(C4)
    at(4000)
    d.tap(D4)
    at(5000)
    d.tap(C4, E4)
    at(6000)
    d.engine.interrupt('user-stop', d.now)
    expect(d.records()[0]).toMatchObject({ completion: 'abandoned', passed: false })
  })
})

describe('Seek and restart against the transport', () => {
  it('restart resets gates: arrivals from the new pass are required again', () => {
    const { d, transport, at } = session()
    at(3000)
    d.tap(C4)
    d.engine.restart(d.now)
    expect(d.state.transportGate).toBe(-1)
    transport.seek(d.engine.timeline.start, d.now)
    d.engine.markPrepared(d.now)
    at(d.now + 1990)
    d.tap(C4)
    expect(d.state).toMatchObject({ groupIndex: 1, transportGate: 0 })
  })

  it('reading seek: gates before the new position count as passed', () => {
    const t = buildTimeline(model, { hands: 'right', range: null, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    d.engine.seek(2, d.now)
    expect(d.state.transportGate).toBe(1)
    d.tap(C4, E4)
    expect(d.state.waitingForTransport).toBe(true)
    d.engine.transportArrived(2, d.now)
    expect(d.state.groupIndex).toBe(3)
  })
})

describe('Per-group outcomes in the attempt record', () => {
  const A3 = 57

  it('a completed scored attempt reports wrong and early attacks and lateness after each gate', () => {
    const { d, at } = session()
    at(3300)
    d.tap(C4) // 300 ms after gate 0 (3000), but its press starts the attempt: never late
    at(4300)
    d.tap(A3)
    d.now = 4350
    d.tap(D4) // 50 ms late, after one wrong attack
    at(5300)
    d.tap(C4, E4) // within the grace before gate 2 (5350): fast-forward, not late
    at(6000)
    d.tap(F4) // too early for gate 3 (6300)
    at(6400)
    d.tap(F4)
    expect(d.state.phase).toBe('completed')
    const [r] = d.records()
    const rest = { spreadMs: 0, tieEndPresses: 0, pedal: 'none' }
    expect(r!.groups).toEqual([
      { group: 0, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, wrongPitches: [], ...rest },
      { group: 1, wrongAttacks: 1, earlyAttacks: 0, lateMs: 50, wrongPitches: [A3], ...rest },
      { group: 2, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0, wrongPitches: [], ...rest },
      // The too-early F4 had the right pitch: not a wrong pitch.
      { group: 3, wrongAttacks: 1, earlyAttacks: 1, lateMs: 100, wrongPitches: [], ...rest },
    ])
    expect(r).toMatchObject({ wrongAttacks: 2, earlyAttacks: 1 })
  })

  it('a running start (lead-in into the loop) measures the first group like any other', () => {
    const { d, at } = session()
    // The transport is already running toward gate 0 (3000) when the attempt begins.
    d.engine.restart(START, { runningStart: true })
    d.engine.markPrepared(START)
    at(3300)
    d.tap(C4)
    at(4100)
    d.engine.interrupt('user-stop', d.now)
    expect(d.records().at(-1)!.groups![0]).toMatchObject({ group: 0, lateMs: 300 })
    // The next attempt starts at the loop again: the transport waits, the first group is never late.
    d.engine.restart(d.now)
    d.engine.markPrepared(d.now)
    d.engine.transportArrived(0, d.now)
    at(d.now + 400)
    d.tap(C4)
    d.engine.interrupt('user-stop', d.now)
    expect(d.records().at(-1)!.groups![0]).toMatchObject({ group: 0, lateMs: 0 })
  })

  it('a chord spread is the time between its first and last accepted attack', () => {
    const t = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    d.tap(C4)
    d.now += 500
    d.tap(D4)
    d.now += 500
    d.tap(E4)
    d.now += 37.4
    d.tap(E4) // a replay does not stretch the spread
    d.tap(C4)
    d.now += 500
    d.tap(G3, F4) // a wrong key in a one-note group; its spread stays 0
    const groups = d.records()[0]!.groups!
    expect(groups.map((g) => g.spreadMs)).toEqual([0, 0, 37, 0])
    expect(groups[3]!.wrongPitches).toEqual([G3])
  })

  it('an abandoned attempt reports the groups reached, the current one included', () => {
    const { d, at } = session()
    at(3000)
    d.tap(C4)
    at(4100)
    d.tap(A3)
    d.engine.interrupt('user-stop', d.now)
    expect(d.records()[0]).toMatchObject({
      completion: 'abandoned',
      groups: [
        { group: 0, wrongAttacks: 0, earlyAttacks: 0, lateMs: 0 },
        { group: 1, wrongAttacks: 1, earlyAttacks: 0, lateMs: 0 },
      ],
    })
  })

  it('without a transport (free mode) nothing is late; reading traversals carry no groups', () => {
    const t = buildTimeline(model, { hands: 'both', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true })
    for (const g of t.groups) {
      d.now += 500
      d.tap(...g.pitches)
    }
    const [r] = d.records()
    expect(r!.completion).toBe('completed')
    expect(r!.groups).toHaveLength(t.groups.length)
    expect(r!.groups!.every((g) => g.lateMs === 0 && g.wrongAttacks === 0)).toBe(true)

    const reading = new EngineDriver(t, { mode: 'reading', pieceId: 'p' })
    reading.tap(...t.groups[0]!.pitches)
    reading.engine.interrupt('user-stop', reading.now)
    expect(reading.records()[0]!.groups).toBeUndefined()
  })
})
