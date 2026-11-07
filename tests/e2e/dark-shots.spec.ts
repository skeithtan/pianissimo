/**
 * Dark-mode screenshots of the Library, Practice and Results for visual review (DECISIONS U8:
 * dark mode everywhere). Skipped unless APP_SHOTS=<directory outside the repository> is set;
 * files land in <dir>/<browser>/<screen>-<size>-dark.png.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import {
  installFakeMidi,
  loopWholePiece,
  openSeededPractice,
  play,
  playWhenDue,
  seedPiece,
  setShowKeys,
} from './practice-helpers'

const SHOTS = process.env['APP_SHOTS']
const SIZES = [
  { name: 'ipad-landscape', width: 1180, height: 820 },
  { name: 'ipad-portrait', width: 820, height: 1180 },
] as const

test.describe('dark mode screenshots', () => {
  test.skip(!SHOTS, 'set APP_SHOTS=<dir outside the repo> to save screenshots')

  test('library, practice and results in dark mode', async ({ page, browserName }) => {
    const dir = join(SHOTS!, browserName)
    mkdirSync(dir, { recursive: true })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await installFakeMidi(page)
    await seedPiece(page, {
      view: { ...DEFAULT_SETTINGS.view, theme: 'dark' },
      labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' },
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Resizing across orientations interrupts a scored attempt, so a live attempt is shot in
    // landscape only; screens with nothing running are shot at every size.
    const shot = async (label: string, sizes: readonly (typeof SIZES)[number][] = SIZES) => {
      for (const s of sizes) {
        await page.setViewportSize({ width: s.width, height: s.height })
        await page.waitForTimeout(400) // layout and color transitions settle
        await page.screenshot({ path: join(dir, `${label}-${s.name}-dark.png`) })
      }
    }

    await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
    await shot('library')
    await page.setViewportSize(SIZES[0]) // practice in landscape; the later shots may rotate
    await openSeededPractice(page)
    await setShowKeys(page)
    await loopWholePiece(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('ready')).toBeVisible()
    await expect(page.locator('.pn-label').first()).toBeVisible()
    await play(page, 70) // a wrong key, so damage feedback and hint state are on screen too
    await shot('practice', [SIZES[0]])

    await playWhenDue(page, 60, 48)
    for (const group of [[62], [64], [65], [67, 71, 74, 43]]) await playWhenDue(page, ...group)
    await playWhenDue(page, 48)
    const card = page.getByTestId('attempt-result')
    await expect(card).toBeVisible()
    await shot('practice-result')

    await card.getByRole('button', { name: 'Details' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
    await expect(page.getByRole('heading', { level: 2, name: 'Latest attempt' })).toBeVisible()
    await shot('results')
  })
})
