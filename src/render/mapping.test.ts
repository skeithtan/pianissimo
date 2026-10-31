import { describe, expect, it } from 'vitest'
import { rat, type Rational } from '../core/music/rational'
import { mapNotes, type GraphicNote } from './mapping'
import type { MappingNote } from './types'

function note(index: number, occ: number, staff: number, voice: string, onset: Rational, midi: number): MappingNote {
  return { index, occ, staff, voice, onsetInMeasure: onset, midi, grace: false, hand: staff === 0 ? 'R' : 'L' }
}

function graphic(
  id: number,
  occ: number,
  staff: number,
  voice: string,
  onset: Rational,
  midi: number,
  x = id * 20,
  y = 0,
): GraphicNote {
  return { id, occ, staff, voice, onset, midi, grace: false, head: { x, y, w: 12, h: 10 }, x: x + 6, graphic: `g${id}` }
}

describe('mapNotes', () => {
  it('maps by occurrence, staff, voice, onset and pitch', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 72), note(1, 0, 1, '5', rat(0), 48), note(2, 0, 0, '1', rat(1, 4), 74)]
    const graphics = [
      graphic(0, 0, 1, '5', rat(0), 48),
      graphic(1, 0, 0, '1', rat(1, 4), 74),
      graphic(2, 0, 0, '1', rat(0), 72),
    ]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([2, 0, 1])
    expect(m.report.unmappedNotes).toEqual([])
    expect(m.report.unmappedGraphics).toEqual([])
    expect(m.report.relaxedMatches).toBe(0)
    expect(m.units.length).toBe(3)
  })

  it('maps cue notes but gives them no label unit (I13)', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 72), { ...note(1, 0, 0, '1', rat(1, 4), 74), cue: true }]
    const graphics = [graphic(0, 0, 0, '1', rat(0), 72), graphic(1, 0, 0, '1', rat(1, 4), 74)]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([0, 1])
    expect(m.units).toEqual([[0]])
    expect(m.unitOf).toEqual([0, -1])
  })

  it('keeps repeated occurrences of one source note apart', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 60), note(1, 1, 0, '1', rat(0), 60)]
    const graphics = [graphic(0, 1, 0, '1', rat(0), 60), graphic(1, 0, 0, '1', rat(0), 60)]
    expect(mapNotes(notes, graphics).graphicOf).toEqual([1, 0])
  })

  it('counts relaxed matches when the engraver numbers voices differently', () => {
    const notes = [note(0, 0, 1, '5', rat(1, 8), 50)]
    const graphics = [graphic(0, 0, 1, '1', rat(1, 8), 50)]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([0])
    expect(m.report.relaxedMatches).toBe(1)
  })

  it('shares one engraved notehead between unison notes of two voices (one label)', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 67), note(1, 0, 0, '2', rat(0), 67)]
    const graphics = [graphic(0, 0, 0, '1', rat(0), 67)]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([0, 0])
    expect(m.units).toEqual([[0, 1]])
    expect(m.unitOf).toEqual([0, 0])
    expect(m.report.sharedHeads).toBe(1)
  })

  it('merges coincident noteheads drawn twice for a unison', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 67), note(1, 0, 0, '2', rat(0), 67)]
    const graphics = [graphic(0, 0, 0, '1', rat(0), 67, 100, 50), graphic(1, 0, 0, '2', rat(0), 67, 100.5, 50)]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([0, 1])
    expect(m.units).toEqual([[0, 1]])
  })

  it('matches a quarter-tone the engraver reports with a fractional pitch', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 77), note(1, 0, 0, '1', rat(1, 4), 79)]
    const graphics = [graphic(0, 0, 0, '1', rat(0), 77.5), graphic(1, 0, 0, '1', rat(1, 4), 79)]
    const m = mapNotes(notes, graphics)
    expect(m.graphicOf).toEqual([0, 1])
    expect(m.report.relaxedMatches).toBe(1)
    expect(m.report.unmappedGraphics).toEqual([])
  })

  it('reports unmapped notes and graphics', () => {
    const notes = [note(0, 0, 0, '1', rat(0), 60)]
    const graphics = [graphic(0, 0, 0, '1', rat(1, 2), 62)]
    const m = mapNotes(notes, graphics)
    expect(m.report.unmappedNotes).toEqual([0])
    expect(m.report.unmappedGraphics).toEqual(['0:0:1:1/2:62'])
    expect(m.report.mapped).toBe(0)
  })
})
