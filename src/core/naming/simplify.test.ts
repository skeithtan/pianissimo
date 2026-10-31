import { describe, expect, it } from 'vitest'
import type { Step } from '../music/pitch'
import { spellingToMidi } from '../music/pitch'
import { normalizeSpelling, simplifySpelling, spellMidi } from './simplify'

const sp = (step: Step, alter: number, octave: number) => ({ step, alter, octave })

describe('simplifySpelling: spec table', () => {
  it.each([
    [sp('B', 1, 4), sp('C', 0, 5)],
    [sp('C', -1, 4), sp('B', 0, 3)],
    [sp('E', 1, 4), sp('F', 0, 4)],
    [sp('F', -1, 4), sp('E', 0, 4)],
    [sp('F', 2, 4), sp('G', 0, 4)],
    [sp('B', -2, 4), sp('A', 0, 4)],
  ])('%j -> %j', (input, expected) => {
    expect(simplifySpelling(input)).toEqual(expected)
  })
})

describe('simplifySpelling: double accidentals', () => {
  it.each([
    [sp('C', 2, 4), sp('D', 0, 4)],
    [sp('D', 2, 4), sp('E', 0, 4)],
    [sp('G', 2, 4), sp('A', 0, 4)],
    [sp('A', 2, 4), sp('B', 0, 4)],
    [sp('D', -2, 4), sp('C', 0, 4)],
    [sp('E', -2, 4), sp('D', 0, 4)],
    [sp('G', -2, 4), sp('F', 0, 4)],
    [sp('A', -2, 4), sp('G', 0, 4)],
  ])('white-key result is natural: %j -> %j', (input, expected) => {
    expect(simplifySpelling(input)).toEqual(expected)
  })

  it.each([
    // The result is a black key, so the original sharp/flat direction decides the name.
    [sp('E', 2, 4), sp('F', 1, 4)],
    [sp('B', 2, 4), sp('C', 1, 5)],
    [sp('F', -2, 4), sp('E', -1, 4)],
    [sp('C', -2, 4), sp('B', -1, 3)],
  ])('black-key result keeps direction: %j -> %j', (input, expected) => {
    expect(simplifySpelling(input)).toEqual(expected)
  })
})

describe('simplifySpelling: ordinary spellings are kept', () => {
  it.each([
    sp('C', 0, 4),
    sp('E', -1, 4),
    sp('C', 1, 4),
    sp('D', 1, 4),
    sp('F', 1, 3),
    sp('G', 1, 4),
    sp('A', 1, 4),
    sp('D', -1, 4),
    sp('G', -1, 4),
    sp('A', -1, 4),
    sp('B', -1, 4),
  ])('%j is unchanged', (input) => {
    expect(simplifySpelling(input)).toEqual(input)
  })

  it('never changes the piano key', () => {
    for (const step of ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const) {
      for (const alter of [-2, -1, 0, 1, 2]) {
        const input = sp(step, alter, 4)
        expect(spellingToMidi(simplifySpelling(input))).toBe(spellingToMidi(input))
      }
    }
  })

  it('produces only single accidentals and never B♯, C♭, E♯ or F♭', () => {
    for (const step of ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const) {
      for (const alter of [-2, -1, 0, 1, 2]) {
        const out = simplifySpelling(sp(step, alter, 4))
        expect(Math.abs(out.alter)).toBeLessThanOrEqual(1)
        if (out.alter === 1) expect(['B', 'E']).not.toContain(out.step)
        if (out.alter === -1) expect(['C', 'F']).not.toContain(out.step)
      }
    }
  })
})

describe('spellMidi', () => {
  it('spells white keys naturally and black keys by preference', () => {
    expect(spellMidi(60)).toEqual(sp('C', 0, 4))
    expect(spellMidi(61)).toEqual(sp('C', 1, 4))
    expect(spellMidi(61, 'flat')).toEqual(sp('D', -1, 4))
    expect(spellMidi(21)).toEqual(sp('A', 0, 0))
    expect(spellMidi(108)).toEqual(sp('C', 0, 8))
    expect(spellMidi(0)).toEqual(sp('C', 0, -1))
  })
})

describe('normalizeSpelling', () => {
  it('keeps supported alterations and respells unsupported ones to a piano key', () => {
    expect(normalizeSpelling(sp('C', 1, 4))).toEqual(sp('C', 1, 4))
    expect(normalizeSpelling(sp('C', 3, 4))).toEqual(sp('D', 1, 4))
    expect(normalizeSpelling(sp('C', -3, 4))).toEqual(sp('A', 0, 3))
    expect(normalizeSpelling(sp('C', 0.5, 4))).toEqual(sp('C', 1, 4))
  })
})
