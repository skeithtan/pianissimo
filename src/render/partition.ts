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

/**
 * Default segment width (layout px): a measure or two. A segment is parsed, styled and laid out
 * in the frame that first needs it, so its size bounds the one hitch the strip can cause while
 * the music scrolls; one measure per staff stays within a fraction of a frame on the reference
 * tablet (PF6).
 */
export const DEFAULT_SEGMENT_WIDTH = 400

/** Segment overlap with its neighbors (layout px) so adjacent copies leave no hairline seam. */
export const SEAM = 2

/**
 * How far (layout px) a mark must reach into a segment to be copied into it. A measure's barline
 * and staff-line ends touch the next segment by about a pixel; the seam of the segment that owns
 * them covers that, so they are not copied (which once put both neighboring measures, two thirds
 * of all nodes, into every segment).
 */
export const CROSSING = 1.5

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
    // A unit goes into the segment holding its center (so every unit, even a 1 px connector on a
    // boundary, is drawn exactly once) and into every other segment it reaches more than
    // CROSSING px into (ties, slurs, hairpins, pedal lines). A neighboring measure whose barline
    // only touches the boundary is left out.
    const lo = b.x0 + CROSSING
    const hi = b.x1 - CROSSING
    const first = index === 0 ? -Infinity : b.x0
    const last = index === bounds.length - 1 ? Infinity : b.x1
    const parts: string[] = []
    for (const u of units) {
      if (u.x0 >= last) break
      const mid = (u.x0 + u.x1) / 2
      if ((u.x1 > lo && u.x0 < hi) || (mid >= first && mid < last)) parts.push(u.html)
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

/** One page-mode system to serialize (`partitionPage`). */
export interface PageSegmentInput {
  readonly occStart: number
  readonly occEnd: number
  /** The system's top-level engraved groups (stafflines, brace), tagged and sanitized. */
  readonly elements: readonly Element[]
  /** Page y extent of the segment (layout px). */
  readonly y0: number
  readonly y1: number
  /** Engraved y → page y shift (the engraving is wrapped in a `translate(0 dy)` group). */
  readonly dy: number
  readonly labelStart: number
  readonly labelEnd: number
}

/**
 * Page mode: one segment per system, each a standalone SVG whose viewBox is the system's page
 * extent (`-SEAM y0 (width + 2·SEAM) (y1 − y0)`), its engraving moved from engraved to page y by
 * one translate group. Systems never share marks: OSMD draws every tie, slur and bracket piece in
 * the staffline group of its own system.
 */
export function partitionPage(systems: readonly PageSegmentInput[], width: number): SegmentData[] {
  return systems.map((s, index): SegmentData => {
    const vw = width + 2 * SEAM
    const h = s.y1 - s.y0
    const body = s.elements.map((el) => el.outerHTML).join('')
    return {
      index,
      occStart: s.occStart,
      occEnd: s.occEnd,
      x0: 0,
      x1: width,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" class="pn-music" viewBox="${r(-SEAM)} ${r(s.y0)} ${r(vw)} ${r(h)}" ` +
        `width="${r(vw)}" height="${r(h)}"><g transform="translate(0 ${r(s.dy)})">${body}</g></svg>`,
      labelStart: s.labelStart,
      labelEnd: s.labelEnd,
      y0: s.y0,
      y1: s.y1,
      system: index,
    }
  })
}

const r = (v: number): string => String(Math.round(v * 100) / 100)
