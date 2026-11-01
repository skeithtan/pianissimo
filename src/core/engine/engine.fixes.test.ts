import { expect, it } from 'vitest'
import { CC_SUSTAIN } from '../midi/types'
import { EngineDriver, buildScore } from './testkit'
import { buildTimeline } from './timeline'

it('a pedal change within the grace still counts when the next group completes first (E17)', () => {
  const m = buildScore({
    notes: [
      { at: 0, midi: 60, dur: 0.25 },
      { at: 0.25, midi: 62, dur: 0.25 },
      { at: 1, midi: 64 },
    ],
    pedals: [{ at: 0, type: 'start' }],
  })
  const t = buildTimeline(m, { hands: 'right', range: null, multiplier: 1 })
  const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
  d.tap(60)
  d.now += 60
  d.tap(62)
  d.now += 40
  d.cc(CC_SUSTAIN, 127)
  d.now += 500
  d.tap(64)
  expect(d.records()[0]!.groups!.map((g) => g.pedal)).toEqual(['ok', 'ok', 'ok'])
})

it('a pedal change after one watched group expired revises only the groups still in their grace', () => {
  const m = buildScore({
    notes: [
      { at: 0, midi: 60, dur: 0.25 },
      { at: 0.25, midi: 62, dur: 0.25 },
      { at: 1, midi: 64 },
    ],
    pedals: [{ at: 0, type: 'start' }],
  })
  const t = buildTimeline(m, { hands: 'right', range: null, multiplier: 1 })
  const d = new EngineDriver(t, { mode: 'scored', pieceId: 'p', prepared: true, transport: 'free' })
  d.tap(60)
  d.now += 120
  d.tap(62)
  d.now += 100 // 220 ms after the first completion, 100 ms after the second
  d.cc(CC_SUSTAIN, 127)
  d.now += 500
  d.tap(64)
  expect(d.records()[0]!.groups!.map((g) => g.pedal)).toEqual(['missing', 'ok', 'ok'])
})
