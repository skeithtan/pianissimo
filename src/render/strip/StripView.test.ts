// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREPARED_LAYOUT_FORMAT,
  type LabelBox,
  type NoteGeometry,
  type OccurrenceGeometry,
  type PreparedLayout,
  type SegmentData,
} from '../types'
import { type Rational, rat } from '../../core/music/rational'
import { StripView, type StripOptions } from './StripView'

const MEASURE = 200
const STAVES = [
  { index: 0, top: 100, bottom: 140 },
  { index: 1, top: 200, bottom: 240 },
]

/** A synthetic layout: `n` measures of 200 px, two notes per measure (one per staff), 4 measures per segment. */
function testLayout(n: number): PreparedLayout {
  const occurrences: OccurrenceGeometry[] = []
  const notes: NoteGeometry[] = []
  const labels: LabelBox[] = []
  for (let o = 0; o < n; o++) {
    const x0 = 50 + o * MEASURE
    occurrences.push({
      occ: o,
      x0,
      x1: x0 + MEASURE,
      start: o,
      duration: 1,
      anchors: [
        [0, x0 + 40],
        [0.5, x0 + 120],
        [1, x0 + MEASURE],
      ],
      label: String(o + 1),
      labelBox: { x: x0 + 2, y: 81, w: 10, h: 13 },
    })
    for (const staff of [0, 1]) {
      const index = notes.length
      const head = { x: x0 + 34, y: STAVES[staff]!.top + 15, w: 12, h: 10 }
      notes.push({
        index,
        occ: o,
        staff,
        hand: staff === 0 ? 'R' : 'L',
        head,
        x: x0 + 40,
        label: index,
        graphic: `g${index}`,
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
    }
  }
  const segments: SegmentData[] = []
  for (let s = 0; s * 4 < n; s++) {
    const occStart = s * 4
    const occEnd = Math.min(n, occStart + 4)
    const x0 = s === 0 ? 0 : occurrences[occStart]!.x0
    const x1 = occurrences[occEnd - 1]!.x1
    let body = ''
    for (let o = occStart; o < occEnd; o++) {
      for (const k of [0, 1]) {
        const i = o * 2 + k
        const h = notes[i]!.head
        body += `<g class="vf-stavenote" data-h="${k === 0 ? 'R' : 'L'}"><g class="vf-notehead" data-n="${i}"><path d="M${h.x} ${h.y}h12v10h-12z"></path></g></g>`
      }
      if (o === 1) body += '<text data-o="0">8va</text><path data-o="0" d="M100 60h200"></path>'
    }
    segments.push({
      index: s,
      occStart,
      occEnd,
      x0,
      x1,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" class="pn-music" viewBox="${x0 - 1} 60 ${x1 - x0 + 2} 220" width="${x1 - x0 + 2}" height="220">${body}</svg>`,
      labelStart: occStart * 2,
      labelEnd: occEnd * 2,
    })
  }
  return {
    format: PREPARED_LAYOUT_FORMAT,
    key: 'k',
    scoreVersionId: 'v',
    renderer: { name: 'test', version: '1' },
    params: {
      labelChars: 3,
      labelFontPx: 12,
      labelW: 25,
      labelH: 14,
      segmentWidth: 800,
      spacing: { voiceSpacingMultiplier: 1.4, voiceSpacingAddend: 3 },
      iterations: 1,
    },
    width: 50 + n * MEASURE + 10,
    top: 60,
    height: 220,
    staves: STAVES,
    occurrences,
    notes,
    labels,
    ottavas: [
      {
        span: 0,
        staff: 0,
        box: { x: 100, y: 55, w: 200, h: 20 },
        labelBox: { x: 100, y: 55, w: 24, h: 20 },
        text: '8va',
        engraved: true,
      },
    ],
    contexts: [
      {
        id: 0,
        width: 60,
        staves: STAVES.map((s) => ({
          staff: s.index,
          glyph: { svg: '<g><path d="M0 0h10v40h-10z"></path></g>', width: 60 },
        })),
      },
    ],
    contextChanges: [{ x: 0, occ: 0, context: 0, glyphEnd: 90 }],
    segments,
    report: {
      modelNotes: notes.length,
      graphicalNotes: notes.length,
      mapped: notes.length,
      unmappedNotes: [],
      unmappedGraphics: [],
      relaxedMatches: 0,
      sharedHeads: 0,
      ottavasMapped: 1,
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
  }
}

let host: HTMLElement
let views: StripView[] = []

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 900,
    height: 300,
    right: 900,
    bottom: 300,
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

function view(n = 40, opts: StripOptions = {}): { v: StripView; layout: PreparedLayout } {
  const layout = testLayout(n)
  const v = new StripView(host, layout, opts)
  views.push(v)
  v.flushNow()
  return { v, layout }
}

const transformX = (el: Element): number =>
  Number(/translate3d\((-?[\d.]+)px/.exec((el as HTMLElement).style.transform)?.[1])

describe('StripView scrolling and mounting', () => {
  it('keeps the cursor one third across at the beginning, middle, and end', () => {
    const { v } = view()
    const content = host.querySelector('.pn-content')!
    expect(transformX(content)).toBe(210)
    v.setCursor(20.5, { smooth: false })
    v.flushNow()
    const cursorX = 50 + 20 * MEASURE + 120
    expect(transformX(content)).toBeCloseTo(300 - cursorX)
    // The cursor lives in screen space at the anchor, outside the scrolled content.
    expect(transformX(host.querySelector('.pn-cursor')!)).toBeCloseTo(300)
    expect(host.querySelector('.pn-content .pn-cursor')).toBeNull()
    v.setCursor(40, { smooth: false })
    v.flushNow()
    expect(transformX(host.querySelector('.pn-cursor')!)).toBe(300)
    expect(transformX(content) + 8050).toBe(300)
  })

  it('marks transport following (pn-follow: no note fill fades) and clears it on a practice step', () => {
    const { v } = view()
    const root = host.querySelector('.pn-strip')!
    v.setCursor(2, { smooth: false })
    expect(root.classList.contains('pn-follow')).toBe(false) // a single jump is a seek
    v.setCursor(2.02, { smooth: false })
    v.setCursor(2.04, { smooth: false })
    expect(root.classList.contains('pn-follow')).toBe(true)
    v.setCursor(3)
    expect(root.classList.contains('pn-follow')).toBe(false)
  })

  it('applies pending work inside the caller frame with flushFrame', () => {
    const { v } = view()
    const content = host.querySelector('.pn-content')!
    v.flushNow()
    const before = transformX(content)
    v.setCursor(20.5, { smooth: false })
    expect(transformX(content)).toBe(before) // waits for a frame
    v.flushFrame()
    expect(transformX(content)).not.toBe(before)
    v.flushFrame() // nothing pending: no work
  })

  it('mounts only the viewport ± one viewport and keeps a bounded LRU while traversing', () => {
    const { v } = view(200)
    let maxMounted = 0
    for (let pos = 0; pos < 200; pos += 0.5) {
      v.setCursor(pos, { smooth: false })
      v.flushNow()
      maxMounted = Math.max(maxMounted, v.stats().mountedSegments)
      expect(v.stats().cachedSegments).toBeLessThanOrEqual(12)
    }
    // viewport (900 px) ± one viewport over 800 px segments
    expect(maxMounted).toBeLessThanOrEqual(Math.ceil((3 * 900) / 800) + 1)
    expect(host.querySelectorAll('.pn-seg').length).toBe(v.stats().mountedSegments)
    expect(v.stats().segments).toBe(50)
  })

  it('fits wide signatures before the fixed cursor on a narrow stage, even when zooming in', () => {
    const rect = host.getBoundingClientRect()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, width: 360, right: 360 })
    const { v } = view(40, { initialZoom: 2 })
    v.setCursor(10, { smooth: false })
    v.setZoom(9)
    v.flushNow()
    expect(transformX(host.querySelector('.pn-cursor')!)).toBe(120)
    expect(v.zoom() * (60 + 32)).toBeCloseTo(108)
    expect((host.querySelector('.pn-stage') as HTMLElement).style.maskImage).toContain('108px')
  })

  it('applies zoom as a CSS scale anchored on the cursor and limited to fit both staves', () => {
    const zooms: number[] = []
    const { v } = view(40, { onZoomChange: (z) => zooms.push(z) })
    v.setCursor(10, { smooth: false })
    v.flushNow()
    const content = host.querySelector('.pn-content') as HTMLElement
    v.setZoom(1.5)
    v.flushNow()
    expect(content.style.transform).toContain('scale(1.5)')
    const cursorX = 50 + 10 * MEASURE + 40
    expect(transformX(content) + cursorX * 1.5).toBeCloseTo(300)
    v.setZoom(9)
    expect(v.zoom()).toBeCloseTo(300 / (240 - 100 + 56))
    expect(zooms.length).toBe(2)
  })
})

describe('StripView pinch', () => {
  it('zooms with two pointers and keeps the cursor where it was', () => {
    const { v } = view()
    v.setCursor(10, { smooth: false })
    v.flushNow()
    const content = host.querySelector('.pn-content') as HTMLElement
    const before = transformX(content) + (50 + 10 * MEASURE + 40)
    const root = host.querySelector('.pn-strip')!
    const ev = (type: string, id: number, x: number) =>
      root.dispatchEvent(
        new PointerEvent(type, { pointerId: id, clientX: x, clientY: 150, pointerType: 'touch', bubbles: true }),
      )
    ev('pointerdown', 1, 400)
    ev('pointerdown', 2, 500)
    ev('pointermove', 2, 540)
    ev('pointerup', 2, 540)
    ev('pointerup', 1, 400)
    v.flushNow()
    expect(v.zoom()).toBeCloseTo(1.4)
    expect(transformX(content) + (50 + 10 * MEASURE + 40) * 1.4).toBeCloseTo(before)
  })
})

describe('StripView overlays', () => {
  it('updates notehead classes and marks for targets and accepted notes only where changed', () => {
    const { v } = view()
    v.setTargets([0, 1])
    v.flushNow()
    const head0 = host.querySelector('[data-n="0"]')!
    expect(head0.classList.contains('pn-target')).toBe(true)
    expect(host.querySelectorAll('.pn-halo').length).toBe(2)
    v.setAccepted([0])
    v.flushNow()
    expect(head0.classList.contains('pn-acc')).toBe(true)
    expect(host.querySelectorAll('.pn-ring').length).toBe(1)
    v.setTargets([2])
    v.setAccepted([])
    v.flushNow()
    expect(head0.classList.contains('pn-target')).toBe(false)
    expect(host.querySelectorAll('.pn-halo').length).toBe(1)
    expect(host.querySelectorAll('.pn-ring').length).toBe(0)
  })

  it('marks automatic and playback notes and subdues a hand', () => {
    const { v } = view()
    v.setAutomatic([1, 3])
    v.setPlaybackHighlights([3])
    v.setSubduedHand('L')
    v.flushNow()
    expect(host.querySelector('[data-n="3"]')!.classList.contains('pn-play')).toBe(true)
    expect(host.querySelector('[data-n="1"]')!.classList.contains('pn-auto')).toBe(true)
    expect(host.querySelector('.pn-strip')!.classList.contains('pn-sub-L')).toBe(true)
  })

  it('tints the cursor after a wrong key without adding text over the score', () => {
    const { v } = view()
    const cursor = host.querySelector('.pn-cursor')!
    v.pulseWrong()
    v.flushNow()
    expect(cursor.classList.contains('pn-cursor-wrong')).toBe(true)
    expect(host.querySelector('.pn-wrong')).toBeNull()
    expect(host.textContent).not.toContain('Wrong key')
    v.setWrongMarker(false)
    v.flushNow()
    expect(cursor.classList.contains('pn-cursor-wrong')).toBe(false)
  })

  it('emphasizes ottava brackets and shows a reminder when the label is offscreen', () => {
    const { v } = view()
    v.setOttavaEmphasis([0])
    v.flushNow()
    expect([...host.querySelectorAll('[data-o="0"]')].every((el) => el.classList.contains('pn-ott-on'))).toBe(true)
    expect(host.querySelector('.pn-ott-box')!.classList.contains('pn-on')).toBe(true)
    expect(host.querySelector('.pn-ott-rem.pn-on')).toBeNull()
    v.setCursor(8, { smooth: false })
    v.flushNow()
    expect(host.querySelector('.pn-ott-rem.pn-on')!.textContent).toBe('8va')
    v.setOttavaEmphasis([])
    v.flushNow()
    expect(host.querySelector('[data-o="0"]')!.classList.contains('pn-ott-on')).toBe(false)
    expect(host.querySelector('.pn-ott-rem.pn-on')).toBeNull()
  })
})

describe('StripView labels', () => {
  it('creates label nodes only while visible, fades by style and removes them at opacity 0', () => {
    const seen: number[][] = []
    const { v, layout } = view(40, { onVisibleLabels: (n) => seen.push([...n]) })
    v.setLabels(
      new Map([
        [0, 'C4'],
        [1, 'E2'],
        [2, 'D4'],
      ]),
    )
    v.flushNow()
    expect(host.querySelectorAll('.pn-label').length).toBe(0)
    v.setLabelOpacity(
      new Map([
        [0, 1],
        [1, 0.5],
      ]),
    )
    v.flushNow()
    const labels = [...host.querySelectorAll('.pn-label')] as SVGTextElement[]
    expect(labels.map((l) => l.textContent)).toEqual(['C4', 'E2'])
    const second = labels[1]!
    expect(second.style.opacity).toBe('0.5')
    expect(second.getAttribute('x')).toBe(String(layout.labels[1]!.tx))
    expect(seen.at(-1)).toEqual([0, 1])
    v.setLabelOpacity(
      new Map([
        [0, 1],
        [1, 0.1],
      ]),
    )
    v.flushNow()
    expect(second.style.opacity).toBe('0.1')
    expect(second.isConnected).toBe(true)
    v.setLabelOpacity(new Map([[0, 1]]))
    v.flushNow()
    expect(second.isConnected).toBe(false)
    expect(v.visibleLabels()).toEqual([0])
    v.setLabels(new Map([[0, 'do4']]))
    v.flushNow()
    expect(host.querySelector('.pn-label')!.textContent).toBe('do4')
  })

  it('restores visible labels when a segment is mounted again', () => {
    const { v } = view(80)
    const texts = new Map<number, string>()
    for (let i = 0; i < 160; i++) texts.set(i, 'C4')
    v.setLabels(texts)
    v.setLabelOpacity(new Map([...texts.keys()].map((i) => [i, 1])))
    v.flushNow()
    const before = v.stats().labelNodes
    v.setCursor(70, { smooth: false })
    v.flushNow()
    v.setCursor(0, { smooth: false })
    v.flushNow()
    expect(v.stats().labelNodes).toBe(before)
    expect(v.stats().labelNodes).toBeLessThan(160)
  })
})

describe('StripView passage selection', () => {
  it('shows the band with handles and clears it with the clear button', () => {
    const changes: unknown[] = []
    const { v } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const band = host.querySelector('.pn-loop') as HTMLElement
    expect(band.classList.contains('pn-on')).toBe(true)
    expect(band.style.left).toBe(`${50 + 2 * MEASURE}px`)
    expect(band.style.width).toBe(`${3 * MEASURE}px`)
    ;(host.querySelector('.pn-loop-clear') as HTMLButtonElement).click()
    v.flushNow()
    expect(changes).toEqual([null])
    expect(band.classList.contains('pn-on')).toBe(false)
  })

  it('grows a new band from the cursor and lets the controls fade out before hiding them (U14)', () => {
    const { v } = view(40)
    v.setCursor(2.5, { smooth: false })
    v.setLoop({ fromOcc: 2, toOcc: 3 })
    v.flushNow()
    const band = host.querySelector('.pn-loop') as HTMLElement
    expect(band.classList.contains('pn-loop-enter')).toBe(true)
    // The cursor sits a quarter of the way into bars 3–4 (400 px): the band grows from there.
    expect(parseFloat(band.style.getPropertyValue('--pn-loop-origin'))).toBeGreaterThan(0)
    expect(parseFloat(band.style.getPropertyValue('--pn-loop-origin'))).toBeLessThan(50)
    band.dispatchEvent(new Event('animationend'))
    expect(band.classList.contains('pn-loop-enter')).toBe(false)
    const [start] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    expect(start!.style.display).toBe('')
    // Leaving: the band shrinks, the controls stay displayed while they fade, then hide.
    v.setLoop(null)
    v.flushNow()
    expect(band.classList.contains('pn-loop-leave')).toBe(true)
    expect(band.classList.contains('pn-on')).toBe(false)
    expect(start!.classList.contains('pn-ctl-leave')).toBe(true)
    expect(start!.style.display).toBe('')
    start!.dispatchEvent(new Event('animationend'))
    expect(start!.style.display).toBe('none')
    expect(start!.classList.contains('pn-ctl-leave')).toBe(false)
    // A loop that comes back mid-fade cancels the exit.
    v.setLoop({ fromOcc: 5, toOcc: 6 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    expect(end!.classList.contains('pn-ctl-leave')).toBe(false)
    expect(end!.style.display).toBe('')
  })

  it('always shows the clear button while editable, drawn small in a narrow band (U14)', () => {
    const { v } = view(40)
    v.setLoop({ fromOcc: 2, toOcc: 2 })
    v.setCursor(2.5, { smooth: false }) // on the band's center, where the repeat button sits
    v.setCursorAction(true)
    v.flushNow()
    const clear = host.querySelector('.pn-loop-clear') as HTMLElement
    // One bar of 200 px at zoom 1: the full-size ✕.
    expect(clear.style.visibility).toBe('')
    expect(clear.style.display).toBe('')
    expect(clear.classList.contains('pn-loop-clear-small')).toBe(false)
    // Zoomed out, the band is 100 px on screen: a smaller ✕, still shown.
    v.setZoom(0.5)
    v.flushNow()
    expect(clear.classList.contains('pn-loop-clear-small')).toBe(true)
    expect(clear.style.visibility).toBe('')
    expect(clear.style.display).toBe('')
    // A wider band is full size again.
    v.setLoop({ fromOcc: 2, toOcc: 5 })
    v.flushNow()
    expect(clear.classList.contains('pn-loop-clear-small')).toBe(false)
  })

  it('moves handles by keyboard without inverting and respects the lock', () => {
    const changes: unknown[] = []
    const { v } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 3 })
    v.flushNow()
    const [start, end] = [...host.querySelectorAll('.pn-handle')] as HTMLButtonElement[]
    end!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(changes).toEqual([
      { fromOcc: 2, toOcc: 4 },
      { fromOcc: 3, toOcc: 4 },
      { fromOcc: 4, toOcc: 4 },
    ])
    v.setLoopEditable(false)
    end!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(changes).toHaveLength(3)
  })

  it('selects a passage with two taps in tap mode and seeks on plain taps', () => {
    const loops: unknown[] = []
    const seeks: number[] = []
    const modes: string[] = []
    const { v } = view(40, {
      onLoopChange: (r) => loops.push(r),
      onSeekRequest: (o) => seeks.push(o),
      onLoopSelectModeChange: (m) => modes.push(m),
    })
    const root = host.querySelector('.pn-strip')!
    const tap = (x: number): void => {
      root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: x, clientY: 150, bubbles: true }))
      root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: x, clientY: 150, bubbles: true }))
    }
    tap(210 + 50 + 3 * MEASURE + 10)
    expect(seeks).toEqual([3])
    v.setLoopSelectMode('tap')
    tap(210 + 50 + 3 * MEASURE + 10)
    tap(210 + 50 + 1 * MEASURE + 10)
    expect(loops).toEqual([
      { fromOcc: 3, toOcc: 3 },
      { fromOcc: 1, toOcc: 3 },
    ])
    expect(modes).toEqual(['tap', 'off'])
  })

  it('browses by dragging when enabled and returns to the cursor', () => {
    const browse: boolean[] = []
    const { v } = view(40, { onBrowse: (b) => browse.push(b) })
    const root = host.querySelector('.pn-strip')!
    const content = host.querySelector('.pn-content')!
    const drag = (): void => {
      root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 600, clientY: 150, bubbles: true }))
      root.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
      root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
      v.flushNow()
    }
    drag()
    expect(browse).toEqual([])
    v.setBrowseEnabled(true)
    drag()
    expect(browse).toEqual([true])
    expect(transformX(content)).toBe(210 - 300)
    expect(root.classList.contains('pn-browsing')).toBe(true)
    v.returnToCurrent()
    v.flushNow()
    expect(browse).toEqual([true, false])
    expect(transformX(content)).toBe(210)
  })

  it('resolves the exact onset under the rendered cursor while browsing at a zoom', () => {
    const { v } = view(40)
    const root = host.querySelector('.pn-strip')!
    v.setSnapPositions(halfBarOnsets(40))
    v.setBrowseEnabled(true)
    v.setZoom(1.2)
    v.flushNow()
    expect(v.browsedPosition()).toBeNull()
    root.dispatchEvent(new WheelEvent('wheel', { deltaX: 280 * 1.2, bubbles: true }))
    v.flushNow()
    // The half-bar onset at x=370 is under the line, while the old cursor is still at x=90.
    expect(v.browsedPosition()).toEqual(rat(3, 2))
    // A pending gesture update does not change which note is actually visible yet.
    root.dispatchEvent(new WheelEvent('wheel', { deltaX: 120 * 1.2, bubbles: true }))
    expect(v.browsedPosition()).toEqual(rat(3, 2))
    v.flushNow()
    expect(v.browsedPosition()).toEqual(rat(2))
    v.returnToCurrent()
    v.flushNow()
    expect(v.browsedPosition()).toBeNull()
    expect(transformX(host.querySelector('.pn-content')!) + 90 * 1.2).toBeCloseTo(300)
  })
})

describe('StripView continuous motion and cursor action', () => {
  it('moves the score continuously across barlines while following a transport', () => {
    const { v, layout } = view(40)
    const content = host.querySelector('.pn-content')!
    const cursor = host.querySelector('.pn-cursor')!
    // Constant musical speed: 1/64 whole note per frame from bar 5 to bar 12.
    const tx: number[] = []
    for (let pos = 5; pos <= 12; pos += 1 / 64) {
      v.setCursor(pos, { smooth: false })
      v.flushNow()
      tx.push(transformX(content))
      expect(transformX(cursor)).toBeCloseTo(300, 1)
      if (pos % 0.5 === 0) {
        const occ = layout.occurrences[Math.floor(pos)]!
        const onsetX = occ.x0 + (pos % 1 === 0 ? 40 : 120)
        expect(transformX(content) + onsetX).toBeCloseTo(300, 1)
      }
    }
    const steps = tx.slice(1).map((t, i) => tx[i]! - t)
    // Bar of 200 px: 40 px after the barline to the first onset, 80 px to the second, 80 px to the next
    // barline. Exact, it moved 0 px/frame at the barline then jumped; now no frame moves more than the
    // fastest stretch and the per-frame speed never steps.
    expect(Math.min(...steps)).toBeGreaterThan(0)
    expect(Math.max(...steps)).toBeLessThan(5)
    const accel = steps.slice(1).map((d, i) => Math.abs(d - steps[i]!))
    expect(Math.max(...accel)).toBeLessThan(0.5)
  })

  it('lands exactly on onsets for practice steps and seeks', () => {
    const { v, layout } = view(40)
    const content = host.querySelector('.pn-content')!
    v.setCursor(10.5)
    v.flushNow()
    expect(transformX(content)).toBeCloseTo(300 - (layout.occurrences[10]!.x0 + 120))
    v.setCursor(20, { smooth: false })
    v.flushNow()
    expect(transformX(content)).toBeCloseTo(300 - (layout.occurrences[20]!.x0 + 40))
  })

  it('shows the cursor action button on request, inert while hidden', () => {
    const presses: number[] = []
    const { v } = view(40, { onCursorAction: () => presses.push(1) })
    const btn = host.querySelector<HTMLButtonElement>('.pn-cursor-action')!
    expect(btn.getAttribute('aria-label')).toBe('Repeat from here')
    expect(btn.hasAttribute('inert')).toBe(true)
    btn.click()
    expect(presses).toEqual([])
    v.setCursorAction(true)
    expect(btn.hasAttribute('inert')).toBe(false)
    expect(host.querySelector('.pn-cursor')!.classList.contains('pn-action-on')).toBe(true)
    btn.click()
    expect(presses).toEqual([1])
    // Shown or hidden only: no pressed state.
    expect(btn.hasAttribute('aria-pressed')).toBe(false)
    v.setCursorAction(false)
    expect(btn.getAttribute('aria-label')).toBe('Repeat from here')
    expect(btn.hasAttribute('inert')).toBe(true)
    expect(host.querySelector('.pn-cursor')!.classList.contains('pn-action-on')).toBe(false)
  })

  it('has no cursor action button at all without a handler (Study mode, U72)', () => {
    const { v } = view(40)
    expect(host.querySelector('.pn-cursor-action')).toBeNull()
    v.setCursorAction(true)
    expect(host.querySelector('.pn-cursor-action')).toBeNull()
  })

  it('sits the cursor action button dead center in the gap between the staves', () => {
    const btn = (): HTMLElement => host.querySelector<HTMLElement>('.pn-cursor-action')!
    const mounted = (headY: number | null, zoom = 1): StripView => {
      const layout = testLayout(40)
      if (headY !== null) {
        const n0 = layout.notes[0]!
        ;(layout.notes as unknown as unknown[])[0] = { ...n0, head: { ...n0.head, y: headY } }
      }
      const v = new StripView(host, layout, { initialZoom: zoom, onCursorAction: () => undefined })
      views.push(v)
      v.flushNow()
      v.setCursorAction(true)
      v.flushNow()
      return v
    }
    // Staves 100–140 and 200–240 (layout top 60, ty 40): the gap is screen y 120–180, its
    // center 150 (top 150 − 24).
    const plain = mounted(null)
    expect(btn().style.top).toBe('126px')
    plain.destroy()
    host.innerHTML = ''
    // A note in the gap does not move it.
    mounted(142)
    expect(btn().style.top).toBe('126px')
  })

  it('a tap while browsing seeks to the tapped bar and ends browsing', () => {
    const seeks: number[] = []
    const browse: boolean[] = []
    const { v } = view(40, { onSeekRequest: (occ) => seeks.push(occ), onBrowse: (b) => browse.push(b) })
    const root = host.querySelector('.pn-strip')!
    v.setBrowseEnabled(true)
    root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 600, clientY: 150, bubbles: true }))
    root.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
    root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
    v.flushNow()
    expect(browse).toEqual([true])
    // Content at -90 px: screen x 700 is layout x 790, bar 3.
    root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, clientX: 700, clientY: 150, bubbles: true }))
    root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: 700, clientY: 150, bubbles: true }))
    expect(seeks).toEqual([3])
    expect(browse).toEqual([true, false])
    expect(root.classList.contains('pn-browsing')).toBe(false)
  })

  it('while browsing, the cursor action names the bar under the fixed cursor line and ends browsing', () => {
    const presses: (number | undefined)[] = []
    const browse: boolean[] = []
    const { v } = view(40, { onCursorAction: (occ) => presses.push(occ), onBrowse: (b) => browse.push(b) })
    const root = host.querySelector('.pn-strip')!
    const btn = host.querySelector<HTMLButtonElement>('.pn-cursor-action')!
    v.setCursorAction(true)
    v.setBrowseEnabled(true)
    // Not browsing: the action belongs to the cursor's own position.
    btn.click()
    expect(presses).toEqual([undefined])
    // Browse 300 px to the left: the music under the line (screen x 300) is now layout x 390, bar 2.
    root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 600, clientY: 150, bubbles: true }))
    root.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
    root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 300, clientY: 150, bubbles: true }))
    v.flushNow()
    expect(browse).toEqual([true])
    btn.click()
    expect(presses).toEqual([undefined, 1])
    expect(browse).toEqual([true, false])
    expect(root.classList.contains('pn-browsing')).toBe(false)
  })
})

describe('StripView cursor bar, early tint and loop wrap', () => {
  it('sizes the cursor bar to the staves plus a faded margin, following zoom', () => {
    const { v } = view(40)
    const bar = host.querySelector<HTMLElement>('.pn-cursor-bar')!
    // Zoom 1: content 220 px high centered in 300 px (ty 40); staves 100–240 with layout top 60.
    expect(bar.style.top).toBe(`${40 + (100 - 60) - 96}px`)
    expect(bar.style.height).toBe(`${240 - 100 + 2 * 96}px`)
    // Zoom 1.5: the content (330 px) overflows; the staves' middle is centered (ty −15).
    v.setZoom(1.5)
    v.flushNow()
    expect(bar.style.top).toBe(`${-15 + (100 - 60) * 1.5 - 96}px`)
    expect(bar.style.height).toBe(`${(240 - 100) * 1.5 + 2 * 96}px`)
  })

  it('tints the cursor amber for a too-early press, the wrong tint alongside', () => {
    const { v } = view(40)
    const cursor = host.querySelector('.pn-cursor')!
    v.setEarlyMarker(true)
    v.flushNow()
    expect(cursor.classList.contains('pn-cursor-early')).toBe(true)
    v.setWrongMarker(true)
    v.flushNow()
    // Both set: the CSS lets the wrong tint win.
    expect(cursor.classList.contains('pn-cursor-wrong')).toBe(true)
    v.setEarlyMarker(false)
    v.flushNow()
    expect(cursor.classList.contains('pn-cursor-early')).toBe(false)
  })

  it('pans back to a near loop start with the quick wrap transition', () => {
    const { v, layout } = view(40)
    const root = host.querySelector('.pn-strip')!
    const content = host.querySelector('.pn-content')!
    v.setCursor(10, { smooth: false })
    v.flushNow()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    v.wrapTo(8)
    v.flushNow()
    const target = 300 - (layout.occurrences[8]!.x0 + 40)
    expect(transformX(content)).toBeCloseTo(target)
    expect(root.classList.contains('pn-wrap')).toBe(true)
    expect(root.classList.contains('pn-instant')).toBe(false)
    // The transport reports the same position: no change, the pan keeps running.
    v.setCursor(8, { smooth: false })
    v.flushNow()
    expect(root.classList.contains('pn-wrap')).toBe(true)
    expect(root.classList.contains('pn-instant')).toBe(false)
    // Moving on from there keeps it too; the wrap state ends after the pan.
    v.setCursor(8.01, { smooth: false })
    v.flushNow()
    expect(root.classList.contains('pn-wrap')).toBe(true)
    expect(root.classList.contains('pn-instant')).toBe(false)
    vi.advanceTimersByTime(400)
    expect(root.classList.contains('pn-wrap')).toBe(false)
  })

  it('jumps a far wrap to 1.5 viewports short of the loop start, then pans the rest', () => {
    const { v, layout } = view(40)
    const root = host.querySelector('.pn-strip')!
    const content = host.querySelector('.pn-content')!
    v.setCursor(30, { smooth: false })
    v.flushNow()
    v.wrapTo(2)
    v.flushNow()
    const target = 300 - (layout.occurrences[2]!.x0 + 40)
    // Coming from later in the score, it lands 1.5 viewports (1350 px) later than the target,
    // without a transition, with the target's bars already mounted.
    expect(transformX(content)).toBeCloseTo(target - 1.5 * 900)
    expect(root.classList.contains('pn-instant')).toBe(true)
    expect(root.classList.contains('pn-wrap')).toBe(false)
    expect(host.querySelector('[data-n="4"]')).not.toBeNull()
    // Next frame: the quick pan to the target.
    v.flushNow()
    expect(transformX(content)).toBeCloseTo(target)
    expect(root.classList.contains('pn-wrap')).toBe(true)
    expect(root.classList.contains('pn-instant')).toBe(false)
    // A seek elsewhere ends the wrap.
    v.setCursor(20)
    expect(root.classList.contains('pn-wrap')).toBe(false)
  })
})

describe('StripView sticky context and lifecycle', () => {
  it('shows the sticky clef/key/meter once the opening glyphs scroll away', () => {
    const { v } = view()
    const sticky = host.querySelector('.pn-sticky')!
    expect(sticky.classList.contains('pn-on')).toBe(false)
    v.setCursor(10, { smooth: false })
    v.flushNow()
    expect(sticky.classList.contains('pn-on')).toBe(true)
    expect(sticky.querySelectorAll('.pn-context-staff path').length).toBe(10)
    expect((host.querySelector('.pn-stage') as HTMLElement).style.maskImage).toContain('linear-gradient')
    v.setCursor(0, { smooth: false })
    v.flushNow()
    expect((host.querySelector('.pn-stage') as HTMLElement).style.maskImage).toBe('')
  })

  it('removes everything on destroy', () => {
    const { v } = view()
    v.destroy()
    views = []
    expect(host.children.length).toBe(0)
  })
})

/** Onsets at every bar start and half bar (the synthetic layout's anchors), as exact positions. */
function halfBarOnsets(n: number): Rational[] {
  const out: Rational[] = []
  for (let o = 0; o < n; o++) out.push(rat(o), rat(2 * o + 1, 2))
  return out
}

/** Layout x → client x at the initial scroll (first note at the fixed 300 px anchor). */
const client = (layoutX: number): number => layoutX + 210

function pointer(el: Element, type: string, x: number, id = 7): void {
  el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 150, bubbles: true }))
}

describe('StripView note-level loops (U21)', () => {
  it('draws note-level edges between the edge note and the entry before it', () => {
    const { v, layout } = view(40)
    v.setSnapPositions(halfBarOnsets(40))
    v.setLoop({ fromOcc: 2, toOcc: 4, start: rat(5, 2), end: rat(9, 2) })
    v.flushNow()
    const band = host.querySelector('.pn-loop') as HTMLElement
    const bar2 = layout.occurrences[2]!.x0
    const bar4 = layout.occurrences[4]!.x0
    // Halfway between the bar's first entry (x0 + 40) and the half-bar note (x0 + 120).
    expect(band.style.left).toBe(`${bar2 + 80}px`)
    expect(band.style.width).toBe(`${bar4 + 80 - (bar2 + 80)}px`)
    const [start, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    expect(start!.style.left).toBe(`${bar2 + 80}px`)
    expect(end!.style.left).toBe(`${bar4 + 80}px`)
  })

  it('snaps a dragged handle to note onsets and reports exact edges', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setSnapPositions(halfBarOnsets(40))
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    const bar3 = layout.occurrences[3]!.x0
    pointer(end!, 'pointerdown', client(layout.occurrences[4]!.x1))
    // Near the edge before occurrence 3's half-bar note: the loop ends just before that note.
    pointer(end!, 'pointermove', client(bar3 + 85))
    v.flushNow()
    expect((host.querySelector('.pn-loop') as HTMLElement).style.width).toBe(
      `${bar3 + 80 - layout.occurrences[2]!.x0}px`,
    )
    pointer(end!, 'pointerup', client(bar3 + 85))
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 3, end: rat(7, 2) }])
    // Onto a barline: whole bars again.
    pointer(end!, 'pointerdown', client(bar3 + 80))
    pointer(end!, 'pointermove', client(layout.occurrences[4]!.x0 + 3))
    pointer(end!, 'pointerup', client(layout.occurrences[4]!.x0 + 3))
    expect(changes[1]).toEqual({ fromOcc: 2, toOcc: 3 })
  })

  it('never empties the loop of notes and never inverts', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setSnapPositions(halfBarOnsets(40))
    v.setLoop({ fromOcc: 2, toOcc: 2, end: rat(5, 2) })
    v.flushNow()
    const [start] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    pointer(start!, 'pointerdown', client(layout.occurrences[2]!.x0))
    pointer(start!, 'pointermove', client(layout.occurrences[8]!.x0))
    pointer(start!, 'pointerup', client(layout.occurrences[8]!.x0))
    // The loop's only note is its first bar's downbeat: the start cannot pass it (no change).
    expect(changes).toEqual([])
  })

  it('arrow keys step one note, Shift+arrow one barline', () => {
    const changes: unknown[] = []
    const { v } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setSnapPositions(halfBarOnsets(40))
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [start, end] = [...host.querySelectorAll('.pn-handle')] as HTMLButtonElement[]
    end!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    end!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    start!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(changes).toEqual([
      { fromOcc: 2, toOcc: 5, end: rat(11, 2) },
      { fromOcc: 2, toOcc: 5 },
      { fromOcc: 1, toOcc: 5, start: rat(3, 2) },
    ])
  })
})

describe('StripView playhead drag (U23)', () => {
  function draggable(opts: StripOptions = {}) {
    const seeks: Rational[] = []
    const taps: number[] = []
    const r = view(40, {
      onCursorSeek: (p) => void seeks.push(p),
      onSeekRequest: (o) => taps.push(o),
      cursorDragLabel: (p) => `at ${p.n}/${p.d}`,
      ...opts,
    })
    r.v.setSnapPositions(halfBarOnsets(40))
    r.v.setCursorDraggable(true)
    const grip = host.querySelector('.pn-cursor-grip')!
    const root = host.querySelector('.pn-strip')!
    return { ...r, seeks, taps, grip, root, cursor: host.querySelector('.pn-cursor')! }
  }

  it('scrubs the nearest note under the stationary cursor, shows the readout and seeks on release', () => {
    const { v, layout, seeks, grip, root, cursor } = draggable()
    const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length
    pointer(grip, 'pointerdown', client(90))
    const note = layout.occurrences[2]!.x0 + 120
    for (const dx of [5, 60, 200, note - 90 - 7]) {
      pointer(root, 'pointermove', client(90 + dx))
      v.flushNow()
    }
    // One layout read when the drag starts; none per move.
    expect(vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length - reads).toBe(1)
    expect(root.classList.contains('pn-cursor-dragging')).toBe(true)
    expect(transformX(cursor)).toBe(300)
    expect(host.querySelector('.pn-cursor-readout')!.textContent).toBe('at 5/2')
    // The selected note moves under the fixed bar while dragging.
    expect(transformX(host.querySelector('.pn-content')!) + note).toBe(300)
    pointer(root, 'pointerup', client(note - 7))
    v.flushNow()
    expect(seeks).toEqual([rat(5, 2)])
    expect(root.classList.contains('pn-cursor-dragging')).toBe(false)
  })

  it('a tap on the cursor still seeks to its bar; a refused seek puts the cursor back', () => {
    const { v, seeks, taps, grip, root, cursor } = draggable({ onCursorSeek: () => false })
    pointer(grip, 'pointerdown', client(90))
    pointer(root, 'pointermove', client(94))
    pointer(root, 'pointerup', client(94))
    expect(taps).toEqual([0])
    pointer(grip, 'pointerdown', client(90))
    pointer(root, 'pointermove', client(500))
    v.flushNow()
    expect(transformX(cursor)).toBe(300)
    expect(transformX(host.querySelector('.pn-content')!)).not.toBe(210)
    pointer(root, 'pointerup', client(500))
    v.flushNow()
    expect(seeks).toEqual([])
    expect(transformX(cursor)).toBe(300)
  })

  it('keeps the real position from setCursor while dragging and is off when not draggable', () => {
    const { v, seeks, taps, grip, root, cursor } = draggable()
    pointer(grip, 'pointerdown', client(90))
    pointer(root, 'pointermove', client(400))
    v.setCursor(0.5)
    v.flushNow()
    expect(transformX(cursor)).toBe(300)
    // Disabling (playback started) cancels the drag and restores the real position.
    v.setCursorDraggable(false)
    v.flushNow()
    expect(root.classList.contains('pn-cursor-dragging')).toBe(false)
    expect(transformX(cursor)).toBe(300)
    expect(transformX(host.querySelector('.pn-content')!) + 170).toBe(300)
    pointer(root, 'pointerup', client(400))
    expect(seeks).toEqual([])
    // Not draggable: a press on the cursor is an ordinary tap.
    pointer(grip, 'pointerdown', 300)
    pointer(root, 'pointerup', 300)
    expect(taps).toEqual([0])
  })

  it('arrow keys seek note by note, Shift by bar, Home / End to the ends; off when not draggable', () => {
    const { v, layout, seeks, grip, cursor } = draggable()
    const key = (k: string, shiftKey = false): boolean =>
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }))
    expect(grip.getAttribute('role')).toBe('slider')
    expect(grip.hasAttribute('inert')).toBe(false)
    grip.dispatchEvent(new FocusEvent('focus'))
    expect(grip.getAttribute('aria-valuetext')).toBe('at 0/1')
    expect(key('ArrowRight')).toBe(false) // default prevented
    v.flushNow()
    expect(seeks).toEqual([rat(1, 2)])
    expect(transformX(cursor)).toBe(300)
    expect(transformX(host.querySelector('.pn-content')!) + layout.occurrences[0]!.x0 + 120).toBe(300)
    expect(grip.getAttribute('aria-valuetext')).toBe('at 1/2')
    expect(host.querySelector('.pn-cursor-readout')!.textContent).toBe('at 1/2')
    key('ArrowRight', true)
    key('ArrowRight', true)
    expect(seeks.slice(1)).toEqual([rat(1), rat(2)])
    key('ArrowLeft')
    key('ArrowLeft', true)
    key('ArrowLeft', true)
    expect(seeks.slice(3)).toEqual([rat(3, 2), rat(1), rat(0)])
    key('ArrowLeft') // already at the first onset: nothing to seek
    key('End')
    key('Home')
    expect(seeks.slice(6)).toEqual([rat(79, 2), rat(0)])
    v.flushNow()
    expect(transformX(cursor)).toBe(300)
    expect(grip.getAttribute('aria-valuenow')).toBe('0')
    expect(grip.getAttribute('aria-valuemax')).toBe('79')
    // Playing: the grip is inert (not focusable) and keys do nothing.
    v.setCursorDraggable(false)
    expect(grip.hasAttribute('inert')).toBe(true)
    expect(key('ArrowRight')).toBe(true)
    expect(seeks).toHaveLength(8)
  })

  it('a refused keyboard seek leaves the cursor where it was', () => {
    const { v, seeks, grip, cursor } = draggable({ onCursorSeek: () => false })
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    v.flushNow()
    expect(seeks).toEqual([])
    expect(transformX(cursor)).toBe(300)
  })

  it('a keyboard seek after browsing starts at the visible cursor and restores following', () => {
    const { v, seeks, grip, root } = draggable()
    v.setBrowseEnabled(true)
    root.dispatchEvent(new WheelEvent('wheel', { deltaX: 280, bubbles: true }))
    v.flushNow()
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    v.flushNow()
    expect(seeks).toEqual([rat(1)])
    expect(v.isBrowsing()).toBe(false)
    expect(transformX(host.querySelector('.pn-content')!) + 290).toBe(300)
    v.setCursor(1.5, { smooth: false })
    v.flushNow()
    expect(transformX(host.querySelector('.pn-content')!) + 370).toBe(300)
  })

  it('a refused keyboard seek after browsing preserves the inspected position', () => {
    const { v, grip, root } = draggable({ onCursorSeek: () => false })
    v.setBrowseEnabled(true)
    root.dispatchEvent(new WheelEvent('wheel', { deltaX: 280, bubbles: true }))
    v.flushNow()
    const before = transformX(host.querySelector('.pn-content')!)
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    v.flushNow()
    expect(v.isBrowsing()).toBe(true)
    expect(transformX(host.querySelector('.pn-content')!)).toBe(before)
  })

  it('scrolls the music near the edges while dragging and keeps snapping under the finger', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const { seeks, grip, root } = draggable()
    const content = host.querySelector('.pn-content')!
    pointer(grip, 'pointerdown', client(90))
    pointer(root, 'pointermove', client(880))
    for (let i = 0; i < 20; i++) frames.splice(0).forEach((cb) => cb(0))
    expect(transformX(content)).toBeLessThan(12 - 200)
    pointer(root, 'pointerup', client(880))
    expect(seeks).toHaveLength(1)
    // The note under the finger after scrolling, beyond what was on screen at the start.
    expect(seeks[0]!.n / seeks[0]!.d).toBeGreaterThan(4)
    vi.unstubAllGlobals()
  })
})

describe('StripView teacher corrections', () => {
  const box = (el: Element) => {
    const s = (el as SVGSVGElement).style
    const left = parseFloat(s.left)
    const top = parseFloat(s.top)
    return {
      left,
      top,
      right: left + Number(el.getAttribute('width')),
      bottom: top + Number(el.getAttribute('height')),
    }
  }

  it('draws one red-pen mark per correction around its notes, with its text, staggered left to right', () => {
    const { v, layout } = view(40)
    v.setCorrections([
      { notes: [4], kind: 'early', text: 'Too soon' },
      { notes: [0], kind: 'wrong', text: 'Wrong note' },
      // A chord on both staves: one ring per staff, one text.
      { notes: [2, 3], kind: 'late', text: 'Too late' },
      { notes: [9999], kind: 'wrong', text: 'Wrong note' }, // no geometry: not drawn
    ])
    expect(host.querySelectorAll('.pn-corr')).toHaveLength(0) // built in the next frame
    v.flushNow()
    const marks = [...host.querySelectorAll('.pn-corrs > .pn-corr')]
    expect(marks.map((m) => m.getAttribute('class'))).toEqual([
      'pn-corr pn-corr-wrong',
      'pn-corr pn-corr-late',
      'pn-corr pn-corr-early',
    ])
    expect(marks.map((m) => m.querySelector('.pn-corr-label')!.textContent)).toEqual([
      'Wrong note',
      'Too late',
      'Too soon',
    ])
    expect(marks.map((m) => m.querySelectorAll('.pn-corr-ring').length)).toEqual([1, 2, 1])
    expect(marks.map((m) => (m as SVGSVGElement).style.animationDelay)).toEqual(['', '40ms', '80ms'])
    // Around the notehead, centered on it (content y = layout y − top).
    const head = layout.notes[0]!.head
    const b = box(marks[0]!)
    expect(b.left).toBeLessThan(head.x)
    expect(b.right).toBeGreaterThan(head.x + head.w)
    expect(b.top).toBeLessThan(head.y - layout.top)
    expect(b.bottom).toBeGreaterThan(head.y + head.h - layout.top)
    expect((b.left + b.right) / 2).toBeCloseTo(head.x + head.w / 2)
    // The chord's mark spans both staves' noteheads.
    const chord = box(marks[1]!)
    expect(chord.top).toBeLessThan(layout.notes[2]!.head.y - layout.top)
    expect(chord.bottom).toBeGreaterThan(layout.notes[3]!.head.y + layout.notes[3]!.head.h - layout.top)
    // The same marks again change nothing.
    v.setCorrections([
      { notes: [4], kind: 'early', text: 'Too soon' },
      { notes: [0], kind: 'wrong', text: 'Wrong note' },
      { notes: [2, 3], kind: 'late', text: 'Too late' },
      { notes: [9999], kind: 'wrong', text: 'Wrong note' },
    ])
    v.flushNow()
    expect(host.querySelectorAll('.pn-corr')).toHaveLength(3)
    expect(host.querySelector('.pn-corr-leave')).toBeNull()
  })

  it('clearing fades the marks out and removes them when their animation ends', () => {
    const { v } = view(40)
    v.setCorrections([
      { notes: [0], kind: 'wrong', text: 'Wrong note' },
      { notes: [2], kind: 'late', text: 'Too late' },
    ])
    v.flushNow()
    v.setCorrections([])
    v.flushNow()
    const leaving = [...host.querySelectorAll('.pn-corr')]
    expect(leaving).toHaveLength(2)
    expect(leaving.every((m) => m.classList.contains('pn-corr-leave'))).toBe(true)
    expect(leaving.every((m) => (m as SVGSVGElement).style.animationDelay === '')).toBe(true)
    leaving[0]!.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(host.querySelectorAll('.pn-corr')).toHaveLength(1)
    leaving[1]!.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(host.querySelectorAll('.pn-corr')).toHaveLength(0)
  })

  it('new marks replace the old ones, which leave by the fallback timer without an animationend', () => {
    vi.useFakeTimers()
    const { v } = view(40)
    v.setCorrections([{ notes: [0], kind: 'wrong', text: 'Wrong note' }])
    v.flushNow()
    v.setCorrections([{ notes: [6], kind: 'early', text: 'Too soon' }])
    v.flushNow()
    expect(host.querySelectorAll('.pn-corr')).toHaveLength(2)
    vi.advanceTimersByTime(300)
    const left = [...host.querySelectorAll('.pn-corr')]
    expect(left.map((m) => m.getAttribute('class'))).toEqual(['pn-corr pn-corr-early'])
  })

  /** A label's text box in layout px from its baseline (13 px text in a 16 px row). */
  const labelOf = (mark: Element) => mark.querySelector('.pn-corr-label')
  const baseline = (mark: Element) => Number(labelOf(mark)!.getAttribute('y'))
  const lineOf = (mark: Element, cls: string) => {
    const l = mark.querySelector(`.${cls}`)!
    return ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a)))
  }

  it('every kind is a red-pen mark with its own class and a paper-haloed label', () => {
    const { v } = view(40)
    const kinds = ['wrong', 'early', 'late', 'accidental', 'octave', 'spread', 'tie'] as const
    v.setCorrections(kinds.map((kind, i) => ({ notes: [i * 4], kind, text: kind })))
    v.flushNow()
    const marks = [...host.querySelectorAll('.pn-corr')]
    expect(marks.map((m) => m.getAttribute('class'))).toEqual(kinds.map((k) => `pn-corr pn-corr-${k}`))
    expect(marks.every((m) => m.querySelectorAll('.pn-corr-ring').length === 1)).toBe(true)
    expect(marks.every((m) => labelOf(m)!.getAttribute('class') === 'pn-corr-label pn-corr-halo')).toBe(true)
    expect(marks.map((m) => labelOf(m)!.textContent)).toEqual([...kinds])
  })

  it('labels sit in a band beyond the staves, never over notation, with a leader to the ring', () => {
    const { v, layout } = view(40)
    v.setCorrections([
      { notes: [20], kind: 'wrong', text: 'F♯, not F' }, // top staff
      { notes: [25], kind: 'late', text: 'Too late' }, // bottom staff
      { notes: [30, 31], kind: 'octave', text: 'Wrong octave ↑' }, // both staves: one label
    ])
    v.flushNow()
    const [top, bottom, chord] = [...host.querySelectorAll('.pn-corr')]
    const topHead = layout.notes[20]!.head
    const bottomHead = layout.notes[25]!.head
    // Above the top staff, clear of the noteheads' stems (36 px) and the measure numbers.
    expect(baseline(top!)).toBeLessThan(Math.min(STAVES[0]!.top, topHead.y - 36))
    expect(baseline(top!)).toBeLessThan(layout.occurrences[10]!.labelBox.y)
    expect(labelOf(top!)!.getAttribute('text-anchor')).toBe('middle')
    expect(Number(labelOf(top!)!.getAttribute('x'))).toBeCloseTo(topHead.x + topHead.w / 2)
    // The leader runs down from the label to the ring's top, at the ring's center.
    const [lx1, ly1, lx2, ly2] = lineOf(top!, 'pn-corr-leader')
    expect(lx1).toBeCloseTo(topHead.x + topHead.w / 2)
    expect(lx2).toBe(lx1)
    expect(ly1).toBeGreaterThan(baseline(top!))
    expect(ly2).toBeGreaterThan(ly1!)
    expect(ly2).toBeLessThan(topHead.y)
    // Below the bottom staff for a bottom-staff mark; its leader runs up to the ring.
    expect(baseline(bottom!) - 12).toBeGreaterThanOrEqual(Math.max(STAVES[1]!.bottom, bottomHead.y + bottomHead.h + 36))
    const [, by1, , by2] = lineOf(bottom!, 'pn-corr-leader')
    expect(by1).toBeLessThan(baseline(bottom!))
    expect(by2).toBeLessThan(by1!)
    expect(by2).toBeGreaterThan(bottomHead.y + bottomHead.h)
    // A chord on both staves: two rings share one label, in the top band.
    expect(chord!.querySelectorAll('.pn-corr-ring')).toHaveLength(2)
    expect(chord!.querySelectorAll('.pn-corr-label')).toHaveLength(1)
    expect(baseline(chord!)).toBeLessThan(STAVES[0]!.top)
    // Only a spread chord joins its rings.
    expect(chord!.querySelector('.pn-corr-link')).toBeNull()
    // The mark's box holds its label and rings.
    const b = box(chord!)
    expect(b.top).toBeLessThan(baseline(chord!) - 12 - layout.top)
    expect(b.bottom).toBeGreaterThan(layout.notes[31]!.head.y + layout.notes[31]!.head.h - layout.top)
  })

  it('a label that would overlap another moves one row farther from the staff, up to three rows, then drops', () => {
    const { v } = view(40)
    // Labels far wider than a bar (200 px): each overlaps those to its left in the top band.
    const long = 'x'.repeat(100)
    v.setCorrections([
      { notes: [20], kind: 'wrong', text: long },
      { notes: [22], kind: 'wrong', text: long },
      { notes: [24], kind: 'wrong', text: long },
      { notes: [26], kind: 'wrong', text: long },
      { notes: [23], kind: 'late', text: long }, // bottom staff: its own band
      { notes: [36], kind: 'early', text: 'Too soon' }, // far right: clear of them all
    ])
    v.flushNow()
    const marks = [...host.querySelectorAll('.pn-corr')]
    const byNote = (cls: string, i: number) => marks.filter((m) => m.classList.contains(cls))[i]!
    const top = [0, 1, 2, 3].map((i) => byNote('pn-corr-wrong', i))
    expect(top.slice(0, 3).map((m) => labelOf(m)!.getAttribute('data-row'))).toEqual(['0', '1', '2'])
    // One row (16 px) farther from the staff each time.
    expect(baseline(top[0]!) - baseline(top[1]!)).toBeCloseTo(16)
    expect(baseline(top[1]!) - baseline(top[2]!)).toBeCloseTo(16)
    // No room in three rows: the ring stays without text or leader.
    expect(labelOf(top[3]!)).toBeNull()
    expect(top[3]!.querySelector('.pn-corr-leader')).toBeNull()
    expect(top[3]!.querySelectorAll('.pn-corr-ring')).toHaveLength(1)
    expect(labelOf(byNote('pn-corr-late', 0))!.getAttribute('data-row')).toBe('0')
    expect(labelOf(byNote('pn-corr-early', 0))!.getAttribute('data-row')).toBe('0')
  })

  it('a spread chord across the staves joins its rings with a red line under them', () => {
    const { v, layout } = view(40)
    v.setCorrections([
      { notes: [20, 21], kind: 'spread', text: 'Together' },
      { notes: [30], kind: 'spread', text: 'Together' }, // one staff: one ring, nothing to join
    ])
    v.flushNow()
    const [cross, single] = [...host.querySelectorAll('.pn-corr')]
    const link = cross!.querySelector('.pn-corr-link')!
    // Drawn first: under the rings (and the leader), inside the same mark element.
    expect(cross!.firstElementChild).toBe(link)
    const [x1, y1, x2, y2] = lineOf(cross!, 'pn-corr-link')
    const top = layout.notes[20]!.head
    const bottom = layout.notes[21]!.head
    expect(x1).toBeCloseTo(top.x + top.w / 2)
    expect(x2).toBeCloseTo(bottom.x + bottom.w / 2)
    // From the top ring's edge to the bottom ring's edge, clear of both noteheads.
    expect(y1).toBeGreaterThan(top.y + top.h)
    expect(y2).toBeLessThan(bottom.y)
    expect(y2).toBeGreaterThan(y1!)
    expect(single!.querySelector('.pn-corr-link')).toBeNull()
  })
})

describe('a notehead copied into a neighboring segment', () => {
  /** Note 8 (bar 5, segment 1) also drawn in segment 0, as PF6 copies a measure reaching into it. */
  const withCopy = () => {
    const layout = testLayout(40)
    const s0 = layout.segments[0]!
    const h = layout.notes[8]!.head
    const copy = `<g class="vf-stavenote" data-h="R"><g class="vf-notehead" data-n="8"><path d="M${h.x} ${h.y}h12v10h-12z"></path></g></g>`
    ;(s0 as { svg: string }).svg = s0.svg.replace('</svg>', `${copy}</svg>`)
    return layout
  }

  it('keeps the owner halo when the neighbor holding a copy detaches', () => {
    const v = new StripView(host, withCopy(), {})
    views.push(v)
    v.setCursor(4, { smooth: false })
    v.flushNow()
    v.setTargets([8])
    v.flushNow()
    v.setCursor(10.2, { smooth: false })
    v.flushNow()
    expect(host.querySelector('.pn-seg[data-segment="0"]')).toBeNull()
    expect(host.querySelector('.pn-seg[data-segment="1"] .pn-halo')).not.toBeNull()
  })

  it('draws the halo in the owner segment when the neighbor attaches first', () => {
    const v = new StripView(host, withCopy(), {})
    views.push(v)
    v.setTargets([8])
    v.flushNow()
    expect(host.querySelector('.pn-seg[data-segment="0"] .pn-halo')).toBeNull()
    expect(host.querySelector('.pn-seg[data-segment="1"] .pn-halo')).not.toBeNull()
    expect(host.querySelectorAll('.pn-halo')).toHaveLength(1)
  })

  it('colors the copied notehead too, and clears it', () => {
    const v = new StripView(host, withCopy(), {})
    views.push(v)
    v.flushNow()
    v.setTargets([8])
    v.flushNow()
    const heads = () => [...host.querySelectorAll('[data-n="8"]')]
    expect(heads()).toHaveLength(2)
    expect(heads().every((h) => h.classList.contains('pn-target'))).toBe(true)
    v.setTargets([])
    v.flushNow()
    expect(heads().some((h) => h.classList.contains('pn-target'))).toBe(false)
    expect(host.querySelector('.pn-halo')).toBeNull()
  })

  it('keeps the target halo after browsing ahead and returning', () => {
    const v = new StripView(host, withCopy(), {})
    views.push(v)
    v.setBrowseEnabled(true)
    v.setCursor(4, { smooth: false })
    v.flushNow()
    v.setTargets([8])
    v.flushNow()
    const root = host.querySelector('.pn-strip')!
    const p = (t: string, x: number) =>
      root.dispatchEvent(new PointerEvent(t, { pointerId: 3, clientX: x, clientY: 150, bubbles: true }))
    p('pointerdown', 800)
    p('pointermove', 600)
    p('pointermove', -700)
    p('pointerup', -700)
    v.flushNow()
    v.returnToCurrent()
    v.flushNow()
    expect(host.querySelector('.pn-seg[data-segment="1"] .pn-halo')).not.toBeNull()
  })
})

describe('StripView zoom preference', () => {
  it('counter-scales loop controls at the initial zoom', () => {
    const { v } = view(40, { initialZoom: 1.5 })
    expect(v.zoom()).toBe(1.5)
    expect(host.querySelector<HTMLElement>('.pn-strip')!.style.getPropertyValue('--pn-inv-zoom')).toBe(String(1 / 1.5))
  })

  it('does not report a fit clamp as the user zoom, and restores it when there is room', () => {
    const zooms: number[] = []
    let observe: (() => void) | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observe = cb
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    const { v } = view(40, { initialZoom: 2, onZoomChange: (z) => zooms.push(z) })
    expect(zooms).toEqual([])
    expect(v.zoom()).toBeCloseTo(300 / (240 - 100 + 56))
    const rect = host.getBoundingClientRect()
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ ...rect, height: 600, bottom: 600 })
    observe!()
    expect(v.zoom()).toBe(2)
    expect(zooms).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('StripView loop handle drag', () => {
  it('does not resurrect a loop cleared while a handle is held', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    const p = (t: string, x: number) =>
      end!.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x, clientY: 150, bubbles: true }))
    p('pointerdown', layout.occurrences[4]!.x1 + 210)
    p('pointermove', layout.occurrences[6]!.x1 + 210)
    v.setLoop(null)
    v.setLoopEditable(false)
    p('pointerup', layout.occurrences[6]!.x1 + 210)
    v.flushNow()
    expect(changes).toEqual([])
  })

  it('does not commit a drag when the loop is locked mid-drag', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    const p = (t: string, x: number) =>
      end!.dispatchEvent(new PointerEvent(t, { pointerId: 7, clientX: x, clientY: 150, bubbles: true }))
    p('pointerdown', layout.occurrences[4]!.x1 + 210)
    p('pointermove', layout.occurrences[6]!.x1 + 210)
    v.setLoopEditable(false)
    v.setLoopEditable(true)
    p('pointerup', layout.occurrences[6]!.x1 + 210)
    v.flushNow()
    expect(changes).toEqual([])
    expect(end!.classList.contains('pn-grab')).toBe(false)
  })
  it.each(['pointercancel', 'lostpointercapture'])('does not commit a loop edit after %s', (type) => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const band = host.querySelector('.pn-loop') as HTMLElement
    const width = band.style.width
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    pointer(end!, 'pointerdown', client(layout.occurrences[4]!.x1))
    pointer(end!, 'pointermove', client(layout.occurrences[6]!.x1))
    v.flushNow()
    expect(band.style.width).not.toBe(width)
    pointer(end!, type, client(layout.occurrences[6]!.x1))
    v.flushNow()
    // Canceling a drag keeps the original passage.
    expect(changes).toEqual([])
    expect(band.style.width).toBe(width)
    expect(end!.classList.contains('pn-grab')).toBe(false)
    // A fresh drag on the same handle still works and commits.
    pointer(end!, 'pointerdown', client(layout.occurrences[4]!.x1))
    pointer(end!, 'pointermove', client(layout.occurrences[5]!.x1))
    pointer(end!, 'pointerup', client(layout.occurrences[5]!.x1))
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 5 }])
  })

  it('commits once when the capture is lost after the release', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    pointer(end!, 'pointerdown', client(layout.occurrences[4]!.x1))
    pointer(end!, 'pointermove', client(layout.occurrences[6]!.x1))
    pointer(end!, 'pointerup', client(layout.occurrences[6]!.x1))
    pointer(end!, 'lostpointercapture', client(layout.occurrences[6]!.x1))
    v.flushNow()
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 6 }])
    const band = host.querySelector('.pn-loop') as HTMLElement
    expect(band.style.width).toBe(`${layout.occurrences[6]!.x1 - layout.occurrences[2]!.x0}px`)
  })

  it('follows only the pointer that started the drag', () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 6 })
    v.flushNow()
    const band = host.querySelector('.pn-loop') as HTMLElement
    const width = band.style.width
    const [start, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    pointer(start!, 'pointerdown', client(layout.occurrences[2]!.x0), 7)
    // A second finger on the end handle changes nothing while the start is held.
    pointer(end!, 'pointerdown', client(layout.occurrences[6]!.x1), 8)
    pointer(end!, 'pointermove', client(layout.occurrences[3]!.x1), 8)
    v.flushNow()
    expect(band.style.width).toBe(width)
    pointer(end!, 'pointerup', client(layout.occurrences[3]!.x1), 8)
    expect(changes).toEqual([])
    expect(start!.classList.contains('pn-grab')).toBe(true)
    // The first finger moves and commits the start edge.
    pointer(start!, 'pointermove', client(layout.occurrences[3]!.x0), 7)
    pointer(start!, 'pointerup', client(layout.occurrences[3]!.x0), 7)
    expect(changes).toEqual([{ fromOcc: 3, toOcc: 6 }])
  })

  it("another pointer's cancel does not end the active drag", () => {
    const changes: unknown[] = []
    const { v, layout } = view(40, { onLoopChange: (r) => changes.push(r) })
    v.setLoop({ fromOcc: 2, toOcc: 4 })
    v.flushNow()
    const [, end] = [...host.querySelectorAll('.pn-handle')] as HTMLElement[]
    pointer(end!, 'pointerdown', client(layout.occurrences[4]!.x1), 7)
    pointer(end!, 'pointermove', client(layout.occurrences[6]!.x1), 7)
    pointer(end!, 'pointercancel', client(layout.occurrences[6]!.x1), 8)
    pointer(end!, 'lostpointercapture', client(layout.occurrences[6]!.x1), 8)
    expect(end!.classList.contains('pn-grab')).toBe(true)
    pointer(end!, 'pointerup', client(layout.occurrences[6]!.x1), 7)
    expect(changes).toEqual([{ fromOcc: 2, toOcc: 6 }])
  })
})
