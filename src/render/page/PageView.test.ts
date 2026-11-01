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
import { PageGeometry, pageWidthFor } from './geometry'
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
    // Staves 60–200 plus the 96 px margin above.
    expect(y0).toBe(PAGE_PAD_TOP + 60 - 96)
    expect(root.querySelector<HTMLElement>('.pn-cursor')!.style.height).toBe(`${140 + 192}px`)
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
    expect(y).toBe(PAGE_PAD_TOP + 600 + 60 - 96)
    expect(scroller(root).scrollTop).toBe(PAGE_PAD_TOP + 600 - VIEW_H / 4)
    expect(root.classList.contains('pn-instant')).toBe(true)
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
    v.setCursor(4)
    v.flushNow()
    expect(sc.scrollTop).toBe(1200)
    v.returnToCurrent()
    v.flushNow()
    expect(browse).toEqual([true, false])
    expect(sc.scrollTop).toBe(PAGE_PAD_TOP + 300 - VIEW_H / 4)
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
      { notes: [4], kind: 'pedal', text: 'Pedal' },
    ])
    v.flushNow()
    expect(root.querySelector('.pn-corr-spread .pn-corr-link')).not.toBeNull()
    expect(root.querySelector('.pn-corr-pedal .pn-corr-ped')?.textContent).toBe('Ped.')
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
})
