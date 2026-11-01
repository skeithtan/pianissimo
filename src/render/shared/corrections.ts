/**
 * Teacher's corrections (U39, `setCorrections`) for both views: geometry and drawing. The strip
 * and the page share this module, so both follow the same contract: a hand-drawn red ring (one
 * pen stroke, rotated −3°) per staff around each mark's noteheads, one text per mark in a band
 * beyond the staves of its system (never on notation or on another label), a 2.5 px link
 * between the rings of a `'spread'` mark and "Ped." before a `'pedal'` mark's text. Strip
 * layouts have one implicit system (`layout.staves`); page layouts key everything by system and
 * use that system's staves and marks only. Built once per `setCorrections`, nothing per frame.
 */
import { LABEL_FONT_FAMILY, LABEL_FONT_WEIGHT, type TextMeasurer } from '../labels/metrics'
import type { Box, PreparedLayout, StaffGeometry } from '../types'

/**
 * A teacher's correction after an attempt: a red-pen ring around `notes` (performed-note indices,
 * the view's note ids) with a short text in a band beyond the staves ("Wrong note", "F♯, not F",
 * "Wrong octave ↑", "Together", "Tied, hold it", "Pedal", "Too soon", "Too late"). Every kind is
 * drawn in the same red pen and named by a class (`pn-corr-<kind>`); a `'spread'` mark across
 * staves also joins its rings, a `'pedal'` mark puts "Ped." before its text.
 */
export interface CorrectionMark {
  readonly notes: readonly number[]
  readonly kind: 'wrong' | 'early' | 'late' | 'accidental' | 'octave' | 'spread' | 'tie' | 'pedal'
  readonly text: string
}

/** Space between the corrected notes' box and the red ring around them (layout px). */
export const CORRECTION_PAD = 10
/** The correction rings' entrance is staggered left to right by this much per ring (ms). */
export const CORRECTION_STAGGER_MS = 40
/** Fading corrections leave on `animationend`, or by this fallback (strip.css: 200 ms). */
export const CORRECTION_LEAVE_MS = 260
/** Correction text (strip.css `.pn-corr-label`: 13 px semibold in the label font). */
const CORRECTION_FONT = `${LABEL_FONT_WEIGHT} 13px ${LABEL_FONT_FAMILY}`
/** One row of correction labels in the band beyond the staves (layout px). */
const CORRECTION_ROW_H = 16
/** Rows a correction label may move away from the staff to clear another; beyond, no text. */
const CORRECTION_ROWS = 3
/** Clearance beyond the nearby noteheads for their stems and beams (layout px). */
const CORRECTION_STEM_CLEAR = 36
/** Clearance from staff lines, the mark's ring, measure numbers and note names (layout px). */
const CORRECTION_GAP = 4
/** Horizontal space kept between two correction labels in one row (layout px). */
const CORRECTION_LABEL_GAP = 6
/** Drawn before a pedal mark's text. */
const PEDAL_GLYPH = 'Ped.'

const SVG_NS = 'http://www.w3.org/2000/svg'

interface XYBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface CorrectionRing {
  /** The system holding the ring's notes (0 on the strip). */
  readonly system: number
  readonly staff: number
  readonly cx: number
  readonly cy: number
  readonly rx: number
  readonly ry: number
}

interface CorrectionRings extends Readonly<XYBox> {
  readonly mark: CorrectionMark
  /** Top to bottom; the box is theirs (layout px). */
  readonly rings: readonly CorrectionRing[]
}

interface CorrectionLabel {
  /** 0 nearest the staff. */
  readonly row: number
  readonly box: Readonly<XYBox>
  /** Text anchor (middle) and baseline. */
  readonly x: number
  readonly y: number
  readonly pedal: boolean
  /** Vertical leader from the label box (y1) to the ring's edge (y2). */
  readonly leader: { readonly x: number; readonly y1: number; readonly y2: number }
}

interface CorrectionLink {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

export interface CorrectionShape extends CorrectionRings {
  /** Null when no row had room: the ring stays without text. */
  readonly label: CorrectionLabel | null
  readonly links: readonly CorrectionLink[]
}

/** Stable identity of a set of marks (the same marks again are a no-op). */
export function correctionsKey(marks: readonly CorrectionMark[]): string {
  return marks.map((m) => `${m.kind}:${m.notes.join(',')}:${m.text}`).join('|')
}

/**
 * The shapes of `marks` in drawing order (by system, then left to right): rings, label and links.
 * O(marks × layout marks), once per call.
 */
export function layoutCorrections(
  layout: PreparedLayout,
  marks: readonly CorrectionMark[],
  measurer: TextMeasurer,
): CorrectionShape[] {
  const rings = marks
    .map((m) => correctionRings(layout, m))
    .filter((r): r is CorrectionRings => r !== null)
    .sort((a, b) => a.rings[0]!.system - b.rings[0]!.system || a.x0 - b.x0)
  return placeLabels(layout, rings, measurer)
}

/**
 * One ring per staff the mark's notes are on (a chord across both staves is not one tall ring
 * over the gap between them), around their noteheads' union box plus `CORRECTION_PAD`, top to
 * bottom. The key includes the system, so a mark never draws one ring over two lines of a page.
 */
function correctionRings(layout: PreparedLayout, mark: CorrectionMark): CorrectionRings | null {
  const boxes = new Map<string, XYBox & { system: number; staff: number }>()
  for (const n of mark.notes) {
    const g = layout.notes[n]
    if (!g) continue
    const system = g.system ?? 0
    const key = `${system}:${g.staff}`
    const b = boxes.get(key)
    const { x, y, w, h } = g.head
    if (!b) boxes.set(key, { system, staff: g.staff, x0: x, y0: y, x1: x + w, y1: y + h })
    else {
      b.x0 = Math.min(b.x0, x)
      b.y0 = Math.min(b.y0, y)
      b.x1 = Math.max(b.x1, x + w)
      b.y1 = Math.max(b.y1, y + h)
    }
  }
  if (boxes.size === 0) return null
  const rings = [...boxes.values()]
    .map((b) => {
      // Slightly beyond the box's half sizes, so a chord's outer noteheads stay inside.
      const rx = ((b.x1 - b.x0) / 2) * 1.15 + CORRECTION_PAD
      const ry = ((b.y1 - b.y0) / 2) * 1.15 + CORRECTION_PAD
      return { system: b.system, staff: b.staff, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx, ry }
    })
    .sort((a, b) => a.cy - b.cy)
  return {
    mark,
    rings,
    x0: Math.min(...rings.map((r) => r.cx - r.rx)),
    y0: Math.min(...rings.map((r) => r.cy - r.ry)),
    x1: Math.max(...rings.map((r) => r.cx + r.rx)),
    y1: Math.max(...rings.map((r) => r.cy + r.ry)),
  }
}

/** The staves of `system` (page) or of the strip. */
function stavesOf(layout: PreparedLayout, system: number): readonly StaffGeometry[] {
  return layout.systems?.[system]?.staves ?? layout.staves
}

/**
 * Places each mark's text (one per mark, so a chord's rings on both staves share one) in a band
 * beyond the staves of its system, never over notation: above the top staff when the mark's top
 * ring is on the upper half of the staves, else below the bottom staff; centered on its nearest
 * ring, with a leader to the ring's edge. Row 0 clears the nearby notation (`bandEdge`). Left to
 * right, a label whose box would overlap one already placed in its band moves one row farther
 * from the staff, up to `CORRECTION_ROWS` rows; beyond, its text is dropped and the ring stays.
 * A spread chord across staves also gets a connector between its rings.
 */
function placeLabels(
  layout: PreparedLayout,
  marks: readonly CorrectionRings[],
  measurer: TextMeasurer,
): CorrectionShape[] {
  const placed = new Map<string, XYBox[]>()
  return marks.map((m) => {
    const system = m.rings[0]!.system
    const own = m.rings.filter((r) => r.system === system)
    const staves = stavesOf(layout, system)
    const pos = staves.findIndex((s) => s.index === own[0]!.staff)
    const side = pos < staves.length / 2 ? 'above' : 'below'
    const ring = side === 'above' ? own[0]! : own[own.length - 1]!
    const pedal = m.mark.kind === 'pedal'
    const w = measurer.width(pedal ? `${PEDAL_GLYPH} ${m.mark.text}` : m.mark.text, CORRECTION_FONT)
    const lx0 = ring.cx - w / 2
    const lx1 = ring.cx + w / 2
    const edge = bandEdge(layout, staves, side, ring, lx0, lx1)
    const bandKey = `${system}:${side}`
    let band = placed.get(bandKey)
    if (!band) placed.set(bandKey, (band = []))
    let label: CorrectionLabel | null = null
    for (let row = 0; row < CORRECTION_ROWS && !label; row++) {
      const y0 = side === 'above' ? edge - (row + 1) * CORRECTION_ROW_H : edge + row * CORRECTION_ROW_H
      const box = { x0: lx0, y0, x1: lx1, y1: y0 + CORRECTION_ROW_H }
      if (band.some((b) => boxesOverlap(b, box, CORRECTION_LABEL_GAP))) continue
      band.push(box)
      // The pen ring's radius runs from 0.95 to 1.04 times the ellipse: the leader meets it.
      const ringEdge = side === 'above' ? ring.cy - ring.ry * 0.95 : ring.cy + ring.ry * 0.95
      label = {
        row,
        box,
        x: ring.cx,
        y: y0 + 12,
        pedal,
        leader: { x: ring.cx, y1: side === 'above' ? box.y1 : box.y0, y2: ringEdge },
      }
    }
    const links: CorrectionLink[] = []
    if (m.mark.kind === 'spread') {
      for (let i = 1; i < m.rings.length; i++) {
        const link = ringLink(m.rings[i - 1]!, m.rings[i]!)
        if (link) links.push(link)
      }
    }
    const pad = 4
    return {
      ...m,
      label,
      links,
      x0: Math.min(m.x0, label?.box.x0 ?? Infinity) - pad,
      y0: Math.min(m.y0, label?.box.y0 ?? Infinity) - pad,
      x1: Math.max(m.x1, label?.box.x1 ?? -Infinity) + pad,
      y1: Math.max(m.y1, label?.box.y1 ?? -Infinity) + pad,
    }
  })
}

/**
 * Where a correction label's band starts beside the staves (layout px; the box edge nearest the
 * staff): beyond the top (bottom) staff line, the mark's own ring, measure numbers, ottava
 * brackets and note names over the label's width, and the nearby noteheads by
 * `CORRECTION_STEM_CLEAR` (their stems and beams). Only marks of the ring's system count (page
 * mode: by `system`, ottavas by their y extent). Nothing finer is known of the engraving.
 */
function bandEdge(
  L: PreparedLayout,
  staves: readonly StaffGeometry[],
  side: 'above' | 'below',
  ring: CorrectionRing,
  lx0: number,
  lx1: number,
): number {
  const staff = side === 'above' ? staves[0] : staves[staves.length - 1]
  const sys = L.systems?.[ring.system]
  const near = (b: Box) => b.x < lx1 + CORRECTION_GAP && b.x + b.w > lx0 - CORRECTION_GAP
  const onStaff = (s: number) => staff === undefined || s === staff.index
  const inSystem = (system: number | undefined) => !sys || (system ?? 0) === ring.system
  const occIn = (occ: number) => inSystem(L.occurrences[occ]?.system)
  const boxIn = (b: Box) => !sys || (b.y < sys.y1 && b.y + b.h > sys.y0)
  if (side === 'above') {
    let edge = Math.min(staff?.top ?? Infinity, ring.cy - ring.ry) - CORRECTION_GAP
    for (const g of L.notes) {
      if (g && onStaff(g.staff) && inSystem(g.system) && near(g.head))
        edge = Math.min(edge, g.head.y - CORRECTION_STEM_CLEAR)
    }
    for (const l of L.labels) {
      if (onStaff(l.staff) && occIn(l.occ) && near(l.box)) edge = Math.min(edge, l.box.y - CORRECTION_GAP)
    }
    for (const o of L.occurrences) {
      if (inSystem(o.system) && near(o.labelBox)) edge = Math.min(edge, o.labelBox.y - CORRECTION_GAP)
    }
    for (const o of L.ottavas) {
      if (o && onStaff(o.staff) && boxIn(o.box) && near(o.box)) edge = Math.min(edge, o.box.y - CORRECTION_GAP)
    }
    return edge
  }
  let edge = Math.max(staff?.bottom ?? -Infinity, ring.cy + ring.ry) + CORRECTION_GAP
  for (const g of L.notes) {
    if (g && onStaff(g.staff) && inSystem(g.system) && near(g.head))
      edge = Math.max(edge, g.head.y + g.head.h + CORRECTION_STEM_CLEAR)
  }
  for (const l of L.labels) {
    if (onStaff(l.staff) && occIn(l.occ) && near(l.box)) edge = Math.max(edge, l.box.y + l.box.h + CORRECTION_GAP)
  }
  for (const o of L.ottavas) {
    if (o && onStaff(o.staff) && boxIn(o.box) && near(o.box)) edge = Math.max(edge, o.box.y + o.box.h + CORRECTION_GAP)
  }
  return edge
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
  const line = (cls: string, x1: number, y1: number, x2: number, y2: number) => {
    const el = doc.createElementNS(SVG_NS, 'line')
    el.setAttribute('class', cls)
    el.setAttribute('x1', String(r2(x1)))
    el.setAttribute('y1', String(r2(y1)))
    el.setAttribute('x2', String(r2(x2)))
    el.setAttribute('y2', String(r2(y2)))
    svg.append(el)
  }
  // Under the rings: the cross-staff connector, then the label's leader.
  for (const k of shape.links) line('pn-corr-link', k.x1, k.y1, k.x2, k.y2)
  const label = shape.label
  if (label) line('pn-corr-leader', label.leader.x, label.leader.y1, label.leader.x, label.leader.y2)
  for (const ring of shape.rings) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', 'pn-corr-ring')
    path.setAttribute('d', penRing(ring.cx, ring.cy, ring.rx, ring.ry))
    path.setAttribute('transform', `rotate(-3 ${r2(ring.cx)} ${r2(ring.cy)})`)
    svg.append(path)
  }
  if (label) {
    const text = doc.createElementNS(SVG_NS, 'text')
    text.setAttribute('class', 'pn-corr-label pn-corr-halo')
    text.setAttribute('x', String(r2(label.x)))
    text.setAttribute('y', String(r2(label.y)))
    text.setAttribute('text-anchor', 'middle')
    text.dataset.row = String(label.row)
    if (label.pedal) {
      const ped = doc.createElementNS(SVG_NS, 'tspan')
      ped.setAttribute('class', 'pn-corr-ped')
      ped.textContent = PEDAL_GLYPH
      text.append(ped, ` ${shape.mark.text}`)
    } else text.textContent = shape.mark.text
    svg.append(text)
  }
  return svg
}

/** Whether two boxes overlap, with `gap` kept between them horizontally. */
function boxesOverlap(a: Readonly<XYBox>, b: Readonly<XYBox>, gap: number): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 && b.y0 < a.y1
}

/**
 * The connector between two rings of one mark: along the line joining their centers, from the
 * edge of one ellipse to the edge of the other (so it crosses no notehead). Null when they touch.
 */
function ringLink(a: CorrectionRing, b: CorrectionRing): CorrectionLink | null {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const ta = 1 / Math.hypot(dx / a.rx, dy / a.ry)
  const tb = 1 / Math.hypot(dx / b.rx, dy / b.ry)
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta + tb >= 1) return null
  return { x1: a.cx + dx * ta, y1: a.cy + dy * ta, x2: b.cx - dx * tb, y2: b.cy - dy * tb }
}

/**
 * A ring as a red pen draws it: one stroke a little more than once around, its radius growing
 * slightly so the ends overlap without meeting. Six elliptical arcs; nothing per frame.
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

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
