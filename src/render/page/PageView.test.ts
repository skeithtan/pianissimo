// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rat } from '../../core/music/rational'
import {
  PREPARED_LAYOUT_FORMAT,
  type LabelBox,
  type NoteGeometry,
  type OccurrenceGeometry,
  type PreparedLayout,
  type SegmentData,
  type SystemGeometry,
} from '../types'
import { PAGE_CURSOR_MARGIN, PageGeometry, pageWidthFor } from './geometry'
import { PAGE_PAD_TOP, PageView, type PageOptions } from './PageView'

const MEASURE = 180
const PER_SYSTEM = 4
const SYSTEM_H = 260
const GAP = 40

/**
 * A synthetic page layout: `n` bars of 180 px, four per system, systems 300 px apart, two notes
 * per bar (one per staff), every system one segment. Bar `o` starts at whole note `o`.
 */
export function testPageLayout(n: number): PreparedLayout {
  const occurrences: OccurrenceGeometry[] = []
  const notes: NoteGeometry[] = []
  const labels: LabelBox[] = []
  const systems: SystemGeometry[] = []
  const segments: SegmentData[] = []
  const count = Math.ceil(n / PER_SYSTEM)
  for (let k = 0; k < count; k++) {
    const y0 = k * (SYSTEM_H + GAP)
    const staves = [
      { index: 0, top: y0 + 60, bottom: y0 + 100 },
      { index: 1, top: y0 + 160, bottom: y0 + 200 },
    ]
    const occStart = k * PER_SYSTEM
    const occEnd = Math.min(n, occStart + PER_SYSTEM)
    systems.push({ index: k, occStart, occEnd, y0, y1: y0 + SYSTEM_H, staves })
    let body = ''
    for (let o = occStart; o < occEnd; o++) {
      const x0 = 10 + (o - occStart) * MEASURE
      occurrences.push({
        occ: o,
        x0,
        x1: x0 + MEASURE,
        start: o,
        duration: 1,
        anchors: [
          [0, x0 + 40],
          [0.5, x0 + 110],
          [1, x0 + MEASURE],
        ],
        label: String(o + 1),
        labelBox: { x: x0 + 2, y: y0 + 41, w: 10, h: 13 },
        system: k,
      })
      for (const staff of [0, 1]) {
        const index = notes.length
        const head = { x: x0 + 34, y: staves[staff]!.top + 15, w: 12, h: 10 }
        notes.push({
          index,
          occ: o,
          staff,
          hand: staff === 0 ? 'R' : 'L',
          head,
          x: x0 + 40,
          label: index,
          graphic: `g${index}`,
          system: k,
        })
        labels.push({
          id: index,
          notes: [index],
          occ: o,
          staff,
          hand: staff === 0 ? 'R' : 'L',
          box: { x: head.x + 14, y: head.y - 2, w: 25, h: 14 },
          tx: head.x + 15,
          ty: head.y + 9,
          anchor: 'start',
          placement: 'right',
        })
        body += `<g class="vf-stavenote" data-h="${staff === 0 ? 'R' : 'L'}"><g class="vf-notehead" data-n="${index}"><path d="M${head.x} ${head.y}h12v10h-12z"></path></g></g>`
      }
    }
    segments.push({
      index: k,
      occStart,
      occEnd,
      x0: 0,
      x1: 740,
      y0,
      y1: y0 + SYSTEM_H,
      system: k,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" class="pn-music" viewBox="-1 ${y0} 742 ${SYSTEM_H}" width="742" height="${SYSTEM_H}"><g transform="translate(0 0)">${body}</g></svg>`,
      labelStart: occStart * 2,
      labelEnd: occEnd * 2,
    })
  }
  return {
    format: PREPARED_LAYOUT_FORMAT,
    key: 'page',
    scoreVersionId: 'v',
    renderer: { name: 'test', version: '1' },
    params: {
      labelChars: 3,
      labelFontPx: 12,
      labelW: 25,
      labelH: 14,
      segmentWidth: 1600,
      spacing: { voiceSpacingMultiplier: 1.4, voiceSpacingAddend: 3 },
      iterations: 1,
      pageWidth: 740,
    },
    width: 740,
    top: 0,
    height: systems.at(-1)!.y1,
    staves: systems[0]!.staves,
    occurrences,
    notes,
    labels,
    ottavas: [],
    contexts: [],
    contextChanges: [],
    segments,
    report: {
      modelNotes: notes.length,
      graphicalNotes: notes.length,
      mapped: notes.length,
      unmappedNotes: [],
      unmappedGraphics: [],
      relaxedMatches: 0,
      sharedHeads: 0,
      ottavasMapped: 0,
      ottavasUnmapped: [],
    },
    stats: {
      loadMs: 0,
      engraveMs: 0,
      extractMs: 0,
      labelMs: 0,
      partitionMs: 0,
      totalMs: 0,
      svgNodes: 0,
      segmentBytes: 0,
      labelFailuresPerIteration: [0],
      placements: { right: 0, stagger: 0, left: 0, stack: 0, callout: 0 },
    },
    mode: 'page',
    systems,
  }
}

const VIEW_W = 772
const VIEW_H = 600

let host: HTMLElement
let views: PageView[] = []

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: VIEW_W,
    height: VIEW_H,
    right: VIEW_W,
    bottom: VIEW_H,
    toJSON: () => ({}),
  } as DOMRect)
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  for (const v of views) v.destroy()
  views = []
  host.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function view(n = 24, opts: PageOptions = {}): { v: PageView; layout: PreparedLayout; root: HTMLElement } {
  const layout = testPageLayout(n)
  const v = new PageView(host, layout, opts)
  views.push(v)
  v.flushNow()
  return { v, layout, root: host.querySelector('.pn-page') as HTMLElement }
}

const cursorXY = (root: HTMLElement): [number, number] => {
  const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(
    root.querySelector<HTMLElement>('.pn-cursor')!.style.transform,
  )
  return [Number(m?.[1]), Number(m?.[2])]
}
const scroller = (root: HTMLElement) => root.querySelector<HTMLElement>('.pn-page-scroll')!
// The page (740 px) is centered in the 772 px view: a 16 px gutter.
const GX = 16

describe('page geometry', () => {
  it('maps positions to systems and cursor x along each system', () => {
    const g = new PageGeometry(testPageLayout(12))
    expect(g.systemAt(0)).toBe(0)
    expect(g.systemAt(3.9)).toBe(0)
    expect(g.systemAt(4)).toBe(1)
    expect(g.cursorAt(0)).toEqual({ system: 0, x: 50 })
    expect(g.cursorAt(4)).toEqual({ system: 1, x: 50 })
    // The last bar of a system glides to its final barline, never back across the page.
    expect(g.cursorAt(3.99, false).x).toBeGreaterThan(g.cursorAt(3.5, false).x)
    expect(g.occAtPoint(200, 380)).toBe(5)
    expect(g.systemAtY(275)).toBe(0)
    expect(g.systemAtY(290)).toBe(1)
  })

  it('gives the cursor bar a small margin past its staves, less toward a close neighbor (U73)', () => {
    const layout = testPageLayout(12)
    const g = new PageGeometry(layout)
    // Staves 160 px apart between systems: the full margin at both ends, at any system.
    for (const k of [0, 1, 2])
      expect(g.cursorMargins(k, 1)).toEqual({ top: PAGE_CURSOR_MARGIN, bottom: PAGE_CURSOR_MARGIN })
    // Systems packed 30 px apart: the bar stops a third of the way into the gap on that side only.
    const tight = new PageGeometry({
      ...layout,
      systems: layout.systems!.map((sys, k) => ({
        ...sys,
        staves: sys.staves.map((st) => ({ ...st, top: st.top - k * 130, bottom: st.bottom - k * 130 })),
      })),
    })
    expect(tight.cursorMargins(0, 1)).toEqual({ top: PAGE_CURSOR_MARGIN, bottom: 10 })
    expect(tight.cursorMargins(1, 1)).toEqual({ top: 10, bottom: 10 })
    expect(tight.cursorMargins(2, 1)).toEqual({ top: 10, bottom: PAGE_CURSOR_MARGIN })
    // The gap is in layout px: zoomed out, the cap shrinks with it.
    expect(tight.cursorMargins(1, 0.6)).toEqual({ top: 6, bottom: 6 })
    // Overlapping staves (never engraved, but never a negative margin).
    const overlapping = new PageGeometry({
      ...layout,
      systems: layout.systems!.map((sys, k) => ({
        ...sys,
        staves: sys.staves.map((st) => ({ ...st, top: st.top - k * 200, bottom: st.bottom - k * 200 })),
      })),
    })
    expect(overlapping.cursorMargins(1, 1)).toEqual({ top: 0, bottom: 0 })
  })

  it('splits a loop band across the systems it crosses', () => {
    const g = new PageGeometry(testPageLayout(12))
    expect(g.loopBands({ fromOcc: 2, toOcc: 9 })).toEqual([
      { system: 0, x0: 370, x1: 730 },
      { system: 1, x0: 10, x1: 730 },
      { system: 2, x0: 10, x1: 370 },
    ])
    // A note-level start edge sits between the previous entry and the note.
    const [band] = g.loopBands({ fromOcc: 1, toOcc: 1, start: rat(3, 2) })
    expect(band).toEqual({ system: 0, x0: (230 + 300) / 2, x1: 370 })
  })

  it('computes the follow scroll and the page width for a zoom', () => {
    const g = new PageGeometry(testPageLayout(24))
    expect(g.followScroll(0, { scale: 1, padTop: 16, viewport: 600, max: 5000 })).toBe(0)
    expect(g.followScroll(3, { scale: 1, padTop: 16, viewport: 600, max: 5000 })).toBe(900 + 16 - 150)
    expect(g.followScroll(5, { scale: 1, padTop: 16, viewport: 600, max: 1000 })).toBe(1000)
    expect(pageWidthFor(820, 1)).toBe(792)
    expect(pageWidthFor(820, 2)).toBe(392)
  })
})

describe('PageView', () => {
  it('mounts the systems around the viewport only', () => {
    const { v } = view(48)
    const s = v.stats()
    expect(s.segments).toBe(12)
    expect(s.mountedSegments).toBeGreaterThan(0)
    expect(s.mountedSegments).toBeLessThan(12)
  })

  it('moves the cursor within the first system without scrolling the page', () => {
    const { v, root } = view()
    const [x0, y0] = cursorXY(root)
    expect(x0).toBe(GX + 50)
    // Staves 60–200 plus the small margin at each end: a plain bar on its own system (U73).
    expect(y0).toBe(PAGE_PAD_TOP + 60 - PAGE_CURSOR_MARGIN)
    expect(root.querySelector<HTMLElement>('.pn-cursor')!.style.height).toBe(`${140 + 2 * PAGE_CURSOR_MARGIN}px`)
    // It ends well short of the next system's staves (360–500).
    expect(y0 - PAGE_PAD_TOP + 140 + 2 * PAGE_CURSOR_MARGIN).toBeLessThan(360 - PAGE_CURSOR_MARGIN)
    for (const p of [0.1, 0.5, 1.2, 2.5]) {
      v.setCursor(p, { smooth: false })
      v.flushNow()
    }
    const [x1, y1] = cursorXY(root)
    expect(x1).toBeGreaterThan(x0)
    expect(y1).toBe(y0)
    expect(scroller(root).scrollTop).toBe(0)
  })

  it('jumps to the next system and scrolls it to a quarter of the viewport', () => {
    const { v, root } = view()
    v.setCursor(9)
    v.flushNow()
    expect(v.currentSystem()).toBe(2)
    const [x, y] = cursorXY(root)
    expect(x).toBe(GX + 230)
    expect(y).toBe(PAGE_PAD_TOP + 600 + 60 - PAGE_CURSOR_MARGIN)
    expect(scroller(root).scrollTop).toBe(PAGE_PAD_TOP + 600 - VIEW_H / 4)
    expect(root.classList.contains('pn-instant')).toBe(true)
  })

  it('hands off a spacing change from the visible position during a system-follow glide', () => {
    const { v, layout, root } = view()
    const sheet = root.querySelector<HTMLElement>('.pn-page-sheet')!
    Object.defineProperty(sheet, 'animate', {
      configurable: true,
      value: () => ({ cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress: 0.25 }) } }),
    })
    v.setCursor(9)
    v.flushNow()
    const targetY = scroller(root).scrollTop
    expect(targetY).toBeGreaterThan(0)
    const next = {
      ...layout,
      params: { ...layout.params, spacing: { ...layout.params.spacing, voiceSpacingMultiplier: 1.8 } },
    }
    const snapshot = v.respaceSnapshot(next)
    expect(snapshot).not.toBeNull()
    // scrollTop already contains the target, but only one quarter of that scroll is visible.
    expect(snapshot!.frame.dy).toBe(PAGE_PAD_TOP - targetY * 0.25)
  })

  it('cancels a new view’s follow glide before anchoring a spacing handoff at the same scroll', () => {
    const { v, layout, root } = view()
    const cancel = vi.fn()
    const sheet = root.querySelector<HTMLElement>('.pn-page-sheet')!
    Object.defineProperty(sheet, 'animate', {
      configurable: true,
      value: () => ({ cancel, effect: { getComputedTiming: () => ({ progress: 0.25 }) } }),
    })
    v.setCursor(9)
    v.flushNow()
    const targetY = scroller(root).scrollTop
    v.respaceFrom({
      layout,
      frame: { scale: 1, dx: GX, dy: PAGE_PAD_TOP - targetY },
      pieces: new Map(),
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(scroller(root).scrollTop).toBe(targetY)
    expect(v.respaceSnapshot(layout)!.frame.dy).toBe(PAGE_PAD_TOP - targetY)
  })

  it('carries the live cursor through the same spacing progress as the notation', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    let progress = 0
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress }) } }),
    })
    try {
      const { v, layout, root } = view()
      const prev: PreparedLayout = {
        ...layout,
        params: { ...layout.params, spacing: { ...layout.params.spacing, voiceSpacingMultiplier: 1.8 } },
        occurrences: layout.occurrences.map((g) => ({
          ...g,
          x0: g.x0 + 100,
          x1: g.x1 + 100,
          anchors: g.anchors.map(([p, x]) => [p, x + 100] as const),
        })),
        systems: layout.systems!.map((sys) => ({
          ...sys,
          staves: sys.staves.map((staff, i) => ({
            ...staff,
            top: staff.top + (i + 1) * 20,
            bottom: staff.bottom + (i + 1) * 20,
          })),
        })),
      }
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      v.setCursor(0.5, { smooth: false })
      v.flushNow()
      v.respaceFrom({
        layout: prev,
        frame: { scale: 1, dx: GX, dy: PAGE_PAD_TOP },
        pieces: new Map([[0, [{ el: mark, chain: [], x0: 210, x1: 230 }]]]),
      })
      expect(root.querySelector('.pn-respace')).not.toBeNull()
      // The old engraving's staves (80–240), with the bar's margin at each end (U73).
      expect(cursorXY(root)).toEqual([GX + 220, 96 - PAGE_CURSOR_MARGIN])
      expect(root.querySelector<HTMLElement>('.pn-cursor')!.style.height).toBe(`${160 + 2 * PAGE_CURSOR_MARGIN}px`)
      // Playback advances during the glide, so use its new position in both layouts.
      progress = 0.5
      v.setCursor(0.75, { smooth: false })
      v.flushNow()
      const actual = new PageGeometry(layout).cursorAt(0.75).x
      expect(cursorXY(root)[0]).toBeCloseTo(GX + actual + 50, 1)
      expect(cursorXY(root)[1]).toBe(86 - PAGE_CURSOR_MARGIN)
      expect(root.querySelector<HTMLElement>('.pn-cursor')!.style.height).toBe(`${150 + 2 * PAGE_CURSOR_MARGIN}px`)
      progress = 1
      v.flushNow()
      expect(cursorXY(root)[0]).toBeCloseTo(GX + actual, 1)
      expect(cursorXY(root)[1]).toBe(76 - PAGE_CURSOR_MARGIN)
      expect(root.querySelector<HTMLElement>('.pn-cursor')!.style.height).toBe(`${140 + 2 * PAGE_CURSOR_MARGIN}px`)
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'animate', original)
      else Reflect.deleteProperty(Element.prototype, 'animate')
    }
  })

  it('keeps a spacing handoff anchored through the initial equal-size observer notification', () => {
    let notify!: () => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    try {
      const { v, layout, root } = view()
      v.setCursor(9, { smooth: false })
      v.flushNow()
      v.respaceFrom({
        layout,
        frame: { scale: 1, dx: GX, dy: PAGE_PAD_TOP - 320 },
        pieces: new Map(),
      })
      expect(scroller(root).scrollTop).toBe(320)
      notify()
      v.flushNow()
      expect(scroller(root).scrollTop).toBe(320)
      // A real viewport resize still requests the new follow position.
      const rect = root.getBoundingClientRect()
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, height: 800 })
      notify()
      v.flushNow()
      expect(scroller(root).scrollTop).not.toBe(320)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not follow while the learner browses, and returns on request', () => {
    const browse: boolean[] = []
    const { v, root } = view(24, { onBrowse: (b) => browse.push(b) })
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    sc.scrollTop = 1200
    sc.dispatchEvent(new Event('scroll'))
    v.flushNow()
    expect(v.isBrowsing()).toBe(true)
    expect(root.classList.contains('pn-browsing')).toBe(true)
    // Scrolling a page never moves its notation-anchored cursor to a different note.
    expect(v.browsedPosition()).toBeNull()
    v.setCursor(4)
    v.flushNow()
    expect(sc.scrollTop).toBe(1200)
    v.returnToCurrent()
    v.flushNow()
    expect(browse).toEqual([true, false])
    expect(sc.scrollTop).toBe(PAGE_PAD_TOP + 300 - VIEW_H / 4)
  })

  it('a keyboard seek after browsing restores following to the chosen system', () => {
    const seeks: unknown[] = []
    const { v, root } = view(24, { onCursorSeek: (p) => void seeks.push(p) })
    v.setSnapPositions(Array.from({ length: 48 }, (_, i) => rat(i, 2)))
    v.setCursorDraggable(true)
    v.setBrowseEnabled(true)
    v.setCursor(4)
    v.flushNow()
    const sc = scroller(root)
    sc.scrollTop = 1200
    sc.dispatchEvent(new Event('scroll'))
    root
      .querySelector('.pn-cursor-grip')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    v.flushNow()
    expect(seeks).toEqual([rat(9, 2)])
    expect(v.isBrowsing()).toBe(false)
    expect(sc.scrollTop).toBe(PAGE_PAD_TOP + 300 - VIEW_H / 4)
    v.setCursor(8, { smooth: false })
    v.flushNow()
    expect(sc.scrollTop).toBe(PAGE_PAD_TOP + 600 - VIEW_H / 4)
  })

  it.each([true, false])('a dragged playhead ends browsing only when the seek is accepted (%s)', (accepted) => {
    const seeks: unknown[] = []
    const { v, root } = view(24, {
      onCursorSeek: (p) => {
        seeks.push(p)
        return accepted
      },
    })
    v.setSnapPositions(Array.from({ length: 48 }, (_, i) => rat(i, 2)))
    v.setCursorDraggable(true)
    v.setBrowseEnabled(true)
    v.setCursor(4)
    v.flushNow()
    const sc = scroller(root)
    sc.scrollTop = 1200
    sc.dispatchEvent(new Event('scroll'))
    const grip = root.querySelector('.pn-cursor-grip')!
    const pointer = (el: Element, type: string, x: number): void => {
      el.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: 100, bubbles: true }))
    }
    pointer(grip, 'pointerdown', GX + 50)
    pointer(sc, 'pointermove', GX + 120)
    pointer(sc, 'pointerup', GX + 120)
    v.flushNow()
    expect(seeks).toEqual([rat(9, 2)])
    expect(v.isBrowsing()).toBe(!accepted)
    expect(sc.scrollTop).toBe(accepted ? PAGE_PAD_TOP + 300 - VIEW_H / 4 : 1200)
  })

  it('locks manual scrolling while browsing is disabled', () => {
    const { v, root } = view()
    expect(scroller(root).classList.contains('pn-page-locked')).toBe(true)
    v.setBrowseEnabled(true)
    expect(scroller(root).classList.contains('pn-page-locked')).toBe(false)
  })

  it('draws a loop band per system with handles at its edges and the ✕ on the first band', () => {
    const { v, root } = view()
    v.setLoop({ fromOcc: 2, toOcc: 9 })
    v.flushNow()
    const bands = [...root.querySelectorAll<HTMLElement>('.pn-loop.pn-on')]
    expect(bands.map((b) => [b.dataset['system'], b.style.left, b.style.width, b.style.top])).toEqual([
      ['0', '370px', '360px', '0px'],
      ['1', '10px', '720px', '300px'],
      ['2', '10px', '360px', '600px'],
    ])
    const start = root.querySelector<HTMLElement>('.pn-handle-start')!
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const clear = root.querySelector<HTMLElement>('.pn-loop-clear')!
    expect(start.style.left).toBe(`${GX + 370}px`)
    expect(start.style.top).toBe(`${PAGE_PAD_TOP + 130}px`)
    expect(end.style.left).toBe(`${GX + 370}px`)
    expect(end.style.top).toBe(`${PAGE_PAD_TOP + 730}px`)
    expect(clear.style.left).toBe(`${GX + 550}px`)
    const changes: unknown[] = []
    v.destroy()
    views = []
    const w = view(24, { onLoopChange: (r) => changes.push(r) })
    w.v.setLoop({ fromOcc: 2, toOcc: 9 })
    w.v.flushNow()
    w.root.querySelector<HTMLElement>('.pn-loop-clear')!.click()
    expect(changes).toEqual([null])
  })

  it('steps a loop handle with the keyboard across systems', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 3 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 4 }])
  })

  it('applies the strip note classes and halos', () => {
    const { v, root } = view()
    v.setTargets([0, 1])
    v.setAccepted([1])
    v.flushNow()
    const head = (n: number) => root.querySelector(`[data-n="${n}"]`)!
    expect(head(0).classList.contains('pn-target')).toBe(true)
    expect(head(1).classList.contains('pn-acc')).toBe(true)
    expect(root.querySelectorAll('.pn-halo')).toHaveLength(1)
    expect(root.querySelectorAll('.pn-ring')).toHaveLength(1)
    v.setWrongMarker(true)
    v.flushNow()
    expect(root.querySelector('.pn-cursor')!.classList.contains('pn-cursor-wrong')).toBe(true)
  })

  it('shows labels and reports the visible ones', () => {
    const seen: number[][] = []
    const { v, root } = view(24, { onVisibleLabels: (n) => seen.push([...n]) })
    v.setLabels(new Map([[0, 'C4']]))
    v.setLabelOpacity(new Map([[0, 1]]))
    v.flushNow()
    expect(root.querySelector('.pn-label')!.textContent).toBe('C4')
    expect(v.visibleLabels()).toEqual([0])
    expect(seen).toEqual([[0]])
  })

  it('draws corrections as red-pen rings in page coordinates', () => {
    const { v, root } = view()
    v.setCorrections([{ notes: [8, 9], kind: 'wrong', text: 'Wrong note' }])
    v.flushNow()
    const corr = root.querySelector<SVGElement>('.pn-corr')!
    expect(corr.classList.contains('pn-corr-wrong')).toBe(true)
    // Two rings (one per staff) in system 1 (notes of bar 5).
    expect(corr.querySelectorAll('.pn-corr-ring')).toHaveLength(2)
    expect(Number.parseFloat(corr.style.top)).toBeGreaterThan(300)
    expect(corr.querySelector('.pn-corr-label')!.textContent).toBe('Wrong note')
  })

  it('reports the bar under a point, and on the current system with one argument', () => {
    const { v } = view()
    expect(v.occAt(GX + 200, PAGE_PAD_TOP + 380)).toBe(5)
    v.setCursor(8)
    v.flushNow()
    expect(v.occAt(GX + 200)).toBe(9)
  })

  it('taps seek to the tapped bar', () => {
    const seeks: number[] = []
    const { root } = view(24, { onSeekRequest: (o) => seeks.push(o) })
    const sc = scroller(root)
    const ev = (type: string) =>
      new PointerEvent(type, { pointerId: 1, clientX: GX + 200, clientY: PAGE_PAD_TOP + 380, bubbles: true })
    sc.dispatchEvent(ev('pointerdown'))
    sc.dispatchEvent(ev('pointerup'))
    expect(seeks).toEqual([5])
  })

  it('a tap while browsing is a chosen seek: browsing ends', () => {
    const browse: boolean[] = []
    const { v, root } = view(24, { onBrowse: (b) => browse.push(b), onSeekRequest: () => undefined })
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    sc.scrollTop = 400
    sc.dispatchEvent(new Event('scroll'))
    const ev = (type: string) => new PointerEvent(type, { pointerId: 2, clientX: 100, clientY: 100, bubbles: true })
    sc.dispatchEvent(ev('pointerdown'))
    sc.dispatchEvent(ev('pointerup'))
    expect(browse).toEqual([true, false])
    expect(v.isBrowsing()).toBe(false)
  })

  it('previews a zoom at once and reports it after the debounce', () => {
    vi.useFakeTimers()
    const zooms: number[] = []
    const { v, root } = view(24, { onZoomChange: (z) => zooms.push(z) })
    v.setZoom(1.5)
    v.flushNow()
    expect(v.zoom()).toBe(1.5)
    expect(root.querySelector<HTMLElement>('.pn-page-content')!.style.transform).toContain('scale(1.5)')
    v.setZoom(1.6)
    vi.advanceTimersByTime(249)
    expect(zooms).toEqual([])
    vi.advanceTimersByTime(2)
    expect(zooms).toEqual([1.6])
  })

  it('fits the page to a narrow host with `fitWidth`, keeping and reporting the requested zoom (R17)', () => {
    vi.useFakeTimers()
    // A 400 px host: the 740 px page fits between the gutters at (400 - 32) / 740.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 400,
      height: VIEW_H,
      right: 400,
      bottom: VIEW_H,
      toJSON: () => ({}),
    } as DOMRect)
    const zooms: number[] = []
    const { v, root } = view(24, {
      fitWidth: true,
      initialZoom: 1.5,
      minZoom: 0.25,
      onZoomChange: (z) => zooms.push(z),
    })
    const fit = (400 - 32) / 740
    expect(v.zoom()).toBeCloseTo(fit, 5)
    expect(root.classList.contains('pn-page-wide')).toBe(false)
    expect(root.querySelector<HTMLElement>('.pn-page-sheet')!.style.width).toBe('400px')
    // Zooming in past the fit changes nothing on screen but is reported: the owner re-prepares
    // a narrower page, which is what the gesture means.
    v.setZoom(2)
    v.flushNow()
    expect(v.zoom()).toBeCloseTo(fit, 5)
    vi.advanceTimersByTime(260)
    expect(zooms).toEqual([2])
    // Zooming out below the fit shows at once.
    v.setZoom(0.4)
    v.flushNow()
    expect(v.zoom()).toBe(0.4)
    expect(root.querySelector<HTMLElement>('.pn-page-content')!.style.transform).toContain('scale(0.4)')
    vi.advanceTimersByTime(260)
    expect(zooms).toEqual([2, 0.4])
  })

  it('does not fit the page without `fitWidth`: a wide page scrolls sideways as before', () => {
    const { v, root } = view(24, { initialZoom: 1.5 })
    expect(v.zoom()).toBe(1.5)
    expect(root.classList.contains('pn-page-wide')).toBe(true)
  })

  describe('image zoom (U83)', () => {
    const narrowHost = () =>
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 400,
        height: VIEW_H,
        right: 400,
        bottom: VIEW_H,
        toJSON: () => ({}),
      } as DOMRect)
    const fit = (400 - 32) / 740

    it('magnifies the page as engraved, 1× to 4× of the fit, and never asks for a new engraving', () => {
      vi.useFakeTimers()
      narrowHost()
      const zooms: number[] = []
      const mags: number[] = []
      const { v, root } = view(24, {
        fitWidth: true,
        imageZoom: true,
        onZoomChange: (z) => zooms.push(z),
        onMagnify: (m) => mags.push(m),
      })
      expect(v.zoom()).toBeCloseTo(fit, 5)
      v.setZoom(fit * 2)
      v.flushNow()
      expect(v.zoom()).toBeCloseTo(fit * 2, 5)
      expect(root.classList.contains('pn-page-wide')).toBe(true)
      expect(root.querySelector<HTMLElement>('.pn-page-content')!.style.transform).toContain(`scale(${fit * 2}`)
      vi.advanceTimersByTime(260)
      expect(mags).toHaveLength(1)
      expect(mags[0]).toBeCloseTo(2, 5)
      // Never smaller than the fit, never past four times it.
      v.setZoom(0.1)
      v.flushNow()
      expect(v.zoom()).toBeCloseTo(fit, 5)
      expect(root.classList.contains('pn-page-wide')).toBe(false)
      v.setZoom(100)
      v.flushNow()
      expect(v.zoom()).toBeCloseTo(fit * 4, 5)
      vi.advanceTimersByTime(260)
      expect(zooms).toEqual([])
    })

    it('opens at the magnification it is handed', () => {
      narrowHost()
      const { v } = view(24, { fitWidth: true, imageZoom: true, initialMagnify: 3 })
      expect(v.zoom()).toBeCloseTo(fit * 3, 5)
    })

    it('ctrl-wheel keeps the page point under the pointer in place, without browsing', () => {
      narrowHost()
      const browse: boolean[] = []
      const { v, root } = view(24, { fitWidth: true, imageZoom: true, onBrowse: (b) => browse.push(b) })
      v.setBrowseEnabled(true)
      v.flushNow()
      const sc = scroller(root)
      const before = { x: sc.scrollLeft, y: sc.scrollTop }
      const s0 = v.zoom()
      const gutter0 = (400 - 740 * s0) / 2
      const px = (before.x + 300 - gutter0) / s0
      const py = (before.y + 200 - PAGE_PAD_TOP) / s0
      // happy-dom's WheelEvent drops the modifier and pointer fields: set them on the event.
      const wheel = new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true })
      Object.defineProperties(wheel, { ctrlKey: { value: true }, clientX: { value: 300 }, clientY: { value: 200 } })
      sc.dispatchEvent(wheel)
      const s1 = v.zoom()
      expect(s1).toBeGreaterThan(s0)
      // The same page point is still under (300, 200); the page is wider than the host now.
      expect(sc.scrollLeft + 300).toBeCloseTo(px * s1, 0)
      expect(sc.scrollTop + 200).toBeCloseTo(PAGE_PAD_TOP + py * s1, 0)
      sc.dispatchEvent(new Event('scroll'))
      expect(browse).toEqual([])
    })
  })

  it('has no repeat button on the cursor without a handler (Study mode, U72)', () => {
    const { root } = view(24)
    expect(root.querySelector('.pn-cursor .pn-cursor-action')).toBeNull()
  })

  it('rides the repeat button on the cursor', () => {
    let pressed = 0
    const { v, root } = view(24, { onCursorAction: () => pressed++ })
    v.setCursorAction(true)
    const btn = root.querySelector<HTMLButtonElement>('.pn-cursor .pn-cursor-action')!
    expect(btn.hasAttribute('inert')).toBe(false)
    btn.click()
    expect(pressed).toBe(1)
  })
})

describe('PageView fixes', () => {
  it('page corrections follow U39', () => {
    const { v, layout, root } = view()
    v.setCorrections([
      { notes: [0, 1], kind: 'spread', text: 'Together' },
      { notes: [4], kind: 'tie', text: 'Tied, hold it' },
    ])
    v.flushNow()
    expect(root.querySelector('.pn-corr-spread .pn-corr-link')).not.toBeNull()
    expect(root.querySelector('.pn-corr-tie .pn-corr-label')?.textContent).toBe('Tied, hold it')
    // Above the top staff, clear of its noteheads (a band beyond the staves, not on notation).
    const top = Number(root.querySelector('.pn-corr-spread .pn-corr-label')!.getAttribute('y'))
    expect(top).toBeLessThan(layout.systems![0]!.staves[0]!.top)
    v.setCorrections([{ notes: [1], kind: 'wrong', text: 'Wrong note' }])
    v.flushNow()
    const y = Number(root.querySelector('.pn-corr:not(.pn-corr-leave) .pn-corr-label')!.getAttribute('y'))
    expect(y).toBeGreaterThan(layout.systems![0]!.staves[1]!.bottom)
  })

  it("places a later system's label against that system only", () => {
    const { v, layout, root } = view()
    v.setCorrections([{ notes: [9], kind: 'wrong', text: 'Wrong note' }])
    v.flushNow()
    const y = Number(root.querySelector('.pn-corr-label')!.getAttribute('y'))
    const sys = layout.systems![1]!
    expect(y).toBeGreaterThan(sys.staves[1]!.bottom)
    expect(y).toBeLessThan(sys.y1 + 40)
  })

  it('does not resurrect a loop cleared while a handle is held', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 1, toOcc: 1 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (t: string, x: number) =>
      end.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x, clientY: 150, bubbles: true }))
    p('pointerdown', GX + 370)
    p('pointermove', GX + 550)
    v.setLoop(null)
    p('pointerup', GX + 550)
    v.flushNow()
    expect(changes).toEqual([])
  })

  it('commits a handle drag when nothing interfered', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 1, toOcc: 1 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (t: string, x: number) =>
      end.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x, clientY: 150, bubbles: true }))
    p('pointerdown', GX + 370)
    p('pointermove', GX + 550)
    p('pointerup', GX + 550)
    expect(changes).toEqual([{ fromOcc: 1, toOcc: 2 }])
  })

  it('drags either loop edge vertically across systems and keeps exact note boundaries', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setSnapPositions(Array.from({ length: 48 }, (_, i) => rat(i, 2)))
    v.setLoop({ fromOcc: 1, toOcc: 1 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (el: HTMLElement, type: string, x: number, y: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: GX + x, clientY: y, bubbles: true }))
    p(end, 'pointerdown', 370, 146)
    p(end, 'pointermove', 265, 446)
    p(end, 'pointerup', 265, 446)
    expect(changes).toEqual([{ fromOcc: 1, toOcc: 5, end: rat(11, 2) }])
    v.flushNow()
    expect(root.querySelectorAll('.pn-loop.pn-on')).toHaveLength(2)

    v.setLoop({ fromOcc: 4, toOcc: 7, end: rat(15, 2) })
    v.flushNow()
    const start = root.querySelector<HTMLElement>('.pn-handle-start')!
    p(start, 'pointerdown', 10, 446)
    p(start, 'pointermove', 265, 146)
    p(start, 'pointerup', 265, 146)
    expect(changes.at(-1)).toEqual({ fromOcc: 1, toOcc: 7, start: rat(3, 2), end: rat(15, 2) })
  })

  it.each(['start', 'end'] as const)('clamps the %s edge against the other edge across systems', (which) => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 4, toOcc: 5 })
    v.flushNow()
    const handle = root.querySelector<HTMLElement>(`.pn-handle-${which}`)!
    const p = (type: string, y: number) =>
      handle.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: GX + 370, clientY: y, bubbles: true }))
    p('pointerdown', 446)
    p('pointermove', which === 'start' ? 746 : 146)
    p('pointerup', which === 'start' ? 746 : 146)
    expect(changes).toEqual([which === 'start' ? { fromOcc: 5, toOcc: 5 } : { fromOcc: 4, toOcc: 4 }])
  })

  it('wraps the end handle at the right edge once per edge entry, then continues on the new system', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 3 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, x: number) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: 146, bubbles: true }))
    p('pointerdown', GX + 730)
    for (const x of [VIEW_W - 1, VIEW_W, VIEW_W + 1]) p('pointermove', x)
    v.flushNow()
    expect(root.querySelectorAll('.pn-loop.pn-on')).toHaveLength(2)
    expect(scroller(root).scrollTop).toBe(300)
    expect(end.style.top).toBe(`${PAGE_PAD_TOP + 430}px`)
    // Back inside the page: edit the next system, then another edge entry reaches system 3.
    p('pointermove', GX + 370)
    p('pointermove', VIEW_W - 1)
    p('pointerup', VIEW_W - 1)
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 8 }])
  })

  it('wraps the start handle at the left edge without skipping more systems while held there', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 4, toOcc: 7 })
    v.flushNow()
    const start = root.querySelector<HTMLElement>('.pn-handle-start')!
    const p = (type: string, x: number) =>
      start.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: 446, bubbles: true }))
    p('pointerdown', GX + 10)
    for (const x of [1, 0, -1]) p('pointermove', x)
    p('pointerup', -1)
    expect(changes).toEqual([{ fromOcc: 3, toOcc: 7 }])
  })

  it('a diagonal drag onto the next system does not also wrap past it', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 3 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, x: number, y: number) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true }))
    p('pointerdown', GX + 730, 146)
    p('pointermove', VIEW_W - 1, 446)
    p('pointermove', VIEW_W, 446)
    p('pointerup', VIEW_W, 446)
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 7 }])
    expect(scroller(root).scrollTop).toBe(0)
  })

  it('an outward drag at the last system clamps without pretending to wrap', () => {
    const changes: unknown[] = []
    const { v, root } = view(8, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 5, toOcc: 5 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, x: number) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: x, clientY: 446, bubbles: true }))
    p('pointerdown', GX + 370)
    p('pointermove', VIEW_W)
    p('pointerup', VIEW_W)
    expect(changes).toEqual([{ fromOcc: 5, toOcc: 7 }])
    expect(scroller(root).scrollTop).toBe(0)
  })

  it('grabbing a handle freezes an in-flight follow glide at its visible scroll position', () => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    const sheet = root.querySelector<HTMLElement>('.pn-page-sheet')!
    const cancel = vi.fn()
    Object.defineProperty(sheet, 'animate', { configurable: true, value: () => ({ cancel }) })
    v.setLoop({ fromOcc: 4, toOcc: 5 })
    v.setCursor(8)
    v.flushNow()
    expect(scroller(root).scrollTop).toBe(466)
    Object.defineProperty(sheet, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...root.getBoundingClientRect(), y: -80, top: -80, bottom: VIEW_H - 80 }),
    })
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, x: number) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: GX + x, clientY: 366, bubbles: true }))
    p('pointerdown', 370)
    expect(scroller(root).scrollTop).toBe(80)
    expect(cancel).toHaveBeenCalledOnce()
    p('pointermove', 550)
    p('pointerup', 550)
    expect(changes).toEqual([{ fromOcc: 4, toOcc: 6 }])
  })

  it('scrolls to more systems while a handle is held near the bottom and stops on release', () => {
    vi.useFakeTimers()
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setBrowseEnabled(true)
    v.setLoop({ fromOcc: 0, toOcc: 1 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, y: number) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: GX + 370, clientY: y, bubbles: true }))
    p('pointerdown', 146)
    p('pointermove', VIEW_H - 1)
    vi.advanceTimersByTime(800)
    expect(scroller(root).scrollTop).toBeGreaterThan(300)
    p('pointerup', VIEW_H - 1)
    const y = scroller(root).scrollTop
    vi.advanceTimersByTime(500)
    expect(scroller(root).scrollTop).toBe(y)
    expect(root.classList.contains('pn-browsing')).toBe(true)
    expect(changes).toHaveLength(1)
    expect((changes[0] as { toOcc: number }).toOcc).toBeGreaterThan(9)
  })

  it.each(['pointercancel', 'lostpointercapture'])('does not commit a loop edit after %s', (cancel) => {
    const changes: unknown[] = []
    const { v, root } = view(24, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 1, toOcc: 1 })
    v.flushNow()
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const p = (type: string, id = 7) =>
      end.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: GX + 370, clientY: 446, bubbles: true }))
    p('pointerdown')
    p('pointermove')
    p('pointerup', 8) // A second finger cannot commit or release this edit.
    p(cancel)
    p('pointerup')
    v.flushNow()
    expect(changes).toEqual([])
    expect(root.querySelectorAll('.pn-loop.pn-on')).toHaveLength(1)
  })
})

describe('PageView with a page wider than the viewport', () => {
  const width = 400

  function wideView(opts: PageOptions = {}) {
    const rect = host.getBoundingClientRect()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, width, right: width })
    return view(24, opts)
  }

  it('keeps each played position visible, then returns to the left of the next system', () => {
    const onBrowse = vi.fn()
    const { v, root } = wideView({ onBrowse })
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    expect(root.querySelector<HTMLElement>('.pn-page-sheet')!.style.width).toBe('740px')
    expect(sc.scrollLeft).toBe(0)
    for (let p = 0; p < 4; p += 0.125) {
      v.setCursor(p, { smooth: false })
      v.flushNow()
      sc.dispatchEvent(new Event('scroll'))
      const x = cursorXY(root)[0] - sc.scrollLeft
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(width)
    }
    expect(sc.scrollLeft).toBeGreaterThan(200)
    v.setCursor(4, { smooth: false })
    v.flushNow()
    expect(sc.scrollLeft).toBe(0)
    expect(sc.scrollTop).toBe(PAGE_PAD_TOP + 300 - VIEW_H / 4)
    expect(onBrowse).not.toHaveBeenCalled()
  })

  it('treats native horizontal scrolling as browsing and resumes following only on return', () => {
    const onBrowse = vi.fn()
    const { v, root } = wideView({ onBrowse })
    const sc = scroller(root)
    v.setBrowseEnabled(true)
    sc.scrollLeft = 180
    sc.dispatchEvent(new Event('scroll'))
    expect(v.isBrowsing()).toBe(true)
    expect(onBrowse).toHaveBeenCalledExactlyOnceWith(true)
    v.setCursor(3)
    v.flushNow()
    expect(sc.scrollLeft).toBe(180)
    v.returnToCurrent()
    v.flushNow()
    expect(v.isBrowsing()).toBe(false)
    expect(sc.scrollLeft).toBe(340)
    expect(onBrowse.mock.calls).toEqual([[true], [false]])
  })

  it('lets a mouse drag pan a wide page and invokes the playback-pause callback without seeking', () => {
    let playing = true
    const onSeekRequest = vi.fn()
    const { v, root } = wideView({
      onBrowse: (on) => {
        if (on) playing = false
      },
      onSeekRequest,
    })
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    const pointer = (type: string, x: number) =>
      sc.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 9,
          pointerType: 'mouse',
          clientX: x,
          clientY: 240,
          bubbles: true,
        }),
      )
    pointer('pointerdown', 300)
    pointer('pointermove', 180)
    pointer('pointerup', 180)
    v.flushNow()
    expect(sc.scrollLeft).toBe(120)
    expect(playing).toBe(false)
    expect(v.isBrowsing()).toBe(true)
    expect(onSeekRequest).not.toHaveBeenCalled()
  })

  it('leaves touch panning to the browser and never interprets its canceled gesture as a seek', () => {
    const onBrowse = vi.fn()
    const onSeekRequest = vi.fn()
    const { v, root } = wideView({ onBrowse, onSeekRequest })
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    const pointer = (type: string, x: number) =>
      sc.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 10,
          pointerType: 'touch',
          clientX: x,
          clientY: 240,
          bubbles: true,
        }),
      )
    pointer('pointerdown', 300)
    pointer('pointermove', 200)
    expect(sc.scrollLeft).toBe(0)
    pointer('pointercancel', 200)
    sc.scrollLeft = 100
    sc.dispatchEvent(new Event('scroll'))
    expect(onBrowse).toHaveBeenCalledExactlyOnceWith(true)
    expect(onSeekRequest).not.toHaveBeenCalled()
  })

  it('resolves taps and cursor screen positions in the horizontally scrolled sheet', () => {
    const { v, root } = wideView()
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    sc.scrollLeft = 180
    sc.dispatchEvent(new Event('scroll'))
    const sheet = root.querySelector<HTMLElement>('.pn-page-sheet')!
    const rect = host.getBoundingClientRect()
    vi.spyOn(sheet, 'getBoundingClientRect').mockImplementation(() => ({
      ...rect,
      left: -sc.scrollLeft,
      top: -sc.scrollTop,
    }))
    expect(v.occAt(50, 120)).toBe(1)
    v.setCursor(2)
    v.flushNow()
    expect(v.cursorClientX()).toBe(410 - 180)
  })

  it('counts only horizontally visible note names as assistance', () => {
    const { v, layout, root } = wideView()
    v.setBrowseEnabled(true)
    v.setLabels(new Map(layout.notes.flatMap((n) => (n ? [[n.index, 'C4'] as const] : []))))
    v.setLabelOpacity(new Map(layout.notes.flatMap((n) => (n ? [[n.index, 1] as const] : []))))
    v.flushNow()
    expect(v.visibleLabels()).toContain(0)
    expect(v.visibleLabels()).not.toContain(6)
    const sc = scroller(root)
    sc.scrollLeft = 340
    sc.dispatchEvent(new Event('scroll'))
    v.flushNow()
    expect(v.visibleLabels()).not.toContain(0)
    expect(v.visibleLabels()).toContain(6)
  })

  it('clamps horizontal browsing when zoom makes the page fit again', () => {
    const { v, root } = wideView()
    v.setBrowseEnabled(true)
    const sc = scroller(root)
    sc.scrollLeft = 340
    sc.dispatchEvent(new Event('scroll'))
    v.setZoom(0.5)
    v.flushNow()
    expect(sc.scrollLeft).toBe(0)
    expect(root.classList.contains('pn-page-wide')).toBe(false)
    expect(root.querySelector<HTMLElement>('.pn-page-sheet')!.style.width).toBe('400px')
  })

  it('resets horizontal pan at a system boundary while capturing the visible vertical glide', () => {
    const { v, layout, root } = wideView()
    Object.defineProperty(root.querySelector('.pn-page-sheet'), 'animate', {
      configurable: true,
      value: () => ({ cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress: 0.25 }) } }),
    })
    v.setCursor(6)
    v.flushNow()
    const sc = scroller(root)
    expect(sc.scrollLeft).toBeGreaterThan(0)
    expect(sc.scrollTop).toBeGreaterThan(0)
    const snapshot = v.respaceSnapshot(layout)!
    expect(snapshot.frame.dx).toBeCloseTo(-sc.scrollLeft)
    expect(snapshot.frame.dx + cursorXY(root)[0]).toBeGreaterThanOrEqual(0)
    expect(snapshot.frame.dx + cursorXY(root)[0]).toBeLessThan(width)
    expect(snapshot.frame.dy).toBeCloseTo(PAGE_PAD_TOP - sc.scrollTop * 0.25)
  })

  it('anchors a spacing change horizontally and keeps the live cursor aligned throughout it', () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    let progress = 0
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress }) } }),
    })
    try {
      const { v, layout, root } = wideView()
      const prev: PreparedLayout = {
        ...layout,
        params: { ...layout.params, spacing: { ...layout.params.spacing, voiceSpacingMultiplier: 1.8 } },
        occurrences: layout.occurrences.map((g) => ({
          ...g,
          x0: g.x0 * 0.75 + 80,
          x1: g.x1 * 0.75 + 80,
          anchors: g.anchors.map(([p, x]) => [p, x * 0.75 + 80] as const),
        })),
      }
      const geo = new PageGeometry(layout)
      const prevGeo = new PageGeometry(prev)
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      v.setCursor(2, { smooth: false })
      v.flushNow()
      v.respaceFrom({
        layout: prev,
        frame: { scale: 1, dx: -200, dy: PAGE_PAD_TOP },
        pieces: new Map([[0, [{ el: mark, chain: [], x0: 380, x1: 400 }]]]),
      })
      const sc = scroller(root)
      expect(sc.scrollLeft).toBeCloseTo(222.5)
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo(187.5)
      expect(root.querySelector('.pn-respace')).not.toBeNull()
      progress = 0.5
      v.setCursor(2.1, { smooth: false })
      v.flushNow()
      const from = -200 + prevGeo.cursorAt(2.1).x
      const to = geo.cursorAt(2.1).x - sc.scrollLeft
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo((from + to) / 2, 1)
      progress = 1
      v.flushNow()
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo(to, 1)
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'animate', original)
      else Reflect.deleteProperty(Element.prototype, 'animate')
    }
  })

  it.each(['fit to wide', 'wide to fit'])('keeps the cursor continuous while respacing %s', (direction) => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    let progress = 0
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress }) } }),
    })
    try {
      const rect = host.getBoundingClientRect()
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, width, right: width })
      const wide = testPageLayout(24)
      const fit: PreparedLayout = {
        ...wide,
        width: wide.width / 2,
        occurrences: wide.occurrences.map((g) => ({
          ...g,
          x0: g.x0 / 2,
          x1: g.x1 / 2,
          anchors: g.anchors.map(([p, x]) => [p, x / 2] as const),
        })),
      }
      const growing = direction === 'fit to wide'
      const next = growing ? wide : fit
      const prev = growing ? fit : wide
      const prevFrame = { scale: 1, dx: growing ? 15 : -300, dy: PAGE_PAD_TOP }
      const v = new PageView(host, next)
      views.push(v)
      v.setCursor(2, { smooth: false })
      v.flushNow()
      const root = host.querySelector<HTMLElement>('.pn-page')!
      const sc = scroller(root)
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      v.respaceFrom({
        layout: prev,
        frame: prevFrame,
        pieces: new Map([[0, [{ el: mark, chain: [], x0: 200, x1: 220 }]]]),
      })
      const from = prevFrame.dx + new PageGeometry(prev).cursorAt(2).x
      const gx = growing ? 0 : 15
      const to = gx + new PageGeometry(next).cursorAt(2).x - sc.scrollLeft
      expect(sc.scrollLeft).toBeCloseTo(growing ? 190 : 0)
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo(from)
      progress = 0.5
      v.flushNow()
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo((from + to) / 2)
      progress = 1
      v.flushNow()
      expect(cursorXY(root)[0] - sc.scrollLeft).toBeCloseTo(to)
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'animate', original)
      else Reflect.deleteProperty(Element.prototype, 'animate')
    }
  })

  it('preserves horizontal following when focus mode changes only the viewport height', () => {
    let notify!: () => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    try {
      const { v, root } = wideView()
      for (let p = 0; p <= 1.5; p += 0.125) {
        v.setCursor(p, { smooth: false })
        v.flushNow()
      }
      const sc = scroller(root)
      const x = sc.scrollLeft
      expect(x).toBeGreaterThan(0)
      const rect = host.getBoundingClientRect()
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, height: 700, bottom: 700 })
      notify()
      v.flushNow()
      expect(sc.scrollLeft).toBe(x)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['pointerup', 'pointercancel'])('edge-scrolls a held playhead and handles %s', (release) => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const onCursorSeek = vi.fn()
    const { v, root } = wideView({ onCursorSeek })
    v.setBrowseEnabled(true)
    v.setCursorDraggable(true)
    v.setSnapPositions(Array.from({ length: 8 }, (_, i) => rat(i, 2)))
    const sc = scroller(root)
    const grip = root.querySelector<HTMLElement>('.pn-cursor-grip')!
    const pointer = (target: Element, type: string, x: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 12,
          clientX: x,
          clientY: 140,
          bubbles: true,
        }),
      )
    pointer(grip, 'pointerdown', 50)
    pointer(sc, 'pointermove', width - 1)
    vi.advanceTimersByTime(800)
    expect(sc.scrollLeft).toBe(340)
    expect(cursorXY(root)[0]).toBe(660)
    expect(onCursorSeek).not.toHaveBeenCalled()
    pointer(sc, release, width - 1)
    v.flushNow()
    if (release === 'pointerup') {
      expect(onCursorSeek).toHaveBeenCalledExactlyOnceWith(rat(7, 2))
      expect(cursorXY(root)[0]).toBe(660)
    } else {
      expect(onCursorSeek).not.toHaveBeenCalled()
      expect(sc.scrollLeft).toBe(0)
      expect(cursorXY(root)[0]).toBe(50)
    }
    const x = sc.scrollLeft
    vi.advanceTimersByTime(300)
    expect(sc.scrollLeft).toBe(x)
  })

  it('clamps a browsed offset after the viewport expands to fit the page', () => {
    let notify!: () => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    try {
      const { v, root } = wideView()
      const sc = scroller(root)
      v.setBrowseEnabled(true)
      sc.scrollLeft = 340
      sc.dispatchEvent(new Event('scroll'))
      const rect = host.getBoundingClientRect()
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, width: 740, right: 740 })
      notify()
      v.flushNow()
      expect(sc.scrollLeft).toBe(0)
      expect(root.classList.contains('pn-page-wide')).toBe(false)
      expect(v.isBrowsing()).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('pans through the current system before wrapping a held loop edge to the next one', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const onLoopChange = vi.fn()
    const { v, root } = wideView({ onLoopChange })
    v.setBrowseEnabled(true)
    v.setLoop({ fromOcc: 0, toOcc: 1 })
    v.flushNow()
    const sc = scroller(root)
    const end = root.querySelector<HTMLElement>('.pn-handle-end')!
    const pointer = (type: string, x: number) =>
      end.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 11,
          clientX: x,
          clientY: 146,
          bubbles: true,
        }),
      )
    pointer('pointerdown', 370)
    pointer('pointermove', width - 1)
    vi.advanceTimersByTime(240)
    expect(sc.scrollLeft).toBeGreaterThan(100)
    expect(sc.scrollTop).toBe(0)
    expect(onLoopChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(sc.scrollTop).toBe(300)
    expect(sc.scrollLeft).toBe(0)
    const y = sc.scrollTop
    vi.advanceTimersByTime(500)
    expect(sc.scrollTop).toBe(y)
    expect(sc.scrollLeft).toBe(0)
    pointer('pointerup', width - 1)
    expect(onLoopChange).toHaveBeenCalledExactlyOnceWith({ fromOcc: 0, toOcc: 4 })
  })
})
