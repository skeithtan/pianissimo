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
