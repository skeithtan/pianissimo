import { describe, expect, it } from 'vitest'
import { ActiveClock, HintState } from './hints'

describe('ActiveClock', () => {
  it('subtracts paused intervals and freezes while paused', () => {
    const c = new ActiveClock()
    expect(c.active(100)).toBe(100)
    c.pause(100)
    expect(c.active(500)).toBe(100)
    expect(c.toReal(150)).toBeNull()
    c.resume(500)
    expect(c.active(600)).toBe(200)
    expect(c.toReal(250)).toBe(650)
    c.pause(600)
    c.pause(700)
    c.resume(800)
    expect(c.active(800)).toBe(200)
  })
})

describe('HintState (spec: Hint fade)', () => {
  it('a timed hint fades during the final fadeMs and is invisible exactly at expiry', () => {
    const h = new HintState()
    h.show(0, [1, 2], 'manual', 0, 30_000, 300)
    expect(h.opacity(1, 29_700)).toBe(1)
    expect(h.opacity(1, 29_850)).toBeCloseTo(0.5)
    expect(h.opacity(1, 29_990)).toBeGreaterThan(0)
    expect(h.opacity(1, 30_000)).toBe(0)
    expect(h.opacities(30_000).size).toBe(0)
    expect(h.expire(29_999)).toBeNull()
    expect(h.expire(30_000)).toBe(0)
    expect(h.hint).toBeNull()
  })

  it('clamps the expiry fade to a lifetime shorter than the fade', () => {
    const h = new HintState()
    h.show(0, [1], 'manual', 0, 200, 300)
    expect(h.opacity(1, 0)).toBe(1)
    expect(h.opacity(1, 100)).toBeCloseTo(0.5)
    expect(h.opacity(1, 200)).toBe(0)
  })

  it('"Until correct" never expires and stays fully visible', () => {
    const h = new HintState()
    h.show(3, [9], 'auto', 0, null, 300)
    expect(h.opacity(9, 10_000_000)).toBe(1)
    expect(h.expire(10_000_000)).toBeNull()
    expect(h.nextDeadline()).toBeNull()
  })

  it('retiring starts an eased fade from the current opacity, attached to the original notes', () => {
    const h = new HintState()
    h.show(0, [1, 2], 'manual', 0, 30_000, 300)
    expect(h.retire(1000, 300)).toBe(0)
    expect(h.hint).toBeNull()
    expect(h.opacity(1, 1000)).toBe(1)
    expect(h.opacity(2, 1150)).toBeCloseTo(0.5)
    expect(h.opacity(1, 1300)).toBe(0)
    expect(h.fadingUntil()).toBe(1300)
    expect(h.prune(1299)).toBe(false)
    expect(h.prune(1300)).toBe(true)
    expect(h.fadingUntil()).toBe(-Infinity)
  })

  it('retiring during the expiry fade continues from the reduced opacity without a jump', () => {
    const h = new HintState()
    h.show(0, [1], 'manual', 0, 1000, 300)
    const before = h.opacity(1, 850)
    h.retire(850, 300)
    expect(h.opacity(1, 850)).toBeCloseTo(before)
    expect(h.opacity(1, 1150)).toBe(0)
  })

  it('a fresh request cancels the fade of the same labels and restores full opacity', () => {
    const h = new HintState()
    h.show(0, [1], 'manual', 0, 30_000, 300)
    h.retire(1000, 300)
    h.show(0, [1], 'manual', 1100, 30_000, 300)
    expect(h.opacity(1, 1100)).toBe(1)
    expect(h.fadingUntil()).toBe(-Infinity)
    expect(h.hint?.expiresAt).toBe(31_100)
  })

  it('a new group keeps the outgoing fade on the old notes only', () => {
    const h = new HintState()
    h.show(0, [1], 'manual', 0, 30_000, 300)
    h.retire(1000, 300)
    h.show(1, [5], 'auto', 1000, 30_000, 300)
    const o = h.opacities(1100)
    expect(o.get(5)).toBe(1)
    expect(o.get(1)).toBeGreaterThan(0)
    expect(o.get(1)).toBeLessThan(1)
    expect(h.nextDeadline()).toBe(1300)
  })

  it('retiring an invisible hint leaves nothing to fade', () => {
    const h = new HintState()
    h.show(0, [1], 'manual', 0, 100, 300)
    h.retire(100, 300)
    expect(h.fadingUntil()).toBe(-Infinity)
    expect(h.retire(200, 300)).toBeNull()
  })
})
