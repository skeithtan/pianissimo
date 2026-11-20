/**
 * Keep time (rhythm mode, DECISIONS P13) in the real app: the footer menu's switch, the count-in
 * over the stage, then a strict transport that never waits. The fake Web MIDI presses each group
 * at its scheduled time (Two Hands is quarter = 60, so at 100% a beat is exactly one second and
 * bar 1 holds C4+C3, D4, E4, F4 on beats 1 to 4), measured from the moment the count-in goes.
 */
import { expect, test } from '../browser-test'
import { storedSettings } from './app-helpers'
import {
  installFakeMidi,
  loopWholePiece,
  openFooterMenu,
  openSeededPractice,
  play,
  playAfterCountIn,
  seedPiece,
  type TimedGroup,
} from './practice-helpers'

const BEAT_MS = 1000

/** Bar 1 played exactly on the beat; `lateBy` moves the second group (D4). */
const bar1 = (lateBy = 0): TimedGroup[] => [
  { notes: [60, 48], atMs: 0 },
  { notes: [62], atMs: BEAT_MS + lateBy },
  { notes: [64], atMs: 2 * BEAT_MS },
  { notes: [65], atMs: 3 * BEAT_MS },
]

test.describe('Keep time', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
  })

  test('Keep time stays in Practice and explains its count-in and tempo', async ({ page }) => {
    const menu = await openFooterMenu(page)
    const keep = menu.getByRole('switch', { name: 'Keep time', exact: true })
    await expect(keep).toHaveAccessibleDescription(/count-in.*set tempo/)
    await expect(menu.getByRole('switch', { name: 'Play through' })).toHaveCount(0)
    await expect(keep).not.toBeChecked()
    await keep.click()
    await expect(keep).toBeChecked()
  })

  test('plays the full score after the count-in when Score playback is enabled', async ({ page }) => {
    const menu = await openFooterMenu(page)
    const keepTimeSettings = menu.getByRole('group', { name: 'Keep time settings' })
    const score = keepTimeSettings.getByRole('switch', { name: 'Score playback' })
    const volume = keepTimeSettings.getByRole('slider', { name: 'Playback volume' })
    await expect(score).toHaveCount(0)
    await expect(volume).toHaveCount(0)
    await keepTimeSettings.getByRole('switch', { name: 'Keep time' }).click()
    await expect(keepTimeSettings.getByRole('switch', { name: 'Metronome' })).toHaveCount(0)
    await expect(score).not.toBeChecked()
    await expect(score).toHaveAccessibleDescription('Hear both hands while you play.')
    const keepTimeLabel = await keepTimeSettings.getByText('Keep time', { exact: true }).boundingBox()
    const scorePlaybackLabel = await keepTimeSettings.getByText('Score playback', { exact: true }).boundingBox()
    expect(scorePlaybackLabel!.x).toBeCloseTo(keepTimeLabel!.x)
    await expect(volume).toHaveCount(0)
    await score.click()
    await expect(volume).toHaveValue('100')
    await volume.fill('50')
    const metronome = menu.getByRole('switch', { name: 'Metronome' })
    await expect(metronome).toBeChecked()
    await metronome.click()
    await expect(score).toBeChecked()
    await expect
      .poll(async () => (await storedSettings(page))?.['rhythm'])
      .toMatchObject({ scorePlayback: true, scorePlaybackVolume: 0.5 })
    await page.keyboard.press('Escape')
    const attacks = () =>
      page.evaluate(() => window.__midi.sent.filter(([status, , velocity]) => (status! & 0xf0) === 0x90 && velocity))
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    expect(await attacks()).toEqual([])
    await expect(page.getByTestId('count-in')).toHaveCount(0)
    await expect
      .poll(async () =>
        (await attacks())
          .slice(0, 2)
          .map((message) => message[1])
          .sort(),
      )
      .toEqual([48, 60])
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
  })

  test('Pause during the count-in cancels it', async ({ page }) => {
    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('keep-time-badge')).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByTestId('count-in')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    // The count-in does not come back, and nothing was scored.
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('count-in')).toHaveCount(0)
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
  })

  for (const example of [
    { direction: 'rushing', label: 'Rushing', mode: 'strip', width: 1180, height: 820, sign: -1 },
    { direction: 'dragging', label: 'Dragging', mode: 'page', width: 820, height: 1180, sign: 1 },
    { direction: 'steady', label: 'On the beat', mode: 'strip', width: 1180, height: 820, sign: 0 },
  ]) {
    const title = example.sign
      ? `shows and clears ${example.direction} above the moving score in ${example.mode} mode`
      : 'a steady pass starts with the timing strip folded and can be expanded'
    test(title, async ({ page }) => {
      await page.setViewportSize({ width: example.width, height: example.height })
      const host = page.getByTestId('strip-host')
      await expect(host).toHaveAttribute('data-mode', example.mode)
      const menu = await openFooterMenu(page)
      await menu.getByRole('switch', { name: 'Keep time' }).click()
      await page.keyboard.press('Escape')
      // Advance the browser clock between presses so timer jitter cannot change a timing sample.
      await page.clock.install()
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      const cue = page.getByTestId('timing-cue')
      await expect(page.getByTestId('count-in')).toBeVisible()
      await expect(cue).toBeHidden()
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 150)))

      const pass = playAfterCountIn(page, [
        { notes: [60, 48], atMs: 0 },
        { notes: [62], atMs: BEAT_MS + example.sign * 67 },
        { notes: [64], atMs: 2 * BEAT_MS + example.sign * 119 },
        { notes: [65], atMs: 3 * BEAT_MS },
        { notes: [67, 71, 74, 43], atMs: 4 * BEAT_MS },
        { notes: [48], atMs: 6 * BEAT_MS },
      ])
      await page.clock.runFor(6100)
      if (example.sign) {
        await expect(cue).toHaveAttribute('data-direction', example.direction)
        await expect(cue).toContainText(example.label)
        // Chromium can round a fully visible cue's intersection ratio just below 1.
        await expect(cue).toBeInViewport({ ratio: 0.999 })
      } else {
        await expect(cue).toBeHidden()
      }
      await expect(page.getByTestId('attempt-result')).toHaveCount(0)
      await page.clock.runFor(2000)
      await expect(cue).toBeHidden()
      await expect(page.getByTestId('attempt-result')).toHaveCount(0)
      await page.clock.runFor(2400)
      await pass
      await page.clock.resume()
      const card = page.getByTestId('attempt-result')
      await expect(card).toContainText('On time 6 of 6')
      await card.getByRole('button', { name: 'Show details of this pass' }).click({ position: { x: 28, y: 37 } })
      const details = page.getByTestId('result-details')
      if (example.sign) {
        const correction = details.getByTestId('result-excerpt')
        await expect(correction).toHaveCount(1)
        await expect(correction).toHaveAttribute('aria-label', 'Bar 1')
        await expect(correction).toContainText(example.label)
        await expect(correction.getByTestId('excerpt-music')).toBeVisible()
        await expect(correction.getByTestId('timing-review').locator('span[data-offset-ms]')).toHaveCount(4)
        await expect(correction.getByRole('button', { name: 'What you played' })).toBeEnabled()
        await expect(correction.getByRole('button', { name: 'As written' })).toBeEnabled()
        await expect(details.getByTestId('timing-review-steady')).toHaveCount(0)
        await expect(details.getByRole('combobox')).toHaveCount(0)
      } else {
        const steady = details.getByTestId('timing-review-steady')
        await expect(steady).toHaveJSProperty('open', false)
        await expect(details.getByTestId('result-excerpt')).toHaveCount(0)
        await steady.locator('summary').click()
        await expect(steady.getByText('All measured attacks were within 30 ms of the beat.')).toBeVisible()
      }
    })
  }

  test('stops at the end of a silent bar after the player has started playing', async ({ page }) => {
    await loopWholePiece(page)
    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await page.keyboard.press('Escape')

    await page.clock.install()
    const start = page.getByRole('button', { name: 'Start', exact: true })
    await start.click()
    const countIn = page.getByTestId('count-in')
    await expect(countIn).toBeVisible()
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 150)))
    const pass = playAfterCountIn(page, bar1())
    await page.clock.runFor(7200)
    await pass
    await page.clock.runFor(4100)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)

    await page.clock.runFor(1200)
    await expect(start).toBeVisible()
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
    await page.clock.runFor(4500)
    await expect(countIn).toHaveCount(0)
  })

  test('shows timing feedback for attacks about a second ahead and behind the playhead', async ({ page }) => {
    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await page.keyboard.press('Escape')
    await page.clock.install()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 150)))
    const cue = page.getByTestId('timing-cue')
    const playhead = page.locator('.pn-cursor-bar')
    const defaultColor = await playhead.evaluate((bar) => getComputedStyle(bar).backgroundColor)
    const pass = playAfterCountIn(page, [
      { notes: [60, 48], atMs: 0 },
      { notes: [62], atMs: 10 },
      { notes: [64], atMs: 2990 },
    ])
    await page.clock.runFor(4200)
    await expect(cue).toHaveAttribute('data-direction', 'rushing')
    await expect(cue).toBeVisible()
    const rushingY = (await cue.boundingBox())!.y
    await page.clock.runFor(3000)
    await pass
    await expect(cue).toHaveAttribute('data-direction', 'dragging')
    await expect(cue).toBeVisible()
    expect((await cue.boundingBox())!.y).toBe(rushingY)
    const draggingColor = await playhead.evaluate((bar) => getComputedStyle(bar).backgroundColor)
    expect(draggingColor).not.toBe(defaultColor)
    await play(page, 85)
    await page.clock.runFor(50)
    await expect(cue).toBeVisible()
    await expect(playhead).toHaveCSS('background-color', draggingColor)
    await page.clock.runFor(1200)
    await expect(cue).toBeHidden()
    await expect(playhead).toHaveCSS('background-color', defaultColor)
    await page.clock.resume()
  })

  test('a count-in, then on-time and a late group are reported on the card and in Results', async ({ page }) => {
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    const panel = page.getByTestId('repeat-controls')
    await expect(panel.getByRole('group', { name: 'Loop start' })).toContainText('Bar 1')
    await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 1')

    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await expect(menu.getByRole('switch', { name: 'Keep time' })).toBeChecked()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // First pass: every group on its beat.
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('count-in')).toBeVisible()
    const beats = await playAfterCountIn(page, bar1())
    expect(beats).toEqual([4, 3, 2, 1])
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('On time 4 of 4')
    await expect(card).toContainText('Clean pass')

    // Repeat mode counts in again; this time D4 comes 400 ms late, outside the +/-150 ms window.
    const second = await playAfterCountIn(page, bar1(400))
    expect(second).toEqual([4, 3, 2, 1])
    await expect(card).toContainText('1 missed')
    await expect(card).toContainText('On time 3 of 4')
    await expect(card).not.toContainText('Clean pass')

    // Let the next count-in start its zoom back in before opening the previous pass's mistakes.
    const countIn = page.getByTestId('count-in')
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 2')
    await card.getByRole('button', { name: 'Show details of this pass' }).click()
    await expect(countIn).toHaveCount(0)
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    // The details open in place over Practice (U99), never another screen.
    const details = page.getByTestId('result-details')
    await expect(details).toBeVisible()
    const correction = details.getByTestId('result-excerpt')
    await expect(correction).toHaveCount(1)
    await expect(correction.getByTestId('timing-review-summary')).toContainText('1 missed')
    await expect(correction.getByTestId('timing-review').getByText('×', { exact: true })).toBeVisible()
    await expect(correction.getByTestId('excerpt-music').locator('.pn-corr-ring').first()).toBeVisible()
    await expect(correction.getByTestId('timing-review').locator('line[data-offset]')).toHaveCount(1)
    await correction.getByRole('button', { name: 'What you played' }).click()
    await expect(correction.getByRole('button', { name: 'What you played' })).toHaveAttribute('aria-pressed', 'true')
    await correction.getByRole('button', { name: 'As written' }).click()
    await expect(correction.getByRole('button', { name: 'As written' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
    await expect(details.getByTestId('result-facts')).toContainText('On time 3 of 4')
    await details.getByText('All the numbers for this pass').click()
    await expect(details.locator('[data-row="missed"]')).toContainText('Missed groups')
    await expect(details.locator('[data-row="missed"]')).toContainText('1')
    await expect(details.locator('[data-row="on-time"]')).toContainText('3')
    await expect(details.locator('[data-row="tolerance"]')).toContainText('150')
    // The late press of D4 came after its group was missed, so the attempt is not a pass.
    await expect(details.locator('[data-reason]')).not.toHaveAttribute('data-reason', 'passed')

    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(countIn).toHaveCount(0)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 4')
  })
})

test.describe('Keep time phone menu', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('nests Score playback under Keep time and hides it when Keep time is off', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    const menu = await openFooterMenu(page)
    const keepTimeSettings = menu.getByRole('group', { name: 'Keep time settings' })
    const score = keepTimeSettings.getByRole('switch', { name: 'Score playback' })
    const volume = keepTimeSettings.getByRole('slider', { name: 'Playback volume' })
    await expect(score).toHaveCount(0)
    await expect(volume).toHaveCount(0)
    const keepTime = keepTimeSettings.getByRole('switch', { name: 'Keep time' })
    await keepTime.click()
    await expect(score).toBeVisible()
    await expect(volume).toHaveCount(0)
    await score.click()
    await volume.fill('40')
    await score.click()
    await expect(volume).toHaveCount(0)
    await score.click()
    await expect(volume).toHaveValue('40')
    await keepTime.click()
    await expect(score).toHaveCount(0)
    await expect(volume).toHaveCount(0)
    await keepTime.click()
    await expect(score).toBeChecked()
    await expect(volume).toHaveValue('40')
  })
})
