import { afterEach, describe, expect, it } from 'vitest'
import { FakeAudioContext, asContext } from '../fakeWebAudio'
import { contextTimeFor, existingAudioContext, resetSharedAudioContext, sharedAudioContext } from './context'
import { WebAudioMetronome } from './metronome'

describe('shared AudioContext', () => {
  afterEach(() => resetSharedAudioContext())

  it('creates one context lazily, reuses it and resumes it when suspended', () => {
    expect(existingAudioContext()).toBeNull()
    let created = 0
    const factory = () => {
      created++
      const ctx = new FakeAudioContext()
      ctx.state = 'suspended'
      return ctx as unknown as AudioContext
    }
    const a = sharedAudioContext(factory)
    const b = sharedAudioContext(factory)
    expect(a).toBe(b)
    expect(created).toBe(1)
    expect(existingAudioContext()).toBe(a)
  })

  it('maps performance.now() times onto the context clock, never into the past', () => {
    const ctx = new FakeAudioContext()
    ctx.currentTime = 3
    expect(contextTimeFor(asContext(ctx), 1000, 1500)).toBeCloseTo(3.5)
    expect(contextTimeFor(asContext(ctx), 1000, 900)).toBe(3)
    const withTs = Object.assign(new FakeAudioContext(), {
      currentTime: 3,
      getOutputTimestamp: () => ({ contextTime: 2.95, performanceTime: 1000 }),
    })
    expect(contextTimeFor(asContext(withTs as FakeAudioContext), 1000, 1100)).toBeCloseTo(3.05)
  })
})

describe('WebAudioMetronome', () => {
  it('schedules accented and plain clicks and cancels the ones not yet played', () => {
    const ctx = new FakeAudioContext()
    let now = 0
    const m = new WebAudioMetronome({ context: asContext(ctx), clock: () => now, volume: 0.5 })
    m.click(0, true)
    m.click(1000, false)
    expect(ctx.oscillators.map((o) => [o.frequency.value, o.startAt])).toEqual([
      [1760, 0],
      [1320, 1],
    ])
    now = 500
    ctx.currentTime = 0.5
    m.cancel(500)
    const [played, pending] = ctx.oscillators
    expect(played!.stopAt).toEqual([0.06])
    expect(pending!.stopAt.length).toBe(2)
    expect(ctx.gains[1]!.disconnected).toBe(true)
  })
})
