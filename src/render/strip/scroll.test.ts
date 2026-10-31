import { describe, expect, it } from 'vitest'
import type { OccurrenceGeometry } from '../types'
import {
  clampTranslate,
  occAtPosition,
  occAtX,
  positionToX,
  scrollTranslate,
  verticalTranslate,
  visibleRange,
  zoomAround,
} from './scroll'

const occ = (i: number, x0: number, x1: number, anchors: [number, number][]): OccurrenceGeometry => ({
  occ: i,
  x0,
  x1,
  start: i,
  duration: 1,
  anchors,
  label: String(i + 1),
  labelBox: { x: x0, y: 0, w: 10, h: 10 },
})

const occs = [
  occ(0, 0, 400, [
    [0, 120],
    [0.5, 260],
    [1, 400],
  ]),
  occ(1, 400, 700, [
    [0, 420],
    [0.25, 500],
    [0.75, 640],
    [1, 700],
  ]),
]

describe('positions and x', () => {
  it('maps onsets to their anchors and interpolates between them', () => {
    expect(positionToX(occs, 0)).toBe(120)
    expect(positionToX(occs, 0.5)).toBe(260)
    expect(positionToX(occs, 0.25)).toBe(190)
    expect(positionToX(occs, 1)).toBe(420)
    expect(positionToX(occs, 1.75)).toBe(640)
    expect(positionToX(occs, 2)).toBe(700)
  })

  it('finds measures by position and by x', () => {
    expect(occAtPosition(occs, 0.99)).toBe(0)
    expect(occAtPosition(occs, 1)).toBe(1)
    expect(occAtX(occs, -5)).toBe(0)
    expect(occAtX(occs, 399)).toBe(0)
    expect(occAtX(occs, 400)).toBe(1)
    expect(occAtX(occs, 10_000)).toBe(1)
  })
})

describe('scrollTranslate', () => {
  const base = { contentWidth: 10_000, viewportWidth: 900, scale: 1 }
  it('keeps the cursor one third across the viewport', () => {
    expect(scrollTranslate({ ...base, cursorX: 5000 })).toBe(300 - 5000)
  })
  it('allows the first and final notes to reach the same fixed anchor', () => {
    expect(scrollTranslate({ ...base, cursorX: 50 })).toBe(250)
    expect(scrollTranslate({ ...base, cursorX: 9990 })).toBe(300 - 9990)
    expect(clampTranslate(500, 10_000, 900, 1)).toBe(300)
    expect(clampTranslate(500, 10_000, 900, 1, 0.5)).toBe(450)
    expect(scrollTranslate({ ...base, contentWidth: 200, cursorX: 190 })).toBe(110)
  })
  it('respects zoom', () => {
    expect(scrollTranslate({ ...base, cursorX: 5000, scale: 2 })).toBe(300 - 10_000)
  })
  it('keeps a zoom anchor fixed on screen', () => {
    const tx = -1000
    const next = zoomAround(tx, 1, 1.5, 1300)
    expect(next + 1300 * 1.5).toBeCloseTo(tx + 1300)
  })
  it('reports the visible layout range', () => {
    expect(visibleRange(-1000, 2, 800)).toEqual({ x0: 500, x1: 900 })
  })
})

describe('verticalTranslate', () => {
  const layout = {
    top: 0,
    height: 400,
    staves: [
      { index: 0, top: 100, bottom: 140 },
      { index: 1, top: 220, bottom: 260 },
    ],
  }
  it('centers content that fits', () => {
    expect(verticalTranslate(layout, 600, 1)).toBe(100)
  })
  it('centers the staves when zoomed beyond the viewport, clamped', () => {
    expect(verticalTranslate(layout, 300, 1)).toBe(-30)
    expect(verticalTranslate(layout, 300, 3)).toBe(Math.max(300 - 1200, 150 - 540))
  })
})
