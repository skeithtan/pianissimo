/**
 * Screenshots of the Library, Settings and Connection modal in both themes, for visual review
 * of the palette (DECISIONS A9, A12). Skipped unless APP_SHOTS=<directory outside the
 * repository> is set; files land in <dir>/<browser>/<theme>/<screen>.png.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { installFakeMidi, seedPiece } from './practice-helpers'

const SHOTS = process.env['APP_SHOTS']
const SIZE = { width: 1180, height: 820 }

test.describe('palette screenshots', () => {
  test.skip(!SHOTS, 'set APP_SHOTS=<dir outside the repo> to save screenshots')

  for (const theme of ['light', 'dark'] as const) {
    test(theme, async ({ page, browserName }) => {
      const dir = join(SHOTS!, browserName, theme)
      mkdirSync(dir, { recursive: true })
      await page.setViewportSize(SIZE)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await installFakeMidi(page)
      await seedPiece(page, {
        view: { ...DEFAULT_SETTINGS.view, theme },
        labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' },
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      const shot = async (name: string) => {
        await page.waitForTimeout(450) // transitions and fades settle
        await page.screenshot({ path: join(dir, `${name}.png`) })
      }

      await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
      await shot('library')

      await page.getByRole('button', { name: 'Settings' }).click()
      await page.locator('dialog[open]').getByRole('tab', { name: 'General' }).click()
      await shot('settings-general')
      await page.keyboard.press('Escape')
      await expect(page.locator('dialog[open]')).toHaveCount(0)

      await page.getByRole('button', { name: /^MIDI status/ }).click()
      await expect(page.locator('dialog[open]').getByRole('navigation', { name: 'Setup steps' })).toBeVisible()
      await shot('connection-modal')
      await page.keyboard.press('Escape')
      await expect(page.locator('dialog[open]')).toHaveCount(0)
    })
  }
})
