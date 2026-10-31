/**
 * Renderer feasibility gates (spec "Import mapping", "Ottava scope and visibility", "All-note
 * labels", "Adjacent label layout", "Bounded notation", "Long piece"): every performed note maps
 * to a visible notehead, ottavas map to their brackets, all-note labels never overlap noteheads
 * or each other, and traversal keeps mounted notation bounded. Measurements are attached.
 */
import { expect, test } from '@playwright/test'
import { REFERENCE_PIECE, referencePresent, openHarness, overlaps, type Box } from './render-helpers'

const FIXTURES = ['basic', 'ottava', 'voices', 'changes'] as const

async function prepare(page: import('@playwright/test').Page, name: string) {
  return page.evaluate(async (n) => {
    const s = await window.harness.prepare(n)
    const l = window.harness.layout()!
    return {
      summary: s,
      heads: l.notes.filter((g) => g !== null).map((g) => ({ ...g!.head, index: g!.index, label: g!.label })),
      labels: l.labels.map((x) => ({ ...x.box, id: x.id, notes: x.notes, placement: x.placement })),
      numbers: l.occurrences.map((o) => o.labelBox),
      segments: l.segments.map((s) => ({
        x0: s.x0,
        x1: s.x1,
        bytes: s.svg.length,
        unsafe: /<script|foreignObject|\son\w+=|javascript:/i.test(s.svg),
      })),
    }
  }, name)
}

function labelCollisions(
  labels: (Box & { id: number; notes: readonly number[] })[],
  heads: (Box & { index: number })[],
  numbers: Box[],
): string[] {
  const out: string[] = []
  const sorted = [...labels].sort((a, b) => a.x - b.x)
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    for (let j = i + 1; j < sorted.length && sorted[j]!.x < a.x + a.w; j++) {
      if (overlaps(a, sorted[j]!)) out.push(`label ${a.id} × label ${sorted[j]!.id}`)
    }
  }
  const byX = [...heads].sort((a, b) => a.x - b.x)
  for (const l of labels) {
    for (const h of byX) {
      if (h.x > l.x + l.w) break
      if (overlaps(l, h)) out.push(`label ${l.id} × head ${h.index}`)
    }
    for (const n of numbers) if (overlaps(l, n)) out.push(`label ${l.id} × measure number`)
  }
  return out
}

test.describe('renderer layout gates', () => {
  test.beforeEach(async ({ page }) => {
    await openHarness(page)
  })

  for (const name of FIXTURES) {
    test(`fixture ${name}: complete mapping and collision-free labels`, async ({ page }) => {
      const r = await prepare(page, name)
      const rep = r.summary.report
      expect(rep.unmappedNotes).toEqual([])
      expect(rep.unmappedGraphics).toEqual([])
      expect(rep.mapped).toBe(rep.modelNotes)
      expect(rep.ottavasUnmapped).toEqual([])
      expect(r.labels).toHaveLength(r.heads.length - rep.sharedHeads)
      expect(labelCollisions(r.labels, r.heads, r.numbers)).toEqual([])
      expect(r.segments.some((s) => s.unsafe)).toBe(false)
      if (name === 'ottava') expect(r.summary.ottavas.map((o) => o?.text)).toEqual(['8va', '8vb', '15ma'])
      if (name === 'voices') expect(rep.sharedHeads).toBe(1)
      if (name === 'changes') expect(r.summary.contexts).toBeGreaterThanOrEqual(3)
    })
  }

  test('importer fixtures: every performed note maps to a visible notehead', async ({ page }) => {
    const names = await page.evaluate(() =>
      window.harness.importerFixtures.filter((n) => !/malformed|unrelated/.test(n)),
    )
    expect(names.length).toBeGreaterThan(15)
    for (const name of names) {
      const r = await prepare(page, name)
      const rep = r.summary.report
      expect(rep.unmappedNotes, name).toEqual([])
      expect(rep.unmappedGraphics, name).toEqual([])
      expect(rep.ottavasUnmapped, name).toEqual([])
      expect(labelCollisions(r.labels, r.heads, r.numbers), name).toEqual([])
    }
  })

  test('importer generateLongScore(500): complete mapping and bounded traversal', async ({ page }) => {
    const r = await prepare(page, 'generated-500')
    expect(r.summary.report.unmappedNotes).toEqual([])
    expect(r.summary.report.unmappedGraphics).toEqual([])
    expect(r.summary.report.ottavasUnmapped).toEqual([])
    const traversal = await page.evaluate(() => {
      window.harness.mount({ width: 1180, height: 360 })
      window.harness.showAllLabels()
      return window.harness.traverse(1, 1)
    })
    // Viewport ± one viewport (old and new view while scrolling) over measure-sized segments.
    expect(traversal.maxMountedSegments).toBeLessThanOrEqual(14)
    expect(traversal.maxMountedNodes).toBeLessThan(8000)
  })

  test('reference piece: 0 unmapped notes, 8va mapped, labels beside every note', async ({ page }, info) => {
    test.skip(!referencePresent, 'private reference-piece fixture absent')
    const r = await prepare(page, REFERENCE_PIECE)
    const rep = r.summary.report
    expect(r.summary.notes).toBeGreaterThan(1300)
    expect(rep.unmappedNotes).toEqual([])
    expect(rep.unmappedGraphics).toEqual([])
    expect(rep.ottavasMapped).toBe(1)
    expect(r.summary.ottavas[0]).toMatchObject({ staff: 0, text: '8va', engraved: true })
    expect(labelCollisions(r.labels, r.heads, r.numbers)).toEqual([])
    expect(r.summary.stats.placements.callout).toBeLessThanOrEqual(Math.ceil(r.labels.length * 0.005))
    await info.attach('reference-prepare.json', {
      body: JSON.stringify(r.summary.stats, null, 2),
      contentType: 'application/json',
    })
  })

  test('500 measures: complete mapping, single staffline, bounded traversal with all labels', async ({
    page,
  }, info) => {
    const r = await prepare(page, 'long-500')
    const rep = r.summary.report
    expect(r.summary.params.iterations).toBeLessThanOrEqual(3)
    expect(rep.unmappedNotes).toEqual([])
    expect(rep.unmappedGraphics).toEqual([])
    expect(rep.ottavasUnmapped).toEqual([])
    expect(r.summary.height).toBeLessThan(400)
    expect(labelCollisions(r.labels, r.heads, r.numbers)).toEqual([])

    const traversal = await page.evaluate(() => {
      window.harness.mount({ width: 1180, height: 360 })
      window.harness.showAllLabels()
      return window.harness.traverse(2, 1)
    })
    // Viewport ± one viewport (old and new view while scrolling) over measure-sized segments.
    expect(traversal.maxMountedSegments).toBeLessThanOrEqual(14)
    expect(traversal.maxCachedSegments).toBeLessThanOrEqual(12)
    expect(traversal.maxLabelNodes).toBeLessThan(600)
    expect(traversal.maxMountedNodes).toBeLessThan(8000)
    expect(traversal.final.mountedNodes).toBeLessThan(8000)
    await info.attach('long-500.json', {
      body: JSON.stringify({ prepare: r.summary.stats, traversal }, null, 2),
      contentType: 'application/json',
    })
  })
})
