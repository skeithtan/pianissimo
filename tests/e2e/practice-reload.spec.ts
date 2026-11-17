/**
 * Repeat mode survives a reload (DECISIONS U98): the loop, "Repeat until", the speed ladder, the
 * hand and the speed come back with the piece, paused at the loop start. Closing Repeat or
 * clearing the loop stays closed. Nothing transient returns: no result pill, nothing playing.
 * Fake Web MIDI and the seeded Two Hands piece (practice-helpers.ts); the Repeat toggle may
 * appear a beat after the screen mounts (the fake piano connects a moment later), so every
 * check waits through Playwright's auto-waiting assertions.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  installFakeMidi,
  openFooterMenu,
  openSeededPractice,
  PIECE_ID,
  playWhenDue,
  seedPiece,
} from './practice-helpers'

const TABLET = { width: 1180, height: 820 }
const TABLET_PORTRAIT = { width: 820, height: 1180 }
const PHONE = { width: 390, height: 844 }

const panelOf = (page: Page) => page.getByTestId('repeat-controls')
const loopStart = (page: Page) => panelOf(page).getByRole('group', { name: 'Loop start' })
const loopEnd = (page: Page) => panelOf(page).getByRole('group', { name: 'Loop end' })

/** Seeds the piece at a viewport and opens its Practice view. */
async function openPractice(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport)
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
}

/** Reloads and waits for the same piece's Practice view (opening it from the Library if the app lands there). */
async function reloadPractice(page: Page): Promise<void> {
  await page.reload()
  const heading = page.locator('h1', { hasText: 'Two Hands' })
  const open = page.getByRole('button', { name: 'Practice Two Hands' })
  await expect(heading.or(open)).toBeVisible()
  if (!(await heading.isVisible())) await open.click()
  await expect(page).toHaveURL(new RegExp(`#/practice/${PIECE_ID}`))
  await expect(page.locator('.pn-strip, .pn-page').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
}

/** Opens Repeat from the cursor's button. */
async function openRepeat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Repeat from here' }).click()
  await expect(panelOf(page)).toBeVisible()
}

/** Makes the loop bars 1-2 and moves its start to the second bar, so it is one bar that is not the default. */
async function loopBarTwo(page: Page): Promise<void> {
  await loopEnd(page).getByRole('button', { name: 'Move loop end one bar later' }).click()
  await expect(loopEnd(page)).toContainText('Bar 2')
  await loopStart(page).getByRole('button', { name: 'Move loop start one bar later' }).click()
  await expect(loopStart(page)).toContainText('Bar 2')
  await expect(loopEnd(page)).toContainText('Bar 2')
}

/** Sets Repeat until 5 and switches the speed ladder on (tablet layouts: the goal popover). */
async function setGoal(page: Page): Promise<void> {
  await panelOf(page)
    .getByRole('button', { name: /^Repeat goal: / })
    .click()
  const options = panelOf(page).getByRole('dialog', { name: 'Repeat options' })
  await options.getByRole('radiogroup', { name: 'Repeat until' }).getByRole('radio', { name: '5' }).click()
  await options.getByRole('switch', { name: 'Speed ladder' }).check()
  await page.keyboard.press('Escape')
  await expect(options).toHaveCount(0)
}

/** Picks the Right hand only and 75% speed. */
async function setHandAndSpeed(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Left hand', exact: true }).click()
  await page.getByRole('button', { name: /Open speed options/ }).click()
  const speed = page.getByRole('dialog', { name: 'Playback speed' })
  await speed.getByRole('group', { name: 'Speed presets' }).getByRole('button', { name: '75%', exact: true }).click()
  await page.getByRole('button', { name: /Open speed options/ }).click()
  await expect(speed).toHaveCount(0)
}

interface Snapshot {
  start: string
  end: string
  target: string
  ladder: string
  speed: string
  left: string | null
  right: string | null
  box: { x: number; y: number; width: number; height: number } | null
}

/** What the Repeat panel and the controls around it show now. */
async function snapshot(page: Page): Promise<Snapshot> {
  const hand = (name: string) => page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed')
  const loop = page.locator('.pn-loop.pn-on').first()
  return {
    start: (await loopStart(page).textContent()) ?? '',
    end: (await loopEnd(page).textContent()) ?? '',
    target: (await panelOf(page).getByTestId('target-line').textContent()) ?? '',
    ladder: (await panelOf(page).getByTestId('ladder-line').textContent()) ?? '',
    speed: (await page.getByRole('button', { name: /Open speed options/ }).getAttribute('aria-label')) ?? '',
    left: await hand('Left hand'),
    right: await hand('Right hand'),
    box: await loop.boundingBox(),
  }
}

/** Nothing transient came back: paused at Start, no result pill. */
async function expectIdle(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('attempt-result')).toHaveCount(0)
}

async function expectRestored(page: Page, before: Snapshot): Promise<void> {
  await expect(panelOf(page)).toBeVisible()
  await expect(page.locator('.pn-loop.pn-on')).not.toHaveCount(0)
  await expect(loopStart(page)).toHaveText(before.start)
  await expect(loopEnd(page)).toHaveText(before.end)
  await expect(panelOf(page).getByTestId('target-line')).toHaveText(before.target)
  await expect(panelOf(page).getByTestId('ladder-line')).toHaveText(before.ladder)
  await expectIdle(page)
  const after = await snapshot(page)
  expect(after.speed).toBe(before.speed)
  expect(after.left).toBe(before.left)
  expect(after.right).toBe(before.right)
  // The reload puts the cursor on the loop start, so the strip scrolls: the band keeps its size, not its place.
  // It may still be settling (a resize animation), so poll.
  if (before.box) {
    const was = before.box
    const drift = async () => {
      const box = await page.locator('.pn-loop.pn-on').first().boundingBox()
      return box ? Math.max(Math.abs(box.width - was.width), Math.abs(box.height - was.height)) : Infinity
    }
    await expect.poll(drift, { timeout: 5000 }).toBeLessThan(3)
  }
}

for (const [name, viewport, layout] of [
  ['strip', TABLET, '.pn-strip'],
  ['page', TABLET_PORTRAIT, '.pn-page'],
] as const) {
  test(`${name}: the loop, goal, ladder, hand and speed come back after a reload`, async ({ page }) => {
    await openPractice(page, viewport)
    await expect(page.locator(layout)).toBeVisible()
    await openRepeat(page)
    await loopBarTwo(page)
    await setGoal(page)
    await setHandAndSpeed(page)
    await expect(panelOf(page).getByTestId('ladder-line')).toContainText('75% →')
    await expect(page.locator('.pn-loop.pn-on')).not.toHaveCount(0)
    // Let the loop's resize settle before measuring it.
    await page.waitForTimeout(500)
    const before = await snapshot(page)
    expect(before.target).toBe('Until 5 clean')
    expect(before.left).toBe('false')

    await reloadPractice(page)
    await expect(page.locator(layout)).toBeVisible()
    await expectRestored(page, before)
  })
}

test('phone: Repeat with its loop comes back after a reload (the docked row)', async ({ page }) => {
  await openPractice(page, PHONE)
  await openRepeat(page)
  await loopBarTwo(page)
  await expect(panelOf(page)).toHaveAttribute('data-layout', 'docked')
  const before = { start: await loopStart(page).textContent(), end: await loopEnd(page).textContent() }

  await reloadPractice(page)
  await expect(panelOf(page)).toBeVisible()
  await expect(panelOf(page)).toHaveAttribute('data-layout', 'docked')
  await expect(loopStart(page)).toHaveText(before.start ?? '')
  await expect(loopEnd(page)).toHaveText(before.end ?? '')
  await expectIdle(page)
})

test('a note-level loop edge survives a reload', async ({ page }) => {
  await openPractice(page, TABLET)
  await openRepeat(page)
  // The end handle one beat in: the loop ends inside bar 1 (the steppers show a note-level edge).
  const end = loopEnd(page)
  const handle = page.getByRole('button', { name: /Passage end/ })
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(end).not.toHaveText(/^\s*Bar 1\s*$/)
  const edge = await end.textContent()
  await page.waitForTimeout(400)

  await reloadPractice(page)
  await expect(panelOf(page)).toBeVisible()
  await expect(loopEnd(page)).toHaveText(edge ?? '')
})

test('closing Repeat but keeping its loop (Play through) stays closed and keeps the loop; the X clears it', async ({
  page,
}) => {
  await openPractice(page, TABLET)
  await openRepeat(page)
  await loopBarTwo(page)
  await page.waitForTimeout(400)
  // Play through closes Repeat and keeps the loop for later (the panel's X would clear it).
  const menu = await openFooterMenu(page)
  await menu.getByRole('switch', { name: 'Play through' }).click()
  await page.keyboard.press('Escape')
  await expect(panelOf(page)).toHaveCount(0)

  await reloadPractice(page)
  // Give a late-connecting piano time to (wrongly) bring Repeat back.
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await expect(panelOf(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Repeat from here' }).click()
  await expect(loopStart(page)).toContainText('Bar 2')
  await expect(loopEnd(page)).toContainText('Bar 2')

  // The panel's X clears the loop and leaves Repeat.
  await panelOf(page).getByRole('button', { name: 'Exit repeat' }).click()
  await expect(panelOf(page)).toHaveCount(0)
  await reloadPractice(page)
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
  await expect(panelOf(page)).toHaveCount(0)
  await expect(page.locator('.pn-loop.pn-on')).toHaveCount(0)
})

test('a completed pass is not brought back by a reload', async ({ page }) => {
  await openPractice(page, TABLET)
  await openRepeat(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await playWhenDue(page, 60, 48)
  await playWhenDue(page, 62)
  await playWhenDue(page, 64)
  await playWhenDue(page, 65)
  await expect(page.getByTestId('attempt-result')).toContainText('Clean pass')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.waitForTimeout(400)
  const start = await loopStart(page).textContent()
  const end = await loopEnd(page).textContent()

  await reloadPractice(page)
  await expect(panelOf(page)).toBeVisible()
  await expect(loopStart(page)).toHaveText(start ?? '')
  await expect(loopEnd(page)).toHaveText(end ?? '')
  await expect(page.locator('.pn-loop.pn-on')).not.toHaveCount(0)
  await expectIdle(page)
})

test('leaving to the Library and opening the piece again keeps Repeat on over its loop', async ({ page }) => {
  await openPractice(page, TABLET)
  await openRepeat(page)
  await loopBarTwo(page)
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()

  await page.getByRole('button', { name: 'Practice Two Hands' }).click()
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  await expect(panelOf(page)).toBeVisible()
  await expect(loopStart(page)).toContainText('Bar 2')
  await expect(loopEnd(page)).toContainText('Bar 2')
  await expectIdle(page)
})
