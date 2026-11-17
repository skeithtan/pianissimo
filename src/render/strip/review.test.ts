import { describe, expect, it } from 'vitest'
import { clampReviewTranslate, reviewEase, reviewFrame } from './review'

const BASE = {
  x0: 1000,
  x1: 1800,
  viewportWidth: 900,
  viewportHeight: 300,
  staffSpan: 196,
  leftReserve: 92,
  playScale: 1,
  minScale: 0.6,
}

describe('reviewFrame (U97)', () => {
  it('fits the loop beside the signatures with margins, centered', () => {
    const f = reviewFrame(BASE)
    expect(f.scale).toBeCloseTo(852 / 892)
    expect(f.fits).toBe(true)
    const left = 24 + 92 * f.scale
    const mid = f.tx + 1400 * f.scale
    expect(mid).toBeCloseTo((left + 876) / 2)
  })

  it('never zooms in past the playing zoom', () => {
    const f = reviewFrame({ ...BASE, x1: 1200, playScale: 0.8 })
    expect(f.scale).toBe(0.8)
    expect(f.fits).toBe(true)
  })

  it('keeps the playing zoom unchanged when the loop already fits with the side margins', () => {
    // Room at zoom 1: 900 - 2 × 24 = 852 px for the 92 px signatures plus the loop.
    for (const x1 of [1300, 1000 + 852 - 92]) {
      const f = reviewFrame({ ...BASE, x1 })
      expect(f.scale).toBe(1)
      expect(f.fits).toBe(true)
    }
  })

  it('zooms out only until the loop just fits with the side margins', () => {
    const f = reviewFrame({ ...BASE, x1: 1000 + 852 - 92 + 100 })
    expect(f.scale).toBeLessThan(1)
    expect(f.scale).toBeGreaterThan(0.6)
    expect(f.fits).toBe(true)
    // The signatures plus the loop fill the room exactly: 24 px free at each side, no more.
    expect(f.tx + 1000 * f.scale).toBeCloseTo(24 + 92 * f.scale)
    expect(f.tx + (1000 + 852 - 92 + 100) * f.scale).toBeCloseTo(900 - 24)
  })

  it('stops at the floor and starts at the loop for a long loop', () => {
    const f = reviewFrame({ ...BASE, x1: 6000 })
    expect(f.scale).toBe(0.6)
    expect(f.fits).toBe(false)
    expect(f.tx + 1000 * 0.6).toBeCloseTo(24 + 92 * 0.6)
  })

  it('keeps the playing zoom when it is already below the floor', () => {
    expect(reviewFrame({ ...BASE, x1: 6000, playScale: 0.5 }).scale).toBe(0.5)
  })

  it('fits both staves in the height left above the card', () => {
    expect(reviewFrame({ ...BASE, viewportHeight: 150 }).scale).toBeCloseTo(150 / 196)
  })

  it('clamps a pan so the first cursor stop or the right end can reach the middle, and eases in and out', () => {
    expect(clampReviewTranslate(1000, 0, 4000, 900, 0.5)).toBe(450)
    // Not past the first cursor stop (U96): the opening clefs never scroll to the middle.
    expect(clampReviewTranslate(1000, 120, 4000, 900, 0.5)).toBe(450 - 60)
    expect(clampReviewTranslate(-5000, 120, 4000, 900, 0.5)).toBe(450 - 2000)
    expect(reviewEase(0)).toBe(0)
    expect(reviewEase(0.5)).toBeCloseTo(0.5)
    expect(reviewEase(1)).toBe(1)
    expect(reviewEase(2)).toBe(1)
  })
})
