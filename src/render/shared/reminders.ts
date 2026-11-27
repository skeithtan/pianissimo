/**
 * Quiet pencil reminders (`setReminders`) for both views: geometry and drawing. A small symmetric
 * pencil caret in the margin band beyond the staves of its system, pointing at the staff ("v"
 * above, mirrored below), horizontally centered on the union of the mark's noteheads, clear of
 * the staves, stems, note names, measure numbers and ottavas (reusing `bandEdge` from
 * `corrections.ts`). Never touches the notation; never interactive. Built once per `setReminders`,
 * nothing per frame.
 */
import type { NoteGeometry, PreparedLayout } from '../types'
import { bandEdge, stavesOf } from './corrections'

/** A quiet reminder at a place that went wrong recently: a pencil caret beyond the staves. */
export interface ReminderMark {
  /** Performed-note indices of the place (the view's note ids). */
  readonly notes: readonly number[]
  /** `firm`: the place went wrong in two of its last three visits. */
  readonly level: 'faint' | 'firm'
}

/** Caret height in layout px. */
export const REMINDER_TICK_H = 6.5
/** Single caret horizontal half-width in layout px (total width 6 px). */
const TICK_HALF_W = 3
/** Horizontal spacing between the two carets of a `firm` double mark (layout px). */
const DOUBLE_TICK_GAP = 8
/** SVG viewBox padding around the strokes so round caps never clip (layout px). */
const TICK_PAD = 2
/** Fading reminders leave on `animationend`, or by this fallback (strip.css: 180 ms). */
export const REMINDER_LEAVE_MS = 220

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface ReminderShape {
  readonly mark: ReminderMark
  readonly system: number
  readonly side: 'above' | 'below'
  /** Horizontal center of the mark's noteheads (layout px). */
  readonly cx: number
  /** Vertical extent of the tick itself (layout px; `tickY1 - tickY0 === REMINDER_TICK_H`). */
  readonly tickY0: number
  readonly tickY1: number
  /** SVG bounding box in layout px (includes stroke cap padding). */
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  /** One `<path>` `d` string for `faint`, two side-by-side strokes for `firm`. */
  readonly strokes: readonly string[]
}

/** Stable identity of a set of reminder marks (the same set again is a no-op). */
export function remindersKey(marks: readonly ReminderMark[]): string {
  return marks.map((m) => `${m.level}:${m.notes.join(',')}`).join('|')
}

/**
 * The shapes of `marks` in drawing order (by system, then left to right). Unknown notes are
 * skipped; a mark with no mapped notes produces nothing. Two close ticks on the same side of the
 * same system are both kept without stacking rows.
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
  found.sort((a, b) => (a.system ?? 0) - (b.system ?? 0) || a.head.y - b.head.y)
  const system = found[0]!.system ?? 0
  const own = found.filter((g) => (g.system ?? 0) === system)

  let hx0 = Infinity
  let hx1 = -Infinity
  for (const g of own) {
    hx0 = Math.min(hx0, g.head.x)
    hx1 = Math.max(hx1, g.head.x + g.head.w)
  }
  const cx = (hx0 + hx1) / 2

  const staves = stavesOf(layout, system)
  // Above the top staff when any note is on the upper half (including a two-staff chord);
  // below the bottom staff only when all notes are on the bottom half.
  let minPos = Infinity
  for (const g of own) {
    const pos = staves.findIndex((s) => s.index === g.staff)
    if (pos >= 0 && pos < minPos) minPos = pos
  }
  const side: 'above' | 'below' = minPos < staves.length / 2 || minPos === Infinity ? 'above' : 'below'

  const centers = mark.level === 'firm' ? [cx - DOUBLE_TICK_GAP / 2, cx + DOUBLE_TICK_GAP / 2] : [cx]
  const tx0 = centers[0]! - TICK_HALF_W
  const tx1 = centers[centers.length - 1]! + TICK_HALF_W

  const edge = bandEdge(layout, staves, side, system, tx0, tx1)
  const tickY0 = side === 'above' ? edge - REMINDER_TICK_H : edge
  const tickY1 = tickY0 + REMINDER_TICK_H
  const strokes = centers.map((sx) => pencilCaret(sx, tickY0, side))

  return {
    mark,
    system,
    side,
    cx,
    tickY0,
    tickY1,
    x0: tx0 - TICK_PAD,
    y0: tickY0 - TICK_PAD,
    x1: tx1 + TICK_PAD,
    y1: tickY1 + TICK_PAD,
    strokes,
  }
}

/**
 * One small symmetric pencil caret (`2 * TICK_HALF_W` = 6 px wide, `REMINDER_TICK_H` = 6.5 px
 * tall) pointing at the staff: a "v" with its apex at the bottom when above the staff, mirrored
 * with its apex at the top when below. Slight quadratic softening gives a light penciled feel.
 */
function pencilCaret(sx: number, y0: number, side: 'above' | 'below'): string {
  const xL = r2(sx - TICK_HALF_W)
  const xR = r2(sx + TICK_HALF_W)
  const xA = r2(sx)
  const c1x = r2(sx - 1.3)
  const c2x = r2(sx + 1.4)
  if (side === 'above') {
    const yTop = r2(y0)
    const yBot = r2(y0 + REMINDER_TICK_H)
    return `M${xL} ${yTop}Q${c1x} ${r2(y0 + 3.4)} ${xA} ${yBot}Q${c2x} ${r2(y0 + 3.3)} ${xR} ${yTop}`
  }
  const yTop = r2(y0)
  const yBot = r2(y0 + REMINDER_TICK_H)
  return `M${xL} ${yBot}Q${c1x} ${r2(y0 + 3.1)} ${xA} ${yTop}Q${c2x} ${r2(y0 + 3.2)} ${xR} ${yBot}`
}

/** The mark's own small SVG in layout px (content y = layout y − `top`). */
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
  for (const d of shape.strokes) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', 'pn-reminder-stroke')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

function r2(v: number): number {
  return Math.round(v * 100) / 100
}
