/**
 * Respacing animation (DECISIONS R3 revised, user): when Labels switch between Off and a mode that
 * shows names, the score is engraved again with or without room for them, and the notes move to
 * their new places instead of the score jumping. Both views use it (strip, page).
 *
 * The music of the wider engraving (more spacing) is cut into one vertical slice per note column
 * (onset), each a small SVG holding copies of the marks it overlaps, clipped to the slice. Every
 * slice glides rigidly from where its column was drawn by the old view to where the new view
 * draws it. The new view anchors its cursor note where the old one was (the strip's cursor line
 * is fixed; the page scrolls to keep the cursor's line in place), so the music around the cursor
 * opens up or closes in from there. Cutting the wider engraving means neighboring slices overlap
 * while they are closer than in that engraving and never leave a gap in the staff lines.
 *
 * Note names ride along with their notes and fade during the glide: in when the new engraving is
 * the wider one (names turned on), out when the old one is (names turned off), so nothing waits
 * for a fade before or after the motion. The overlay exists only for the glide (≈ 0.4 s); the
 * view hides its own notation meanwhile. Built once, then compositor transforms only.
 */
import type { PreparedLayout } from '../types'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Glide duration (ms). */
export const RESPACE_MS = 420

const EASE_STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)'

/** The app's standard easing (`--ease-standard`) as seen from `el`. */
export function standardEasing(el: Element): string {
  try {
    return getComputedStyle(el).getPropertyValue('--ease-standard').trim() || EASE_STANDARD
  } catch {
    return EASE_STANDARD
  }
}

/** Groups at most this wide (layout px) are copied whole; wider ones are copied child by child. */
const PIECE_W = 30

/** Layout px → view px (relative to the view's root): `x · scale + dx`, `y · scale + dy`. */
export interface ScreenFrame {
  readonly scale: number
  readonly dx: number
  readonly dy: number
}

/** One engraved mark (or narrow group) of a mounted segment, with its layout x extent. */
export interface Piece {
  readonly el: Element
  /** Ancestors between the segment's root `svg` and `el`, outermost first (copied shallow). */
  readonly chain: readonly Element[]
  readonly x0: number
  readonly x1: number
  /** Text: rides whole with the column where it starts instead of being cut into columns. */
  readonly whole?: boolean
  /** A note name or its leader (whole, by its center; fades during the glide). */
  readonly label?: boolean
}

/** What a view hands to the next one before it goes away. */
export interface RespaceSnapshot {
  readonly layout: PreparedLayout
  readonly frame: ScreenFrame
  /** The old view's notation by segment, when its engraving is the wider one (else null). */
  readonly pieces: ReadonlyMap<number, readonly Piece[]> | null
}

/** The mounted segment parts the pieces come from (both views' `MountedSegment` satisfy it). */
export interface PieceSource {
  readonly index: number
  readonly music: SVGSVGElement
  readonly over: SVGSVGElement
}

/** One note column of the source engraving. */
export interface Slice {
  readonly occ: number
  /** Source segment (whose pieces fill the slice). */
  readonly segment: number
  /** Clip box in source layout px. */
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  /** The column's anchor (onset x, staff top of its line) in the source layout. */
  readonly ax: number
  readonly ay: number
  /** The same column in the other layout. */
  readonly bx: number
  readonly by: number
}

/** The engraving to cut: the one with more spacing (the old one on a tie). */
export function wider(prev: PreparedLayout, next: PreparedLayout): 'prev' | 'next' {
  return next.params.spacing.voiceSpacingMultiplier > prev.params.spacing.voiceSpacingMultiplier ? 'next' : 'prev'
}

/** x of an offset (whole notes) within a bar, interpolated between its onset anchors. */
function xAtOffset(anchors: readonly (readonly [number, number])[], offset: number, fallback: number): number {
  for (let k = 0; k < anchors.length; k++) {
    const [p, x] = anchors[k]!
    if (Math.abs(p - offset) < 1e-9) return x
    if (p > offset) {
      if (k === 0) return x
      const [p0, x0] = anchors[k - 1]!
      return x0 + ((offset - p0) / (p - p0)) * (x - x0)
    }
  }
  return anchors.at(-1)?.[1] ?? fallback
}

/** Line (system) of a bar, the staff top of that line and its extent; the strip is one line. */
export function lineOf(layout: PreparedLayout, occ: number): { system: number; top: number; y0: number; y1: number } {
  const system = layout.occurrences[occ]?.system
  const s = system === undefined ? undefined : layout.systems?.[system]
  if (s) return { system: s.index, top: s.staves[0]?.top ?? s.y0, y0: s.y0, y1: s.y1 }
  return { system: 0, top: layout.staves[0]?.top ?? layout.top, y0: layout.top, y1: layout.top + layout.height }
}

/**
 * The note columns of bars [occ0, occ1) in `src`, matched to `other` by bar and onset (pure).
 * A column spans halfway to its neighbors; a bar's first and last columns reach its barlines, and
 * a line's first and last bars reach the line's ends (clefs, key signatures, the final barline).
 */
export function columnSlices(
  src: PreparedLayout,
  other: PreparedLayout,
  occ0: number,
  occ1: number,
  segmentOf: (occ: number) => number,
): Slice[] {
  const out: Slice[] = []
  const occs = src.occurrences
  for (let o = Math.max(0, occ0); o < Math.min(occs.length, occ1); o++) {
    const g = occs[o]!
    const og = other.occurrences[o]
    if (!og) continue
    const line = lineOf(src, o)
    const otherLine = lineOf(other, o)
    const first = o === 0 || lineOf(src, o - 1).system !== line.system
    const last = o === occs.length - 1 || lineOf(src, o + 1).system !== line.system
    const cols = g.anchors.filter(([p]) => p < g.duration - 1e-9)
    if (!cols.length) cols.push([0, g.x0])
    for (let k = 0; k < cols.length; k++) {
      const [pos, x] = cols[k]!
      const left = k > 0 ? (cols[k - 1]![1] + x) / 2 : first ? Math.min(0, g.x0) : g.x0
      const right = k < cols.length - 1 ? (x + cols[k + 1]![1]) / 2 : last ? Math.max(src.width, g.x1) : g.x1
      out.push({
        occ: o,
        segment: segmentOf(o),
        x0: left,
        x1: right,
        y0: line.y0,
        y1: line.y1,
        ax: x,
        ay: line.top,
        bx: xAtOffset(og.anchors, pos, og.x0),
        by: otherLine.top,
      })
    }
  }
  return out
}

/** Screen corner of a slice drawn in `frame`, its column anchored at layout (px, py) there. */
export function sliceCorner(s: Slice, frame: ScreenFrame, px: number, py: number): { x: number; y: number } {
  return {
    x: frame.dx + (px + (s.x0 - s.ax)) * frame.scale,
    y: frame.dy + (py + (s.y0 - s.ay)) * frame.scale,
  }
}

/**
 * The marks of mounted segments, by segment: every child of the notation, the measure numbers
 * and the visible note names, descending into groups wider than `PIECE_W` so a copy holds only
 * what a column overlaps. Reads `getBBox` once per element visited (bounded by what is mounted).
 */
export function collectPieces(segments: Iterable<PieceSource>): Map<number, Piece[]> {
  const out = new Map<number, Piece[]>()
  for (const seg of segments) {
    const list: Piece[] = []
    const walk = (parent: Element, chain: readonly Element[], label = false): void => {
      for (const el of parent.children) {
        // Names: their own pieces, without the group (the view hides that group while gliding).
        if (el.classList.contains('pn-labels')) {
          walk(el, chain, true)
          continue
        }
        let b: { x: number; width: number; height: number }
        try {
          b = (el as SVGGraphicsElement).getBBox()
        } catch {
          continue
        }
        if (b.width === 0 && b.height === 0 && el.tagName !== 'g') continue
        if (el.tagName === 'g' && el.childElementCount > 0 && b.width > PIECE_W) walk(el, [...chain, el], label)
        else {
          const kind = label ? { whole: true, label: true } : el.tagName === 'text' ? { whole: true } : {}
          list.push({ el, chain, x0: b.x, x1: b.x + b.width, ...kind })
        }
      }
    }
    walk(seg.music, [])
    walk(seg.over, [])
    out.set(seg.index, list)
  }
  return out
}

/**
 * The slices to draw for one segment: each column with copies of the marks it overlaps, clipped
 * to it, and each text whole in a slice of its own that moves with the column where it starts (a
 * name, with the column of its center; a copy of a text belonging to a neighboring segment is left
 * to that segment).
 */
function segmentSlices(doc: Document, slices: readonly Slice[], pieces: readonly Piece[]): [Slice, SVGSVGElement][] {
  const out: [Slice, SVGSVGElement][] = []
  const cut = pieces.filter((p) => !p.whole)
  for (const s of slices) {
    const el = sliceSvg(doc, s, cut)
    if (el) out.push([s, el])
  }
  const first = slices[0]
  const last = slices.at(-1)
  if (!first || !last) return out
  for (const p of pieces) {
    const at = p.label ? (p.x0 + p.x1) / 2 : p.x0
    if (!p.whole || at < first.x0 || at >= last.x1) continue
    const owner = slices.find((s) => at < s.x1) ?? last
    const s: Slice = { ...owner, x0: p.x0 - 2, x1: p.x1 + 2 }
    const el = sliceSvg(doc, s, [p])
    if (el) out.push([s, el])
  }
  return out
}

/** A slice's SVG: copies of the pieces it overlaps (with their ancestor groups), clipped to it. */
function sliceSvg(doc: Document, s: Slice, pieces: readonly Piece[]): SVGSVGElement | null {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  const w = s.x1 - s.x0
  const h = s.y1 - s.y0
  svg.setAttribute('class', 'pn-music pn-respace-slice')
  svg.setAttribute('viewBox', `${s.x0} ${s.y0} ${w} ${h}`)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  const copies = new Map<Element, Element>()
  const parentFor = (chain: readonly Element[]): Element => {
    let parent: Element = svg
    for (const a of chain) {
      let c = copies.get(a)
      if (!c) {
        c = a.cloneNode(false) as Element
        copies.set(a, c)
        parent.append(c)
      }
      parent = c
    }
    return parent
  }
  let n = 0
  for (const p of pieces) {
    if (p.x1 <= s.x0 || p.x0 >= s.x1) continue
    const copy = p.el.cloneNode(true) as Element
    if (p.label) copy.classList.add('pn-respace-label')
    parentFor(p.chain).append(copy)
    n++
  }
  return n ? svg : null
}

export interface RespaceRun {
  /** Ends the glide now (the view shows its own notation again). */
  cancel(): void
}

export interface RespaceOptions {
  readonly prev: RespaceSnapshot
  readonly next: { readonly layout: PreparedLayout; readonly frame: ScreenFrame }
  /** The new view's pieces (used when its engraving is the wider one). */
  readonly nextPieces: () => ReadonlyMap<number, readonly Piece[]>
  readonly segmentOf: { readonly prev: (occ: number) => number; readonly next: (occ: number) => number }
  /** Where the overlay goes: appended to `parent`, before `before` when given. */
  readonly parent: HTMLElement
  readonly before?: Element | null
  /** The view's size (px), for leaving out slices that stay offscreen. */
  readonly width: number
  readonly height: number
  readonly easing: string
  readonly duration?: number
  readonly onDone: () => void
}

/**
 * Builds the overlay and starts the glide. Returns null when there is nothing to animate (no
 * slice on screen, no Web Animations); the caller then just shows the new engraving.
 */
export function startRespace(o: RespaceOptions): RespaceRun | null {
  const doc = o.parent.ownerDocument
  const cutPrev = wider(o.prev.layout, o.next.layout) === 'prev'
  const src = cutPrev ? o.prev.layout : o.next.layout
  const other = cutPrev ? o.next.layout : o.prev.layout
  const pieces = cutPrev ? o.prev.pieces : o.nextPieces()
  if (!pieces || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return null
  const segmentOf = cutPrev ? o.segmentOf.prev : o.segmentOf.next
  const slices = columnSlices(src, other, 0, src.occurrences.length, segmentOf)

  const overlay = doc.createElement('div')
  // Names belong to the wider engraving: they fade in with it (turned on) or out with it (off).
  overlay.className = cutPrev ? 'pn-respace pn-respace-out' : 'pn-respace pn-respace-in'
  overlay.setAttribute('aria-hidden', 'true')
  const margin = Math.max(o.width, o.height) * 0.25
  const onScreen = (x: number, y: number, w: number, h: number): boolean =>
    x < o.width + margin && x + w > -margin && y < o.height + margin && y + h > -margin
  const animations: Animation[] = []
  // Corners in the old view (`prev` frame) and the new one, each with the column at its place there.
  const corners = (s: Slice): { from: { x: number; y: number }; to: { x: number; y: number } } => ({
    from: cutPrev ? sliceCorner(s, o.prev.frame, s.ax, s.ay) : sliceCorner(s, o.prev.frame, s.bx, s.by),
    to: cutPrev ? sliceCorner(s, o.next.frame, s.bx, s.by) : sliceCorner(s, o.next.frame, s.ax, s.ay),
  })
  const bySegment = new Map<number, Slice[]>()
  for (const s of slices) {
    const { from, to } = corners(s)
    const w = (s.x1 - s.x0) * Math.max(o.prev.frame.scale, o.next.frame.scale)
    const h = (s.y1 - s.y0) * Math.max(o.prev.frame.scale, o.next.frame.scale)
    if (!onScreen(from.x, from.y, w, h) && !onScreen(to.x, to.y, w, h)) continue
    const list = bySegment.get(s.segment)
    if (list) list.push(s)
    else bySegment.set(s.segment, [s])
  }
  const t = (p: { x: number; y: number }, scale: number): string =>
    `translate3d(${Math.round(p.x * 100) / 100}px, ${Math.round(p.y * 100) / 100}px, 0) scale(${scale})`
  const pending: { el: SVGSVGElement; from: string; to: string }[] = []
  for (const [segment, segSlices] of bySegment) {
    const segPieces = pieces.get(segment)
    if (!segPieces) continue
    for (const [s, el] of segmentSlices(doc, segSlices, segPieces)) {
      const { from, to } = corners(s)
      pending.push({ el, from: t(from, o.prev.frame.scale), to: t(to, o.next.frame.scale) })
    }
  }
  if (!pending.length) return null
  for (const p of pending) {
    p.el.style.transform = p.from
    overlay.append(p.el)
  }
  o.parent.insertBefore(overlay, o.before ?? null)

  let ended = false
  const duration = o.duration ?? RESPACE_MS
  const end = (): void => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    for (const a of animations) a.cancel()
    overlay.remove()
    o.onDone()
  }
  for (const p of pending) {
    const a = p.el.animate([{ transform: p.from }, { transform: p.to }], {
      duration,
      easing: o.easing,
      fill: 'forwards',
    })
    animations.push(a)
  }
  animations[0]?.finished?.then(end, () => undefined)
  // A throttled or hidden page may never finish the animations: end on time anyway.
  const timer = setTimeout(end, duration + 120)
  return { cancel: end }
}
