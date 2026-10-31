import { describe, expect, it } from 'vitest'
import type { Step } from '../music/pitch'
import { contextAlter, keySignatureAlter } from './context'

describe('keySignatureAlter', () => {
  it('sharpens F C G D A E B in order', () => {
    const sharpSteps = (fifths: number) =>
      (['C', 'D', 'E', 'F', 'G', 'A', 'B'] as Step[]).filter((s) => keySignatureAlter(s, fifths) === 1)
    expect(sharpSteps(0)).toEqual([])
    expect(sharpSteps(1)).toEqual(['F'])
    expect(sharpSteps(2)).toEqual(['C', 'F'])
    expect(sharpSteps(7)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'])
  })

  it('flattens B E A D G C F in order', () => {
    const flatSteps = (fifths: number) =>
      (['C', 'D', 'E', 'F', 'G', 'A', 'B'] as Step[]).filter((s) => keySignatureAlter(s, fifths) === -1)
    expect(flatSteps(-1)).toEqual(['B'])
    expect(flatSteps(-3)).toEqual(['E', 'A', 'B'])
    expect(flatSteps(-7)).toHaveLength(7)
  })
})

describe('contextAlter', () => {
  it('uses the key signature when nothing is carried', () => {
    expect(contextAlter({ keyFifths: 2, carried: [] }, 'C', 4)).toBe(1)
    expect(contextAlter({ keyFifths: 2, carried: [] }, 'G', 4)).toBe(0)
  })

  it('prefers a carried accidental on the same step and written octave', () => {
    const ctx = { keyFifths: 0, carried: [['F', 4, 1]] as const }
    expect(contextAlter(ctx, 'F', 4)).toBe(1)
    expect(contextAlter(ctx, 'F', 5)).toBe(0)
    expect(contextAlter(ctx, 'G', 4)).toBe(0)
  })

  it('lets a carried natural cancel the key signature, and the latest entry win', () => {
    expect(contextAlter({ keyFifths: 1, carried: [['F', 4, 0]] }, 'F', 4)).toBe(0)
    expect(contextAlter({ keyFifths: 1, carried: [['F', 4, 0]] }, 'F', 5)).toBe(1)
    expect(
      contextAlter(
        {
          keyFifths: 0,
          carried: [
            ['F', 4, 1],
            ['F', 4, -1],
          ],
        },
        'F',
        4,
      ),
    ).toBe(-1)
  })
})
