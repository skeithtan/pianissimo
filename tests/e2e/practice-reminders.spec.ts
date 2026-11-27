/**
 * Quiet pencil reminders at past mistakes (U167): off by default, enabled from Settings →
 * Hints, hidden while the red-pen review shows, handed over on the next pass's first correct note
 * (U101), faint after one mistake and firm after two of the last three, cleared after a clean
 * visit. Fake Web MIDI; the seeded Two Hands piece looped.
 *
 * REMINDER_SHOTS=<directory outside the repository> also saves screenshots of strip (iPad
 * landscape) and page (iPad upright), light and dark, at the playing zoom, mid-pass with one
 * faint and one firm caret visible, on the seeded piece and on a dense passage.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '../browser-test'
import { buildTimeline } from '../../src/core/engine'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { newPieceRecord } from '../../src/core/storage/records'
import { importFixture } from '../unit/import/fixtures'
import { installFakeMidi, loopWholePiece, openSeededPractice, play, playWhenDue, seedPiece } from './practice-helpers'

const SHOTS = process.env['REMINDER_SHOTS']

const TWO_HANDS_GROUPS: readonly (readonly number[])[] = [[60, 48], [62], [64], [65], [67, 71, 74, 43], [48]]

async function nextPass(page: Page): Promise<void> {
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
}

async function waitForOnsetOf(page: Page, allPitches: readonly number[], notes: readonly number[]): Promise<void> {
  await page.evaluate(
    ({ notes, pitches }) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 15_000
        let stableSince = performance.now()
        let previous = ''
        const check = () => {
          const now = performance.now()
          const cursor = document.querySelector('.pn-cursor-bar')?.getBoundingClientRect()
          const targets = [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].map((el) => ({
            pitches: (el.getAttribute('data-n') ?? '').split(' ').map((n) => pitches[Number(n)]),
            box: el.getBoundingClientRect(),
          }))
          const wanted = notes.map((n) => targets.find((t) => t.pitches.includes(n)))
          const atCursor =
            cursor &&
            wanted.every(Boolean) &&
            wanted.some((t) => t && t.box.left <= cursor.right && t.box.right >= cursor.left)
          const position = atCursor ? wanted.map((t) => t!.box.x.toFixed(1)).join('|') : ''
          if (!position || position !== previous) stableSince = now
          previous = position
          if (position && now - stableSince >= 80) return resolve()
          if (now >= deadline) return reject(new Error(`Notes ${notes.join(', ')} did not reach the cursor`))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
    { notes, pitches: allPitches },
  )
}

async function playGroups(
  page: Page,
  groups: readonly (readonly number[])[],
  wrong: Partial<Record<number, number[]>> = {},
  onceMore: readonly number[] = [],
  allPitches?: readonly number[],
): Promise<void> {
  for (let i = 0; i < groups.length; i++) {
    const bad = wrong[i]
    if (bad) {
      await page.waitForTimeout(250)
      await play(page, ...bad)
    }
    if (allPitches) {
      await waitForOnsetOf(page, allPitches, groups[i]!)
      await play(page, ...groups[i]!)
    } else {
      await playWhenDue(page, ...groups[i]!)
    }
    if (onceMore.includes(i)) {
      await page.waitForTimeout(100)
      await play(page, ...groups[i]!)
    }
  }
}

async function openLoop(page: Page, settings: Partial<AppSettings> = {}): Promise<void> {
  await installFakeMidi(page)
  await seedPiece(page, settings)
  await openSeededPractice(page)
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
}

test.describe('pencil reminders at past mistakes', () => {
  test('off by default; enabling in Settings shows faint and firm carets after review hand-over and clears them on a clean pass', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)

    // Pass 1 with a wrong key at D4 (group 1): still off by default.
    await playGroups(page, TWO_HANDS_GROUPS, { 1: [61] })
    await expect(page.getByTestId('attempt-result')).toContainText('1 wrong note')
    await expect(page.locator('.pn-corr')).not.toHaveCount(0)
    await expect(page.locator('.pn-reminder')).toHaveCount(0)

    await nextPass(page)
    await playWhenDue(page, ...TWO_HANDS_GROUPS[0]!)
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    await expect(page.locator('.pn-reminder')).toHaveCount(0)

    // Turn on "Pencil marks at past mistakes" in Settings → Hints while paused.
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Reading help', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Pencil marks at past mistakes' })
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await page.keyboard.press('Escape')

    // Resume pass 2 from start: faint caret at D4 now shows (no review active).
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.pn-reminder')).toHaveCount(1)
    await expect(page.locator('.pn-reminder-firm')).toHaveCount(0)

    // Pass 2: wrong again at D4 (now firm) and wrong once at F4 (now faint).
    await playGroups(page, TWO_HANDS_GROUPS, { 1: [61], 3: [66] }, [1])
    await expect(page.getByTestId('attempt-result')).toContainText('2 wrong notes')
    // During the review: red marks show, carets are hidden.
    await expect(page.locator('.pn-corr')).not.toHaveCount(0)
    await expect(page.locator('.pn-reminder')).toHaveCount(0)

    // Next pass's first correct note ends the review: red marks go, 1 firm + 1 faint caret appear.
    await nextPass(page)
    await playWhenDue(page, ...TWO_HANDS_GROUPS[0]!)
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    await expect(page.locator('.pn-reminder')).toHaveCount(2)
    await expect(page.locator('.pn-reminder-firm')).toHaveCount(1)

    // Finish pass 3 cleanly: after the review ends, both carets are gone.
    for (let i = 1; i < TWO_HANDS_GROUPS.length; i++) {
      await playWhenDue(page, ...TWO_HANDS_GROUPS[i]!)
    }
    await expect(page.getByTestId('attempt-result')).toContainText('Clean pass')
    await expect(page.locator('.pn-reminder')).toHaveCount(0)
    await nextPass(page)
    await playWhenDue(page, ...TWO_HANDS_GROUPS[0]!)
    await expect(page.locator('.pn-reminder')).toHaveCount(0)
  })
})

test.describe('reminder screenshots', () => {
  test.skip(!SHOTS, 'set REMINDER_SHOTS=<dir outside the repo> to save owner review screenshots')

  const VIEWS = [
    { name: 'strip', width: 1194, height: 834, mode: 'strip' },
    { name: 'page', width: 834, height: 1194, mode: 'page' },
  ] as const

  async function seedDensePiece(
    page: Page,
    theme: 'light' | 'dark',
  ): Promise<{ readonly groups: readonly (readonly number[])[]; readonly allPitches: readonly number[] }> {
    const built = await importFixture('unequal-rhythms.musicxml')
    const id = 'e2e-dense-unequal'
    const piece = newPieceRecord(built.package, { id, now: Date.now() })
    await installFakeMidi(page)
    await seedPiece(page, {
      hints: { ...DEFAULT_SETTINGS.hints, reminders: true },
      view: { ...DEFAULT_SETTINGS.view, theme },
    })
    await page.evaluate(
      async ({ piece, pkg }) => {
        const db: IDBDatabase = await new Promise((resolve, reject) => {
          const req = indexedDB.open('pianissimo')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['pieces', 'packages'], 'readwrite')
          tx.objectStore('pieces').put(piece)
          tx.objectStore('packages').put(pkg, (pkg as { model: { scoreVersionId: string } }).model.scoreVersionId)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        db.close()
      },
      { piece, pkg: built.package },
    )
    await page.reload()
    await page.getByRole('button', { name: `Practice ${piece.title}` }).click()
    await expect(page.locator('h1', { hasText: piece.title })).toBeVisible()
    await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
    // Loop bars 1–2 (dense beamed eighths climbing onto high ledger lines, dotted-eighth/16th, two voices).
    await page.getByRole('button', { name: 'Repeat from here' }).click()
    await page.getByTestId('repeat-controls').getByRole('button', { name: 'Move loop end one bar later' }).click()
    await expect(page.getByTestId('repeat-controls').getByRole('group', { name: 'Loop end' })).toContainText('Bar 2')
    const tl = buildTimeline(built.package.model, { hands: 'both', range: { fromOcc: 0, toOcc: 1 }, multiplier: 1 })
    return {
      groups: tl.groups.map((g) => g.pitches),
      allPitches: built.package.model.notes.map((n) => n.midi),
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`seeded piece mid-pass ${theme}`, async ({ page, browserName }) => {
      test.setTimeout(180_000)
      mkdirSync(SHOTS!, { recursive: true })
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 1194, height: 834 })
      await openLoop(page, {
        hints: { ...DEFAULT_SETTINGS.hints, reminders: true },
        view: { ...DEFAULT_SETTINGS.view, theme },
      })
      await playGroups(page, TWO_HANDS_GROUPS, { 1: [61] })
      await nextPass(page)
      await playGroups(page, TWO_HANDS_GROUPS, { 1: [61], 3: [66] }, [1])
      await nextPass(page)
      // Mid-pass: first note ends review → 1 firm (D4) and 1 faint (F4) caret visible.
      await playWhenDue(page, ...TWO_HANDS_GROUPS[0]!)
      await expect(page.locator('.pn-corr')).toHaveCount(0)
      await expect(page.locator('.pn-reminder')).toHaveCount(2)
      await expect(page.locator('.pn-reminder-firm')).toHaveCount(1)

      for (const v of VIEWS) {
        if (v.mode === 'page') {
          await page.setViewportSize({ width: v.width, height: v.height })
          await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', v.mode, { timeout: 30_000 })
          // Layout change interrupts an active pass; restart and play the first note so the shot is cleanly mid-pass.
          await page.getByRole('button', { name: 'Restart passage' }).click()
          await play(page, ...TWO_HANDS_GROUPS[0]!)
        }
        await expect(page.locator('.pn-reminder')).toHaveCount(2)
        await expect(page.locator('.pn-reminder-firm')).toHaveCount(1)
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(SHOTS!, `${browserName}-seeded-${v.name}-${theme}.png`) })
      }
    })

    test(`dense passage mid-pass ${theme}`, async ({ page, browserName }) => {
      test.setTimeout(240_000)
      mkdirSync(SHOTS!, { recursive: true })
      await page.emulateMedia({ colorScheme: theme })
      await page.setViewportSize({ width: 1194, height: 834 })
      const { groups, allPitches } = await seedDensePiece(page, theme)
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      const firmIdx = 3
      const faintIdx = Math.min(groups.length - 2, 7)
      const wrongFor = (pitches: readonly number[]) => [pitches[0]! + 1]

      await playGroups(page, groups, { [firmIdx]: wrongFor(groups[firmIdx]!) }, [], allPitches)
      await nextPass(page)
      await playGroups(
        page,
        groups,
        { [firmIdx]: wrongFor(groups[firmIdx]!), [faintIdx]: wrongFor(groups[faintIdx]!) },
        [firmIdx],
        allPitches,
      )
      await nextPass(page)
      await waitForOnsetOf(page, allPitches, groups[0]!)
      await play(page, ...groups[0]!)
      await expect(page.locator('.pn-corr')).toHaveCount(0)
      await expect(page.locator('.pn-reminder')).toHaveCount(2)
      await expect(page.locator('.pn-reminder-firm')).toHaveCount(1)

      for (const v of VIEWS) {
        if (v.mode === 'page') {
          await page.setViewportSize({ width: v.width, height: v.height })
          await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', v.mode, { timeout: 30_000 })
          await page.getByRole('button', { name: 'Restart passage' }).click()
          await play(page, ...groups[0]!)
        }
        await expect(page.locator('.pn-reminder')).toHaveCount(2)
        await expect(page.locator('.pn-reminder-firm')).toHaveCount(1)
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(SHOTS!, `${browserName}-dense-${v.name}-${theme}.png`) })
      }
    })
  }
})
