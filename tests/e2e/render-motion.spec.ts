/**
 * Strip motion in real browsers (DECISIONS R12): in Listen the session passes the transport
 * position every frame with `smooth: false`. Sampled per frame at a constant musical speed, the
 * score's translate must change continuously — no jump at barlines (the old mapping went to the
 * barline, then jumped to the next bar's first note) and no step in speed — while the cursor stays
 * at its one-third anchor.
 */
import { expect, test, type Page } from '@playwright/test'
import { REFERENCE_PIECE, referencePresent, openHarness } from './render-helpers'

interface Sample {
  t: number
  pos: number
  tx: number
  cursorX: number
  flushMs: number
}

interface Run {
  samples: Sample[]
  legacyMaxJump: number
}

const WIDTH = 1000

async function setup(page: Page, name: string): Promise<void> {
  await openHarness(page)
  await page.evaluate(async (n) => {
    await window.harness.prepare(n)
    window.harness.mount({ width: 1000, height: 360 })
    window.harness.showAllLabels()
  }, name)
}

function sweep(page: Page, opts: { fixedStep?: number; legacy?: boolean } = {}): Promise<Run> {
  return page.evaluate(async (o) => {
    const run = await window.harness.simulateListen(3, 1, o)
    return { samples: [...run.samples], legacyMaxJump: run.legacyMaxJump }
  }, opts)
}

/** Speed per step in px per whole note (from the position actually advanced) and its changes. */
function analyze(samples: readonly Sample[]) {
  const speeds: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!
    const b = samples[i]!
    const dp = b.pos - a.pos
    if (dp < 1e-4) continue // a frame delivered twice at one timestamp
    speeds.push((a.tx - b.tx) / dp)
  }
  const sorted = [...speeds].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  let maxChange = 0
  for (let i = 1; i < speeds.length; i++) maxChange = Math.max(maxChange, Math.abs(speeds[i]! - speeds[i - 1]!))
  return { median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, maxChange }
}

const round = (a: ReturnType<typeof analyze>) =>
  Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Math.round(v)]))

for (const name of ['long-500', 'generated-40', REFERENCE_PIECE]) {
  test(`Listen glides at constant musical speed without jumps (${name})`, async ({ page }) => {
    test.skip(name === REFERENCE_PIECE && !referencePresent, 'private reference-piece fixture absent')
    await setup(page, name)

    // Real time: one position per animation frame, from the frame timestamp.
    const live = await sweep(page)
    expect(live.samples.length).toBeGreaterThan(30)
    const a = analyze(live.samples)
    // The cursor stays at its anchor while the music moves beneath it.
    for (const s of live.samples) expect(Math.abs(s.cursorX - WIDTH / 3)).toBeLessThan(0.6)
    // Always forward, and no frame jumps: nothing moves faster than a small multiple of the
    // typical speed (the old barline jump was a whole bar padding in one frame).
    expect(a.min).toBeGreaterThanOrEqual(0)
    expect(a.max).toBeLessThan(a.median * 4)

    // Deterministic 1/240-whole steps: the speed never steps either (it ramps).
    const fixed = analyze((await sweep(page, { fixedStep: 1 / 240 })).samples)
    expect(fixed.min).toBeGreaterThanOrEqual(0)
    expect(fixed.max).toBeLessThan(fixed.median * 4)
    expect(fixed.maxChange).toBeLessThan(fixed.median * 0.15)
    // Also verify continuous speed at finer resolution, allowing for 0.01 px transform rounding.
    const finer = analyze((await sweep(page, { fixedStep: 1 / 960 })).samples)
    expect(finer.maxChange).toBeLessThan(fixed.maxChange * 0.5 + 20)

    // The same criteria reject the old mapping (barline anchors, no smoothing).
    const legacyRun = await sweep(page, { fixedStep: 1 / 240, legacy: true })
    const legacy = analyze(legacyRun.samples)
    expect(legacy.max > legacy.median * 4 || legacy.maxChange > legacy.median * 0.15).toBe(true)

    test.info().annotations.push({
      type: 'motion',
      description: JSON.stringify({
        frames: live.samples.length,
        live: round(a),
        fixed: round(fixed),
        legacy: round(legacy),
        legacyMaxJumpPx: Math.round(legacyRun.legacyMaxJump),
        maxFlushMs: Number(Math.max(...live.samples.map((s) => s.flushMs)).toFixed(2)),
      }),
    })
  })
}
