/**
 * A phone's page zooms like a photo (DECISIONS U83): it opens fitted to the screen's width, never
 * scrolling sideways; a pinch magnifies the page as engraved (nothing is re-engraved, the systems
 * keep their bars) and it may then scroll sideways; the app itself never zooms; a reload opens
 * fitted again. A page zoom saved before U83 (when a pinch re-engraved the page) does not apply.
 */
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { storedSettings } from './app-helpers'
import { seedPiece } from './practice-helpers'

const PHONE = { width: 393, height: 852 }
const COLD = { timeout: 60_000 }

const scroller = (page: Page) => page.locator('.pn-page-scroll')

async function openStudy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Study Two Hands' }).click()
  await expect(page.locator('main')).toHaveAttribute('data-view', 'study')
  await waitForPage(page)
}

async function waitForPage(page: Page): Promise<void> {
  await expect(page.getByTestId('score-skeleton')).toHaveCount(0, COLD)
  await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page')
  await expect(page.locator('.pn-page-content')).toHaveCount(1, COLD)
}

/** The page's shown scale, from its content transform. */
async function shownScale(page: Page): Promise<number> {
  const t = await page.locator('.pn-page-content').evaluate((el) => (el as HTMLElement).style.transform)
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? NaN)
}

/** How far the page scrolls sideways (px); 0 when it fits. */
const sideways = (page: Page) => scroller(page).evaluate((el) => el.scrollWidth - el.clientWidth)

/** Two fingers spreading apart around the page's center (Chromium: real touch input). */
async function pinchOut(page: Page, browserName: string): Promise<void> {
  const box = (await scroller(page).boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 3
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', d: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd'
            ? []
            : [
                { x: cx - d, y: cy, id: 0 },
                { x: cx + d, y: cy, id: 1 },
              ],
      })
    await touch('touchStart', 40)
    for (let d = 50; d <= 120; d += 10) await touch('touchMove', d)
    await touch('touchEnd', 120)
  } else {
    // Mobile WebKit here can drive neither two fingers nor a wheel: a trackpad pinch (ctrl-wheel
    // events) takes the same magnify path, so the page and its rendering are still WebKit's.
    await scroller(page).evaluate(
      async (el, { cx, cy }) => {
        for (let i = 0; i < 4; i++) {
          el.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: -60,
              ctrlKey: true,
              clientX: cx,
              clientY: cy,
              bubbles: true,
              cancelable: true,
            }),
          )
          await new Promise((r) => requestAnimationFrame(r))
        }
      },
      { cx, cy },
    )
  }
}

test.describe('A phone page zooms like a photo (U83)', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

  test('opens fitted, a pinch magnifies without re-engraving, a reload fits again', async ({ page, browserName }) => {
    // A page zoom saved by an old pinch (it re-engraved the page then) must not apply on a phone.
    await seedPiece(page, { route: DEFAULT_SETTINGS.route, view: { ...DEFAULT_SETTINGS.view, pageZoom: 2 } })
    await openStudy(page)

    // Fitted: engraved at zoom 1 for the screen's width, nothing scrolls sideways.
    const fitted = await shownScale(page)
    expect(fitted).toBeGreaterThan(0.85)
    expect(fitted).toBeLessThanOrEqual(1)
    expect(await sideways(page)).toBeLessThanOrEqual(0)
    await expect(page.locator('.pn-page-wide')).toHaveCount(0)

    // Mark this view: a re-engraving would replace it.
    await page.locator('.pn-page-content').evaluate((el) => el.setAttribute('data-probe', 'first'))
    const systems = await page.locator('.pn-page-content svg').count()

    await pinchOut(page, browserName)
    await expect.poll(() => shownScale(page)).toBeGreaterThan(fitted * 1.4)
    // Let any debounced report settle: still the same view, the same systems, nothing saved.
    await page.waitForTimeout(600)
    await expect(page.locator('.pn-page-content[data-probe="first"]')).toHaveCount(1)
    expect(await page.locator('.pn-page-content svg').count()).toBe(systems)
    expect(await sideways(page)).toBeGreaterThan(0)
    await expect(page.locator('.pn-page-wide')).toHaveCount(1)
    // Only the score zoomed: the app is at its own scale.
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    expect((await storedSettings(page))?.['view']?.['pageZoom']).toBe(2)

    // A reload opens fitted again.
    await page.reload()
    await waitForPage(page)
    expect(await shownScale(page)).toBeCloseTo(fitted, 5)
    expect(await sideways(page)).toBeLessThanOrEqual(0)
  })
})
