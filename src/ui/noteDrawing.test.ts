import { describe, expect, it } from 'vitest'
import { rat } from '../core/music/rational'
import type { ScoreModel } from '../core/model/score'
import { notePaths, openingNotes, openingOf, overviewNotes, shortestNote, type DrawnNote } from './noteDrawing'

const note = (onset: number, length: number, midi: number, over: object = {}) => ({
  onset: rat(Math.round(onset * 16), 16),
  soundingDuration: rat(Math.round(length * 16), 16),
  midi,
  hand: 'R',
  tieContinuation: false,
  cue: false,
  ...over,
})
const model = (notes: object[], bars = 2): ScoreModel =>
  ({
    notes,
    occurrences: Array.from({ length: bars }, (_, i) => ({ index: i, start: rat(i), duration: rat(1) })),
  }) as never

describe('note drawing (U154)', () => {
  it("draws every attack on the overview's time scale, with its tied length", () => {
    // Bar 2 takes twice as long as bar 1.
    const measures = [
      { start: 0, duration: 1, seconds: 2 },
      { start: 1, duration: 1, seconds: 4 },
    ]
    const drawn = overviewNotes(
      model([
        note(0, 1, 60),
        note(1, 1, 48, { hand: 'L' }),
        note(1, 1, 60, { tieContinuation: true }),
        note(1, 1, 72, { cue: true }),
      ]),
      measures,
    )
    expect(drawn).toEqual([
      { from: 0, to: 1 / 3, midi: 60, left: false },
      { from: 1 / 3, to: 1, midi: 48, left: true },
    ])
    expect(shortestNote(measures, 320)).toBe(10)
    expect(shortestNote([], 320)).toBe(1.4)
  })

  it('keeps every note inside the box, the hands apart, high notes above low ones', () => {
    const notes: DrawnNote[] = [
      { from: 0, to: 0.5, midi: 84, left: false },
      { from: 0.999, to: 1, midi: 36, left: true },
    ]
    const { right, left } = notePaths(notes, { width: 200, height: 32, thickness: 3.8, shortest: 3 })
    expect(right.startsWith('M1')).toBe(true) // a rounded bar starts half its thickness in
    expect(right).toContain('a')
    const [, x, y] = /^M([\d.]+) ([\d.]+)h/.exec(left)!
    expect(Number(x)).toBeLessThanOrEqual(200)
    expect(Number(y)).toBeGreaterThan(25)
    expect(notePaths([], { width: 200, height: 32, thickness: 4, shortest: 2 })).toEqual({ right: '', left: '' })
  })

  it('keeps the opening bars small and shows as many of them as a row has room for', () => {
    const notes = Array.from({ length: 64 }, (_, i) => note(i / 16, 1 / 16, 60 + (i % 5)))
    const opening = openingOf(model(notes, 4))
    expect(opening.bars).toEqual([192, 384, 576, 768])
    expect(opening.notes).toHaveLength(4 * 64)
    expect(openingNotes(opening, 40)).toHaveLength(32)
    // One bar at least, however dense.
    expect(openingNotes(opening, 3)).toHaveLength(16)
    expect(openingNotes({ bars: [], notes: [] }, 40)).toEqual([])
    expect(openingNotes(opening, 64).at(-1)!.to).toBe(1)
  })
})
