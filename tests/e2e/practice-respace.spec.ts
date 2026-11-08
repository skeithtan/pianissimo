/**
 * Respacing (DECISIONS R3 revised): Labels Off engraves the score tight (room for hints only);
 * All / Conditional engrave it with room for every name. Switching glides the notes to their new
 * places around the cursor: the cursor note stays put, the rest opens up or closes in.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { SHOT_DIR, installFakeMidi, openFooterMenu, openSeededPractice, seedPiece } from './practice-helpers'

/** Screen x of every notehead, left to right (first engraving of each note only). */
async function headXs(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const seen = new Set<string>()
    const xs: number[] = []
    for (const el of document.querySelectorAll('.pn-strip .pn-segs [data-n]')) {
      const n = el.getAttribute('data-n') ?? ''
      if (seen.has(n)) continue
      seen.add(n)
      const r = el.getBoundingClientRect()
      xs.push(r.left + r.width / 2)
    }
    return xs.sort((a, b) => a - b)
  })
}

const span = (xs: readonly number[]): number => xs.at(-1)! - xs[0]!

interface Glide {
  slices: number
  /** Note names riding along, and whether they fade in (names on) or out (off). */
  names: number
  fade: 'in' | 'out'
  /** ms from the click to the glide. */
  after: number
  /** Actual time the overlay remained visible, including during a rapid reversal. */
  duration?: number
}

declare global {
  interface Window {
    /** Glides seen so far (each overlay lives for less than half a second). */
    __glides: Glide[]
    __clicked: number
    /** Engravings started (OSMD's hidden container appearing). */
    __engravings: number
  }
}

/** Records every respacing overlay as it appears. */
async function watchGlides(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__glides = []
    window.__clicked = 0
    window.__engravings = 0
    document.addEventListener('pointerdown', () => (window.__clicked = performance.now()), true)
    const active = new Map<Node, { glide: Glide; started: number }>()
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.style.left === '-200000px') window.__engravings++
          else if (n instanceof HTMLElement && n.classList.contains('pn-respace')) {
            const glide: Glide = {
              slices: n.querySelectorAll('.pn-respace-slice').length,
              names: n.querySelectorAll('.pn-respace-label').length,
              fade: n.classList.contains('pn-respace-in') ? 'in' : 'out',
              after: performance.now() - window.__clicked,
            }
            window.__glides.push(glide)
            active.set(n, { glide, started: performance.now() })
          }
        for (const n of r.removedNodes) {
          const entry = active.get(n)
          if (entry) {
            entry.glide.duration = performance.now() - entry.started
            active.delete(n)
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

const glides = (page: Page): Promise<Glide[]> => page.evaluate(() => window.__glides)
const engravings = (page: Page): Promise<number> => page.evaluate(() => window.__engravings)

/**
 * Note names live in the footer menu (U76), which closes when the chrome recedes. During Listen
 * the receded tools are inert, so the menu is opened the way the labels are chosen here: a
 * programmatic click.
 */
/** The footer's Menu button, or the phone top bar's (U80), which opens the same rows in a sheet. */
const MENU_BUTTON = 'footer button[aria-label="Menu"], [data-testid="practice-bar"] button[aria-label="Menu"]'

async function openMenuDirectly(page: Page): Promise<void> {
  // Playback starting closes the menu (U76), and `ui.playing` can still settle right after
  // Listen: keep asking until the rows are there.
  await page.waitForFunction(
    (selector) => {
      if (document.querySelector('[role="radiogroup"][aria-label="Note names on the score"]')) return true
      const menu = document.querySelector<HTMLElement>(selector)!
      if (menu.getAttribute('aria-expanded') !== 'true') menu.click()
      return false
    },
    MENU_BUTTON,
    { polling: 100 },
  )
}

/** The last animated note and the real note on the first frame after the overlay disappears. */
async function playbackSeam(
  page: Page,
  label: string,
): Promise<{ distance: number; playbackDistance: number; elapsed: number; frames: number }> {
  await openMenuDirectly(page)
  return page.evaluate(async (name) => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Note names on the score"]')!
    const control = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (el) => el.textContent === name,
    )!
    type Point = { x: number; y: number }
    // Notes on screen, by note index. The portrait page scrolls during the run, so no fixed note
    // is guaranteed to stay visible: whichever notes both engravings show on a frame are compared.
    const points = (overlay: Element | null): Map<string, Point> => {
      const root = overlay ?? document.querySelector('.pn-segs')!
      const out = new Map<string, Point>()
      for (const el of root.querySelectorAll('[data-n]')) {
        const n = el.getAttribute('data-n') ?? ''
        if (out.has(n)) continue
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
        const clip = el.closest('.pn-respace-slice')?.getBoundingClientRect()
        if (!clip || (x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom)) out.set(n, { x, y })
        if (out.size >= 8) break
      }
      return out
    }
    control.click()
    return new Promise((resolve, reject) => {
      let last: { t: number; notes: Map<string, Point & { real: Point }> } | null = null
      let frames = 0
      const started = performance.now()
      const sample = (t: number) => {
        const overlay = document.querySelector('.pn-respace')
        const p = points(overlay)
        if (overlay) {
          const real = points(null)
          const shared = [...p.keys()].filter((n) => real.has(n))
          if (shared.length > 0) {
            last = { t, notes: new Map(shared.map((n) => [n, { ...p.get(n)!, real: real.get(n)! }])) }
            frames++
          }
        } else if (last) {
          const n = [...last.notes.keys()].find((k) => p.has(k))
          if (n) {
            const was = last.notes.get(n)!
            const now = p.get(n)!
            resolve({
              distance: Math.hypot(now.x - was.x, now.y - was.y),
              playbackDistance: Math.hypot(now.x - was.real.x, now.y - was.real.y),
              elapsed: t - last.t,
              frames,
            })
            return
          }
        }
        if (t - started > 4000) {
          reject(new Error(`No complete ${name} glide observed`))
          return
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  }, label)
}

test.describe('respacing between Labels Off and All', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
  })

  test('the notes glide apart around the cursor note for All, and back for Off', async ({ page }, info) => {
    await page.setViewportSize({ width: 1180, height: 820 })
    await seedPiece(page)
    await openSeededPractice(page)
    await openFooterMenu(page)
    const group = page.getByRole('radiogroup', { name: 'Note names on the score' })
    const tight = await headXs(page)
    expect(tight.length).toBeGreaterThan(4)
    await watchGlides(page)

    await group.getByRole('radio', { name: 'All' }).click()
    // The glide: slices of the roomy engraving over the hidden notation, then gone.
    await expect.poll(() => glides(page)).toHaveLength(1)
    const open = (await glides(page))[0]!
    expect(open.slices).toBeGreaterThan(4)
    // The names fade in on the way, riding with their notes; the glide starts without delay.
    expect(open).toMatchObject({ fade: 'in' })
    expect(open.names).toBeGreaterThan(4)
    expect(open.after).toBeLessThan(250)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    await expect(page.locator('.pn-strip.pn-respacing')).toHaveCount(0)
    await expect(page.locator('.pn-label').first()).toBeVisible()
    const roomy = await headXs(page)
    expect(roomy).toHaveLength(tight.length)
    // The cursor note (the first one, under the cursor line) stays; the music opens up from it.
    expect(Math.abs(roomy[0]! - tight[0]!)).toBeLessThan(2)
    expect(span(roomy) / span(tight)).toBeGreaterThan(1.15)
    await page.screenshot({ path: join(SHOT_DIR, `respace-open-end-${info.project.name}.png`) })

    await group.getByRole('radio', { name: 'Off' }).click()
    // The notes close in at once (the layout is in memory); the names fade out on the way.
    await expect.poll(() => glides(page)).toHaveLength(2)
    const close = (await glides(page))[1]!
    expect(close.slices).toBeGreaterThan(4)
    expect(close).toMatchObject({ fade: 'out' })
    expect(close.names).toBeGreaterThan(4)
    expect(close.after).toBeLessThan(250)
    await expect(page.locator('.pn-label')).toHaveCount(0)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    test.info().annotations.push({ type: 'glides', description: JSON.stringify(await glides(page)) })
    const back = await headXs(page)
    expect(Math.abs(back[0]! - tight[0]!)).toBeLessThan(2)
    expect(Math.abs(span(back) - span(tight))).toBeLessThan(2)
  })

  test('the other spacing is prepared ahead while idle: the first switch engraves nothing', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await watchGlides(page)
    // A moment of idle: the roomy engraving is prepared in the background (or read from storage).
    await page.waitForTimeout(2500)
    const before = await engravings(page)
    // Seen being engraved in the background (a fresh browser context has nothing stored).
    expect(before).toBe(1)
    await openFooterMenu(page)
    await page.getByRole('radiogroup', { name: 'Note names on the score' }).getByRole('radio', { name: 'All' }).click()
    await expect.poll(() => glides(page)).toHaveLength(1)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    expect(await engravings(page)).toBe(before)
    expect((await glides(page))[0]!.after).toBeLessThan(250)
  })

  for (const mode of ['landscape', 'portrait'] as const) {
    test(`label spacing follows Listen through the final animation frame (${mode})`, async ({ page }, info) => {
      await page.setViewportSize(mode === 'landscape' ? { width: 1180, height: 820 } : { width: 360, height: 780 })
      await seedPiece(page)
      await openSeededPractice(page)
      await page.waitForTimeout(2500)
      await page.getByRole('button', { name: 'Left hand', exact: true }).click()
      await page.getByRole('button', { name: 'Right hand', exact: true }).click()
      await page.getByRole('button', { name: 'Listen', exact: true }).click()
      // Cross the first system boundary during the portrait glide.
      if (mode === 'portrait') await page.waitForTimeout(3650)
      const labels = mode === 'landscape' ? ['All', 'Off', 'Conditional', 'Off'] : ['All', 'Off']
      for (const label of labels) {
        const seam = await playbackSeam(page, label)
        expect(seam.frames).toBeGreaterThan(3)
        // Allow the actual playback/scroll motion of this frame, never a whole glide's catch-up.
        expect(seam.distance).toBeLessThan(2 + seam.playbackDistance)
        info.annotations.push({ type: `${mode}-${label}-seam`, description: JSON.stringify(seam) })
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
        if (label === 'Conditional') {
          const view = await page.locator('.pn-strip').elementHandle()
          // The two visible-name modes share spacing, so neither switch replaces the score.
          // Address the controls directly while focus mode makes their row inert.
          for (const sameRoom of ['All', 'Conditional']) {
            await openMenuDirectly(page)
            await page
              .locator('[role="radio"]')
              .filter({ hasText: new RegExp(`^${sameRoom}$`) })
              .evaluate((el: HTMLElement) => el.click())
            expect(await view!.evaluate((el) => el.isConnected)).toBe(true)
            await expect(page.locator('.pn-respace')).toHaveCount(0)
          }
        }
      }
    })
  }

  test('a rapid reversal finishes the visible glide before returning to Off', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 })
    await seedPiece(page)
    await openSeededPractice(page)
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: 'Left hand', exact: true }).click()
    await page.getByRole('button', { name: 'Right hand', exact: true }).click()
    await page.getByRole('button', { name: 'Listen', exact: true }).click()
    await watchGlides(page)
    await openFooterMenu(page)
    const group = page.getByRole('radiogroup', { name: 'Note names on the score' })
    await group.getByRole('radio', { name: 'All' }).click()
    await expect(page.locator('.pn-respace')).toHaveCount(1)
    await page.waitForTimeout(60)
    await group.getByRole('radio', { name: 'Off', exact: true }).evaluate((el: HTMLElement) => el.click())
    await expect.poll(() => glides(page)).toHaveLength(2)
    await expect(page.locator('.pn-respace')).toHaveCount(0)
    const runs = await glides(page)
    expect(runs[0]!.duration).toBeGreaterThan(350)
    expect(runs[1]!.duration).toBeGreaterThan(350)
    await expect(group.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })

  test('the portrait cursor stays on its visible path when label modes change during Listen', async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await seedPiece(page)
    await openSeededPractice(page)
    await page.waitForTimeout(2500)
    await page.getByRole('button', { name: 'Left hand', exact: true }).click()
    await page.getByRole('button', { name: 'Right hand', exact: true }).click()
    await page.getByRole('button', { name: 'Listen', exact: true }).click()
    const samples = await page.evaluate(async (menuButton) => {
      const points: { t: number; x: number; y: number; lag: number; mode: string }[] = []
      const sample = (mode: string) => {
        const cursor = document.querySelector<HTMLElement>('.pn-page .pn-cursor')!
        const rect = cursor.getBoundingClientRect()
        const drawn = new DOMMatrixReadOnly(getComputedStyle(cursor).transform)
        const target = new DOMMatrixReadOnly(cursor.style.transform)
        points.push({
          t: performance.now(),
          x: rect.left,
          y: rect.top,
          lag: cursor.closest('.pn-instant') ? Math.hypot(drawn.m41 - target.m41, drawn.m42 - target.m42) : 0,
          mode,
        })
      }
      for (const mode of ['All', 'Off', 'Conditional', 'All', 'Conditional']) {
        sample(mode)
        // Direct activation keeps the test focused on playback, even with receded controls. Note
        // names live in the footer menu (U76), which closes when the chrome recedes, or on a
        // phone in the top bar's menu sheet (U80): reopen it.
        const radio = () =>
          [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((el) => el.textContent === mode)
        const menu = document.querySelector<HTMLElement>(menuButton)!
        while (!radio()) {
          if (menu.getAttribute('aria-expanded') !== 'true') menu.click()
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        radio()!.click()
        await new Promise<void>((resolve) => {
          const started = performance.now()
          const frame = () => {
            sample(mode)
            if (performance.now() - started >= 550) resolve()
            else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
      }
      return points
    }, MENU_BUTTON)
    expect(samples.length).toBeGreaterThan(30)
    let worstStep = 0
    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1]!
      const current = samples[i]!
      const distance = Math.hypot(current.x - previous.x, current.y - previous.y)
      const allowance = 3 + (current.t - previous.t) * 1.5
      worstStep = Math.max(worstStep, distance / allowance)
    }
    const lag = Math.max(...samples.map((p) => p.lag))
    info.annotations.push({ type: 'portrait-cursor', description: JSON.stringify({ lag, worstStep, samples }) })
    // Playback writes the current position every frame, never a CSS seek from a stale position.
    expect(lag).toBeLessThan(0.5)
    // The new layout must pick up where the visible cursor was, rather than teleporting to its x.
    expect(worstStep).toBeLessThan(1)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })
})
