/**
 * The draggable playhead and note-level loops (WP13; DECISIONS U19, U21–U23) in the real app:
 * drag the cursor onto a note and continue from there; drag a loop handle into a bar, play the
 * note-level loop scored and see it repeat. Fake Web MIDI as in practice.spec.ts.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { importFixture } from '../unit/import/fixtures'
import { SHOT_DIR, installFakeMidi, openSeededPractice, playWhenDue, seedPiece } from './practice-helpers'

/** Performed-note index of a pitch in the first bar of the Two Hands fixture (the strip's `data-n`). */
async function noteIndex(midi: number): Promise<number> {
  const built = await importFixture('two-hands.musicxml')
  const i = built.package.model.notes.findIndex((n) => n.occ === 0 && n.midi === midi)
  expect(i).toBeGreaterThanOrEqual(0)
  return i
}

/** Horizontal center of a notehead on screen. */
async function headX(page: Page, note: number): Promise<number> {
  const box = await page.locator(`.pn-music [data-n="${note}"]`).first().boundingBox()
  expect(box).not.toBeNull()
  return box!.x + box!.width / 2
}

test.describe('note-level practice', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
  })

  for (const action of ['pause', 'browse'] as const) {
    test(`the stage X clears the loop after Listen stops through ${action}`, async ({ page }) => {
      await page.setViewportSize({ width: 958, height: 846 })
      await page.getByRole('button', { name: 'Left hand', exact: true }).click()
      await page.getByRole('button', { name: 'Right hand', exact: true }).click()
      await page.getByRole('button', { name: 'Repeat from here' }).click()
      await page.getByRole('button', { name: 'Listen', exact: true }).click()
      await expect(page.locator('.pn-strip')).toHaveClass(/pn-loop-locked/)
      if (action === 'pause') {
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
      } else {
        const stage = (await page.locator('.pn-strip').boundingBox())!
        const x = stage.x + stage.width * 0.8
        const y = stage.y + stage.height * 0.75
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x - 70, y, { steps: 5 })
        await page.mouse.up()
        await expect(page.locator('.pn-strip')).toHaveClass(/pn-browsing/)
      }
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
      await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-loop-locked/)
      const clear = page.locator('.pn-loop-clear')
      await expect(clear).toBeVisible()
      await clear.click()
      await expect(page.getByTestId('repeat-controls')).toHaveCount(0)
      await expect(page.locator('.pn-loop.pn-on')).toHaveCount(0)
    })
  }

  test('dragging the playhead onto a note continues practice from that note', async ({ page, browserName }) => {
    const grip = page.getByTestId('cursor-grip')
    const g = (await grip.boundingBox())!
    const e4 = await headX(page, await noteIndex(64))
    // Below the round repeat button in the middle of the cursor.
    const y = g.y + g.height * 0.8
    await page.mouse.move(g.x + g.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(e4, y, { steps: 12 })
    await expect(page.locator('.pn-cursor-readout')).toHaveText('Bar 1, beat 3')
    await page.waitForTimeout(300) // let the readout fade in for the review screenshot
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-playhead-drag.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-playhead-drag-dark.png`) })
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
    await page.mouse.up()
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-cursor-dragging/)

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    // E4 is the current note now: it is accepted (C4 + C3 at the start of the bar would be wrong).
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)
    await expect(page.locator('[data-phase="completed"]')).toHaveCount(1) // the end of the piece (no banner)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
  })

  test('arrow keys move the playhead note by note and practice continues from there', async ({ page }) => {
    const grip = page.getByTestId('cursor-grip')
    await grip.focus()
    await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 1, beat 1')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 2, beat 1')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 1, beat 1')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 1, beat 3')
    await expect(page.locator('.pn-cursor-readout')).toHaveText('Bar 1, beat 3')

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    // The playhead is not draggable while an attempt runs: the grip loses focus and its keys.
    await expect(grip).toHaveAttribute('inert', '')
    // E4 is the current note now: it is accepted (C4 + C3 at the start of the bar would be wrong).
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)
    await expect(page.locator('[data-phase="completed"]')).toHaveCount(1) // the end of the piece (no banner)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
  })

  test('after browsing, the cursor button loops the bar under the fixed cursor line (U14)', async ({ page }) => {
    const strip = page.locator('.pn-strip')
    const box = (await strip.boundingBox())!
    // Bar 2's first notehead on screen; the cursor line rests one third across the strip.
    const built = await importFixture('two-hands.musicxml')
    const bar2 = built.package.model.notes.findIndex((n) => n.occ === 1)
    expect(bar2).toBeGreaterThanOrEqual(0)
    const x2 = await headX(page, bar2)
    const lineX = box.x + box.width / 3
    expect(x2).toBeGreaterThan(lineX)
    // Browse: drag the music left until bar 2 sits under the cursor line (the cursor stays in bar 1).
    const y = box.y + box.height / 2
    const from = box.x + box.width * 0.85
    await page.mouse.move(from, y)
    await page.mouse.down()
    await page.mouse.move(from - (x2 - lineX) - 20, y, { steps: 10 })
    await page.mouse.up()
    const back = page.getByRole('button', { name: 'Return to current position' })
    await expect(back).toBeVisible()

    await page.getByRole('button', { name: 'Repeat from here' }).click()
    const panel = page.getByTestId('repeat-controls')
    await expect(panel.getByRole('group', { name: 'Loop start' })).toContainText('Bar 2')
    await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 2')
    // Browsing ended with the press: the view follows the cursor, now in bar 2 (the return button
    // only fades, so the strip's browsing class is the signal).
    await expect(strip).not.toHaveClass(/pn-browsing/)
  })

  for (const browsed of [false, true]) {
    test(`a tap on the overview brings the tapped bar under the cursor line${browsed ? ' after browsing' : ''}`, async ({
      page,
    }) => {
      const strip = page.locator('.pn-strip')
      const box = (await strip.boundingBox())!
      const lineX = box.x + box.width / 3
      const built = await importFixture('two-hands.musicxml')
      const bar2 = built.package.model.notes.findIndex((n) => n.occ === 1)
      expect(bar2).toBeGreaterThanOrEqual(0)
      if (browsed) {
        // Browse past bar 2's first note, so the music under the line is not where the tap seeks.
        const x2 = await headX(page, bar2)
        const y = box.y + box.height / 2
        const from = box.x + box.width * 0.85
        await page.mouse.move(from, y)
        await page.mouse.down()
        await page.mouse.move(from - (x2 - lineX) - 150, y, { steps: 10 })
        await page.mouse.up()
        await expect(strip).toHaveClass(/pn-browsing/)
        expect(Math.abs((await headX(page, bar2)) - lineX)).toBeGreaterThan(40)
      }
      // Tap near the end of the overview: bar 2 of the two-bar piece.
      const overview = page.getByRole('slider', { name: 'Piece overview' })
      const ob = (await overview.boundingBox())!
      await page.mouse.click(ob.x + ob.width * 0.9, ob.y + ob.height / 2)
      await expect(overview).toHaveAttribute('aria-valuetext', /^Bar 2 of 2/)
      // The cursor line shows the new position: bar 2's first note sits under it.
      await expect.poll(async () => Math.abs((await headX(page, bar2)) - lineX)).toBeLessThan(4)
      await expect(strip).not.toHaveClass(/pn-browsing/)
    })
  }

  test('after browsing, a tap on a bar in the strip brings it under the cursor line', async ({ page }) => {
    const strip = page.locator('.pn-strip')
    const box = (await strip.boundingBox())!
    const lineX = box.x + box.width / 3
    const built = await importFixture('two-hands.musicxml')
    const bar2 = built.package.model.notes.findIndex((n) => n.occ === 1)
    expect(bar2).toBeGreaterThanOrEqual(0)
    // Browse past bar 2's first note: it now sits left of the cursor line.
    const x2 = await headX(page, bar2)
    const y = box.y + box.height / 2
    const from = box.x + box.width * 0.85
    await page.mouse.move(from, y)
    await page.mouse.down()
    await page.mouse.move(from - (x2 - lineX) - 150, y, { steps: 10 })
    await page.mouse.up()
    await expect(strip).toHaveClass(/pn-browsing/)
    const browsedX = await headX(page, bar2)
    expect(lineX - browsedX).toBeGreaterThan(40)
    // Tap bar 2 just right of its first note (on the staff, not the cursor's grip).
    await page.mouse.click(browsedX + 12, y)
    await expect(strip).not.toHaveClass(/pn-browsing/)
    await expect.poll(async () => Math.abs((await headX(page, bar2)) - lineX)).toBeLessThan(4)
  })

  test('a loop handle dragged into a bar makes a note-level loop that is scored and repeats', async ({
    page,
    browserName,
  }) => {
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    const panel = page.getByTestId('repeat-controls')
    await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 1')

    // Drag the end handle to just before E4: the loop now ends after D4, inside bar 1.
    const handle = page.getByRole('button', { name: /Passage end/ })
    const h = (await handle.boundingBox())!
    const d4 = await headX(page, await noteIndex(62))
    const e4 = await headX(page, await noteIndex(64))
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move((d4 + e4) / 2, h.y + h.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 1, beat 2')
    await expect(panel.getByRole('group', { name: 'Loop start' })).toContainText('Bar 1')
    // The band ends between D4 and E4 (once its 200 ms resize has settled).
    const bandEnd = async () => {
      const band = (await page.locator('.pn-loop').boundingBox())!
      return band.x + band.width
    }
    await expect.poll(bandEnd).toBeLessThan(e4)
    expect(await bandEnd()).toBeGreaterThan(d4)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-note-loop.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-note-loop-dark.png`) })
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('ready')).toBeVisible()
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('Clean pass')
    // Repeat: back to Ready at the loop start (the result card stays); a second clean pass makes a streak.
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready')
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    await expect(card).toContainText('2 clean in a row')

    // Results name the loop by its notes.
    await card.getByRole('button', { name: 'Details' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
    await expect(page.locator('[data-row="context"]')).toContainText('Bar 1, beats 1–2')
  })
})
