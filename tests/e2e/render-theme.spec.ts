/**
 * Theme-aware score (user requirement: dark mode includes the score). The cached layout carries
 * no colors; switching the theme recolors ink, paper and overlays through CSS variables only,
 * without re-engraving. Screenshots for light, dark and dark with pinned light paper are attached.
 */
import { expect, test, type Page } from '@playwright/test'
import { openHarness } from './render-helpers'

interface ScoreColors {
  head: string
  staffLine: string
  paper: string
  label: string
  target: string
  accepted: string
  playback: string
}

async function inkOf(page: Page): Promise<ScoreColors> {
  return page.evaluate(() => {
    const head = document.querySelector('.pn-music [data-n] path')!
    const staffLine = document.querySelector('.pn-music .vf-measure > path')!
    const label = document.querySelector('.pn-label')
    return {
      head: getComputedStyle(head).fill,
      staffLine: getComputedStyle(staffLine).stroke,
      paper: getComputedStyle(document.querySelector('.pn-strip')!).backgroundColor,
      label: label ? getComputedStyle(label).fill : '',
      target: getComputedStyle(document.querySelector('.pn-music .pn-target path')!).fill,
      accepted: getComputedStyle(document.querySelector('.pn-music .pn-acc path')!).fill,
      playback: getComputedStyle(document.querySelector('.pn-music .pn-play path')!).fill,
    }
  })
}

test('notation ink, paper and labels follow explicit and system themes without re-engraving', async ({
  page,
}, info) => {
  // This is a color-state check; suppress note fill transitions while sampling computed colors.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openHarness(page)
  await page.evaluate(async () => {
    window.harness.setTheme('light')
    await window.harness.prepare('changes')
    window.harness.mount({ width: 1000, height: 300 })
    window.harness.showAllLabels()
    const s = window.harness.strip()!
    s.setTargets([3, 4])
    s.setAccepted([1])
    s.setPlaybackHighlights([2])
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

  // Always light uses classic paper, which may differ from the active light palette.
  await page.evaluate(() => window.harness.setTheme('light', true))
  const pinnedLight = await inkOf(page)

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

  expect(dark.head).not.toBe(light.head)
  expect(dark.staffLine).not.toBe(light.staffLine)
  expect(dark.paper).not.toBe(light.paper)
  expect(dark.label).not.toBe(light.label)
  expect(dark.target).not.toBe(light.target)
  expect(dark.accepted).not.toBe(light.accepted)
  expect(dark.playback).not.toBe(light.playback)
  // Pinned paper uses the light semantic inks as well as light ordinary notes and All labels.
  expect(pinned).toEqual(pinnedLight)

  // System dark and explicit dark must agree. Pinned light paper must win in both modes,
  // including when the OS preference changes while the app is mounted.
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.evaluate(() => delete document.documentElement.dataset['theme'])
  expect(await inkOf(page)).toEqual(pinnedLight)
  await page.evaluate(() => delete document.documentElement.dataset['scorePaper'])
  expect(await inkOf(page)).toEqual(dark)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  expect(await inkOf(page)).toEqual(light)
  expect(await parsed()).toBe(parsedBefore)
})
