/**
 * Segmentation (spec "Execution and rendering architecture": turn prepared geometry into
 * removable score segments; DECISIONS R1). The complete engraving is cut into measure-range
 * segments, each a standalone SVG in global layout coordinates. A mark crossing a boundary
 * (tie, slur, hairpin, pedal line, beam) is copied into every segment it touches and each copy is
 * clipped by its segment's viewBox, so the pieces line up exactly when mounted side by side.
 */
import type { SegmentData } from './types'

export interface SegmentBound {
  readonly occStart: number
  readonly occEnd: number
  readonly x0: number
  readonly x1: number
}

/** Default segment width (layout px): small enough to parse within a frame slice. */
export const DEFAULT_SEGMENT_WIDTH = 1600

/** Segment overlap with its neighbors (layout px) so adjacent copies leave no hairline seam. */
export const SEAM = 1

/**
 * Groups whole measures into segments of at least `target` px. The first segment starts at 0
 * (clefs, brace) and the last ends at `width`; a short tail is merged into its predecessor.
 */
export function segmentBounds(
  measures: readonly { readonly x0: number; readonly x1: number }[],
  width: number,
  target: number,
): SegmentBound[] {
  const out: SegmentBound[] = []
  let start = 0
  let x0 = 0
  for (let i = 0; i < measures.length; i++) {
    const end = measures[i]!.x1
    if (end - x0 >= target || i === measures.length - 1) {
      out.push({ occStart: start, occEnd: i + 1, x0, x1: i === measures.length - 1 ? Math.max(width, end) : end })
      start = i + 1
      x0 = end
    }
  }
  const last = out[out.length - 1]
  const prev = out[out.length - 2]
  if (last && prev && last.x1 - last.x0 < target / 3) {
    out.splice(out.length - 2, 2, { occStart: prev.occStart, occEnd: last.occEnd, x0: prev.x0, x1: last.x1 })
  }
  return out
}

interface Unit {
  readonly html: string
  readonly x0: number
  readonly x1: number
}

/**
 * Serializes the (already tagged and sanitized) engraving into per-segment SVG strings.
 * `units` are the top-level drawable groups: staffline children and other root children.
 */
export function partitionSvg(
  svg: SVGSVGElement,
  bounds: readonly SegmentBound[],
  top: number,
  height: number,
  labelRange: (b: SegmentBound) => readonly [number, number],
): SegmentData[] {
  const units: Unit[] = []
  const add = (el: Element): void => {
    const b = (el as SVGGraphicsElement).getBBox()
    if (b.width === 0 && b.height === 0 && el.childElementCount === 0 && el.tagName !== 'text') return
    units.push({ html: el.outerHTML, x0: b.x, x1: b.x + b.width })
  }
  for (const child of [...svg.children]) {
    if (child.classList.contains('staffline')) {
      for (const c of [...child.children]) add(c)
    } else {
      add(child)
    }
  }
  units.sort((a, b) => a.x0 - b.x0)

  return bounds.map((b, index): SegmentData => {
    const lo = b.x0 - SEAM - 1
    const hi = b.x1 + SEAM + 1
    const parts: string[] = []
    for (const u of units) {
      if (u.x0 > hi) break
      if (u.x1 >= lo) parts.push(u.html)
    }
    const vx = b.x0 - SEAM
    const vw = b.x1 - b.x0 + 2 * SEAM
    const [labelStart, labelEnd] = labelRange(b)
    return {
      index,
      occStart: b.occStart,
      occEnd: b.occEnd,
      x0: b.x0,
      x1: b.x1,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" class="pn-music" viewBox="${r(vx)} ${r(top)} ${r(vw)} ${r(height)}" ` +
        `width="${r(vw)}" height="${r(height)}">${parts.join('')}</svg>`,
      labelStart,
      labelEnd,
    }
  })
}

const r = (v: number): string => String(Math.round(v * 100) / 100)
