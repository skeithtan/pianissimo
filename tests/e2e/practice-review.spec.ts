/**
 * The review after a completed Repeat pass (DECISIONS U97) in the real app: the strip zooms out
 * to show the whole loop, the result docks at the bottom without covering the passage or the
 * teacher's marks, and the first notes of the next pass are matched at once while the strip zooms
 * back in to exactly the zoom it had, the marks and the card going as before. Fake Web MIDI; a
 * generated two-staff score (bars 1–5 looped, wider than the screen) and the seeded Two Hands
 * piece (practice-helpers.ts).
 *
 * The same wrong key three passes running puts its line on the result pill (P24).
 *
 * LOOP_REVIEW_SHOTS=<directory outside the repository> also saves screenshots of the review
 * (mid-zoom and settled) at iPad landscape / upright and phone upright / on its side, light and
 * dark: <dir>/<browser>-<state>-<size>-<theme>.png, and of the pill with a repeated mistake at
 * iPad landscape and phone upright: <dir>/<browser>-repeated-<size>-<theme>[-pill].png.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { generateLongScore } from '../fixtures/generate-long-score'
import { importBytes } from '../unit/import/fixtures'
import {
  installFakeMidi,
  loopWholePiece,
  openFooterMenu,
  openSeededPractice,
  play,
  playWhenDue,
  seedPiece,
} from './practice-helpers'

const SHOTS = process.env['LOOP_REVIEW_SHOTS']
const LONG = generateLongScore(12)
const LOOP_END = 5

/** The scale of the strip's content transform (1 when none is applied yet). */
async function stripScale(page: Page): Promise<number> {
  const t = await page.locator('.pn-strip .pn-content').evaluate((el) => (el as HTMLElement).style.transform)
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 1)
}

/**
 * Waits until a review zoom (650 ms out, 420 ms in) has had time to run and the score's transform
 * has then not changed for 150 ms.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const el = document.querySelector<HTMLElement>('.pn-strip .pn-content')
        if (!el) return resolve()
        let last = el.style.transform
        const start = performance.now()
        let since = start
        const deadline = since + 5000
        const check = () => {
          const now = performance.now()
          if (el.style.transform !== last) {
            last = el.style.transform
            since = now
          }
          if (now - start >= 700 && now - since >= 150) return resolve()
          if (now > deadline) return reject(new Error('the strip never settled'))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
  )
}

/** Imports the generated score (Practice opens and plays it), pauses, loops bars 1–LOOP_END. */
async function openLongLoop(page: Page, settings: Partial<AppSettings> = {}): Promise<number[]> {
  await installFakeMidi(page)
  await seedPiece(page, settings)
  await page
    .locator('label', { hasText: 'Add score' })
    .first()
    .locator('input[type="file"]')
    .setInputFiles({ name: 'review-loop.musicxml', mimeType: 'application/xml', buffer: Buffer.from(LONG) })
  await page.getByRole('button', { name: 'Add and open', exact: true }).click()
  await expect(page.locator('.pn-strip, .pn-page').first()).toBeVisible({ timeout: 60_000 })
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  if (await pause.isVisible()) await pause.click()
  await page.getByRole('button', { name: 'Repeat from here', exact: true }).click()
  const panel = page.getByTestId('repeat-controls')
  await expect(panel).toBeVisible()
  const start = panel.getByRole('group', { name: 'Loop start' })
  const end = panel.getByRole('group', { name: 'Loop end' })
  const bar = async (group: typeof start) => Number(/Bar (\d+)/.exec((await group.textContent()) ?? '')?.[1])
  for (let i = 0; i < 24; i++) {
    const was = await bar(start)
    if (was <= 1) break
    await start.getByRole('button', { name: 'Move loop start one bar earlier' }).click()
    await expect.poll(() => bar(start)).toBe(was - 1)
  }
  for (let i = 0; i < 24; i++) {
    const was = await bar(end)
    if (was === LOOP_END) break
    const later = was < LOOP_END
    await end.getByRole('button', { name: `Move loop end one bar ${later ? 'later' : 'earlier'}` }).click()
    await expect.poll(() => bar(end)).toBe(later ? was + 1 : was - 1)
  }
  await expect(start).toContainText(/Bar 1(?!\d)/)
  await expect(end).toContainText(new RegExp(`Bar ${LOOP_END}(?!\\d)`))
  const built = await importBytes('review-loop.musicxml', new TextEncoder().encode(LONG))
  return built.package.model.notes.map((n) => n.midi)
}

/** The unanswered target notes once they rest at the cursor (null once a result shows). */
async function nextTargets(page: Page): Promise<string[] | null> {
  return page.evaluate(
    () =>
      new Promise<string[] | null>((resolve, reject) => {
        const deadline = performance.now() + 20_000
        let previous = ''
        let since = performance.now()
        const check = () => {
          if (document.querySelector('[data-testid="attempt-result"]')) return resolve(null)
          const now = performance.now()
          const cursor = document.querySelector('.pn-cursor-bar')?.getBoundingClientRect()
          const near = [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].filter((el) => {
            const b = el.getBoundingClientRect()
            return !!cursor && b.left <= cursor.right + 4 && b.right >= cursor.left - 4
          })
          const ids = [...new Set(near.flatMap((el) => (el.getAttribute('data-n') ?? '').split(' ')))].filter(Boolean)
          // The page's cursor moves over still notes: it must have stopped at them too.
          const at = `${cursor?.x.toFixed(1)},${cursor?.y.toFixed(1)}`
          const key = `${ids.sort().join(',')}|${at}|${near.map((el) => el.getBoundingClientRect().x.toFixed(1)).join(',')}`
          if (!ids.length || key !== previous) since = now
          previous = key
          if (ids.length && now - since >= 80) return resolve(ids)
          if (now > deadline) return reject(new Error('no target came to the cursor'))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
  )
}

/** Plays the loop through from Start, every group when due, one far wrong key after the first. */
async function playLongPass(page: Page, midis: readonly number[]): Promise<void> {
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  let first = true
  for (let i = 0; i < 200; i++) {
    const ids = await nextTargets(page)
    if (!ids) return
    await play(page, ...new Set(ids.map((id) => midis[Number(id)]!)))
    await page
      .waitForFunction(
        (ids) => ids.every((id) => !document.querySelector(`.pn-music [data-n~="${id}"].pn-target:not(.pn-acc)`)),
        ids,
        { timeout: 5000 },
      )
      .catch(async (e) => {
        const state = await page.evaluate(
          (ids) =>
            ids.map((id) =>
              [...document.querySelectorAll(`[data-n~="${id}"]`)].map((el) => el.getAttribute('class')).join('/'),
            ),
          ids,
        )
        throw new Error(`notes ${ids.join(',')} (${midis[Number(ids[0])]}) not accepted: ${state.join(' | ')}; ${e}`)
      })
    if (first) await play(page, 30) // far from every note: "Wrong note"
    first = false
  }
  throw new Error('the pass never completed')
}

const REPEATED = 'D♭ instead of D♮ in bar 1, three passes running'

/**
 * The seeded Two Hands piece looped (bars 1–2) and played three times, a C♯ pressed 300 ms after
 * the first chord on every pass (counted at the D the cursor waits for next).
 */
async function threeWrongPasses(page: Page, settings: Partial<AppSettings> = {}): Promise<void> {
  await installFakeMidi(page)
  await seedPiece(page, settings)
  await openSeededPractice(page)
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  const card = page.getByTestId('attempt-result')
  for (let pass = 1; pass <= 3; pass++) {
    if (pass > 1)
      await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
    await playWhenDue(page, 60, 48)
    await page.waitForTimeout(300)
    await play(page, 61)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)
    await expect(card).toContainText('1 wrong note')
    if (pass < 3) await expect(page.getByTestId('result-note')).toHaveCount(0)
  }
}

type Box = { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Boxes of the loop's noteheads and the teacher's marks: in view and uncovered by the card. */
async function passageBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const band = document.querySelector('.pn-loop')!.getBoundingClientRect()
    return [...document.querySelectorAll('.pn-music [data-n], .pn-corr')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.right > band.left + 1 && r.left < band.right - 1)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
  })
}

test.describe('the review after a completed pass (U97)', () => {
  test('zooms out to the whole loop, docks the result clear of it, and zooms back in on the next pass', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    const midis = await openLongLoop(page)
    const before = await stripScale(page)

    await playLongPass(page, midis)
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('1 wrong note')
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    await expect(page.locator('.pn-corr')).not.toHaveCount(0)
    await settled(page)
    expect(await stripScale(page)).toBeLessThan(before)

    // The whole loop is on screen, and the card covers none of its notes or marks.
    const strip = (await page.locator('.pn-strip').boundingBox())!
    const band = (await page.locator('.pn-loop').boundingBox())!
    expect(band.x).toBeGreaterThanOrEqual(strip.x)
    expect(band.x + band.width).toBeLessThanOrEqual(strip.x + strip.width)
    const cardBox = (await card.boundingBox())!
    const boxes = await passageBoxes(page)
    expect(boxes.length).toBeGreaterThan(20)
    for (const b of boxes) expect(overlaps(b, cardBox)).toBe(false)

    // Repeat waits at Ready at the loop start (the music played on to the loop end, then
    // wrapped); the first notes of the next pass are matched at once.
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
    const first = await page.evaluate(() =>
      [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].flatMap((el) =>
        (el.getAttribute('data-n') ?? '').split(' ').filter(Boolean),
      ),
    )
    expect(first.length).toBeGreaterThan(0)
    await play(page, ...new Set(first.map((id) => midis[Number(id)]!)))
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running', { timeout: 1000 })
    // Accepted: those notes are no longer waiting at the cursor.
    await page.waitForFunction(
      (ids) => ids.every((id) => !document.querySelector(`.pn-music [data-n~="${id}"].pn-target:not(.pn-acc)`)),
      first,
      { timeout: 1000 },
    )
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-review/)
    // The card stays, dimmed, until the cursor leaves the bar (U101).
    await expect(card).toHaveAttribute('data-dimmed', 'true')
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    await settled(page)
    expect(await stripScale(page)).toBeCloseTo(before, 4)
  })

  test('Hide ends the review, and the saved zoom is never touched by it', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await installFakeMidi(page)
    await seedPiece(page, { view: { ...DEFAULT_SETTINGS.view, zoom: 2.2 } })
    await openSeededPractice(page)
    await loopWholePiece(page)
    const before = await stripScale(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await playWhenDue(page, 60, 48)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)
    await expect(page.getByTestId('attempt-result')).toContainText('Clean pass')
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    await settled(page)
    // Two bars at 2.2 are wider than this stage: the review zoomed out.
    expect(await stripScale(page)).toBeLessThan(before)
    await page.getByTestId('attempt-result').getByRole('button', { name: 'Hide result' }).click()
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-review/)
    await settled(page)
    expect(await stripScale(page)).toBeCloseTo(before, 4)
    const saved = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const req = indexedDB.open('pianissimo')
          req.onsuccess = () => {
            const get = req.result.transaction('settings').objectStore('settings').get('app')
            get.onsuccess = () => resolve((get.result as { view: { zoom: number } }).view.zoom)
          }
        }),
    )
    expect(saved).toBe(2.2)
  })

  test('Keep time returns to playing zoom during the next count-in without any key presses', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await installFakeMidi(page)
    await seedPiece(page, { view: { ...DEFAULT_SETTINGS.view, zoom: 2.2 } })
    await openSeededPractice(page)
    await loopWholePiece(page)
    const menu = await openFooterMenu(page)
    await menu.getByRole('switch', { name: 'Keep time' }).click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    const strip = page.locator('.pn-strip')
    const countIn = page.getByTestId('count-in')
    const before = await stripScale(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('attempt-result')).toContainText('6 missed', { timeout: 20_000 })
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 3')
    await expect(strip).toHaveClass(/pn-review/)
    expect(await stripScale(page)).toBeLessThan(before)

    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 2')
    await expect(strip).not.toHaveClass(/pn-review/)
    await expect(countIn).toHaveAttribute('aria-label', 'Count-in: 1')
    expect(await stripScale(page)).toBeCloseTo(before, 4)
    await expect(countIn).toHaveCount(0)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running')
    expect(await stripScale(page)).toBeCloseTo(before, 4)
  })

  test('the same wrong key three passes running is named on the pill (P24)', async ({ page }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await threeWrongPasses(page)
    const card = page.getByTestId('attempt-result')
    await expect(card.getByTestId('result-note')).toHaveText(REPEATED)
    // The line stays inside the pill and the pill clear of the reviewed passage.
    const note = (await card.getByTestId('result-note').boundingBox())!
    const cardBox = (await card.boundingBox())!
    expect(note.x).toBeGreaterThanOrEqual(cardBox.x)
    expect(note.x + note.width).toBeLessThanOrEqual(cardBox.x + cardBox.width)
    for (const b of await passageBoxes(page)) expect(overlaps(b, cardBox)).toBe(false)
  })
})

/**
 * REVIEW_PERF=1 (Chromium): frame intervals and long tasks during the zoom out and back in, under
 * 4× CPU throttling as a stand-in for the reference tablet (printed, not asserted).
 */
test('review zoom frame times (REVIEW_PERF)', async ({ page, browserName }) => {
  test.skip(!process.env['REVIEW_PERF'] || browserName !== 'chromium', 'set REVIEW_PERF=1 (Chromium)')
  await page.setViewportSize({ width: 1194, height: 834 })
  const midis = await openLongLoop(page)
  const cdp = await page.context().newCDPSession(page)
  const record = () =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[] }
      w.__frames = []
      w.__long = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push(Math.round(e.duration))
      }).observe({ type: 'longtask' })
      let last = performance.now()
      const tick = (t: number) => {
        w.__frames.push(t - last)
        last = t
        if (w.__frames.length < 90) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  const report = async (label: string) => {
    await page.waitForTimeout(1600)
    const { frames, long } = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __long: number[] }
      return { frames: w.__frames.slice(1), long: w.__long }
    })
    const sorted = [...frames].sort((a, b) => a - b)
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1)
    console.log(
      `${label}: ${frames.length} frames, median ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms, long tasks ${JSON.stringify(long)}`,
    )
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  // Out: from the last note of the pass (the result appears) through the landed review.
  const pass = playLongPass(page, midis)
  await page.getByTestId('attempt-result').waitFor({ timeout: 60_000 })
  await record()
  await pass
  await report('zoom out (4x CPU)')
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
  const first = await page.evaluate(() =>
    [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].flatMap((el) =>
      (el.getAttribute('data-n') ?? '').split(' ').filter(Boolean),
    ),
  )
  await record()
  await play(page, ...new Set(first.map((id) => midis[Number(id)]!)))
  await report('zoom back in while playing (4x CPU)')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
})

test.describe('review screenshots (U97)', () => {
  test.skip(!SHOTS, 'set LOOP_REVIEW_SHOTS=<dir outside the repo> to save screenshots')
  const SIZES = [
    { name: '1194x834', width: 1194, height: 834 },
    { name: '834x1194', width: 834, height: 1194 },
    { name: '390x844', width: 390, height: 844 },
    { name: '852x360', width: 852, height: 360 },
  ] as const
  for (const theme of ['light', 'dark'] as const) {
    for (const size of SIZES) {
      test(`${size.name} ${theme}`, async ({ page, browserName }) => {
        mkdirSync(SHOTS!, { recursive: true })
        const shot = (state: string) =>
          page.screenshot({ path: join(SHOTS!, `${browserName}-${state}-${size.name}-${theme}.png`) })
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.emulateMedia({ colorScheme: theme })
        const midis = await openLongLoop(page, { view: { ...DEFAULT_SETTINGS.view, theme } })
        await playLongPass(page, midis)
        await expect(page.getByTestId('attempt-result')).toBeVisible()
        await page.waitForTimeout(150)
        await shot('mid-review')
        await page.waitForTimeout(1200)
        await shot('completed')
      })
    }
    for (const size of SIZES.filter((s) => s.name === '1194x834' || s.name === '390x844')) {
      test(`repeated mistake ${size.name} ${theme}`, async ({ page, browserName }) => {
        mkdirSync(SHOTS!, { recursive: true })
        const name = `${browserName}-repeated-${size.name}-${theme}`
        // Played at the tablet size (`playWhenDue` reads the cursor geometry), then shown at the size.
        await page.setViewportSize({ width: 1194, height: 834 })
        await page.emulateMedia({ colorScheme: theme })
        await threeWrongPasses(page, { view: { ...DEFAULT_SETTINGS.view, theme } })
        await page.setViewportSize({ width: size.width, height: size.height })
        const card = page.getByTestId('attempt-result')
        await expect(card.getByTestId('result-note')).toHaveText(REPEATED)
        await page.waitForTimeout(1200)
        await page.screenshot({ path: join(SHOTS!, `${name}.png`) })
        await card.screenshot({ path: join(SHOTS!, `${name}-pill.png`) })
      })
    }
  }
})
