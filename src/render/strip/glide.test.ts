import { describe, expect, it } from 'vitest'
import { cubicBezier, parseEasing } from './glide'

describe('cubicBezier', () => {
  it('is pinned at both ends and linear for the linear curve', () => {
    const linear = cubicBezier(0, 0, 1, 1)
    for (const t of [0, 0.1, 0.25, 0.5, 0.9, 1]) expect(linear(t)).toBeCloseTo(t, 5)
    expect(linear(-1)).toBe(0)
    expect(linear(2)).toBe(1)
  })

  it('matches known points of the CSS keyword curves', () => {
    // ease-in-out is symmetric about the middle.
    const inOut = cubicBezier(0.42, 0, 0.58, 1)
    expect(inOut(0.5)).toBeCloseTo(0.5, 5)
    expect(inOut(0.25) + inOut(0.75)).toBeCloseTo(1, 5)
    // `ease` at 50 % of the time is about 80 % of the way.
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3)
  })

  it('rises steeply and monotonically for the strip’s ease-out curves', () => {
    for (const curve of [cubicBezier(0.16, 1, 0.3, 1), cubicBezier(0.22, 1, 0.36, 1)]) {
      let prev = 0
      for (let i = 1; i <= 100; i++) {
        const v = curve(i / 100)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = v
      }
      expect(curve(0.1)).toBeGreaterThan(0.3)
    }
  })
})

describe('parseEasing', () => {
  it('reads cubic-bezier values and keywords, and falls back otherwise', () => {
    expect(parseEasing(' cubic-bezier(0.42, 0, 0.58, 1) ', [0, 0, 1, 1])(0.25)).toBeCloseTo(
      cubicBezier(0.42, 0, 0.58, 1)(0.25),
      6,
    )
    expect(parseEasing('ease-in', [0, 0, 1, 1])(0.5)).toBeCloseTo(cubicBezier(0.42, 0, 1, 1)(0.5), 6)
    expect(parseEasing('', [0, 0, 1, 1])(0.3)).toBeCloseTo(0.3, 5)
    expect(parseEasing('steps(4)', [0, 0, 1, 1])(0.3)).toBeCloseTo(0.3, 5)
    expect(parseEasing('cubic-bezier(1, 2)', [0, 0, 1, 1])(0.3)).toBeCloseTo(0.3, 5)
  })
})
