import { expect, test } from '../browser-test'

const layouts = [
  { name: 'tablet landscape', viewport: { width: 1194, height: 834 }, widthFraction: 0.7 },
  { name: 'wide tablet landscape', viewport: { width: 1389, height: 884 }, widthFraction: 0.7 },
  {
    name: 'tablet with stale viewport units',
    viewport: { width: 1389, height: 884 },
    widthFraction: 0.7,
    viewportUnitsWidth: 689,
  },
  { name: 'phone portrait', viewport: { width: 393, height: 852 }, widthFraction: 1 },
  { name: 'phone landscape', viewport: { width: 852, height: 393 }, widthFraction: 1 },
]

for (const { name, viewport, widthFraction, viewportUnitsWidth } of layouts) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block' })

    test('centers Settings at the expected width', async ({ page }) => {
      if (viewportUnitsWidth) {
        // Model the width reported by the tablet's viewport units while its dialog still centers
        // within the full app. Intercept CSS so both engines can exercise the discrepancy.
        await page.route('**/*.css', async (route) => {
          const response = await route.fetch()
          const body = (await response.text()).replace(/(\d+(?:\.\d+)?)vw\b/g, (_, value: string) => {
            return `${(Number(value) * viewportUnitsWidth) / 100}px`
          })
          await route.fulfill({ response, body })
        })
      }
      await page.goto('./')
      await page.getByRole('button', { name: 'Settings', exact: true }).tap()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await expect(dialog.getByRole('tabpanel', { name: 'Reading help' })).toBeVisible()
      // The sheet opens slightly scaled down: measure it once its opening animations are over.
      await dialog.evaluate((el) => Promise.allSettled(el.getAnimations().map((a) => a.finished)))
      const box = await dialog.boundingBox()
      expect(box?.width).toBeCloseTo(viewport.width * widthFraction, 0)
      expect(box?.x).toBeCloseTo((viewport.width * (1 - widthFraction)) / 2, 0)
    })
  })
}
