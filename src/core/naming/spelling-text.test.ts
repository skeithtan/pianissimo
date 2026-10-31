import { describe, expect, it } from 'vitest'
import type { Spelling, Step } from '../music/pitch'
import { formatSpelling, parseSpelling } from './spelling-text'

const sp = (step: Step, alter: number, octave: number): Spelling => ({ step, alter, octave })

describe('parseSpelling: accepted forms', () => {
  it.each([
    ['C4', sp('C', 0, 4)],
    ['c4', sp('C', 0, 4)],
    ['C#4', sp('C', 1, 4)],
    ['C♯4', sp('C', 1, 4)],
    ['Bb3', sp('B', -1, 3)],
    ['B♭3', sp('B', -1, 3)],
    ['bb3', sp('B', -1, 3)],
    ['b3', sp('B', 0, 3)],
    ['Cx4', sp('C', 2, 4)],
    ['CX4', sp('C', 2, 4)],
    ['C##4', sp('C', 2, 4)],
    ['C𝄪4', sp('C', 2, 4)],
    ['C♯♯4', sp('C', 2, 4)],
    ['Ebb4', sp('E', -2, 4)],
    ['E𝄫4', sp('E', -2, 4)],
    ['B♮3', sp('B', 0, 3)],
    ['do#4', sp('C', 1, 4)],
    ['Do♯4', sp('C', 1, 4)],
    ['sol4', sp('G', 0, 4)],
    ['re4', sp('D', 0, 4)],
    ['mib5', sp('E', -1, 5)],
    ['fa#3', sp('F', 1, 3)],
    ['la2', sp('A', 0, 2)],
    ['si3', sp('B', 0, 3)],
    ['ti3', sp('B', 0, 3)],
    ['sib3', sp('B', -1, 3)],
    ['  C  #  4 ', sp('C', 1, 4)],
    ['A0', sp('A', 0, 0)],
    ['C-1', sp('C', 0, -1)],
    ['G9', sp('G', 0, 9)],
    ['B#3', sp('B', 1, 3)],
  ])('%s', (text, expected) => {
    expect(parseSpelling(text)).toEqual({ ok: true, spelling: expected })
  })
})

describe('parseSpelling: clear errors', () => {
  const errorFor = (text: string): string => {
    const result = parseSpelling(text)
    if (result.ok) throw new Error(`Expected "${text}" to fail`)
    return result.error
  }

  it('asks for something when empty', () => {
    expect(errorFor('')).toMatch(/Enter a pitch/u)
    expect(errorFor('   ')).toMatch(/Enter a pitch/u)
  })

  it('requires an octave', () => {
    expect(errorFor('C')).toMatch(/octave/u)
    expect(errorFor('F#')).toMatch(/octave/u)
  })

  it('rejects unknown note names', () => {
    expect(errorFor('H4')).toMatch(/not a note name/u)
    expect(errorFor('x4')).toMatch(/Could not read|not a note name/u)
  })

  it('rejects mixed or excessive accidentals', () => {
    expect(errorFor('C#b4')).toMatch(/sharps or flats, not both/u)
    expect(errorFor('C###4')).toMatch(/At most two/u)
    expect(errorFor('Cbbb4')).toMatch(/At most two/u)
    expect(errorFor('C♮#4')).toMatch(/natural/u)
  })

  it('rejects unknown accidentals and trailing junk', () => {
    expect(errorFor('Ca4')).toMatch(/not an accidental/u)
    expect(errorFor('C4x')).toBeTruthy()
    expect(errorFor('4')).toMatch(/Could not read/u)
    expect(errorFor('C4.5')).toBeTruthy()
  })

  it('rejects pitches outside the MIDI range', () => {
    expect(errorFor('C10')).toMatch(/outside the MIDI range/u)
    expect(errorFor('Cb-1')).toMatch(/outside the MIDI range/u)
  })
})

describe('formatSpelling', () => {
  it('writes letter, glyph and octave', () => {
    expect(formatSpelling(sp('C', 0, 4))).toBe('C4')
    expect(formatSpelling(sp('C', 1, 5))).toBe('C♯5')
    expect(formatSpelling(sp('B', -1, 3))).toBe('B♭3')
    expect(formatSpelling(sp('F', 2, 4))).toBe('F𝄪4')
    expect(formatSpelling(sp('E', -2, 4))).toBe('E𝄫4')
  })

  it('round-trips through parseSpelling', () => {
    for (const alter of [-2, -1, 0, 1, 2]) {
      const s = sp('D', alter, 3)
      expect(parseSpelling(formatSpelling(s))).toEqual({ ok: true, spelling: s })
    }
  })
})
