/**
 * Practice smoke workflow (WP10): imported fixture → Practice with injected fake MIDI → wrong-note
 * feedback → scored completion → compact result linking to Results. Light and dark screenshots
 * are written outside the repository (SHOT_DIR) and attached to the report.
 */
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { importFixture } from '../unit/import/fixtures'
import {
  SHOT_DIR,
  installFakeMidi,
  loopWholePiece,
  openSeededPractice,
  play,
  playWhenDue,
  seedPiece,
  waitForOnset,
} from './practice-helpers'

test.describe('practice', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeMidi(page)
  })

  test('wrong note flash, scored completion and the result card', async ({ page, browserName }, info) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await expect(page.getByText('Connected', { exact: false }).first()).toBeVisible({ timeout: 15_000 })

    await loopWholePiece(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByTestId('ready')).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-ready-light.png`) })

    // Wrong keys show the damage wash without text over the notation or any shake.
    await play(page, 70)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await expect(page.getByText('Wrong key', { exact: true })).toHaveCount(0)
    const feedback = await page.evaluate(
      () =>
        new Promise<{ seen: boolean; cursor: number[]; note: number[] }>((resolve) => {
          const el = document.querySelector<HTMLElement>('[data-testid="wrong-note-flash"]')!
          const cursor = document.querySelector('.pn-cursor')!
          const note = document.querySelector('.pn-target')!
          const positions = { cursor: [] as number[], note: [] as number[] }
          window.__midi.on(71)
          window.__midi.off(71)
          let seen = false
          const t0 = performance.now()
          const check = () => {
            if (Number(getComputedStyle(el).opacity) > 0.05) seen = true
            positions.cursor.push(cursor.getBoundingClientRect().x)
            positions.note.push(note.getBoundingClientRect().x)
            if (performance.now() - t0 > 450) resolve({ seen, ...positions })
            else requestAnimationFrame(check)
          }
          requestAnimationFrame(check)
        }),
    )
    expect(feedback.seen).toBe(true)
    for (const positions of [feedback.cursor, feedback.note]) {
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.01)
    }
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-wrong-light.png`) })

    await playWhenDue(page, 60, 48)
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await playWhenDue(page, 62)
    await playWhenDue(page, 64)
    await playWhenDue(page, 65)
    await playWhenDue(page, 67, 71, 74, 43)
    await playWhenDue(page, 48)

    const card = page.getByTestId('attempt-result')
    await expect(card).toBeVisible()
    await expect(card).toContainText('2 wrong notes')
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-result-light.png`) })
    await info.attach('result-light.png', { body: await page.screenshot(), contentType: 'image/png' })

    // Dark theme: the screen and score follow the theme (U8).
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(500) // let color transitions settle before the screenshot
    const [bg, darkBg] = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('div'))
      probe.style.background = 'var(--bg)'
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return [getComputedStyle(document.querySelector('[data-activity]')!).backgroundColor, expected]
    })
    expect(bg).toBe(darkBg)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-result-dark.png`) })
    await info.attach('result-dark.png', { body: await page.screenshot(), contentType: 'image/png' })

    await card.getByRole('button', { name: 'Details' }).click()
    await expect(page.locator('main')).toHaveAttribute('data-view', 'results')
  })

  test('the cursor stays fixed while practice flows at tempo and waits for the next correct note', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    const cursor = page.locator('.pn-cursor')
    const initialX = (await cursor.boundingBox())!.x
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await waitForOnset(page, 60, 48)
    const built = await importFixture('two-hands.musicxml')
    const nextIndex = built.package.model.notes.findIndex((n) => n.occ === 0 && n.midi === 62)
    const frames = await page.evaluate(
      (nextIndex) =>
        new Promise<{ t: number; cursor: number; note: number }[]>((resolve) => {
          const cursor = document.querySelector('.pn-cursor')!
          const note = document.querySelector(`.pn-music [data-n="${nextIndex}"]`)!
          const frames: { t: number; cursor: number; note: number }[] = []
          const start = performance.now()
          const sample = () => {
            const box = note.getBoundingClientRect()
            frames.push({ t: performance.now() - start, cursor: cursor.getBoundingClientRect().x, note: box.x })
            if (performance.now() - start >= 1400) return resolve(frames)
            requestAnimationFrame(sample)
          }
          sample()
          for (const n of [60, 48]) window.__midi.on(n)
          for (const n of [60, 48]) window.__midi.off(n)
        }),
      nextIndex,
    )
    for (const frame of frames) expect(frame.cursor).toBeCloseTo(initialX, 2)
    const moving = frames.filter((f) => f.t >= 50 && f.t <= 900)
    expect(new Set(moving.map((f) => f.note.toFixed(1))).size).toBeGreaterThan(12)
    expect(moving.at(-1)!.note).toBeLessThan(moving[0]!.note - 20)
    // At quarter = 60 the next note must still be approaching after a quarter of a second.
    expect(frames.find((f) => f.t >= 250)!.note).toBeGreaterThan(initialX + 15)
    const waiting = frames.filter((f) => f.t >= 1150)
    expect(Math.max(...waiting.map((f) => f.note)) - Math.min(...waiting.map((f) => f.note))).toBeLessThan(0.1)
    await waitForOnset(page, 62)
    await expect(page.getByTestId('attempt-result')).toHaveCount(0)
    await playWhenDue(page, 62)
    await waitForOnset(page, 64)
    expect((await cursor.boundingBox())!.x).toBeCloseTo(initialX, 2)
  })

  test('a correct pitch in the wrong octave shows only an arrow in the needed direction', async ({ page }) => {
    await seedPiece(page)
    await openSeededPractice(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await waitForOnset(page, 60, 48)
    const arrow = page.getByTestId('stage-cue')
    await play(page, 72)
    await expect(arrow).toHaveAttribute('data-direction', 'down')
    await expect(arrow).toHaveText('')
    await play(page, 36)
    await expect(arrow).toHaveAttribute('data-direction', 'up')
    await expect(arrow).toHaveText('')
    await expect(page.getByTestId('feedback-chip')).toHaveCount(0)
    await playWhenDue(page, 60, 48)
    await expect(arrow).toHaveCount(0)
  })

  test('portrait layout keeps the strip and the main controls usable', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await seedPiece(page)
    await openSeededPractice(page)
    await page.getByRole('button', { name: 'Show keys' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await playWhenDue(page, 60, 48)
    const strip = await page.locator('[data-testid="strip-host"]').boundingBox()
    expect(strip!.height).toBeGreaterThan(120)
    await expect(
      page.getByRole('region', { name: 'Keyboard guide' }).getByRole('img', { name: /^Keyboard guide\./ }),
    ).toBeVisible()
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-portrait-light.png`) })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOT_DIR, `${browserName}-portrait-dark.png`) })
  })

  test('MIDI-only practice never fetches the piano sample bank', async ({ page }) => {
    const samples: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/samples/')) samples.push(r.url())
    })
    await seedPiece(page)
    await openSeededPractice(page)
    await page.getByRole('button', { name: 'Left hand' }).click() // left hand off → right hand + accompaniment
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await playWhenDue(page, 60)
    await page.waitForTimeout(500)
    expect(samples).toEqual([])
    const sent = await page.evaluate(() => window.__midi.sent.length)
    expect(sent).toBeGreaterThan(0) // the accompaniment played through MIDI
  })
})
