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
import { installFakeMidi, openSeededPractice, playWhenDue, seedPiece, waitForOnset } from './practice-helpers'

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
        await openSeededPractice(page)
        await page.waitForTimeout(400)
        await shot('idle')

        await page.getByRole('button', { name: 'Repeat from here' }).click()
        await expect(page.getByTestId('repeat-controls')).toBeVisible()
        await page.waitForTimeout(400)
        await shot('repeat')
        await page.getByRole('button', { name: 'Clear passage selection' }).click()

        await page.getByRole('button', { name: 'Show keys' }).click()
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
