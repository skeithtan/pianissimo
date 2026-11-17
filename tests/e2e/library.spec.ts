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
import { idbAll } from './app-helpers'
import { installFakeMidi } from './practice-helpers'

const SCORES = fileURLToPath(new URL('../fixtures/scores/', import.meta.url))
const fixture = (name: string) => ({ name, mimeType: 'application/xml', buffer: readFileSync(join(SCORES, name)) })

async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.locator('label', { hasText: 'Add score' }).first().locator('input[type="file"]').setInputFiles(file)
}

const sheet = (page: Page) => page.locator('dialog[open]')

test('the library opens without the notation engine or the piano samples', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(requested.filter((u) => /opensheetmusicdisplay|osmd|vexflow|salamander|samples\/|\.mp3/i.test(u))).toEqual([])
})

test('adding a score opens Practice ready to start without a piano, and keeps it after a reload', async ({ page }) => {
  await page.goto('./')
  await importFile(page, fixture('two-hands.musicxml'))
  await expect(sheet(page).getByRole('button', { name: 'Add and open' })).toBeEnabled()
  await expect(sheet(page)).toContainText('From the score')
  await sheet(page).getByRole('button', { name: 'Add and open' }).click()
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByText('“Two Hands” is in your library.')).toBeVisible()
  // Nothing starts by itself: Play through follows the microphone, which needs the user's own Start.
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect(page.locator('.pn-strip')).toBeVisible()
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(4)
})

test('adding a score with a connected piano also opens paused', async ({ page }) => {
  await installFakeMidi(page)
  await page.goto('./')
  await importFile(page, fixture('two-hands.musicxml'))
  await sheet(page).getByRole('button', { name: 'Add and open' }).click()
  await expect(page.locator('.pn-strip')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
})

test('the initial three pieces use ordinary actions and stay deleted after reload', async ({ page }) => {
  await page.goto('./')
  const titles = ['Ode to Joy', 'Für Elise', 'La Candeur, Op. 100 No. 1']
  for (const title of titles) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: `Practice ${title}`, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: `Study ${title}`, exact: true })).toBeVisible()
  }
  expect(await idbAll(page, 'pieces')).toHaveLength(3)
  await expect(page.locator('main')).not.toContainText(/sample/i)
  for (const title of titles) {
    const piece = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    await piece.getByRole('button', { name: `Options for ${title}`, exact: true }).click()
    await piece.getByRole('button', { name: 'Delete…' }).click()
    await sheet(page).getByRole('button', { name: 'Delete piece' }).click()
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  expect(await idbAll(page, 'pieces')).toHaveLength(0)
})

test('a tap anywhere on a row opens Practice, but not on Study, Options or inside the open menu', async ({ page }) => {
  await page.goto('./')
  const title = 'Ode to Joy'
  const row = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
  const view = page.locator('main')
  const hash = () => page.evaluate(() => location.hash)
  await expect(row).toContainText('Not opened yet')

  // Options opens its menu and stays in the Library.
  const options = row.getByRole('button', { name: `Options for ${title}`, exact: true })
  await options.click()
  const menu = row.getByRole('group', { name: `Manage ${title}` })
  await expect(menu).toBeVisible()
  await page.waitForTimeout(500) // long enough for a Practice navigation to have happened
  await expect(view).toHaveAttribute('data-view', 'library')
  expect(await hash()).toMatch(/^(#\/)?$/)
  // Empty space inside the open menu (its own padding, over the next row) does not open Practice.
  const box = (await menu.boundingBox())!
  await menu.click({ position: { x: 4, y: box.height - 12 } })
  await page.waitForTimeout(500)
  await expect(view).toHaveAttribute('data-view', 'library')
  expect(await hash()).toMatch(/^(#\/)?$/)
  // Chromium closes the menu there (focus moves to the page), WebKit keeps it: close it, since a
  // tap outside an open menu only closes it.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Study opens Study, not Practice.
  await row.getByRole('button', { name: `Study ${title}`, exact: true }).click()
  await expect(view).toHaveAttribute('data-view', 'study')
  expect(await hash()).toMatch(/^#\/study\//)
  await page.goBack()
  await expect(view).toHaveAttribute('data-view', 'library')
  await expect(row).toContainText('Opened just now')

  // A tap on the title text (under the row's stretched Practice target) opens Practice.
  const heading = (await row.getByRole('heading', { name: title, exact: true }).boundingBox())!
  await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2)
  await expect(view).toHaveAttribute('data-view', 'practice')
  expect(await hash()).toMatch(/^#\/practice\//)
})

const pieceRow = (page: Page, title: string) =>
  page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
/** The middle of a row's title: under the row's stretched Practice target. */
async function titleCenter(page: Page, title: string): Promise<{ x: number; y: number }> {
  const box = (await pieceRow(page, title).getByRole('heading', { name: title, exact: true }).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// An open menu drops over the right side of the rows below it, so these tests reach other rows'
// controls above it, or titles on the left.
test('a tap outside an open Options menu only closes it; the next tap opens the row', async ({ page }) => {
  await page.goto('./')
  const view = page.locator('main')
  await page.getByRole('button', { name: 'Options for Für Elise', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Manage Für Elise' })).toBeVisible()
  // Another row's Options button closes this menu and opens its own in the same tap.
  await page.getByRole('button', { name: 'Options for Ode to Joy', exact: true }).click()
  const menu = page.getByRole('group', { name: 'Manage Ode to Joy' })
  await expect(menu).toBeVisible()
  await expect(page.getByRole('group', { name: 'Manage Für Elise' })).toHaveCount(0)

  // The title area of another row: the menu closes and the Library stays.
  const other = await titleCenter(page, 'La Candeur, Op. 100 No. 1')
  await page.mouse.click(other.x, other.y)
  await expect(menu).toHaveCount(0)
  await page.waitForTimeout(500) // long enough for a Practice navigation to have happened
  await expect(view).toHaveAttribute('data-view', 'library')
  // Nothing was opened: every initial piece still reads "Not opened yet".
  const pieces = await idbAll<{ lastOpenedAt: number; createdAt: number }>(page, 'pieces')
  expect(pieces.filter((p) => p.lastOpenedAt > p.createdAt)).toEqual([])
  // With the menu closed, the same click opens Practice.
  await page.mouse.click(other.x, other.y)
  await expect(view).toHaveAttribute('data-view', 'practice')
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })

  test('a tap outside an open Options menu only closes it, with no late click', async ({ page }) => {
    await page.goto('./')
    const view = page.locator('main')
    const options = page.getByRole('button', { name: 'Options for Für Elise', exact: true })
    const menu = page.getByRole('group', { name: 'Manage Für Elise' })
    await options.tap()
    await expect(menu).toBeVisible()
    // On another row's Study button: only the menu closes.
    await page.getByRole('button', { name: 'Study Ode to Joy', exact: true }).tap()
    await expect(menu).toHaveCount(0)
    await page.waitForTimeout(700) // longer than any delayed touch click
    await expect(view).toHaveAttribute('data-view', 'library')

    // On another row's title: only the menu closes, then the next tap opens Practice.
    await options.tap()
    await expect(menu).toBeVisible()
    const other = await titleCenter(page, 'Ode to Joy')
    await page.touchscreen.tap(other.x, other.y)
    await expect(menu).toHaveCount(0)
    await page.waitForTimeout(700)
    await expect(view).toHaveAttribute('data-view', 'library')
    await page.touchscreen.tap(other.x, other.y)
    await expect(view).toHaveAttribute('data-view', 'practice')
  })
})

test('renaming a piece keeps the new name after a reload', async ({ page }) => {
  await page.goto('./')
  const piece = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Ode to Joy', exact: true }) })
  await piece.getByRole('button', { name: 'Options for Ode to Joy', exact: true }).click()
  await piece.getByRole('button', { name: 'Rename…' }).click()
  const title = sheet(page).getByLabel('Title')
  await expect(title).toHaveValue('Ode to Joy')
  // The title has focus with its text selected, so typing replaces it.
  await expect(title).toBeFocused()
  expect(await title.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 10])
  await page.keyboard.type('Freude')
  await sheet(page).getByLabel('Composer').fill('')
  await sheet(page).getByLabel('Composer').press('Enter')
  await expect(sheet(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 2, name: 'Freude', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Practice Freude', exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'Freude', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toHaveCount(0)
  const pieces = await idbAll<{ title: string; composer?: string }>(page, 'pieces')
  const renamed = pieces.find((p) => p.title === 'Freude')
  expect(renamed).toBeDefined()
  expect(renamed).not.toHaveProperty('composer')
})

test('a score without a tempo needs one before it can be added', async ({ page }) => {
  await page.goto('./')
  await importFile(page, fixture('no-tempo.musicxml'))
  const add = sheet(page).getByRole('button', { name: 'Add and open' })
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
  await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
  // A new import works afterwards (the old worker was released).
  await importFile(page, fixture('two-hands.musicxml'))
  await expect(sheet(page).getByRole('button', { name: 'Add and open' })).toBeEnabled()
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
      await expect(page.getByRole('heading', { name: 'Ode to Joy', exact: true })).toBeVisible()
      await shot('library')

      await importFile(page, fixture('split-voice.musicxml'))
      await expect(sheet(page).getByRole('button', { name: 'Confirm hands' })).toBeVisible()
      await shot('sheet-hands')
      await sheet(page).getByRole('button', { name: 'Confirm hands' }).click()
      await sheet(page).getByRole('button', { name: 'Add and open' }).click()
      await expect(sheet(page)).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to Library' }).click()
      await shot('saved')

      await importFile(page, fixture('no-tempo.musicxml'))
      await expect(sheet(page).getByLabel('Beats per minute')).toBeVisible()
      await sheet(page).getByLabel('Beats per minute').fill('5')
      await shot('sheet-tempo')
      await sheet(page).getByLabel('Beats per minute').fill('72')
      await sheet(page).getByRole('button', { name: 'Add and open' }).click()
      await expect(page.locator('dialog[open]')).toHaveCount(0)
      await page.getByRole('button', { name: 'Back to Library' }).click()
      await shot('list')

      await page
        .getByRole('button', { name: /^Options for / })
        .first()
        .click()
      await page.getByRole('button', { name: 'Delete…' }).first().click()
      await shot('sheet-delete')
    })
  }
})
