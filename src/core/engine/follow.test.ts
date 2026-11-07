/**
 * Play-through follower (DECISIONS P12): gates are released when a group is played, when the
 * learner moves on to one of the next groups, or when patience runs out after a press; a
 * learner who stops playing is waited for indefinitely.
 */
import { describe, expect, it } from 'vitest'
import { CC_ALL_NOTES_OFF } from '../midi/types'
import {
  FOLLOW_WRONG_FEEDBACK_MS,
  PATIENCE_LAST_MS,
  PATIENCE_MAX_MS,
  PATIENCE_MIN_MS,
  type FollowerConfig,
  type FollowerEvent,
  PlayFollower,
  patienceMs,
} from './follow'
import { MidiScript, buildScore, quarters, type ScoreSpec } from './testkit'
import { type LearnerHands, type Timeline, buildTimeline } from './timeline'

const C3 = 48
const C4 = 60
const D4 = 62
const E4 = 64
const F4 = 65
const G4 = 67
const A4 = 69
const B4 = 71

// Quarter = 60 (1 s per quarter). Groups: 0 = [C4, E4], 1 = [G4], 2 = [D4], 3 = [F4], 4 = [A4].
const spec: ScoreSpec = {
  notes: [
    { at: 0, midi: C4 },
    { at: 0, midi: E4 },
    { at: 0, midi: C3, hand: 'L' },
    { at: 1, midi: G4 },
    { at: 2, midi: D4 },
    { at: 3, midi: F4 },
    { at: 4, midi: A4 },
  ],
}

function timelineOf(s: ScoreSpec = spec, hands: LearnerHands = 'right', multiplier = 1): Timeline {
  return buildTimeline(buildScore(s), { hands, range: null, multiplier })
}

class Driver {
  readonly follower: PlayFollower
  readonly midi = new MidiScript()
  readonly log: FollowerEvent[] = []
  now = 1000

  constructor(timeline: Timeline = timelineOf(), config: FollowerConfig = {}) {
    this.follower = new PlayFollower(timeline, config, this.now)
    this.flush()
  }

  get state() {
    return this.follower.state
  }

  flush(): void {
    this.log.push(...this.follower.drainEvents())
  }

  /** Events since the previous `take()` (or construction), without `key` events. */
  #taken = 0
  take(): FollowerEvent[] {
    this.flush()
    const out = this.log.slice(this.#taken).filter((e) => e.type !== 'key')
    this.#taken = this.log.length
    return out
  }

  wait(ms: number): this {
    this.now += ms
    this.follower.tick(this.now)
    this.flush()
    return this
  }

  down(...notes: number[]): this {
    for (const n of notes) this.follower.input(this.midi.on(n, this.now))
    this.flush()
    return this
  }

  up(...notes: number[]): this {
    for (const n of notes) this.follower.input(this.midi.off(n, this.now))
    this.flush()
    return this
  }

  tap(...notes: number[]): this {
    for (const n of notes) this.down(n).up(n)
    return this
  }

  arrive(group: number): this {
    this.follower.transportArrived(group, this.now)
    this.flush()
    return this
  }

  of<T extends FollowerEvent['type']>(type: T): Extract<FollowerEvent, { type: T }>[] {
    this.flush()
    return this.log.filter((e): e is Extract<FollowerEvent, { type: T }> => e.type === type)
  }

  releases(): [number, string][] {
    return this.of('release').map((e) => [e.group, e.reason])
  }
}

describe('patienceMs', () => {
  it('is the time to the next onset at the current speed, clamped, and fixed for the last group', () => {
    const t = timelineOf()
    expect(patienceMs(t, 0)).toBe(1000)
    expect(patienceMs(t, 4)).toBe(PATIENCE_LAST_MS)
    expect(patienceMs(timelineOf(spec, 'right', 2), 0)).toBe(500)
    expect(patienceMs(timelineOf(spec, 'right', 4), 0)).toBe(PATIENCE_MIN_MS)
    expect(patienceMs(timelineOf(spec, 'right', 0.25), 0)).toBe(PATIENCE_MAX_MS)
    expect(patienceMs(timelineOf({ ...spec, tempo: { bpm: 240 } }), 1)).toBe(PATIENCE_MIN_MS)
    expect(patienceMs(timelineOf({ ...spec, tempo: { bpm: 20 } }), 1)).toBe(PATIENCE_MAX_MS)
  })
})

describe('Played it', () => {
  it('every required pitch freshly pressed releases the gate and advances', () => {
    const d = new Driver()
    d.arrive(0).down(C4)
    expect(d.state).toMatchObject({ groupIndex: 0, acceptedPitches: [C4], missingPitches: [E4], arrived: true })
    d.down(E4)
    expect(d.take()).toEqual([
      { type: 'accepted', group: 0, pitch: C4, notes: [0], time: 1000 },
      { type: 'accepted', group: 0, pitch: E4, notes: [1], time: 1000 },
      { type: 'release', group: 0, reason: 'complete' },
      { type: 'advanced', from: 0, to: 1 },
    ])
    expect(d.state).toMatchObject({ groupIndex: 1, position: quarters(1), acceptedPitches: [], arrived: false })
  })

  it('the last group finishes', () => {
    const d = new Driver(timelineOf(), { startGroup: 4 })
    d.tap(A4)
    expect(d.take()).toEqual([
      expect.objectContaining({ type: 'accepted', group: 4 }),
      { type: 'release', group: 4, reason: 'complete' },
      { type: 'advanced', from: 4, to: null },
      { type: 'finished' },
    ])
    expect(d.state).toMatchObject({ groupIndex: null, position: null, finished: true, targetNotes: [] })
    expect(d.follower.nextDeadline()).toBeNull()
  })

  it('a press before the transport arrives is accepted and completing it releases early', () => {
    const d = new Driver()
    d.tap(C4, E4)
    expect(d.releases()).toEqual([[0, 'complete']])
    // Already on group 1 before the transport reached gate 0: its presses count too.
    d.tap(G4)
    expect(d.releases()).toEqual([
      [0, 'complete'],
      [1, 'complete'],
    ])
    expect(d.of('wrong')).toEqual([])
    // A late arrival at an earlier gate is ignored.
    d.arrive(0).arrive(1)
    expect(d.state).toMatchObject({ groupIndex: 2, arrived: false })
    d.arrive(2)
    expect(d.state.arrived).toBe(true)
  })

  it('a key held before the group became current never satisfies it', () => {
    const t = timelineOf({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: C4 },
      ],
    })
    const d = new Driver(t)
    d.down(C4)
    expect(d.state.groupIndex).toBe(1)
    d.arrive(1).wait(5000)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], heldKeys: [C4] })
    d.up(C4).down(C4)
    expect(d.state.finished).toBe(true)
  })
})

describe('Wrong presses and patience', () => {
  it('a wrong press gives gentle feedback and patience releases the gate', () => {
    const d = new Driver()
    d.arrive(0).down(B4)
    expect(d.take()).toEqual([
      { type: 'wrong', group: 0, pitch: B4, time: 1000, feedbackUntil: 1000 + FOLLOW_WRONG_FEEDBACK_MS },
    ])
    expect(d.state).toMatchObject({ groupHasError: true, heldWrongKeys: [B4], wrongFeedbackUntil: 1300 })
    expect(d.of('key').at(-1)).toEqual({ type: 'key', note: B4, down: true, wrong: true })
    d.up(B4)
    expect(d.state.heldWrongKeys).toEqual([])
    expect(d.follower.nextDeadline()).toBe(1000 + patienceMs(d.follower.timeline, 0))
    d.wait(999)
    expect(d.state.groupIndex).toBe(0)
    d.wait(1)
    expect(d.take()).toEqual([
      { type: 'release', group: 0, reason: 'patience' },
      { type: 'advanced', from: 0, to: 1 },
    ])
    expect(d.state).toMatchObject({ groupIndex: 1, groupHasError: false })
  })

  it('a skipped chord member does not block: patience releases the incomplete group', () => {
    const d = new Driver()
    d.arrive(0).down(C4).wait(1000)
    expect(d.releases()).toEqual([[0, 'patience']])
  })

  it('the deadline runs from the later of the arrival and the first press', () => {
    const d = new Driver()
    d.down(B4)
    expect(d.follower.nextDeadline()).toBeNull()
    d.wait(400).arrive(0)
    expect(d.follower.nextDeadline()).toBe(1400 + 1000)
    const e = new Driver()
    e.arrive(0).wait(5000).down(B4)
    expect(e.follower.nextDeadline()).toBe(6000 + 1000)
    // Later presses do not move it.
    e.wait(500).down(B4)
    expect(e.follower.nextDeadline()).toBe(7000)
  })

  it('no press since the group became current: no deadline, waited for indefinitely', () => {
    const d = new Driver()
    d.arrive(0)
    expect(d.follower.nextDeadline()).toBeNull()
    d.wait(60_000)
    expect(d.state.groupIndex).toBe(0)
    // After a patience release the next group needs its own press.
    d.down(B4).wait(1000).arrive(1)
    expect(d.state.groupIndex).toBe(1)
    expect(d.follower.nextDeadline()).toBeNull()
    d.wait(60_000)
    expect(d.state.groupIndex).toBe(1)
  })
})

describe('Moved on', () => {
  it('a press of the next group releases the current gate and is accepted there', () => {
    const d = new Driver()
    d.arrive(0).down(C4).down(G4)
    expect(d.take()).toEqual([
      expect.objectContaining({ type: 'accepted', group: 0, pitch: C4 }),
      { type: 'release', group: 0, reason: 'skipped' },
      { type: 'advanced', from: 0, to: 1 },
      { type: 'accepted', group: 1, pitch: G4, notes: [3], time: 1000 },
      { type: 'release', group: 1, reason: 'complete' },
      { type: 'advanced', from: 1, to: 2 },
    ])
    expect(d.state.groupIndex).toBe(2)
  })

  it('a press two groups ahead releases every skipped gate in order', () => {
    const d = new Driver()
    d.arrive(0).down(D4)
    expect(d.take()).toEqual([
      { type: 'release', group: 0, reason: 'skipped' },
      { type: 'release', group: 1, reason: 'skipped' },
      { type: 'advanced', from: 0, to: 2 },
      expect.objectContaining({ type: 'accepted', group: 2, pitch: D4 }),
      { type: 'release', group: 2, reason: 'complete' },
      { type: 'advanced', from: 2, to: 3 },
    ])
  })

  it('a pitch of both the previous and a next group is a silent late repeat (lookbehind first)', () => {
    const t = timelineOf({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: D4 },
        { at: 2, midi: C4 },
        { at: 3, midi: E4 },
      ],
    })
    const d = new Driver(t)
    d.tap(C4).arrive(1).tap(C4)
    expect(d.releases()).toEqual([[0, 'complete']])
    expect(d.of('wrong')).toEqual([])
    expect(d.state.groupIndex).toBe(1)
    // A genuine skip is caught one note later by the lookahead.
    d.tap(E4)
    expect(d.releases()).toEqual([
      [0, 'complete'],
      [1, 'skipped'],
      [2, 'skipped'],
      [3, 'complete'],
    ])
    expect(d.state.finished).toBe(true)
  })

  it('three groups ahead is a wrong press', () => {
    const d = new Driver()
    d.down(F4)
    expect(d.of('wrong')).toHaveLength(1)
    expect(d.state.groupIndex).toBe(0)
  })

  it('the target group keeps its incomplete pitches and the moving press starts its patience', () => {
    const t = timelineOf({
      notes: [
        { at: 0, midi: C4 },
        { at: 1, midi: E4 },
        { at: 1, midi: G4 },
        { at: 2, midi: A4 },
      ],
    })
    const d = new Driver(t)
    d.arrive(0).wait(100).down(E4)
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [E4], missingPitches: [G4], arrived: false })
    expect(d.follower.nextDeadline()).toBeNull()
    d.wait(300).arrive(1)
    expect(d.follower.nextDeadline()).toBe(1400 + 1000)
  })
})

describe('Silent presses', () => {
  it('a late press of the previous group is ignored', () => {
    const d = new Driver()
    d.arrive(0).tap(C4, E4).tap(C4)
    expect(d.of('wrong')).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 1, acceptedPitches: [], groupHasError: false })
    // It still counts as a press for patience.
    d.arrive(1)
    expect(d.follower.nextDeadline()).toBe(1000 + 1000)
  })

  it('two groups back is wrong', () => {
    const d = new Driver(timelineOf(), { startGroup: 2 })
    d.down(C4)
    expect(d.of('wrong')).toHaveLength(1)
  })

  it('a replay of an accepted pitch is silent', () => {
    const d = new Driver()
    d.tap(C4, C4)
    expect(d.of('wrong')).toEqual([])
    expect(d.of('accepted')).toHaveLength(1)
    expect(d.state.acceptedPitches).toEqual([C4])
  })

  it('a tie-end press is silent', () => {
    const t = timelineOf({
      notes: [
        { at: 0, dur: 2, midi: E4 },
        { at: 2, midi: E4, cont: true },
        { at: 2, midi: G4 },
        { at: 3, midi: C4 },
      ],
    })
    expect(t.groups[1]!.tiedPitches).toEqual([E4])
    const d = new Driver(t, { startGroup: 1 })
    d.tap(E4)
    expect(d.take()).toEqual([])
    expect(d.state).toMatchObject({ groupIndex: 1, groupHasError: false })
  })
})

describe('Transport arrivals', () => {
  it('an arrival at a later group moves there without releasing anything', () => {
    const d = new Driver()
    d.down(C4).arrive(2)
    expect(d.take()).toEqual([
      expect.objectContaining({ type: 'accepted', group: 0 }),
      { type: 'advanced', from: 0, to: 2 },
    ])
    expect(d.state).toMatchObject({ groupIndex: 2, acceptedPitches: [], arrived: true })
    expect(d.follower.nextDeadline()).toBeNull()
  })

  it('out-of-range and finished arrivals are ignored', () => {
    const d = new Driver()
    d.arrive(9)
    expect(d.state).toMatchObject({ groupIndex: 0, arrived: false })
  })
})

describe('Pause, seek and reconfigure', () => {
  it('paused time never counts toward patience', () => {
    const d = new Driver()
    d.arrive(0).down(B4).wait(400)
    d.follower.pause(d.now)
    expect(d.state.paused).toBe(true)
    expect(d.follower.nextDeadline()).toBeNull()
    d.wait(10_000)
    expect(d.state.groupIndex).toBe(0)
    d.follower.resume(d.now)
    expect(d.follower.nextDeadline()).toBe(d.now + 600)
    d.wait(599)
    expect(d.state.groupIndex).toBe(0)
    d.wait(1)
    expect(d.releases()).toEqual([[0, 'patience']])
  })

  it('an arrival during a pause counts from the resume; presses while paused only move keys', () => {
    const d = new Driver()
    d.follower.pause(d.now)
    d.down(C4, E4)
    expect(d.state).toMatchObject({ groupIndex: 0, acceptedPitches: [], heldKeys: [C4, E4] })
    expect(d.of('accepted')).toEqual([])
    d.up(C4, E4).down(B4).wait(200).arrive(0)
    d.wait(300)
    d.follower.resume(d.now)
    expect(d.state.arrived).toBe(true)
    expect(d.follower.nextDeadline()).toBeNull()
    d.down(B4)
    expect(d.follower.nextDeadline()).toBe(d.now + 1000)
  })

  it('seek makes a new current group with nothing accepted; held keys are kept', () => {
    const d = new Driver()
    d.arrive(0).down(C4).down(B4)
    d.follower.seek(3, d.now)
    expect(d.take().filter((e) => e.type === 'advanced')).toEqual([])
    expect(d.state).toMatchObject({
      groupIndex: 3,
      acceptedPitches: [],
      arrived: false,
      heldKeys: [C4, B4],
      groupHasError: false,
      finished: false,
    })
    expect(d.follower.nextDeadline()).toBeNull()
    d.follower.seek(99, d.now)
    expect(d.state).toMatchObject({ groupIndex: null, finished: true })
    d.follower.seek(0, d.now)
    expect(d.state).toMatchObject({ groupIndex: 0, finished: false })
  })

  it('reconfigure at a new speed keeps the group, its accepted pitches and arrival; patience follows', () => {
    const d = new Driver()
    d.arrive(0).down(C4)
    expect(d.follower.nextDeadline()).toBe(2000)
    d.follower.reconfigure(timelineOf(spec, 'right', 2), d.now)
    expect(d.state).toMatchObject({ groupIndex: 0, acceptedPitches: [C4], arrived: true })
    expect(d.follower.nextDeadline()).toBe(1500)
  })

  it('reconfigure to other hands goes to the group at or after the old position', () => {
    const d = new Driver()
    d.tap(C4, E4).tap(G4)
    expect(d.state.position).toEqual(quarters(2))
    d.follower.reconfigure(timelineOf(spec, 'both'), d.now)
    expect(d.state).toMatchObject({ groupIndex: 2, position: quarters(2) })
    d.follower.reconfigure(timelineOf(spec, 'left'), d.now)
    expect(d.state).toMatchObject({ groupIndex: null, finished: true })
    d.follower.reconfigure(timelineOf(), d.now, 1)
    expect(d.state).toMatchObject({ groupIndex: 1, finished: false })
  })
})

describe('Keys', () => {
  it('CC 123 clears the channel’s held keys; other controllers are ignored', () => {
    const d = new Driver()
    d.down(C4, B4)
    d.follower.input(d.midi.cc(64, 127, d.now))
    expect(d.state.heldKeys).toEqual([C4, B4])
    d.follower.input(d.midi.cc(CC_ALL_NOTES_OFF, 0, d.now))
    d.flush()
    expect(d.state).toMatchObject({ heldKeys: [], heldWrongKeys: [] })
    expect(d.of('key').slice(-2)).toEqual([
      { type: 'key', note: C4, down: false, wrong: false },
      { type: 'key', note: B4, down: false, wrong: true },
    ])
  })

  it('events are consumed once by seq, zero-velocity Note On releases, resetPhysical forgets keys', () => {
    const d = new Driver()
    const ev = d.midi.on(C4, d.now)
    d.follower.input(ev)
    d.follower.input(ev)
    expect(d.of('accepted')).toHaveLength(1)
    d.follower.input(d.midi.on(C4, d.now, 0))
    expect(d.state.heldKeys).toEqual([])
    d.down(E4)
    d.follower.resetPhysical(d.now)
    expect(d.state.heldKeys).toEqual([])
  })

  it('the snapshot is reused until the version changes', () => {
    const d = new Driver()
    const s = d.state
    expect(d.state).toBe(s)
    d.down(C4)
    expect(d.state).not.toBe(s)
    expect(d.state.version).toBeGreaterThan(s.version)
  })
})

describe('Empty timeline', () => {
  it('is finished from the start', () => {
    const empty = timelineOf({ notes: [{ at: 0, midi: C3, hand: 'L' }] }, 'right')
    expect(empty.groups).toEqual([])
    const d = new Driver(empty)
    expect(d.state).toMatchObject({ groupIndex: null, finished: true, position: null })
    d.down(C4).arrive(0).wait(5000)
    expect(d.take()).toEqual([])
    expect(d.follower.nextDeadline()).toBeNull()
  })
})
