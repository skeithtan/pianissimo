/**
 * Note-label font (DECISIONS R14, revised): labels draw in the bundled Inter Bold, and the
 * accidentals in the bundled Noto Music in every engine. Both faces share the label weight;
 * Chromium joins unicode-range faces only when their weights match, and used to draw ♯ ♭ ♮ from a
 * system font (wider), measuring label boxes with it too.
 */
import { expect, test } from '@playwright/test'
import { installFakeMidi, openSeededPractice, seedPiece } from './practice-helpers'

/** Advances at 13.5 px from the bundled files (hmtx / unitsPerEm × 13.5). */
const EXPECTED: Record<string, number> = {
  C: 9.987,
  G: 10.132,
  '4': 9.13,
  '♯': 4.388,
  '♭': 4.037,
  '♮': 3.726,
  '\u{1D12A}': 4.86,
  '\u{1D12B}': 6.304,
}

test('labels measure and draw in the bundled Inter Bold and Noto Music accidentals', async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  const widths = await page.evaluate(async (chars) => {
    const font = '700 13.5px "Pianissimo Label", system-ui, sans-serif'
    await document.fonts.load(font, chars.join(''))
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = font
    return Object.fromEntries(chars.map((c) => [c, ctx.measureText(c).width]))
  }, Object.keys(EXPECTED))
  for (const [c, w] of Object.entries(EXPECTED)) expect(widths[c], `advance of ${c}`).toBeCloseTo(w, 1)
})
