/**
 * Note-label font (DECISIONS R14, revised): labels draw in the bundled Inter Bold, and the
 * accidentals in the bundled Noto Music in every engine. Both faces share the label weight;
 * Chromium joins unicode-range faces only when their weights match, and used to draw ♯ ♭ ♮ from a
 * system font (wider), measuring label boxes with it too.
 *
 * The advances are measured at 100 × the label size (R14 addendum): Linux Chromium (FreeType,
 * device scale factor 1, no subpixel positioning) rounds every glyph advance to whole pixels, so
 * at 13.5 px the bundled faces measure 9 for the digit 4 (9.13) and 5 for ♯ (4.388), while a
 * system fallback is tenths of a pixel to pixels away. At 1350 px the rounding is at most one
 * pixel, a hundredth of a pixel back at label size, and a fallback stays as far off as before.
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
const LABEL_PX = 13.5
const SCALE = 100
/** Whole-pixel rounding at 1350 px, plus hinting slack, scaled back to label size. */
const TOLERANCE_PX = 0.03

test('labels measure and draw in the bundled Inter Bold and Noto Music accidentals', async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  const widths = await page.evaluate(
    async ({ chars, px }) => {
      const font = `700 ${px}px "Pianissimo Label", system-ui, sans-serif`
      await document.fonts.load(font, chars.join(''))
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.font = font
      return Object.fromEntries(chars.map((c) => [c, ctx.measureText(c).width]))
    },
    { chars: Object.keys(EXPECTED), px: LABEL_PX * SCALE },
  )
  for (const [c, w] of Object.entries(EXPECTED)) {
    const measured = widths[c]! / SCALE
    expect(Math.abs(measured - w), `advance of ${c}: ${measured.toFixed(3)} px, expected ${w}`).toBeLessThan(
      TOLERANCE_PX,
    )
  }
})
