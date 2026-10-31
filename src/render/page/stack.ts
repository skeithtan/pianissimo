/**
 * Page-mode layout arithmetic used while preparing (pure, DOM-free; DECISIONS "Portrait page
 * mode"). OSMD engraves systems with its own vertical spacing, which knows nothing about the
 * reserved note-label boxes. The page therefore restacks the systems: each system's content
 * extent (notation, labels, measure number, ottava brackets) is placed below the previous one
 * with a fixed gap, and every coordinate of that system moves by the same `dy`.
 */
import { round } from '../geom'
import type { Box, LabelBox, NoteGeometry, OccurrenceGeometry, OttavaGeometry, StaffGeometry } from '../types'

/** Space between two systems' content extents, layout px (each extent also carries 6 px padding). */
export const PAGE_SYSTEM_GAP = 36

export interface StackedSystem {
  /** Page y extent. */
  readonly y0: number
  readonly y1: number
  /** Engraved y → page y. */
  readonly dy: number
}

/**
 * Stacks engraved extents `[top, bottom]` (layout px, rounded outward to whole pixels) from page
 * y 0 down, `gap` apart.
 */
export function stackSystems(extents: readonly (readonly [number, number])[], gap = PAGE_SYSTEM_GAP): StackedSystem[] {
  const out: StackedSystem[] = []
  let y = 0
  for (const [top, bottom] of extents) {
    const e0 = Math.floor(top)
    const e1 = Math.max(e0 + 1, Math.ceil(bottom))
    out.push({ y0: y, y1: y + (e1 - e0), dy: y - e0 })
    y += e1 - e0 + gap
  }
  return out
}

export function shiftBox(b: Box, dy: number): Box {
  return { x: b.x, y: round(b.y + dy), w: b.w, h: b.h }
}

export function shiftStaves(staves: readonly StaffGeometry[], dy: number): StaffGeometry[] {
  return staves.map((s) => ({ index: s.index, top: round(s.top + dy), bottom: round(s.bottom + dy) }))
}

export function shiftNote(n: NoteGeometry, dy: number, system: number): NoteGeometry {
  return { ...n, head: shiftBox(n.head, dy), system }
}

export function shiftLabel(l: LabelBox, dy: number): LabelBox {
  const out: LabelBox = { ...l, box: shiftBox(l.box, dy), ty: round(l.ty + dy) }
  if (!l.leader) return out
  const [x1, y1, x2, y2] = l.leader
  return { ...out, leader: [x1, round(y1 + dy), x2, round(y2 + dy)] }
}

export function shiftOccurrence(o: OccurrenceGeometry, dy: number, system: number): OccurrenceGeometry {
  return { ...o, labelBox: shiftBox(o.labelBox, dy), system }
}

export function shiftOttava(g: OttavaGeometry, dy: number): OttavaGeometry {
  return { ...g, box: shiftBox(g.box, dy), labelBox: shiftBox(g.labelBox, dy) }
}

/** Index of the system whose staves are nearest to engraved y `y`. */
export function nearestSystem(systems: readonly { readonly staves: readonly StaffGeometry[] }[], y: number): number {
  let best = 0
  let bestD = Infinity
  systems.forEach((s, k) => {
    const top = s.staves[0]?.top ?? 0
    const bottom = s.staves[s.staves.length - 1]?.bottom ?? top
    const d = y < top ? top - y : y > bottom ? y - bottom : 0
    if (d < bestD) {
      bestD = d
      best = k
    }
  })
  return best
}
