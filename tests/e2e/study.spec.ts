/**
 * Study mode (DECISIONS U72) on a phone: no Web MIDI (like Safari on an iPhone), the piece
 * plays through browser sound, the score shows as a page in portrait and a strip in landscape,
 * note names come on request, and nothing of practice is offered or recorded. On a phone-size
 * screen there is no footer (U74): Play and Menu are in the header and the other controls,
 * Show keys too, are in the untitled menu sheet. A tablet has Practice's footer (U90): Speed, Go to
 * the start, Play, Name the notes at the cursor and a Menu button whose popover ("Sheet music menu")
 * holds Note names, Metronome and Show keys.
 */
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { idbAll } from './app-helpers'
import { PIECE_ID, installFakeMidi, play, seedPiece } from './practice-helpers'

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
  await page.getByRole('button', { name: 'Open sheet music for Two Hands' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
  await expect(page.locator('main')).toHaveAttribute('aria-label', 'Sheet music')
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
    await expect(page.getByRole('button', { name: 'Repeat from here' })).toHaveCount(0)

    // No footer on a phone (U74): the header holds the only controls on screen, and the score
    // gets the height.
    await expect(screen(page)).toHaveAttribute('data-compact', 'true')
    await expect(screen(page).locator('footer')).toHaveCount(0)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await expect(page.getByRole('button', { name: 'Show keys' })).toHaveCount(0)
    for (const name of ['Back to Library', 'Listen', 'Menu']) {
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
    const play = page.getByRole('button', { name: 'Listen', exact: true })
    await expect(play).toBeEnabled()
    await play.click()
    await expect(play).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 })
    await expect(screen(page)).toHaveAttribute('data-playing', 'true')
    expect(samples.length).toBeGreaterThan(0)
    await play.click()
    await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeVisible()
    const overview = page.getByRole('slider', { name: 'Piece overview' })
    await overview.press('End')
    await expect(overview).toHaveAttribute('aria-valuenow', '2')
    await overview.press('Home')
    await expect(overview).toHaveAttribute('aria-valuenow', '1')

    // Nothing was practiced: no attempts, and the piece keeps its practice state untouched.
    await page.waitForTimeout(500)
    expect(await idbAll(page, 'attempts')).toHaveLength(0)
    const pieces = await idbAll<{ id: string; lastHands?: string; resume?: unknown }>(page, 'pieces')
    expect(pieces.find((p) => p.id === PIECE_ID)?.resume ?? null).toBeNull()
  })

  test('Note names are set from Off, Conditional and All in the menu', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(labels(page)).toHaveCount(0)
    await openMenu(page)
    await expect(menu(page).getByRole('button', { name: 'Name the notes at the cursor' })).toHaveCount(0)
    await expect(menu(page).getByRole('button', { name: 'Go to the start' })).toHaveCount(0)
    const names = menu(page).getByRole('radiogroup', { name: 'Note names on the score' })
    await names.getByRole('radio', { name: 'Conditional' }).click()
    await expect(names.getByRole('radio', { name: 'Conditional' })).toHaveAttribute('aria-checked', 'true')
    await names.getByRole('radio', { name: 'All' }).click()
    await expect(labels(page).first()).toBeVisible({ timeout: 30_000 })
    await names.getByRole('radio', { name: 'Off' }).click()
    await expect(labels(page)).toHaveCount(0, { timeout: 30_000 })
  })

  test('Show keys in the menu opens the keyboard guide; Settings is in the menu', async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await openMenu(page)
    // The menu has no visible title, only its close button.
    await expect(menu(page).locator('h2')).toHaveCount(0)
    const show = menu(page).getByRole('switch', { name: 'Show keys' })
    await show.check()
    await expect(show).toBeChecked()
    await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'true')
    await menu(page).getByRole('button', { name: 'Close' }).click()
    await expect(menu(page)).toHaveCount(0)
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
    await expect(page.locator('main')).toHaveAttribute('aria-label', 'Sheet music')
    await page.getByRole('button', { name: 'Back to Library' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'library')
    await expect(page.getByRole('button', { name: 'Open sheet music for Two Hands' })).toBeVisible()
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
    const play = (await page.getByRole('button', { name: 'Listen', exact: true }).boundingBox())!
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
    await openMenu(page)
    await expect(menu(page).getByRole('switch', { name: 'Show keys' })).toHaveCount(0)
  })
})

test.describe('Study on a tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

  test("has Practice's footer with the Sheet music menu, and Settings in the header (U90)", async ({ page }) => {
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openStudy(page)
    await expect(page.locator('.pn-strip')).toBeVisible(COLD)
    await expect(screen(page)).not.toHaveAttribute('data-compact', 'true')
    await expect(page.locator('header').getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0)
    const footer = screen(page).locator('footer')
    for (const name of ['Listen', 'Follow my playing', 'Menu'])
      await expect(footer.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(footer.getByRole('button', { name: 'Faster by 5 percent' })).toBeVisible()
    // One row: Speed, both transport buttons and Menu share a line.
    const top = async (name: string) => (await footer.getByRole('button', { name, exact: true }).boundingBox())!
    const play = await top('Listen')
    for (const name of ['Follow my playing', 'Menu']) {
      const box = await top(name)
      expect(Math.abs(box.y + box.height / 2 - (play.y + play.height / 2))).toBeLessThan(8)
    }
    await expect(footer.getByRole('radiogroup', { name: 'Note names on the score' })).toHaveCount(0)

    await footer.getByRole('button', { name: 'Menu', exact: true }).click()
    const studyMenu = page.getByRole('dialog', { name: 'Sheet music menu' })
    await expect(studyMenu).toBeVisible()
    await expect(studyMenu.getByRole('radiogroup', { name: 'Note names on the score' })).toBeVisible()
    await expect(studyMenu.getByRole('switch', { name: 'Metronome' })).toBeVisible()
    const keys = studyMenu.getByRole('switch', { name: 'Show keys' })
    await expect(keys).toBeVisible()
    await expect(studyMenu.getByRole('switch', { name: 'Play through' })).toHaveCount(0)
    await expect(studyMenu.getByRole('switch', { name: 'Keep time' })).toHaveCount(0)
    await keys.click()
    await expect(keys).toBeChecked()
    await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'true')
    await page.keyboard.press('Escape')
    await expect(studyMenu).toHaveCount(0)
    await expect(page.locator('header').getByRole('button', { name: 'Settings' })).toBeVisible()
  })
})

test('Study follows the MIDI piano and switches to Listen without recording practice', async ({ page }) => {
  await page.setViewportSize({ width: 1194, height: 834 })
  await installFakeMidi(page)
  await seedPiece(page)
  await openStudy(page)
  const follow = page.getByRole('button', { name: 'Follow my playing', exact: true })
  const listen = page.getByRole('button', { name: 'Listen', exact: true })
  await follow.click()
  await expect(follow).toHaveAttribute('aria-pressed', 'true')
  const targets = page.locator('.pn-music .pn-target:not(.pn-acc)')
  const targetIds = () => targets.evaluateAll((els) => els.map((el) => el.getAttribute('data-n')))
  await expect.poll(targetIds).not.toEqual([])
  const first = await targetIds()
  await play(page, 60, 48)
  await expect
    .poll(async () => {
      const next = await targetIds()
      return next.length > 0 && next.join(' ') !== first.join(' ')
    })
    .toBe(true)
  await listen.click()
  await expect(listen).toHaveAttribute('aria-pressed', 'true')
  await expect(follow).toHaveAttribute('aria-pressed', 'false')
  await expect(targets).toHaveCount(0)
  expect(await idbAll(page, 'attempts')).toEqual([])
})
