import { describe, expect, it } from 'vitest'
import { rat } from '../../core/music/rational'
import { CursorPath } from './cursorPath'
import {
  buildCursorKnots,
  buildLoopKnots,
  edgeLimits,
  knotAtPosition,
  loopEdgeX,
  nearestKnot,
  passageFromKnots,
} from './snap'

/** Three bars of one whole note each, 200 px wide: entries at 0 (x0 + 40) and ½ (x0 + 120). */
const occs = [0, 1, 2].map((o) => {
  const x0 = 50 + o * 200
  return {
    start: o,
    duration: 1,
    x0,
    x1: x0 + 200,
    anchors: [
      [0, x0 + 40],
      [0.5, x0 + 120],
      [1, x0 + 200],
    ] as [number, number][],
  }
})

describe('loop knots', () => {
  it('are barlines plus the onsets inside bars, with band edges between notes', () => {
    const k = buildLoopKnots(occs, [rat(0), rat(1, 2), rat(3, 2), rat(5, 2)])
    expect([...k.pos]).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
    expect(k.exact).toEqual([null, rat(1, 2), null, rat(3, 2), null, rat(5, 2), null])
    expect([...k.occ]).toEqual([0, 0, 1, 1, 2, 2, 3])
    // Bar 2 has no downbeat note for these hands.
    expect([...k.note]).toEqual([1, 1, 0, 1, 0, 1, 0])
    expect([...k.x]).toEqual([50, 130, 250, 330, 450, 530, 650])
    expect(loopEdgeX(occs, 0.5)).toBe(130)
  })

  it('without known onsets every barline counts as a note (whole-bar editing)', () => {
    const k = buildLoopKnots(occs, null)
    expect([...k.pos]).toEqual([0, 1, 2, 3])
    expect([...k.note]).toEqual([1, 1, 1, 0])
  })

  it('limit a dragged edge so the loop keeps a note and never inverts', () => {
    const k = buildLoopKnots(occs, [rat(0), rat(1, 2), rat(3, 2), rat(5, 2)])
    // Start, with the end at 1.5: the last note before it is ½.
    expect(edgeLimits(k, 'start', 1.5)).toEqual({ lo: 0, hi: 1 })
    // End, with the start at 1 (a barline without a note): past the note at 1.5.
    expect(edgeLimits(k, 'end', 1)).toEqual({ lo: 4, hi: 6 })
    expect(passageFromKnots(k, 1, 4)).toEqual({ fromOcc: 0, toOcc: 1, start: rat(1, 2) })
    expect(passageFromKnots(k, 2, 5)).toEqual({ fromOcc: 1, toOcc: 2, end: rat(5, 2) })
  })

  it('find the nearest knot by x within limits and by position', () => {
    const xs = Float64Array.from([50, 130, 250, 330])
    expect(nearestKnot(xs, 0)).toBe(0)
    expect(nearestKnot(xs, 189)).toBe(1)
    expect(nearestKnot(xs, 191)).toBe(2)
    expect(nearestKnot(xs, 1000)).toBe(3)
    expect(nearestKnot(xs, 1000, 0, 2)).toBe(2)
    expect(nearestKnot(xs, 0, 2, 3)).toBe(2)
    expect(knotAtPosition(Float64Array.from([0, 0.5, 1]), 0.49)).toBe(1)
  })
})

describe('cursor knots', () => {
  it('put the dragged playhead exactly on the cursor path at each onset', () => {
    const k = buildCursorKnots(new CursorPath(occs.map((o) => ({ ...o }))), [rat(0), rat(3, 2)])
    expect([...k.x]).toEqual([90, 370])
    expect(k.exact).toEqual([rat(0), rat(3, 2)])
  })
})
