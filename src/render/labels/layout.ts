/**
 * Collision-aware note-label layout (spec "Persistent score labels", layout paragraph; "Mistake
 * feedback and hints": chord labels never cover noteheads, ledger lines or accidentals).
 *
 * Every label unit (one per graphical notehead) receives a reserved box of the worst-case label
 * size, so revealing labels never reflows the music (DECISIONS R3). Preference order per unit:
 *  1. beside its own notehead, vertically centered (right, then left; small x nudges past dots or
 *     ledger lines) — `right` / `left`;
 *  2. a half-height stagger above/below that still reads as belonging to that notehead —
 *     `stagger`;
 *  3. a compact stack slightly further out with a short leader line — `stack`;
 *  4. a callout above/below the staff with a leader (always succeeds; adds vertical label
 *     space) — `callout`. Callouts count as failures that ask the adapter to widen spacing.
 * Labels are never omitted or shrunk.
 */
import { BoxGrid, bottom, centerY, right } from '../geom'
import type { Box, LabelBox, LabelPlacement, StaffGeometry } from '../types'
import type { Hand } from '../../core/model/score'

export interface LabelUnitInput {
  readonly notes: readonly number[]
  readonly occ: number
  readonly staff: number
  readonly hand: Hand
  /** Notehead box (union for a shared notehead). */
  readonly head: Box
  /** Onset x (staff-entry x): heads of one staff with the same x form a column. */
  readonly x: number
}

export interface LabelLayoutInput {
  readonly units: readonly LabelUnitInput[]
  /** Every engraved mark labels must not cover (noteheads, accidentals, stems, …; not staff lines). */
  readonly obstacles: readonly Box[]
  readonly staves: readonly StaffGeometry[]
  readonly labelW: number
  readonly labelH: number
  readonly fontPx: number
  /** Gap between notehead and label (default 2). */
  readonly gap?: number
}

export type LabelDraft = Omit<LabelBox, 'id'>

export interface LabelLayoutResult {
  /** Same order as `units`. */
  readonly labels: readonly LabelDraft[]
  /** Units that needed a callout. */
  readonly failures: readonly number[]
  /**
   * Suggested horizontal spacing factor (≥ 1) that would let failed labels sit beside their
   * notes: the 90th percentile of required / available column gaps. 1 when nothing failed.
   */
  readonly spacingDemand: number
  readonly placements: Readonly<Record<LabelPlacement, number>>
}

interface Candidate {
  readonly box: Box
  readonly placement: LabelPlacement
  readonly anchor: 'start' | 'end' | 'middle'
  readonly leader: boolean
}

export function layoutLabels(input: LabelLayoutInput): LabelLayoutResult {
  const { labelW: w, labelH: h, fontPx } = input
  const gap = input.gap ?? 2
  const grid = new BoxGrid<Box>(64)
  for (const o of input.obstacles) grid.add(o)

  const order = input.units
    .map((_, i) => i)
    .sort((a, b) => {
      const ua = input.units[a]!
      const ub = input.units[b]!
      return ua.x - ub.x || ua.staff - ub.staff || ua.head.y - ub.head.y
    })
  const columns = columnIndex(input.units)
  const columnXs = staffColumnXs(input.units)
  const out: (LabelDraft | undefined)[] = new Array(input.units.length)
  const failures: number[] = []
  const ratios: number[] = []
  const placements: Record<LabelPlacement, number> = { right: 0, stagger: 0, left: 0, stack: 0, callout: 0 }

  for (const i of order) {
    const u = input.units[i]!
    const column = columns.get(columnKey(u)) ?? [i]
    let placed: Candidate | undefined
    for (const c of candidates(u.head, w, h, gap)) {
      if (grid.hit(c.box)) continue
      if (c.placement === 'stagger' && !ownsStagger(c.box, i, column, input.units)) continue
      placed = c
      break
    }
    if (!placed) {
      placed = callout(u, input.staves, w, h, gap, grid)
      failures.push(i)
      ratios.push(widthRatio(u, columnXs, w, gap))
    }
    grid.add(placed.box)
    placements[placed.placement]++
    out[i] = draft(u, placed, fontPx, h)
  }

  return {
    labels: out as LabelDraft[],
    failures,
    spacingDemand: ratios.length ? Math.max(1, percentile(ratios, 0.9)) : 1,
    placements,
  }
}

function columnKey(u: LabelUnitInput): string {
  return `${u.staff}|${Math.round(u.x * 2)}`
}

function columnIndex(units: readonly LabelUnitInput[]): Map<string, number[]> {
  const m = new Map<string, number[]>()
  units.forEach((u, i) => {
    const k = columnKey(u)
    const list = m.get(k)
    if (list) list.push(i)
    else m.set(k, [i])
  })
  return m
}

/** Candidate boxes in preference order (see module doc). */
export function* candidates(head: Box, w: number, h: number, gap: number): Generator<Candidate> {
  const cy = centerY(head)
  const y0 = cy - h / 2
  const rx = right(head) + gap
  const lx = head.x - gap - w
  for (const off of [0, 3, 6, 10]) {
    yield { box: { x: rx + off, y: y0, w, h }, placement: 'right', anchor: 'start', leader: false }
    yield { box: { x: lx - off, y: y0, w, h }, placement: 'left', anchor: 'end', leader: false }
  }
  for (const dy of [-h / 2, h / 2]) {
    for (const off of [0, 4]) {
      yield { box: { x: rx + off, y: y0 + dy, w, h }, placement: 'stagger', anchor: 'start', leader: false }
      yield { box: { x: lx - off, y: y0 + dy, w, h }, placement: 'stagger', anchor: 'end', leader: false }
    }
  }
  for (const off of [6, 12, 18, 26]) {
    for (const dy of [-h, h, -1.5 * h, 1.5 * h, -2 * h, 2 * h]) {
      yield { box: { x: rx + off, y: y0 + dy, w, h }, placement: 'stack', anchor: 'start', leader: true }
      yield { box: { x: lx - off, y: y0 + dy, w, h }, placement: 'stack', anchor: 'end', leader: true }
    }
  }
}

/** A staggered label must still be nearer its own notehead than any other head in its column. */
function ownsStagger(b: Box, self: number, column: readonly number[], units: readonly LabelUnitInput[]): boolean {
  const cy = centerY(b)
  const own = Math.abs(centerY(units[self]!.head) - cy)
  for (const j of column) {
    if (j !== self && Math.abs(centerY(units[j]!.head) - cy) <= own) return false
  }
  return true
}

/** Callout above (upper half of the staff) or below the staff, searching outward until free. */
function callout(
  u: LabelUnitInput,
  staves: readonly StaffGeometry[],
  w: number,
  h: number,
  gap: number,
  grid: BoxGrid<Box>,
): Candidate {
  const staff = staves.find((s) => s.index === u.staff)
  const cx = u.head.x + u.head.w / 2
  const above = staff ? centerY(u.head) <= (staff.top + staff.bottom) / 2 : true
  const start = above
    ? Math.min(u.head.y, staff?.top ?? u.head.y) - gap - h
    : Math.max(bottom(u.head), staff?.bottom ?? 0) + gap
  for (let step = 0; step < 400; step++) {
    const y = above ? start - step * (h / 2) : start + step * (h / 2)
    for (const dx of [0, -w / 2, w / 2, -w, w]) {
      const b = { x: cx - w / 2 + dx, y, w, h }
      if (!grid.hit(b)) return { box: b, placement: 'callout', anchor: 'middle', leader: true }
    }
  }
  const y = above ? start - 400 * (h / 2) : start + 400 * (h / 2)
  return { box: { x: cx - w / 2, y, w, h }, placement: 'callout', anchor: 'middle', leader: true }
}

function draft(u: LabelUnitInput, c: Candidate, fontPx: number, h: number): LabelDraft {
  const b = c.box
  const baseline = b.y + (h + fontPx * 0.7) / 2
  const tx = c.anchor === 'start' ? b.x + 1 : c.anchor === 'end' ? b.x + b.w - 1 : b.x + b.w / 2
  const base = {
    notes: u.notes,
    occ: u.occ,
    staff: u.staff,
    hand: u.hand,
    box: b,
    tx,
    ty: baseline,
    placement: c.placement,
    anchor: c.anchor,
  }
  return c.leader ? { ...base, leader: leaderLine(u.head, b, c) } : base
}

/** Leader from the notehead edge to the nearest label edge. */
function leaderLine(head: Box, b: Box, c: Candidate): readonly [number, number, number, number] {
  const hy = centerY(head)
  if (c.placement === 'callout') {
    const hx = head.x + head.w / 2
    const above = b.y + b.h <= head.y
    return above ? [hx, head.y - 1, b.x + b.w / 2, b.y + b.h] : [hx, head.y + head.h + 1, b.x + b.w / 2, b.y]
  }
  if (c.anchor === 'start') return [head.x + head.w + 0.5, hy, b.x, centerY(b)]
  return [head.x - 0.5, hy, b.x + b.w, centerY(b)]
}

/** Sorted distinct column x per staff. */
function staffColumnXs(units: readonly LabelUnitInput[]): Map<number, number[]> {
  const m = new Map<number, Set<number>>()
  for (const u of units) {
    let set = m.get(u.staff)
    if (!set) {
      set = new Set()
      m.set(u.staff, set)
    }
    set.add(Math.round(u.x * 2) / 2)
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))
}

/** Column gap needed for a right label divided by the gap available to the next column on the staff. */
function widthRatio(u: LabelUnitInput, columnXs: Map<number, number[]>, w: number, gap: number): number {
  const xs = columnXs.get(u.staff) ?? []
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= u.x + 0.5) lo = mid + 1
    else hi = mid
  }
  const next = xs[lo]
  if (next === undefined) return 1.25
  const needed = u.head.w + 2 * gap + w + u.head.w / 2
  return Math.min(3, needed / Math.max(1, next - u.x))
}

function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? 1
}

/** Count of label boxes overlapping each other or an obstacle (0 for a valid layout). */
export function countCollisions(labels: readonly Pick<LabelBox, 'box'>[], obstacles: readonly Box[]): number {
  const grid = new BoxGrid<Box>(64)
  for (const o of obstacles) grid.add(o)
  let n = 0
  for (const l of labels) {
    if (grid.hit(l.box)) n++
    grid.add(l.box)
  }
  return n
}
