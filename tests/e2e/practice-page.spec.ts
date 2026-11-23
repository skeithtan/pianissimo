/**
 * Portrait page mode (DECISIONS "Portrait page mode"): at iPad portrait size Practice shows the
 * score as wrapped systems with a moving cursor. Playing the first notes moves the cursor along
 * the first system while the page stays still; a seek to a later bar scrolls the page.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '../browser-test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { newPieceRecord } from '../../src/core/storage/records'
import { generateLongScore } from '../fixtures/generate-long-score'
import { importBytes } from '../unit/import/fixtures'
import { storedSettings } from './app-helpers'
import { chooseMode, SHOT_DIR, installFakeMidi, play } from './practice-helpers'

const PIECE_ID = 'e2e-page'
const TITLE = 'Page Mode Etude'

async function seedLongPiece(page: Page, settingsPatch: Partial<AppSettings> = {}): Promise<number[]> {
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
    ...settingsPatch,
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
/** Where the page rests: its scroll offset, and the first system's top below the viewport's top (px). */
const restingPlace = (page: Page) =>
  page.getByTestId('page-scroll').evaluate((el) => {
    const tops = [...document.querySelectorAll('.pn-page .pn-seg')].map((seg) => seg.getBoundingClientRect().top)
    return { scrollTop: el.scrollTop, systemTop: Math.round(Math.min(...tops) - el.getBoundingClientRect().top) }
  })

test.describe('practice page mode (portrait)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    await installFakeMidi(page)
  })

  test('Listen plays on while the page is scrolled, and Return follows its moving cursor again (U95)', async ({
    page,
  }) => {
    await seedLongPiece(page)
    await page.getByRole('button', { name: `Practice ${TITLE}` }).click()
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    await chooseMode(page, 'Listen')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    const scroller = page.getByTestId('page-scroll')
    const stage = (await scroller.boundingBox())!
    await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height / 2)
    await page.mouse.wheel(0, 900)
    await expect(page.locator('.pn-page')).toHaveClass(/pn-browsing/)
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(200)
    // Scrolling the page moves no musical position (U52): playback goes on (U95).
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Return to current position' }).click()
    await expect(page.locator('.pn-page')).not.toHaveClass(/pn-browsing/)
    await expect.poll(() => scrollTop(page)).toBeLessThan(10)
    await expect
      .poll(async () => {
        const cursor = (await cursorBox(page))!
        const center = cursor.y + cursor.height / 2
        return center > stage.y && center < stage.y + stage.height
      })
      .toBe(true)
    const before = (await cursorBox(page))!
    await expect.poll(async () => (await cursorBox(page))!.x).toBeGreaterThan(before.x + 10)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
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

    const chromeHeights = () =>
      page.evaluate(() =>
        ['practice-header', 'footer-tools-slot'].map((id) =>
          Math.round(document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().height),
        ),
      )
    const expandedChrome = await chromeHeights()
    // The first system rests whole at the top of the page, right under the timing cue's reserved row.
    const rest = await restingPlace(page)
    expect(rest.systemTop).toBeGreaterThanOrEqual(0)
    expect(rest.systemTop).toBeLessThan((await page.getByTestId('page-scroll').boundingBox())!.height / 4)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    // Focus mode on a tablet keeps the header (U93 revised) and this footer's one row: the score's
    // viewport keeps its size. Measure stationary-system behavior once focus mode is on, so the
    // check still catches unwanted scrolling during the line.
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-recede', 'true')
    await page.waitForTimeout(400)
    expect(await chromeHeights()).toEqual(expandedChrome)
    const before = (await cursorBox(page))!
    // Starting moves nothing: the cue row is reserved in every phase.
    expect(await restingPlace(page)).toEqual(rest)
    await playDueTargets(page, pitches)
    await playDueTargets(page, pitches)
    await playDueTargets(page, pitches)
    await expect.poll(async () => (await cursorBox(page))!.x).toBeGreaterThan(before.x + 20)
    const after = (await cursorBox(page))!
    // Same system: the bar did not move vertically, and the page did not scroll.
    expect(Math.abs(after.y - before.y)).toBeLessThan(1)
    expect(await restingPlace(page)).toEqual(rest)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-page-playing.png`) })

    // Pause, then seek to a late bar from the overview: the page scrolls to its system, which
    // rests in the middle of the score, with the cursor on it.
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(chromeHeights).toEqual(expandedChrome)
    const overview = (await page.getByRole('slider', { name: 'Piece overview' }).boundingBox())!
    await page.mouse.click(overview.x + overview.width * 0.85, overview.y + overview.height / 2)
    await expect.poll(() => scrollTop(page), { timeout: 5_000 }).toBeGreaterThan(100)
    await page.waitForTimeout(500)
    const stage = (await page.getByTestId('page-scroll').boundingBox())!
    const bar = (await cursorBox(page))!
    expect(Math.abs(bar.y + bar.height / 2 - (stage.y + stage.height / 2))).toBeLessThan(12)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-page-seek.png`) })
  })
})

/**
 * How far the page scrolls sideways, and the current system's first and last noteheads against the
 * page's viewport (px inside its left and right edges): the system under the cursor bar.
 */
const systemInView = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.pn-page-scroll')!
    const box = scroller.getBoundingClientRect()
    const bar = document.querySelector('.pn-page .pn-cursor-bar')!.getBoundingClientRect()
    const heads = [...document.querySelectorAll('.pn-page .pn-music [data-n]')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.top + r.height / 2 >= bar.top && r.top + r.height / 2 <= bar.bottom)
    return {
      heads: heads.length,
      width: box.width,
      firstIn: Math.min(...heads.map((r) => r.left)) - box.left,
      lastIn: box.right - Math.max(...heads.map((r) => r.right)),
      sideways: scroller.scrollWidth - scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
    }
  })

/** Polls until the page has settled, then checks that nothing of the system is cut off sideways. */
async function expectWholeSystem(page: Page, viewportWidth: number): Promise<void> {
  await expect(page.getByTestId('score-skeleton')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('.pn-page-content')).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(async () => (await systemInView(page)).heads).toBeGreaterThan(1)
  const now = await systemInView(page)
  expect(now.width).toBe(viewportWidth)
  expect(now.sideways).toBeLessThanOrEqual(0)
  expect(now.scrollLeft).toBe(0)
  expect(now.firstIn).toBeGreaterThan(0)
  expect(now.lastIn).toBeGreaterThan(0)
}

test.describe('a tablet held upright always shows whole systems (R17)', () => {
  const UPRIGHT = { width: 834, height: 1194 }
  const ON_ITS_SIDE = { width: 1194, height: 834 }
  test.use({ viewport: UPRIGHT, hasTouch: true })

  test('the page never scrolls sideways, at the largest zoom and after turning the tablet and back', async ({
    page,
  }) => {
    await installFakeMidi(page)
    // Every note named: at the largest zoom a bar alone needs more than the page's width.
    await seedLongPiece(page, { labels: { ...DEFAULT_SETTINGS.labels, mode: 'all' } })
    await page.getByRole('button', { name: `Practice ${TITLE}` }).click()
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    await expectWholeSystem(page, UPRIGHT.width)

    // A pinch in (here its trackpad form, a ctrl-wheel) to the largest page zoom re-engraves the
    // page at the width that zoom means.
    await page.locator('.pn-page-content').evaluate((el) => el.setAttribute('data-probe', 'before'))
    const box = (await page.locator('.pn-page-scroll').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
    await page.keyboard.down('Control')
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
    await expect.poll(async () => (await storedSettings(page))?.['view']?.['pageZoom']).toBe(2.5)
    await expect(page.locator('.pn-page-content[data-probe="before"]')).toHaveCount(0, { timeout: 60_000 })
    await expectWholeSystem(page, UPRIGHT.width)

    // Turned on its side (the strip) and back: the zoom is kept and the system is still whole.
    await page.setViewportSize(ON_ITS_SIDE)
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'strip')
    await expect(page.getByTestId('score-skeleton')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator('.pn-strip:not(.pn-page)')).toBeVisible({ timeout: 60_000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)

    await page.setViewportSize(UPRIGHT)
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page')
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    await expectWholeSystem(page, UPRIGHT.width)
    expect((await storedSettings(page))?.['view']?.['pageZoom']).toBe(2.5)
  })
})

test.describe('page mode cursor button (portrait)', () => {
  test('the repeat button sits in the gap between the staves of the current system', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    await installFakeMidi(page)
    await seedLongPiece(page)
    await page.getByRole('button', { name: `Practice ${TITLE}` }).click()
    await expect(page.getByTestId('strip-host')).toHaveAttribute('data-mode', 'page', { timeout: 60_000 })
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    const button = page.getByRole('button', { name: 'Repeat from here' })
    await expect(button).toBeVisible()
    // Staff lines of the cursor's system under the button: its center lies between the upper
    // staff's bottom line and the lower staff's top line.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const b = document.querySelector('.pn-page .pn-cursor-action')!.getBoundingClientRect()
          const bar = document.querySelector('.pn-page .pn-cursor-bar')!.getBoundingClientRect()
          const cx = (b.left + b.right) / 2
          const ys = [
            ...new Set(
              [...document.querySelectorAll('.pn-music .vf-measure > path')]
                .map((p) => p.getBoundingClientRect())
                .filter(
                  (r) =>
                    r.height < 3 &&
                    r.width > 20 &&
                    r.left <= cx &&
                    r.right >= cx &&
                    r.top >= bar.top &&
                    r.bottom <= bar.bottom,
                )
                .map((r) => Math.round(r.top + r.height / 2)),
            ),
          ].sort((a, c) => a - c)
          const cy = (b.top + b.bottom) / 2
          return ys.length === 10 && cy > ys[4]! && cy < ys[5]!
        }),
      )
      .toBe(true)
  })
})
