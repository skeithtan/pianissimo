/**
 * Mounted notation segments (spec "Execution and rendering architecture": retain only the
 * viewport plus about one viewport of notation on each side, with a bounded cache). Segments
 * leaving the window are detached into a small LRU (re-attaching avoids re-parsing when the
 * player scrolls back); older ones are dropped entirely.
 */
import type { PreparedLayout, SegmentData } from '../types'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface MountedSegment {
  readonly index: number
  readonly data: SegmentData
  readonly el: HTMLDivElement
  readonly music: SVGSVGElement
  readonly over: SVGSVGElement
  /** Behind the notation: halos and rings. */
  readonly marks: SVGGElement
  /** Above the notation: labels and leaders. */
  readonly labels: SVGGElement
  /** Note index → notehead group. */
  readonly heads: Map<number, Element>
  /** Ottava span → bracket parts. */
  readonly ottava: Map<number, Element[]>
  /** Element count at mount (notation + measure numbers). */
  readonly nodes: number
}

export interface SegmentHooks {
  /** Called after a segment is attached (fresh or from the LRU): apply current state to it. */
  attached(seg: MountedSegment): void
  /** Called before a segment is detached. */
  detaching(seg: MountedSegment): void
}

export class SegmentStore {
  readonly mounted = new Map<number, MountedSegment>()
  private readonly detached = new Map<number, MountedSegment>()
  private readonly segOfOcc: Int32Array
  private readonly tpl: HTMLTemplateElement
  parsed = 0

  constructor(
    private readonly layout: PreparedLayout,
    private readonly container: HTMLElement,
    private readonly hooks: SegmentHooks,
    private readonly lruSize = 4,
  ) {
    this.segOfOcc = new Int32Array(layout.occurrences.length).fill(-1)
    for (const s of layout.segments) for (let o = s.occStart; o < s.occEnd; o++) this.segOfOcc[o] = s.index
    this.tpl = container.ownerDocument.createElement('template')
  }

  segmentOfOcc(occ: number): number {
    return this.segOfOcc[occ] ?? -1
  }

  /** Segments intersecting [x0, x1] (layout px), nearest to `focus` first. */
  wanted(x0: number, x1: number, focus: number): number[] {
    const segs = this.layout.segments
    const out: number[] = []
    let lo = 0
    let hi = segs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid]!.x1 < x0) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < segs.length && segs[i]!.x0 <= x1; i++) out.push(i)
    const dist = (i: number): number => {
      const s = segs[i]!
      return focus < s.x0 ? s.x0 - focus : focus > s.x1 ? focus - s.x1 : 0
    }
    return out.sort((a, b) => dist(a) - dist(b))
  }

  /**
   * Mounts the wanted segments and releases the rest. `required` segments (visible now) are
   * mounted regardless of `budget`; the others at most `budget` per call (bounded work slices).
   * Returns true when everything wanted is mounted.
   */
  sync(wanted: readonly number[], required: ReadonlySet<number>, budget: number): boolean {
    const keep = new Set(wanted)
    for (const [i, seg] of this.mounted) if (!keep.has(i)) this.release(seg)
    let done = true
    for (const i of wanted) {
      if (this.mounted.has(i)) continue
      const cheap = this.detached.has(i)
      if (!required.has(i) && !cheap && budget <= 0) {
        done = false
        continue
      }
      if (!cheap && !required.has(i)) budget--
      this.attach(i)
    }
    return done
  }

  private attach(i: number): void {
    let seg = this.detached.get(i)
    if (seg) this.detached.delete(i)
    else seg = this.build(i)
    this.container.append(seg.el)
    this.mounted.set(i, seg)
    this.hooks.attached(seg)
  }

  private release(seg: MountedSegment): void {
    this.hooks.detaching(seg)
    seg.el.remove()
    this.mounted.delete(seg.index)
    this.detached.delete(seg.index)
    this.detached.set(seg.index, seg)
    while (this.detached.size > this.lruSize) {
      const oldest = this.detached.keys().next().value as number
      this.detached.delete(oldest)
    }
  }

  private build(i: number): MountedSegment {
    const data = this.layout.segments[i]!
    const doc = this.container.ownerDocument
    this.tpl.innerHTML = data.svg
    const music = this.tpl.content.firstElementChild as SVGSVGElement
    this.tpl.content.replaceChildren()
    this.parsed++

    const marks = doc.createElementNS(SVG_NS, 'g')
    marks.setAttribute('class', 'pn-marks')
    music.insertBefore(marks, music.firstChild)

    const over = doc.createElementNS(SVG_NS, 'svg')
    over.setAttribute('class', 'pn-over')
    for (const a of ['viewBox', 'width', 'height']) over.setAttribute(a, music.getAttribute(a) ?? '')
    const numbers = doc.createElementNS(SVG_NS, 'g')
    for (let o = data.occStart; o < data.occEnd; o++) {
      const occ = this.layout.occurrences[o]!
      const t = doc.createElementNS(SVG_NS, 'text')
      t.setAttribute('class', 'pn-mnum')
      t.setAttribute('x', String(occ.labelBox.x + 1))
      t.setAttribute('y', String(occ.labelBox.y + 10))
      t.textContent = occ.label
      numbers.append(t)
    }
    const labels = doc.createElementNS(SVG_NS, 'g')
    over.append(numbers, labels)

    const heads = new Map<number, Element>()
    for (const el of music.querySelectorAll('[data-n]')) {
      for (const n of (el.getAttribute('data-n') ?? '').split(' ')) heads.set(Number(n), el)
    }
    const ottava = new Map<number, Element[]>()
    for (const el of music.querySelectorAll('[data-o]')) {
      const span = Number(el.getAttribute('data-o'))
      const list = ottava.get(span)
      if (list) list.push(el)
      else ottava.set(span, [el])
    }

    const el = doc.createElement('div')
    el.className = 'pn-seg'
    el.style.left = `${data.x0 - 1}px`
    el.dataset['segment'] = String(i)
    el.append(music, over)
    const nodes = music.getElementsByTagName('*').length + data.occEnd - data.occStart + 2
    return { index: i, data, el, music, over, marks, labels, heads, ottava, nodes }
  }

  /** Mounted DOM elements (notation, measure numbers, live labels and marks). */
  mountedNodes(): number {
    let n = 0
    for (const s of this.mounted.values()) n += s.nodes + s.labels.childElementCount + s.marks.childElementCount
    return n
  }

  cachedCount(): number {
    return this.detached.size
  }

  cachedBytes(): number {
    let n = 0
    for (const s of this.detached.values()) n += s.data.svg.length
    return n
  }

  destroy(): void {
    for (const seg of this.mounted.values()) seg.el.remove()
    this.mounted.clear()
    this.detached.clear()
  }
}
