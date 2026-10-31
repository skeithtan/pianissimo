/**
 * Teacher's corrections drawing (red-pen rings, `setCorrections`), shared by page mode.
 *
 * COPIED from `strip/StripView.ts` (`correctionShape`, `buildCorrection`, `penRing`) without
 * changing the strip, which another change is editing; deduplicate once both settle (the strip
 * should then import this module). Keep the look identical: `--danger` (via `.pn-corr-*` in
 * strip.css), 2.5 px, one ring per staff around the notes' union box + 10 px, rotated −3°, the
 * text above-right of the top ring.
 */
import type { PreparedLayout } from '../types'

export interface CorrectionMark {
  readonly notes: readonly number[]
  readonly kind: 'wrong' | 'early' | 'late'
  readonly text: string
}

/** Space between the corrected notes' box and the red ring around them (layout px). */
export const CORRECTION_PAD = 10
/** The correction rings' entrance is staggered left to right by this much per ring (ms). */
export const CORRECTION_STAGGER_MS = 40
/** Fading corrections leave on `animationend`, or by this fallback (strip.css: 200 ms). */
export const CORRECTION_LEAVE_MS = 260

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface CorrectionShape {
  readonly mark: CorrectionMark
  readonly rings: readonly { cx: number; cy: number; rx: number; ry: number }[]
  /** Text baseline start, above-right of the top ring. */
  readonly tx: number
  readonly ty: number
  /** Box of the rings (the text may overflow it), layout px. */
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** Stable identity of a set of marks (the same marks again are a no-op). */
export function correctionsKey(marks: readonly CorrectionMark[]): string {
  return marks.map((m) => `${m.kind}:${m.notes.join(',')}:${m.text}`).join('|')
}

/**
 * One ring per staff the mark's notes are on, around their noteheads' union box plus
 * `CORRECTION_PAD`. In page mode a mark's notes are one group, so they share a system; the
 * staff key includes the system so a mark spanning two systems still never draws one ring over
 * the gap between them.
 */
export function correctionShape(layout: PreparedLayout, mark: CorrectionMark): CorrectionShape | null {
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>()
  for (const n of mark.notes) {
    const g = layout.notes[n]
    if (!g) continue
    const key = `${g.system ?? 0}:${g.staff}`
    const b = boxes.get(key)
    const { x, y, w, h } = g.head
    if (!b) boxes.set(key, { x0: x, y0: y, x1: x + w, y1: y + h })
    else {
      b.x0 = Math.min(b.x0, x)
      b.y0 = Math.min(b.y0, y)
      b.x1 = Math.max(b.x1, x + w)
      b.y1 = Math.max(b.y1, y + h)
    }
  }
  if (boxes.size === 0) return null
  const rings = [...boxes.values()]
    .sort((a, b) => a.y0 - b.y0)
    .map((b) => {
      const rx = ((b.x1 - b.x0) / 2) * 1.15 + CORRECTION_PAD
      const ry = ((b.y1 - b.y0) / 2) * 1.15 + CORRECTION_PAD
      return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx, ry }
    })
  const top = rings[0]!
  const tx = top.cx + top.rx * 0.55
  const ty = top.cy - top.ry - 3
  const x0 = Math.min(...rings.map((r) => r.cx - r.rx)) - 4
  const x1 = Math.max(...rings.map((r) => r.cx + r.rx)) + 4
  const y0 = ty - 14
  const y1 = Math.max(...rings.map((r) => r.cy + r.ry)) + 4
  return { mark, rings, tx, ty, x0, y0, x1, y1 }
}

/** The mark's own small SVG in layout px (content y = layout y − `top`). */
export function buildCorrection(doc: Document, shape: CorrectionShape, top: number, delayMs: number): SVGSVGElement {
  const w = r2(shape.x1 - shape.x0)
  const h = r2(shape.y1 - shape.y0)
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', `pn-corr pn-corr-${shape.mark.kind}`)
  svg.setAttribute('viewBox', `${r2(shape.x0)} ${r2(shape.y0)} ${w} ${h}`)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.style.left = `${r2(shape.x0)}px`
  svg.style.top = `${r2(shape.y0 - top)}px`
  if (delayMs > 0) svg.style.animationDelay = `${delayMs}ms`
  for (const ring of shape.rings) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', 'pn-corr-ring')
    path.setAttribute('d', penRing(ring.cx, ring.cy, ring.rx, ring.ry))
    path.setAttribute('transform', `rotate(-3 ${r2(ring.cx)} ${r2(ring.cy)})`)
    svg.append(path)
  }
  const text = doc.createElementNS(SVG_NS, 'text')
  text.setAttribute('class', 'pn-corr-label')
  text.setAttribute('x', String(r2(shape.tx)))
  text.setAttribute('y', String(r2(shape.ty)))
  text.textContent = shape.mark.text
  svg.append(text)
  return svg
}

/**
 * A ring as a red pen draws it: one stroke a little more than once around, its radius growing
 * slightly so the ends overlap without meeting. Six elliptical arcs.
 */
export function penRing(cx: number, cy: number, rx: number, ry: number): string {
  const steps = 6
  const start = (-150 * Math.PI) / 180
  const sweep = 2 * Math.PI + 0.45
  const at = (k: number): { x: number; y: number; s: number } => {
    const s = 0.95 + (0.09 * k) / steps
    const a = start - (sweep * k) / steps
    return { x: cx + rx * s * Math.cos(a), y: cy + ry * s * Math.sin(a), s }
  }
  const p0 = at(0)
  let d = `M${r2(p0.x)} ${r2(p0.y)}`
  for (let k = 1; k <= steps; k++) {
    const p = at(k)
    const s = (at(k - 1).s + p.s) / 2
    d += `A${r2(rx * s)} ${r2(ry * s)} 0 0 0 ${r2(p.x)} ${r2(p.y)}`
  }
  return d
}

export function r2(v: number): number {
  return Math.round(v * 100) / 100
}
