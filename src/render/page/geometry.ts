/**
 * Pure page-mode geometry (DECISIONS "Portrait page mode"): which system a position or a point
 * is in, where the cursor is drawn, how far the page scrolls to follow, and how a loop band
 * splits across systems. DOM-free; the view (`PageView`) does the drawing.
 */
import { type Rational, toNumber } from '../../core/music/rational'
import type { OccurrenceGeometry, PreparedLayout, SystemGeometry } from '../types'
import { CursorPath } from '../strip/cursorPath'
import type { LoopRange } from '../strip/loop'
import { occAtPosition, occAtX } from '../strip/scroll'
import {
  buildCursorKnots,
  buildLoopKnots,
  loopEdgeX,
  passagePositions,
  type CursorKnots,
  type LoopKnots,
} from '../strip/snap'

/** Side gutter of the page (screen px) at least, each side. */
export const PAGE_GUTTER = 16

/**
 * How far the page cursor bar reaches past the outer staff lines of its system (screen px,
 * DECISIONS U73): enough to cover a notehead sitting on the outer line, no more.
 */
export const PAGE_CURSOR_MARGIN = 16

/**
 * The page width to prepare for a stage `stageWidth` CSS px wide at `zoom`: the stage minus
 * its gutters, in layout px, rounded to 8 px so tiny size changes keep the cached layout.
 */
export function pageWidthFor(stageWidth: number, zoom: number): number {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  return Math.max(240, Math.round((Math.max(0, stageWidth) - 2 * PAGE_GUTTER) / z / 8) * 8)
}

export interface Band {
  readonly system: number
  readonly x0: number
  readonly x1: number
}

export class PageGeometry {
  readonly systems: readonly SystemGeometry[]
  /** System index by occurrence. */
  readonly systemOfOcc: Int32Array
  /** One cursor path per system: knots are that system's onsets (R12 within a line). */
  private readonly paths: CursorPath[]

  constructor(private readonly layout: PreparedLayout) {
    this.systems = layout.systems?.length ? layout.systems : [singleSystem(layout)]
    this.systemOfOcc = new Int32Array(layout.occurrences.length)
    this.systems.forEach((s, k) => {
      for (let o = s.occStart; o < s.occEnd; o++) this.systemOfOcc[o] = k
    })
    this.paths = this.systems.map((s) => new CursorPath(this.occurrencesOf(s.index)))
  }

  occurrencesOf(system: number): readonly OccurrenceGeometry[] {
    const s = this.systems[system]
    return s ? this.layout.occurrences.slice(s.occStart, s.occEnd) : []
  }

  /** System holding performance position `pos` (whole notes). */
  systemAt(pos: number): number {
    const occ = occAtPosition(this.layout.occurrences, pos)
    return occ < 0 ? 0 : this.systemOfOcc[occ]!
  }

  /**
   * Cursor x in its system: linear (`smooth: false`) or the monotone smooth path between that
   * system's onsets. At a system's end the cursor reaches the final barline, then the next
   * position is on the next system (a jump, never a glide back across the page).
   */
  cursorAt(pos: number, smooth = true): { system: number; x: number } {
    const system = this.systemAt(pos)
    const path = this.paths[system]!
    return { system, x: smooth ? path.smoothAt(pos) : path.at(pos) }
  }

  path(system: number): CursorPath {
    return this.paths[system]!
  }

  /** Top and bottom staff lines of a system (page y). */
  staffSpan(system: number): { top: number; bottom: number } {
    const st = this.systems[system]?.staves ?? []
    const top = st[0]?.top ?? 0
    return { top, bottom: st[st.length - 1]?.bottom ?? top }
  }

  /**
   * The cursor bar's reach above and below a system's staves at `scale` (screen px, U73):
   * `PAGE_CURSOR_MARGIN`, less toward a neighboring system whose staves are close (at most a
   * third of the gap between the two systems' staves), so the bar never enters another system.
   */
  cursorMargins(system: number, scale: number): { top: number; bottom: number } {
    const span = this.staffSpan(system)
    const cap = (gap: number): number => Math.max(0, Math.min(PAGE_CURSOR_MARGIN, (gap * scale) / 3))
    const prev = system > 0 && system < this.systems.length ? this.staffSpan(system - 1) : null
    const next = system >= 0 && system < this.systems.length - 1 ? this.staffSpan(system + 1) : null
    return {
      top: prev ? cap(span.top - prev.bottom) : PAGE_CURSOR_MARGIN,
      bottom: next ? cap(next.top - span.bottom) : PAGE_CURSOR_MARGIN,
    }
  }

  /** The system whose extent contains page y `y`, or the nearest one. */
  systemAtY(y: number): number {
    const s = this.systems
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s[mid]!.y0 <= y) lo = mid
      else hi = mid - 1
    }
    // Between two systems: the nearer one.
    const cur = s[lo]
    const next = s[lo + 1]
    if (cur && next && y > cur.y1 && next.y0 - y < y - cur.y1) return lo + 1
    return lo
  }

  /** Bar under a page point (layout px). */
  occAtPoint(x: number, y: number): number {
    const k = this.systemAtY(y)
    const s = this.systems[k]
    if (!s || s.occEnd <= s.occStart) return -1
    return s.occStart + occAtX(this.occurrencesOf(k), x)
  }

  /**
   * The scroll offset (screen px) that puts system `system`'s top `offset` of the way down the
   * viewport, clamped to the scrollable range.
   */
  followScroll(
    system: number,
    o: { scale: number; padTop: number; viewport: number; max: number; offset?: number },
  ): number {
    const s = this.systems[system]
    if (!s) return 0
    const y = o.padTop + (s.y0 - this.layout.top) * o.scale - o.viewport * (o.offset ?? 0.25)
    return Math.max(0, Math.min(Math.max(0, o.max), Math.round(y)))
  }

  /**
   * A passage drawn as one band per system it crosses: the first from its start edge to the
   * system's end, middle systems whole, the last to its end edge. Note-level edges sit where the
   * strip draws them (`loopEdgeX`), whole-bar edges on the barlines.
   */
  loopBands(r: LoopRange): Band[] {
    const occs = this.layout.occurrences
    const a = occs[r.fromOcc]
    const b = occs[r.toOcc]
    if (!a || !b) return []
    const pos = passagePositions(occs, r)
    const sa = this.systemOfOcc[r.fromOcc]!
    const sb = this.systemOfOcc[r.toOcc]!
    const startX = r.start ? loopEdgeX(occs, pos.start) : a.x0
    const endX = r.end ? loopEdgeX(occs, pos.end) : b.x1
    const out: Band[] = []
    for (let k = sa; k <= sb; k++) {
      const s = this.systems[k]!
      const first = occs[s.occStart]!
      const last = occs[s.occEnd - 1]!
      const x0 = k === sa ? startX : first.x0
      const x1 = k === sb ? endX : last.x1
      out.push({ system: k, x0, x1: Math.max(x0, x1) })
    }
    return out
  }

  /** The playhead's snap knots within one system (`setSnapPositions` onsets inside it). */
  cursorKnots(system: number, onsets: readonly Rational[]): CursorKnots {
    const s = this.systems[system]
    const occs = this.layout.occurrences
    if (!s) return buildCursorKnots(this.paths[0]!, [])
    const lo = occs[s.occStart]?.start ?? 0
    const last = occs[s.occEnd - 1]
    const hi = last ? last.start + last.duration : lo
    const inside = onsets.filter((p) => {
      const v = toNumber(p)
      return v >= lo - 1e-9 && v < hi - 1e-9
    })
    return buildCursorKnots(this.paths[system]!, inside)
  }

  /**
   * Loop-edge knots within one system: its barlines, the onsets inside its bars and its end
   * (the next system's first barline, drawn at this system's final barline). `occ` values are
   * the layout's own bar indices.
   */
  loopKnots(system: number, onsets: readonly Rational[] | null): LoopKnots {
    const s = this.systems[system]
    if (!s) return buildLoopKnots([], null)
    const k = buildLoopKnots(this.occurrencesOf(system), onsets)
    const occ = Int32Array.from(k.occ, (o) => o + s.occStart)
    return { ...k, occ }
  }
}

/** A strip layout seen as a page of one system (lets the view open any layout). */
function singleSystem(layout: PreparedLayout): SystemGeometry {
  return {
    index: 0,
    occStart: 0,
    occEnd: layout.occurrences.length,
    y0: layout.top,
    y1: layout.top + layout.height,
    staves: layout.staves,
  }
}
