import { describe, expect, it } from 'vitest'
import { CHIP_WORDS_PX, TITLE_MIN_PX, chipFits, choiceFits } from './modeFit'

/** Back, the four modes in English, and a header of a tablet upright (834 px less its padding). */
const HEADER = { inner: 794, back: 48, choice: 296, take: 0 }

describe('choiceFits', () => {
  it('needs the same room on both sides of the centered modes', () => {
    const start = 48 + 6 + TITLE_MIN_PX
    expect(choiceFits({ ...HEADER, inner: 2 * (start + 12) + 296 })).toBe(true)
    expect(choiceFits({ ...HEADER, inner: 2 * (start + 12) + 295 })).toBe(false)
  })

  it('counts a take in full, beside the chip as its dot and Settings', () => {
    const end = 170 + 8 + 48 + 8 + 48
    expect(choiceFits({ ...HEADER, take: 170, inner: 2 * (end + 12) + 296 })).toBe(true)
    expect(choiceFits({ ...HEADER, take: 170 })).toBe(false)
    expect(choiceFits(HEADER)).toBe(true)
  })

  it('a language with long mode names runs out of room first', () => {
    expect(choiceFits({ ...HEADER, choice: 449, inner: 704 })).toBe(false)
    expect(choiceFits({ ...HEADER, choice: 345, inner: 704 })).toBe(true)
  })
})

describe('chipFits', () => {
  it('keeps the words while enough of them show', () => {
    expect(chipFits(CHIP_WORDS_PX + 56, 0)).toBe(true)
    expect(chipFits(CHIP_WORDS_PX + 55, 0)).toBe(false)
    expect(chipFits(CHIP_WORDS_PX + 56 + 178, 170)).toBe(true)
    expect(chipFits(CHIP_WORDS_PX + 56 + 177, 170)).toBe(false)
  })
})
