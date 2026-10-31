import { describe, expect, it } from 'vitest'
import {
  FLASH_TIMING,
  FLASH_TIMING_REDUCED,
  NO_FLASH,
  SOFT_FLASH_PEAK,
  envelopeEnd,
  flashActive,
  flashIntensity,
  hitEnvelope,
  hitFlash,
  intensityAt,
  isActive,
} from './flashEnvelope'

describe('flash envelope', () => {
  it('is zero with no envelope', () => {
    expect(intensityAt(null, 100)).toBe(0)
    expect(isActive(null, 100)).toBe(false)
  })

  it('rises quickly to the peak, holds, then decays to zero in about 300 ms', () => {
    const env = hitEnvelope(null, 1000)
    expect(intensityAt(env, 1000)).toBe(0)
    expect(intensityAt(env, 1025)).toBeGreaterThan(0.8) // ease-out: most of the rise early
    expect(intensityAt(env, 1050)).toBe(1)
    expect(intensityAt(env, 1060)).toBe(1) // hold
    const mid = intensityAt(env, 1070 + FLASH_TIMING.decayMs / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(intensityAt(env, envelopeEnd(env))).toBe(0)
    expect(envelopeEnd(env) - 1000).toBeGreaterThanOrEqual(280)
    expect(envelopeEnd(env) - 1000).toBeLessThanOrEqual(360)
  })

  it('rises monotonically to the peak and then falls monotonically', () => {
    const env = hitEnvelope(null, 0)
    const samples: number[] = []
    for (let t = 0; t <= envelopeEnd(env); t += 5) samples.push(intensityAt(env, t))
    const firstPeak = samples.indexOf(1)
    const lastPeak = samples.lastIndexOf(1)
    expect(firstPeak).toBeGreaterThan(0)
    for (let i = 1; i <= firstPeak; i++) expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!)
    for (let i = lastPeak + 1; i < samples.length; i++) expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]!)
  })

  it('a repeat during the decay re-raises from the current value without dropping to zero', () => {
    const first = hitEnvelope(null, 0)
    const now = 200 // well into the decay
    const before = intensityAt(first, now)
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(1)

    const second = hitEnvelope(first, now)
    expect(second.from).toBeCloseTo(before, 10)
    expect(intensityAt(second, now)).toBeCloseTo(before, 10) // continuous at the hit
    let last = before
    for (let t = now; t <= now + second.attackMs; t += 1) {
      const v = intensityAt(second, t)
      expect(v).toBeGreaterThanOrEqual(last - 1e-9) // only ever rises during the attack
      last = v
    }
    expect(intensityAt(second, now + second.attackMs)).toBe(1)
  })

  it('pushes the decay later on every repeat', () => {
    const first = hitEnvelope(null, 0)
    const second = hitEnvelope(first, 150)
    const third = hitEnvelope(second, 250)
    expect(envelopeEnd(second)).toBeGreaterThan(envelopeEnd(first))
    expect(envelopeEnd(third)).toBeGreaterThan(envelopeEnd(second))
  })

  it('rapid repeats stay high: the intensity never dips below a strobe-free floor', () => {
    let env = hitEnvelope(null, 0)
    let floor = 1
    for (let t = 100; t <= 1000; t += 100) {
      env = hitEnvelope(env, t)
      for (let u = t; u < t + 100; u += 4) floor = Math.min(floor, intensityAt(env, u))
    }
    expect(floor).toBeGreaterThan(0.85)
  })

  it('a repeat landing at the very start of the attack does not restart from zero', () => {
    const first = hitEnvelope(null, 0)
    const second = hitEnvelope(first, 30)
    expect(second.from).toBeGreaterThan(0.5)
    expect(intensityAt(second, 30)).toBeGreaterThan(0.5)
  })

  it('stretches the hold to honor the engine feedback deadline', () => {
    const env = hitEnvelope(null, 0, FLASH_TIMING, 1000)
    expect(envelopeEnd(env)).toBe(1000)
    expect(intensityAt(env, 600)).toBe(1)
    // A deadline earlier than the natural end changes nothing.
    expect(envelopeEnd(hitEnvelope(null, 0, FLASH_TIMING, 100))).toBe(envelopeEnd(hitEnvelope(null, 0)))
  })

  it('reports activity until the envelope ends', () => {
    const env = hitEnvelope(null, 0)
    expect(isActive(env, envelopeEnd(env) - 1)).toBe(true)
    expect(isActive(env, envelopeEnd(env))).toBe(false)
  })
})

describe('soft flash (too-early press)', () => {
  const soft = { soft: true } as const

  it('peaks at 0.35 of the full flash with the same attack and a shorter decay', () => {
    expect(SOFT_FLASH_PEAK).toBe(0.35)
    for (const timing of [FLASH_TIMING, FLASH_TIMING_REDUCED]) {
      const state = hitFlash(NO_FLASH, 0, timing, undefined, soft)
      expect(state.full).toBeNull()
      const env = state.soft!
      expect(env.attackMs).toBe(timing.attackMs)
      expect(env.decayMs).toBeLessThanOrEqual(timing.decayMs)
      let max = 0
      for (let t = 0; t <= envelopeEnd(env); t += 1) max = Math.max(max, flashIntensity(state, t))
      expect(max).toBeCloseTo(SOFT_FLASH_PEAK, 10)
      expect(envelopeEnd(env)).toBeLessThanOrEqual(envelopeEnd(hitEnvelope(null, 0, timing)))
      expect(flashActive(state, envelopeEnd(env))).toBe(false)
    }
  })

  it('repeated soft hits never exceed the soft peak', () => {
    let state = NO_FLASH
    for (let t = 0; t <= 600; t += 40) {
      state = hitFlash(state, t, FLASH_TIMING, undefined, soft)
      for (let u = t; u < t + 40; u += 2) expect(flashIntensity(state, u)).toBeLessThanOrEqual(SOFT_FLASH_PEAK + 1e-9)
    }
  })

  it('never raises a running full flash above its current intensity', () => {
    const full = hitFlash(NO_FLASH, 0)
    const now = 150 // decaying, above the soft peak
    const before = flashIntensity(full, now)
    expect(before).toBeGreaterThan(SOFT_FLASH_PEAK)
    const both = hitFlash(full, now, FLASH_TIMING, undefined, soft)
    for (let t = now; t <= envelopeEnd(full.full!); t += 2) {
      expect(flashIntensity(both, t)).toBeLessThanOrEqual(before + 1e-9)
      expect(flashIntensity(both, t)).toBeGreaterThanOrEqual(flashIntensity(full, t) - 1e-9)
    }
    // Once the full flash has decayed below the soft layer, the soft hit shows (the maximum).
    expect(flashIntensity(both, envelopeEnd(full.full!))).toBeGreaterThan(0)
  })

  it('a full hit after a soft one takes precedence and rises from the intensity showing', () => {
    const softState = hitFlash(NO_FLASH, 0, FLASH_TIMING, undefined, soft)
    const now = 60
    const showing = flashIntensity(softState, now)
    expect(showing).toBeCloseTo(SOFT_FLASH_PEAK, 10)
    const full = hitFlash(softState, now)
    expect(full.full!.from).toBeCloseTo(showing, 10)
    expect(flashIntensity(full, now)).toBeCloseTo(showing, 10)
    expect(flashIntensity(full, now + full.full!.attackMs)).toBe(1)
    expect(full.full!.attackMs).toBeLessThan(FLASH_TIMING.attackMs)
  })

  it('honors the engine feedback deadline like a full hit', () => {
    const state = hitFlash(NO_FLASH, 0, FLASH_TIMING, 1000, soft)
    expect(envelopeEnd(state.soft!)).toBe(1000)
    expect(flashIntensity(state, 600)).toBeCloseTo(SOFT_FLASH_PEAK, 10)
  })
})
