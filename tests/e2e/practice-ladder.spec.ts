/**
 * The speed ladder (Repeat mode) in the real app: a one-bar loop at 50% with a ladder to 100%
 * and "Until 3 clean in a row"; the third clean pass climbs one 5% step, the card says so, and
 * the setting is still on after a reload.
 */
import { expect, test } from '@playwright/test'
import { installFakeMidi, openSeededPractice, playWhenDue, seedPiece } from './practice-helpers'

test('three clean passes climb the ladder one step, and the ladder survives a reload', async ({ page }) => {
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)

  await page.getByRole('button', { name: 'Repeat from here' }).click()
  const panel = page.getByTestId('repeat-controls')
  await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText('Bar 1')

  // 50% first: a ladder starts from the speed it is switched on at.
  await page.getByRole('button', { name: /Open speed options/ }).click()
  const speed = page.getByRole('dialog', { name: 'Playback speed' })
  await speed.getByRole('group', { name: 'Speed presets' }).getByRole('button', { name: '50%', exact: true }).click()
  const speedButton = page.getByRole('button', { name: /Open speed options/ })
  await speedButton.click()
  await expect(speed).toHaveCount(0)
  await expect(speedButton).toHaveAccessibleName(/Speed 50%/)

  await panel.getByRole('combobox', { name: 'Repeat until' }).selectOption({ label: 'Until 3 clean in a row' })
  const ladder = panel.getByTestId('ladder-select')
  await ladder.selectOption({ label: 'Ladder to 100%' })
  await expect(panel.getByTestId('ladder-line')).toContainText('50% → 100%')

  await page.getByRole('button', { name: 'Start', exact: true }).click()
  const card = page.getByTestId('attempt-result')
  const cleanPass = async () => {
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
  }
  await cleanPass()
  await expect(card).toContainText('Clean pass')
  await expect(speedButton).toHaveAccessibleName(/Speed 50%/)
  await cleanPass()
  await expect(card).toContainText('2 clean in a row')
  await expect(speedButton).toHaveAccessibleName(/Speed 50%/)
  await cleanPass()
  await expect(card).toContainText('Speed up')
  await expect(card).toContainText('next at 55%')
  // The new speed waits for the Repeat reset, then the Speed control shows it.
  await expect(speedButton).toHaveAccessibleName(/Speed 55%/, { timeout: 20_000 })
  await expect(panel.getByTestId('ladder-line')).toContainText('55% → 100%')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  // The ladder is saved on the piece: still on after a reload.
  await page.reload()
  const heading = page.locator('h1', { hasText: 'Two Hands' })
  const open = page.getByRole('button', { name: 'Practice Two Hands' })
  await expect(heading.or(open)).toBeVisible()
  if (!(await heading.isVisible())) await open.click()
  await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
  const restored = page.getByTestId('repeat-controls')
  const reopen = page.getByRole('button', { name: 'Repeat from here' })
  await expect(restored.or(reopen)).toBeVisible()
  if (!(await restored.isVisible())) await reopen.click()
  await expect(restored.getByTestId('ladder-select')).toHaveValue('100')
  await expect(restored.getByTestId('ladder-line')).toContainText('100%')
})
