/** Portrait loop handles cross systems without losing pointer capture or their snap bounds. */
import { expect, test, type Page } from '../browser-test'
import { generateLongScore } from '../fixtures/generate-long-score'
import { installFakeMidi } from './practice-helpers'

async function openLoop(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height })
  await installFakeMidi(page)
  await page.goto('./')
  await page
    .locator('label', { hasText: 'Add score' })
    .first()
    .locator('input[type="file"]')
    .setInputFiles({
      name: 'page-loop.musicxml',
      mimeType: 'application/xml',
      buffer: Buffer.from(generateLongScore(12)),
    })
  await page.getByRole('button', { name: 'Add and open', exact: true }).click()
  await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
  // "Add and open" opens Practice paused; pause only if something is still playing.
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  if (await pause.isVisible()) await pause.click()
  await page.getByRole('button', { name: 'Repeat from here', exact: true }).click()
  await expect(page.locator('.pn-loop.pn-on')).toHaveCount(1)
}

async function grab(page: Page, which: 'start' | 'end'): Promise<void> {
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
}

async function dropAt(page: Page, which: 'start' | 'end', x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator(`.pn-page .pn-handle-${which}`)).not.toHaveClass(/pn-grab/)
}

async function drag(page: Page, which: 'start' | 'end', x: number, y: number): Promise<void> {
  await grab(page, which)
  await dropAt(page, which, x, y)
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
  // The page now rests with the second system at its top (right under the timing cue's reserved
  // row), so the first one is out of view: a handle held at the top edge scrolls it back.
  const firstSystem = page.locator('.pn-page .pn-seg[data-system="0"] > svg.pn-music')
  const stage = (await page.locator('.pn-page').boundingBox())!
  await grab(page, 'start')
  await page.mouse.move(second.x + second.width * 0.3, stage.y + 8, { steps: 12 })
  await expect.poll(async () => (await firstSystem.boundingBox())!.y).toBeGreaterThan(stage.y)
  const first = (await firstSystem.boundingBox())!
  await dropAt(page, 'start', first.x + first.width * 0.3, first.y + first.height / 2)
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
