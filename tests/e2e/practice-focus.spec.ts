/** Focus mode collapses chrome without replacing the score or interrupting playback. */
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { REVEAL_MS } from '../../src/views/practice/recede'
import { SHOT_DIR, installFakeMidi, openSeededPractice, seedPiece } from './practice-helpers'

const height = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().height)
const screen = (page: Page) => page.locator('[data-activity]')
const header = (page: Page) => page.getByTestId('practice-header-slot')
const tools = (page: Page) => page.getByTestId('footer-tools-slot')
const stage = (page: Page) => page.getByTestId('strip-host')

async function open(page: Page): Promise<void> {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
}

async function focused(page: Page): Promise<void> {
  await expect(screen(page)).toHaveAttribute('data-recede', 'true')
  await expect.poll(() => height(header(page))).toBeLessThan(1)
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
}

async function reveal(page: Page): Promise<void> {
  // Empty footer space reveals the tools without activating playback or seeking in the score.
  await page.locator('footer').click({ position: { x: 5, y: 5 } })
  await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
  await expect.poll(() => height(header(page))).toBeGreaterThan(50)
}

for (const size of [
  { name: 'portrait', width: 586, height: 846, colorScheme: 'light', reducedMotion: 'no-preference' },
  { name: 'tablet', width: 820, height: 1180, colorScheme: 'dark', reducedMotion: 'no-preference' },
  { name: 'phone', width: 390, height: 844, colorScheme: 'dark', reducedMotion: 'reduce' },
] as const) {
  test(`${size.name}: focus releases header and tool-row space, and restores usable speed controls`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.emulateMedia({ colorScheme: size.colorScheme, reducedMotion: size.reducedMotion })
    await open(page)
    await expect(page.locator('.pn-page')).toBeVisible()
    const originalPage = await page.locator('.pn-page').elementHandle()
    const originalHeight = await height(stage(page))
    const releasedHeight = (await height(header(page))) + (await height(tools(page)))
    const playBefore = await page.getByRole('button', { name: 'Start', exact: true }).boundingBox()

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await focused(page)
    await expect.poll(() => height(tools(page))).toBeLessThan(1)
    await expect.poll(() => height(stage(page))).toBeGreaterThan(originalHeight + releasedHeight - 2)
    expect(await originalPage!.evaluate((el) => el.isConnected)).toBe(true)
    expect(
      await header(page)
        .locator('header')
        .evaluate((el) => el.hasAttribute('inert')),
    ).toBe(true)
    expect(await tools(page).evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    await expect(page.getByRole('slider', { name: 'Piece overview' })).toBeVisible()
    const pause = await page.getByRole('button', { name: 'Pause', exact: true }).boundingBox()
    expect(Math.abs(pause!.y - playBefore!.y)).toBeLessThan(2)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-focus-${size.name}.png`) })

    await reveal(page)
    await expect.poll(() => height(tools(page))).toBeGreaterThan(40)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    expect(await originalPage!.evaluate((el) => el.isConnected)).toBe(true)

    await page.getByRole('button', { name: /Open speed options/ }).click()
    const speed = page.getByRole('dialog', { name: 'Playback speed' })
    await expect(speed).toBeVisible()
    // The automatically focused preset is a button, not a keyboard-focused text field.
    // Pointer users must still be able to leave this popover open without focus mode hiding it.
    await page.waitForTimeout(REVEAL_MS + 200)
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    const input = speed.getByRole('textbox', { name: 'Custom speed' })
    await input.click()
    await input.fill('80%')
    await expect(input).toHaveValue('80%')
    const box = await input.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-focus-speed-${size.name}.png`) })
    await input.press('Escape')
    await expect(speed).toHaveCount(0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await expect.poll(() => height(header(page))).toBeGreaterThan(50)
    await expect.poll(() => height(tools(page))).toBeGreaterThan(40)
  })
}

for (const size of [
  { width: 1180, height: 820 },
  { width: 958, height: 846 },
  { width: 882, height: 700 },
]) {
  test(`landscape ${size.width}: focus dims footer tools in place and reveals them for keyboard navigation`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await open(page)
    const menu = page.locator('footer').getByRole('button', { name: 'Menu', exact: true })
    const speed = page.getByRole('button', { name: /Open speed options/ })
    const start = page.getByRole('button', { name: 'Start', exact: true })
    const footer = page.locator('footer')
    const initial = {
      menu: await menu.boundingBox(),
      speed: await speed.boundingBox(),
      play: await start.boundingBox(),
      footer: await footer.boundingBox(),
    }
    expect(Math.abs(initial.play!.x + initial.play!.width / 2 - size.width / 2)).toBeLessThan(2)

    await start.click()
    await focused(page)
    expect(await tools(page).evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    // Inert tools are still visible, so use their existing DOM handles rather than role lookup.
    const focusedTools = await footer.evaluate((el) => {
      const control = (label: string) => el.querySelector<HTMLElement>(`[aria-label$="${label}"]`)!
      return {
        menu: el.querySelector<HTMLElement>('[aria-label="Menu"]')!.getBoundingClientRect().toJSON(),
        speed: control('Open speed options').getBoundingClientRect().toJSON(),
        play: control('Pause').getBoundingClientRect().toJSON(),
        footer: el.getBoundingClientRect().toJSON(),
      }
    })
    for (const name of ['menu', 'speed', 'play', 'footer'] as const) {
      expect(Math.abs(focusedTools[name].x - initial[name]!.x), name).toBeLessThan(2)
      expect(Math.abs(focusedTools[name].y - initial[name]!.y), name).toBeLessThan(2)
      expect(Math.abs(focusedTools[name].height - initial[name]!.height), name).toBeLessThan(2)
    }
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await expect.poll(() => height(header(page))).toBeGreaterThan(50)
    expect(await tools(page).evaluate((el) => el.hasAttribute('inert'))).toBe(false)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })
}

test('Listen keeps playing while portrait chrome collapses and returns', async ({ page }) => {
  await page.setViewportSize({ width: 586, height: 846 })
  await open(page)
  await page.getByRole('button', { name: /Open speed options/ }).click()
  await page.getByRole('dialog', { name: 'Playback speed' }).getByRole('button', { name: '50%', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Left hand', exact: true }).click()
  await page.getByRole('button', { name: 'Right hand', exact: true }).click()
  await page.getByRole('button', { name: 'Listen', exact: true }).click()
  await focused(page)
  await expect(screen(page)).toHaveAttribute('data-activity', 'listening')
  await expect(page.locator('.pn-page.pn-browsing')).toHaveCount(0)
  await reveal(page)
  await expect.poll(() => height(tools(page))).toBeGreaterThan(40)
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await expect(screen(page)).toHaveAttribute('data-activity', 'listening')
  await expect(page.locator('.pn-page.pn-browsing')).toHaveCount(0)
})
