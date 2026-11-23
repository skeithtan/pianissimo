/**
 * Focus mode recedes chrome without replacing the score or interrupting playback. A tablet's or
 * desktop's header keeps its place, faded when upright (U147); a phone's top bar collapses (U93).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '../browser-test'
import { REVEAL_MS } from '../../src/views/practice/recede'
import { SHOT_DIR, chooseMode, installFakeMidi, openSeededPractice, seedPiece } from './practice-helpers'

const height = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().height)
const screen = (page: Page) => page.locator('[data-activity]')
const header = (page: Page) => page.getByTestId('practice-header')
const tools = (page: Page) => page.getByTestId('footer-tools-slot')
const stage = (page: Page) => page.getByTestId('strip-host')
const speedButton = (page: Page) => page.getByRole('button', { name: /Open speed options/ })
const menuButton = (page: Page) => page.locator('footer').getByRole('button', { name: 'Menu', exact: true })

/** How strongly a control shows: its opacity times every ancestor's, up to the footer or header. */
const strength = (locator: Locator) =>
  locator.evaluate((el) => {
    let value = 1
    for (
      let node: Element | null = el;
      node && node.tagName !== 'FOOTER' && node.tagName !== 'HEADER';
      node = node.parentElement
    )
      value *= Number(getComputedStyle(node).opacity)
    return Math.round(value * 100) / 100
  })

async function open(page: Page): Promise<void> {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
}

async function focused(page: Page): Promise<void> {
  await expect(screen(page)).toHaveAttribute('data-recede', 'true')
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
}

/**
 * The header keeps its place: in full and taking input, or faded (upright focus mode, U147), when a
 * tap on it only brings it back.
 */
async function headerStays(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  { faded = false } = {},
) {
  await expect(header(page)).toBeVisible()
  expect(await header(page).boundingBox()).toEqual(box)
  expect(await header(page).evaluate((el) => el.hasAttribute('inert') || !!el.closest('[inert]'))).toBe(false)
  const back = header(page).getByRole('button', { name: 'Back to Library' })
  await expect.poll(() => strength(back)).toBe(faded ? 0.12 : 1)
  expect(await strength(header(page).getByRole('button', { name: /MIDI status/ }))).toBe(faded ? 0.12 : 1)
  expect(
    await back.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }),
  ).toBe(!faded)
}

async function reveal(page: Page): Promise<void> {
  // Empty footer space reveals the tools without activating playback or seeking in the score.
  await page.locator('footer').click({ position: { x: 5, y: 5 } })
  await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
}

for (const size of [
  // A window too narrow for one footer row: the tools wrap into their own row, which collapses.
  { name: 'portrait', width: 586, height: 846, wraps: true, colorScheme: 'light', reducedMotion: 'no-preference' },
  // A tablet held upright has the footer it has on its side (U88): one row, nothing to collapse.
  { name: 'tablet', width: 820, height: 1180, wraps: false, colorScheme: 'dark', reducedMotion: 'no-preference' },
] as const) {
  test(`${size.name}: focus keeps the header${size.wraps ? ', releases the tool row' : ', the footer tools dim in place'}, and restores usable speed controls`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.emulateMedia({ colorScheme: size.colorScheme, reducedMotion: size.reducedMotion })
    await open(page)
    await expect(page.locator('.pn-page')).toBeVisible()
    const originalPage = await page.locator('.pn-page').elementHandle()
    const originalHeight = await height(stage(page))
    const headerBox = (await header(page).boundingBox())!
    // Only the wrapped tool row gives the score its height: the header stays.
    const releasedHeight = size.wraps ? await height(tools(page)) : 0
    const playBefore = await page.getByRole('button', { name: 'Start', exact: true }).boundingBox()
    const speedBefore = await speedButton(page).boundingBox()
    const menuBefore = await menuButton(page).boundingBox()

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await focused(page)
    if (size.wraps) await expect.poll(() => height(tools(page))).toBeLessThan(1)
    await expect.poll(() => height(stage(page))).toBeGreaterThan(originalHeight + releasedHeight - 2)
    expect(await height(stage(page))).toBeLessThan(originalHeight + releasedHeight + 2)
    await headerStays(page, headerBox, { faded: true })
    if (!size.wraps) {
      // Speed and Menu stay exactly where they were and dim, as in landscape.
      await expect.poll(() => strength(menuButton(page))).toBe(0.12)
      expect(await strength(speedButton(page))).toBe(0.12)
      expect(await speedButton(page).boundingBox()).toEqual(speedBefore)
      expect(await menuButton(page).boundingBox()).toEqual(menuBefore)
    }
    expect(await originalPage!.evaluate((el) => el.isConnected)).toBe(true)
    expect(await tools(page).evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    await expect(page.getByRole('slider', { name: 'Piece overview' })).toBeVisible()
    const pause = await page.getByRole('button', { name: 'Pause', exact: true }).boundingBox()
    expect(Math.abs(pause!.y - playBefore!.y)).toBeLessThan(2)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-focus-${size.name}.png`) })

    await reveal(page)
    if (size.wraps) await expect.poll(() => height(tools(page))).toBeGreaterThan(40)
    else await expect.poll(() => strength(menuButton(page))).toBe(1)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    expect(await originalPage!.evaluate((el) => el.isConnected)).toBe(true)

    await speedButton(page).click()
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
    await headerStays(page, headerBox)
    if (size.wraps) await expect.poll(() => height(tools(page))).toBeGreaterThan(40)
    else expect(await speedButton(page).boundingBox()).toEqual(speedBefore)
  })
}

/**
 * A tablet's footer is the same single row held upright and on its side (U88): Speed at the start
 * edge, the hands around Start in the middle, Menu at the end edge.
 */
test('a tablet held upright has the footer it has on its side: one row', async ({ page }) => {
  const footerLayout = async (width: number, viewportHeight: number) => {
    await page.setViewportSize({ width, height: viewportHeight })
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', width > viewportHeight ? 'strip' : 'page')
    return page.evaluate(() => {
      const footer = document.querySelector('footer')!
      const box = (label: string) => footer.querySelector(`button[aria-label${label}]`)!.getBoundingClientRect()
      const area = footer.getBoundingClientRect()
      const speed = box('^="Slower"')
      const start = box('="Start"')
      const menu = box('="Menu"')
      return {
        height: Math.round(area.height),
        speedFromStartEdge: Math.round(speed.left - area.left),
        speedTop: Math.round(speed.top - area.top),
        startOffCenter: Math.round(start.left + start.width / 2 - (area.left + area.width / 2)),
        startTop: Math.round(start.top - area.top),
        menuFromEndEdge: Math.round(area.right - menu.right),
        menuTop: Math.round(menu.top - area.top),
      }
    })
  }
  await page.setViewportSize({ width: 1180, height: 820 })
  await open(page)
  const onItsSide = await footerLayout(1180, 820)
  expect(onItsSide.startOffCenter).toBe(0)
  // The 11-inch and 10-inch tablets, and the smallest one, held upright.
  for (const [width, viewportHeight] of [
    [820, 1180],
    [744, 1133],
  ] as const) {
    expect(await footerLayout(width, viewportHeight), `${width} px wide`).toEqual(onItsSide)
  }
})

test.describe('tablet Repeat options', () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true })

  test('the No limit button opens Repeat options during practice when the controls are revealed', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Repeat from here' }).tap()
    const panel = page.getByTestId('repeat-controls')
    const goal = panel.getByRole('button', { name: /^Repeat goal: / })
    const options = panel.getByRole('dialog', { name: 'Repeat options' })
    await expect(goal).toHaveText('No limit')
    await goal.tap()
    await expect(options.getByRole('radio', { name: 'No limit' })).toBeChecked()
    await goal.tap()
    await expect(options).toHaveCount(0)

    await page.getByRole('button', { name: 'Start', exact: true }).tap()
    await focused(page)
    await page.locator('footer').tap({ position: { x: 5, y: 5 } })
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await goal.tap()
    await expect(goal).toHaveAttribute('aria-expanded', 'true')
    await expect(options).toBeVisible({ timeout: 3000 })
    await page.waitForTimeout(REVEAL_MS + 200)
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await options.getByRole('radio', { name: '3', exact: true }).tap()
    await expect(goal).toHaveText('Until 3 clean')
    await options.getByRole('radio', { name: 'No limit' }).tap()
    await expect(goal).toHaveText('No limit')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })

  /** How strongly an element shows: its opacity times every ancestor's. */
  const shown = (locator: Locator) =>
    locator.evaluate((el) => {
      let value = 1
      for (let node: Element | null = el; node; node = node.parentElement)
        value *= Number(getComputedStyle(node).opacity)
      return Math.round(value * 100) / 100
    })

  test('an open popover holds the chrome past the reveal time, after a tap inside it too', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Repeat from here' }).tap()
    const panel = page.getByTestId('repeat-controls')
    const goal = panel.getByRole('button', { name: /^Repeat goal: / })
    const options = panel.getByRole('dialog', { name: 'Repeat options' })
    await page.getByRole('button', { name: 'Start', exact: true }).tap()
    await focused(page)
    await page.locator('footer').tap({ position: { x: 5, y: 5 } })
    await goal.tap()
    await expect(options).toBeVisible()
    // A tap on a choice need not keep keyboard focus inside the popover (a touch on WebKit).
    await options.getByRole('radio', { name: '3', exact: true }).tap()
    await expect(goal).toHaveText('Until 3 clean')
    await page.waitForTimeout(REVEAL_MS + 400)
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await expect(goal).toHaveAttribute('aria-expanded', 'true')
    expect(await shown(options)).toBe(1)
    await options.getByRole('radio', { name: 'No limit' }).tap()
    await expect(goal).toHaveText('No limit')
    // Closed, the chrome recedes again after the reveal time.
    await goal.tap()
    await expect(options).toHaveCount(0)
    await expect(screen(page)).toHaveAttribute('data-recede', 'true', { timeout: REVEAL_MS + 2000 })

    // The footer's menu, opened while playing, holds it the same way.
    await page.locator('footer').tap({ position: { x: 5, y: 5 } })
    await menuButton(page).tap()
    const menu = page.getByRole('dialog', { name: 'Practice menu' })
    await expect(menu).toBeVisible()
    await menu.getByRole('switch', { name: 'Show keys' }).tap()
    await page.waitForTimeout(REVEAL_MS + 400)
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    await expect(menu).toBeVisible()
    expect(await shown(menu)).toBe(1)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })
})

/**
 * Focus mode on a tablet keeps the header, in full on its side, faded when upright (U132, U147):
 * there is room for it. The score's stage keeps its size (the header never leaves), and the footer tools dim as
 * before. A phone's top bar still recedes (below).
 */
test.describe('a tablet keeps its header in focus mode', () => {
  test.use({ hasTouch: true })
  for (const size of [
    { name: 'upright', width: 834, height: 1194, mode: 'page' },
    { name: 'on its side', width: 1194, height: 834, mode: 'strip' },
  ] as const) {
    test(`${size.name}: the header ${size.mode === 'page' ? 'fades in place' : 'stays in full and takes input'} while the footer tools recede`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await open(page)
      await expect(stage(page)).toHaveAttribute('data-mode', size.mode)
      await expect(screen(page)).not.toHaveAttribute('data-compact', 'true')
      const headerBox = (await header(page).boundingBox())!
      expect(headerBox.height).toBeGreaterThan(50)
      const stageHeight = await height(stage(page))
      await page.getByRole('button', { name: 'Start', exact: true }).tap()
      await focused(page)
      await expect.poll(() => strength(menuButton(page))).toBe(0.12)
      // Past the recede delay and its transitions: nothing moved, the header is all there.
      await page.waitForTimeout(800)
      await headerStays(page, headerBox, { faded: size.mode === 'page' })
      expect(Math.abs((await height(stage(page))) - stageHeight)).toBeLessThan(1)
      await expect(screen(page)).toHaveAttribute('data-recede', 'true')
      // It takes a tap at once: Settings opens over Practice (and pauses it).
      if (size.mode === 'page') {
        // The first tap on the faded header, here where Settings is, only brings it back.
        const gear = (await header(page).getByRole('button', { name: 'Settings' }).boundingBox())!
        await page.touchscreen.tap(gear.x + gear.width / 2, gear.y + gear.height / 2)
        await headerStays(page, headerBox)
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
      }
      await header(page).getByRole('button', { name: 'Settings' }).tap()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    })
  }
})

/**
 * A phone-size screen (U80) has one top bar instead of the header and footer. In focus mode the
 * whole bar slides up, fades and its row collapses (U93), the overview with it on its side; the score takes the height, and a press on the score brings the bar back.
 */
test.describe('phone top bar', () => {
  test.use({ hasTouch: true })

  for (const size of [
    { name: 'phone upright', width: 393, height: 852, sideways: false, reducedMotion: 'reduce' },
    { name: 'phone on its side', width: 852, height: 360, sideways: true, reducedMotion: 'no-preference' },
  ] as const) {
    test(`${size.name}: focus mode hides the top bar, the score takes its height, a tap on the score brings it back`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: size.reducedMotion })
      await open(page)
      await expect(screen(page)).toHaveAttribute('data-compact', 'true')
      await expect(page.locator('footer')).toHaveCount(0)
      await expect(header(page)).toHaveCount(0)
      const slot = page.getByTestId('practice-bar-slot')
      const bar = page.getByTestId('practice-bar')
      for (const name of ['Back to Library', 'Left hand', 'Start', 'Right hand', 'Menu']) {
        const box = (await bar.getByRole('button', { name, exact: true }).boundingBox())!
        expect(box, name).not.toBeNull()
        // The hands are drawn at 40 px with a 44 px hit area around them (a pseudo-element).
        expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(name.endsWith('hand') ? 40 : 44)
      }
      const overview = page.getByRole('slider', { name: 'Piece overview' })
      await expect(overview).toBeVisible()
      if (size.sideways) {
        // The overview sits in the bar, in the title's place; no keyboard guide.
        await expect(bar.getByRole('slider', { name: 'Piece overview' })).toBeVisible()
        await expect(page.getByTestId('guide-slot')).toHaveAttribute('data-open', 'false')
      }
      const score = page.locator(size.sideways ? '.pn-strip' : '.pn-page')
      await expect(score).toBeVisible()
      const engraved = await score.elementHandle()
      const barHeight = await height(slot)
      expect(barHeight).toBeGreaterThanOrEqual(50)
      const stageBefore = await height(stage(page))
      expect(stageBefore).toBeGreaterThanOrEqual(size.height - 150)

      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await expect(screen(page)).toHaveAttribute('data-recede', 'true')
      await expect.poll(() => height(slot)).toBeLessThan(1)
      await expect.poll(() => height(stage(page))).toBeGreaterThan(stageBefore + barHeight - 2)
      await expect(bar).toHaveCSS('opacity', '0')
      expect(await bar.evaluate((el) => el.hasAttribute('inert'))).toBe(true)
      // Upright the overview keeps its own row; on its side it went with the bar.
      if (!size.sideways) await expect(overview).toBeVisible()
      // The score was not engraved again: the stage only grew taller.
      expect(await engraved!.evaluate((el) => el.isConnected)).toBe(true)

      // A tap on the score brings the bar back and only that: it does not seek (U93), here on a
      // point of bar 2 while the reading cursor waits in bar 1.
      const position = page.locator('[aria-label="Piece overview"]')
      await expect(position).toHaveAttribute('aria-valuetext', /^Bar 1 of 2/)
      const svgBox = (await score.locator('svg').first().boundingBox())!
      const stageBox = (await stage(page).boundingBox())!
      const bar2 = () => ({
        x: Math.round(svgBox.x + svgBox.width * 0.8 - stageBox.x),
        y: Math.round(Math.min(svgBox.y + svgBox.height / 2, stageBox.y + stageBox.height - 10) - stageBox.y),
      })
      await stage(page).tap({ position: bar2() })
      await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
      await expect.poll(() => height(slot)).toBeGreaterThan(barHeight - 2)
      await expect(bar).toHaveCSS('opacity', '1')
      await expect(position).toHaveAttribute('aria-valuetext', /^Bar 1 of 2/)
      // A mouse press anywhere on the score does too (the hidden bar holds Pause), without seeking.
      await page.waitForTimeout(REVEAL_MS + 300)
      await expect(screen(page)).toHaveAttribute('data-recede', 'true')
      // The score moved up with the stage's top: measure again.
      Object.assign(svgBox, (await score.locator('svg').first().boundingBox())!)
      Object.assign(stageBox, (await stage(page).boundingBox())!)
      await stage(page).click({ position: bar2() })
      await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
      await expect.poll(() => height(slot)).toBeGreaterThan(barHeight - 2)
      await expect(position).toHaveAttribute('aria-valuetext', /^Bar 1 of 2/)
      // With the bar showing, a tap seeks as before.
      await expect.poll(() => height(stage(page))).toBeLessThan(stageBefore + 2)
      Object.assign(svgBox, (await score.locator('svg').first().boundingBox())!)
      Object.assign(stageBox, (await stage(page).boundingBox())!)
      await stage(page).tap({ position: bar2() })
      await expect(position).toHaveAttribute('aria-valuetext', /^Bar 2 of 2/)
      await bar.getByRole('button', { name: 'Pause', exact: true }).click()
      await expect(bar.getByRole('button', { name: /^(Start|Resume)$/ })).toBeVisible()
      await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
      expect(await bar.evaluate((el) => el.hasAttribute('inert'))).toBe(false)
      await expect.poll(() => height(stage(page))).toBeLessThan(stageBefore + 2)
      expect(await engraved!.evaluate((el) => el.isConnected)).toBe(true)

      // The menu sheet holds Speed and the rest.
      await bar.getByRole('button', { name: 'Menu', exact: true }).click()
      const menu = page.getByRole('dialog', { name: 'Menu' })
      await expect(menu).toBeVisible()
      await expect(menu.getByText('Speed')).toBeVisible()
      await expect(menu.getByRole('switch', { name: 'Metronome' })).toBeVisible()
      await expect(menu.getByRole('switch', { name: 'Show keys' })).toHaveCount(size.sideways ? 0 : 1)
      await expect(menu.getByRole('radiogroup', { name: 'Note names on the score' })).toBeVisible()
      await menu.getByRole('button', { name: /Open speed options/ }).click()
      const speed = page.getByRole('dialog', { name: 'Playback speed' })
      await expect(speed).toBeVisible()
      const input = speed.getByRole('textbox', { name: 'Custom speed' })
      await input.click()
      await input.fill('80%')
      await expect(input).toHaveValue('80%')
      const box = (await input.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
      await input.press('Escape')
      await expect(speed).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
    })
  }
})

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
    const headerBox = (await header(page).boundingBox())!
    expect(Math.abs(initial.play!.x + initial.play!.width / 2 - size.width / 2)).toBeLessThan(2)

    await start.click()
    await focused(page)
    await headerStays(page, headerBox)
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
    expect(await tools(page).evaluate((el) => el.hasAttribute('inert'))).toBe(false)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })
}

for (const size of [
  { width: 586, height: 846 },
  { width: 1194, height: 834 },
  { width: 393, height: 852 },
  { width: 852, height: 360 },
])
  test(`${size.width}×${size.height}: nothing recedes while Listen plays (U72), only the cursor's repeat button goes`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await open(page)
    await chooseMode(page, 'Listen')
    const phone = await page.getByTestId('practice-bar').count()
    if (!phone) {
      await page.getByRole('button', { name: /Open speed options/ }).click()
      await page
        .getByRole('dialog', { name: 'Playback speed' })
        .getByRole('button', { name: '50%', exact: true })
        .click()
      await page.keyboard.press('Escape')
    }
    const repeat = page.locator('.pn-action-on')
    await expect(repeat).toHaveCount(1)
    const stageBefore = await height(stage(page))
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(screen(page)).toHaveAttribute('data-activity', 'listening')
    await expect(repeat).toHaveCount(0)
    // Where the other modes have receded by now (1.2 s), every control is still there and takes input.
    await page.waitForTimeout(800)
    await expect(screen(page)).not.toHaveAttribute('data-recede', 'true')
    expect(await height(stage(page))).toBe(stageBefore)
    const chrome = phone ? page.getByTestId('practice-bar') : tools(page)
    expect(await chrome.evaluate((el) => el.hasAttribute('inert'))).toBe(false)
    await expect(chrome).toHaveCSS('opacity', '1')
    await expect(page.locator('.pn-browsing')).toHaveCount(0)
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    await expect(pause).toBeInViewport({ ratio: 1 })
    // Another mode is one tap away, and stops it.
    await chooseMode(page, 'Wait')
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  })

/**
 * The footer menu's last action (Record performance) keeps the rows' rhythm: a hairline above it,
 * the rows' spacing above and below, its icon and label at the start of the full width (as the phone
 * menu's actions). MENU_SHOTS=<dir outside the repo> also saves the open menu as
 * <dir>/<browser>-menu-<size>-<MENU_SHOTS_LABEL or "after">.png.
 */
for (const size of [
  { width: 1194, height: 834 },
  { width: 834, height: 1194 },
]) {
  test(`${size.width}×${size.height}: the footer menu's Record performance has the rows' spacing`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize(size)
    await open(page)
    await menuButton(page).click()
    const menu = page.getByRole('dialog', { name: 'Practice menu' })
    await expect(menu).toBeVisible()
    const record = menu.getByRole('button', { name: 'Record performance' })
    await expect(record).toBeEnabled()
    await page.waitForTimeout(400)
    const shots = process.env['MENU_SHOTS']
    if (shots) {
      mkdirSync(shots, { recursive: true })
      const label = process.env['MENU_SHOTS_LABEL'] ?? 'after'
      await page.screenshot({ path: join(shots, `${browserName}-menu-${size.width}x${size.height}-${label}.png`) })
    }
    const measured = await menu.evaluate((popover) => {
      const inner = (el: Element) => {
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return {
          top: r.top + parseFloat(style.borderTopWidth),
          bottom: r.bottom - parseFloat(style.borderBottomWidth),
        }
      }
      const button = popover.querySelector(':scope > button')!
      const rows = [...popover.children].filter((el) => el !== button)
      const above = rows.at(-1)!
      const b = button.getBoundingClientRect()
      const box = inner(popover)
      const result = {
        below: Math.round((box.bottom - b.bottom) * 10) / 10,
        above: Math.round((b.top - above.getBoundingClientRect().bottom) * 10) / 10,
        hairline: getComputedStyle(above).borderBottomWidth,
        width: Math.round(b.width),
        rowWidth: Math.round(above.getBoundingClientRect().width),
        // The record icon, then the label after it.
        iconStart: Math.round(button.querySelector('svg')!.getBoundingClientRect().left - b.left),
        // The rows' own spacing (the first row is Note names).
        rowPadding: parseFloat(getComputedStyle(rows[0]!).paddingTop),
      }
      // Without the button: what the last row keeps below its content.
      button.remove()
      const last = rows.at(-1)!
      const content = last.getBoundingClientRect().bottom - parseFloat(getComputedStyle(last).paddingBottom)
      const rowBelow = Math.round((inner(popover).bottom - content) * 10) / 10
      return { ...result, rowBelow }
    })
    expect(measured.below).toBe(measured.rowBelow)
    expect(measured.above).toBe(measured.rowPadding)
    expect(measured.hairline).toBe('1px')
    expect(measured.width).toBe(measured.rowWidth)
    expect(measured.iconStart).toBeLessThan(24)
  })
}
