/**
 * The Metronome switch (DECISIONS U87, P20) in the real app: the Practice menu's row and the Study
 * menu's row (U90), which preference each edits, and the clicks themselves. With the fake MIDI piano and both
 * hands selected the app makes no other browser sound, so the metronome's oscillators are the
 * clicks: a wrapper around `AudioContext.prototype.createOscillator` counts them.
 */
import { expect, test, type Page } from '@playwright/test'
import { storedSettings } from './app-helpers'
import { installFakeMidi, openFooterMenu, openSeededPractice, seedPiece } from './practice-helpers'

declare global {
  interface Window {
    __clicks: number
  }
}

/** Counts every oscillator any AudioContext creates, on `window.__clicks`. */
async function countOscillators(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__clicks = 0
    const proto = window.AudioContext?.prototype
    if (!proto) return
    const create = proto.createOscillator
    proto.createOscillator = function (this: AudioContext) {
      window.__clicks++
      return create.call(this)
    }
  })
}

const clicks = (page: Page) => page.evaluate(() => window.__clicks)

async function metronomeSwitch(page: Page) {
  const menu = await openFooterMenu(page)
  return menu.getByRole('switch', { name: 'Metronome' })
}

async function keepTimeSwitch(page: Page) {
  const menu = await openFooterMenu(page)
  return menu.getByRole('switch', { name: 'Keep time' })
}

test.describe('Practice Metronome switch', () => {
  test.beforeEach(async ({ page }) => {
    await countOscillators(page)
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
  })

  test('is off by default, reads the Keep time preference in Keep time and leaves the general one alone', async ({
    page,
  }) => {
    const metronome = await metronomeSwitch(page)
    await expect(metronome).not.toBeChecked()
    // Keep time's own preference is on by default.
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).toBeChecked()
    // Turn it off there: it stays off after Keep time goes off and on again.
    await metronome.click()
    await expect(metronome).not.toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    // The general preference (Keep time off) was never touched.
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
    // And turning the general one on does not change Keep time's.
    await metronome.click()
    await expect(metronome).toBeChecked()
    await (await keepTimeSwitch(page)).click()
    await expect(metronome).not.toBeChecked()
  })

  test('Keep time clicks through the attempt after the count-in; with the switch off only the count-in clicks', async ({
    page,
  }) => {
    await (await keepTimeSwitch(page)).click()
    await expect(await metronomeSwitch(page)).toBeChecked()
    await page.keyboard.press('Escape')
    expect(await clicks(page)).toBe(0)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await expect.poll(() => clicks(page)).toBeGreaterThanOrEqual(4)
    // The attempt keeps adding clicks once the one-bar count-in (4 s at 60 BPM) is over.
    await expect(page.getByTestId('count-in')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => clicks(page), { timeout: 10_000 }).toBeGreaterThan(4)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()

    // Off in Keep time: the count-in still clicks, nothing after it.
    const metronome = await metronomeSwitch(page)
    await metronome.click()
    await expect(metronome).not.toBeChecked()
    await page.keyboard.press('Escape')
    const before = await clicks(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await expect(page.getByTestId('count-in')).toHaveCount(0, { timeout: 10_000 })
    await page.waitForTimeout(1500)
    expect((await clicks(page)) - before).toBe(4)
  })

  test('ordinary reading with the switch off creates no click', async ({ page }) => {
    await expect(await metronomeSwitch(page)).not.toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await clicks(page)).toBe(0)
  })

  test('turning it on in ordinary reading saves the general preference', async ({ page }) => {
    const metronome = await metronomeSwitch(page)
    await metronome.click()
    await expect(metronome).toBeChecked()
    await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ enabled: true })
  })
})

test.describe('Study Metronome switch', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

  test("toggles in the tablet footer's Study menu (U90)", async ({ page }) => {
    await seedPiece(page)
    await page.getByRole('button', { name: 'Study Two Hands' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
    await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('study-screen').locator('footer').getByRole('button', { name: 'Menu', exact: true }).click()
    const metronome = page.getByRole('dialog', { name: 'Study menu' }).getByRole('switch', { name: 'Metronome' })
    await expect(metronome).not.toBeChecked()
    await metronome.click()
    await expect(metronome).toBeChecked()
    await expect.poll(async () => (await storedSettings(page))?.['metronome']).toMatchObject({ enabled: true })
    await metronome.click()
    await expect(metronome).not.toBeChecked()
  })
})
