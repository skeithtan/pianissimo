/**
 * URL routing (hash routes under the Pages base path) and the Connection setup modal: the URL
 * follows the screen, Back/Forward behave, reloads and deep links reopen what they name, and the
 * overlays (Connection, Settings) are history entries that Back and Escape close.
 */
import { expect, test, type Page } from '@playwright/test'
import { installFakeMidi, PIECE_ID, seedPiece } from './practice-helpers'

const hash = (page: Page) => page.evaluate(() => location.hash)
const openDialog = (page: Page) => page.locator('dialog[open]')
/** A dialog by name: a sheet that is fading out is still `[open]` for a moment. */
const dialog = (page: Page, name: string) => page.getByRole('dialog', { name })
/** A cold load of the Practice chunk (engine, renderer) is slow on WebKit: wait like the practice specs do. */
const COLD = { timeout: 60_000 }
const pieceHeading = (page: Page) => page.locator('h1', { hasText: 'Two Hands' })

test.beforeEach(async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()
})

test('opening a piece changes the URL; Back and Forward walk the pages', async ({ page }) => {
  await page.getByRole('button', { name: 'Practice Two Hands' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
  expect(await hash(page)).toBe(`#/practice/${PIECE_ID}`)

  await page.goBack()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
  expect(await hash(page)).toMatch(/^(#\/)?$/)
  await expect(page.getByRole('heading', { level: 2, name: 'Two Hands' })).toBeVisible()

  await page.goForward()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
  await expect(pieceHeading(page)).toBeVisible(COLD)
})

test('reloading a practice URL reopens that piece; an unknown piece shows the empty state', async ({ page }) => {
  await page.goto(`./#/practice/${PIECE_ID}`)
  await page.reload()
  await expect(pieceHeading(page)).toBeVisible(COLD)
  expect(await hash(page)).toBe(`#/practice/${PIECE_ID}`)

  await page.goto('./#/practice/no-such-piece')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Can’t open this piece' })).toBeVisible(COLD)
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
  expect(await hash(page)).toBe('#/')
})

test('results have their own URL and survive a reload', async ({ page }) => {
  await page.goto(`./#/results/${PIECE_ID}`)
  await page.reload()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
})

test('the connection chip opens a large modal over the Library; Back closes it', async ({ page }) => {
  await page.getByRole('button', { name: /^MIDI status/ }).click()
  await expect(openDialog(page)).toHaveAttribute('aria-label', 'Connection and Pedal Setup')
  await expect(openDialog(page).getByRole('heading', { name: 'Step 1: Your piano', exact: true })).toBeVisible()
  expect(await hash(page)).toBe('#/?connection')
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library') // not another page

  await page.goBack()
  await expect(openDialog(page)).toHaveCount(0)
  expect(await hash(page)).toMatch(/^(#\/)?$/)
  await page.goForward()
  await expect(openDialog(page)).toHaveAttribute('aria-label', 'Connection and Pedal Setup')
})

test('Escape and the close button close the modal and leave history where it was', async ({ page }) => {
  const entries = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: /^MIDI status/ }).click()
  await expect(openDialog(page)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(openDialog(page)).toHaveCount(0)
  expect(await hash(page)).toMatch(/^(#\/)?$/)

  await page.getByRole('button', { name: /^MIDI status/ }).click()
  await openDialog(page).getByRole('button', { name: 'Close' }).click()
  await expect(openDialog(page)).toHaveCount(0)
  // Each open/close pair went forward then back: no pile of entries.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(entries + 1)
})

test('the connection modal opens over Practice and leaves the piece in place', async ({ page }) => {
  await page.goto(`./#/practice/${PIECE_ID}`)
  await page.reload()
  await expect(pieceHeading(page)).toBeVisible(COLD)
  await page.getByRole('button', { name: /^MIDI status/ }).click()
  await expect(openDialog(page)).toHaveAttribute('aria-label', 'Connection and Pedal Setup')
  expect(await hash(page)).toBe(`#/practice/${PIECE_ID}?connection`)
  await page.goBack()
  await expect(openDialog(page)).toHaveCount(0)
  await expect(pieceHeading(page)).toBeVisible(COLD)
})

test('#/connection is a deep link to the modal over the Library', async ({ page }) => {
  await page.goto('./#/connection')
  await page.reload()
  await expect(openDialog(page)).toHaveAttribute('aria-label', 'Connection and Pedal Setup')
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
  expect(await hash(page)).toBe('#/?connection')
  await page.keyboard.press('Escape')
  await expect(openDialog(page)).toHaveCount(0)
  expect(await hash(page)).toBe('#/')
})

test('Settings is a history entry too', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(openDialog(page)).toHaveAttribute('aria-label', 'Settings')
  expect(await hash(page)).toBe('#/?settings')
  await page.goBack()
  await expect(openDialog(page)).toHaveCount(0)
})

test('Set up in Connection swaps Settings for the Connection modal', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await openDialog(page).getByRole('tab', { name: 'Pedal' }).click()
  await openDialog(page).getByRole('button', { name: 'Set up in Connection' }).click()
  await expect(dialog(page, 'Connection and Pedal Setup')).toBeVisible()
  await expect(dialog(page, 'Settings')).toHaveCount(0)
  expect(await hash(page)).toBe('#/?connection')
  await page.goBack()
  await expect(openDialog(page)).toHaveCount(0)
  await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
})
