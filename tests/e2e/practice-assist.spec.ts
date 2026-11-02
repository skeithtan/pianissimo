/**
 * Practice beyond the smoke workflow (spec "Mistake feedback and hints", "Persistent score
 * labels", "Keyboard guide", "Repeating passages", "Results and timing"): automatic hints and
 * temporary labels that fade, persistent labels, the keyboard guide, Repeat readiness after a
 * completed attempt, the Details link into the Results scorecard, and Listen.
 * Uses the injected fake Web MIDI of practice-helpers.ts and a piece seeded in IndexedDB.
 */
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { idbAll } from './app-helpers'
import {
  installFakeMidi,
  loopWholePiece,
  openSeededPractice,
  play,
  playWhenDue,
  seedPiece,
  waitForOnset,
} from './practice-helpers'

/** Two Hands: bar 1 = C4 D4 E4 F4 over C3; bar 2 = chord G4 B4 D5 over G2 then C3 (stays on C3). */
const FIRST = [60, 48]
const REST = [[62], [64], [65], [67, 71, 74, 43]]
const LAST = 48

const labels = (page: Page) => page.locator('.pn-label')

async function startWholePiece(page: Page): Promise<void> {
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByTestId('ready')).toBeVisible()
}

async function playThrough(page: Page): Promise<void> {
  await playWhenDue(page, ...FIRST)
  for (const group of REST) await playWhenDue(page, ...group)
  await playWhenDue(page, LAST)
}

test.describe('practice assistance and repeat', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
  })

  test('automatic hints show temporary note names that fade out on their own', async ({ page }) => {
    // A short hint lifetime and a visible fade keep the test quick without fixed sleeps.
    await seedPiece(page, { hints: { autoThreshold: 1, lifetime: 1, fadeMs: 600, damageFlash: true } })
    await openSeededPractice(page)
    await startWholePiece(page)
    await expect(labels(page)).toHaveCount(0)

    // Sample every label's opacity per frame from just before the wrong note, so the fade is observed.
    await page.evaluate(() => {
      const seen: number[] = []
      ;(window as unknown as { __opacities: number[] }).__opacities = seen
      const tick = () => {
        for (const el of document.querySelectorAll<SVGElement>('.pn-label')) {
          seen.push(Number(getComputedStyle(el).opacity))
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await play(page, 70)
    await expect(labels(page).first()).toBeVisible()
    await expect(labels(page).filter({ hasText: /^C4$/ })).toHaveCount(1)
    await expect(labels(page)).toHaveCount(0) // lifetime over, fade done, labels removed

    const seen = await page.evaluate(() => (window as unknown as { __opacities: number[] }).__opacities)
    expect(Math.max(...seen)).toBeGreaterThan(0.9)
    expect(seen.some((o) => o > 0.02 && o < 0.9)).toBe(true) // a fade, not a cut

    // The attempt is still on: the group was not answered by the hint.
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
  })

  test('two wrong attacks at a group reveal the names automatically, and a correct answer fades them', async ({
    page,
  }) => {
    await seedPiece(page, { hints: { autoThreshold: 2, lifetime: 'until-correct', fadeMs: 200, damageFlash: true } })
    await openSeededPractice(page)
    await startWholePiece(page)
    await play(page, 70)
    await expect(labels(page)).toHaveCount(0)
    await play(page, 71)
    await expect(labels(page).first()).toBeVisible()
    await expect(labels(page).filter({ hasText: /^C4$/ })).toHaveCount(1)
    await playWhenDue(page, ...FIRST)
    await expect(labels(page)).toHaveCount(0) // faded out once answered
  })

  test('Labels All keeps note names on the score, Off removes them', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    const group = page.getByRole('radiogroup', { name: 'Note names on the score' })
    await expect(group.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
    await expect(labels(page)).toHaveCount(0)

    await group.getByRole('radio', { name: 'All' }).click()
    await expect(group.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    await expect(labels(page).first()).toBeVisible()
    await expect(labels(page).filter({ hasText: /^C4$/ })).toHaveCount(1)
    await expect(labels(page).filter({ hasText: /^D5$/ })).toHaveCount(1)

    // They stay while practicing (persistent, not temporary).
    await loopWholePiece(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('ready')).toBeVisible()
    await playWhenDue(page, ...FIRST)
    await expect(labels(page).filter({ hasText: /^D4$/ })).toHaveCount(1)

    await group.getByRole('radio', { name: 'Off' }).click()
    await expect(labels(page)).toHaveCount(0)
  })

  test('Show keys opens the keyboard guide and Hide keys closes it', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    const guide = page.getByRole('region', { name: 'Keyboard guide' })
    await expect(guide).toHaveCount(0)
    const show = page.getByRole('button', { name: 'Show keys' })
    await expect(show).toHaveAttribute('aria-pressed', 'false')
    await show.click()
    await expect(guide).toBeVisible()
    // The whole 88-key piano, with the first group's keys named above them (U15).
    await expect(guide.locator('[data-part="white-keys"] rect')).toHaveCount(52)
    await expect(guide.locator('[data-part="black-keys"] rect')).toHaveCount(36)
    const labels = guide.locator('[data-part="label"]')
    await expect(labels).toHaveText(['C3', 'C4'])
    // Live, also before Start: a held key lights up with its name, and is checked against the
    // group at the cursor (U37): D4 is not wanted, C4 is.
    await page.evaluate(() => window.__midi.on(62))
    await expect(guide.locator('[data-part="label"][data-midi="62"]')).toHaveText('D4')
    await expect(guide.locator('[data-part="bar"][data-midi="62"]')).toHaveAttribute('data-state', 'wrong')
    await page.evaluate(() => window.__midi.off(62))
    await expect(labels).toHaveText(['C3', 'C4'])
    await page.evaluate(() => window.__midi.on(60))
    await expect(guide.locator('[data-part="bar"][data-midi="60"]')).toHaveAttribute('data-state', 'accepted')
    await page.evaluate(() => window.__midi.off(60))
    const hide = page.getByRole('button', { name: 'Hide keys' })
    await expect(hide).toHaveAttribute('aria-pressed', 'true')
    await hide.click()
    await expect(guide).toHaveCount(0) // unmounted once the fade has finished
    await expect(page.getByRole('button', { name: 'Show keys' })).toBeVisible()
  })

  test('Repeat waits for released keys after a completed attempt, then returns to Ready', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await loopWholePiece(page)
    await expect(page.getByTestId('repeat-controls')).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('ready')).toBeVisible()

    // Finish the piece but keep the last key down.
    await playWhenDue(page, ...FIRST)
    for (const group of REST) await playWhenDue(page, ...group)
    await waitForOnset(page, LAST)
    await page.evaluate((n) => window.__midi.on(n), LAST)

    const card = page.getByTestId('attempt-result')
    await expect(card).toBeVisible()
    await expect(card).toContainText('No wrong notes')
    await expect(page.getByText('Release the keys to begin.')).toBeVisible()
    await expect(page.getByTestId('ready')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Again' })).toHaveCount(0) // Repeat restarts by itself

    await page.evaluate((n) => window.__midi.off(n), LAST)
    await expect(page.getByText('Release the keys to begin.')).toHaveCount(0)

    // Ready again: the next first note starts attempt number two, which can pass as well.
    await playThrough(page)
    await expect(card).toContainText('2 clean in a row')
    // Both completed attempts are recorded as scored (history is written in the background).
    await expect
      .poll(async () => (await idbAll<{ kind: string }>(page, 'attempts')).map((a) => a.kind), { timeout: 15_000 })
      .toEqual(['scored', 'scored'])
  })

  test('Details opens the Results page with a scorecard of the attempt', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await page.getByRole('button', { name: 'Show keys' }).click()
    await startWholePiece(page)

    await play(page, 70) // wrong attack 1
    await play(page, 71) // wrong attack 2
    await playWhenDue(page, ...FIRST)
    for (const group of REST) await playWhenDue(page, ...group)
    await playWhenDue(page, LAST)

    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('2 wrong notes')
    await card.getByRole('button', { name: 'Details' }).click()

    await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
    await expect(page.getByRole('heading', { level: 1, name: 'Results' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Latest attempt' })).toBeVisible()
    await expect(page.locator('[data-row="wrong-attacks"]')).toContainText('2')
    await expect(page.getByText('Not a pass: wrong-note attacks')).toBeVisible()
    await expect(page.locator('[data-row="assist-keyboard"]')).toContainText('Shown during this attempt.')
    await expect(page.locator('[data-row="assist-hints"]')).toContainText('1 automatic hint. 1 group revealed')
    await expect(page.locator('[data-row="completion-time"]')).toBeVisible()

    // The stored record matches what the card says.
    const attempts = await idbAll<{ wrongAttacks: number; completion: string }>(page, 'attempts')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ wrongAttacks: 2, completion: 'completed' })
  })

  test('Listen (both hands off) plays the piece through the MIDI output without grading the keys you press', async ({
    page,
  }) => {
    const samples: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/samples/')) samples.push(r.url())
    })
    await seedPiece(page)
    await openSeededPractice(page)
    const sentBefore = await page.evaluate(() => window.__midi.sent.length)

    // Both hand toggles off is Listen mode (U9): the main button reads Listen; no part filter (U12).
    await page.getByRole('button', { name: 'Left hand' }).click()
    await page.getByRole('button', { name: 'Right hand' }).click()
    await expect(page.getByRole('radiogroup', { name: 'Hear' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Listen', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => window.__midi.sent.filter((m) => (m[0]! & 0xf0) === 0x90 && (m[2] ?? 0) > 0).length),
      )
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => window.__midi.sent.length)).toBeGreaterThan(sentBefore)

    // Keys pressed while listening are not graded: no error feedback, no attempt, no result.
    await play(page, 70)
    await play(page, 71)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hint', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
    expect(await idbAll(page, 'attempts')).toHaveLength(0)
    expect(samples).toEqual([]) // Auto with a piano connected never loads browser sound (S4)
  })
})

test.describe('practice without a piano', () => {
  // No fake Web MIDI here: headless browsers have none, like a device with no piano.
  test('Listen plays through this device (Auto, S4)', async ({ page }) => {
    const samples: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/samples/')) samples.push(r.url())
    })
    await seedPiece(page, { route: DEFAULT_SETTINGS.route })
    await openSeededPractice(page)
    // Without a piano both hands are off and unavailable (U27): Listen is the only choice, and a
    // tap on a hand explains why (`force`: Playwright treats aria-disabled as disabled).
    const left = page.getByRole('button', { name: 'Left hand' })
    await expect(left).toHaveAttribute('aria-pressed', 'false')
    await expect(left).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('button', { name: 'Right hand' })).toHaveAttribute('aria-disabled', 'true')
    await left.click({ force: true })
    await expect(page.getByText(/Connect a piano to play a hand yourself/)).toBeVisible()
    const listen = page.getByRole('button', { name: 'Listen', exact: true })
    await expect(listen).toBeEnabled()
    expect(samples).toEqual([]) // nothing is fetched before the gesture
    await listen.click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 20_000 })
    expect(samples.length).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  })
})

test.describe('browsing while playing (U41)', () => {
  test('scrolling the score during an attempt stops it and records nothing', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page)
    await openSeededPractice(page)
    await startWholePiece(page)
    await playWhenDue(page, ...FIRST)
    await playWhenDue(page, ...REST[0]!)
    const strip = page.locator('.pn-strip')
    await expect(strip).not.toHaveClass(/pn-browsing/)
    // Drag the music back while the attempt runs.
    const box = (await strip.boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * 0.5, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 })
    await page.mouse.up()
    await expect(strip).toHaveClass(/pn-browsing/)
    // The attempt stopped: Start is offered again, and nothing of it reaches storage.
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
    await page.waitForTimeout(1500)
    expect(await idbAll(page, 'attempts')).toHaveLength(0)
  })
})

test.describe('cursor repeat button and note names', () => {
  test('the repeat button sits in the gap between the staves ("Name every note")', async ({ page }) => {
    await installFakeMidi(page)
    await seedPiece(page, { labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    await openSeededPractice(page)
    const button = page.getByRole('button', { name: 'Repeat from here' })
    await expect(button).toBeVisible()
    await expect(labels(page).filter({ hasText: /^C4$/ })).toHaveCount(1)
    if (process.env['SHOT']) {
      await page.waitForTimeout(500)
      await page.screenshot({ path: process.env['SHOT'] })
    }
    // Staff lines under the button (VexFlow draws them as each measure's own paths): the button's
    // center lies between the treble staff's bottom line and the bass staff's top line.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const b = document.querySelector('.pn-cursor-action')!.getBoundingClientRect()
          const cx = (b.left + b.right) / 2
          const ys = [
            ...new Set(
              [...document.querySelectorAll('.pn-music .vf-measure > path')]
                .map((p) => p.getBoundingClientRect())
                .filter((r) => r.height < 3 && r.width > 20 && r.left <= cx && r.right >= cx)
                .map((r) => Math.round(r.top + r.height / 2)),
            ),
          ].sort((a, c) => a - c)
          const cy = (b.top + b.bottom) / 2
          return ys.length === 10 && cy > ys[4]! && cy < ys[5]!
        }),
      )
      .toBe(true)
    // The button still works there.
    await button.click()
    await expect(page.getByTestId('repeat-controls')).toBeVisible()
  })
})
