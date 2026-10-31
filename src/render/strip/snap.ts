/**
 * Snap targets for the strip's drags (DECISIONS U19, U21–U23), pure and DOM-free.
 *
 * - **Cursor knots**: the note onsets of the current hand selection (all onsets in Listen). The
 *   dragged playhead lands exactly on one; its x is the cursor path's x there (R12).
 * - **Loop knots**: every barline (bar start, plus the end of the piece) and every onset inside a
 *   bar. A loop is `[knot a, knot b)`: it starts at a note or a barline and ends just before the
 *   next note or at a barline. A knot's x is where the loop band's edge is drawn: the barline, or
 *   halfway between the previous engraved entry of the bar (any note or rest) and the note, so the
 *   note sits inside the band and its predecessor outside.
 *
 * Everything is built once per hand selection (O(bars + onsets)); a pointer move is one binary
 * search over a Float64Array.
 */
import type { PassageRange } from '../../core/model/practice'
import { type Rational, toNumber } from '../../core/music/rational'
import type { OccurrenceGeometry } from '../types'
import type { CursorPath } from './cursorPath'
import { occAtPosition, positionToX } from './scroll'

const EPS = 1e-9

export interface CursorKnots {
  /** Onset positions (whole notes), ascending. */
  readonly pos: Float64Array
  /** Cursor x (layout px) at each onset, non-decreasing. */
  readonly x: Float64Array
  readonly exact: readonly Rational[]
}

export interface LoopKnots {
  readonly pos: Float64Array
  /** Loop band edge x (layout px), non-decreasing. */
  readonly x: Float64Array
  /** Exact onset of a note knot strictly inside a bar; null for a barline (or the piece end). */
  readonly exact: readonly (Rational | null)[]
  /** Bar holding the knot: the bar a barline starts (the bar count for the piece end). */
  readonly occ: Int32Array
  /** 1 when a note of the hands starts here (a barline knot too, when a note is on the downbeat). */
  readonly note: Uint8Array
}

type Geometry = Pick<OccurrenceGeometry, 'start' | 'duration' | 'anchors' | 'x0' | 'x1'>

export function buildCursorKnots(path: CursorPath, onsets: readonly Rational[]): CursorKnots {
  const pos = Float64Array.from(onsets, toNumber)
  const x = new Float64Array(pos.length)
  let prev = -Infinity
  for (let k = 0; k < pos.length; k++) {
    prev = Math.max(prev, path.at(pos[k]!))
    x[k] = prev
  }
  return { pos, x, exact: onsets }
}

/**
 * Where a loop edge at `pos` is drawn: a barline at a bar start or the end of the piece, else
 * the midpoint between the previous engraved entry of the bar and the entry at `pos`.
 */
export function loopEdgeX(occurrences: readonly Geometry[], pos: number): number {
  const i = occAtPosition(occurrences, pos)
  const o = occurrences[i]
  if (!o) return 0
  if (pos <= o.start + EPS) return o.x0
  const off = pos - o.start
  if (off >= o.duration - EPS) return o.x1
  let prevX = o.x0
  for (const [p, x] of o.anchors) {
    if (p < off - EPS) prevX = x
    else break
  }
  return (prevX + positionToX(occurrences as readonly OccurrenceGeometry[], pos)) / 2
}

/**
 * Barlines plus the onsets inside bars. Without onsets (`null`: the hands are not known yet) every
 * barline counts as a note, so whole-bar editing works as before.
 */
export function buildLoopKnots(occurrences: readonly Geometry[], onsets: readonly Rational[] | null): LoopKnots {
  const list = onsets ?? []
  const pos: number[] = []
  const exact: (Rational | null)[] = []
  const occ: number[] = []
  const note: number[] = []
  let j = 0
  const n = occurrences.length
  for (let i = 0; i < n; i++) {
    const o = occurrences[i]!
    const end = o.start + o.duration
    // Onsets before this bar (float drift, or a model/layout mismatch) are skipped.
    while (j < list.length && toNumber(list[j]!) < o.start - EPS) j++
    let downbeat = onsets ? 0 : 1
    if (j < list.length && Math.abs(toNumber(list[j]!) - o.start) <= EPS) {
      downbeat = 1
      j++
    }
    pos.push(o.start)
    exact.push(null)
    occ.push(i)
    note.push(downbeat)
    while (j < list.length && toNumber(list[j]!) < end - EPS) {
      pos.push(toNumber(list[j]!))
      exact.push(list[j]!)
      occ.push(i)
      note.push(1)
      j++
    }
  }
  const last = occurrences[n - 1]
  if (last) {
    pos.push(last.start + last.duration)
    exact.push(null)
    occ.push(n)
    note.push(0)
  }
  const x = new Float64Array(pos.length)
  let prev = -Infinity
  for (let k = 0; k < pos.length; k++) {
    prev = Math.max(prev, loopEdgeX(occurrences, pos[k]!))
    x[k] = prev
  }
  return { pos: Float64Array.from(pos), x, exact, occ: Int32Array.from(occ), note: Uint8Array.from(note) }
}

/** Index in `lo..hi` whose x is nearest to `x` (ties go to the earlier knot). `xs` is non-decreasing. */
export function nearestKnot(xs: Float64Array, x: number, lo = 0, hi = xs.length - 1): number {
  if (hi < lo) return lo
  let a = lo
  let b = hi
  while (a < b) {
    const mid = (a + b) >> 1
    if (xs[mid]! < x) a = mid + 1
    else b = mid
  }
  // a = first index with xs ≥ x (or hi); compare with its predecessor.
  if (a > lo && x - xs[a - 1]! <= xs[a]! - x) return a - 1
  return a
}

/** Index of the first knot at or after position `p` (`pos.length` when there is none). */
export function firstKnotAtOrAfter(pos: Float64Array, p: number): number {
  let a = 0
  let b = pos.length
  while (a < b) {
    const mid = (a + b) >> 1
    if (pos[mid]! < p - EPS) a = mid + 1
    else b = mid
  }
  return a
}

/** Index of the knot at (or nearest to) position `p`. */
export function knotAtPosition(pos: Float64Array, p: number): number {
  let a = 0
  let b = pos.length - 1
  if (b < 0) return 0
  while (a < b) {
    const mid = (a + b) >> 1
    if (pos[mid]! < p - EPS) a = mid + 1
    else b = mid
  }
  if (a > 0 && Math.abs(pos[a - 1]! - p) < Math.abs(pos[a]! - p)) return a - 1
  return a
}

/** The passage `[knot a, knot b)`: bars from the knots, exact edges only for notes inside a bar. */
export function passageFromKnots(k: LoopKnots, a: number, b: number): PassageRange {
  const start = k.exact[a] ?? null
  const end = k.exact[b] ?? null
  const fromOcc = k.occ[a]!
  const toOcc = end ? k.occ[b]! : k.occ[b]! - 1
  return { fromOcc, toOcc: Math.max(fromOcc, toOcc), ...(start ? { start } : {}), ...(end ? { end } : {}) }
}

/** Float `[start, end)` of a passage in layout geometry (whole bars from the barlines). */
export function passagePositions(
  occurrences: readonly Pick<OccurrenceGeometry, 'start' | 'duration'>[],
  p: PassageRange,
): { start: number; end: number } {
  const a = occurrences[p.fromOcc]
  const b = occurrences[p.toOcc]
  return {
    start: p.start ? toNumber(p.start) : (a?.start ?? 0),
    end: p.end ? toNumber(p.end) : b ? b.start + b.duration : 0,
  }
}

/**
 * Index bounds for dragging one loop edge while the other stays at position `fixed`: the loop
 * never inverts and keeps at least one note of the hands (a note knot in `[start, end)`) when it
 * can; a loop around bars where the hands rest only stays non-empty.
 */
export function edgeLimits(k: LoopKnots, which: 'start' | 'end', fixed: number): { lo: number; hi: number } | null {
  const n = k.pos.length
  if (n < 2) return null
  if (which === 'start') {
    let last = -1
    let lastNote = -1
    for (let i = 0; i < n && k.pos[i]! < fixed - EPS; i++) {
      last = i
      if (k.note[i]) lastNote = i
    }
    const hi = lastNote >= 0 ? lastNote : last
    return hi < 0 ? null : { lo: 0, hi }
  }
  let first = -1
  let firstNote = -1
  for (let i = 0; i < n; i++) {
    if (k.pos[i]! < fixed - EPS) continue
    if (first < 0 && k.pos[i]! > fixed + EPS) first = i
    if (k.note[i]) {
      firstNote = i
      break
    }
  }
  const lo = firstNote >= 0 && firstNote + 1 < n ? firstNote + 1 : first
  return lo < 0 ? null : { lo, hi: n - 1 }
}
