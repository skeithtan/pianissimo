/**
 * Strict transport (rhythm mode, DECISIONS P13): the music never waits; every learner onset
 * group is judged against its scheduled time (the transport's arrival at its gate).
 *
 * The scripted transport runs at a fixed tempo from the end of the count-in (`START`): gate i
 * arrives at `sched[i]` whatever the learner does, the session reports each arrival with its own
 * time (`transportArrived(i, sched[i])`) and the engine asks `transportEta` before arrival.
 */
import { describe, expect, it } from 'vitest'
import type { ScoreSpec } from './testkit'
import { toNumber } from '../music/rational'
import { AttemptLog, buildAttemptRecord } from './attempt'
import {
  DEFAULT_RHYTHM_TOLERANCE_MS,
  EARLY_PRESS_GRACE_MS,
  PracticeEngine,
  matchingRulesFor,
  rhythmMatchingRulesFor,
} from './engine'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline, transportGates } from './timeline'
import type { EngineConfig } from './types'

const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const B3 = 59

/** End of the count-in: the transport (and the attempt clock) start here. */
const START = 2000
/** Quarter = 60: one whole note is 4000 ms. */
const MS_PER_WHOLE = 4000

// One bar of quarters, then a second bar: gates at START, +1000, +2000, +3000, +4000.
const SCALE: ScoreSpec = {
  notes: [
    { at: 0, midi: C4 },
    { at: 1, midi: D4 },
    { at: 2, midi: E4 },
    { at: 3, midi: F4 },
    { at: 4, midi: G4 },
  ],
}

interface Session {
  readonly d: EngineDriver
  readonly sched: readonly number[]
  /** Move the clock to `time`: report every gate due by then, tick, drain. */
  at(time: number): void
  /** End of the count-in: start the clock at START and report the first gate. */
  go(): void
}

function session(
  spec: ScoreSpec = SCALE,
  toleranceMs = 150,
  extra: Partial<EngineConfig> = {},
  msPerWhole = MS_PER_WHOLE,
): Session {
  const model = buildScore(spec)
  const t = buildTimeline(model, { hands: 'right', range: null, multiplier: 1 })
  const sched = transportGates(t).map((p) => START + toNumber(p) * msPerWhole)
  let next = 0
  const d = new EngineDriver(
    t,
    {
      mode: 'scored',
      pieceId: 'p',
      prepared: true,
      transport: 'strict',
      rhythm: { toleranceMs },
      transportEta: (g, at) => {
        const s = sched[g]
        return s === undefined ? null : Math.max(0, s - at)
      },
      ...extra,
    },
    1000,
  )
  const at = (time: number): void => {
    d.now = time
    while (next < sched.length && sched[next]! <= time) {
      d.engine.transportArrived(next, sched[next]!)
      next++
    }
    d.engine.tick(time)
    d.flush()
  }
  const go = (): void => {
    d.now = START
    d.engine.startRunning(START)
    at(START)
  }
  return { d, sched, at, go }
}

describe('Strict transport: configuration', () => {
  const model = buildScore(SCALE)
  const t = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })

  it('needs rhythm parameters, is scored only and validates the tolerance', () => {
    expect(() => new PracticeEngine(t, { mode: 'scored', pieceId: 'p', transport: 'strict' }, 0)).toThrow(RangeError)
    expect(
      () =>
        new PracticeEngine(t, { mode: 'reading', pieceId: 'p', transport: 'strict', rhythm: { toleranceMs: 150 } }, 0),
    ).toThrow(RangeError)
    expect(
      () =>
        new PracticeEngine(t, { mode: 'scored', pieceId: 'p', transport: 'strict', rhythm: { toleranceMs: -1 } }, 0),
    ).toThrow(RangeError)
  })

  it('names its matching rules after the tolerance; the default tolerance is 150 ms', () => {
    expect(DEFAULT_RHYTHM_TOLERANCE_MS).toBe(150)
    const { d } = session(SCALE, 120)
    expect(d.engine.transport).toBe('strict')
    expect(d.state.transport).toBe('strict')
    expect(d.engine.matchingRules).toBe('strict-v1-tol-120ms')
    expect(rhythmMatchingRulesFor(150)).toBe('strict-v1-tol-150ms')
  })

  it('reconfiguring to strict needs rhythm parameters; a kept strict transport does not follow into reading', () => {
    const e = new PracticeEngine(t, { mode: 'scored', pieceId: 'p', prepared: true }, 0)
    expect(() => e.reconfigure({ reason: 'mode-change', transport: 'strict' }, 1)).toThrow(RangeError)
    e.reconfigure({ reason: 'mode-change', transport: 'strict', rhythm: { toleranceMs: 100 } }, 2)
    expect(e.transport).toBe('strict')
    expect(e.matchingRules).toBe('strict-v1-tol-100ms')
    e.reconfigure({ reason: 'mode-change', mode: 'reading' }, 3)
    expect(e.transport).toBe('accompaniment')
    expect(() => e.reconfigure({ reason: 'mode-change', transport: 'strict' }, 4)).toThrow(RangeError)
  })

  it('rhythm parameters outside strict change nothing; strict records need them', () => {
    const e = new PracticeEngine(t, { mode: 'scored', pieceId: 'p', rhythm: { toleranceMs: 90 } }, 0)
    expect(e.transport).toBe('accompaniment')
    expect(e.matchingRules).toBe(matchingRulesFor(EARLY_PRESS_GRACE_MS))
    e.updateSettings({ rhythm: { toleranceMs: 80 } }, 1)
    expect(e.state.phase).toBe('preparing')
    expect(() =>
      buildAttemptRecord({
        log: new AttemptLog('a', 0),
        kind: 'scored',
        timeline: t,
        transport: 'strict',
        pieceId: 'p',
        labelSettings: { mode: 'off', rulesJson: '{}' },
        completion: 'completed',
        reason: null,
        timeTolerance: null,
      }),
    ).toThrow(RangeError)
  })

  it('a different tolerance interrupts an active strict attempt (different comparison context)', () => {
    const { d, go } = session()
    go()
    d.engine.updateSettings({ rhythm: { toleranceMs: 150 } }, START + 10)
    expect(d.state.phase).toBe('running')
    d.engine.updateSettings({ rhythm: { toleranceMs: 200 } }, START + 20)
    d.flush()
    expect(d.state.phase).toBe('interrupted')
    expect(d.state.interruptReason).toBe('setting-change')
    expect(d.engine.matchingRules).toBe('strict-v1-tol-200ms')
  })
})

describe('Strict transport: Ready and the clock', () => {
  it('presses in Ready only update key state: no clock, no judging, no wrong attack', () => {
    const { d, at } = session()
    expect(d.state.phase).toBe('ready')
    at(1500)
    d.down(C4)
    expect(d.state.heldKeys).toEqual([C4])
    expect(d.state.phase).toBe('ready')
    expect(d.state.clockStartedAt).toBeNull()
    expect(d.state.acceptedPitches).toEqual([])
    expect(d.of('clock-started')).toEqual([])
    expect(d.of('wrong')).toEqual([])
    expect(d.of('key').at(-1)).toEqual({ type: 'key', note: C4, down: true, wrong: false })
    d.up(C4).down(B3).up(B3)
    expect(d.state.wrongAttacks).toBe(0)
  })

  it('startRunning moves Ready to Running and starts the clock at the end of the count-in', () => {
    const { d, go } = session()
    go()
    expect(d.state.phase).toBe('running')
    expect(d.state.clockStartedAt).toBe(START)
    expect(d.of('clock-started')).toEqual([{ type: 'clock-started', time: START }])
    expect(d.state.transportGate).toBe(0)
    // Calling it again (or in another phase) is a no-op.
    d.engine.startRunning(START + 50)
    expect(d.of('clock-started')).toHaveLength(1)
    expect(d.state.clockStartedAt).toBe(START)
  })

  it('startRunning is a no-op in other transports and while Preparing', () => {
    const model = buildScore(SCALE)
    const t = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const acc = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true })
    acc.engine.startRunning(1500)
    expect(acc.state.phase).toBe('ready')
    expect(acc.state.clockStartedAt).toBeNull()
    const strict = new EngineDriver(t, {
      mode: 'scored',
      pieceId: 'p',
      transport: 'strict',
      rhythm: { toleranceMs: 150 },
    })
    expect(strict.state.phase).toBe('preparing')
    strict.engine.startRunning(1500)
    expect(strict.state.phase).toBe('preparing')
    expect(strict.state.clockStartedAt).toBeNull()
  })

  it('the next deadline includes the current group close', () => {
    const { d, go } = session()
    go()
    expect(d.engine.nextDeadline()).toBe(START + 150)
  })
})

describe('Strict transport: judging against the scheduled time', () => {
  it('an on-time press is accepted with its offset; the first group is judged like every other', () => {
    const { d, at, go } = session()
    go()
    at(START + 20)
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.lastOffsetMs).toBe(20)
    expect(d.of('input-complete').map((e) => e.group)).toEqual([0])
  })

  it('early within the tolerance is accepted and advances at once (never waits for the gate)', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 900)
    d.tap(D4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.waitingForTransport).toBe(false)
    expect(d.of('waiting-for-transport')).toEqual([])
    expect(d.state.lastOffsetMs).toBe(-100)
    // The arrival at a group already left changes nothing.
    at(START + 1000)
    expect(d.state.groupIndex).toBe(2)
    expect(d.of('missed')).toEqual([])
  })

  it('early beyond the tolerance is a too-early wrong attack, not accepted', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 800)
    d.tap(D4)
    expect(d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[1, D4, 'early']])
    expect(d.state.wrongAttacks).toBe(1)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.acceptedPitches).toEqual([])
    at(START + 1000)
    d.tap(D4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.lastOffsetMs).toBe(0)
  })

  it('late within the tolerance is accepted, up to and including the tolerance', () => {
    const { d, at, go } = session()
    go()
    at(START + 140)
    d.tap(C4)
    expect(d.state.lastOffsetMs).toBe(140)
    at(START + 1150)
    // The tick at the close time already closed group 1: exactly at the close, only a press counts.
    expect(d.of('missed').map((m) => m.group)).toEqual([1])
  })

  it('a press exactly at the close time (before any tick) is still on time', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    d.now = START + 1000
    d.engine.transportArrived(1, START + 1000)
    d.now = START + 1150
    d.tap(D4)
    expect(d.of('missed')).toEqual([])
    expect(d.state.lastOffsetMs).toBe(150)
    at(START + 1200)
    expect(d.state.groupIndex).toBe(2)
  })
})

describe('Strict transport: missing by the clock', () => {
  it('an incomplete group closes at arrival + tolerance and the next group is current at once', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1149)
    expect(d.state.groupIndex).toBe(1)
    at(START + 1150)
    expect(d.of('missed')).toEqual([{ type: 'missed', group: 1, notes: [1], time: START + 1150 }])
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.missedGroups).toBe(1)
    expect(d.state.groupHasError).toBe(false)
    expect(d.state.wrongAttacks).toBe(0)
    // Group 2's close is known once its gate arrives.
    expect(d.engine.nextDeadline()).toBeNull()
    at(START + 2000)
    expect(d.engine.nextDeadline()).toBe(START + 2150)
  })

  it('a press after the close is judged after the close (input processes the due close first)', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1000)
    d.now = START + 1300
    d.tap(E4)
    expect(d.of('missed').map((m) => m.group)).toEqual([1])
    // E4 belongs to group 2, still 700 ms away: too early.
    expect(d.of('wrong').map((w) => [w.group, w.reason])).toEqual([[2, 'early']])
  })

  it('a late slip is still gentle long after the close while the next group has not arrived', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1000)
    // Group 1 (D4) closes at 1150; D4 at 1400 is 250 ms past the close but before group 2 arrives.
    d.now = START + 1400
    d.tap(D4)
    expect(d.of('missed').map((m) => m.group)).toEqual([1])
    expect(d.of('wrong').map((w) => [w.group, w.reason])).toEqual([[1, 'late']])
    expect(d.state.wrongAttacks).toBe(0)
    // Once group 2 has arrived and the tolerance after the close has passed, D4 is a wrong note.
    at(START + 2000)
    d.now = START + 2050
    d.tap(D4)
    expect(d.of('wrong').map((w) => [w.group, w.reason])).toEqual([
      [1, 'late'],
      [2, 'pitch'],
    ])
    expect(d.state.wrongAttacks).toBe(1)
  })

  it('a late slip of the missed group within the tolerance of its close is gentle feedback only', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1150)
    const washBefore = d.state.wrongFeedbackUntil
    at(START + 1200)
    d.tap(D4)
    const late = d.of('wrong').filter((w) => w.reason === 'late')
    expect(late).toEqual([
      { type: 'wrong', group: 1, pitch: D4, time: START + 1200, feedbackUntil: washBefore, reason: 'late' },
    ])
    expect(d.state.wrongAttacks).toBe(0)
    expect(d.state.wrongFeedbackUntil).toBe(washBefore)
    expect(d.state.groupHasError).toBe(false)
    expect(d.state.heldWrongKeys).toEqual([])
    expect(d.state.lastWrongReason).toBeNull()
    // Still a slip beyond the tolerance while group 2 has not arrived; once it has (and the
    // tolerance after the close has passed) it is an ordinary wrong key.
    at(START + 1301)
    d.tap(D4)
    expect(d.of('wrong').at(-1)).toMatchObject({ group: 1, pitch: D4, reason: 'late' })
    expect(d.state.wrongAttacks).toBe(0)
    at(START + 2000)
    d.now = START + 2001
    d.tap(D4)
    expect(d.of('wrong').at(-1)).toMatchObject({ group: 2, pitch: D4, reason: 'pitch' })
    expect(d.state.wrongAttacks).toBe(1)
  })

  it('a missed group counts in its bar traversal, which stays complete', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1150)
    at(START + 2000)
    d.tap(E4)
    at(START + 3000)
    d.tap(F4)
    const bar = d.of('measure').map((m) => m.traversal)[0]!
    expect(bar).toMatchObject({ occ: 0, complete: true, wrongAttacks: 0, groupsWithErrors: 1 })
  })

  it('the attempt completes when the last group closes missed', () => {
    const { d, at, go, sched } = session()
    go()
    d.tap(C4)
    at(START + 1000)
    d.tap(D4)
    at(START + 2000)
    d.tap(E4)
    at(START + 3000)
    d.tap(F4)
    at(sched[4]! + 150)
    expect(d.state.phase).toBe('completed')
    const r = d.records()[0]!
    expect(r.completion).toBe('completed')
    expect(r.missedGroups).toBe(1)
    expect(r.completionTimeSec).toBeCloseTo(4.15)
    expect(r.passed).toBe(false)
    expect(r.groups!.at(-1)).toMatchObject({ group: 4, missed: true })
    expect(r.groups!.at(-1)!.offsetMs).toBeUndefined()
  })

  it('an arrival ahead of the current group closes the groups in between as missed, in order', () => {
    const { d, go } = session()
    go()
    d.tap(C4)
    d.now = START + 3000
    d.engine.transportArrived(3, START + 3000)
    d.flush()
    expect(d.of('missed').map((m) => [m.group, m.time])).toEqual([
      [1, START + 3000],
      [2, START + 3000],
    ])
    expect(d.state.groupIndex).toBe(3)
    expect(d.state.transportGate).toBe(3)
    expect(d.engine.nextDeadline()).toBe(START + 3150)
    d.tap(F4)
    expect(d.state.lastOffsetMs).toBe(0)
  })

  it('a gate reached earlier keeps its own close when a later gate jumps ahead', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1000)
    d.now = START + 1100
    d.engine.transportArrived(3, START + 1100)
    d.flush()
    // Group 1 (arrived at +1000) is still open until +1150; group 2 closes at the jump.
    expect(d.state.groupIndex).toBe(1)
    d.tap(D4)
    d.wait(0)
    expect(d.of('missed').map((m) => m.group)).toEqual([2])
    expect(d.state.groupIndex).toBe(3)
  })
})

describe('Strict transport: overlapping windows (IOI shorter than the tolerance)', () => {
  // Sixteenths at quarter = 60: gates every 250 ms, tolerance 300 ms.
  const SIXTEENTHS: ScoreSpec = {
    notes: [
      { at: 0, midi: C4, dur: 0.25 },
      { at: 0.25, midi: D4, dur: 0.25 },
      { at: 0.5, midi: E4, dur: 0.25 },
      { at: 0.75, midi: F4, dur: 0.25 },
    ],
  }

  it('a next-group press while the current group is open is pending, then applied in order', () => {
    const { d, at, go } = session(SIXTEENTHS, 300)
    go()
    at(START + 240)
    d.down(D4)
    expect(d.state.pendingPitches).toEqual([D4])
    expect(d.state.groupIndex).toBe(0)
    at(START + 260)
    d.down(C4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.pendingPitches).toEqual([])
    expect(d.of('wrong')).toEqual([])
    expect(d.of('accepted').map((a) => [a.group, a.pitch, a.time])).toEqual([
      [0, C4, START + 260],
      [1, D4, START + 240],
    ])
  })

  it('the current group still open when the next gate arrives keeps its window', () => {
    const { d, at, go } = session(SIXTEENTHS, 300)
    go()
    at(START + 280)
    expect(d.state.transportGate).toBe(1)
    expect(d.state.groupIndex).toBe(0)
    d.tap(C4)
    expect(d.state.lastOffsetMs).toBe(280)
    expect(d.state.groupIndex).toBe(1)
  })

  it('a pending press of the next group is accepted once the current group closes missed', () => {
    const { d, at, go } = session(SIXTEENTHS, 300)
    go()
    at(START + 260)
    d.down(D4)
    expect(d.state.pendingPitches).toEqual([D4])
    at(START + 300)
    expect(d.of('missed').map((m) => m.group)).toEqual([0])
    expect(d.state.groupIndex).toBe(2)
    expect(d.of('accepted').map((a) => [a.group, a.pitch])).toEqual([[1, D4]])
    expect(d.of('wrong')).toEqual([])
  })

  it('a pending deadline and a close at the same time: the close comes first', () => {
    const { d, at, go } = session(SIXTEENTHS, 300)
    go()
    d.down(D4)
    at(START + 299)
    expect(d.state.pendingPitches).toEqual([D4])
    at(START + 300)
    // Deadline (press + 300) and the close of group 0 coincide: the close comes first, so the
    // press resolves against group 1, whose gate (+250) was within the tolerance of the press.
    expect(d.of('missed').map((m) => m.group)).toEqual([0])
    expect(d.of('accepted').map((a) => [a.group, a.pitch])).toEqual([[1, D4]])
  })

  it('a pending press expiring while its group is still not current is "ahead"', () => {
    // The current group's own gate is still ahead (group 1 completed early), so the pending
    // window of a group-3 press ends before group 2 can close.
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 860)
    d.tap(D4)
    expect(d.state.groupIndex).toBe(2)
    at(START + 870)
    d.down(F4)
    expect(d.state.pendingPitches).toEqual([F4])
    at(START + 1020)
    expect(d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[2, F4, 'ahead']])
    expect(d.state.wrongAttacks).toBe(1)
  })
})

describe('Strict transport: a slip on a fast run (look-ahead within the tolerance)', () => {
  // Twelve sixteenths on distinct pitches; `msPerWhole` sets the gap (sixteenth = msPerWhole / 16).
  const RUN_PITCHES = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79]
  const RUN: ScoreSpec = { notes: RUN_PITCHES.map((midi, i) => ({ at: i / 4, midi, dur: 0.25 })) }
  // Gaps under half the tolerance: 114 ms (♩=132) at 250, 72 ms at 150.
  const FAST = [
    { gapMs: 114, toleranceMs: 250 },
    { gapMs: 72, toleranceMs: 150 },
  ] as const

  /** Press every group from `from` on exactly at its gate; `before` runs at the first gate. */
  function playFrom(s: Session, from: number, before: () => void = () => {}): void {
    s.go()
    before()
    for (let i = from; i < RUN_PITCHES.length; i++) {
      s.at(s.sched[i]!)
      s.d.tap(RUN_PITCHES[i]!)
    }
  }

  function outcomes(s: Session): (number | 'missed' | undefined)[] {
    return s.d.records()[0]!.groups!.map((g) => (g.missed ? 'missed' : g.offsetMs))
  }

  it.each(FAST)('one skipped note costs one group, not every second one ($gapMs ms, tolerance $toleranceMs)', (c) => {
    const s = session(RUN, c.toleranceMs, {}, c.gapMs * 16)
    playFrom(s, 1)
    expect(s.d.state.phase).toBe('completed')
    const r = s.d.records()[0]!
    expect(r.missedGroups).toBe(1)
    expect(r.wrongAttacks).toBe(0)
    expect(outcomes(s)).toEqual(['missed', ...RUN_PITCHES.slice(1).map(() => 0)])
  })

  it.each(FAST)('a wrong key on the first beat is one wrong attack and one miss ($gapMs ms)', (c) => {
    const s = session(RUN, c.toleranceMs, {}, c.gapMs * 16)
    playFrom(s, 1, () => s.d.tap(61))
    const r = s.d.records()[0]!
    expect(s.d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[0, 61, 'pitch']])
    expect(r.wrongAttacks).toBe(1)
    expect(r.missedGroups).toBe(1)
    expect(outcomes(s)).toEqual(['missed', ...RUN_PITCHES.slice(1).map(() => 0)])
  })

  it('presses for several later groups pending while the current one is open are accepted in order', () => {
    // 50 ms gaps at tolerance 250: groups 1 to 4 are pressed before group 0 closes at +250.
    const s = session(RUN, 250, {}, 800)
    s.go()
    for (let i = 1; i <= 4; i++) {
      s.at(s.sched[i]!)
      s.d.tap(RUN_PITCHES[i]!)
    }
    expect(s.d.state.groupIndex).toBe(0)
    expect(s.d.state.pendingPitches).toEqual(RUN_PITCHES.slice(1, 5))
    s.at(START + 250)
    expect(s.d.of('missed').map((m) => m.group)).toEqual([0])
    expect(s.d.state.groupIndex).toBe(5)
    expect(s.d.state.pendingPitches).toEqual([])
    expect(s.d.of('accepted').map((a) => [a.group, a.time])).toEqual([1, 2, 3, 4].map((i) => [i, s.sched[i]!]))
    expect(s.d.of('wrong')).toEqual([])
  })

  it.each(FAST)('two slips in a row cost exactly those two groups ($gapMs ms)', (c) => {
    const s = session(RUN, c.toleranceMs, {}, c.gapMs * 16)
    playFrom(s, 2)
    const r = s.d.records()[0]!
    expect(r.missedGroups).toBe(2)
    expect(r.wrongAttacks).toBe(0)
    expect(outcomes(s)).toEqual(['missed', 'missed', ...RUN_PITCHES.slice(2).map(() => 0)])
  })

  it('a pitch only further ahead than the tolerance is still a wrong key', () => {
    const s = session(RUN, 250, {}, 114 * 16)
    s.go()
    // Group 4 is 456 ms away; group 9's pitch is not near either.
    s.d.tap(RUN_PITCHES[4]!, RUN_PITCHES[9]!)
    expect(s.d.state.pendingPitches).toEqual([])
    expect(s.d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([
      [0, RUN_PITCHES[4], 'pitch'],
      [0, RUN_PITCHES[9], 'pitch'],
    ])
    expect(s.d.state.wrongAttacks).toBe(2)
  })

  it('a later group pressed within the tolerance before its gate is accepted early; beyond it, wrong', () => {
    // 50 ms gaps at tolerance 100: group 3 is scheduled at +150.
    const s = session(RUN, 100, {}, 800)
    s.go()
    s.d.tap(RUN_PITCHES[0]!)
    s.at(START + 20)
    // Current group 1; group 3 is 130 ms away, beyond the tolerance.
    s.d.tap(RUN_PITCHES[3]!)
    expect(s.d.of('wrong').map((w) => [w.group, w.pitch, w.reason])).toEqual([[1, RUN_PITCHES[3], 'pitch']])
    s.at(START + 60)
    // Group 3 is now 90 ms away: pending until group 3 is current.
    s.d.tap(RUN_PITCHES[3]!)
    expect(s.d.state.pendingPitches).toEqual([RUN_PITCHES[3]])
    s.d.tap(RUN_PITCHES[1]!)
    s.at(s.sched[2]!)
    s.d.tap(RUN_PITCHES[2]!)
    expect(s.d.state.groupIndex).toBe(4)
    expect(s.d.of('wrong')).toHaveLength(1)
    expect(s.d.of('accepted').at(-1)).toMatchObject({ group: 3, pitch: RUN_PITCHES[3], time: START + 60 })
    // Completed before its scheduled time: the offset is negative (early).
    expect(s.d.state.lastOffsetMs).toBeLessThan(0)
  })
})

describe('Strict transport: chords', () => {
  const CHORDS: ScoreSpec = {
    notes: [
      { at: 0, midi: C4 },
      { at: 1, midi: E4 },
      { at: 1, midi: G4 },
      { at: 2, midi: F4 },
    ],
  }

  it('a spread chord completes at its last accepted attack; spreadMs and offsetMs follow', () => {
    const { d, at, go } = session(CHORDS)
    go()
    d.tap(C4)
    at(START + 950)
    d.down(E4)
    at(START + 1030)
    d.down(G4)
    expect(d.state.groupIndex).toBe(2)
    expect(d.state.lastOffsetMs).toBe(30)
    d.engine.interrupt('user-stop', START + 1100)
    const g = d.records()[0]!.groups![1]!
    expect(g).toMatchObject({ group: 1, spreadMs: 80, offsetMs: 30, lateMs: 30 })
  })

  it('a partial chord then the close: missed, its missing notes no longer required', () => {
    const { d, at, go } = session(CHORDS)
    go()
    d.tap(C4)
    at(START + 1000)
    d.tap(E4)
    expect(d.state.missingPitches).toEqual([G4])
    at(START + 1150)
    expect(d.of('missed')).toHaveLength(1)
    expect(d.state.groupIndex).toBe(2)
    at(START + 2000)
    d.tap(F4)
    const r = d.records()[0]!
    expect(r.groups![1]).toMatchObject({ group: 1, missed: true, spreadMs: 0 })
    expect(r.groups![1]!.offsetMs).toBeUndefined()
    expect(r.missedGroups).toBe(1)
    expect(r.groupsFirstPass).toBe(2)
  })
})

describe('Strict transport: records', () => {
  function playAll(s: Session, offsets: readonly number[]): void {
    s.go()
    const pitches = [C4, D4, E4, F4, G4]
    offsets.forEach((o, i) => {
      s.at(s.sched[i]! + o)
      s.d.tap(pitches[i]!)
    })
  }

  it('all groups within the tolerance pass; the record carries the strict context and offsets', () => {
    const s = session(SCALE, 150, { passTimeTolerance: 0.0001 })
    playAll(s, [10, -40, 0, 120, -150])
    expect(s.d.state.phase).toBe('completed')
    const r = s.d.records()[0]!
    expect(r.context.transport).toBe('strict')
    expect(r.context.matchingRules).toBe('strict-v1-tol-150ms')
    expect(r.contextKey).toContain('|strict|strict-v1-tol-150ms')
    expect(r.rhythm).toEqual({ toleranceMs: 150 })
    expect(r.missedGroups).toBe(0)
    expect(r.groups!.map((g) => g.offsetMs)).toEqual([10, -40, 0, 120, -150])
    expect(r.groups!.map((g) => g.lateMs)).toEqual([10, 0, 0, 120, 0])
    expect(r.groups!.some((g) => g.missed)).toBe(false)
    // The total-time tolerance does not apply in strict.
    expect(r.passed).toBe(true)
    expect(r.completionTimeSec).toBeCloseTo((s.sched[4]! - 150 - START) / 1000)
    expect(r.expectedTimeSec).toBeCloseTo(4)
    expect(r.onsets.map((o) => o.t)).toEqual([0.01, 0.96, 2, 3.12, 3.85])
  })

  it('a wrong attack fails the attempt even when every group is on time', () => {
    const s = session()
    s.go()
    s.d.tap(B3, C4)
    s.at(START + 1000)
    s.d.tap(D4)
    s.at(START + 2000)
    s.d.tap(E4)
    s.at(START + 3000)
    s.d.tap(F4)
    s.at(START + 4000)
    s.d.tap(G4)
    const r = s.d.records()[0]!
    expect(r.wrongAttacks).toBe(1)
    expect(r.missedGroups).toBe(0)
    expect(r.passed).toBe(false)
  })

  it('a too-early wrong attack fails the attempt', () => {
    const s = session()
    s.go()
    s.d.tap(C4)
    s.at(START + 700)
    s.d.tap(D4)
    s.at(START + 1000)
    s.d.tap(D4)
    s.at(START + 2000)
    s.d.tap(E4)
    s.at(START + 3000)
    s.d.tap(F4)
    s.at(START + 4000)
    s.d.tap(G4)
    const r = s.d.records()[0]!
    expect(r.earlyAttacks).toBe(1)
    expect(r.passed).toBe(false)
  })

  it('free and accompaniment records carry no rhythm fields', () => {
    const model = buildScore(SCALE)
    const t = buildTimeline(model, { hands: 'right', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
    d.tap(C4, D4, E4, F4, G4)
    const r = d.records()[0]!
    expect(r.rhythm).toBeUndefined()
    expect(r.missedGroups).toBeUndefined()
    expect(r.groups!.every((g) => g.offsetMs === undefined && g.missed === undefined)).toBe(true)
    expect(d.state.missedGroups).toBe(0)
    expect(d.state.lastOffsetMs).toBeNull()
  })
})

describe('Strict transport: assistance and lifecycle', () => {
  it('hints and keyboard assistance are still recorded; a hint retires when its group is missed', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1000)
    expect(d.engine.requestHint(START + 1000)).toBe(true)
    d.flush()
    expect(d.state.hint?.group).toBe(1)
    at(START + 1150)
    expect(d.of('hint-retired')).toEqual([{ type: 'hint-retired', group: 1, reason: 'dismissed' }])
    expect(d.state.hint).toBeNull()
    d.engine.setKeyboardVisible(true, START + 1200)
    d.engine.interrupt('user-stop', START + 1300)
    const r = d.records()[0]!
    expect(r.assistance.hintRequests).toBe(1)
    expect(r.assistance.hintGroups).toEqual([1])
    expect(r.assistance.level).toBe('keyboard')
  })

  it('an automatic hint still follows wrong keys; a hint in Ready never starts the clock', () => {
    const { d, at, go } = session()
    expect(d.engine.requestHint(1500)).toBe(true)
    d.flush()
    expect(d.state.phase).toBe('ready')
    expect(d.state.clockStartedAt).toBeNull()
    go()
    d.tap(C4)
    at(START + 1000)
    d.tap(B3)
    expect(d.of('hint-shown').map((h) => [h.group, h.source])).toEqual([
      [0, 'manual'],
      [1, 'auto'],
    ])
  })

  it('an interruption mid-attempt records what was reached, misses and offsets included', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1150)
    at(START + 2050)
    d.tap(E4)
    d.engine.pause(START + 2500)
    d.flush()
    expect(d.state.phase).toBe('interrupted')
    const r = d.records()[0]!
    expect(r.completion).toBe('interrupted')
    expect(r.interruptReason).toBe('pause')
    expect(r.passed).toBe(false)
    expect(r.completionTimeSec).toBeUndefined()
    expect(r.missedGroups).toBe(1)
    expect(r.rhythm).toEqual({ toleranceMs: 150 })
    expect(r.groups!.map((g) => [g.group, g.offsetMs, g.missed])).toEqual([
      [0, 0, undefined],
      [1, undefined, true],
      [2, 50, undefined],
      [3, undefined, undefined],
    ])
  })

  it('restart goes back through Preparing to Ready; the next attempt starts with startRunning', () => {
    const { d, at, go } = session()
    go()
    d.tap(C4)
    at(START + 1150)
    expect(d.state.missedGroups).toBe(1)
    d.engine.restart(START + 1300)
    d.flush()
    expect(d.records()[0]!.completion).toBe('abandoned')
    expect(d.state.phase).toBe('preparing')
    d.engine.markPrepared(START + 1400)
    d.flush()
    expect(d.state).toMatchObject({ phase: 'ready', missedGroups: 0, lastOffsetMs: null, transportGate: -1 })
    expect(d.engine.nextDeadline()).toBeNull()
    // A press in Ready does nothing; the clock starts with the new count-in's end.
    d.now = START + 1500
    d.tap(C4)
    expect(d.state.clockStartedAt).toBeNull()
    const T = 10_000
    d.now = T
    d.engine.startRunning(T)
    d.engine.transportArrived(0, T)
    d.flush()
    d.now = T + 30
    d.tap(C4)
    expect(d.state.groupIndex).toBe(1)
    expect(d.state.lastOffsetMs).toBe(30)
    // A late slip of the previous attempt's missed group is forgotten.
    d.now = T + 40
    d.tap(D4)
    expect(d.of('wrong').filter((w) => w.reason === 'late')).toEqual([])
  })
})
