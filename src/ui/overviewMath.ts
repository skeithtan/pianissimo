/**
 * Geometry of the whole-piece overview bar. Measures are unfolded occurrences with performance
 * positions in whole notes. Each bar's width is proportional to the time spent in it (DECISIONS
 * U12, like Synthesia's overview): `seconds` from the tempo map, so slow sections are wide; bars
 * without seconds fall back to their whole-note length. Bar edges are computed once per
 * `measures` array (cached), so per-frame position updates are O(log bars).
 */
import type { PassageRange } from '../core/model/practice'
import type { ScoreModel } from '../core/model/score'
import { add, toNumber } from '../core/music/rational'
import { hasTempo, secondsBetween } from '../core/music/tempo'

export interface OverviewMeasure {
  /** Performance position where the bar starts, in whole notes. */
  readonly start: number
  readonly duration: number
  /** Playing time of the bar in seconds; widths are proportional to it (all bars or none). */
  readonly seconds?: number
  /** Label of a section starting at this bar (rehearsal mark or heading, I12). */
  readonly section?: string
}

/**
 * Overview measures for a score: positions, seconds per bar from its tempo map, and section
 * labels. The speed multiplier scales every bar alike, so proportions do not depend on it; it
 * only changes the seconds reported.
 */
export function overviewMeasures(
  model: Pick<ScoreModel, 'occurrences' | 'tempo'> & { readonly sections?: ScoreModel['sections'] },
  multiplier = 1,
): OverviewMeasure[] {
  const labels = new Map<number, string>()
  for (const s of model.sections ?? []) if (!labels.has(s.occ)) labels.set(s.occ, s.label)
  const timed = hasTempo(model.tempo) && Number.isFinite(multiplier) && multiplier > 0
  return model.occurrences.map((o) => {
    const m: { -readonly [K in keyof OverviewMeasure]: OverviewMeasure[K] } = {
      start: toNumber(o.start),
      duration: toNumber(o.duration),
    }
    if (timed) m.seconds = secondsBetween(model.tempo, o.start, add(o.start, o.duration), multiplier)
    const label = labels.get(o.index)
    if (label) m.section = label
    return m
  })
}

/** Whole-note length of the piece (end of the last bar). */
export function totalLength(measures: readonly OverviewMeasure[]): number {
  const last = measures[measures.length - 1]
  return last ? last.start + last.duration : 0
}

const edgeCache = new WeakMap<readonly OverviewMeasure[], Float64Array>()

/**
 * Bar edges as fractions of the overview (length = bars + 1, first 0, last 1): cumulative seconds
 * when every bar has them, else cumulative whole-note lengths. Cached per array.
 */
export function barEdges(measures: readonly OverviewMeasure[]): Float64Array {
  const hit = edgeCache.get(measures)
  if (hit) return hit
  const n = measures.length
  const edges = new Float64Array(n + 1)
  const timed = n > 0 && measures.every((m) => m.seconds !== undefined && Number.isFinite(m.seconds) && m.seconds >= 0)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const m = measures[i]!
    sum += Math.max(0, timed ? m.seconds! : m.duration)
    edges[i + 1] = sum
  }
  if (sum > 0) for (let i = 1; i <= n; i++) edges[i] = edges[i]! / sum
  edgeCache.set(measures, edges)
  return edges
}

/** Index of the bar containing `position`, clamped to the first and last bars. Empty piece -> 0. */
export function occAtPosition(measures: readonly OverviewMeasure[], position: number): number {
  let lo = 0
  let hi = measures.length - 1
  let answer = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (measures[mid]!.start <= position) {
      answer = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return answer
}

/** Fraction (0..1) of the bar's width at a horizontal pointer offset. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - left) / width))
}

/** Bar under a horizontal fraction of the overview. */
export function occAtFraction(measures: readonly OverviewMeasure[], fraction: number): number {
  const n = measures.length
  if (n === 0) return 0
  const e = barEdges(measures)
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (e[mid]! <= fraction) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Fraction of the overview at `position` (time-proportional between bar edges), clamped to 0..1. */
export function progressAt(measures: readonly OverviewMeasure[], position: number): number {
  const n = measures.length
  if (n === 0) return 0
  const e = barEdges(measures)
  const i = occAtPosition(measures, position)
  const m = measures[i]!
  const within = m.duration > 0 ? (position - m.start) / m.duration : position >= m.start ? 1 : 0
  const f = e[i]! + Math.min(1, Math.max(0, within)) * (e[i + 1]! - e[i]!)
  return Math.min(1, Math.max(0, f))
}

/**
 * Left edge and width (as fractions of the bar) of bars `fromOcc..toOcc`, inclusive of both, or of
 * the exact positions `start` / `end` inside them for a note-level loop (U21; linear in time
 * within a bar).
 */
export function loopExtent(
  measures: readonly OverviewMeasure[],
  fromOcc: number,
  toOcc: number,
  start?: number,
  end?: number,
): { left: number; width: number } | null {
  const n = measures.length
  if (n === 0 || totalLength(measures) <= 0) return null
  const a = Math.max(0, Math.min(fromOcc, toOcc, n - 1))
  const b = Math.min(n - 1, Math.max(fromOcc, toOcc, 0))
  const e = barEdges(measures)
  const left = start === undefined ? e[a]! : progressAt(measures, start)
  const right = end === undefined ? e[b + 1]! : progressAt(measures, end)
  return { left, width: Math.max(0, right - left) }
}

/**
 * The loop after dragging one of its edges to bar `occ` on the overview (whole bars only; note-level
 * edges belong to the stage, U21). The dragged edge lands on a barline, dropping its note-level
 * `start` / `end`; the other edge keeps its exact value. The edge never crosses the other one (the
 * loop keeps at least one bar) and never leaves `0..lastOcc`.
 */
export function dragLoopEdge(base: PassageRange, edge: 'start' | 'end', occ: number, lastOcc: number): PassageRange {
  const last = Math.max(0, lastOcc)
  const at = Math.trunc(occ)
  if (edge === 'start') {
    const fromOcc = Math.min(Math.max(at, 0), base.toOcc, last)
    return base.end ? { fromOcc, toOcc: base.toOcc, end: base.end } : { fromOcc, toOcc: base.toOcc }
  }
  const toOcc = Math.max(Math.min(at, last), base.fromOcc, 0)
  return base.start ? { fromOcc: base.fromOcc, toOcc, start: base.start } : { fromOcc: base.fromOcc, toOcc }
}

/** Horizontal resolution of the tick path (units of a 1000-wide viewBox). */
export const TICK_VIEWBOX_WIDTH = 1000
/** Ticks closer than this many viewBox units to the last drawn one are skipped (long pieces). */
const MIN_TICK_GAP = 4

/**
 * SVG path data (`M x 0V1 ...`, viewBox height 1) of the divisions between bars. A tick closer
 * than about 4 units (of 1000) to the previous drawn tick is skipped so dense stretches stay
 * legible.
 */
export function tickPath(measures: readonly OverviewMeasure[]): string {
  if (totalLength(measures) <= 0) return ''
  const e = barEdges(measures)
  let path = ''
  let last = 0
  for (let i = 1; i < measures.length; i++) {
    const x = e[i]! * TICK_VIEWBOX_WIDTH
    if (x - last < MIN_TICK_GAP || TICK_VIEWBOX_WIDTH - x < MIN_TICK_GAP / 2) continue
    path += `M${x.toFixed(2)} 0V1`
    last = x
  }
  return path
}

export interface SectionMarker {
  readonly occ: number
  readonly label: string
  /** Left edge and room until the next marker (or the end), as fractions of the overview. */
  readonly left: number
  readonly room: number
}

/** Section markers in bar order (bars with a `section` label). */
export function sectionMarkers(measures: readonly OverviewMeasure[]): SectionMarker[] {
  const e = barEdges(measures)
  const at: { occ: number; label: string }[] = []
  measures.forEach((m, occ) => {
    if (m.section) at.push({ occ, label: m.section })
  })
  return at.map((s, k) => {
    const left = e[s.occ]!
    const next = at[k + 1]
    return { ...s, left, room: (next ? e[next.occ]! : 1) - left }
  })
}

const sectionCache = new WeakMap<readonly OverviewMeasure[], readonly (string | undefined)[]>()

/** Label of the section the bar `occ` belongs to (last section starting at or before it). */
export function sectionAt(measures: readonly OverviewMeasure[], occ: number): string | undefined {
  let per = sectionCache.get(measures)
  if (!per) {
    let current: string | undefined
    per = measures.map((m) => (current = m.section ?? current))
    sectionCache.set(measures, per)
  }
  return per[Math.max(0, Math.min(occ, per.length - 1))]
}
