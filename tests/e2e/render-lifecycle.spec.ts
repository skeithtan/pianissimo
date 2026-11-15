/**
 * What an engraving leaves behind (spec "Execution and rendering architecture"): a canceled
 * preparation stops at the next stage boundary in the real OSMD, rejects as canceled and removes
 * its hidden container, and a finished one keeps none of its engraved SVG alive (OSMD's statics
 * held the last engraving until the next one), on the strip and the page path alike.
 */
import { expect, test, type CDPSession } from '@playwright/test'
import { openHarness } from './render-helpers'

const STAGES = ['start', 'loading', 'engraving', 'extracting', 'labels', 'partitioning'] as const

for (const mode of ['strip', 'page'] as const) {
  test(`a canceled ${mode} preparation stops at the next stage boundary and leaves no container`, async ({ page }) => {
    await openHarness(page)
    for (const stage of STAGES) {
      const result = await page.evaluate(([s, m]) => window.harness.prepareCanceledAt('basic', s, { mode: m }), [
        stage,
        mode,
      ] as const)
      expect(result.outcome, stage).toBe('AbortError')
      expect(result.bodyChildrenAdded, stage).toBe(0)
      // Nothing after the stage it was canceled in.
      if (stage === 'start') expect(result.stages, stage).toEqual([])
      else expect(result.stages.at(-1), stage).toBe(stage)
    }
  })
}

/** DOM nodes alive after a full garbage collection, detached ones included (Chromium only). */
async function liveNodes(cdp: CDPSession): Promise<number> {
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  return metrics.find((m) => m.name === 'Nodes')!.value
}

for (const mode of ['strip', 'page'] as const) {
  test(`a finished ${mode} preparation keeps none of its engraving alive`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'counts nodes through the Chrome DevTools Protocol')
    await openHarness(page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    // Load OSMD and the label font first: what they keep is not the engraving's.
    await page.evaluate((m) => window.harness.prepare('basic', 3, { mode: m }), mode)
    const before = await liveNodes(cdp)
    const summary = await page.evaluate((m) => window.harness.prepare('generated-40', 3, { mode: m }), mode)
    const after = await liveNodes(cdp)
    expect(summary.stats.svgNodes).toBeGreaterThan(2000)
    // Before the fix every node of the engraved tree stayed alive until the next engraving.
    expect(after - before).toBeLessThan(summary.stats.svgNodes / 20)
  })
}
