/** Portrait loop handles cross systems without losing pointer capture or their snap bounds. */
import { expect, test, type Page } from '@playwright/test'
import { generateLongScore } from '../fixtures/generate-long-score'
import { installFakeMidi } from './practice-helpers'

async function openLoop(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await installFakeMidi(page)
  await page.goto('./')
  await page
    .locator('label', { hasText: 'Import MusicXML' })
    .first()
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'page-loop.musicxml',
      mimeType: 'application/xml',
      buffer: Buffer.from(generateLongScore(12)),
    })
  await page.getByRole('button', { name: 'Add to library', exact: true }).click()
  await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.getByRole('button', { name: 'Repeat from here', exact: true }).click()
  await expect(page.locator('.pn-loop.pn-on')).toHaveCount(1)
}

async function drag(page: Page, which: 'start' | 'end', x: number, y: number): Promise<void> {
  const handle = page.locator(`.pn-page .pn-handle-${which}`)
  // The Repeat panel can overlap the center of a handle on the first system. Grab an exposed
  // part of its full-height touch target, as a person can, without forcing through the panel.
  const point = await handle.evaluate((el) => {
    const b = el.getBoundingClientRect()
    const x = b.x + b.width / 2
    for (const y of [b.y + b.height / 2, b.top + 5, b.bottom - 5]) {
      const hit = document.elementFromPoint(x, y)
      if (hit && el.contains(hit)) return { x: b.width / 2, y: y - b.top }
    }
    return null
  })
  expect(point).not.toBeNull()
  await handle.hover({ position: point! })
  await page.mouse.down()
  await expect(handle).toHaveClass(/pn-grab/)
  await page.mouse.move(x, y, { steps: 12 })
  await page.mouse.up()
  await expect(handle).not.toHaveClass(/pn-grab/)
}

test('both loop handles drag vertically between page systems', async ({ page }) => {
  await openLoop(page, 820, 1180)
  const second = (await page.locator('.pn-page .pn-seg[data-system="1"] > svg.pn-music').boundingBox())!
  const y = second.y + second.height / 2
  await drag(page, 'end', second.x + second.width * 0.7, y)
  await expect(page.locator('.pn-loop.pn-on[data-system="0"]')).toHaveCount(1)
  await expect(page.locator('.pn-loop.pn-on[data-system="1"]')).toHaveCount(1)

  await drag(page, 'start', second.x + second.width * 0.3, y)
  await expect(page.locator('.pn-loop.pn-on[data-system="0"]')).toHaveCount(0)
  await expect(page.locator('.pn-loop.pn-on[data-system="1"]')).toHaveCount(1)
  const first = (await page.locator('.pn-page .pn-seg[data-system="0"] > svg.pn-music').boundingBox())!
  await drag(page, 'start', first.x + first.width * 0.3, first.y + first.height / 2)
  await expect(page.locator('.pn-loop.pn-on[data-system="0"]')).toHaveCount(1)
  await expect(page.locator('.pn-loop.pn-on[data-system="1"]')).toHaveCount(1)
})

test('the narrow page wraps a held end handle once at its right edge', async ({ page }) => {
  await openLoop(page, 586, 846)
  const handle = page.locator('.pn-page .pn-handle-end')
  const box = (await handle.boundingBox())!
  const stage = (await page.locator('.pn-page').boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await expect(handle).toHaveClass(/pn-grab/)
  await page.mouse.move(stage.x + stage.width - 1, y, { steps: 12 })
  await expect(page.locator('.pn-loop.pn-on[data-system="1"]')).toHaveCount(1)
  await expect(page.locator('.pn-loop.pn-on[data-system="2"]')).toHaveCount(0)
  await page.waitForTimeout(500)
  await page.mouse.move(stage.x + stage.width - 0.5, y)
  await expect(page.locator('.pn-loop.pn-on[data-system="2"]')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.pn-loop.pn-on[data-system="1"]')).toHaveCount(1)
  const endLabel = await page.getByTestId('repeat-controls').getByRole('group', { name: 'Loop end' }).textContent()
  expect(Number(endLabel?.match(/Bar (\d+)/)?.[1])).toBeGreaterThan(1)
})
