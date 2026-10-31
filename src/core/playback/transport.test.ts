import { describe, expect, it } from 'vitest'
import { type Rational, rat } from '../music/rational'
import type { HandSelection } from '../model/score'
import { buildClickTrack } from './clicks'
import { buildPerformance, passageRange } from './performance'
import { ManualClock, type ModelSpec, type NoteSpec, RecordingBackend, makeModel, r } from './testkit'
import { type TransportOptions, createTransport } from './transport'
import {
  type ClickEvent,
  type ControlEvent,
  type MetronomeSink,
  type NoteOffEvent,
  type NoteOnEvent,
  OutputLostError,
  type PerformanceRange,
} from './types'

type Emitted = {
  readonly ev: NoteOnEvent | NoteOffEvent | ControlEvent | ClickEvent
  readonly time: number
  readonly at: number
}

interface SetupOptions {
  readonly notes: readonly NoteSpec[]
  readonly model?: Omit<ModelSpec, 'notes'>
  readonly hands?: HandSelection
  readonly gates?: readonly string[]
  readonly range?: PerformanceRange
  readonly multiplier?: number
  readonly metronome?: boolean
  readonly transport?: Partial<TransportOptions>
}

class ClickRecorder implements MetronomeSink {
  readonly clicks: Array<{ time: number; accent: boolean }> = []
  readonly cancels: number[] = []
  click(time: number, accent: boolean): void {
    this.clicks.push({ time, accent })
  }
  cancel(now: number): void {
    this.cancels.push(now)
  }
}

/** Quarter = 60 by default: a quarter note lasts 1000 ms at 1×, a 4/4 bar 4000 ms. */
function setup(o: SetupOptions) {
  const clock = new ManualClock()
  const model = makeModel({ notes: o.notes, ...o.model })
  const backend = new RecordingBackend(clock.clock)
  const range = o.range ?? passageRange(model, null)
  const reached: number[] = []
  const emitted: Emitted[] = []
  const interrupted: string[] = []
  const metronome = new ClickRecorder()
  let ended = 0
  const t = createTransport({
    clock: clock.clock,
    timers: clock,
    tempo: model.tempo,
    multiplier: o.multiplier ?? 1,
    events: buildPerformance(model, { hands: o.hands ?? 'none', sendPedals: true, range }),
    gates: o.gates ? o.gates.map(r) : null,
    range,
    backend,
    ...(o.metronome ? { metronome: { sink: metronome, clicks: buildClickTrack(model, range) } } : {}),
    onGateReached: (g) => reached.push(g),
    onRangeEnd: () => ended++,
    onInterrupted: (cause) => interrupted.push(cause),
    onEmit: (ev, time) => emitted.push({ ev, time, at: clock.now }),
    ...o.transport,
  })
  return { clock, model, backend, t, reached, emitted, interrupted, metronome, ended: () => ended }
}

const quarters = (midis: readonly number[], hand: 'L' | 'R' = 'L', start = 0): NoteSpec[] =>
  midis.map((midi, i) => ({ at: rat(start + i, 4), dur: '1/4', midi, hand }))

const onsOf = (em: readonly Emitted[]) => em.filter((e): e is Emitted & { ev: NoteOnEvent } => e.ev.kind === 'on')
const offsOf = (em: readonly Emitted[]) => em.filter((e): e is Emitted & { ev: NoteOffEvent } => e.ev.kind === 'off')

/** Every voice attacked exactly once and released exactly once, release after attack. */
function expectBalanced(em: readonly Emitted[]): void {
  const on = new Map<number, number>()
  const off = new Map<number, number>()
  for (const e of em) {
    if (e.ev.kind === 'on') {
      expect(on.has(e.ev.voice), `duplicate attack of voice ${e.ev.voice}`).toBe(false)
      on.set(e.ev.voice, e.time)
    } else if (e.ev.kind === 'off') {
      expect(off.has(e.ev.voice), `duplicate release of voice ${e.ev.voice}`).toBe(false)
      off.set(e.ev.voice, e.time)
    }
  }
  expect([...off.keys()].sort()).toEqual([...on.keys()].sort())
  for (const [v, t] of on) expect(off.get(v)!).toBeGreaterThan(t)
}

describe('transport: Preview playback (spec "Physical-piano Preview")', () => {
  it('hands attacks out within the lookahead at their exact times and releases when due', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(10_000)
    const ons = onsOf(s.emitted)
    expect(ons.map((e) => e.time)).toEqual([0, 1000, 2000, 3000])
    for (const e of ons) {
      expect(e.at).toBeLessThanOrEqual(e.time)
      expect(e.at).toBeGreaterThanOrEqual(e.time - 100)
    }
    const offs = offsOf(s.emitted)
    expect(offs.map((e) => e.time)).toEqual([1000, 2000, 3000, 4000])
    for (const e of offs) expect(e.at).toBe(e.time)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [48, 0],
      [50, 1000],
      [52, 2000],
      [53, 3000],
    ])
    expectBalanced(s.emitted)
  })

  it('calls onRangeEnd once at the range end, then play() restarts from the range start', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(3999)
    expect(s.ended()).toBe(0)
    s.clock.advanceTo(4000)
    expect(s.ended()).toBe(1)
    expect(s.t.state).toBe('ended')
    expect(s.t.positionNow()).toBe(1)
    expect(s.clock.pendingTimers).toBe(0)
    s.t.play()
    expect(s.t.positionNow()).toBe(0)
    s.clock.advanceTo(9000)
    expect(s.ended()).toBe(2)
    expect(onsOf(s.emitted)).toHaveLength(8)
  })

  it('reports a moving cursor position that never passes the end', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(1500)
    expect(s.t.positionNow()).toBeCloseTo(0.375)
    s.clock.advanceTo(4500)
    expect(s.t.positionNow()).toBe(1)
  })

  it('applies the multiplier to note times, reference offsets and the cursor', () => {
    const s = setup({
      notes: [
        { at: '0', dur: '1/4', midi: 48, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 50, hand: 'L', refOffsetSec: 0.05 },
      ],
      multiplier: 2,
    })
    s.t.play()
    s.clock.advanceTo(1000)
    expect(onsOf(s.emitted).map((e) => e.time)).toEqual([0, 525])
    expect(offsOf(s.emitted).map((e) => e.time)).toEqual([500, 1000])
  })
})

describe('transport: learner gates (spec "Accompaniment waiting")', () => {
  const accompaniment = (): SetupOptions => ({
    notes: [
      ...quarters([48, 50, 52, 53]),
      { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
      { at: '3/4', dur: '1/4', midi: 74, hand: 'R' },
    ],
    hands: 'right',
    gates: ['1/4', '3/4'],
  })

  it('holds the gate position back until release, then plays it at once without a burst or replay', () => {
    const s = setup(accompaniment())
    s.t.play()
    s.clock.advanceTo(999)
    expect(s.reached).toEqual([])
    // The automatic note written at the learner's onset waits for the learner, even inside the lookahead.
    expect(onsOf(s.emitted).map((e) => e.ev.note)).toEqual([48])
    s.clock.advanceTo(1000)
    expect(s.reached).toEqual([0])
    expect(s.t.holdingGate).toBe(0)

    s.clock.advanceTo(5000)
    expect(onsOf(s.emitted).map((e) => e.ev.note)).toEqual([48])
    expect(s.t.positionNow()).toBe(0.25)
    // The note sounding before the gate still ends on schedule while the transport waits.
    expect(offsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([[48, 1000]])

    s.t.releaseGate(0)
    // Due now: handed out inside the release call, at the release time.
    expect(onsOf(s.emitted).at(-1)).toMatchObject({ ev: { note: 50 }, time: 5000, at: 5000 })
    const before = s.emitted.length
    s.clock.advanceTo(5899)
    expect(s.emitted.length).toBe(before)
    s.clock.advanceTo(5900)
    expect(onsOf(s.emitted).at(-1)!.ev.note).toBe(52)
    expect(onsOf(s.emitted).at(-1)!.time).toBe(6000)

    s.clock.advanceTo(7000)
    expect(s.reached).toEqual([0, 1])
    expect(s.t.holdingGate).toBe(1)
    s.clock.advanceTo(7500)
    s.t.releaseGate(1)
    s.clock.advanceTo(20_000)
    expect(s.ended()).toBe(1)
    expect(onsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([
      [48, 0],
      [50, 5000],
      [52, 6000],
      [53, 7500],
    ])
    expect(offsOf(s.emitted).at(-1)!.time).toBe(8500)
    expectBalanced(s.emitted)
  })

  it('a chord at the gate sounds when the learner releases it 400 ms after arrival, not at arrival', () => {
    const s = setup({
      notes: [
        { at: '0', dur: '1/4', midi: 43, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
        { at: '1/4', dur: '1/4', midi: 48, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 52, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 55, hand: 'L' },
      ],
      hands: 'right',
      gates: ['1/4'],
    })
    s.t.play()
    s.clock.advanceTo(1000)
    expect(s.reached).toEqual([0])
    expect(onsOf(s.emitted).map((e) => e.ev.note)).toEqual([43])
    s.clock.advanceTo(1400)
    expect(onsOf(s.emitted).map((e) => e.ev.note)).toEqual([43])
    expect(s.t.msUntilGate(0, 1400)).toBe(0)
    s.t.releaseGate(0)
    expect(onsOf(s.emitted).map((e) => [e.ev.note, e.time, e.at])).toEqual([
      [43, 0, 0],
      [48, 1400, 1400],
      [52, 1400, 1400],
      [55, 1400, 1400],
    ])
    expect(s.t.positionNow()).toBe(0.25)
    s.clock.advanceTo(1900)
    expect(s.t.positionNow()).toBeCloseTo(0.375)
    s.clock.advanceTo(10_000)
    expect(offsOf(s.emitted).map((e) => e.time)).toEqual([1000, 2400, 2400, 2400])
    expectBalanced(s.emitted)
  })

  it('fast-forwards to a gate released before musical time reaches it', () => {
    const s = setup({
      notes: [
        { at: '0', dur: '1/4', midi: 43, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
        { at: '1/4', dur: '1/8', midi: 48, hand: 'L' },
        // 50 ms after the gate (a whole note lasts 4000 ms).
        { at: '21/80', dur: '1/80', midi: 55, hand: 'L' },
        { at: '1/2', dur: '1/4', midi: 74, hand: 'R' },
      ],
      hands: 'right',
      gates: ['1/4', '1/2'],
    })
    s.t.play()
    s.clock.advanceTo(900)
    expect(s.t.msUntilGate(0, 900)).toBe(100)
    expect(s.reached).toEqual([])
    s.t.releaseGate(0)
    expect(s.reached).toEqual([0])
    expect(s.t.holdingGate).toBeNull()
    expect(s.t.positionNow()).toBe(0.25)
    expect(s.t.msUntilGate(0, 900)).toBe(0)
    expect(s.t.msUntilGate(1, 900)).toBe(1000)
    expect(onsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([
      [43, 0],
      [48, 900],
      [55, 950],
    ])
    // The note sounding before the gate is released at the jump.
    expect(offsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([[43, 900]])
    s.clock.advanceTo(1900)
    expect(s.reached).toEqual([0, 1])
    expect(s.t.holdingGate).toBe(1)
    // Reported exactly once.
    s.clock.advanceTo(5000)
    expect(s.reached).toEqual([0, 1])
    expectBalanced(s.emitted)
  })

  it('a fast-forward never hands an attack out before one already scheduled', () => {
    const s = setup({
      notes: [
        { at: '0', dur: '1/4', midi: 43, hand: 'L' },
        { at: '15/64', dur: '1/64', midi: 45, hand: 'L' },
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
        { at: '1/4', dur: '1/4', midi: 48, hand: 'L' },
      ],
      hands: 'right',
      gates: ['1/4'],
    })
    s.t.play()
    // 45 (at 937.5 ms) went out with the lookahead before the early release.
    s.clock.advanceTo(900)
    expect(onsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([
      [43, 0],
      [45, 937.5],
    ])
    s.t.releaseGate(0)
    expect(s.t.positionNow()).toBe(0.25)
    expect(onsOf(s.emitted).map((e) => [e.ev.note, e.time])).toEqual([
      [43, 0],
      [45, 937.5],
      [48, 937.5],
    ])
  })

  it('continues seamlessly when the gate is released from inside onGateReached', () => {
    const s = setup({ ...accompaniment(), transport: {} })
    const t2 = createTransport({
      clock: s.clock.clock,
      timers: s.clock,
      tempo: s.model.tempo,
      multiplier: 1,
      events: buildPerformance(s.model, { hands: 'right', sendPedals: false }),
      gates: [r('1/4'), r('3/4')],
      range: passageRange(s.model, null),
      backend: s.backend,
      onGateReached: (g) => t2.releaseGate(g),
    })
    t2.play()
    s.clock.advanceTo(5000)
    expect(s.backend.ons().map((c) => c.time)).toEqual([0, 1000, 2000, 3000])
    expect(t2.state).toBe('ended')
  })

  it('never queues a later written position beyond an unreleased gate, even inside the lookahead', () => {
    const s = setup({
      notes: [
        { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
        { at: '17/64', dur: '1/64', midi: 50, hand: 'L' },
      ],
      hands: 'right',
      gates: ['1/4'],
    })
    s.t.play()
    s.clock.advanceTo(990)
    expect(s.backend.ons()).toEqual([])
    s.clock.advanceTo(10_000)
    expect(s.backend.ons()).toEqual([])
    expect(s.t.holdingGate).toBe(0)
    s.t.releaseGate(0)
    s.clock.advanceTo(20_000)
    expect(s.backend.ons().map((c) => c.time)).toEqual([10_062.5])
  })

  it('plays automatic roll members at the gate position from the release, keeping their reference offsets', () => {
    const notes: NoteSpec[] = [
      { at: '1/4', dur: '1/4', midi: 72, hand: 'R' },
      { at: '1/4', dur: '1/4', midi: 45, hand: 'L', refOffsetSec: 0 },
      { at: '1/4', dur: '1/4', midi: 52, hand: 'L', refOffsetSec: 0.05 },
      { at: '1/4', dur: '1/4', midi: 60, hand: 'L', refOffsetSec: 0.15 },
    ]
    const s = setup({ notes, hands: 'right', gates: ['1/4'] })
    s.t.play()
    s.clock.advanceTo(10_000)
    expect(s.t.holdingGate).toBe(0)
    expect(s.backend.ons()).toEqual([])
    s.t.releaseGate(0)
    s.clock.advanceTo(11_000)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [45, 10_000],
      [52, 10_050],
      [60, 10_150],
    ])
    const slow = setup({ notes, hands: 'right', gates: ['1/4'], multiplier: 0.5 })
    slow.t.play()
    slow.clock.advanceTo(10_000)
    slow.t.releaseGate(0)
    slow.clock.advanceTo(11_000)
    expect(slow.backend.ons().map((c) => c.time)).toEqual([10_000, 10_100, 10_300])
  })

  it('holds immediately at a gate on the range start; the start position waits for the learner', () => {
    const s = setup({
      notes: [{ at: '0', dur: '1/4', midi: 72, hand: 'R' }, ...quarters([48, 50])],
      hands: 'right',
      gates: ['0'],
    })
    s.t.play()
    expect(s.reached).toEqual([0])
    expect(s.backend.ons()).toEqual([])
    s.clock.advanceTo(3000)
    expect(s.backend.ons()).toEqual([])
    s.t.releaseGate(0)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([[48, 3000]])
    s.clock.advanceTo(10_000)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [48, 3000],
      [50, 4000],
    ])
  })

  it('treats gates before a seek position as passed and forgets early releases at or after it', () => {
    const s = setup(accompaniment())
    s.t.releaseGate(1)
    s.t.seek(r('1/2'))
    expect(s.t.state).toBe('paused')
    s.t.play()
    s.clock.advanceTo(5000)
    expect(s.reached).toEqual([1])
    expect(s.t.holdingGate).toBe(1)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([[52, 0]])
  })

  it('keeps holding across pause and resume without replaying the gate position', () => {
    const s = setup(accompaniment())
    s.t.play()
    s.clock.advanceTo(1500)
    s.t.pause()
    expect(s.t.positionNow()).toBe(0.25)
    s.clock.advanceTo(3000)
    s.t.play()
    s.clock.advanceTo(4000)
    expect(s.reached).toEqual([0])
    expect(s.backend.ons().map((c) => c.note)).toEqual([48])
    s.t.releaseGate(0)
    s.clock.advanceTo(5000)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [48, 0],
      [50, 4000],
      [52, 5000],
    ])
  })

  it('blocks metronome clicks at and beyond a held gate (the metronome follows the transport)', () => {
    const s = setup({ ...accompaniment(), metronome: true })
    s.t.play()
    s.clock.advanceTo(5000)
    expect(s.metronome.clicks.map((c) => c.time)).toEqual([0])
    expect(s.metronome.clicks[0]!.accent).toBe(true)
    s.t.releaseGate(0)
    s.clock.advanceTo(6000)
    expect(s.metronome.clicks.map((c) => c.time)).toEqual([0, 5000, 6000])
  })
})

describe('transport: pause, stop, seek and cleanup (spec "MIDI output recovery")', () => {
  it('pause cleans up output and resume re-sends only what had not sounded yet', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(1950)
    expect(s.backend.ons().map((c) => c.note)).toEqual([48, 50, 52])
    s.t.pause()
    expect(s.backend.calls.at(-1)).toMatchObject({ op: 'cleanup', time: 1950 })
    expect(s.t.state).toBe('paused')
    expect(s.t.positionNow()).toBeCloseTo(0.4875)
    expect(s.clock.pendingTimers).toBe(0)
    s.clock.advanceTo(5000)
    s.t.play()
    s.clock.advanceTo(20_000)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [48, 0],
      [50, 1000],
      [52, 2000],
      [52, 5050],
      [53, 6050],
    ])
    // The note sounding at the pause was released by cleanup, not re-released after resume.
    expect(s.backend.offs().map((c) => c.note)).toEqual([48, 52, 53])
  })

  it('stop cleans up, returns to the range start and resets gates', () => {
    const s = setup({
      notes: [...quarters([48, 50, 52, 53]), { at: '1/4', dur: '1/4', midi: 72, hand: 'R' }],
      hands: 'right',
      gates: ['1/4'],
    })
    s.t.play()
    s.clock.advanceTo(1500)
    s.t.stop()
    expect(s.backend.calls.at(-1)?.op).toBe('cleanup')
    expect(s.t.state).toBe('stopped')
    expect(s.t.positionNow()).toBe(0)
    s.t.play()
    s.clock.advanceTo(2600)
    expect(s.reached).toEqual([0, 0])
    expect(s.t.holdingGate).toBe(0)
  })

  it('seek while playing cleans up and continues from the new position at once', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53, 55, 57, 59, 60]) })
    s.t.play()
    s.clock.advanceTo(1500)
    s.t.seek(r('3/2'))
    expect(s.backend.calls.filter((c) => c.op === 'cleanup')).toHaveLength(1)
    s.clock.advanceTo(3499)
    expect(s.t.state).toBe('playing')
    s.clock.advanceTo(3500)
    expect(s.backend.ons().map((c) => [c.note, c.time])).toEqual([
      [48, 0],
      [50, 1000],
      [59, 1500],
      [60, 2500],
    ])
    expect(s.t.state).toBe('ended')
  })

  it('stopSound pauses and runs the backend recovery', () => {
    const s = setup({ notes: quarters([48, 50]) })
    s.t.play()
    s.clock.advanceTo(500)
    s.t.stopSound()
    expect(s.backend.calls.at(-1)?.op).toBe('stopSound')
    expect(s.t.state).toBe('paused')
  })

  it('a lost destination stops scheduling, reports a disconnect and resumes later without replay', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(1500)
    s.backend.failWith = new OutputLostError()
    s.clock.advanceTo(3000)
    expect(s.interrupted).toEqual(['disconnect'])
    expect(s.t.state).toBe('interrupted')
    expect(s.clock.pendingTimers).toBe(0)
    const frozen = s.t.positionNow()
    expect(frozen).toBeCloseTo(0.5, 1)
    s.backend.failWith = null
    s.t.play()
    s.clock.advanceTo(20_000)
    expect(s.backend.ons().map((c) => c.note)).toEqual([48, 50, 52, 53])
  })

  it('interrupt() stops scheduling without output cleanup', () => {
    const s = setup({ notes: quarters([48, 50]) })
    s.t.play()
    s.clock.advanceTo(500)
    s.t.interrupt()
    expect(s.t.state).toBe('interrupted')
    expect(s.backend.calls.some((c) => c.op === 'cleanup')).toBe(false)
    s.clock.advanceTo(5000)
    expect(s.backend.ons()).toHaveLength(1)
  })

  it('recovers from a stalled timer by resuming musical time instead of bursting', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]) })
    s.t.play()
    s.clock.advanceTo(500)
    s.clock.now = 2500
    s.clock.advance(0)
    expect(s.backend.ons()).toHaveLength(1)
    s.clock.advanceTo(4000)
    const second = s.backend.ons()[1]!
    expect(second.time).toBeGreaterThanOrEqual(2500)
    expect(second.at).toBeLessThanOrEqual(second.time)
  })
})

describe('transport: live tempo changes (spec "Tempo changes during use")', () => {
  const run = (multiplier: number) => {
    const notes: NoteSpec[] = []
    for (let i = 0; i < 16; i++) notes.push({ at: rat(i, 8), dur: '1/8', midi: 60 + (i % 3), hand: 'R' })
    notes.push({ at: '0', dur: '1', midi: 48, hand: 'L' }, { at: '1/2', dur: '1/2', midi: 48, hand: 'L', voice: '6' })
    notes.push({ at: '1', dur: '1', midi: 43, hand: 'L' })
    const s = setup({
      notes,
      model: {
        pedals: [
          { at: '0', type: 'start' },
          { at: '1', type: 'change' },
          { at: '2', type: 'stop' },
        ],
      },
    })
    const cursor: number[] = []
    s.t.play()
    for (let t = 0; t < 30_000; t += 10) {
      if (t === 2950) s.t.setMultiplier(multiplier)
      if (t === 5020) s.t.setMultiplier(1)
      s.clock.advanceTo(t)
      cursor.push(s.t.positionNow())
    }
    return { s, cursor }
  }

  for (const m of [2, 0.5]) {
    it(`×${m}: reschedules without skipped, duplicated or stuck notes and keeps order`, () => {
      const { s, cursor } = run(m)
      expect(s.ended()).toBe(1)
      expectBalanced(s.emitted)
      expect(onsOf(s.emitted)).toHaveLength(19)
      // Attacks and pedals go out ahead in time order; MIDI releases go out when due, in order.
      for (const part of [s.emitted.filter((e) => e.ev.kind !== 'off'), offsOf(s.emitted)]) {
        const times = part.map((e) => e.time)
        for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
      }
      for (let i = 1; i < cursor.length; i++) expect(cursor[i]!).toBeGreaterThanOrEqual(cursor[i - 1]! - 1e-12)
      const sounding = new Map<number, number>()
      for (const c of s.backend.calls) {
        if (c.op === 'on') sounding.set(c.note, (sounding.get(c.note) ?? 0) + 1)
        if (c.op === 'off') sounding.set(c.note, (sounding.get(c.note) ?? 0) - 1)
      }
      for (const v of sounding.values()) expect(v).toBe(0)
      const pedal = s.backend.ccs()
      expect(pedal.at(-1)).toMatchObject({ controller: 64, value: 0 })
      // Eighth-note spacing right after the change reflects the new speed.
      const ons = onsOf(s.emitted).filter((e) => e.ev.hand === 'R')
      const gaps = ons.slice(1).map((e, i) => e.time - ons[i]!.time)
      expect(gaps).toContain(500 / m)
      expect(gaps.every((g) => g >= Math.min(500, 500 / m) - 1e-9 && g <= Math.max(500, 500 / m) + 1e-9)).toBe(true)
    })
  }

  it('hands a browser-style backend every event in time order across tempo changes', () => {
    const notes: NoteSpec[] = []
    for (let i = 0; i < 16; i++) notes.push({ at: rat(i, 8), dur: rat(3, 16), midi: 60 + (i % 4), hand: 'R' })
    const s = setup({ notes, transport: { offLookaheadMs: 100 } })
    s.t.play()
    for (let t = 0; t < 20_000; t += 10) {
      if (t === 1960) s.t.setMultiplier(2)
      if (t === 3020) s.t.setMultiplier(0.5)
      s.clock.advanceTo(t)
    }
    expect(s.ended()).toBe(1)
    expectBalanced(s.emitted)
    const times = s.emitted.map((e) => e.time)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
  })

  it('rejects invalid multipliers', () => {
    const s = setup({ notes: quarters([48]) })
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => s.t.setMultiplier(bad)).toThrow(RangeError)
  })
})

describe('transport: metronome', () => {
  it('clicks the beats with an accent on the first beat, and stops when disabled', () => {
    const s = setup({ notes: quarters([48, 50, 52, 53]), metronome: true })
    s.t.play()
    s.clock.advanceTo(1500)
    expect(s.metronome.clicks).toEqual([
      { time: 0, accent: true },
      { time: 1000, accent: false },
    ])
    s.t.setMetronomeEnabled(false)
    expect(s.metronome.cancels).toEqual([1500])
    s.clock.advanceTo(5000)
    expect(s.metronome.clicks).toHaveLength(2)
  })

  it('a click-only transport anchors at the first key press time', () => {
    const clock = new ManualClock()
    const model = makeModel({ notes: quarters([48]) })
    const sink = new ClickRecorder()
    const range = passageRange(model, null)
    const t = createTransport({
      clock: clock.clock,
      timers: clock,
      tempo: model.tempo,
      multiplier: 1,
      events: [],
      gates: null,
      range,
      backend: null,
      metronome: { sink, clicks: buildClickTrack(model, range) },
    })
    clock.advanceTo(1000)
    t.play(990)
    clock.advanceTo(5000)
    expect(sink.clicks.map((c) => c.time)).toEqual([1000, 1990, 2990, 3990])
  })
})

describe('transport: msUntilGate / msUntilPosition (engine early-press grace)', () => {
  const learner = (positions: readonly string[]): NoteSpec[] =>
    positions.map((at) => ({ at, dur: '1/8', midi: 72, hand: 'R' as const }))

  it('constant tempo: time from a possibly past event timestamp until the gate', () => {
    const s = setup({ notes: learner(['1/4', '1/2']), hands: 'right', gates: ['1/4', '1/2'] })
    s.t.play()
    expect(s.t.msUntilGate(0, 0)).toBe(1000)
    s.clock.advanceTo(500)
    expect(s.t.msUntilGate(0, 480)).toBe(520)
    expect(s.t.msUntilGate(0, 500)).toBe(500)
    expect(s.t.msUntilPosition(r('3/16'), 450)).toBe(300)
    expect(s.t.msUntilPosition(r('1/8'), 450)).toBe(0)
    expect(s.t.msUntilPosition(r('1/16'), 450)).toBe(0)
    // Gate 1 lies behind the unreleased gate 0.
    expect(s.t.msUntilGate(1, 500)).toBeNull()
    expect(s.t.msUntilPosition(r('3/8'), 500)).toBeNull()
    // An early release fast-forwards: gate 0 is now, gate 1 a quarter later.
    s.t.releaseGate(0)
    expect(s.t.msUntilGate(0, 500)).toBe(0)
    expect(s.t.msUntilGate(1, 500)).toBe(1000)
    expect(s.t.msUntilGate(5, 500)).toBeNull()
  })

  it('is exact across a tempo change in the map', () => {
    const tempo = {
      segments: [
        { start: rat(0), quarterBpm: 60, beatUnit: rat(1, 4), beatBpm: 60, source: 'sound' as const },
        { start: rat(1, 4), quarterBpm: 120, beatUnit: rat(1, 4), beatBpm: 120, source: 'sound' as const },
      ],
    }
    const s = setup({ notes: learner(['1/2']), hands: 'right', gates: ['1/2'], model: { tempo } })
    s.t.play()
    s.clock.advanceTo(200)
    expect(s.t.msUntilGate(0, 200)).toBe(1300)
    expect(s.t.msUntilPosition(r('3/8'), 190)).toBe(1060)
  })

  it('follows a live multiplier change', () => {
    const s = setup({ notes: learner(['1/4']), hands: 'right', gates: ['1/4'] })
    s.t.play()
    s.clock.advanceTo(500)
    s.t.setMultiplier(2)
    expect(s.t.msUntilGate(0, 500)).toBe(250)
    expect(s.t.msUntilGate(0, 490)).toBe(260)
    s.clock.advanceTo(600)
    s.t.setMultiplier(0.5)
    expect(s.t.msUntilGate(0, 600)).toBe(600)
  })

  it('is 0 once arrived, holding or passed, and null while held at an earlier gate', () => {
    const s = setup({ notes: learner(['1/4', '1/2']), hands: 'right', gates: ['1/4', '1/2'] })
    s.t.play()
    s.clock.advanceTo(1000)
    expect(s.t.holdingGate).toBe(0)
    expect(s.t.msUntilGate(0, 990)).toBe(0)
    expect(s.t.msUntilGate(1, 1000)).toBeNull()
    s.clock.advanceTo(3000)
    s.t.releaseGate(0)
    expect(s.t.msUntilGate(1, 3000)).toBe(1000)
    expect(s.t.msUntilPosition(r('1/4'), 3000)).toBe(0)
    s.clock.advanceTo(4000)
    expect(s.t.msUntilGate(1, 4000)).toBe(0)
    s.t.releaseGate(1)
    s.clock.advanceTo(4500)
    expect(s.t.msUntilGate(0, 4500)).toBe(0)
    expect(s.t.msUntilGate(1, 4500)).toBe(0)
  })

  it('is null while paused or stopped for gates not yet reached', () => {
    const s = setup({ notes: learner(['1/4', '1/2']), hands: 'right', gates: ['1/4', '1/2'] })
    expect(s.t.msUntilGate(0, 0)).toBeNull()
    s.t.play()
    s.clock.advanceTo(1000)
    s.t.releaseGate(0)
    s.clock.advanceTo(1500)
    s.t.pause()
    expect(s.t.msUntilGate(1, 1500)).toBeNull()
    expect(s.t.msUntilGate(0, 1500)).toBe(0)
    expect(s.t.msUntilPosition(r('1/2'), 1500)).toBeNull()
    s.t.stop()
    expect(s.t.msUntilGate(0, 1500)).toBeNull()
  })
})

describe('transport: validation', () => {
  const model = makeModel({ notes: quarters([48, 50]) })
  const base = (over: Partial<TransportOptions>): TransportOptions => ({
    clock: () => 0,
    timers: new ManualClock(),
    tempo: model.tempo,
    multiplier: 1,
    events: buildPerformance(model, { hands: 'none', sendPedals: false }),
    gates: null,
    range: passageRange(model, null),
    backend: null,
    ...over,
  })
  const g = (...xs: string[]): Rational[] => xs.map(r)

  it('rejects unordered gates, gates at the end, unpaired notes and bad multipliers', () => {
    expect(() => createTransport(base({ gates: g('1/2', '1/4') }))).toThrow(RangeError)
    expect(() => createTransport(base({ gates: g('1') }))).toThrow(RangeError)
    expect(() => createTransport(base({ multiplier: 0 }))).toThrow(RangeError)
    const evs = buildPerformance(model, { hands: 'none', sendPedals: false }).filter((e) => e.kind !== 'off')
    expect(() => createTransport(base({ events: evs }))).toThrow(/without note-off/)
  })
})
