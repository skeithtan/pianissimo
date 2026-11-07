/**
 * Practice screen screenshots for visual review (DECISIONS U8, U12–U14): idle, Repeat mode and
 * playing (chrome receded, keyboard guide open with held keys) at iPad landscape, iPad portrait
 * and phone width, light and dark. Skipped unless PRACTICE_SHOTS=<directory outside the
 * repository> is set; files land in <dir>/<browser>/<state>-<size>-<theme>.png.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { installFakeMidi, playWhenDue, seedPiece, setShowKeys, waitForOnset } from './practice-helpers'

const SHOTS = process.env['PRACTICE_SHOTS']
const SIZES = [
  { name: 'ipad-landscape', width: 1180, height: 820 },
  { name: 'ipad-portrait', width: 820, height: 1180 },
  { name: 'phone', width: 360, height: 780 },
] as const
const THEMES = ['light', 'dark'] as const

test.describe('practice screenshots', () => {
  test.skip(!SHOTS, 'set PRACTICE_SHOTS=<dir outside the repo> to save screenshots')

  for (const theme of THEMES) {
    for (const size of SIZES) {
      test(`${size.name} ${theme}`, async ({ page, browserName }) => {
        const dir = join(SHOTS!, browserName)
        mkdirSync(dir, { recursive: true })
        const shot = (state: string) => page.screenshot({ path: join(dir, `${state}-${size.name}-${theme}.png`) })
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.emulateMedia({ colorScheme: theme })
        await installFakeMidi(page)
        await seedPiece(page, { view: { ...DEFAULT_SETTINGS.view, theme } })
        // Hold engraving's first download to review the real preparation state deterministically.
        let release!: () => void
        const download = new Promise<void>((resolve) => (release = resolve))
        await page.route('**/opensheetmusicdisplay.min-*.js', async (route) => {
          await download
          await route.continue()
        })
        await page.getByRole('button', { name: 'Practice Two Hands' }).click()
        const skeleton = page.getByTestId('score-skeleton')
        try {
          await expect(skeleton).toBeVisible()
          await shot('preparing')
          if (size.name === 'phone') {
            await page.emulateMedia({ reducedMotion: 'reduce' })
            await expect(skeleton.locator('[aria-hidden="true"]')).toHaveCSS('animation-name', 'none')
            await shot('preparing-reduced-motion')
            await page.emulateMedia({ reducedMotion: 'no-preference' })
          }
        } finally {
          release()
        }
        await expect(skeleton).toHaveCount(0, { timeout: 60_000 })
        await expect(page.locator('.pn-strip')).toBeVisible()
        await page.waitForTimeout(400)
        await shot('idle')

        await page.getByRole('button', { name: 'Repeat from here' }).click()
        await expect(page.getByTestId('repeat-controls')).toBeVisible()
        await page.waitForTimeout(400)
        await shot('repeat')
        await page.getByTestId('repeat-controls').getByRole('button', { name: 'Clear loop', exact: true }).click()

        await setShowKeys(page)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await playWhenDue(page, 60, 48)
        await waitForOnset(page, 62)
        await page.evaluate(() => {
          window.__midi.on(62)
          window.__midi.on(67) // a wrong key, held
        })
        await expect(page.locator('[data-recede="true"]')).toHaveCount(1, { timeout: 5000 })
        await page.waitForTimeout(800) // the fade-out finishes
        await shot('playing')
      })
    }
  }
})
