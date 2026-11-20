/** Playback must start at the visible cursor after browsing and keep following the sound. */
import { expect, test, type Page } from '../browser-test'
import { importFixture } from '../unit/import/fixtures'
import { installFakeMidi, openSeededPractice, playWhenDue, seedPiece } from './practice-helpers'

async function headX(page: Page, midi: number): Promise<number> {
  const built = await importFixture('two-hands.musicxml')
  const note = built.package.model.notes.findIndex((n) => n.midi === midi)
  expect(note).toBeGreaterThanOrEqual(0)
  const box = (await page.locator(`.pn-music [data-n="${note}"]`).first().boundingBox())!
  return box.x + box.width / 2
}

/** Pan the notation until an exact onset sits beneath the fixed playhead. */
async function browseTo(page: Page, midi: number, wheel = false): Promise<number> {
  const strip = page.locator('.pn-strip')
  const box = (await strip.boundingBox())!
  const line = box.x + box.width / 3
  const delta = line - (await headX(page, midi))
  const from = box.x + box.width * 0.65
  const y = box.y + box.height * 0.7
  await page.mouse.move(from, y)
  if (wheel) await page.mouse.wheel(-delta, 0)
  else {
    await page.mouse.down()
    await page.mouse.move(from + delta, y, { steps: 10 })
    await page.mouse.up()
  }
  await expect(strip).toHaveClass(/pn-browsing/)
  await expect.poll(async () => Math.abs((await headX(page, midi)) - line)).toBeLessThan(3)
  return line
}

async function seekBarTwo(page: Page): Promise<void> {
  const grip = page.getByTestId('cursor-grip')
  await grip.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 2, beat 1')
  const box = (await page.locator('.pn-strip').boundingBox())!
  await expect.poll(async () => Math.abs((await headX(page, 67)) - box.x - box.width / 3)).toBeLessThan(3)
}

test.describe('playback from the visible cursor', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
  })

  for (const resumed of [false, true]) {
    test(`${resumed ? 'resumed' : 'first'} Listen starts at the note browsed backward to and follows playback`, async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Left hand', exact: true }).click()
      await page.getByRole('button', { name: 'Right hand', exact: true }).click()
      await seekBarTwo(page)
      if (resumed) {
        await page.getByRole('button', { name: 'Listen', exact: true }).click()
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
      }
      const line = await browseTo(page, 62, resumed)
      await page.evaluate(() => (window.__midi.sent.length = 0))
      await page.getByRole('button', { name: resumed ? 'Play' : 'Listen', exact: true }).click()
      // D4 is inside bar 1: choosing only the browsed bar would incorrectly sound C4 instead.
      await expect
        .poll(() =>
          page.evaluate(() => window.__midi.sent.find((m) => (m[0]! & 0xf0) === 0x90 && m[2]! > 0 && m[1]! >= 60)?.[1]),
        )
        .toBe(62)
      await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-browsing/)
      // The fixed line stays put as the score advances beyond the selected D4 onset.
      await expect.poll(async () => (await headX(page, 62)) - line).toBeLessThan(-20)
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
    })
  }

  test('reading starts at the exact browsed onset', async ({ page }) => {
    await seekBarTwo(page)
    const line = await browseTo(page, 64)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-browsing/)
    await expect.poll(async () => Math.abs((await headX(page, 64)) - line)).toBeLessThan(3)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)
    await expect(page.locator('[data-phase="completed"]')).toHaveCount(1)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
  })

  test('keyboard seeking after browsing starts from the visible note and restores following', async ({ page }) => {
    const grip = page.getByTestId('cursor-grip')
    await seekBarTwo(page)
    const line = await browseTo(page, 62)
    await grip.focus()
    await page.keyboard.press('ArrowRight')
    await expect(grip).toHaveAttribute('aria-valuetext', 'Bar 1, beat 3')
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-browsing/)
    await expect.poll(async () => Math.abs((await headX(page, 64)) - line)).toBeLessThan(3)
  })
})

for (const portrait of [false, true]) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`Listen rewinds and waits for Play in ${portrait ? 'page' : 'strip'} view (${reducedMotion})`, async ({
      page,
    }) => {
      await page.setViewportSize(portrait ? { width: 820, height: 1180 } : { width: 1180, height: 820 })
      await page.emulateMedia({ reducedMotion })
      await installFakeMidi(page)
      await seedPiece(page)
      await openSeededPractice(page)
      await page.getByRole('button', { name: 'Left hand', exact: true }).click()
      await page.getByRole('button', { name: 'Right hand', exact: true }).click()
      const moving = page.locator(portrait ? '.pn-page .pn-cursor' : '.pn-strip .pn-content')
      const openingX = await moving.evaluate((el) => new DOMMatrix((el as HTMLElement).style.transform).m41)
      const overview = page.getByRole('slider', { name: 'Piece overview' })
      await overview.press('End')
      await expect(overview).toHaveAttribute('aria-valuenow', '2')
      await page.getByRole('button', { name: 'Listen', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()

      // At the rewind the inline transform points to the opening. The computed transform
      // still shows an intermediate frame unless Reduced Motion was requested.
      const animated = await moving.evaluate(
        (el, openingX) =>
          new Promise<boolean>((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const sample = () => {
              const x = new DOMMatrix((el as HTMLElement).style.transform).m41
              if (Math.abs(x - openingX) < 1) {
                const visibleX = new DOMMatrix(getComputedStyle(el).transform).m41
                resolve(Math.abs(visibleX - openingX) > 1)
              } else if (performance.now() >= deadline) reject(new Error('The score did not return to the opening'))
              else requestAnimationFrame(sample)
            }
            requestAnimationFrame(sample)
          }),
        openingX,
      )
      expect(animated).toBe(reducedMotion === 'no-preference')
      await expect(overview).toHaveAttribute('aria-valuenow', '1')
      const play = page.getByRole('button', { name: 'Play', exact: true })
      await expect(play).toBeVisible()

      const attacks = () =>
        page.evaluate(
          () => window.__midi.sent.filter(([status, , velocity]) => status === 0x90 && velocity! > 0).length,
        )
      const before = await attacks()
      await expect
        .poll(() => moving.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41))
        .toBeCloseTo(openingX, 0)
      expect(await attacks()).toBe(before)
      await play.click()
      await expect.poll(attacks).toBeGreaterThan(before)
    })
  }
}
