/**
 * Mounted systems for page mode (spec "Execution and rendering architecture": retain only the
 * viewport plus about one viewport of notation on each side, with a bounded cache). A copy of
 * the strip's `SegmentStore` (strip/segments.ts) adapted to vertical systems: segments are
 * found by page y, placed at their page `y0`, and only the bar opening each system shows its
 * measure number. Keep the two in step until they are deduplicated.
 */
import { SEAM } from '../partition'
import type { PreparedLayout, SegmentData } from '../types'
import type { MountedSegment, SegmentHooks } from '../strip/segments'

const SVG_NS = 'http://www.w3.org/2000/svg'

export type { MountedSegment, SegmentHooks } from '../strip/segments'

export class PageSegmentStore {
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

  /** Segments intersecting page y [y0, y1] (layout px), nearest to `focus` first. */
  wanted(y0: number, y1: number, focus: number): number[] {
    const segs = this.layout.segments
    const top = (s: SegmentData): number => s.y0 ?? 0
    const bottom = (s: SegmentData): number => s.y1 ?? 0
    const out: number[] = []
    let lo = 0
    let hi = segs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (bottom(segs[mid]!) < y0) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < segs.length && top(segs[i]!) <= y1; i++) out.push(i)
    const dist = (i: number): number => {
      const s = segs[i]!
      return focus < top(s) ? top(s) - focus : focus > bottom(s) ? focus - bottom(s) : 0
    }
    return out.sort((a, b) => dist(a) - dist(b))
  }

  /** As `SegmentStore.sync`: required segments always, others at most `budget` new parses. */
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
    // Page mode: the measure number of the bar opening the system only.
    const occ = this.layout.occurrences[data.occStart]
    if (occ) {
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
    // The viewBox starts SEAM px before the segment: place the element the same way.
    el.style.left = `${data.x0 - SEAM}px`
    el.style.top = `${(data.y0 ?? 0) - this.layout.top}px`
    el.dataset['segment'] = String(i)
    el.dataset['system'] = String(data.system ?? i)
    el.append(music, over)
    const nodes = music.getElementsByTagName('*').length + 3
    return { index: i, data, el, music, over, marks, labels, heads, ottava, nodes }
  }

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
