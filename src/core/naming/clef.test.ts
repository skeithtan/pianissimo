import { describe, expect, it } from 'vitest'
import { diatonicIndex } from '../music/pitch'
import { clefDisplayName, clefMiddleLineIndex, clefShortName, parseClefKey, stepFromDiatonicIndex } from './clef'

describe('clef names', () => {
  it.each([
    ['G2', 'Treble (G)'],
    ['F4', 'Bass (F)'],
    ['C3', 'Alto (C3)'],
    ['C4', 'Tenor (C4)'],
    ['C1', 'Soprano (C1)'],
    ['C2', 'Mezzo-soprano (C2)'],
    ['F3', 'Baritone (F3)'],
    ['G1', 'French violin (G1)'],
    ['G2-8', 'Treble 8vb (G)'],
    ['G2-1', 'Treble 8vb (G)'],
    ['G2+8', 'Treble 8va (G)'],
    ['F4-15', 'Bass 15mb (F)'],
    ['percussion', 'percussion'],
  ])('%s -> %s', (key, expected) => {
    expect(clefDisplayName(key)).toBe(expected)
  })

  it('gives short names for sentences', () => {
    expect(clefShortName('G2')).toBe('Treble')
    expect(clefShortName('F4')).toBe('Bass')
    expect(clefShortName('C3')).toBe('Alto')
    expect(clefShortName('C5')).toBe('Baritone')
  })

  it('names a non-standard line without inventing a name', () => {
    expect(clefDisplayName('G3')).toBe('G-clef line 3 (G3)')
    expect(clefDisplayName('F1')).toBe('F-clef line 1 (F1)')
  })
})

describe('parseClefKey and middle line', () => {
  it('parses sign, line and octave change', () => {
    expect(parseClefKey('G2')).toEqual({ sign: 'G', line: 2, octaveChange: 0 })
    expect(parseClefKey('G2-8')).toEqual({ sign: 'G', line: 2, octaveChange: -1 })
    expect(parseClefKey('F4+15')).toEqual({ sign: 'F', line: 4, octaveChange: 2 })
    expect(parseClefKey('none')).toBeNull()
  })

  it('finds the sounding pitch on the middle line', () => {
    const note = (index: number | null) => (index === null ? null : stepFromDiatonicIndex(index))
    expect(note(clefMiddleLineIndex('G2'))).toEqual({ step: 'B', octave: 4 })
    expect(note(clefMiddleLineIndex('F4'))).toEqual({ step: 'D', octave: 3 })
    expect(note(clefMiddleLineIndex('C3'))).toEqual({ step: 'C', octave: 4 })
    expect(note(clefMiddleLineIndex('C4'))).toEqual({ step: 'A', octave: 3 })
    expect(note(clefMiddleLineIndex('G2-8'))).toEqual({ step: 'B', octave: 3 })
    expect(clefMiddleLineIndex('G2')).toBe(diatonicIndex({ step: 'B', octave: 4 }))
    expect(clefMiddleLineIndex('percussion')).toBeNull()
  })
})
