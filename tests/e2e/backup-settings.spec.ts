/**
 * Storage and recovery (spec "Storage and recovery"): an exported backup restores a deleted piece
 * together with its results, and settings survive a reload. Real downloads and real file inputs.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { idbAll, sheet, storedSettings } from './app-helpers'
import { installFakeMidi, loopWholePiece, openSeededPractice, play, playWhenDue, seedPiece } from './practice-helpers'

async function completeWithOneWrongNote(page: Page): Promise<void> {
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('ready')).toBeVisible()
  await play(page, 70) // one wrong attack
  await playWhenDue(page, 60, 48)
  for (const group of [[62], [64], [65], [67, 71, 74, 43]]) await playWhenDue(page, ...group)
  await playWhenDue(page, 48)
  await expect(page.getByTestId('attempt-result')).toContainText('1 wrong note')
}

test('export, delete the piece, restore the backup: the piece and its results are back', async ({ page }, info) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await completeWithOneWrongNote(page)
  await expect.poll(async () => (await idbAll(page, 'attempts')).length, { timeout: 15_000 }).toBe(1)

  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()

  // Export: a real download of the backup archive.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export backup' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.pianissimo\.zip$/)
  const backupPath = info.outputPath('backup.pianissimo.zip')
  await download.saveAs(backupPath)
  const bytes = readFileSync(backupPath)
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  await expect(page.getByText(/Backup saved as/)).toBeVisible()

  // Delete the piece (with its results).
  await page.getByRole('button', { name: 'Delete…' }).click()
  await sheet(page).getByRole('button', { name: 'Delete piece' }).click()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(0)
  expect(await idbAll(page, 'attempts')).toHaveLength(0)

  // Restore it from the downloaded file through the real file input.
  await page
    .locator('label', { hasText: 'Restore from backup' })
    .locator('input[type="file"]')
    .setInputFiles(backupPath)
  await expect(sheet(page)).toContainText('.pianissimo.zip')
  await sheet(page).getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(sheet(page)).toContainText('Backup restored.')
  await expect(sheet(page)).toContainText('Pieces: 1 added')
  await expect(sheet(page)).toContainText('Results: 1 added')
  await sheet(page).getByRole('button', { name: 'Done' }).click()

  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(1)
  expect(await idbAll(page, 'attempts')).toHaveLength(1)

  // The restored piece practices, and its restored attempt is in the same Results history.
  await openSeededPractice(page)
  // The restored piece remembers its last passage (bars 1–2): Repeat over the same loop.
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('ready')).toBeVisible()
  await playWhenDue(page, 60, 48)
  for (const group of [[62], [64], [65], [67, 71, 74, 43]]) await playWhenDue(page, ...group)
  await playWhenDue(page, 48)
  const card = page.getByTestId('attempt-result')
  await expect(card).toContainText('No wrong notes')
  await card.getByRole('button', { name: 'Details' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
  const history = page.locator('[data-panel="history"]')
  await expect(history.getByRole('heading', { name: 'Clean and unassisted' })).toBeVisible()
  // The restored attempt had one wrong note, which now shows a hint (S5): assisted practice.
  await expect(history.getByRole('heading', { name: 'Assisted practice' })).toBeVisible()
  await expect(history.locator('ul > li')).toHaveCount(2) // the restored attempt and the new one
})

test('restoring a file that is not a backup changes nothing and says why', async ({ page }, info) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await page
    .locator('label', { hasText: 'Restore from backup' })
    .locator('input[type="file"]')
    .setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('this is not a zip archive') })
  await sheet(page).getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(sheet(page)).toContainText('could not be restored')
  await expect(sheet(page)).toContainText('Nothing was changed')
  info.annotations.push({ type: 'note', description: 'validation errors are shown' })
  await sheet(page).locator('button', { hasText: 'Close' }).click()
  await expect(sheet(page)).toHaveCount(0)
  expect(await idbAll(page, 'pieces')).toHaveLength(0)
})

test.describe('settings survive a reload', () => {
  async function openSettings(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(sheet(page)).toBeVisible()
  }

  test('naming and theme settings are stored and still applied after reloading', async ({ page }) => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
    await openSettings(page)

    // Note names: fixed do with ti, no octave numbers.
    await sheet(page).getByRole('radio', { name: 'Fixed do' }).click()
    await sheet(page).getByRole('radio', { name: 'ti' }).click()
    await sheet(page)
      .getByRole('switch', { name: /Show octave number/ })
      .uncheck()
    const examples = sheet(page).getByLabel('Example labels')
    await expect(examples).toContainText('do')
    const exampleTexts = await examples.locator('strong').allTextContents()

    // Theme: dark.
    await sheet(page).getByRole('tab', { name: 'General' }).click()
    await sheet(page).getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // Settings are written after a short debounce: wait for the stored record, not a timeout.
    await expect
      .poll(async () => {
        const s = await storedSettings(page)
        return s ? [s['naming'].system, s['naming'].seventh, s['naming'].showOctave, s['view'].theme] : null
      })
      .toEqual(['fixed-do', 'ti', false, 'dark'])

    await page.reload() // Settings is part of the URL (#/?settings), so a reload reopens it
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(sheet(page)).toBeVisible()
    await expect(sheet(page).getByRole('radio', { name: 'Fixed do' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet(page).getByRole('radio', { name: 'ti' })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet(page).getByRole('switch', { name: /Show octave number/ })).not.toBeChecked()
    expect(await sheet(page).getByLabel('Example labels').locator('strong').allTextContents()).toEqual(exampleTexts)
    await sheet(page).getByRole('tab', { name: 'General' }).click()
    await expect(sheet(page).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  })

  test('the Labels mode chosen in Practice is remembered after a reload', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    const all = page.getByRole('radiogroup', { name: 'Note names on the score' }).getByRole('radio', { name: 'All' })
    await all.click()
    await expect(all).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await storedSettings(page))?.['labels'].mode).toBe('all')

    await page.reload() // the URL names the piece (#/practice/<id>), so the reload reopens it
    await expect(page.locator('h1', { hasText: 'Two Hands' })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
    await expect(
      page.getByRole('radiogroup', { name: 'Note names on the score' }).getByRole('radio', { name: 'All' }),
    ).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.pn-label').first()).toBeVisible()
  })
})
