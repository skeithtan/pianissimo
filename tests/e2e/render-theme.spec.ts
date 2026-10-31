/**
 * Theme-aware score (user requirement: dark mode includes the score). The cached layout carries
 * no colors; switching the theme recolors ink, paper and overlays through CSS variables only,
 * without re-engraving. Screenshots for light, dark and dark with pinned light paper are attached.
 */
import { expect, test, type Page } from '@playwright/test'
import { openHarness } from './render-helpers'

async function inkOf(page: Page): Promise<{ head: string; staffLine: string; paper: string; label: string }> {
  return page.evaluate(() => {
    const head = document.querySelector('.pn-music [data-n] path')!
    const staffLine = document.querySelector('.pn-music .vf-measure > path')!
    const label = document.querySelector('.pn-label')
    return {
      head: getComputedStyle(head).fill,
      staffLine: getComputedStyle(staffLine).stroke,
      paper: getComputedStyle(document.querySelector('.pn-strip')!).backgroundColor,
      label: label ? getComputedStyle(label).fill : '',
    }
  })
}

test('notation ink, paper and labels follow the theme without re-engraving', async ({ page }, info) => {
  await openHarness(page)
  await page.evaluate(async () => {
    window.harness.setTheme('light')
    await window.harness.prepare('changes')
    window.harness.mount({ width: 1000, height: 300 })
    window.harness.showAllLabels()
    const s = window.harness.strip()!
    s.setTargets([3, 4])
    s.setLoop({ fromOcc: 2, toOcc: 2 })
    s.flushNow()
  })
  const parsed = () => page.evaluate(() => window.harness.strip()!.stats().parsedSegments)
  const parsedBefore = await parsed()

  const light = await inkOf(page)
  await info.attach('theme-light.png', {
    body: await page.locator('#strip-host').screenshot(),
    contentType: 'image/png',
  })

  await page.evaluate(() => window.harness.setTheme('dark'))
  const dark = await inkOf(page)
  await info.attach('theme-dark.png', {
    body: await page.locator('#strip-host').screenshot(),
    contentType: 'image/png',
  })

  await page.evaluate(() => window.harness.setTheme('dark', true))
  const pinned = await inkOf(page)
  await info.attach('theme-dark-light-paper.png', {
    body: await page.locator('#strip-host').screenshot(),
    contentType: 'image/png',
  })

  expect(light.head).toBe('rgb(17, 17, 17)')
  expect(dark.head).toBe('rgb(227, 230, 238)')
  expect(dark.head).not.toBe(light.head)
  expect(dark.staffLine).not.toBe(light.staffLine)
  expect(dark.paper).not.toBe(light.paper)
  expect(dark.label).not.toBe(light.label)
  expect(pinned).toEqual(light)
  expect(await parsed()).toBe(parsedBefore)
})
