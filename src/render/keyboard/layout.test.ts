import { describe, expect, it } from 'vitest'
import { buildLayout, countWhiteKeys, isBlackKey, placeLabels } from './layout'

describe('isBlackKey', () => {
  it('recognizes the five black pitch classes', () => {
    const blacks = Array.from({ length: 12 }, (_, i) => 60 + i).filter(isBlackKey)
    expect(blacks).toEqual([61, 63, 66, 68, 70])
  })
})

describe('countWhiteKeys', () => {
  it('counts the white keys of whole octaves and of the 88-key piano', () => {
    expect(countWhiteKeys({ low: 48, high: 71 })).toBe(14)
    expect(countWhiteKeys({ low: 21, high: 108 })).toBe(52)
    expect(countWhiteKeys({ low: 48, high: 71 })).toBe(
      buildLayout({ low: 48, high: 71 }, 100).keys.filter((k) => !k.black).length,
    )
  })
})

describe('buildLayout', () => {
  const layout = buildLayout({ low: 48, high: 71 }, 560)

  it('shares the width equally between the white keys', () => {
    const whites = layout.keys.filter((k) => !k.black)
    expect(whites).toHaveLength(14)
    expect(layout.whiteWidth).toBe(40)
    expect(whites[0]?.x).toBe(0)
    const last = whites.at(-1)
    expect((last?.x ?? 0) + (last?.width ?? 0)).toBeCloseTo(560)
  })

  it('draws every key in range once, white before black', () => {
    expect(layout.keys).toHaveLength(24)
    const firstBlack = layout.keys.findIndex((k) => k.black)
    expect(layout.keys.slice(firstBlack).every((k) => k.black)).toBe(true)
  })

  it('centers a black key on the boundary between its white neighbors', () => {
    const cSharp = layout.keys.find((k) => k.midi === 49)
    const c = layout.keys.find((k) => k.midi === 48)
    const d = layout.keys.find((k) => k.midi === 50)
    expect(cSharp?.cx).toBeCloseTo(((c?.x ?? 0) + (c?.width ?? 0) + (d?.x ?? 0)) / 2)
    expect(cSharp?.width).toBeCloseTo(24)
  })

  it('marks the C keys as octave landmarks', () => {
    expect(layout.keys.filter((k) => k.isC).map((k) => k.midi)).toEqual([48, 60])
  })

  it('shrinks key width rather than cropping a wide window', () => {
    const wide = buildLayout({ low: 21, high: 108 }, 400)
    expect(wide.keys.filter((k) => !k.black)).toHaveLength(52)
    expect(wide.whiteWidth).toBeCloseTo(400 / 52)
    expect(wide.centerX(21)).toBeCloseTo(wide.whiteWidth / 2)
    expect(wide.centerX(108)).toBeCloseTo(400 - wide.whiteWidth / 2)
  })

  it('clamps centreX for pitches outside the range', () => {
    expect(layout.centerX(10)).toBe(0)
    expect(layout.centerX(100)).toBe(560)
  })
})

describe('placeLabels', () => {
  const overlaps = (items: { width: number }[], placed: { lane: number; left: number }[]) =>
    placed.some((a, i) =>
      placed.some(
        (b, j) => i < j && a.lane === b.lane && a.left < b.left + items[j]!.width && b.left < a.left + items[i]!.width,
      ),
    )

  it('stacks colliding labels and reuses a freed lane while one exists (nothing moves)', () => {
    const items = [
      { left: 0, width: 40, anchor: 20 },
      { left: 20, width: 40, anchor: 40 },
      { left: 45, width: 35, anchor: 62 },
    ]
    const placed = placeLabels(items, 3, 200)
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 0])
    expect(placed.map((p) => p.left)).toEqual([0, 20, 45])
  })

  it('slides labels of a dense cluster instead of overlapping when every lane is taken', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ left: 100 + i * 8, width: 50, anchor: 125 + i * 8 }))
    const placed = placeLabels(items, 3, 360)
    expect(overlaps(items, placed)).toBe(false)
    expect(Math.max(...placed.map((p) => p.lane))).toBeLessThanOrEqual(2)
    for (const [i, p] of placed.entries()) {
      expect(p.left).toBeGreaterThanOrEqual(items[i]!.left)
      expect(p.left + items[i]!.width).toBeLessThanOrEqual(360)
    }
  })

  it('keeps a lane-0 label over its anchor; only higher lanes (with leader lines) slide past it', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ left: i * 6, width: 40, anchor: 20 + i * 6 }))
    const placed = placeLabels(items, 3, 300)
    for (const [i, p] of placed.entries()) {
      if (p.lane === 0) {
        expect(items[i]!.anchor).toBeGreaterThanOrEqual(p.left + 3)
        expect(items[i]!.anchor).toBeLessThanOrEqual(p.left + 40 - 3)
      }
    }
    expect(overlaps(items, placed)).toBe(false)
  })

  it('overlaps only when no lane can take a label inside the limit, and never drops one', () => {
    const items = Array.from({ length: 5 }, () => ({ left: 60, width: 40, anchor: 80 }))
    const placed = placeLabels(items, 2, 100)
    expect(placed).toHaveLength(5)
    for (const p of placed) expect(p.left + 40).toBeLessThanOrEqual(100)
  })
})
