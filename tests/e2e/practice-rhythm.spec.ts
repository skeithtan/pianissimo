/**
 * Keep time (rhythm mode, DECISIONS P13) in the real app: the footer menu's switch, the count-in
 * over the stage, then a strict transport that never waits. The fake Web MIDI presses each group
 * at its scheduled time (Two Hands is quarter = 60, so at 100% a beat is exactly one second and
 * bar 1 holds C4+C3, D4, E4, F4 on beats 1 to 4), measured from the moment the count-in goes.
 */
import { expect, test } from '@playwright/test'
import {
  installFakeMidi,
  openFooterMenu,
  openSeededPractice,
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

  test('Keep time and Play through exclude each other', async ({ page }) => {
    const menu = await openFooterMenu(page)
    const keep = menu.getByRole('switch', { name: 'Keep time' })
    const through = menu.getByRole('switch', { name: 'Play through' })
    await expect(keep).not.toBeChecked()
    await keep.click()
    await expect(keep).toBeChecked()
    await expect(through).not.toBeChecked()
    await through.click()
    await expect(through).toBeChecked()
    await expect(keep).not.toBeChecked()
    await keep.click()
    await expect(keep).toBeChecked()
    await expect(through).not.toBeChecked()
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

    await card.getByRole('button', { name: 'Details' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
    await expect(page.locator('[data-row="missed"]')).toContainText('Missed groups')
    await expect(page.locator('[data-row="missed"]')).toContainText('1')
    await expect(page.locator('[data-row="on-time"]')).toContainText('3')
    await expect(page.locator('[data-row="tolerance"]')).toContainText('150')
    // The late press of D4 came after its group was missed, so the attempt is not a pass.
    await expect(page.locator('[data-reason]')).not.toHaveAttribute('data-reason', 'passed')
  })
})
