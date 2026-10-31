/**
 * Passage selection rules (spec "Repeating passages", DECISIONS U5, U19, U21): a contiguous range
 * of measures, optionally narrowed to notes inside its boundary bars (exact `start` / `end`),
 * edited by dragging start/end handles (snapping to note onsets, `snap.ts`) or by tapping a start
 * and an end bar (whole bars).
 */
import type { PassageRange } from '../../core/model/practice'
import { eq } from '../../core/music/rational'

/** First and last occurrence (both included) with optional exact note-level edges. */
export type LoopRange = PassageRange

/** Moves one handle to bar `occ` (whole bars); the band never inverts and keeps at least one measure. */
export function dragHandle(range: LoopRange, handle: 'start' | 'end', occ: number): LoopRange {
  return handle === 'start'
    ? { fromOcc: Math.min(occ, range.toOcc), toOcc: range.toOcc, ...(range.end ? { end: range.end } : {}) }
    : { fromOcc: range.fromOcc, toOcc: Math.max(occ, range.fromOcc), ...(range.start ? { start: range.start } : {}) }
}

/** Tap selection: the first tap picks one measure, the second extends to the tapped measure. */
export function tapSelect(
  anchor: number | null,
  occ: number,
): { range: LoopRange; anchor: number | null; done: boolean } {
  if (anchor === null) return { range: { fromOcc: occ, toOcc: occ }, anchor: occ, done: false }
  return { range: { fromOcc: Math.min(anchor, occ), toOcc: Math.max(anchor, occ) }, anchor: null, done: true }
}

export function sameRange(a: LoopRange | null, b: LoopRange | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const edge = (x: LoopRange['start'], y: LoopRange['start']): boolean =>
    x === y || (x !== undefined && y !== undefined && eq(x, y))
  return a.fromOcc === b.fromOcc && a.toOcc === b.toOcc && edge(a.start, b.start) && edge(a.end, b.end)
}

/** Bars clamped to the layout; an exact edge is kept only while its bar is unchanged. */
export function clampRange(range: LoopRange, occCount: number): LoopRange {
  const last = Math.max(0, occCount - 1)
  const from = Math.min(Math.max(0, range.fromOcc), last)
  const to = Math.min(Math.max(from, range.toOcc), last)
  return {
    fromOcc: from,
    toOcc: to,
    ...(range.start && from === range.fromOcc ? { start: range.start } : {}),
    ...(range.end && to === range.toOcc ? { end: range.end } : {}),
  }
}
