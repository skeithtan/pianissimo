/**
 * Portrait page mode (DECISIONS "Portrait page mode"): at iPad portrait size Practice shows the
 * score as wrapped systems with a moving cursor. Playing the first notes moves the cursor along
 * the first system while the page stays still; a seek to a later bar scrolls the page.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { newPieceRecord } from '../../src/core/storage/records'
import { generateLongScore } from '../fixtures/generate-long-score'
import { importBytes } from '../unit/import/fixtures'
import { SHOT_DIR, installFakeMidi, play } from './practice-helpers'

const PIECE_ID = 'e2e-page'
const TITLE = 'Page Mode Etude'

async function seedLongPiece(page: Page): Promise<number[]> {
  const built = await importBytes('page.musicxml', new TextEncoder().encode(generateLongScore(24)))
  const piece = { ...newPieceRecord(built.package, { id: PIECE_ID, now: Date.now() }), title: TITLE }
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    route: {
      ...DEFAULT_SETTINGS.route,
      inputId: 'fake-in',
      inputName: 'Fake Piano',
      outputId: 'fake-out',
      outputName: 'Fake Piano',
      outputVerified: true,
      echo: 'none',
    },
  }
  await page.goto('./')
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'pianissimo')), {
      timeout: 15_000,
    })
    .toBe(true)
  await page.evaluate(
    async ({ piece, pkg, settings }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('pianissimo')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['pieces', 'packages', 'settings'], 'readwrite')
        tx.objectStore('pieces').put(piece)
        tx.objectStore('packages').put(pkg, (pkg as { model: { scoreVersionId: string } }).model.scoreVersionId)
        tx.objectStore('settings').put(settings, 'app')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    {
      piece: JSON.parse(JSON.stringify(piece)),
      pkg: JSON.parse(JSON.stringify(built.package)),
      settings: JSON.parse(JSON.stringify(settings)),
    },
  )
  await page.reload()
  return built.package.model.notes.map((n) => n.midi)
}

/** Waits until the current targets sit under the cursor and hold still, then plays them. */
async function playDueTargets(page: Page, pitches: readonly number[]): Promise<void> {
  const notes = await page.evaluate(
    (pitches) =>
      new Promise<number[]>((resolve, reject) => {
        const deadline = performance.now() + 15_000
        let since = performance.now()
        let previous = ''
        const check = () => {
          const now = performance.now()
          const bar = document.querySelector('.pn-cursor-bar')?.getBoundingClientRect()
          const heads = [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')]
          const under = heads.filter((el) => {
            const b = el.getBoundingClientRect()
            return bar && b.left <= bar.right && b.right >= bar.left && b.top >= bar.top && b.bottom <= bar.bottom
          })
          const key = under.map((el) => el.getBoundingClientRect().x.toFixed(1)).join('|')
          if (!key || key !== previous) since = now
          previous = key
          if (key && heads.length === under.length && now - since >= 80) {
            const ids = heads.flatMap((el) => (el.getAttribute('data-n') ?? '').split(' ').map(Number))
            return resolve([...new Set(ids.map((n) => pitches[n]!))])
          }
          if (now >= deadline) return reject(new Error('The targets did not reach the cursor'))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
    pitches,
  )
  await play(page, ...notes)
}

const cursorBox = (page: Page) => page.locator('.pn-page .pn-cursor-bar').boundingBox()
const scrollTop = (page: Page) => page.getByTestId('page-scroll').evaluate((el) => el.scrollTop)

test.describe('practice page mode (portrait)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    await installFakeMidi(page)
  })

  test('the cursor moves along a fixed page of systems; a later bar scrolls the page', async ({
    page,
    browserName,
  }) => {
    const pitches = await seedLongPiece(page)
    await page.getByRole('button', { name: `Practice ${TITLE}` }).click()
    await expect(page.locator('h1', { hasText: TITLE })).toBeVisible()
    await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 60_000 })
    // The page layout is prepared after the first paint; under a full parallel run it can take a while.
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page', { timeout: 60_000 })
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    // Several systems, stacked top to bottom.
    await expect.poll(() => page.locator('.pn-page .pn-seg').count()).toBeGreaterThanOrEqual(3)
    const tops = await page
      .locator('.pn-page .pn-seg')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top).sort((a, b) => a - b))
    expect(tops[1]! - tops[0]!).toBeGreaterThan(100)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-page-idle.png`) })

    await page.getByRole('button', { name: 'Start', exact: true }).click()
    const before = (await cursorBox(page))!
    expect(await scrollTop(page)).toBe(0)
    await playDueTargets(page, pitches)
    await playDueTargets(page, pitches)
    await playDueTargets(page, pitches)
    await expect.poll(async () => (await cursorBox(page))!.x).toBeGreaterThan(before.x + 20)
    const after = (await cursorBox(page))!
    // Same system: the bar did not move vertically, and the page did not scroll.
    expect(Math.abs(after.y - before.y)).toBeLessThan(1)
    expect(await scrollTop(page)).toBe(0)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-page-playing.png`) })

    // Pause, then seek to a late bar from the overview: the page scrolls to its system, which
    // rests about a quarter down the score, with the cursor on it.
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const overview = (await page.getByRole('slider', { name: 'Piece overview' }).boundingBox())!
    await page.mouse.click(overview.x + overview.width * 0.85, overview.y + overview.height / 2)
    await expect.poll(() => scrollTop(page), { timeout: 5_000 }).toBeGreaterThan(100)
    await page.waitForTimeout(500)
    const stage = (await page.getByTestId('page-scroll').boundingBox())!
    const bar = (await cursorBox(page))!
    expect(bar.y + bar.height / 2).toBeGreaterThan(stage.y)
    expect(bar.y + bar.height / 2).toBeLessThan(stage.y + stage.height)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-page-seek.png`) })
  })
})
