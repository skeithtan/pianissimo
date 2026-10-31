/**
 * Performance pass measurements (DECISIONS D10). One serial walk through the app per browser:
 * Library first load, a 500-bar import through the UI, layout preparation cold and warm, Listen
 * (with and without the 88-key guide, with all note names), scored practice with an injected fake
 * Web MIDI (MIDI → strip latency, fast playing, wrong-note flash), memory after traversing the
 * whole strip, then a normal-size fixture and the private reference piece (skipped when absent).
 *
 * Chromium: CDP CPU throttling (PERF_CPU, default 4) as the iPad stand-in, traces for the
 * main-thread split, Long Tasks, heap. WebKit: unthrottled, rAF frame times and wall times only.
 * Writes $PERF_OUT/<label>-<browser>.json (default $TMPDIR/pianissimo-perf, label "run") and
 * prints a table; `node scripts/perf/table.mjs a.json b.json` compares two runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test'
import { generateLongScore } from '../../tests/fixtures/generate-long-score'
import { installFakeMidi } from '../../tests/e2e/practice-helpers'
import { DEFAULT_SETTINGS } from '../../src/core/model/settings'
import { dist, frameStats, installPageProbe, perFrame, topSelf, traceSplit, type TraceSplit } from './lib'

const OUT = process.env['PERF_OUT'] ?? join(tmpdir(), 'pianissimo-perf')
const LABEL = process.env['PERF_LABEL'] ?? 'run'
const CPU = Number(process.env['PERF_CPU'] ?? 4)
const LISTEN_MS = Number(process.env['PERF_LISTEN_MS'] ?? 20_000)
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const REFERENCE_PIECE = join(REPO, 'tests/fixtures/private/reference-piece.musicxml')
const NORMAL = join(REPO, 'tests/fixtures/scores/ds-al-coda.musicxml')
const LONG_TITLE = 'Long Score (500 bars)'
/** PERF_PROFILE=1: a sampled CPU profile per measurement (Chromium), top self time by function. */
const PROFILE = process.env['PERF_PROFILE'] === '1'
/** PERF_KEEP_TRACE=1: also write each Chromium trace next to the results (DevTools can open it). */
const KEEP_TRACE = process.env['PERF_KEEP_TRACE'] === '1'
/** PERF_STEPS=listen,practice: run only these optional steps (load, import and prepare always run). */
const STEPS = new Set((process.env['PERF_STEPS'] ?? 'listen,practice,traversal,fixtures').split(','))

type Json = Record<string, unknown>

declare global {
  interface Window {
    __perf: {
      marks: Record<string, number>
      startFrames(): void
      stopFrames(): number[]
      longTasksSince(since: number): { start: number; duration: number }[]
    }
    __pnProbe?: { renders: Record<string, number>; reset(): void }
    __groups?: number[][]
  }
}

test.describe.configure({ mode: 'serial' })

test('perf walk', async ({ page, browser, browserName }) => {
  test.setTimeout(30 * 60_000)
  const chromium = browserName === 'chromium'
  const results: Json = {
    label: LABEL,
    browser: browserName,
    version: browser.version(),
    cpuThrottle: chromium ? CPU : 1,
    viewport: page.viewportSize(),
    date: new Date().toISOString(),
  }
  let cdp: CDPSession | null = null
  if (chromium) {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
    await cdp.send('Performance.enable')
  }
  await page.addInitScript(installPageProbe)
  await installFakeMidi(page)

  // ── Library first load ──────────────────────────────────────────────────────────────────
  await test.step('library first load', async () => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
    await page.waitForTimeout(500)
    results['load'] = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
      const pick = (ext: RegExp) => res.filter((r) => ext.test(new URL(r.name).pathname))
      const sum = (list: PerformanceResourceTiming[], k: 'encodedBodySize' | 'decodedBodySize' | 'transferSize') =>
        Math.round(list.reduce((a, r) => a + (r[k] ?? 0), 0))
      const js = pick(/\.js$/)
      const css = pick(/\.css$/)
      const lt = window.__perf.longTasksSince(0)
      return {
        domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
        loadEvent: Math.round(nav?.loadEventEnd ?? 0),
        fcp: Math.round(fcp?.startTime ?? 0),
        libraryReady: Math.round(window.__perf.marks['libraryReady'] ?? 0),
        jsFiles: js.map((r) => new URL(r.name).pathname.split('/').pop()),
        jsEncoded: sum(js, 'encodedBodySize'),
        jsDecoded: sum(js, 'decodedBodySize'),
        cssEncoded: sum(css, 'encodedBodySize'),
        cssDecoded: sum(css, 'decodedBodySize'),
        longTasks: lt.length,
        longTaskMs: Math.round(lt.reduce((a, l) => a + l.duration, 0)),
      }
    })
    results['heapAfterLoad'] = await heap(cdp)
  })

  // ── 500-bar import through the UI ───────────────────────────────────────────────────────
  await test.step('import 500 bars', async () => {
    results['import500'] = await importThroughUi(page, `long-500.musicxml`, generateLongScore(500))
    results['heapAfterImport'] = await heap(cdp)
  })

  await seedRoute(page)
  await page.reload()
  await expect(page.getByRole('button', { name: `Practice ${LONG_TITLE}` })).toBeVisible()

  // ── prepareLayout cold / warm (500 bars) ────────────────────────────────────────────────
  await test.step('prepare 500 cold/warm', async () => {
    results['prepare500'] = await prepareColdWarm(page, LONG_TITLE)
    results['heapAfterPrepare'] = await heap(cdp)
  })

  // ── Listen ──────────────────────────────────────────────────────────────────────────────
  if (STEPS.has('listen'))
    await test.step('listen', async () => {
      await setHands(page, false)
      await expect(page.getByRole('button', { name: 'Listen', exact: true })).toBeVisible()
      results['listen'] = await measure(page, browser, cdp, 'listen', LISTEN_MS, async () => {
        await page.getByRole('button', { name: 'Listen', exact: true }).click()
      })
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()

      // Same, with the 88-key guide shown (U15).
      await page.getByRole('button', { name: 'Show keys' }).click()
      await page.waitForTimeout(600)
      results['listenGuide'] = await measure(page, browser, cdp, 'listen-guide', LISTEN_MS, async () => {
        await page.getByRole('button', { name: 'Play', exact: true }).click()
      })
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await page.getByRole('button', { name: 'Hide keys' }).click()

      // Same, with every note named (spec: a 500-measure score works with all-note labels).
      await page.getByRole('radio', { name: 'All' }).click()
      await page.waitForTimeout(800)
      results['listenLabels'] = await measure(page, browser, cdp, 'listen-labels', LISTEN_MS, async () => {
        await page.getByRole('button', { name: 'Play', exact: true }).click()
      })
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await page.getByRole('radio', { name: 'Off' }).click()
      results['heapAfterListen'] = await heap(cdp)
    })

  // ── Scored practice with fake MIDI ──────────────────────────────────────────────────────
  if (STEPS.has('practice'))
    await test.step('practice with MIDI', async () => {
      // Both hands, reading from bar 1.
      await setHands(page, true)
      await page.getByRole('slider', { name: 'Piece overview' }).focus()
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      await loadGroups(page)
      await page.getByRole('button', { name: 'Start', exact: true }).click()
      await page.waitForTimeout(400)

      // Latency: one group every 300 ms, each measured on its own.
      results['midiLatency'] = await page.evaluate(async () => {
        const groups = window.__groups!
        const strip = document.querySelector('.pn-strip')!
        const dom: number[] = []
        const frame: number[] = []
        const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)))
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 30; i++) {
          const notes = groups[i]!
          let hit = -1
          const mo = new MutationObserver((list) => {
            if (hit >= 0) return
            for (const m of list) {
              const t = m.target as Element
              if (t.hasAttribute?.('data-n') || t.classList?.contains('pn-marks')) {
                hit = performance.now()
                return
              }
            }
          })
          mo.observe(strip, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true })
          const t0 = performance.now()
          for (const n of notes) window.__midi.on(n)
          while (hit < 0 && performance.now() - t0 < 500) await nextFrame()
          const presented = hit >= 0 ? await nextFrame() : -1
          mo.disconnect()
          for (const n of notes) window.__midi.off(n)
          if (hit >= 0) {
            dom.push(hit - t0)
            frame.push(presented - t0)
          }
          await wait(300)
        }
        return { dom, frame }
      })
      const lat = results['midiLatency'] as { dom: number[]; frame: number[] }
      results['midiLatency'] = { dom: dist(lat.dom), nextFrame: dist(lat.frame) }

      // Fast playing: 8 groups per second.
      results['practiceFast'] = await measure(page, browser, cdp, 'practice-fast', 0, async () => {
        await page.evaluate(async () => {
          const groups = window.__groups!
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
          for (let i = 30; i < 30 + 80 && i < groups.length; i++) {
            const notes = groups[i]!
            for (const n of notes) window.__midi.on(n)
            await wait(60)
            for (const n of notes) window.__midi.off(n)
            await wait(65)
          }
        })
      })

      // Wrong-note flash: five wrong keys 700 ms apart (vignette, chip, strip marker).
      results['wrongFlash'] = await measure(page, browser, cdp, 'wrong-flash', 0, async () => {
        await page.evaluate(async () => {
          const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
          for (let i = 0; i < 5; i++) {
            window.__midi.on(22)
            await wait(80)
            window.__midi.off(22)
            await wait(620)
          }
        })
      })
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
    })

  // ── Memory after traversing the whole strip ─────────────────────────────────────────────
  if (STEPS.has('traversal'))
    await test.step('memory traversal', async () => {
      results['traversal'] = await page.evaluate(async () => {
        const slider = document.querySelector('[role="slider"][aria-label="Piece overview"]') as HTMLElement
        const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)))
        let maxSegs = 0
        let maxNodes = 0
        const t0 = performance.now()
        slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        for (let i = 0; i < 520; i++) {
          slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
          await nextFrame()
          await nextFrame()
          maxSegs = Math.max(maxSegs, document.querySelectorAll('.pn-seg').length)
          if (i % 20 === 0) maxNodes = Math.max(maxNodes, document.getElementsByTagName('*').length)
        }
        return {
          ms: Math.round(performance.now() - t0),
          maxMountedSegments: maxSegs,
          maxDomNodes: maxNodes,
          endBar: slider.getAttribute('aria-valuenow'),
        }
      })
      results['heapAfterTraversal'] = await heap(cdp)
    })

  // ── Normal-size fixture and the reference piece ──────────────────────────────────────────────────
  if (STEPS.has('fixtures'))
    await test.step('normal fixtures', async () => {
      await page.getByRole('button', { name: 'Back to Library' }).click()
      const normal = await importThroughUi(page, 'ds-al-coda.musicxml', readFileSync(NORMAL, 'utf8'))
      const title = String(normal['title'])
      results['normal'] = {
        file: 'ds-al-coda.musicxml',
        title,
        import: normal,
        prepare: await prepareColdWarm(page, title),
      }
      await page.getByRole('button', { name: 'Back to Library' }).click()
      if (existsSync(REFERENCE_PIECE)) {
        const reference = await importThroughUi(page, 'reference-piece.musicxml', readFileSync(REFERENCE_PIECE, 'utf8'))
        const mt = String(reference['title'])
        results['reference'] = { title: mt, import: reference, prepare: await prepareColdWarm(page, mt) }
        // Listen on the reference piece too: a real score's density.
        await setHands(page, false)
        ;(results['reference'] as Json)['listen'] = await measure(
          page,
          browser,
          cdp,
          'reference-listen',
          LISTEN_MS / 2,
          async () => {
            await page.getByRole('button', { name: 'Listen', exact: true }).click()
          },
        )
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
      } else {
        results['reference'] = 'skipped (private fixture absent)'
      }
    })

  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, `${LABEL}-${browserName}.json`)
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`\nperf results: ${file}\n${summaryTable(results)}`)
})

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/** Both hand toggles on (practice both hands) or off (Listen, U9). */
async function setHands(page: Page, on: boolean): Promise<void> {
  for (const name of ['Left hand', 'Right hand']) {
    const toggle = page.getByRole('button', { name, exact: true })
    if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  }
}

async function heap(cdp: CDPSession | null): Promise<Json | null> {
  if (!cdp) return null
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return {
    jsHeapUsedMB: Math.round(((m['JSHeapUsedSize'] ?? 0) / 1048576) * 10) / 10,
    jsHeapTotalMB: Math.round(((m['JSHeapTotalSize'] ?? 0) / 1048576) * 10) / 10,
    nodes: m['Nodes'],
    documents: m['Documents'],
  }
}

/** Picks a file in the Library's real input (in page), times summary and stored. */
async function importThroughUi(page: Page, name: string, xml: string): Promise<Json> {
  await page.locator('label', { hasText: 'Import MusicXML' }).first().waitFor()
  const out = await page.evaluate(
    async ({ name, xml }) => {
      const input = [...document.querySelectorAll('label')]
        .find((l) => /Import MusicXML/.test(l.textContent ?? ''))!
        .querySelector('input[type="file"]') as HTMLInputElement
      const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)))
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = performance.now()
        while (!cond()) {
          if (performance.now() - t0 > ms) throw new Error('timeout')
          await nextFrame()
        }
        return performance.now()
      }
      const addButton = () =>
        [...document.querySelectorAll('dialog[open] button')].find((b) =>
          /Add to library/.test(b.textContent ?? ''),
        ) as HTMLButtonElement | undefined
      const dt = new DataTransfer()
      dt.items.add(new File([xml], name, { type: 'application/xml' }))
      window.__perf.startFrames()
      const t0 = performance.now()
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      const summary = await until(() => !!addButton(), 120_000)
      const frames = window.__perf.stopFrames()
      const lt = window.__perf.longTasksSince(t0)
      return {
        bytes: xml.length,
        toSummaryMs: Math.round(summary - t0),
        maxFrameGapMs: Math.round(Math.max(0, ...frames)),
        longTasks: lt.length,
        longTaskMs: Math.round(lt.reduce((a, l) => a + l.duration, 0)),
      }
    },
    { name, xml },
  )
  const dialog = page.locator('dialog[open]')
  const add = dialog.getByRole('button', { name: 'Add to library' })
  // Ambiguous hands (L1): keep the proposed hands and confirm them.
  if (await add.isDisabled()) await dialog.getByRole('button', { name: 'Confirm hands' }).click()
  await expect(add).toBeEnabled()
  const handle = await add.elementHandle()
  const second = await page.evaluate(
    async (button) => {
      const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)))
      // Saving closes the sheet, shows a notice and opens Practice (library workflow, U-series).
      const text = () => document.body.textContent ?? ''
      window.__perf.startFrames()
      const t0 = performance.now()
      button.click()
      while (!/is in your library/.test(text())) {
        if (performance.now() - t0 > 120_000) throw new Error('import store timeout')
        await nextFrame()
      }
      const stored = performance.now()
      const frames = window.__perf.stopFrames()
      const lt = window.__perf.longTasksSince(t0)
      return {
        title: /“(.*)” is in your library/.exec(text())?.[1] ?? '',
        toStoredMs: Math.round(stored - t0),
        storeMaxFrameGapMs: Math.round(Math.max(0, ...frames)),
        storeLongTaskMs: Math.round(lt.reduce((a, l) => a + l.duration, 0)),
      }
    },
    handle as unknown as HTMLButtonElement,
  )
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  // Saving opens Practice; the walk measures Practice openings itself, so return to the list.
  await page.getByRole('button', { name: 'Back to Library' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  return { ...out, ...second }
}

/** Opens Practice from the Library twice: cold (no layout cache) and warm (IndexedDB layout cache). */
async function prepareColdWarm(page: Page, title: string): Promise<Json> {
  await clearLayoutCache(page)
  const cold = await openPractice(page, title)
  await page.getByRole('button', { name: 'Back to Library' }).click()
  const warm = await openPractice(page, title)
  // A reload straight into Practice (app boot + cached layout).
  const t0 = Date.now()
  await page.reload()
  await waitStrip(page)
  const reload = Date.now() - t0
  return { cold, warm, reloadIntoPracticeMs: reload }
}

async function openPractice(page: Page, title: string): Promise<Json> {
  const handle = await page.getByRole('button', { name: `Practice ${title}`, exact: true }).elementHandle()
  const out = await page.evaluate(
    async (button) => {
      const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)))
      window.__perf.startFrames()
      const t0 = performance.now()
      button.click()
      let shown = 0
      for (;;) {
        await nextFrame()
        if (!shown && document.querySelector('.pn-strip')) shown = performance.now()
        const preparing = [...document.querySelectorAll('[role="status"]')].some((e) =>
          /Preparing the score/.test(e.textContent ?? ''),
        )
        if (shown && !preparing && document.querySelector('.pn-seg')) break
        if (performance.now() - t0 > 180_000) throw new Error('prepare timeout')
      }
      const t1 = performance.now()
      // Let the first frames settle (segments beyond the viewport mount one per frame).
      for (let i = 0; i < 30; i++) await nextFrame()
      const frames = window.__perf.stopFrames()
      const lt = window.__perf.longTasksSince(t0)
      return {
        toStripMs: Math.round(t1 - t0),
        maxFrameGapMs: Math.round(Math.max(0, ...frames)),
        longTasks: lt.length,
        longTaskMs: Math.round(lt.reduce((a, l) => a + l.duration, 0)),
        maxLongTaskMs: Math.round(Math.max(0, ...lt.map((l) => l.duration))),
      }
    },
    handle as unknown as HTMLButtonElement,
  )
  return out
}

async function waitStrip(page: Page): Promise<void> {
  await expect(page.locator('.pn-seg').first()).toBeAttached({ timeout: 180_000 })
  await expect(page.getByText(/Preparing the score/)).toHaveCount(0, { timeout: 180_000 })
}

async function clearLayoutCache(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pianissimo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stores = [...db.objectStoreNames].filter((n) => /layout/i.test(n))
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite')
      for (const s of stores) tx.objectStore(s).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
}

/** Remembered route to the fake MIDI ports (verified, echo-free output), so Auto sound uses MIDI. */
async function seedRoute(page: Page): Promise<void> {
  await page.evaluate(
    async (defaults) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('pianissimo')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const current = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const req = db.transaction('settings', 'readonly').objectStore('settings').get('app')
        req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined)
        req.onerror = () => reject(req.error)
      })
      const settings = current ?? defaults
      const route = {
        ...(settings['route'] as object),
        inputId: 'fake-in',
        inputName: 'Fake Piano',
        outputId: 'fake-out',
        outputName: 'Fake Piano',
        outputVerified: true,
        echo: 'none',
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite')
        tx.objectStore('settings').put({ ...settings, route }, 'app')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()
    },
    JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>,
  )
}

/** The learner onset groups (both hands, from bar 1) from the stored package. */
async function loadGroups(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const id = decodeURIComponent(location.hash.split('/')[2] ?? '')
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pianissimo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const get = <T>(store: string, key: string) =>
      new Promise<T>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key)
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      })
    const piece = await get<{ scoreVersionId: string }>('pieces', id)
    const pkg = await get<{
      model: {
        notes: { onset: { n: number; d: number }; midi: number; grace: boolean; tieContinuation: boolean }[]
      }
    }>('packages', piece.scoreVersionId)
    db.close()
    const groups = new Map<number, Set<number>>()
    for (const n of pkg.model.notes) {
      if (n.grace || n.tieContinuation) continue
      const at = n.onset.n / n.onset.d
      let g = groups.get(at)
      if (!g) groups.set(at, (g = new Set()))
      g.add(n.midi)
    }
    window.__groups = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => [...s])
  })
}

/**
 * Runs `action`, then samples for `ms` (or until the action resolves when ms is 0): frame times,
 * long tasks, Preact renders and, on Chromium, a trace for the main-thread split.
 */
async function measure(
  page: Page,
  browser: Browser,
  cdp: CDPSession | null,
  name: string,
  ms: number,
  action: () => Promise<void>,
): Promise<Json> {
  const tracing = cdp !== null
  const profiling = cdp !== null && PROFILE
  if (profiling) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await cdp.send('Profiler.start')
  }
  if (tracing) {
    await browser.startTracing(page, {
      categories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'toplevel',
        'v8',
        'blink',
        // e.g. PERF_TRACE_EXTRA=disabled-by-default-devtools.timeline.invalidationTracking
        ...(process.env['PERF_TRACE_EXTRA']?.split(',') ?? []),
      ],
    })
  }
  const since = await page.evaluate(() => {
    window.__pnProbe?.reset()
    window.__perf.startFrames()
    return performance.now()
  })
  const wall0 = Date.now()
  await action()
  if (ms > 0) await page.waitForTimeout(ms)
  const wall = Date.now() - wall0
  const sample = await page.evaluate((since) => {
    const frames = window.__perf.stopFrames()
    const lt = window.__perf.longTasksSince(since)
    return {
      frames,
      longTasks: lt.length,
      longTaskMs: Math.round(lt.reduce((a, l) => a + l.duration, 0)),
      maxLongTaskMs: Math.round(Math.max(0, ...lt.map((l) => l.duration))),
      renders: { ...(window.__pnProbe?.renders ?? {}) },
      mountedSegments: document.querySelectorAll('.pn-seg').length,
    }
  }, since)
  let profileTop: string[] | null = null
  if (profiling) profileTop = topSelf((await cdp.send('Profiler.stop')).profile, 30)
  let split: TraceSplit | null = null
  if (tracing) {
    const buf = await browser.stopTracing()
    if (KEEP_TRACE) {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, `${LABEL}-${name}.trace.json`), buf)
    }
    split = traceSplit(buf.toString('utf8'))
  }
  const nFrames = sample.frames.length
  const renderTotal = Object.values(sample.renders).reduce((a, b) => a + b, 0)
  const topRenders = Object.entries(sample.renders)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}:${v}`)
  return {
    wallMs: wall,
    frames: frameStats(sample.frames),
    longTasks: sample.longTasks,
    longTaskMs: sample.longTaskMs,
    maxLongTaskMs: sample.maxLongTaskMs,
    rendersPerFrame: Math.round((renderTotal / Math.max(1, nFrames)) * 100) / 100,
    renders: topRenders,
    mountedSegments: sample.mountedSegments,
    ...(split ? { mainThread: split, mainThreadPerFrame: perFrame(split, nFrames) } : {}),
    ...(profileTop ? { profileTop } : {}),
  }
}

function summaryTable(r: Json): string {
  const g = (path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Json | null)?.[k], r)
  const rows: [string, unknown][] = [
    ['load: library ready ms', g('load.libraryReady')],
    ['load: JS / CSS encoded bytes', `${g('load.jsEncoded')} / ${g('load.cssEncoded')}`],
    ['import500: summary / stored ms', `${g('import500.toSummaryMs')} / ${g('import500.toStoredMs')}`],
    ['import500: max frame gap ms', g('import500.maxFrameGapMs')],
    ['prepare500 cold / warm ms', `${g('prepare500.cold.toStripMs')} / ${g('prepare500.warm.toStripMs')}`],
    ['prepare500 warm max long task', g('prepare500.warm.maxLongTaskMs')],
    ['listen frames p50/p95/p99', fr(g('listen.frames'))],
    ['listen frames >20ms', `${(g('listen.frames') as Json | undefined)?.['over20']}`],
    ['listen main ms/frame', (g('listen.mainThreadPerFrame') as Json | undefined)?.['total']],
    ['listen renders/frame', g('listen.rendersPerFrame')],
    ['listen+guide main ms/frame', (g('listenGuide.mainThreadPerFrame') as Json | undefined)?.['total']],
    ['listen+guide frames p95 / >20', `${fr(g('listenGuide.frames'))}`],
    ['listen+labels main ms/frame', (g('listenLabels.mainThreadPerFrame') as Json | undefined)?.['total']],
    ['MIDI→DOM p50/p95 ms', `${g('midiLatency.dom.p50')} / ${g('midiLatency.dom.p95')}`],
    ['MIDI→next frame p50/p95 ms', `${g('midiLatency.nextFrame.p50')} / ${g('midiLatency.nextFrame.p95')}`],
    ['practice 8/s frames p50/p95/p99', fr(g('practiceFast.frames'))],
    ['wrong flash frames p50/p95/p99', fr(g('wrongFlash.frames'))],
    ['traversal max mounted segs', g('traversal.maxMountedSegments')],
    ['heap after traversal MB', (g('heapAfterTraversal') as Json | null)?.['jsHeapUsedMB']],
  ]
  return rows.map(([k, v]) => `${k.padEnd(34)} ${String(v)}`).join('\n')
}

function fr(f: unknown): string {
  const x = f as Json | undefined
  return x ? `${x['p50']}/${x['p95']}/${x['p99']} (>20: ${x['over20']}, n=${x['n']})` : '-'
}
