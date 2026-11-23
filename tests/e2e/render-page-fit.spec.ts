/**
 * The portrait page on a tablet (PageView `fitWidth`): the whole system is always visible and the
 * page never scrolls sideways, whatever the zoom, the layout or the host's width; and a scroll
 * the learner drives is left to the browser (no script writes to the scroll position until it
 * settles, which is what keeps iOS momentum and rubber-banding alive; desktop browsers have no
 * iOS momentum, so the invariant is what is checked here, the glide itself only on the device).
 */
import { expect, test, type Page } from '../browser-test'
import { openHarness } from './render-helpers'

const TABLET = { width: 834, height: 1194 }
/** The harness host inside the tablet viewport (the page body keeps its 8 px margin). */
const HOST = { width: 818, height: 1100 }
/** `pageWidthFor(818, 1)` and `pageWidthFor(818, 2.5)`. */
const PAGE_WIDTH = 784
const PAGE_WIDTH_MAX_ZOOM = 312

interface Sample {
  when: string
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
}

interface SystemSpan {
  when: string
  first: number
  last: number
  width: number
}

/** Prepares `long-40` as a page `pageWidth` wide (capped there unless `uncapped`) and mounts it fitted. */
async function mountFitted(page: Page, pageWidth: number, opts: { uncapped?: boolean; initialZoom?: number } = {}) {
  await page.evaluate(
    async ({ pageWidth, host, uncapped, initialZoom }) => {
      await window.harness.prepare('long-40', 3, {
        mode: 'page',
        pageWidth,
        ...(uncapped ? {} : { pageMaxWidth: pageWidth }),
      })
      window.harness.mount(host, { fitWidth: true, ...(initialZoom ? { initialZoom } : {}) })
      window.harness.showAllLabels()
    },
    { pageWidth, host: HOST, uncapped: !!opts.uncapped, initialZoom: opts.initialZoom ?? 0 },
  )
}

test.describe('a tablet page never scrolls sideways', () => {
  test.use({ viewport: TABLET, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await openHarness(page)
  })

  test('the system stays whole and in view through max zoom, a ctrl-wheel zoom, a resize and wide layouts', async ({
    page,
  }) => {
    await mountFitted(page, PAGE_WIDTH)
    // The probes live in the page: every sampled frame, and the current system's first and last notes.
    await page.evaluate(() => {
      const w = window as unknown as {
        probe: {
          samples: Sample[]
          spans: SystemSpan[]
          sample(when: string): void
          frames(when: string, n?: number): Promise<void>
          span(when: string): void
        }
      }
      const scroller = () => document.querySelector<HTMLElement>('.pn-page-scroll')!
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
      w.probe = {
        samples: [],
        spans: [],
        sample(when) {
          const sc = scroller()
          this.samples.push({
            when,
            scrollWidth: sc.scrollWidth,
            clientWidth: sc.clientWidth,
            scrollLeft: sc.scrollLeft,
          })
        },
        async frames(when, n = 20) {
          for (let i = 0; i < n; i++) {
            await frame()
            this.sample(when)
          }
        },
        span(when) {
          const layout = window.harness.layout()!
          const view = window.harness.strip() as unknown as { currentSystem(): number }
          const system = view.currentSystem()
          const notes = layout.notes.filter((n): n is NonNullable<typeof n> => n?.system === system)
          const xs = notes.map((n) => n.head.x)
          const first = notes[xs.indexOf(Math.min(...xs))]!
          const last = notes[xs.indexOf(Math.max(...xs))]!
          const box = scroller().getBoundingClientRect()
          const rect = (index: number) =>
            document.querySelector(`.pn-page-content [data-n~="${index}"]`)!.getBoundingClientRect()
          this.spans.push({
            when,
            first: rect(first.index).left - box.left,
            last: rect(last.index).right - box.left,
            width: box.width,
          })
        },
      }
    })

    const run = (when: string, act: string) =>
      page.evaluate(
        async ({ when, act }) => {
          const w = window as unknown as {
            probe: { sample(when: string): void; frames(when: string): Promise<void>; span(when: string): void }
          }
          const view = window.harness.strip()!
          const sc = document.querySelector<HTMLElement>('.pn-page-scroll')!
          const host = document.getElementById('strip-host')!
          const occs = window.harness.layout()!.occurrences
          const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
          // A loop over the last bar of a system puts its end handle at the page's right edge.
          const lastOfSystem = occs.find((o, i) => occs[i + 1]?.system !== o.system)!
          view.setLoopEditable(true)
          view.setLoop({ fromOcc: lastOfSystem.occ, toOcc: lastOfSystem.occ })
          view.setCursor(occs[Math.floor(occs.length / 3)]!.start, { smooth: false })
          if (act === 'zoom') view.setZoom(2.5)
          if (act === 'wheel') {
            const box = sc.getBoundingClientRect()
            for (let i = 0; i < 3; i++) {
              sc.dispatchEvent(
                new WheelEvent('wheel', {
                  deltaY: -120,
                  ctrlKey: true,
                  clientX: box.left + box.width / 2,
                  clientY: box.top + box.height / 3,
                  bubbles: true,
                  cancelable: true,
                }),
              )
              w.probe.sample(when)
              await frame()
            }
          }
          if (act === 'narrow' || act === 'widen') {
            // Resize within a frame and measure at once: the frame the browser paints next.
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => {
                host.style.width = act === 'narrow' ? '520px' : '818px'
                w.probe.sample(when)
                resolve()
              }),
            )
          }
          w.probe.sample(when)
          await w.probe.frames(when)
          view.flushNow()
          w.probe.span(when)
        },
        { when, act },
      )

    await run('at rest', 'none')
    await run('max zoom (a narrower page pending)', 'zoom')
    await run('ctrl-wheel zoom', 'wheel')
    await run('narrower host (split screen)', 'narrow')
    await run('wider host again', 'widen')
    // The page the max zoom asks for, and a layout wider than the page it was asked for.
    await mountFitted(page, PAGE_WIDTH_MAX_ZOOM, { initialZoom: 2.5 })
    await run('engraved for the max zoom', 'none')
    await mountFitted(page, 1200, { uncapped: true })
    await run('a layout wider than asked', 'none')

    const { samples, spans } = await page.evaluate(() => {
      const w = window as unknown as { probe: { samples: Sample[]; spans: SystemSpan[] } }
      return { samples: w.probe.samples, spans: w.probe.spans }
    })
    expect(samples.length).toBeGreaterThan(150)
    for (const s of samples) {
      expect(s.scrollWidth, s.when).toBeLessThanOrEqual(s.clientWidth)
      expect(s.scrollLeft, s.when).toBe(0)
    }
    expect(spans).toHaveLength(7)
    for (const s of spans) {
      expect(s.first, s.when).toBeGreaterThanOrEqual(0)
      expect(s.last, s.when).toBeLessThanOrEqual(s.width)
    }
  })
})

test.describe('a scroll the learner drives is left to the browser', () => {
  test.use({ viewport: TABLET, hasTouch: true })

  test('no script writes the scroll position during a touch fling, a wheel fling or a sideways swipe', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'real scroll gestures come from Chromium’s DevTools protocol')
    await openHarness(page)
    await mountFitted(page, PAGE_WIDTH)
    await page.evaluate(() => {
      const view = window.harness.strip()!
      view.setBrowseEnabled(true)
      view.flushNow()
      const sc = document.querySelector<HTMLElement>('.pn-page-scroll')!
      interface Spy {
        writes: string[]
        recording: boolean
        ended: number
        playing: boolean
      }
      const spy: Spy = { writes: [], recording: false, ended: 0, playing: true }
      ;(window as unknown as { spy: Spy }).spy = spy
      for (const key of ['scrollTop', 'scrollLeft'] as const) {
        const d = Object.getOwnPropertyDescriptor(Element.prototype, key)!
        Object.defineProperty(sc, key, {
          configurable: true,
          get: () => d.get!.call(sc),
          set: (v: number) => {
            if (spy.recording) spy.writes.push(`${key}=${v}`)
            d.set!.call(sc, v)
          },
        })
      }
      for (const key of ['scrollTo', 'scrollBy'] as const) {
        const original = sc[key].bind(sc) as (...args: unknown[]) => void
        Object.defineProperty(sc, key, {
          configurable: true,
          value: (...args: unknown[]) => {
            if (spy.recording) spy.writes.push(key)
            original(...args)
          },
        })
      }
      // The gesture starts at its first input event (before the view sees it).
      for (const type of ['touchstart', 'wheel'] as const) {
        sc.addEventListener(type, () => (spy.recording = true), { capture: true, passive: true })
      }
      sc.addEventListener('scrollend', () => spy.ended++)
      // Playback seeks to another system every frame meanwhile, so the follow always has a
      // scroll to make (until browsing stops it).
      const occs = window.harness.layout()!.occurrences
      const openings = occs.filter((o, i) => i === 0 || occs[i - 1]!.system !== o.system)
      let i = 0
      const step = () => {
        if (!spy.playing) return
        i = (i + 1) % openings.length
        view.setCursor(openings[i]!.start, { smooth: false })
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    const cdp = await page.context().newCDPSession(page)

    /** Runs a gesture; a scroll is recorded until it (fling included) has ended, a swipe that scrolls nothing for 1 s. */
    const gesture = async (params: Record<string, unknown>, scrolls = true) => {
      await page.evaluate(() => {
        const w = window as unknown as { spy: { writes: string[]; ended: number } }
        w.spy.writes.length = 0
        w.spy.ended = 0
      })
      const before = await page.evaluate(() => document.querySelector('.pn-page-scroll')!.scrollTop)
      await cdp.send('Input.synthesizeScrollGesture', { x: 400, y: 800, speed: 2400, ...params })
      if (scrolls) await page.waitForFunction(() => (window as unknown as { spy: { ended: number } }).spy.ended > 0)
      else await page.waitForTimeout(1000)
      return page.evaluate((before) => {
        const w = window as unknown as { spy: { writes: string[]; recording: boolean } }
        w.spy.recording = false
        const sc = document.querySelector('.pn-page-scroll')!
        return { writes: [...w.spy.writes], moved: sc.scrollTop - before, left: sc.scrollLeft }
      }, before)
    }

    // A slow start (the finger is down for a few frames before the scroll begins), then a fling.
    const fling = await gesture({ yDistance: -500, speed: 1200, gestureSourceType: 'touch', preventFling: false })
    expect(fling.writes).toEqual([])
    expect(fling.moved).toBeGreaterThan(200)
    expect(fling.left).toBe(0)

    const wheel = await gesture({ yDistance: -600, gestureSourceType: 'mouse' })
    expect(wheel.writes).toEqual([])
    expect(wheel.moved).toBeGreaterThan(200)

    // Sideways there is nothing to scroll (the page is fitted): no scroll, so no `scrollend`.
    const sideways = await gesture(
      { xDistance: -400, yDistance: -40, gestureSourceType: 'touch', preventFling: false },
      false,
    )
    expect(sideways.writes).toEqual([])
    expect(sideways.left).toBe(0)

    // Once settled, the page follows again when asked: "Return to current position" scrolls.
    const returned = await page.evaluate(async () => {
      const w = window as unknown as { spy: { writes: string[]; recording: boolean; playing: boolean } }
      w.spy.playing = false
      w.spy.writes.length = 0
      w.spy.recording = true
      const view = window.harness.strip()!
      const browsing = view.isBrowsing()
      view.returnToCurrent()
      view.flushNow()
      w.spy.recording = false
      return { browsing, writes: w.spy.writes }
    })
    expect(returned.browsing).toBe(true)
    expect(returned.writes.some((x) => x.startsWith('scrollTop'))).toBe(true)
  })
})
