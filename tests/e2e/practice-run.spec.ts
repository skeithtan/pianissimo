/**
 * The result after every run (DECISIONS U142): a Wait run outside Repeat that reaches the end of the
 * piece shows the pill a loop shows and stores no attempt. The pill has no actions: it is the top of
 * its card, cut off partway, and all of it opens the card, whose actions (Loop 4–6, Again) are under
 * the verdict. Fake Web MIDI; a generated eight-bar piece (two half notes a bar over a whole note).
 *
 * RUN_SHOTS=<directory outside the repository> also saves the pill with mistakes, on a tablet and a phone.
 */
import { join } from 'node:path'
import { expect, test, type Page } from '../browser-test'
import type { AppSettings } from '../../src/core/model/settings'
import { newPieceRecord, type PieceRecord } from '../../src/core/storage/records'
import { importBytes } from '../unit/import/fixtures'
import { PIECE_ID, installFakeMidi, playAfterCountIn, seedPiece } from './practice-helpers'

const SHOTS = process.env['RUN_SHOTS']
const BARS = 8
/** Seconds between the half notes at ♩ = 160. */
const HALF = 0.75
const SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']
const SIZES = [
  { width: 1194, height: 834 },
  { width: 834, height: 1194 },
  { width: 390, height: 844 },
  { width: 852, height: 393 },
] as const

const note = (step: string, octave: number, duration: number, type: string, staff: number) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${staff}</voice><type>${type}</type><staff>${staff}</staff></note>`

/** Right hand: a rising scale in half notes; left hand: C3 and G2 whole notes. */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>Two Hands</work-title></work>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from(
  { length: BARS },
  (_, bar) =>
    `<measure number="${bar + 1}">${
      bar === 0
        ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>160</per-minute></metronome></direction-type><sound tempo="160"/></direction>'
        : ''
    }${[0, 1]
      .map((i) => (bar * 2 + i) % 8)
      .map((k) => note(SCALE[k]!, k === 7 ? 5 : 4, 2, 'half', 1))
      .join(
        '',
      )}<backup><duration>4</duration></backup>${note(bar % 2 ? 'G' : 'C', bar % 2 ? 2 : 3, 4, 'whole', 2)}</measure>`,
).join('')}</part></score-partwise>`

/** A key nowhere near a written one. */
const WRONG = 30

/** Opens the generated piece in Practice; returns the MIDI pitch of each performed note. */
async function openPiece(
  page: Page,
  patch: Partial<PieceRecord> = {},
  settings: Partial<AppSettings> = {},
): Promise<number[]> {
  await installFakeMidi(page)
  await seedPiece(page, settings)
  const built = await importBytes('run.musicxml', new TextEncoder().encode(XML))
  const piece: PieceRecord = { ...newPieceRecord(built.package, { id: PIECE_ID, now: Date.now() }), ...patch }
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
    { piece: JSON.parse(JSON.stringify(piece)), pkg: JSON.parse(JSON.stringify(built.package)) },
  )
  await page.goto(`./#/practice/${PIECE_ID}`)
  await page.reload()
  await expect(page.locator('.pn-strip, .pn-page').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'paused')
  return built.package.model.notes.map((n) => n.midi)
}

const startButton = (page: Page) => page.getByRole('button', { name: 'Start', exact: true })
const pill = (page: Page) => page.getByTestId('attempt-result')
const loopButton = (page: Page) => page.getByTestId('result-loop')

/**
 * Plays every onset as it comes to rest at the cursor, from the first one waiting there, a wrong key
 * before the onsets named by `wrong` (counted from that one), until the run ends or after `onsets`.
 */
async function read(
  page: Page,
  midis: readonly number[],
  wrong: Record<number, number[]> = {},
  onsets = Infinity,
): Promise<void> {
  await page.evaluate(
    ({ midis, wrong, onsets }) =>
      new Promise<void>((resolve, reject) => {
        let played = 0
        let last = ''
        let previous = ''
        let since = performance.now()
        let deadline = since + 20_000
        const tap = (notes: number[]) => {
          for (const n of notes) window.__midi.on(n)
          for (const n of notes) window.__midi.off(n)
        }
        const check = () => {
          const now = performance.now()
          const phase = document.querySelector<HTMLElement>('[data-activity]')?.dataset['phase']
          if (phase === 'completed' || played >= onsets) return resolve()
          const cursor = document.querySelector('.pn-cursor-bar')?.getBoundingClientRect()
          const near = [...document.querySelectorAll('.pn-music .pn-target:not(.pn-acc)')].filter((el) => {
            const b = el.getBoundingClientRect()
            return !!cursor && b.left <= cursor.right + 4 && b.right >= cursor.left - 4
          })
          const ids = [...new Set(near.flatMap((el) => (el.getAttribute('data-n') ?? '').split(' ')))]
            .filter(Boolean)
            .sort()
          const at = [cursor?.x, cursor?.y, ...near.map((el) => el.getBoundingClientRect().x)].map((x) => x?.toFixed(1))
          const key = `${ids.join(',')}|${at.join(',')}`
          if (!ids.length || key !== previous) since = now
          previous = key
          if (ids.length && ids.join(',') !== last && now - since >= 80) {
            tap(wrong[played] ?? [])
            tap([...new Set(ids.map((id) => midis[Number(id)]!))])
            last = ids.join(',')
            played++
            deadline = now + 20_000
          }
          if (now > deadline) return reject(new Error(`no onset came to the cursor after ${played}`))
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
    { midis, wrong, onsets: Number.isFinite(onsets) ? onsets : Number.MAX_SAFE_INTEGER },
  )
}

/** The stored attempts of the piece. */
function storedAttempts(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('pianissimo')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const count = req.result.transaction('attempts').objectStore('attempts').count()
          count.onsuccess = () => {
            req.result.close()
            resolve(count.result)
          }
        }
      }),
  )
}

/** The pill's peek: what is drawn in it, how much of it the pill cuts off, and what can be pressed. */
function peekOf(page: Page) {
  return pill(page).evaluate((card) => {
    const peek = card.querySelector<HTMLElement>('[data-testid="result-details-preview"]')!
    const row = card.querySelector<HTMLElement>('[data-expandable]')!
    const toggle = card.querySelector<HTMLElement>('[data-testid="result-details-toggle"]')!
    const chevron = toggle.querySelector('svg > *')!.getBoundingClientRect()
    const box = row.getBoundingClientRect()
    const dock = document.querySelector('[data-testid="result-dock"]')!.getBoundingClientRect()
    const clip = peek.getBoundingClientRect()
    const lines = [...peek.querySelectorAll('li, p, span')].map((el) => el.getBoundingClientRect())
    const music = peek.querySelector('svg.pn-excerpt-svg')?.getBoundingClientRect()
    const surface = toggle.getBoundingClientRect()
    return {
      height: box.height,
      dock: dock.height,
      contentHeight: peek.scrollHeight,
      clipHeight: peek.clientHeight,
      // The peek runs to the pill's bottom edge (inside its border).
      gap: box.bottom - clip.bottom,
      // Just above the pill, inside the dock the review keeps free.
      chevronAbove:
        chevron.bottom < box.top &&
        box.top - chevron.bottom >= 8 &&
        box.top - chevron.bottom <= 16 &&
        chevron.top >= dock.top,
      // Clear of the badge.
      air: clip.top - card.querySelector('[data-expandable] [aria-hidden="true"]')!.getBoundingClientRect().bottom,
      complete: lines.some((r) => r.height > 0 && r.bottom <= clip.bottom + 0.5),
      cut: music
        ? music.top < clip.bottom - 8 && music.bottom > clip.bottom + 8
        : lines.some((r) => r.top < clip.bottom - 4 && r.bottom > clip.bottom + 2),
      surface: surface.width >= box.width - 2 && surface.height >= box.height - 2,
      buttons: [...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
    }
  })
}

async function expectCut(page: Page): Promise<Awaited<ReturnType<typeof peekOf>>> {
  const peek = await peekOf(page)
  expect(peek).toMatchObject({ chevronAbove: true, complete: true, cut: true, surface: true })
  expect(peek.air).toBeGreaterThanOrEqual(12)
  expect(peek.contentHeight).toBeGreaterThan(peek.clipHeight + 4)
  expect(Math.abs(peek.gap)).toBeLessThanOrEqual(1.5)
  expect(peek.buttons).toEqual(['Show details of this pass', 'Hide result'])
  return peek
}

const choices = (page: Page) => page.getByTestId('result-choices')
const card = (page: Page) => page.getByTestId('result-details')
const again = (page: Page) => choices(page).getByRole('button', { name: 'Again', exact: true })

test.describe('the result after a Wait run (U142)', () => {
  test('a run to the end shows the pill, its top of the card cut off, stores no attempt; the card loops its rough bars', async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0])
    const midis = await openPiece(page)
    await startButton(page).click()
    // Two wrong keys in bar 5 (onsets 8 and 9), one in bar 8.
    await read(page, midis, { 8: [WRONG], 9: [WRONG], 14: [WRONG] })
    // Nothing of the card loads with Practice: the first rest after a result fetches it for the peek.
    const fetched = () =>
      page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/ResultDetails-')))
    expect(await fetched()).toBe(false)
    await expect(pill(page)).toContainText('3 wrong notes')
    await expect(page.locator('.pn-corr')).not.toHaveCount(0)
    await expect(page.locator('.pn-strip')).not.toHaveClass(/pn-review/)
    // The shell of the first mistake, at once; its excerpt once at rest; the pill never changes size.
    const before = await peekOf(page)
    expect(before.buttons).toEqual(['Show details of this pass', 'Hide result'])
    await expect(page.getByTestId('result-details-preview').locator('svg.pn-excerpt-svg')).toHaveCount(1, {
      timeout: 10_000,
    })
    await expect(page.getByTestId('result-details-preview')).toContainText('Bar 5')
    expect(await fetched()).toBe(true)
    const after = await expectCut(page)
    expect(after.height).toBe(before.height)
    expect(after.dock).toBe(before.dock)
    expect(after.height).toBeLessThanOrEqual(128)
    if (SHOTS) {
      await page.screenshot({ path: join(SHOTS, 'pill-tablet.png') })
      await page.setViewportSize(SIZES[2])
      await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
      // Rotated, the excerpt is drawn again.
      await expect(page.getByTestId('result-details-preview').locator('svg.pn-excerpt-svg')).toHaveCount(1)
      await page.screenshot({ path: join(SHOTS, 'pill-phone.png') })
      await page.setViewportSize(SIZES[0])
      await expect(page.locator('.pn-strip')).toBeVisible({ timeout: 60_000 })
    }

    // The whole pill opens the card: its middle too.
    await pill(page).click()
    await expect(card(page).getByTestId('result-verdict')).toHaveText('Not clean: 3 wrong notes.')
    await expect.poll(async () => (await card(page).boundingBox())?.width).toBe(900)
    // The actions, under the verdict, in view; then what the pill peeked at.
    await expect(choices(page).getByRole('button')).toHaveText(['Loop 4–6', 'Again'])
    const order = await card(page).evaluate((el) =>
      [...el.querySelectorAll('[data-testid]')]
        .map((n) => n.getAttribute('data-testid')!)
        .filter((id) => ['result-verdict', 'result-choices', 'result-excerpt', 'result-facts'].includes(id)),
    )
    expect(order).toEqual(['result-verdict', 'result-choices', 'result-excerpt', 'result-excerpt', 'result-facts'])
    await expect(card(page).getByTestId('result-excerpt').first()).toContainText('Bar 5')
    // A loop's card, without what is stored; reading is not timed.
    await expect(card(page).getByTestId('result-facts').locator('li')).toHaveText([
      'Right the first time at 13 of 16 places',
    ])
    const listen = card(page).getByTestId('excerpt-listen').first()
    await expect(listen.getByRole('button', { name: 'What you played' })).toBeEnabled({ timeout: 15_000 })
    await expect(card(page).getByText(/Earlier passes|All the numbers/)).toHaveCount(0)
    await page.getByTestId('result-details-toggle').click()
    await expect(card(page)).toHaveCount(0)
    expect((await expectCut(page)).height).toBe(before.height)

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(1500)
    expect(await storedAttempts(page)).toBe(0)

    await pill(page).click()
    await loopButton(page).click()
    const panel = page.getByTestId('repeat-controls')
    await expect(panel.getByRole('group', { name: 'Loop start' })).toContainText(/Bar 4(?!\d)/)
    await expect(panel.getByRole('group', { name: 'Loop end' })).toContainText(/Bar 6(?!\d)/)
    await expect(pill(page)).toHaveCount(0)
    await expect(card(page)).toHaveCount(0)
    await expect(page.locator('.pn-corr')).toHaveCount(0)
    // Paused at the loop's start: nothing plays, Start begins a pass.
    await page.waitForTimeout(1000)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'paused')
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0)
    await startButton(page).click()
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'ready')
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-activity', 'scored')
  })

  test('a clean run peeks at its facts and offers Again only; the next run plays past the pill (U101)', async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0])
    const midis = await openPiece(page)
    await startButton(page).click()
    await read(page, midis)
    await expect(pill(page)).toContainText('Clean pass')
    // Its facts, whatever marks the pass has, and first in the card.
    await expectCut(page)
    await expect(page.getByTestId('result-details-preview')).toContainText('Right the first time')
    await expect(page.getByTestId('result-peek-mistake')).toHaveCount(0)
    await pill(page).click()
    await expect(card(page).getByTestId('result-facts')).toBeVisible()
    expect(
      await card(page)
        .locator('[data-testid="result-excerpt"], [data-testid="result-facts"]')
        .first()
        .getAttribute('data-testid'),
    ).toBe('result-facts')
    await expect(choices(page).getByRole('button')).toHaveText(['Again'])
    await page.keyboard.press('Escape')
    await expect(card(page)).toHaveCount(0)

    await startButton(page).click()
    await expect(pill(page)).not.toHaveAttribute('data-dimmed', 'true')
    await read(page, midis, {}, 1)
    await expect(pill(page)).toHaveAttribute('data-dimmed', 'true')
    await read(page, midis, {}, 1)
    await expect(pill(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  })

  test('Again, from the card, starts over from the run’s first note; a rotation keeps the pill and its card', async ({
    page,
  }) => {
    await page.setViewportSize(SIZES[0])
    const midis = await openPiece(page)
    await startButton(page).click()
    await read(page, midis, { 4: [WRONG] })
    await expect(pill(page)).toContainText('1 wrong note')
    await pill(page).click()
    await expect(loopButton(page)).toHaveText('Loop 2–4')
    await page.setViewportSize(SIZES[1])
    await expect(page.locator('.pn-page')).toBeVisible({ timeout: 60_000 })
    await expect(card(page)).toBeVisible()
    await expect(loopButton(page)).toHaveText('Loop 2–4')
    await again(page).click()
    await expect(card(page)).toHaveCount(0)
    await expect(pill(page)).toHaveCount(0)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running')
    await read(page, midis, {}, 2)
    await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'running')
  })
})

/** A whole Keep time pass, the second note of bar 5 left out. */
async function keepTimePass(page: Page): Promise<void> {
  await startButton(page).click()
  const rh = [60, 62, 64, 65, 67, 69, 71, 72]
  await playAfterCountIn(
    page,
    Array.from({ length: BARS * 2 }, (_, g) => ({
      notes: [rh[g % 8]!, ...(g % 2 ? [] : [(g >> 1) % 2 ? 43 : 48])],
      atMs: g * HALF * 1000,
    })).filter((_, g) => g !== 9),
  )
  await expect(pill(page)).toContainText('1 missed', { timeout: 20_000 })
}

test('Keep time: opened while its music ends, the card loops the rough bars, or counts in again', async ({ page }) => {
  await page.setViewportSize(SIZES[0])
  await openPiece(page, { mode: 'time' })
  await keepTimePass(page)
  await pill(page).click()
  await expect(choices(page).getByRole('button')).toHaveText(['Loop 4–6', 'Again'])
  await again(page).click()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByTestId('count-in')).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  await keepTimePass(page)
  await pill(page).click()
  await loopButton(page).click()
  await expect(page.getByTestId('repeat-controls').getByRole('group', { name: 'Loop start' })).toContainText(
    /Bar 4(?!\d)/,
  )
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('count-in')).toHaveCount(0)
  await expect(page.locator('[data-activity]')).toHaveAttribute('data-phase', 'paused')
  await startButton(page).click()
  await expect(page.getByTestId('count-in')).toBeVisible()
})

const LOOP_BARS = { fromOcc: 3, toOcc: 5 }
const inRepeat: Partial<PieceRecord> = { mode: 'wait', lastPassage: LOOP_BARS, repeatOpen: true }

test('a loop’s pill is cut the same, has no actions, and covers none of the passage it reviews, on its side', async ({
  page,
}) => {
  await page.setViewportSize(SIZES[3])
  const midis = await openPiece(page, inRepeat)
  await startButton(page).click()
  await read(page, midis, { 2: [WRONG] }, 6)
  await expect(pill(page)).toContainText('1 wrong note')
  await expect(page.getByTestId('result-details-preview').locator('svg.pn-excerpt-svg')).toHaveCount(1, {
    timeout: 10_000,
  })
  await expect(pill(page)).not.toHaveAttribute('data-intro', 'true')
  await expectCut(page)
  await page.waitForTimeout(800)
  const covered = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="attempt-result"]')!.getBoundingClientRect()
    const band = document.querySelector('.pn-loop')!.getBoundingClientRect()
    return [...document.querySelectorAll('.pn-music [data-n], .pn-corr')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.right > band.left + 1 && r.left < band.right - 1)
      .filter((r) => r.left < pill.right && r.right > pill.left && r.bottom > pill.top && r.top < pill.bottom).length
  })
  expect(covered).toBe(0)
  await pill(page).click()
  await expect(card(page).getByTestId('result-verdict')).toBeVisible()
  await expect(choices(page)).toHaveCount(0)
})
