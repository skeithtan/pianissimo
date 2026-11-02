/**
 * Respacing (DECISIONS R3 revised): Labels Off engraves the score tight (room for hints only);
 * All / Conditional engrave it with room for every name. Switching glides the notes to their new
 * places around the cursor: the cursor note stays put, the rest opens up or closes in.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { SHOT_DIR, installFakeMidi, openSeededPractice, seedPiece } from './practice-helpers'

/** Screen x of every notehead, left to right (first engraving of each note only). */
async function headXs(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const seen = new Set<string>()
    const xs: number[] = []
    for (const el of document.querySelectorAll('.pn-strip .pn-segs [data-n]')) {
      const n = el.getAttribute('data-n') ?? ''
      if (seen.has(n)) continue
      seen.add(n)
      const r = el.getBoundingClientRect()
      xs.push(r.left + r.width / 2)
    }
    return xs.sort((a, b) => a - b)
  })
}

const span = (xs: readonly number[]): number => xs.at(-1)! - xs[0]!

interface Glide {
  slices: number
  /** Note names riding along, and whether they fade in (names on) or out (off). */
  names: number
  fade: 'in' | 'out'
  /** ms from the click to the glide. */
  after: number
}

declare global {
  interface Window {
    /** Glides seen so far (each overlay lives for less than half a second). */
    __glides: Glide[]
    __clicked: number
    /** Engravings started (OSMD's hidden container appearing). */
    __engravings: number
  }
}

/** Records every respacing overlay as it appears. */
async function watchGlides(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__glides = []
    window.__clicked = 0
    window.__engravings = 0
    document.addEventListener('pointerdown', () => (window.__clicked = performance.now()), true)
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.style.left === '-200000px') window.__engravings++
          else if (n instanceof HTMLElement && n.classList.contains('pn-respace'))
            window.__glides.push({
              slices: n.querySelectorAll('.pn-respace-slice').length,
              names: n.querySelectorAll('.pn-respace-label').length,
              fade: n.classList.contains('pn-respace-in') ? 'in' : 'out',
              after: performance.now() - window.__clicked,
            })
    }).observe(document.body, { childList: true, subtree: true })
  })
}

const glides = (page: Page): Promise<Glide[]> => page.evaluate(() => window.__glides)
const engravings = (page: Page): Promise<number> => page.evaluate(() => window.__engravings)

test.describe('respacing between Labels Off and All', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
  })

  test('the notes glide apart around the cursor note for All, and back for Off', async ({ page }, info) => {
    await page.setViewportSize({ width: 1180, height: 820 })
    await seedPiece(page)
    await openSeededPractice(page)
    const group = page.getByRole('radiogroup', { name: 'Note names on the score' })
    const tight = await headXs(page)
    expect(tight.length).toBeGreaterThan(4)
    await watchGlides(page)

    await group.getByRole('radio', { name: 'All' }).click()
    // The glide: slices of the roomy engraving over the hidden notation, then gone.
    await expect.poll(() => glides(page)).toHaveLength(1)
    const open = (await glides(page))[0]!
    expect(open.slices).toBeGreaterThan(4)
    // The names fade in on the way, riding with their notes; the glide starts without delay.
    expect(open).toMatchObject({ fade: 'in' })
    expect(open.names).toBeGreaterThan(4)
    expect(open.after).toBeLessThan(250)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    await expect(page.locator('.pn-strip.pn-respacing')).toHaveCount(0)
    await expect(page.locator('.pn-label').first()).toBeVisible()
    const roomy = await headXs(page)
    expect(roomy).toHaveLength(tight.length)
    // The cursor note (the first one, under the cursor line) stays; the music opens up from it.
    expect(Math.abs(roomy[0]! - tight[0]!)).toBeLessThan(2)
    expect(span(roomy) / span(tight)).toBeGreaterThan(1.15)
    await page.screenshot({ path: join(SHOT_DIR, `respace-open-end-${info.project.name}.png`) })

    await group.getByRole('radio', { name: 'Off' }).click()
    // The notes close in at once (the layout is in memory); the names fade out on the way.
    await expect.poll(() => glides(page)).toHaveLength(2)
    const close = (await glides(page))[1]!
    expect(close.slices).toBeGreaterThan(4)
    expect(close).toMatchObject({ fade: 'out' })
    expect(close.names).toBeGreaterThan(4)
    expect(close.after).toBeLessThan(250)
    await expect(page.locator('.pn-label')).toHaveCount(0)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    test.info().annotations.push({ type: 'glides', description: JSON.stringify(await glides(page)) })
    const back = await headXs(page)
    expect(Math.abs(back[0]! - tight[0]!)).toBeLessThan(2)
    expect(Math.abs(span(back) - span(tight))).toBeLessThan(2)
  })

  test('the other spacing is prepared ahead while idle: the first switch engraves nothing', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await watchGlides(page)
    // A moment of idle: the roomy engraving is prepared in the background (or read from storage).
    await page.waitForTimeout(2500)
    const before = await engravings(page)
    // Seen being engraved in the background (a fresh browser context has nothing stored).
    expect(before).toBe(1)
    await page.getByRole('radiogroup', { name: 'Note names on the score' }).getByRole('radio', { name: 'All' }).click()
    await expect.poll(() => glides(page)).toHaveLength(1)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    expect(await engravings(page)).toBe(before)
    expect((await glides(page))[0]!.after).toBeLessThan(250)
  })
})
