import { describe, expect, it } from 'vitest'
import { easeInOut, fadeOutOpacity } from './fade'

describe('easeInOut', () => {
  it('is exactly 0 and 1 at the ends and clamps outside', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(-0.5)).toBe(0)
    expect(easeInOut(2)).toBe(1)
    expect(easeInOut(Number.NaN)).toBe(0)
  })

  it('is symmetric and monotonic', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1)
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const v = easeInOut(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('starts and ends gently (smaller steps near the ends than in the middle)', () => {
    const start = easeInOut(0.05) - easeInOut(0)
    const middle = easeInOut(0.525) - easeInOut(0.475)
    expect(start).toBeLessThan(middle / 3)
  })
})

describe('fadeOutOpacity', () => {
  it('is exactly 1 before the fade and exactly 0 at and after its end', () => {
    expect(fadeOutOpacity(-10, 300)).toBe(1)
    expect(fadeOutOpacity(0, 300)).toBe(1)
    expect(fadeOutOpacity(300, 300)).toBe(0)
    expect(fadeOutOpacity(1000, 300)).toBe(0)
  })

  it('eases between the ends', () => {
    expect(fadeOutOpacity(150, 300)).toBeCloseTo(0.5)
    expect(fadeOutOpacity(30, 300)).toBeGreaterThan(0.97)
    expect(fadeOutOpacity(270, 300)).toBeLessThan(0.03)
    expect(fadeOutOpacity(270, 300)).toBeGreaterThan(0)
  })

  it('treats a zero-length fade as immediate removal', () => {
    expect(fadeOutOpacity(0, 0)).toBe(0)
    expect(fadeOutOpacity(-1, 0)).toBe(1)
  })
})
