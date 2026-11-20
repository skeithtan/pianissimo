import { expect, test } from '../browser-test'

const layouts = [
  { name: 'tablet landscape', viewport: { width: 1194, height: 834 }, widthFraction: 0.7 },
  { name: 'wide tablet landscape', viewport: { width: 1389, height: 884 }, widthFraction: 0.7 },
  { name: 'phone portrait', viewport: { width: 393, height: 852 }, widthFraction: 1 },
  { name: 'phone landscape', viewport: { width: 852, height: 393 }, widthFraction: 1 },
]

for (const { name, viewport, widthFraction } of layouts) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })

    test('centers Settings at the expected width', async ({ page }) => {
      await page.goto('./')
      await page.getByRole('button', { name: 'Settings', exact: true }).tap()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await expect(dialog.getByRole('tabpanel', { name: 'Note names' })).toBeVisible()
      const box = await dialog.boundingBox()
      expect(box?.width).toBeCloseTo(viewport.width * widthFraction, 0)
      expect(box?.x).toBeCloseTo((viewport.width * (1 - widthFraction)) / 2, 0)
    })
  })
}
