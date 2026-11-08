/**
 * Study mode (DECISIONS U72) on a phone: no Web MIDI (like Safari on an iPhone), the piece
 * plays through browser sound, the score shows as a page in portrait and a strip in landscape,
 * note names come on request, and nothing of practice is offered or recorded. On a phone-size
 * screen there is no footer (U74): Show keys, Play and Menu are in the header and the other
 * controls are in the menu sheet. A tablet keeps the footer.
 */
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { idbAll } from './app-helpers'
import { PIECE_ID, seedPiece } from './practice-helpers'

const PHONE_PORTRAIT = { width: 390, height: 844 }
const PHONE_LANDSCAPE = { width: 844, height: 390 }
/** A cold load of the Study chunk (renderer) is slow on WebKit. */
const COLD = { timeout: 60_000 }

const labels = (page: Page) => page.locator('.pn-label')
const screen = (page: Page) => page.getByTestId('study-screen')
const menu = (page: Page) => page.getByRole('dialog', { name: 'Menu' })

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(menu(page)).toBeVisible()
}

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study Two Hands' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
  await expect(page.locator('h1', { hasText: 'Two Hands' })).toBeVisible()
  await expect(page.getByTestId('score-skeleton')).toHaveCount(0, COLD)
}

test.describe('Study on a phone', () => {
  test.use({ viewport: PHONE_PORTRAIT, hasTouch: true, isMobile: true })

  test('opens from the Library as its own route, plays through this device and shows the page view', async ({
    page,
  }) => {
    // No fake Web MIDI: the browser has none, like a phone.
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    expect(await page.evaluate(() => location.hash)).toBe(`#/study/${PIECE_ID}`)
    // The page is engraved to the stage's width and fitted to it: nothing scrolls sideways (R17).
    await expect(page.locator('.pn-page-wide')).toHaveCount(0)
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page')
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)

    // Playback only: no hands, no Start, no Listen, no Repeat button on the cursor.
    await expect(page.getByRole('button', { name: 'Left hand' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Repeat from here' })).toHaveCount(0)

    // No footer on a phone (U74): the header holds the only controls on screen, and the score
    // gets the height.
    await expect(screen(page)).toHaveAttribute('data-compact', 'true')
    await expect(screen(page).locator('footer')).toHaveCount(0)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    for (const name of ['Back to Library', 'Show keys', 'Play', 'Menu']) {
      const box = (await page.locator('header').getByRole('button', { name, exact: true }).boundingBox())!
      expect(box, name).not.toBeNull()
      expect(box.x, name).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, name).toBeLessThanOrEqual(PHONE_PORTRAIT.width)
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(44)
    }
    const stage = (await page.getByTestId('strip-host').boundingBox())!
    expect(stage.height).toBeGreaterThanOrEqual(PHONE_PORTRAIT.height - 130)
    await expect(page.getByRole('button', { name: 'Go to the start' })).toHaveCount(0)

    const samples: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/samples/')) samples.push(r.url())
    })
    const play = page.getByRole('button', { name: 'Play', exact: true })
    await expect(play).toBeEnabled()
    await play.click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(screen(page)).toHaveAttribute('data-playing', 'true')
    expect(samples.length).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    await openMenu(page)
    await menu(page).getByRole('button', { name: 'Go to the start' }).click()
    await expect(menu(page)).toHaveCount(0)

    // Nothing was practiced: no attempts, and the piece keeps its practice state untouched.
    await page.waitForTimeout(500)
    expect(await idbAll(page, 'attempts')).toHaveLength(0)
    const pieces = await idbAll<{ id: string; lastHands?: string; resume?: unknown }>(page, 'pieces')
    expect(pieces.find((p) => p.id === PIECE_ID)?.resume ?? null).toBeNull()
  })

  test('the menu names the notes at the cursor on request, and all of them with Note names', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(labels(page)).toHaveCount(0)
    await openMenu(page)
    await expect(menu(page).getByText('Speed')).toBeVisible()
    await menu(page).getByRole('button', { name: 'Name the notes at the cursor' }).click()
    await expect(menu(page)).toHaveCount(0)
    await expect(labels(page).first()).toBeVisible()
    const revealed = await labels(page).count()
    expect(revealed).toBeGreaterThan(0)
    await openMenu(page)
    await menu(page).getByRole('radio', { name: 'All' }).click()
    await expect.poll(() => labels(page).count(), { timeout: 30_000 }).toBeGreaterThan(revealed)
    await menu(page).getByRole('radio', { name: 'Off' }).click()
    await expect.poll(() => labels(page).count(), { timeout: 30_000 }).toBeLessThanOrEqual(revealed)
    await menu(page).getByRole('button', { name: 'Close' }).click()
    await expect(menu(page)).toHaveCount(0)
  })

  test('Show keys in the header opens the keyboard guide; Settings is in the menu', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await page.getByRole('button', { name: 'Show keys' }).click()
    await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'true')
    await expect(page.getByRole('button', { name: 'Hide keys' })).toHaveAttribute('aria-pressed', 'true')
    // The guide reaches the bottom of the screen: nothing but the home-indicator strip below it.
    const guide = (await page.getByTestId('guide-slot').boundingBox())!
    expect(guide.y + guide.height).toBeGreaterThanOrEqual(PHONE_PORTRAIT.height - 40)
    await openMenu(page)
    await menu(page).getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  })

  test('Back returns to the Library and a reload reopens the piece', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await page.reload()
    await expect(page.locator('h1', { hasText: 'Two Hands' })).toBeVisible(COLD)
    await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
    await page.getByRole('button', { name: 'Back to Library' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
    await expect(page.getByRole('button', { name: 'Study Two Hands' })).toBeVisible()
  })
})

test.describe('Study on a phone on its side', () => {
  test.use({ viewport: PHONE_LANDSCAPE, hasTouch: true, isMobile: true })

  test('shows the strip with the controls in the header and the staves readable', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'strip')
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(screen(page).locator('footer')).toHaveCount(0)
    const stage = (await page.getByTestId('strip-host').boundingBox())!
    expect(stage.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE.height - 130)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    const play = (await page.getByRole('button', { name: 'Play', exact: true }).boundingBox())!
    const back = (await page.getByRole('button', { name: 'Back to Library' }).boundingBox())!
    // One row: Play sits in the header beside Back, and so does the overview (U80), in the
    // title's place; there is no keyboard guide and no Show keys.
    expect(Math.abs(play.y + play.height / 2 - (back.y + back.height / 2))).toBeLessThan(8)
    await expect(screen(page)).toHaveAttribute('data-sideways', 'true')
    const overview = (await page.locator('header').getByRole('slider', { name: 'Piece overview' }).boundingBox())!
    expect(Math.abs(overview.y + overview.height / 2 - (back.y + back.height / 2))).toBeLessThan(8)
    expect(overview.width).toBeGreaterThan(PHONE_LANDSCAPE.width / 2)
    await expect(page.getByRole('button', { name: 'Show keys' })).toHaveCount(0)
    await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'false')
    expect(stage.height).toBeGreaterThanOrEqual(PHONE_LANDSCAPE.height - 80)
  })
})

test.describe('Study on a tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

  test('keeps the footer controls and Settings in the header: no menu', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(screen(page)).not.toHaveAttribute('data-compact', 'true')
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0)
    const footer = screen(page).locator('footer')
    for (const name of ['Play', 'Go to the start', 'Name the notes at the cursor', 'Show keys'])
      await expect(footer.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(footer.getByRole('radiogroup', { name: 'Note names on the score' })).toBeVisible()
    await expect(page.locator('header').getByRole('button', { name: 'Settings' })).toBeVisible()
  })
})
