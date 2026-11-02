import { describe, expect, it } from 'vitest'
import type { OccurrenceGeometry, PreparedLayout } from '../types'
import { columnSlices, sliceCorner, wider } from './respace'

/** A strip of bars of `width` px, onsets at quarters (0.25 whole notes). */
function strip(multiplier: number, barWidth: number, bars = 2): PreparedLayout {
  const occurrences: OccurrenceGeometry[] = Array.from({ length: bars }, (_, i) => {
    const x0 = 40 + i * barWidth
    const step = barWidth / 4
    return {
      occ: i,
      x0,
      x1: x0 + barWidth,
      start: i,
      duration: 1,
      anchors: [
        [0, x0 + step / 2],
        [0.25, x0 + 1.5 * step],
        [0.5, x0 + 2.5 * step],
        [0.75, x0 + 3.5 * step],
        [1, x0 + barWidth],
      ],
      label: String(i + 1),
      labelBox: { x: x0, y: 0, w: 10, h: 10 },
    }
  })
  return {
    params: { spacing: { voiceSpacingMultiplier: multiplier, voiceSpacingAddend: 3 } },
    width: 40 + bars * barWidth + 6,
    top: -20,
    height: 200,
    staves: [
      { index: 0, top: 0, bottom: 40 },
      { index: 1, top: 100, bottom: 140 },
    ],
    occurrences,
    segments: [],
  } as unknown as PreparedLayout
}

describe('respacing columns', () => {
  const tight = strip(1, 200)
  const roomy = strip(1.4, 280)

  it('cuts the engraving with more spacing', () => {
    expect(wider(tight, roomy)).toBe('next')
    expect(wider(roomy, tight)).toBe('prev')
    expect(wider(tight, tight)).toBe('prev')
  })

  it('one slice per onset, edge to edge, matched to the same onset in the other layout', () => {
    const slices = columnSlices(roomy, tight, 0, 2, () => 0)
    expect(slices).toHaveLength(8)
    // Contiguous from the line's start (clef) to its end (final barline), no gap or overlap.
    expect(slices[0]!.x0).toBe(0)
    for (let i = 1; i < slices.length; i++) expect(slices[i]!.x0).toBeCloseTo(slices[i - 1]!.x1)
    expect(slices.at(-1)!.x1).toBe(roomy.width)
    // A bar's first column starts at its barline; anchors map onset to onset.
    expect(slices[4]!.x0).toBe(roomy.occurrences[1]!.x0)
    expect(slices[5]).toMatchObject({ occ: 1, ax: 40 + 280 + 105, bx: 40 + 200 + 75 })
    expect(slices[5]!.y0).toBe(-20)
    expect(slices[5]!.y1).toBe(180)
    expect(slices[5]!.ay).toBe(0)
  })

  it('places a slice so its column sits at the given anchor in a frame', () => {
    const s = columnSlices(roomy, tight, 0, 1, () => 0)[1]!
    const frame = { scale: 2, dx: 10, dy: 5 }
    // At its own place: the slice's own corner through the frame.
    expect(sliceCorner(s, frame, s.ax, s.ay)).toEqual({ x: 10 + s.x0 * 2, y: 5 + s.y0 * 2 })
    // At the other layout's column: shifted by the anchors' difference.
    const c = sliceCorner(s, frame, s.bx, s.by)
    expect(c.x - (10 + s.x0 * 2)).toBeCloseTo((s.bx - s.ax) * 2)
  })
})
