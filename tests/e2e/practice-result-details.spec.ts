/**
 * The result's details open in place (DECISIONS U99): Details expands the pill into a larger card
 * over the score, never another screen. The URL and the strip's review frame stay as they were;
 * the chevron, Escape, and everything that ends the result fold it; a key press starts the next
 * pass as before, and the next pass's first correct note folds and dims it until the cursor leaves
 * that bar, when it slides away (U101). The card's excerpts show each wrong place on the music, ranked by severity: the
 * same wrong key three passes running first, then one twice running, then this pass's one-offs,
 * with ghost notes for the keys pressed. Fake Web MIDI; the seeded Two Hands piece looped.
 *
 * RESULT_DETAILS_SHOTS=<directory outside the repository> also saves screenshots collapsed and
 * expanded at iPad landscape / upright and phone upright / on its side, light and dark.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { installFakeMidi, loopWholePiece, openSeededPractice, play, playWhenDue, seedPiece } from './practice-helpers'

const SHOTS = process.env['RESULT_DETAILS_SHOTS']

/** The strip's content transform (zoom and translate). */
async function stripTransform(page: Page): Promise<string> {
  return page.locator('.pn-strip .pn-content').evaluate((el) => (el as HTMLElement).style.transform)
}

/** Waits until the score's view (strip transform or page scroll) has not changed for 200 ms (the review zoom has landed). */
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(800)
  let last = await viewSignature(page)
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200)
    const now = await viewSignature(page)
    if (now === last) return
    last = now
  }
}

/** One pass over bars 1–2 with wrong keys pressed before given groups (by index 0–5). */
async function pass(page: Page, wrong: Partial<Record<number, number[]>> = {}): Promise<void> {
  const groups = [[60, 48], [62], [64], [65], [67, 71, 74, 43], [48]]
  for (let i = 0; i < groups.length; i++) {
    const keys = wrong[i]
    if (keys) {
      await page.waitForTimeout(300)
      await play(page, ...keys)
    }
    await playWhenDue(page, ...groups[i]!)
  }
}

async function openLoop(page: Page, settings: Partial<AppSettings> = {}): Promise<void> {
  await installFakeMidi(page)
  await seedPiece(page, settings)
  await openSeededPractice(page)
  await loopWholePiece(page)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
}

async function nextPass(page: Page): Promise<void> {
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready', { timeout: 15_000 })
}

/**
 * Three passes: C♯ at the D three passes running, E♭ at the E in the last two, and in the last
 * one only two keys at the bar 2 chord (one far from everything, one a neighbor) and C4 for C3.
 */
async function rankedPasses(page: Page, settings: Partial<AppSettings> = {}): Promise<void> {
  await openLoop(page, settings)
  await pass(page, { 1: [61] })
  await nextPass(page)
  await pass(page, { 1: [61], 2: [63] })
  await nextPass(page)
  await pass(page, { 1: [61], 2: [63], 4: [30, 69], 5: [60] })
  await expect(page.getByTestId('attempt-result')).toContainText('three passes running')
}

const toggle = (page: Page) => page.getByTestId('result-details-toggle')
const details = (page: Page) => page.getByTestId('result-details')
const hide = (page: Page) => page.getByTestId('result-details-hide')

/** What the score underneath shows: the strip's transform, or the page's scroll offset. */
async function viewSignature(page: Page): Promise<string> {
  if ((await page.locator('.pn-strip .pn-content').count()) > 0) return stripTransform(page)
  return String(await page.getByTestId('page-scroll').evaluate((el) => el.scrollTop))
}

/** Folds the expanded result by its chevron: the panel's own on a phone, the pill's otherwise. */
async function fold(page: Page): Promise<void> {
  const phone = await page.evaluate(
    () => matchMedia('(max-width: 520px), (orientation: landscape) and (max-height: 520px)').matches,
  )
  if (phone) await hide(page).click()
  else await toggle(page).click()
}

const PHONE_SIZES = [
  { name: 'phone upright', width: 390, height: 844 },
  { name: 'phone on its side', width: 852, height: 360 },
] as const
const TABLET_SIZES = [
  { name: 'tablet on its side', width: 1194, height: 834 },
  { name: 'tablet upright', width: 834, height: 1194 },
] as const
/** The tablet panel's margin to the stage's top and sides and to the footer: at least this (px). */
const PANEL_MARGIN = 16
/** The tablet panel's height cap (`DETAILS_MAX_HEIGHT` in views/practice/Banners.tsx). */
const PANEL_MAX_HEIGHT = 880

test.describe('the result details open in place (U99)', () => {
  test('Details expands the pill over the score, the URL and the review stay, the chevron folds it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    await pass(page)
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('Clean pass')
    await settled(page)
    const url = page.url()
    const before = await stripTransform(page)
    const dock = (await page.getByTestId('result-dock').boundingBox())!

    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page)).toHaveAccessibleName('Show details of this pass')
    await toggle(page).click()
    await expect(details(page)).toBeVisible()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(details(page).getByTestId('result-clean')).toHaveText('No mistakes in this pass.')
    await expect(details(page).getByTestId('result-facts')).toContainText('No help used')
    // Still Practice, same URL, same review frame; the dock (and so the review inset) did not grow.
    expect(page.url()).toBe(url)
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    await page.waitForTimeout(500)
    expect(await stripTransform(page)).toBe(before)
    expect((await page.getByTestId('result-dock').boundingBox())!.height).toBeCloseTo(dock.height, 0)
    // The details sit above the pill, over the stage.
    const panel = (await details(page).boundingBox())!
    expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y + 2)

    await toggle(page).click()
    await expect(details(page)).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    expect(await stripTransform(page)).toBe(before)

    // Escape folds it too; nothing navigates.
    await toggle(page).click()
    await expect(details(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    expect(page.url()).toBe(url)
    await expect(card).toBeVisible()
  })

  test('the next pass: wrong keys keep the card; the first correct note folds and dims it; past that bar it slides away (U101)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    await pass(page, { 3: [66] })
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('1 wrong note')
    await toggle(page).click()
    await expect(details(page).getByTestId('result-excerpt')).toHaveCount(1)
    await nextPass(page)
    // Repeat waits at Ready (Pause shows), but nothing was played yet: no focus mode (U102).
    const practice = page.locator('[data-activity]')
    await page.waitForTimeout(1600)
    await expect(practice).not.toHaveAttribute('data-recede', 'true')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    // A wrong key starts the pass and changes nothing here: expanded, full strength, reviewing.
    await play(page, 30)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running', { timeout: 1000 })
    await page.waitForTimeout(1400)
    await expect(practice).not.toHaveAttribute('data-recede', 'true')
    await expect(details(page)).toBeVisible()
    await expect(card).not.toHaveAttribute('data-dimmed')
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    await expect(page.locator('.pn-corr')).not.toHaveCount(0)
    // The first correct note: folded, dimmed, the strip back at the playing frame, the marks gone.
    await play(page, 60, 48)
    await expect(details(page)).toHaveCount(0)
    await expect(card).toHaveAttribute('data-dimmed', 'true')
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-review/)
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    expect(Number(await card.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.5)
    // Focus mode follows the first correct note after its usual delay.
    await expect(practice).toHaveAttribute('data-recede', 'true', { timeout: 3000 })
    // A tap brings it back to full strength without acting on its controls.
    await card.click()
    await expect(card).not.toHaveAttribute('data-dimmed')
    await expect(card).toBeVisible()
    // The rest of bar 1: once the cursor leaves it, the card slides down out of the score.
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await expect(card).toBeVisible()
    await playWhenDue(page, 65)
    await expect(card).toHaveAttribute('data-exit', 'played')
    await expect(card).toHaveCount(0)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running')
  })

  test('a reload while expanded leaves the learner in Practice with the loop, folded', async ({ page }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    await pass(page)
    await toggle(page).click()
    await expect(details(page)).toBeVisible()
    await page.reload()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
    await expect(page.getByTestId('repeat-controls')).toBeVisible({ timeout: 60_000 })
    await expect(details(page)).toHaveCount(0)
  })

  test('mistakes are ranked: the same key three passes running first, with the bar and ghost notes', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await rankedPasses(page)
    await settled(page)
    const url = page.url()
    const before = await stripTransform(page)
    await toggle(page).click()
    const excerpts = details(page).getByTestId('result-excerpt')
    await expect(excerpts).toHaveCount(2)
    // Bar 1 leads under "Keeps happening": D♭ for D three passes running, E♭ for E twice now.
    const keeps = details(page).locator('[data-group="keeps"]')
    await expect(keeps.getByRole('heading', { name: 'Keeps happening' })).toBeVisible()
    const first = excerpts.first()
    await expect(first).toHaveAttribute('data-occ', '0')
    await expect(first).toHaveAttribute('data-level', 'repeated')
    await expect(first).toContainText('Same wrong key three passes running')
    await expect(first).toContainText('You pressed D♭ where D♮ is written (three passes running)')
    await expect(first).toContainText('You pressed E♭ where E♮ is written (twice now)')
    // Bar 2: this pass only, two keys at the chord and the wrong octave.
    const second = excerpts.nth(1)
    await expect(second).toHaveAttribute('data-occ', '1')
    await expect(second).toContainText('it is not in the score here')
    await expect(second).toContainText('You pressed C4; the note is C3')
    // The music: rings with their labels and crossed ghost heads, on the notation itself.
    for (const ex of [first, second]) {
      const music = ex.getByTestId('excerpt-music')
      await expect(music.locator('.pn-corr-ring').first()).toBeVisible()
      await expect(music.locator('.pn-ex-ghost').first()).toBeAttached()
      expect(await music.locator('[data-n]').count()).toBeGreaterThan(0)
    }
    await expect(first.getByTestId('excerpt-music').locator('.pn-ex-ghost')).toHaveCount(2)
    await expect(second.getByTestId('excerpt-music').locator('.pn-ex-ghost')).toHaveCount(3)
    // Safe markup only (as the strip's notation): no script, foreignObject, handlers or links.
    const unsafe = await details(page).evaluate((root) => {
      const bad: string[] = []
      for (const el of root.querySelectorAll('[data-testid="excerpt-music"] *')) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'script' || tag === 'foreignobject' || tag === 'image' || tag === 'use') bad.push(tag)
        for (const a of el.getAttributeNames()) if (/^on|href$/i.test(a)) bad.push(`${tag}@${a}`)
      }
      return bad
    })
    expect(unsafe).toEqual([])
    // Tapping an excerpt does nothing: same screen, same review.
    await first.getByTestId('excerpt-music').click()
    expect(page.url()).toBe(url)
    expect(await stripTransform(page)).toBe(before)
    await expect(details(page)).toBeVisible()
    // The earlier passes are in the card; a row shows that pass's numbers there.
    await details(page)
      .getByText(/Earlier passes of this loop/)
      .click()
    await details(page).locator('[data-panel="history"] button[data-attempt]:not([aria-current])').first().click()
    await expect(details(page).getByRole('button', { name: 'Back to this pass' })).toBeVisible()
    expect(page.url()).toBe(url)
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
  })
})

test.describe('mistake playback in the card (U100)', () => {
  /** Note-ons the app sent to the piano since `from`. */
  const sentOns = (page: Page, from: number) =>
    page.evaluate(
      (from) =>
        (window as unknown as { __midi: { sent: number[][] } }).__midi.sent
          .slice(from)
          .filter((m) => (m[0]! & 0xf0) === 0x90 && m[2]! > 0)
          .map((m) => m[1]!),
      from,
    )
  const sentCount = (page: Page) =>
    page.evaluate(() => (window as unknown as { __midi: { sent: number[][] } }).__midi.sent.length)

  test('As written sends the bar to the piano, What you played the keys pressed; a key stops it and starts the pass', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    await pass(page, { 4: [69] }) // A pressed at the bar 2 chord
    await expect(page.getByTestId('attempt-result')).toContainText('1 wrong note')
    await nextPass(page)
    const url = page.url()
    await toggle(page).click()
    const excerpt = details(page).getByTestId('result-excerpt').first()
    await expect(excerpt).toHaveAttribute('data-occ', '1')

    let from = await sentCount(page)
    await excerpt.getByRole('button', { name: 'As written' }).click()
    await expect(excerpt.getByRole('button', { name: 'As written' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => sentOns(page, from), { timeout: 8000 }).toEqual(expect.arrayContaining([67, 71, 74, 43]))
    await expect(excerpt.getByRole('button', { name: 'As written' })).toHaveAttribute('aria-pressed', 'false', {
      timeout: 10_000,
    })
    expect(page.url()).toBe(url)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready')

    from = await sentCount(page)
    await excerpt.getByRole('button', { name: 'What you played' }).click()
    await expect
      .poll(() => sentOns(page, from), { timeout: 8000 })
      .toEqual(expect.arrayContaining([69, 67, 71, 74, 43]))
    await expect(excerpt.getByRole('button', { name: 'What you played' })).toHaveAttribute('aria-pressed', 'false', {
      timeout: 10_000,
    })

    // Playing again, a key press stops it at once and starts the next pass as always (its first
    // correct notes fold and dim the card, U101).
    await excerpt.getByRole('button', { name: 'As written' }).click()
    await expect(excerpt.getByRole('button', { name: 'As written' })).toHaveAttribute('aria-pressed', 'true')
    await play(page, 60, 48)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running', { timeout: 1000 })
    await expect(page.getByTestId('attempt-result')).toHaveAttribute('data-dimmed', 'true')
    await expect(details(page)).toHaveCount(0)
    expect(page.url()).toBe(url)
  })
})

test.describe('the expanded result by screen size (U99, 17 November 2026)', () => {
  test('a phone shows it full screen, a tablet a roomy panel with an even margin', async ({ page }) => {
    test.setTimeout(400_000)
    // Played at the tablet size (`playWhenDue` reads the cursor geometry), then shown at each size.
    await page.setViewportSize({ width: 1194, height: 834 })
    await rankedPasses(page)
    const url = page.url()
    for (const size of [...TABLET_SIZES, ...PHONE_SIZES]) {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.waitForTimeout(2500)
      await expect(page.getByTestId('attempt-result')).toBeVisible()
      await settled(page)
      const before = await viewSignature(page)
      const phone = PHONE_SIZES.some((p) => p.name === size.name)
      await toggle(page).click()
      await expect(details(page).getByTestId('result-excerpt').first()).toBeVisible()
      await page.waitForTimeout(500)
      const box = (await details(page).boundingBox())!
      const vw = size.width
      const vh = size.height
      const label = size.name
      if (phone) {
        // Full screen: the whole viewport, over the top bar and the footer, edge to edge.
        expect(box, label).toMatchObject({ x: 0, y: 0, width: vw, height: vh })
        await expect(details(page)).toHaveAttribute('data-layout', 'screen')
        await expect(details(page)).toHaveAttribute('role', 'dialog')
        // The panel is what is on top at every corner and at the middle of the top bar.
        const covered = await page.evaluate(
          ([w, h]) =>
            [
              [2, 2],
              [w! - 2, 2],
              [2, h! - 2],
              [w! - 2, h! - 2],
              [w! / 2, 20],
            ].every(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-testid="result-details"]')),
          [vw, vh],
        )
        expect(covered, label).toBe(true)
        // The chevron down is in the header, in reach, and stays there while the content scrolls.
        const head = (await page.getByTestId('result-screen-header').boundingBox())!
        expect(head.y, label).toBe(0)
        expect(head.height, label).toBeLessThanOrEqual(size.height > 400 ? 72 : 52)
        await expect(hide(page)).toBeVisible()
        await expect(hide(page)).toBeFocused()
        await details(page).evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await page.waitForTimeout(150)
        const chev = (await hide(page).boundingBox())!
        expect(chev.y, label).toBeGreaterThanOrEqual(0)
        expect(chev.y + chev.height, label).toBeLessThanOrEqual(head.height + 2)
        // An excerpt uses the width there is (inside its padding), not a tiny picture.
        const music = (await details(page).getByTestId('excerpt-music').first().boundingBox())!
        expect(music.width, label).toBeGreaterThan(vw * 0.6)
        // What is underneath neither scrolls nor takes taps: a tap at the pill's old place lands on the panel.
        const hit = await page.evaluate(
          ([w, h]) => document.elementFromPoint(w! / 2, h! - 40)?.closest('[data-testid="result-details"]') !== null,
          [vw, vh],
        )
        expect(hit, label).toBe(true)
      } else {
        await expect(details(page)).toHaveAttribute('data-layout', 'panel')
        // Wider than before (760 at most), clearly not full screen, and as tall as the stage allows.
        // The review keeps the header and overview up (no focus mode, U102), so on its side the
        // room is the stage under them: about 550 px at 1194 × 834.
        expect(box.width, label).toBeGreaterThan(760)
        expect(box.width, label).toBeLessThan(vw - 2 * PANEL_MARGIN + 1)
        expect(box.height, label).toBeGreaterThan(size.height > size.width ? 560 : 500)
        expect(box.height, label).toBeLessThan(vh * 0.85)
        // The same margin on every side: the sides of the screen, the top of the stage (under the
        // header and the overview), and the footer under the pill.
        const stageTop = (await page.locator('[data-repeat-bounds]').boundingBox())!.y
        const footerTop = (await page.getByTestId('footer-tools-slot').locator('xpath=ancestor::footer').boundingBox())!
          .y
        const dock = (await page.getByTestId('result-dock').boundingBox())!
        const card = (await page.getByTestId('attempt-result').boundingBox())!
        expect(box.x, label).toBeGreaterThanOrEqual(PANEL_MARGIN)
        expect(vw - (box.x + box.width), label).toBeGreaterThanOrEqual(PANEL_MARGIN)
        expect(box.y - stageTop, label).toBeGreaterThanOrEqual(PANEL_MARGIN - 1)
        if (box.height < PANEL_MAX_HEIGHT - 1) expect(box.y - stageTop, label).toBeLessThanOrEqual(PANEL_MARGIN + 2)
        expect(footerTop - (card.y + card.height), label).toBeGreaterThanOrEqual(PANEL_MARGIN - 1)
        expect(dock.width, label).toBeGreaterThan(0)
      }
      // Never re-zoomed or moved by expanding; still Practice on the same URL.
      expect(await viewSignature(page), label).toBe(before)
      expect(page.url()).toBe(url)
      await fold(page)
      await expect(details(page)).toHaveCount(0)
      await expect(toggle(page)).toBeFocused()
      expect(await viewSignature(page), label).toBe(before)
    }
  })

  test('a phone on its side keeps the header compact; Escape folds it and a rotation keeps it open', async ({
    page,
  }) => {
    test.setTimeout(200_000)
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    await pass(page)
    await expect(page.getByTestId('attempt-result')).toContainText('Clean pass')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(2500)
    await toggle(page).click()
    await expect(details(page).getByTestId('result-clean')).toHaveText('No mistakes in this pass.')
    await expect(page.getByTestId('result-screen-header')).toContainText('Clean pass')
    // Rotated: still open, laid out again for the short screen.
    await page.setViewportSize({ width: 852, height: 360 })
    await page.waitForTimeout(800)
    await expect(details(page)).toBeVisible()
    expect(await details(page).boundingBox()).toMatchObject({ x: 0, y: 0, width: 852, height: 360 })
    const head = (await page.getByTestId('result-screen-header').boundingBox())!
    expect(head.height).toBeLessThanOrEqual(52)
    await expect(details(page).getByTestId('result-facts')).toBeAttached()
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    await expect(page.getByTestId('attempt-result')).toBeVisible()
    // Hide result in the panel's header ends the result and its panel together.
    await toggle(page).click()
    await details(page).getByRole('button', { name: 'Hide result' }).click()
    await expect(details(page)).toHaveCount(0)
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
  })
})

test.describe('result details screenshots (U99)', () => {
  test.skip(!SHOTS, 'set RESULT_DETAILS_SHOTS=<dir outside the repo> to save screenshots')
  const SIZES = [
    { name: '1194x834', width: 1194, height: 834 },
    { name: '834x1194', width: 834, height: 1194 },
    { name: '390x844', width: 390, height: 844 },
    { name: '852x360', width: 852, height: 360 },
  ] as const
  for (const theme of ['light', 'dark'] as const) {
    test(`ranked mistakes ${theme}`, async ({ page, browserName }) => {
      test.setTimeout(400_000)
      mkdirSync(SHOTS!, { recursive: true })
      // Played at the tablet size (`playWhenDue` reads the cursor geometry), then shown at each size.
      await page.setViewportSize({ width: 1194, height: 834 })
      await page.emulateMedia({ colorScheme: theme })
      await rankedPasses(page, { view: { ...DEFAULT_SETTINGS.view, theme } })
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height })
        const name = `${browserName}-${size.name}-${theme}`
        if ((await toggle(page).getAttribute('aria-expanded')) === 'true') await fold(page)
        await page.waitForTimeout(2500)
        await expect(page.getByTestId('attempt-result')).toBeVisible()
        await page.screenshot({ path: join(SHOTS!, `${name}-collapsed.png`) })
        await toggle(page).click()
        await expect(details(page).getByTestId('result-excerpt').first()).toBeVisible()
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(SHOTS!, `${name}-expanded.png`) })
        await details(page).evaluate((el) => el.scrollTo(0, el.scrollHeight))
        await page.waitForTimeout(200)
        await page.screenshot({ path: join(SHOTS!, `${name}-expanded-end.png`) })
      }
    })
  }
})
