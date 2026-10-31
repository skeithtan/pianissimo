import { describe, expect, it } from 'vitest'
import { intersects } from '../geom'
import type { Box } from '../types'
import { countCollisions, layoutLabels, type LabelUnitInput } from './layout'

const staves = [
  { index: 0, top: 100, bottom: 140 },
  { index: 1, top: 200, bottom: 240 },
]
const W = 24
const H = 14

function head(x: number, y: number): Box {
  return { x, y: y - 5, w: 12, h: 10 }
}

function unit(i: number, x: number, y: number, staff = 0): LabelUnitInput {
  return { notes: [i], occ: 0, staff, hand: staff === 0 ? 'R' : 'L', head: head(x, y), x: x + 6 }
}

function run(units: LabelUnitInput[], extra: Box[] = []) {
  const obstacles = [...units.map((u) => u.head), ...extra]
  const res = layoutLabels({ units, obstacles, staves, labelW: W, labelH: H, fontPx: 12 })
  return { res, obstacles }
}

describe('layoutLabels', () => {
  it('places a lone label right of its notehead, vertically centered', () => {
    const { res } = run([unit(0, 100, 120)])
    const l = res.labels[0]!
    expect(l.placement).toBe('right')
    expect(l.box.x).toBe(114)
    expect(l.box.y + l.box.h / 2).toBe(120)
    expect(l.anchor).toBe('start')
    expect(res.failures).toEqual([])
    expect(res.spacingDemand).toBe(1)
  })

  it('never overlaps noteheads, obstacles or other labels in a dense chord', () => {
    const chord = [unit(0, 100, 100), unit(1, 100, 110), unit(2, 100, 120), unit(3, 100, 130), unit(4, 100, 140)]
    const accidentals = chord.map((u) => ({ x: u.head.x - 10, y: u.head.y - 3, w: 8, h: 16 }))
    const { res, obstacles } = run(chord, accidentals)
    expect(res.labels).toHaveLength(5)
    expect(countCollisions(res.labels, obstacles)).toBe(0)
    for (const l of res.labels) for (const o of obstacles) expect(intersects(l.box, o)).toBe(false)
  })

  it('labels each note of a fast run without covering the next notehead', () => {
    const run16 = Array.from({ length: 8 }, (_, i) => unit(i, 100 + i * 18, 120 - (i % 3) * 5))
    const { res, obstacles } = run(run16)
    expect(countCollisions(res.labels, obstacles)).toBe(0)
    expect(res.labels.every((l) => l.notes.length === 1)).toBe(true)
  })

  it('falls back to a callout with a leader and asks for wider spacing when boxed in', () => {
    const u = unit(0, 100, 120)
    const walls: Box[] = [
      { x: 60, y: 60, w: 100, h: 54 },
      { x: 60, y: 126, w: 100, h: 54 },
      { x: 60, y: 114, w: 39, h: 12 },
      { x: 113, y: 114, w: 47, h: 12 },
    ]
    const { res, obstacles } = run([u, unit(1, 140, 120)], walls)
    const l = res.labels[0]!
    expect(l.placement).toBe('callout')
    expect(l.leader).toBeDefined()
    expect(res.failures).toContain(0)
    expect(res.spacingDemand).toBeGreaterThan(1)
    expect(countCollisions(res.labels, obstacles)).toBe(0)
  })

  it('keeps staggered labels nearer their own notehead than a neighbor', () => {
    const chord = [unit(0, 100, 110), unit(1, 100, 120)]
    const { res } = run(chord, [{ x: 70, y: 90, w: 29, h: 50 }])
    for (const [i, l] of res.labels.entries()) {
      if (l.placement !== 'stagger') continue
      const cy = l.box.y + l.box.h / 2
      const own = Math.abs(cy - (chord[i]!.head.y + 5))
      const other = Math.abs(cy - (chord[1 - i]!.head.y + 5))
      expect(own).toBeLessThan(other)
    }
  })
})
