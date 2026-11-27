import { expect, it } from 'vitest'
import { buildPerformance, passageRange } from './performance'
import { ManualClock, RecordingBackend, makeModel, r } from './testkit'
import { createTransport } from './transport'

it('an offset automatic attack written before a gate sounds on time while the gate holds', () => {
  const clock = new ManualClock()
  const model = makeModel({
    notes: [
      { at: '0', dur: '1/4', midi: 48, hand: 'L', refOffsetSec: 0 },
      { at: '0', dur: '1/4', midi: 52, hand: 'L', refOffsetSec: 0.05 },
      { at: '0', dur: '1/4', midi: 55, hand: 'L', refOffsetSec: 0.1 },
      { at: '0', dur: '1/4', midi: 60, hand: 'L', refOffsetSec: 0.15 },
      { at: '1/32', dur: '1/32', midi: 72, hand: 'R' },
      { at: '1/32', dur: '1/32', midi: 43, hand: 'L' },
    ],
  })
  const range = passageRange(model, null)
  const backend = new RecordingBackend(clock.clock)
  const t = createTransport({
    clock: clock.clock,
    timers: clock,
    tempo: model.tempo,
    multiplier: 1,
    events: buildPerformance(model, { hands: 'right', sendPedals: false, range }),
    gates: [r('1/32')],
    range,
    backend,
  })
  t.play()
  clock.advance(2000)
  expect(t.holdingGate).toBe(0)
  const ons = backend.ons()
  expect(ons.map((c) => c.note)).toEqual([48, 52, 55, 60])
  expect(ons.map((c) => c.time)).toEqual([0, 50, 100, 150])
  // Releasing the gate plays what is written there, once.
  t.releaseGate(0)
  clock.advance(10)
  expect(backend.ons().map((c) => c.note)).toEqual([48, 52, 55, 60, 43])
})

it('pause right after a seek inside offset attacks forgets an attack the cleanup canceled', () => {
  const clock = new ManualClock()
  const model = makeModel({
    notes: [
      { at: '0', dur: '1/4', midi: 48, hand: 'L', refOffsetSec: 0 },
      { at: '0', dur: '1/4', midi: 52, hand: 'L', refOffsetSec: 0.1 },
      { at: '0', dur: '1/4', midi: 55, hand: 'L', refOffsetSec: 0.15 },
      { at: '1/32', dur: '1/32', midi: 72, hand: 'R' },
    ],
  })
  const range = passageRange(model, null)
  const backend = new RecordingBackend(clock.clock)
  const t = createTransport({
    clock: clock.clock,
    timers: clock,
    tempo: model.tempo,
    multiplier: 1,
    events: buildPerformance(model, { hands: 'none', sendPedals: false, range }),
    gates: null,
    range,
    backend,
  })
  t.seek(r('1/64'))
  clock.advance(1000)
  t.play()
  expect(backend.ons().map((c) => c.note)).toEqual([72])
  clock.advance(10)
  t.pause()
  clock.advance(1000)
  t.play()
  clock.advance(1000)
  expect(backend.ons().map((c) => c.note)).toEqual([72, 72])
})

it('hidden tab does not treat 1 s background timer wakes as stalls and schedules note-offs ahead', () => {
  const clock = new ManualClock()
  const model = makeModel({
    notes: [
      { at: '0', dur: '1/4', midi: 60, hand: 'R' },
      { at: '1/4', dur: '1/4', midi: 62, hand: 'R' },
    ],
  })
  const range = passageRange(model, null)
  const backend = new RecordingBackend(clock.clock)
  const t = createTransport({
    clock: clock.clock,
    timers: clock,
    tempo: model.tempo,
    multiplier: 1,
    events: buildPerformance(model, { hands: 'none', sendPedals: false, range }),
    gates: null,
    range,
    backend,
    isHidden: () => true,
  })
  t.play()
  // Note 60 [0, 1000 ms] and note 62's attack [1000 ms] are within the 1200 ms hidden lookahead.
  expect(backend.ons().map((c) => c.note)).toEqual([60, 62])
  expect(backend.offs().map((c) => c.note)).toEqual([60])
  // Simulate a 1 s browser-throttled background timer wake (exceeds visible 250 ms stallMs).
  clock.now = 1000
  clock.advance(0)
  expect(t.shiftMs).toBe(0)
  expect(backend.offs().map((c) => c.note)).toEqual([60, 62])
})

it('isolates throwing observer callbacks so pending note-offs still fire and scheduling continues', () => {
  const clock = new ManualClock()
  const model = makeModel({
    notes: [{ at: '0', dur: '1/4', midi: 60, hand: 'R' }],
  })
  const range = passageRange(model, null)
  const backend = new RecordingBackend(clock.clock)
  let threw = false
  const t = createTransport({
    clock: clock.clock,
    timers: clock,
    tempo: model.tempo,
    multiplier: 1,
    events: buildPerformance(model, { hands: 'none', sendPedals: false, range }),
    gates: null,
    range,
    backend,
    onEmit: () => {
      if (!threw) {
        threw = true
        throw new Error('observer boom')
      }
    },
  })
  t.play()
  clock.advance(4500)
  expect(backend.ons().map((c) => c.note)).toEqual([60])
  expect(backend.offs().map((c) => c.note)).toEqual([60])
  expect(t.state).toBe('ended')
})
