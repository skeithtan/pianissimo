/**
 * The speed ladder (Repeat mode) in the real app: start the default climb at the written
 * tempo. Three clean passes at 75% climb to 80%. Failed passes hold 80%, even across reload.
 */
import { expect, test } from '../browser-test'
import { installFakeMidi, openSeededPractice, play, playWhenDue, seedPiece, waitForOnset } from './practice-helpers'

test('the default ladder climbs after three clean passes, holds after failures, and survives a reload', async ({
  page,
}) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)

  await page.getByRole('button', { name: 'Repeat from here' }).click()
  const panel = page.getByTestId('repeat-controls')
  await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 1')

  const speedButton = page.getByRole('button', { name: /Open speed options/ })
  await expect(speedButton).toHaveAccessibleName(/Speed 100%/)

  // The goal button opens the repeat options: Until 3 clean in a row, and a ladder to 100%.
  const goalButton = panel.getByRole('button', { name: /^Repeat goal: / })
  await goalButton.click()
  const options = panel.getByRole('dialog', { name: 'Repeat options' })
  await options.getByRole('radiogroup', { name: 'Repeat until' }).getByRole('radio', { name: '3' }).click()
  await options.getByRole('switch', { name: 'Speed ladder' }).check()
  await expect(
    options.getByRole('radiogroup', { name: 'Ladder goal' }).getByRole('radio', { name: '100%' }),
  ).toBeChecked()
  await expect(panel.getByTestId('target-line')).toHaveText('Until 3 clean')
  await expect(panel.getByTestId('ladder-line')).toHaveText('75% → 100%')
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await goalButton.click()
  await expect(options).toHaveCount(0)

  await page.getByRole('button', { name: 'Start', exact: true }).click()
  const card = page.getByTestId('attempt-result')
  const pass = async (wrong = false, onceMore = false) => {
    await waitForOnset(page, 60, 48)
    if (wrong) {
      await play(page, 61)
      await waitForOnset(page, 60, 48)
      // Past the strike of the wrong key (P33), so that it was pressed alone.
      if (onceMore) await page.waitForTimeout(200)
    }
    await play(page, 60, 48)
    if (onceMore) {
      // The same lone wrong key as the pass before: the first clean strike is taken back (P39).
      await expect(page.getByTestId('stage-cue')).toHaveAttribute('data-kind', 'once-more')
      await play(page, 60, 48)
    }
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
  }
  await pass()
  await expect(card).toContainText('Clean pass')
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await pass()
  await expect(card).toContainText('2 clean in a row')
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await pass()
  await expect(card).toContainText('Speed up')
  await expect(card).toContainText('next at 80%')
  // The new speed waits for the Repeat reset, then the Speed control shows it.
  await expect(speedButton).toHaveAccessibleName(/Speed 80%/, { timeout: 20_000 })
  await expect(panel.getByTestId('ladder-line')).toHaveText('80% → 100%')
  for (let failure = 0; failure < 2; failure++) {
    await pass(true, failure > 0)
    await expect(card).toContainText('1 wrong note')
  }
  await waitForOnset(page, 60, 48)
  await expect(speedButton).toHaveAccessibleName(/Speed 80%/)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  // The ladder is saved on the piece: still on after a reload.
  await page.reload()
  const heading = page.locator('h1', { hasText: 'Two Hands' })
  const open = page.getByRole('button', { name: /^(?:Practice|Continue practice) Two Hands$/ })
  await expect(heading.or(open)).toBeVisible()
  if (!(await heading.isVisible())) await open.click()
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  const restored = page.getByTestId('repeat-controls')
  // Repeat was on when the page went away: it comes back on its own (DECISIONS U98).
  await expect(restored).toBeVisible()
  await expect(restored.getByTestId('ladder-line')).toHaveText('80% → 100%')
  await restored.getByRole('button', { name: /^Repeat goal: / }).click()
  const reopened = restored.getByRole('dialog', { name: 'Repeat options' })
  await expect(reopened.getByRole('switch', { name: 'Speed ladder' })).toBeChecked()
  await expect(
    reopened.getByRole('radiogroup', { name: 'Ladder goal' }).getByRole('radio', { name: '100%' }),
  ).toBeChecked()
})

test('a hesitant clean pass holds the ladder speed instead of climbing', async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)

  await page.getByRole('button', { name: 'Repeat from here' }).click()
  const panel = page.getByTestId('repeat-controls')
  const goalButton = panel.getByRole('button', { name: /^Repeat goal: / })
  await goalButton.click()
  const options = panel.getByRole('dialog', { name: 'Repeat options' })
  await options.getByRole('radiogroup', { name: 'Repeat until' }).getByRole('radio', { name: '3' }).click()
  await options.getByRole('switch', { name: 'Speed ladder' }).check()
  await goalButton.click()

  const speedButton = page.getByRole('button', { name: /Open speed options/ })
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await page.getByRole('button', { name: 'Start', exact: true }).click()

  const card = page.getByTestId('attempt-result')
  const fluentPass = async () => {
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
  }

  // Two fluent clean passes, then a clean pass with a long pause (> 600 ms) at D4: holds at 75%.
  await fluentPass()
  await expect(card).toContainText('Clean pass')
  await fluentPass()
  await expect(card).toContainText('2 clean in a row')

  await playWhenDue(page, 60, 48)
  await waitForOnset(page, 62)
  await page.waitForTimeout(800)
  await play(page, 62)
  await playWhenDue(page, 64)
  await playWhenDue(page, 65)

  await expect(card).toContainText('Clean pass')
  await expect(card.getByTestId('ladder-result')).toHaveText('Clean, with pauses: staying at 75%')
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  // Still repeats at 75%; a fresh streak of 3 fluent clean passes climbs to 80%.
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
  await fluentPass()
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await fluentPass()
  await expect(speedButton).toHaveAccessibleName(/Speed 75%/)
  await fluentPass()
  await expect(card.getByTestId('ladder-result')).toHaveText('Speed up: next at 80%')
  await expect(speedButton).toHaveAccessibleName(/Speed 80%/, { timeout: 20_000 })
})
