/**
 * Library and Import in a real browser against the production build (spec "Main user journey"
 * 1–2, "MusicXML score import", "Deferred assets", "Import memory lifecycle"): the real import
 * worker, IndexedDB persistence across reloads, cancellation, and readable rejections.
 *
 * Set LIBRARY_SHOTS=<dir> to also save light/dark screenshots at iPad and phone sizes (visual
 * review, DECISIONS U8); the directory must be outside the repository.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { generateLongScore } from '../fixtures/generate-long-score'

const SCORES = fileURLToPath(new URL('../fixtures/scores/', import.meta.url))
const fixture = (name: string) => ({ name, mimeType: 'application/xml', buffer: readFileSync(join(SCORES, name)) })

async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator('label', { hasText: 'Import MusicXML' }).first().locator('input[type="file"]').setInputFiles(file)
}

const sheet = (page: Page) => page.locator('dialog[open]')

test('the library opens without the notation engine or the piano samples', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(requested.filter((u) => /opensheetmusicdisplay|osmd|vexflow|salamander|samples\/|\.mp3/i.test(u))).toEqual([])
})

test('adding a score opens Practice and starts Listen without a piano, and keeps it after a reload', async ({
  page,
}) => {
  await page.goto('./')
  await importFile(page, fixture('two-hands.musicxml'))
  await expect(sheet(page).getByRole('button', { name: 'Add to library' })).toBeEnabled()
  await expect(sheet(page)).toContainText('From the score')
  await sheet(page).getByRole('button', { name: 'Add to library' }).click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByText('“Two Hands” is in your library.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(page.locator('.pn-strip')).toBeVisible()
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
  await expect(page.getByText('1 piece.', { exact: false })).toBeVisible()
})

test('a score without a tempo needs one before it can be added', async ({ page }) => {
  await page.goto('./')
  await importFile(page, fixture('no-tempo.musicxml'))
  const add = sheet(page).getByRole('button', { name: 'Add to library' })
  await expect(add).toBeDisabled()
  await sheet(page).getByLabel('Beats per minute').fill('76')
  await expect(add).toBeEnabled()
  await add.click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByText('is in your library')).toBeVisible()
})

test('rejects unrelated XML with a readable explanation', async ({ page }) => {
  await page.goto('./')
  await importFile(page, fixture('unrelated.xml'))
  await expect(sheet(page)).toContainText('could not be imported')
  await expect(sheet(page)).toContainText(/MusicXML/)
})

test('canceling a long import closes it and nothing appears afterwards', async ({ page }) => {
  await page.goto('./')
  const xml = generateLongScore(3000)
  await importFile(page, { name: 'long.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) })
  const cancel = sheet(page).getByRole('button', { name: 'Cancel import' })
  await cancel.click()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  // Long enough for the canceled build to have finished had it kept running.
  await page.waitForTimeout(4000)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  // A new import works afterwards (the old worker was released).
  await importFile(page, fixture('two-hands.musicxml'))
  await expect(sheet(page).getByRole('button', { name: 'Add to library' })).toBeEnabled()
})

const SHOTS = process.env['LIBRARY_SHOTS']
const SIZES = [
  { name: 'ipad-landscape', width: 1180, height: 820 },
  { name: 'ipad-portrait', width: 820, height: 1180 },
  { name: 'phone', width: 360, height: 740 },
] as const

test.describe('visual review', () => {
  test.skip(!SHOTS, 'set LIBRARY_SHOTS=<dir outside the repo> to save screenshots')

  for (const scheme of ['light', 'dark'] as const) {
    test(`library screens in ${scheme}`, async ({ page, browserName }) => {
      const dir = join(SHOTS!, browserName)
      mkdirSync(dir, { recursive: true })
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.goto('./')
      const shot = async (label: string) => {
        for (const s of SIZES) {
          await page.setViewportSize({ width: s.width, height: s.height })
          await page.waitForTimeout(150)
          await page.screenshot({
            path: join(dir, `${label}-${s.name}-${scheme}.png`),
            fullPage: !label.includes('sheet'),
          })
        }
      }
      await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
      await shot('empty')

      await importFile(page, fixture('split-voice.musicxml'))
      await expect(sheet(page).getByRole('button', { name: 'Confirm hands' })).toBeVisible()
      await shot('sheet-hands')
      await sheet(page).getByRole('button', { name: 'Confirm hands' }).click()
      await sheet(page).getByRole('button', { name: 'Add to library' }).click()
      await expect(sheet(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to Library' }).click()
      await shot('saved')

      await importFile(page, fixture('no-tempo.musicxml'))
      await expect(sheet(page).getByLabel('Beats per minute')).toBeVisible()
      await sheet(page).getByLabel('Beats per minute').fill('5')
      await shot('sheet-tempo')
      await sheet(page).getByLabel('Beats per minute').fill('72')
      await sheet(page).getByRole('button', { name: 'Add to library' }).click()
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to Library' }).click()
      await shot('list')

      await page.getByRole('button', { name: 'Delete…' }).first().click()
      await shot('sheet-delete')
    })
  }
})
