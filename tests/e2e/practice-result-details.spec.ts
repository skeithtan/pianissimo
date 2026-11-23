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
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '../browser-test'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/core/model/settings'
import { QUICK_FOLD_MS } from '../../src/views/practice/resultMotion'
import {
  installFakeMidi,
  loopWholePiece,
  openFooterMenu,
  openSeededPractice,
  play,
  playAfterCountIn,
  playWhenDue,
  seedPiece,
} from './practice-helpers'

/** The interface catalogs, by language (read as data: Playwright loads no JSON modules). */
const CATALOGS: Record<string, Record<string, string>> = Object.fromEntries(
  ['en-US', 'es-ES', 'fr-FR', 'fil-PH', 'ja-JP'].map((language) => [
    language,
    JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${language}.json`, import.meta.url), 'utf8')),
  ]),
)

const SHOTS = process.env['RESULT_DETAILS_SHOTS']

/** The strip's content transform (zoom and translate). */
async function stripTransform(page: Page): Promise<string> {
  return page.locator('.pn-strip .pn-content').evaluate((el) => (el as HTMLElement).style.transform)
}

/** The strip has not moved or zoomed since `before` (rounding may differ by a hundredth of a pixel). */
async function expectStripAt(page: Page, before: string): Promise<void> {
  const numbers = (transform: string) => (transform.match(/-?\d+(?:\.\d+)?(?=px|\))/g) ?? []).map(Number)
  const now = numbers(await stripTransform(page))
  const was = numbers(before)
  expect(now.length).toBe(was.length)
  now.forEach((n, i) => expect(Math.abs(n - was[i]!)).toBeLessThan(0.05))
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

/**
 * A Keep time pass over bars 1–2 that misses some groups: a result with a status line as long as
 * they get, and timing correction cards in its details.
 */
async function keepTimePass(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1194, height: 834 })
  await installFakeMidi(page)
  await seedPiece(page)
  await openSeededPractice(page)
  await loopWholePiece(page)
  const menu = await openFooterMenu(page)
  await menu.getByRole('switch', { name: 'Keep time' }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await playAfterCountIn(page, [
    { notes: [60, 48], atMs: 0 },
    { notes: [67, 71, 74, 43], atMs: 4000 },
  ])
  await expect(page.getByTestId('attempt-result')).toContainText('missed', { timeout: 20_000 })
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

/** What may animate on the result card while it opens or folds: nothing that lays anything out. */
const DRAWN_ONLY = new Set(['transform', 'clipPath', 'clip-path', 'opacity'])

/**
 * The properties animated on the result card and inside it, every frame for `ms` from now (CSS
 * animations and transitions and script animations alike, `document.getAnimations()`).
 */
function animatedProperties(page: Page, ms: number): Promise<string[]> {
  return page.getByTestId('result-dock').evaluate(
    (dock, ms) =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>()
        const end = performance.now() + ms
        const sample = () => {
          for (const animation of document.getAnimations()) {
            const effect = animation.effect as KeyframeEffect | null
            const target = effect?.target
            if (!target || !dock.contains(target)) continue
            if ('transitionProperty' in animation) seen.add(String(animation.transitionProperty))
            else
              for (const frame of effect.getKeyframes())
                for (const key of Object.keys(frame))
                  if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) seen.add(key)
          }
          if (performance.now() < end) requestAnimationFrame(sample)
          else resolve([...seen].sort())
        }
        requestAnimationFrame(sample)
      }),
    ms,
  )
}

/**
 * From the moment the result appears: every frame for `ms`, the time since then, the dock's height,
 * the score view's transform (or the stage's height upright) and where the pill's badge is drawn.
 */
function introFrames(page: Page, ms: number) {
  return page.evaluate(
    (ms) =>
      new Promise<{ t: number; dock: number; view: string; badge: number }[]>((resolve) => {
        const frames: { t: number; dock: number; view: string; badge: number }[] = []
        let start = 0
        const sample = (now: number) => {
          const card = document.querySelector('[data-testid="attempt-result"]')
          if (card) {
            start ||= now
            const content = document.querySelector<HTMLElement>('.pn-strip .pn-content')
            const stage = document.querySelector('[data-repeat-bounds]')!
            frames.push({
              t: now - start,
              dock: document.querySelector('[data-testid="result-dock"]')!.getBoundingClientRect().height,
              view: content ? content.style.transform : String(stage.getBoundingClientRect().height),
              badge: card.querySelector('[data-expandable] [aria-hidden="true"]')!.getBoundingClientRect().top,
            })
          }
          if (!start || now - start < ms) requestAnimationFrame(sample)
          else resolve(frames)
        }
        requestAnimationFrame(sample)
      }),
    ms,
  )
}

/**
 * Every frame for `ms`: the text, lists and excerpt cards in the details and the text of the summary
 * row that show (their opacity, with their ancestors', above 0.05) but reach past the animated side
 * clip of the element they are in. The clip is the element's computed `clip-path` (its running
 * animation); its box already carries its translate. The notation's own SVG text is covered by its
 * excerpt card. `fading` counts the frames in which the contents were partly transparent.
 */
function cutBySideClip(
  page: Page,
  ms: number,
): Promise<{ frames: number; shown: number; fading: number; cut: string[] }> {
  return page.evaluate(
    (ms) =>
      new Promise<{ frames: number; shown: number; fading: number; cut: string[] }>((resolve) => {
        const cut: string[] = []
        let frames = 0
        let shown = 0
        let fading = 0
        const end = performance.now() + ms
        const look = (clipped: HTMLElement, what: string) => {
          const box = clipped.getBoundingClientRect()
          const inset = /^inset\(([^)]*?)(?: round [^)]*)?\)$/.exec(getComputedStyle(clipped).clipPath)
          const [t = 0, r = t, , l = r] = inset ? inset[1]!.trim().split(/\s+/).map(parseFloat) : []
          const from = box.left + l
          const to = box.right - r
          const visible = (el: Element) => {
            let opacity = 1
            for (let node: Element | null = el; node && node !== clipped.parentElement; node = node.parentElement)
              opacity *= Number(getComputedStyle(node).opacity)
            return opacity > 0.05
          }
          const check = (rect: DOMRect, name: string) => {
            if (rect.width === 0 || rect.height === 0) return
            shown++
            if (rect.left < from - 0.5 || rect.right > to + 0.5)
              cut.push(
                `${what} ${name}: ${Math.round(rect.left)}–${Math.round(rect.right)} in ${Math.round(from)}–${Math.round(to)}`,
              )
          }
          const walker = document.createTreeWalker(clipped, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const el = node.parentElement
            if (!el || !node.textContent?.trim() || el.closest('svg') || !visible(el)) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            // What an ellipsis or a list's own edge hides is not shown: keep the part inside the
            // nearest ancestor that clips its overflow.
            let clip: Element | null = el
            while (clip && clip !== clipped && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement
            const bounds = clip && clip !== clipped ? clip.getBoundingClientRect() : null
            for (const rect of range.getClientRects()) {
              const left = bounds ? Math.max(rect.left, bounds.left) : rect.left
              const right = bounds ? Math.min(rect.right, bounds.right) : rect.right
              if (right > left)
                check(
                  new DOMRect(left, rect.top, right - left, rect.height),
                  JSON.stringify(node.textContent.trim().slice(0, 24)),
                )
            }
          }
          for (const el of clipped.querySelectorAll('ul, [data-testid="result-excerpt"]'))
            if (visible(el)) check(el.getBoundingClientRect(), el.tagName.toLowerCase())
        }
        const sample = () => {
          const panel = document.querySelector<HTMLElement>('[data-testid="result-details"]')
          if (panel) {
            frames++
            // The contents fade (they are neither absent nor there at once).
            const opacity = Number(getComputedStyle(panel.lastElementChild!).opacity)
            if (opacity > 0.05 && opacity < 0.95) fading++
            look(panel, 'panel')
            // On a phone the pill lies under the panel, whole; its own clip never moves.
            if (panel.dataset['layout'] === 'panel')
              look(document.querySelector<HTMLElement>('[data-testid="attempt-result"] [data-expandable]')!, 'row')
          }
          if (performance.now() < end) requestAnimationFrame(sample)
          else resolve({ frames, shown, fading, cut: [...new Set(cut)] })
        }
        requestAnimationFrame(sample)
      }),
    ms,
  )
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
  test('tapping the pill opens and folds its details without moving the score or changing the URL', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 })
    await openLoop(page)
    const intro = introFrames(page, 1100)
    await pass(page)
    const card = page.getByTestId('attempt-result')
    await expect(card).toContainText('Clean pass')
    const preview = card.getByTestId('result-details-preview')
    await expect(card).toHaveAttribute('data-intro', 'true')
    await expect(card).not.toHaveAttribute('data-intro', 'true')
    // The taller preview is drawn above the pill: the dock keeps one height from the first frame, so
    // the review frame never re-fits. Once the zoom out has landed (650 ms), the score holds still
    // through the end of the intro (960 ms).
    const frames = await intro
    const docks = frames.map((f) => f.dock)
    expect(Math.max(...docks) - Math.min(...docks)).toBeLessThan(0.5)
    const held = frames
      .filter((f) => f.t >= 760 && f.t <= 960)
      .map((f) => (f.view.match(/-?[\d.]+/g) ?? []).map(Number))
    expect(held.length).toBeGreaterThan(3)
    // (The strip's own sub-pixel rounding aside.)
    for (const numbers of held) numbers.forEach((n, i) => expect(Math.abs(n - held[0]![i]!)).toBeLessThan(0.05))
    const early = frames.find((f) => f.t > 50 && f.t < 400)!
    expect(frames.at(-1)!.badge - early.badge).toBeGreaterThan(20)
    await settled(page)
    const url = page.url()
    const before = await stripTransform(page)
    const dock = (await page.getByTestId('result-dock').boundingBox())!

    const peek = await preview.evaluate((el) => ({
      height: el.clientHeight,
      contentHeight: el.scrollHeight,
      mask: getComputedStyle(el).maskImage,
    }))
    expect(peek.contentHeight).toBeGreaterThan(peek.height)
    expect(peek.mask).toContain('linear-gradient')
    await expect(card.getByText('More below')).toHaveCount(0)
    const previewLines = await preview.locator('li').allTextContents()
    const collapsed = (await card.boundingBox())!
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle(page)).toHaveAccessibleName('Show details of this pass')
    // Sample the growing card before waiting for the lazy details: where its top edge and the
    // badge at its start edge are drawn.
    const motion = card.evaluate(
      (el) =>
        new Promise<{ badge: number; height: number }[]>((resolve) => {
          const trail: { badge: number; height: number }[] = []
          const sample = () => {
            const panel = el.querySelector('[data-testid="result-details"]')
            if (panel) {
              const top = panel.getBoundingClientRect().top
              const bottom = el.getBoundingClientRect().bottom
              const badge = el.querySelector('[data-expandable] [aria-hidden="true"]')!.getBoundingClientRect().left
              trail.push({ badge, height: bottom - top })
            }
            if (trail.length < 20) requestAnimationFrame(sample)
            else resolve(trail)
          }
          requestAnimationFrame(sample)
        }),
    )
    // By keyboard, the pointer away: a hovered control's own feedback is not part of the motion.
    await page.mouse.move(1, 1)
    await page.waitForTimeout(300)
    const opening = animatedProperties(page, 600)
    await toggle(page).press('Enter')
    await expect(details(page)).toBeVisible()
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle(page)).toHaveText('Details')
    await expect(preview).toHaveCount(0)
    await expect(details(page).getByTestId('result-verdict')).toHaveText('Clean pass: no wrong notes and no help.')
    const expandedFacts = details(page).getByTestId('result-facts')
    await expect(expandedFacts).toBeInViewport({ ratio: 0.9 })
    expect((await expandedFacts.locator('li').allTextContents()).slice(0, previewLines.length)).toEqual(previewLines)
    // Still Practice, same URL, same review frame; the dock (and so the review inset) did not grow.
    expect(page.url()).toBe(url)
    await expect(page.locator('main')).toHaveAttribute('data-view', 'practice')
    await expect(page.locator('.pn-strip')).toHaveClass(/pn-review/)
    await page.waitForTimeout(500)
    await expectStripAt(page, before)
    expect((await page.getByTestId('result-dock').boundingBox())!.height).toBeCloseTo(dock.height, 0)
    // The details sit above the pill, over the stage.
    const panel = (await details(page).boundingBox())!
    const pill = (await card.locator('[data-expandable]').boundingBox())!
    expect(panel.width).toBe(900)
    expect(panel.y + panel.height).toBeCloseTo(pill.y + 1, 0)
    const expandedHeight = pill.y + pill.height - panel.y
    const trail = await motion
    const badgeEnd = (await card.locator('[data-expandable] [aria-hidden="true"]').first().boundingBox())!.x
    expect(trail.some(({ badge }) => badge > badgeEnd + 10 && badge < collapsed.x + 20)).toBe(true)
    expect(trail.some(({ height }) => height > collapsed.height + 5 && height < expandedHeight - 5)).toBe(true)
    // Grown with transforms, clips and opacity only: nothing in the card is laid out per frame.
    const grown = await opening
    expect(grown.length).toBeGreaterThan(0)
    expect(grown.filter((p) => !DRAWN_ONLY.has(p))).toEqual([])

    const folding = animatedProperties(page, 600)
    await toggle(page).press('Enter')
    const folded = await folding
    expect(folded.length).toBeGreaterThan(0)
    expect(folded.filter((p) => !DRAWN_ONLY.has(p))).toEqual([])
    await expect(details(page)).toHaveCount(0)
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(preview).toBeVisible()
    await expect(card).not.toHaveAttribute('data-intro', 'true')
    await expectStripAt(page, before)

    // Escape folds it too; nothing navigates.
    await toggle(page).click()
    await expect(details(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(details(page)).toHaveCount(0)
    expect(page.url()).toBe(url)
    await expect(card).toBeVisible()
  })

  for (const size of [TABLET_SIZES[0], PHONE_SIZES[0]]) {
    test(`dismissing the expanded result on ${size.name} reverses its opening motion`, async ({ page }) => {
      await page.setViewportSize(TABLET_SIZES[0])
      await openLoop(page)
      await pass(page, { 1: [61] })
      const card = page.getByTestId('attempt-result')
      await expect(card).toContainText('1 wrong note')
      await expect(card).not.toHaveAttribute('data-intro', 'true')
      await page.setViewportSize(size)
      await settled(page)
      const pill = (await card.boundingBox())!
      // No frame of the opening or the fold shows a letter, a bullet or an excerpt cut by the side clip.
      const opening = cutBySideClip(page, 700)
      await toggle(page).click()
      const panel = details(page)
      await expect(panel.getByTestId('result-excerpt').first()).toBeVisible()
      const opened = await opening
      expect(opened.frames).toBeGreaterThan(10)
      expect(opened.shown).toBeGreaterThan(0)
      expect(opened.cut).toEqual([])
      const expanded = (await panel.boundingBox())!
      // The height drawn above the pill's bottom edge, down to the pill's own as it folds.
      const closing = panel.evaluate(
        (el, bottom) =>
          new Promise<number[]>((resolve) => {
            const heights: number[] = []
            const sample = () => {
              if (!el.isConnected) return resolve(heights)
              if (el.getAttribute('data-phase') === 'leaving') heights.push(bottom - el.getBoundingClientRect().top)
              requestAnimationFrame(sample)
            }
            sample()
          }),
        pill.y + pill.height,
      )
      await page.mouse.move(1, 1)
      await page.waitForTimeout(300)
      const folding = animatedProperties(page, 500)
      const unclipped = cutBySideClip(page, 500)
      const controls = size === PHONE_SIZES[0] ? page.getByTestId('result-screen-header') : card
      await controls.getByRole('button', { name: 'Hide result', exact: true }).press('Enter')
      const heights = await closing
      const folded = await unclipped
      expect(folded.frames).toBeGreaterThan(5)
      expect(folded.cut).toEqual([])
      expect(heights.some((h) => h < expanded.height - 10 && h > pill.height + 10)).toBe(true)
      expect(heights.at(-1)!).toBeLessThan(pill.height + 15)
      expect((await folding).filter((p) => !DRAWN_ONLY.has(p))).toEqual([])
      await expect(card).toHaveCount(0)
    })
  }

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
    // The first correct note: folded at once (a short fold that never holds up the playing), dimmed,
    // the strip back at the playing frame, the marks gone.
    const fold = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let dimmed = 0
          const check = (now: number) => {
            const card = document.querySelector('[data-testid="attempt-result"]')
            if (!dimmed && card?.hasAttribute('data-dimmed')) dimmed = now
            if (dimmed && !document.querySelector('[data-testid="result-details"]')) return resolve(now - dimmed)
            requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
    )
    const unclipped = cutBySideClip(page, 500)
    await play(page, 60, 48)
    expect(await fold).toBeLessThan(QUICK_FOLD_MS + 160)
    expect((await unclipped).cut).toEqual([])
    await expect(details(page)).toHaveCount(0)
    await expect(card).toHaveAttribute('data-dimmed', 'true')
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-review/)
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    await expect.poll(() => card.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5)
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
    const previewLines = await page.getByTestId('result-details-preview').locator('li').allTextContents()
    await toggle(page).click()
    const excerpts = details(page).getByTestId('result-excerpt')
    await expect(excerpts).toHaveCount(2)
    const expandedFacts = details(page).getByTestId('result-facts')
    await expect(expandedFacts).toBeInViewport({ ratio: 0.9 })
    expect((await expandedFacts.locator('li').allTextContents()).slice(0, previewLines.length)).toEqual(previewLines)
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
    await expectStripAt(page, before)
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
    await expect(details(page).getByTestId('result-verdict')).toHaveText('Clean pass: no wrong notes and no help.')
    await expect(page.getByTestId('result-screen-header')).toContainText('Clean pass')
    // Rotated: still open, laid out again for the short screen.
    await page.setViewportSize({ width: 852, height: 360 })
    await expect.poll(() => details(page).boundingBox()).toMatchObject({ x: 0, y: 0, width: 852, height: 360 })
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

/**
 * RESULT_OPEN_SHOTS=<dir outside the repo> saves the opening motion paused at its start, middle and
 * end at 1194×834 and 390×844: <dir>/<browser>-<size>-<label>-open-<start|middle|end>.png, where
 * RESULT_OPEN_LABEL (default "after") names the build being shown.
 */
test.describe('result opening screenshots', () => {
  const OPEN_SHOTS = process.env['RESULT_OPEN_SHOTS']
  const LABEL = process.env['RESULT_OPEN_LABEL'] ?? 'after'
  test.skip(!OPEN_SHOTS, 'set RESULT_OPEN_SHOTS=<dir outside the repo> to save screenshots')
  for (const size of [TABLET_SIZES[0], PHONE_SIZES[0]]) {
    test(`the pill growing into the card at ${size.width}x${size.height}`, async ({ page, browserName }) => {
      test.setTimeout(200_000)
      mkdirSync(OPEN_SHOTS!, { recursive: true })
      await page.setViewportSize(TABLET_SIZES[0])
      await openLoop(page)
      await pass(page, { 1: [61] })
      const card = page.getByTestId('attempt-result')
      await expect(card).toContainText('1 wrong note')
      if (size === TABLET_SIZES[0]) {
        // The intro: the taller preview, then settling (its own timer ends it at 960 ms).
        await expect(card).toHaveAttribute('data-intro', 'true')
        for (const [label, time] of [
          ['intro-tall', 300],
          ['intro-settling', 720],
        ] as const) {
          await card.evaluate((el, time) => {
            for (const a of el.getAnimations({ subtree: true })) {
              a.pause()
              a.currentTime = time
            }
          }, time)
          const box = (await card.boundingBox())!
          await page.screenshot({
            path: join(OPEN_SHOTS!, `${browserName}-${LABEL}-${label}.png`),
            clip: { x: box.x - 20, y: box.y - 80, width: box.width + 40, height: box.height + 100 },
          })
        }
      }
      await expect(card).not.toHaveAttribute('data-intro', 'true')
      await page.setViewportSize(size)
      await page.waitForTimeout(2500)
      await settled(page)
      // Once open and folded, so the lazy details are in place and the motion is the one seen later.
      await toggle(page).click()
      await expect(details(page).getByTestId('result-excerpt').first()).toBeVisible()
      await fold(page)
      await expect(details(page)).toHaveCount(0)
      await page.waitForTimeout(800)
      const count = await page.evaluate(async () => {
        document.querySelector<HTMLElement>('[data-testid="result-details-toggle"]')!.click()
        const root = document.querySelector('[data-testid="attempt-result"]')!
        const running = () =>
          document.getAnimations().filter((a) => {
            const target = (a.effect as KeyframeEffect | null)?.target
            return !!target && root.contains(target) && root.hasAttribute('data-opening')
          })
        let motion = running()
        for (let i = 0; i < 50 && motion.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          motion = running()
        }
        for (const a of motion) {
          a.pause()
          a.currentTime = 0
        }
        ;(window as unknown as { __open: Animation[] }).__open = motion
        return motion.length
      })
      expect(count).toBeGreaterThan(0)
      const at = async (label: string, time: number) => {
        await page.evaluate((time) => {
          for (const a of (window as unknown as { __open: Animation[] }).__open) a.currentTime = time
        }, time)
        await page.waitForTimeout(100)
        await page.screenshot({
          path: join(OPEN_SHOTS!, `${browserName}-${size.width}x${size.height}-${LABEL}-open-${label}.png`),
        })
      }
      await at('start', 0)
      await at('middle', 210)
      await at('end', 419)
      await page.evaluate(() => {
        for (const a of (window as unknown as { __open: Animation[] }).__open) a.finish()
      })
    })
  }
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

/**
 * The same on a result with the longest status line there is (Keep time's timing), opened and folded
 * with the toggle: no letter is cut by the side clips, in the details or in the summary row. The
 * first opening has the details replace their loading line in the middle of it (the request for
 * them is held back; the service worker would serve it around the route).
 */
test.describe('no letter is cut while a long result opens and folds', () => {
  test.use({ serviceWorkers: 'block' })
  for (const size of [TABLET_SIZES[0], PHONE_SIZES[0]]) {
    test(`at ${size.width}×${size.height}`, async ({ page }) => {
      test.setTimeout(200_000)
      let held = 0
      await page.route('**/assets/ResultDetails-*.js', async (route) => {
        held++
        await new Promise((resolve) => setTimeout(resolve, 150))
        await route.continue()
      })
      await keepTimePass(page)
      await expect(page.getByTestId('timing-result')).toBeVisible()
      await page.setViewportSize(size)
      await page.waitForTimeout(1500)
      expect(held).toBe(0) // fetched only on the first expansion
      for (let i = 0; i < 2; i++) {
        const opening = cutBySideClip(page, 900)
        await toggle(page).click()
        const opened = await opening
        expect(opened.frames).toBeGreaterThan(10)
        expect(opened.cut, `opening ${i + 1}`).toEqual([])
        expect(opened.fading, `opening ${i + 1} fades its contents in`).toBeGreaterThan(1)
        await expect(details(page).getByTestId('timing-review').first()).toBeVisible()
        const folding = cutBySideClip(page, 600)
        await fold(page)
        expect((await folding).cut, `folding ${i + 1}`).toEqual([])
        await expect(details(page)).toHaveCount(0)
      }
      expect(held).toBe(1)
    })
  }
})

/**
 * The Keep time correction cards' plot axis (Early, On beat, Late, Missed) in every interface
 * language: no label is cut off by the card at a phone's or a tablet's width (P9). The labels are
 * measured in place with each catalog's words.
 */
test('the timing plot labels fit in every language', async ({ page }) => {
  test.setTimeout(200_000)
  await keepTimePass(page)
  const words: Record<string, readonly string[]> = {}
  for (const [language, catalog] of Object.entries(CATALOGS)) {
    words[language] = ['265', '577', '415', '468'].map((id) => catalog[id]!)
  }
  for (const size of [PHONE_SIZES[0], TABLET_SIZES[0], TABLET_SIZES[1]]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(1500)
    if ((await toggle(page).getAttribute('aria-expanded')) !== 'true') await toggle(page).click()
    const axis = details(page).getByTestId('timing-review').first()
    await expect(axis).toBeVisible()
    const clipped = await details(page).evaluate((root, words) => {
      const out: string[] = []
      const plot = root.querySelector('[data-testid="timing-review"]')!
      const labels = [...plot.previousElementSibling!.querySelectorAll('span')]
      for (const [language, list] of Object.entries(words)) {
        labels.forEach((label, i) => {
          if (list[i]) label.textContent = list[i]!
        })
        // Laid out again with this language's words: the card's edge and the plot's start.
        const music = plot.closest('.pn-excerpt')!.getBoundingClientRect()
        const chart = plot.getBoundingClientRect()
        for (const label of labels) {
          const r = label.getBoundingClientRect()
          if (r.left < music.left - 0.5 || r.right > chart.left + 0.5)
            out.push(
              `${language} "${label.textContent}" ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(music.left)}–${Math.round(chart.left)}`,
            )
        }
      }
      return out
    }, words)
    expect(clipped, `${size.width}×${size.height}`).toEqual([])
    const shots = process.env['AXIS_SHOTS']
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await axis.evaluate((plot, list) => {
        plot.previousElementSibling!.querySelectorAll('span').forEach((label, i) => {
          if (list[i]) label.textContent = list[i]!
        })
      }, words['fr-FR']!)
      await details(page)
        .getByTestId('result-excerpt')
        .first()
        .screenshot({
          path: join(shots, `${test.info().project.name}-axis-${size.width}x${size.height}-fr.png`),
        })
    }
    await fold(page)
  }
})
