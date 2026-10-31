import { describe, expect, it } from 'vitest'
import type { OccurrenceGeometry } from '../types'
import { CursorPath } from './cursorPath'

type Occ = Pick<OccurrenceGeometry, 'start' | 'duration' | 'anchors' | 'x1'>

/** Bar 0: half notes (wide); bar 1: a gap after the barline (key change), then quarters. */
const occs: Occ[] = [
  {
    start: 0,
    duration: 1,
    x1: 400,
    anchors: [
      [0, 120],
      [0.5, 260],
      [1, 400],
    ],
  },
  {
    start: 1,
    duration: 1,
    x1: 700,
    anchors: [
      [0, 460],
      [0.25, 520],
      [0.5, 580],
      [0.75, 640],
      [1, 700],
    ],
  },
]

describe('CursorPath', () => {
  it('is exact at every onset and glides from the last onset of a bar to the next bar', () => {
    const path = new CursorPath(occs)
    expect(path.at(0)).toBe(120)
    expect(path.at(0.5)).toBe(260)
    expect(path.at(1)).toBe(460)
    expect(path.at(1.25)).toBe(520)
    // The barline (x 400) is not a knot: halfway through the last half note is halfway to 460.
    expect(path.at(0.75)).toBe(360)
    // Only the end of the piece maps to the final barline; outside the piece x is clamped.
    expect(path.at(2)).toBe(700)
    expect(path.at(5)).toBe(700)
    expect(path.at(-1)).toBe(120)
    expect(path.knots).toBe(7)
  })

  it('has no jump anywhere: sampled densely, the largest step is bounded by the fastest segment', () => {
    const path = new CursorPath(occs)
    const dt = 1 / 960
    let prev = path.at(0)
    let maxStep = 0
    for (let t = dt; t <= 2; t += dt) {
      const x = path.at(t)
      expect(x).toBeGreaterThanOrEqual(prev)
      maxStep = Math.max(maxStep, x - prev)
      prev = x
    }
    // Fastest segment: 200 px over half a whole note (bar 0 → bar 1) = 400 px per whole note.
    expect(maxStep).toBeLessThanOrEqual(400 * dt + 1e-6)
  })

  it('merges onsets at one position (grace notes) into the rightmost x and keeps x monotone', () => {
    const path = new CursorPath([
      {
        start: 0,
        duration: 1,
        x1: 300,
        anchors: [
          [0, 80],
          [0, 100],
          [0.5, 90],
          [1, 300],
        ],
      },
    ])
    expect(path.at(0)).toBe(100)
    expect(path.at(0.5)).toBe(100)
    expect(path.at(1)).toBe(300)
  })

  it('smooths speed changes while remaining monotone and exactly aligned at every onset', () => {
    const path = new CursorPath(occs)
    // Constant-speed stretches are unchanged.
    expect(path.smoothAt(1.375)).toBeCloseTo(path.at(1.375), 9)
    // Every required onset remains exactly aligned, including changes in spacing.
    for (const pos of [0, 0.5, 1, 1.25, 1.5, 1.75, 2]) {
      expect(path.smoothAt(pos)).toBe(path.at(pos))
    }
    const dt = 1 / 960
    let prevX = path.smoothAt(0)
    let prevV = NaN
    let maxDv = 0
    for (let t = dt; t <= 2; t += dt) {
      const x = path.smoothAt(t)
      expect(x).toBeGreaterThanOrEqual(prevX - 1e-9)
      const v = (x - prevX) / dt
      if (!Number.isNaN(prevV)) maxDv = Math.max(maxDv, Math.abs(v - prevV))
      prevV = v
      prevX = x
    }
    // Speed (px per whole note) never steps: the largest change between samples is a ramp slice.
    expect(maxDv).toBeLessThan(5)
  })

  it('handles an empty layout', () => {
    const path = new CursorPath([])
    expect(path.at(3)).toBe(0)
    expect(path.smoothAt(3)).toBe(0)
  })
})
