import { expect, test } from '@playwright/test'
import { openHarness, REFERENCE_PIECE, referencePresent } from './render-helpers'

/** Portrait labels need horizontal space even when collision layout can hide them in stacks. */
test.describe('portrait note-name spacing', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 597, height: 846 })
    await openHarness(page)
  })

  test('ordinary bars wrap within the requested page width', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const summary = await window.harness.prepare('generated-12', 3, { mode: 'page', pageWidth: 565 })
      return { summary, systems: window.harness.layout()!.systems!.length }
    })
    expect(result.summary.params.pageWidth).toBe(565)
    expect(result.summary.params.iterations).toBeLessThanOrEqual(3)
    expect(result.summary.report.unmappedNotes).toEqual([])
    expect(result.systems).toBeGreaterThan(1)
  })

  test('dense runs gain note spacing without shrinking labels or losing mapping', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const before = await window.harness.prepare('changes', 3, {
        mode: 'page',
        pageWidth: 565,
        maxIterations: 1,
      })
      const beforeBar = window.harness.layout()!.occurrences[0]!
      const after = await window.harness.prepare('changes', 3, { mode: 'page', pageWidth: 565 })
      const afterBar = window.harness.layout()!.occurrences[0]!
      const off = await window.harness.prepare('changes', 3, { mode: 'page', pageWidth: 565, room: 'hints' })
      return { before, after, off, beforeWidth: beforeBar.x1 - beforeBar.x0, afterWidth: afterBar.x1 - afterBar.x0 }
    })
    expect(result.afterWidth).toBeGreaterThan(result.beforeWidth * 1.3)
    expect(result.after.params.labelFontPx).toBe(result.before.params.labelFontPx)
    expect(result.after.labels).toBe(result.before.labels)
    expect(result.after.report.unmappedNotes).toEqual([])
    expect(result.after.stats.placements.stack + result.after.stats.placements.callout).toBeLessThan(
      result.before.stats.placements.stack + result.before.stats.placements.callout,
    )
    expect(result.off.params.pageWidth).toBe(565)
    expect(result.off.params.iterations).toBe(1)
  })

  test('reference dense bar stays readable and reachable across the wider system', async ({ page }, info) => {
    test.skip(!referencePresent, 'private reference-piece fixture absent')
    const result = await page.evaluate(async (name) => {
      const summary = await window.harness.prepare(name, 3, { mode: 'page', pageWidth: 565 })
      const layout = window.harness.layout()!
      const bar = layout.occurrences[10]!
      const labels = layout.labels.filter((l) => l.occ === 10)
      window.harness.mount({ width: 597, height: 846 })
      window.harness.showAllLabels()
      window.harness.strip()!.setCursor(bar.start, { smooth: false })
      window.harness.strip()!.flushNow()
      return {
        summary,
        bar,
        leaders: labels.filter((l) => l.placement === 'stack' || l.placement === 'callout').length,
      }
    }, REFERENCE_PIECE)
    expect(result.bar.x1 - result.bar.x0).toBeGreaterThan(1000)
    expect(result.leaders).toBeLessThanOrEqual(6)
    expect(result.summary.report.unmappedNotes).toEqual([])
    expect(result.summary.params.iterations).toBeLessThanOrEqual(3)
    await page.waitForTimeout(350)
    const playback = await page.evaluate(async ({ start, duration }) => {
      const view = window.harness.strip()!
      const scroller = document.querySelector<HTMLElement>('.pn-page-scroll')!
      const root = scroller.getBoundingClientRect()
      const positions: number[] = []
      for (let i = 1; i <= 30; i++) {
        view.setCursor(start + (duration * i) / 32, { smooth: false })
        view.flushNow()
        await new Promise(requestAnimationFrame)
        const cursor = document.querySelector('.pn-cursor')!.getBoundingClientRect()
        positions.push(cursor.x + cursor.width / 2 - root.x)
      }
      return { positions, left: scroller.scrollLeft }
    }, result.bar)
    expect(playback.left).toBeGreaterThan(100)
    for (const x of playback.positions) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(597)
    }
    await info.attach('portrait-dense-labels', { body: await page.screenshot(), contentType: 'image/png' })
    const nextSystem = await page.evaluate(async ({ start, duration }) => {
      const view = window.harness.strip()!
      const bounds = document.querySelector('.pn-page-scroll')!.getBoundingClientRect()
      const xs: number[] = []
      for (let i = 0; i < 24; i++) {
        view.setCursor(start + duration + i / 240, { smooth: false })
        view.flushNow()
        await new Promise(requestAnimationFrame)
        const cursor = document.querySelector('.pn-cursor')!.getBoundingClientRect()
        xs.push(cursor.x + cursor.width / 2 - bounds.x)
      }
      return xs
    }, result.bar)
    for (const x of nextSystem) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(597)
    }
  })
})
