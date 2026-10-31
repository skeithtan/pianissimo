import { describe, expect, it } from 'vitest'
import { segmentBounds } from './partition'

const measures = (widths: number[]) => {
  let x = 50
  return widths.map((w) => {
    const m = { x0: x, x1: x + w }
    x += w
    return m
  })
}

describe('segmentBounds', () => {
  it('groups whole measures into segments of at least the target width', () => {
    const b = segmentBounds(measures([300, 300, 300, 300, 300, 300, 300]), 2200, 800)
    expect(b.map((s) => [s.occStart, s.occEnd])).toEqual([
      [0, 3],
      [3, 6],
      [6, 7],
    ])
    expect(b[0]!.x0).toBe(0)
    expect(b[1]!.x0).toBe(b[0]!.x1)
    expect(b[2]!.x1).toBe(2200)
  })

  it('merges a short tail into the previous segment', () => {
    const b = segmentBounds(measures([500, 500, 100]), 1200, 900)
    expect(b.map((s) => [s.occStart, s.occEnd])).toEqual([[0, 3]])
  })

  it('keeps a single wide measure in its own segment', () => {
    const b = segmentBounds(measures([2000, 200, 200, 200]), 2700, 500)
    expect(b.map((s) => [s.occStart, s.occEnd])).toEqual([
      [0, 1],
      [1, 4],
    ])
  })
})
