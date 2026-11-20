/** Small geometry helpers shared by extraction, label layout and the strip (layout px). */
import type { Box, InkBounds, StaffGeometry } from './types'

export const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h })

export const right = (b: Box): number => b.x + b.w
export const bottom = (b: Box): number => b.y + b.h
export const centerX = (b: Box): number => b.x + b.w / 2
export const centerY = (b: Box): number => b.y + b.h / 2

/** True when the boxes overlap by more than `eps` in both axes (touching edges do not count). */
export function intersects(a: Box, b: Box, eps = 0.01): boolean {
  return a.x + a.w - eps > b.x && b.x + b.w - eps > a.x && a.y + a.h - eps > b.y && b.y + b.h - eps > a.y
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y }
}

export function unionAll(boxes: readonly Box[]): Box | undefined {
  let acc: Box | undefined
  for (const b of boxes) acc = acc ? union(acc, b) : b
  return acc
}

export function inflate(b: Box, dx: number, dy = dx): Box {
  return { x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy }
}

/** Round to `digits` decimals (keeps serialized layouts compact). */
export function round(v: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export function roundBox(b: Box, digits = 2): Box {
  return { x: round(b.x, digits), y: round(b.y, digits), w: round(b.w, digits), h: round(b.h, digits) }
}

export const INK_COLUMN_WIDTH = 24

/** Include all ink beyond the staves so a screen-space badge can clear a local span of the score. */
export function inkBounds(
  width: number,
  staves: readonly StaffGeometry[],
  boxes: readonly (readonly Box[])[],
  dy = 0,
): InkBounds {
  const columns = Math.ceil(width / INK_COLUMN_WIDTH)
  const staffTop = staves[0]?.top ?? 0
  const staffBottom = staves.at(-1)?.bottom ?? staffTop
  const top = new Array<number>(columns).fill(Math.floor(staffTop + dy))
  const bottom = new Array<number>(columns).fill(Math.ceil(staffBottom + dy))
  for (const group of boxes) {
    for (const ink of group) {
      if (ink.y >= staffTop && ink.y + ink.h <= staffBottom) continue
      const first = Math.max(0, Math.floor(ink.x / INK_COLUMN_WIDTH))
      const last = Math.min(columns - 1, Math.floor((ink.x + ink.w) / INK_COLUMN_WIDTH))
      const y0 = Math.floor(ink.y + dy)
      const y1 = Math.ceil(ink.y + ink.h + dy)
      for (let i = first; i <= last; i++) {
        top[i] = Math.min(top[i]!, y0)
        bottom[i] = Math.max(bottom[i]!, y1)
      }
    }
  }
  return { top, bottom }
}

/**
 * Uniform grid over x for box collision queries. Boxes are bucketed by the columns they cover;
 * queries return each candidate at most once per call.
 */
export class BoxGrid<T extends Box = Box> {
  private readonly cols = new Map<number, { b: T; s: number }[]>()
  private stamp = 0
  size = 0

  constructor(private readonly cell = 64) {}

  add(b: T): void {
    const entry = { b, s: 0 }
    const c0 = Math.floor(b.x / this.cell)
    const c1 = Math.floor((b.x + b.w) / this.cell)
    for (let c = c0; c <= c1; c++) {
      let list = this.cols.get(c)
      if (!list) {
        list = []
        this.cols.set(c, list)
      }
      list.push(entry)
    }
    this.size++
  }

  /** First stored box intersecting `q` and accepted by `filter`, if any. */
  hit(q: Box, filter?: (b: T) => boolean): T | undefined {
    const stamp = ++this.stamp
    const c0 = Math.floor(q.x / this.cell)
    const c1 = Math.floor((q.x + q.w) / this.cell)
    for (let c = c0; c <= c1; c++) {
      const list = this.cols.get(c)
      if (!list) continue
      for (const e of list) {
        if (e.s === stamp) continue
        e.s = stamp
        if (intersects(q, e.b) && (!filter || filter(e.b))) return e.b
      }
    }
    return undefined
  }

  /** All stored boxes intersecting `q`. */
  query(q: Box): T[] {
    const stamp = ++this.stamp
    const out: T[] = []
    const c0 = Math.floor(q.x / this.cell)
    const c1 = Math.floor((q.x + q.w) / this.cell)
    for (let c = c0; c <= c1; c++) {
      const list = this.cols.get(c)
      if (!list) continue
      for (const e of list) {
        if (e.s === stamp) continue
        e.s = stamp
        if (intersects(q, e.b)) out.push(e.b)
      }
    }
    return out
  }
}
