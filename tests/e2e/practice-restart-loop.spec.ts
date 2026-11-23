import { join } from 'node:path'
import { expect, test } from '../browser-test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { installFakeMidi, openFooterMenu, play, playWhenDue, seedPiece, waitForOnset } from './practice-helpers'

const shots = process.env['PW_RESTART_SHOTS']
const layouts = [
  { name: 'tablet', width: 1180, height: 820, theme: 'light', mode: 'strip' },
  { name: 'phone', width: 390, height: 844, theme: 'dark', mode: 'page' },
] as const

for (const { name, width, height, theme, mode } of layouts) {
  test(`Restart loop goes back to the first selected note on ${name}`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await installFakeMidi(page)
    await seedPiece(page, { view: { ...DEFAULT_SETTINGS.view, theme } })
    await page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ }).click()
    await expect(page.locator(`.pn-${mode}`)).toBeVisible({ timeout: 60_000 })

    const restart = page.getByRole('button', { name: 'Restart loop', exact: true })
    const start = page.getByRole('button', { name: 'Start', exact: true })
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    const score = page.locator('[data-repeat-bounds]')
    const speed = page.getByRole('button', { name: /^Speed 100%/ })
    const speedX = name === 'tablet' ? (await speed.boundingBox())!.x : null
    await expect(restart).toHaveCount(0)
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    await expect(restart).toBeVisible()
    await page.getByRole('button', { name: /^Passage start/ }).press('ArrowRight')
    const loopStart = page.getByRole('group', { name: 'Loop start' })
    await expect(loopStart).toContainText('Bar 1, beat 2')
    await expect(restart).toBeVisible()
    if (shots && name === 'tablet')
      await page.screenshot({ path: join(shots, `${browserName}-${name}-loop-before-start.png`) })

    await (name === 'tablet' ? restart : start).click()
    await waitForOnset(page, 62)
    // The sustained left-hand C also needs a fresh attack at this mid-bar loop boundary.
    await play(page, 62, 48)
    await waitForOnset(page, 64)
    await expect(restart).toHaveCount(0)
    // Keyboard navigation reveals the phone's Pause without moving the cursor.
    if (name === 'phone') await page.keyboard.press('Tab')
    await pause.click()
    await expect(score.getByRole('button', { name: 'Restart loop', exact: true })).toBeVisible()
    await expect(page.locator('footer').getByRole('button', { name: 'Restart loop' })).toHaveCount(0)
    if (speedX !== null) await expect.poll(async () => (await speed.boundingBox())?.x).toBe(speedX)

    const returnButton = score.locator('.pn-return')
    for (const property of ['border-radius', 'font-size', 'min-height']) {
      const value = await returnButton.evaluate(
        (button, name) => getComputedStyle(button).getPropertyValue(name),
        property,
      )
      await expect(restart).toHaveCSS(property, value)
    }
    const accentFill = await returnButton.evaluate((button) => getComputedStyle(button).backgroundColor)
    await expect(restart).not.toHaveCSS('background-color', accentFill)
    await expect(restart).toHaveCSS('border-top-width', '1px')
    const box = (await restart.boundingBox())!
    const bounds = (await score.boundingBox())!
    expect(box.x - bounds.x).toBeLessThan(32)
    const bottomGap = bounds.y + bounds.height - box.y - box.height
    expect(bottomGap).toBeGreaterThan(8)
    expect(bottomGap).toBeLessThan(24)
    if (shots) await page.screenshot({ path: join(shots, `${browserName}-${name}-neutral-restart.png`) })

    await restart.click()
    await expect(restart).toHaveCount(0)
    await expect(page.getByTestId('ready')).toBeVisible()
    await waitForOnset(page, 62)
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
    if (shots && name === 'tablet')
      await page.screenshot({ path: join(shots, `${browserName}-${name}-neutral-restarted.png`) })
  })
}

test.describe('Repeat playback and results', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 })
    await installFakeMidi(page)
    await seedPiece(page)
    await page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ }).click()
    await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  })

  test('Keep time restarts with a fresh count-in after pausing before or during playback', async ({ page }) => {
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await page.keyboard.press('Escape')
    await page.clock.install()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    const countIn = page.getByTestId('count-in')
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    const restart = page.getByRole('button', { name: 'Restart loop', exact: true })
    await expect(countIn).toBeVisible()
    await pause.click()
    await expect(countIn).toHaveCount(0)
    await restart.click()
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 4')

    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 150)))
    await page.clock.runFor(5000)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running')
    await page.clock.resume()
    await pause.click()

    await restart.click()
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 4')
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
  })

  test('Restart loop plays Listen from the beginning before and after pausing', async ({ page }) => {
    await page.getByRole('button', { name: 'Left hand', exact: true }).click()
    await page.getByRole('button', { name: 'Right hand', exact: true }).click()
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    const sentNote = (pitch: number) =>
      page.evaluate(
        (note) =>
          window.__midi.sent.some(
            ([status, key, velocity]) =>
              status !== undefined && (status & 0xf0) === 0x90 && key === note && (velocity ?? 0) > 0,
          ),
        pitch,
      )

    const restart = page.getByRole('button', { name: 'Restart loop', exact: true })
    await restart.click()
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    await expect.poll(() => sentNote(60)).toBe(true)
    await expect.poll(() => sentNote(62)).toBe(true)
    await pause.click()
    await page.evaluate(() => {
      window.__midi.sent.length = 0
    })

    await restart.click()
    await expect(pause).toBeVisible()
    await expect.poll(() => sentNote(60)).toBe(true)
  })

  test('the restart button clears the result pill on a phone held sideways', async ({ page }) => {
    await page.setViewportSize({ width: 667, height: 375 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    const result = page.getByTestId('attempt-result')
    await expect(result).toBeVisible()
    await waitForOnset(page, 60, 48)
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()

    const restart = page.getByRole('button', { name: 'Restart loop', exact: true })
    await expect(restart).toBeVisible()
    await expect(result).toBeVisible()
    const [button, pill] = await Promise.all([restart.boundingBox(), result.boundingBox()])
    expect(button!.y + button!.height).toBeLessThan(pill!.y)
    await restart.click()
    await expect(restart).toHaveCount(0)
    await waitForOnset(page, 60, 48)
  })
})

/**
 * Restart loop never sits on the result pill or on Return to current position, whatever the width
 * and the language (P11): a phone on its side, a narrow tablet upright, a phone upright, in
 * English, French and Japanese (the device language, switched in place).
 */
test('Restart loop clears the result pill and Return to current position at every width', async ({ page }) => {
  test.setTimeout(200_000)
  await page.setViewportSize({ width: 1180, height: 820 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFakeMidi(page)
  await seedPiece(page)
  await page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ }).click()
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Repeat from here' }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await playWhenDue(page, 60, 48)
  await play(page, 30)
  await playWhenDue(page, 62)
  await playWhenDue(page, 64)
  await playWhenDue(page, 65)
  const result = page.getByTestId('attempt-result')
  await expect(result).toBeVisible()
  await waitForOnset(page, 60, 48)
  await page.keyboard.press('Tab')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const restart = page.locator('[data-repeat-bounds] .pn-score-action:not(.pn-return)')
  await expect(restart).toBeVisible()
  const speak = (languages: string[]) =>
    page.evaluate((languages) => {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: languages })
      window.dispatchEvent(new Event('languagechange'))
    }, languages)
  const problems: string[] = []
  for (const size of [
    { width: 852, height: 393 },
    { width: 760, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(1500)
    for (const languages of [['en-US'], ['fr-FR'], ['ja-JP'], ['es-ES'], ['fil-PH']]) {
      await speak(languages)
      await expect(page.locator('html')).toHaveAttribute('lang', languages[0]!)
      await page.waitForTimeout(300)
      // Browse a little, so Return to current position shows too.
      await page
        .locator('.pn-strip')
        .first()
        .evaluate((el) => el.classList.add('pn-browsing'))
      await page.waitForTimeout(250)
      const found = await page.evaluate(() => {
        const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
        const restart = box(document.querySelector('[data-repeat-bounds] .pn-score-action:not(.pn-return)'))!
        const pill = box(document.querySelector('[data-testid="attempt-result"] [data-expandable]'))
        const back = box(document.querySelector('.pn-browsing .pn-return'))
        const out: string[] = []
        const overlap = (a: DOMRect, b: DOMRect) =>
          a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
        if (restart.left < 0 || restart.right > innerWidth) out.push('restart off screen')
        if (pill && overlap(restart, pill)) out.push('restart over the result pill')
        if (back && overlap(restart, back)) out.push('restart over Return to current position')
        return out
      })
      if (process.env['P11_SHOTS'])
        await page.screenshot({ path: `${process.env['P11_SHOTS']}/${size.width}x${size.height}-${languages[0]}.png` })
      await page
        .locator('.pn-strip')
        .first()
        .evaluate((el) => el.classList.remove('pn-browsing'))
      for (const p of found) problems.push(`${size.width}×${size.height} ${languages[0]}: ${p}`)
      // A pill as wide as it can be (a long note line, a Keep time line): Restart loop moves up.
      if (size.height < 520) {
        await result.evaluate((el) => (el.style.minWidth = '620px'))
        await expect
          .poll(async () => {
            const [button, pill] = await Promise.all([restart.boundingBox(), result.boundingBox()])
            return button!.y + button!.height <= pill!.y
          })
          .toBe(true)
        await result.evaluate((el) => (el.style.minWidth = ''))
      }
    }
  }
  expect(problems).toEqual([])
})
