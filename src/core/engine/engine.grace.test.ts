/**
 * Early-press grace (user decision, EARLY_PRESS_GRACE_MS = 120 real ms): the accompaniment
 * gate window for the current group and the next-group pending window in both modes.
 * Gate ETAs come from an injected pure table, so every case is deterministic.
 */
import { describe, expect, it } from 'vitest'
import { EARLY_PRESS_GRACE_MS } from './engine'
import type { EngineConfig } from './types'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'
import type { LearnerHands } from './timeline'

const C3 = 48
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69

// Groups: 0 = [C4, E4], 1 = [G4], 2 = [D4], 3 = [F4]. An 8va span covers group 0.
const model = buildScore({
  notes: [
    { at: 0, midi: C4 },
    { at: 0, midi: E4 },
    { at: 0, midi: C3, hand: 'L' },
    { at: 1, midi: G4 },
    { at: 2, midi: D4 },
    { at: 3, midi: F4 },
  ],
  ottavas: [{ staff: 0, start: 0, end: 1, shift: 1 }],
})

/** Gate arrival times by group; missing = unknown (null ETA). */
function etaFrom(gateAt: Record<number, number>): NonNullable<EngineConfig['transportEta']> {
  return (group, at) => (gateAt[group] === undefined ? null : Math.max(0, gateAt[group]! - at))
}

function driver(
  hands: LearnerHands,
  over: Partial<EngineConfig> = {},
  mode: 'reading' | 'scored' = 'reading',
): EngineDriver {
  const t = buildTimeline(model, { hands, range: null, multiplier: 1 })
  return new EngineDriver(
    t,
    { mode, pieceId: 'p', prepared: true, hints: { autoThreshold: 1, lifetime: 30, fadeMs: 300 }, ...over },
    1000,
  )
}

describe('Accompaniment gate window for the current group', () => {
  const gates = { 0: 2000, 1: 3000, 2: 4000, 3: 5000 }

  it('a press 119 ms before the gate is accepted', () => {
    const d = driver('right', { transportEta: etaFrom(gates) })
    d.now = 2000 - 119
    d.tap(C4, E4)
    expect(d.of('accepted')).toHaveLength(2)
    expect(d.state).toMatchObject({ inputComplete: true, waitingForTransport: true, wrongAttacks: 0 })
    d.engine.transportArrived(0, 2000)
    expect(d.state.groupIndex).toBe(1)
  })

  it('a press 121 ms before the gate is a "too early" wrong attack without hint count or ottava warning', () => {
    const d = driver('right', { transportEta: etaFrom(gates) })
    d.now = 2000 - 121
    d.down(C4)
    const [w] = d.of('wrong')
    expect(w).toEqual({ type: 'wrong', group: 0, pitch: C4, time: 1879, feedbackUntil: 1879 + 300, reason: 'early' })
    expect(d.state).toMatchObject({
      lastWrongReason: 'early',
      wrongAttacks: 1,
      groupHasError: true,
      acceptedPitches: [],
      heldWrongKeys: [],
      ottavaWarning: [],
      hint: null,
    })
    expect(d.of('ottava-warning')).toHaveLength(0)
    // The threshold is 1, yet only a pitch error reveals names.
    d.down(A4)
    expect(d.of('hint-shown')).toHaveLength(1)
    expect(d.state.ottavaWarning).toEqual([0])
    expect(d.state.lastWrongReason).toBe('pitch')
  })

  it('a too-early press counts in the bar’s traversal and spoils first-pass', () => {
    const d = driver('right', { transportEta: etaFrom(gates) }, 'scored')
    d.now = 1500
    d.tap(C4)
    d.engine.transportArrived(0, 2000)
    d.now = 2000
    d.tap(C4, E4)
    d.engine.interrupt('suspend', d.now)
    const [r] = d.records()
    expect(r).toMatchObject({ wrongAttacks: 1, earlyAttacks: 1, groupsFirstPass: 0 })
    expect(r!.measures[0]).toMatchObject({ wrongAttacks: 1, groupsWithErrors: 1 })
  })

  it('an unknown ETA (blocked behind an unreleased gate) is not within the window', () => {
    const d = driver('right', { transportEta: etaFrom({}) })
    d.down(C4)
    expect(d.of('wrong').map((w) => w.reason)).toEqual(['early'])
  })

  it('once the gate is reached or holding, presses are accepted at any time', () => {
    const d = driver('right', { transportEta: etaFrom({}) })
    d.engine.transportArrived(0, 1000)
    d.now = 60_000
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(1)
  })

  it('without a transportEta there is no early check, and free mode is unaffected', () => {
    const noEta = driver('right')
    noEta.tap(C4)
    expect(noEta.state.acceptedPitches).toEqual([C4])
    const free = driver('both', { transportEta: () => 10_000 })
    expect(free.engine.transport).toBe('free')
    free.tap(C4, E4, C3)
    expect(free.state.groupIndex).toBe(1)
    expect(free.state.wrongAttacks).toBe(0)
  })
})

describe('Next-group grace (both modes)', () => {
  it('a next-group press 30 ms before the current chord’s last note is applied after advancement', () => {
    const d = driver('right', { transport: 'free' })
    d.down(C4)
    d.now += 10
    d.down(G4)
    expect(d.state.pendingPitches).toEqual([G4])
    expect(d.of('wrong')).toHaveLength(0)
    d.now += 30
    d.down(E4)
    const evs = d.log.filter((e) => e.type === 'advanced' || e.type === 'accepted' || e.type === 'input-complete')
    expect(evs.map((e) => [e.type, 'group' in e ? e.group : e.from])).toEqual([
      ['accepted', 0],
      ['accepted', 0],
      ['input-complete', 0],
      ['advanced', 0],
      ['accepted', 1],
      ['input-complete', 1],
      ['advanced', 1],
    ])
    expect(d.of('accepted')[2]!.time).toBe(1010)
    expect(d.of('input-complete')[1]!.time).toBe(1040)
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0, pendingPitches: [] })
  })

  it('a next-group press 150 ms early becomes an "ahead" error at its deadline with its original time', () => {
    const d = driver('right', { transport: 'free' })
    d.down(C4)
    d.down(G4)
    expect(d.engine.nextDeadline()).toBe(1000 + EARLY_PRESS_GRACE_MS)
    d.wait(119)
    expect(d.of('wrong')).toHaveLength(0)
    d.wait(1)
    expect(d.of('wrong')).toEqual([
      { type: 'wrong', group: 0, pitch: G4, time: 1000, feedbackUntil: 1300, reason: 'ahead' },
    ])
    // "ahead" behaves like a pitch error: ottava warning, hint threshold, held wrong key.
    expect(d.state).toMatchObject({ ottavaWarning: [0], heldWrongKeys: [G4], pendingPitches: [] })
    expect(d.of('hint-shown')).toHaveLength(1)
    expect(d.engine.nextDeadline()).toBe(1120 + 30_000)
    d.now += 20
    d.down(E4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
  })

  it('an expired pending press is judged before the next input', () => {
    const d = driver('right', { transport: 'free', hints: { autoThreshold: null, lifetime: 30, fadeMs: 300 } })
    d.down(C4).down(G4)
    d.now += 150
    d.down(E4)
    expect(d.of('wrong').map((w) => [w.reason, w.time])).toEqual([['ahead', 1000]])
    expect(d.of('input-complete').map((e) => e.group)).toEqual([0])
    expect(d.records()).toHaveLength(0)
    expect(d.state.groupIndex).toBe(1)
  })

  it('a replay of an accepted pitch stays a replay and never prefills the next group', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 0, midi: E4 },
        { at: 1, midi: C4 },
      ],
    })
    const d = new EngineDriver(buildTimeline(m, { hands: 'both', range: null, multiplier: 1 }), {
      mode: 'reading',
      pieceId: 'p',
    })
    d.tap(C4).tap(C4)
    expect(d.of('replay')).toHaveLength(1)
    expect(d.state.pendingPitches).toEqual([])
    d.tap(E4)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [] })
  })

  it('only the immediate next group is considered', () => {
    const d = driver('right')
    d.down(D4)
    expect(d.of('wrong').map((w) => w.reason)).toEqual(['pitch'])
  })

  it('an early next chord may be pending as a whole', () => {
    const m = buildScore({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: E4 },
        { at: 1, midi: G4 },
        { at: 2, midi: D4 },
      ],
    })
    const d = new EngineDriver(buildTimeline(m, { hands: 'both', range: null, multiplier: 1 }), {
      mode: 'reading',
      pieceId: 'p',
    })
    d.down(E4, G4)
    expect(d.state.pendingPitches).toEqual([E4, G4])
    d.now += 20
    d.down(C4)
    expect(d.state).toMatchObject({ groupIndex: 2, wrongAttacks: 0 })
  })

  it('interrupt, seek and restart drop pending presses without errors', () => {
    for (const action of ['interrupt', 'seek', 'restart', 'pause'] as const) {
      const mode = action === 'seek' || action === 'pause' ? 'reading' : 'scored'
      const d = driver('right', {}, mode)
      d.down(C4).down(G4)
      if (action === 'interrupt') d.engine.interrupt('user-stop', d.now)
      else if (action === 'seek') d.engine.seek(2, d.now)
      else if (action === 'restart') d.engine.restart(d.now)
      else d.engine.pause(d.now)
      d.wait(500)
      expect(d.of('wrong')).toHaveLength(0)
      expect(d.state.pendingPitches).toEqual([])
      expect(d.of('abandon')).toHaveLength(0)
    }
  })

  it('a pending first press in Ready starts the clock at its own timestamp', () => {
    const d = driver('right', { transport: 'free' }, 'scored')
    expect(d.state.phase).toBe('ready')
    d.down(G4)
    expect(d.state).toMatchObject({ phase: 'running', clockStartedAt: 1000, heldKeys: [G4], pendingPitches: [G4] })
    d.now += 30
    d.tap(C4, E4)
    expect(d.state.groupIndex).toBe(2)
    d.tap(D4, F4)
    expect(d.records()[0]).toMatchObject({ completion: 'completed', completionTimeSec: 0.03, wrongAttacks: 0 })
  })
})

describe('Next-group grace with accompaniment', () => {
  function holdingAtZero(gateAt: Record<number, number>): EngineDriver {
    const d = driver('right', { transportEta: etaFrom(gateAt) }, 'scored')
    d.engine.transportArrived(0, 2000)
    d.now = 2000
    return d
  }

  it('applies when the next gate is within the grace of the press', () => {
    const d = holdingAtZero({ 0: 2000, 1: 2050 })
    d.down(C4)
    d.now = 2005
    d.down(G4)
    d.now = 2030
    d.down(E4)
    expect(d.of('accepted').map((e) => [e.group, e.pitch, e.time])).toEqual([
      [0, C4, 2000],
      [0, E4, 2030],
      [1, G4, 2005],
    ])
    expect(d.state).toMatchObject({ groupIndex: 1, inputComplete: true, waitingForTransport: true })
    d.engine.transportArrived(1, 2050)
    expect(d.state.groupIndex).toBe(2)
  })

  it('is "too early" when the next gate is beyond the grace of the press', () => {
    const d = holdingAtZero({ 0: 2000, 1: 2200 })
    d.down(C4)
    d.now = 2005
    d.down(G4)
    d.now = 2030
    d.down(E4)
    expect(d.of('wrong').map((w) => [w.group, w.pitch, w.time, w.reason])).toEqual([[1, G4, 2005, 'early']])
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], pendingPitches: [] })
  })

  it('with an unknown ETA, waits for the actual arrival within the window', () => {
    const d = holdingAtZero({ 0: 2000 })
    d.down(C4)
    d.now = 2005
    d.down(G4)
    d.now = 2030
    d.down(E4)
    expect(d.state.pendingPitches).toEqual([G4])
    expect(d.engine.nextDeadline()).toBe(2125)
    d.engine.transportArrived(1, 2060)
    expect(d.of('accepted').at(-1)).toMatchObject({ group: 1, pitch: G4, time: 2005 })
    expect(d.state.groupIndex).toBe(2)
  })

  it('with an unknown ETA, an arrival after the window makes it "too early"', () => {
    const d = holdingAtZero({ 0: 2000 })
    d.down(C4)
    d.now = 2005
    d.down(G4)
    d.now = 2030
    d.down(E4)
    d.engine.transportArrived(1, 2140)
    expect(d.of('wrong').map((w) => [w.group, w.reason, w.time])).toEqual([[1, 'early', 2005]])
    expect(d.state).toMatchObject({ groupIndex: 1, transportGate: 1, acceptedPitches: [] })
  })
})

describe('Matching-rules identity', () => {
  it('records name the grace in their comparison context', () => {
    const d = driver('both', {}, 'scored')
    expect(d.engine.matchingRules).toBe('match-v2-early-grace-120ms')
    const custom = driver('both', { earlyGraceMs: 50 }, 'scored')
    expect(custom.engine.matchingRules).toBe('match-v2-early-grace-50ms')
    custom.tap(C4, E4, C3, G4, D4, F4)
    expect(custom.records()[0]!.context.matchingRules).toBe('match-v2-early-grace-50ms')
  })
})
