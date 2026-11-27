/**
 * Quiet reminders (`setReminders`) for both views: geometry and drawing. A highlighter swipe behind
 * the noteheads of a place that went wrong recently, one per staff of the place, slanted like a
 * chisel-tip marker; a `firm` place gets a second, stronger pass. The layer sits under the
 * engraving, so every glyph stays on top. Opaque highlighter hues, never the score's ink and never
 * a glyph, so it cannot be read as an engraved marking (U167). Never interactive. Built once per
 * `setReminders`, nothing per frame.
 */
import type { NoteGeometry, PreparedLayout } from '../types'

/** A quiet reminder at a place that went wrong recently: a highlighter swipe behind its notes. */
export interface ReminderMark {
  /** Performed-note indices of the place (the view's note ids). */
  readonly notes: readonly number[]
  /** `firm`: the place went wrong in two of its last three visits. */
  readonly level: 'faint' | 'firm'
}

/** One highlighter pass in layout px, before its slant and tilt. */
export interface ReminderPass {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** Padding of a pass around the noteheads of one staff (layout px). */
const PAD_X = 5
const PAD_Y = 3
/** The firm second pass sits a little lower and to the right of the first (layout px from the heads). */
const SECOND = { left: 2, top: 1.5, right: 7, bottom: 4 }
/** The chisel tip: the top edge shifts right and the bottom edge left by this much (layout px). */
export const REMINDER_SLANT = 2.5
/** Each staff's passes are drawn rotated by this many degrees about the noteheads' center. */
export const REMINDER_TILT = -4
/** Room in the element's box for the slant and the tilt (layout px). */
const MARGIN = 4
/** Fading reminders leave on `animationend`, or by this fallback (strip.css: 180 ms). */
export const REMINDER_LEAVE_MS = 220

export interface ReminderShape {
  readonly mark: ReminderMark
  readonly system: number
  /** Horizontal center of the mark's noteheads (layout px). */
  readonly cx: number
  /** One pass per staff of the place, top to bottom. */
  readonly passes: readonly ReminderPass[]
  /** `firm` only: the second pass over each of `passes`, same order. */
  readonly second: readonly ReminderPass[]
  /** The element's box in layout px, holding every pass with its slant and tilt. */
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** Stable identity of a set of reminder marks (the same set again is a no-op). */
export function remindersKey(marks: readonly ReminderMark[]): string {
  return marks.map((m) => `${m.level}:${m.notes.join(',')}`).join('|')
}

/**
 * The shapes of `marks` in drawing order (by system, then left to right). Unknown notes are
 * skipped; a mark with no mapped notes produces nothing. A mark split across systems (page mode)
 * is drawn on its first one.
 */
export function layoutReminders(layout: PreparedLayout, marks: readonly ReminderMark[]): ReminderShape[] {
  const shapes: ReminderShape[] = []
  for (const mark of marks) {
    const shape = reminderShape(layout, mark)
    if (shape) shapes.push(shape)
  }
  return shapes.sort((a, b) => a.system - b.system || a.cx - b.cx)
}

function reminderShape(layout: PreparedLayout, mark: ReminderMark): ReminderShape | null {
  const found: NoteGeometry[] = []
  for (const n of mark.notes) {
    const g = layout.notes[n]
    if (g) found.push(g)
  }
  if (found.length === 0) return null
  const system = Math.min(...found.map((g) => g.system ?? 0))

  const byStaff = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  for (const g of found) {
    if ((g.system ?? 0) !== system) continue
    const { x, y, w, h } = g.head
    const b = byStaff.get(g.staff)
    if (!b) byStaff.set(g.staff, { x0: x, y0: y, x1: x + w, y1: y + h })
    else {
      b.x0 = Math.min(b.x0, x)
      b.y0 = Math.min(b.y0, y)
      b.x1 = Math.max(b.x1, x + w)
      b.y1 = Math.max(b.y1, y + h)
    }
  }
  const heads = [...byStaff.values()].sort((a, b) => a.y0 - b.y0)
  const passes = heads.map((h) => ({ x0: h.x0 - PAD_X, y0: h.y0 - PAD_Y, x1: h.x1 + PAD_X, y1: h.y1 + PAD_Y }))
  const second =
    mark.level === 'firm'
      ? heads.map((h) => ({
          x0: h.x0 - SECOND.left,
          y0: h.y0 - SECOND.top,
          x1: h.x1 + SECOND.right,
          y1: h.y1 + SECOND.bottom,
        }))
      : []
  const all = [...passes, ...second]
  const pad = MARGIN + REMINDER_SLANT
  return {
    mark,
    system,
    cx: (Math.min(...heads.map((h) => h.x0)) + Math.max(...heads.map((h) => h.x1))) / 2,
    passes,
    second,
    x0: Math.min(...all.map((p) => p.x0)) - pad,
    y0: Math.min(...all.map((p) => p.y0)) - pad,
    x1: Math.max(...all.map((p) => p.x1)) + pad,
    y1: Math.max(...all.map((p) => p.y1)) + pad,
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The mark's own small SVG in layout px (content y = layout y − `top`); strip.css fills the passes. */
export function buildReminder(doc: Document, shape: ReminderShape, top: number): SVGSVGElement {
  const w = r2(shape.x1 - shape.x0)
  const h = r2(shape.y1 - shape.y0)
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', `pn-reminder pn-reminder-${shape.mark.level}`)
  svg.setAttribute('viewBox', `${r2(shape.x0)} ${r2(shape.y0)} ${w} ${h}`)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  svg.style.left = `${r2(shape.x0)}px`
  svg.style.top = `${r2(shape.y0 - top)}px`
  shape.passes.forEach((pass, i) => {
    const g = doc.createElementNS(SVG_NS, 'g')
    g.setAttribute(
      'transform',
      `rotate(${REMINDER_TILT} ${r2((pass.x0 + pass.x1) / 2)} ${r2((pass.y0 + pass.y1) / 2)})`,
    )
    g.append(chisel(doc, pass, 'pn-reminder-pass'))
    const second = shape.second[i]
    if (second) g.append(chisel(doc, second, 'pn-reminder-second'))
    svg.append(g)
  })
  return svg
}

/** A pass as a chisel tip draws it: a box whose top edge leans right of its bottom edge. */
function chisel(doc: Document, p: ReminderPass, cls: string): SVGPolygonElement {
  const s = REMINDER_SLANT
  const el = doc.createElementNS(SVG_NS, 'polygon')
  el.setAttribute('class', cls)
  el.setAttribute(
    'points',
    `${r2(p.x0 + s)},${r2(p.y0)} ${r2(p.x1 + s)},${r2(p.y0)} ${r2(p.x1 - s)},${r2(p.y1)} ${r2(p.x0 - s)},${r2(p.y1)}`,
  )
  return el
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
