/**
 * Loop edge stepping for the Practice view (spec "Repeating passages"; DECISIONS U6, U21, U22):
 * the learner nudges the loop start or end one whole bar at a time. Bars are measure occurrences
 * (0-based performance order); a loop includes both boundary bars, optionally narrowed to notes
 * inside them (`PassageRange.start` / `end`, set with the strip's handles).
 *
 * A bar step moves an edge to the next barline in that direction: a note-level edge first snaps
 * to its own bar's barline, a barline edge moves one whole bar. A loop keeps at least one bar.
 */
import type { PassageRange } from '../core/model/practice'

/** A loop: bars `fromOcc`…`toOcc` (both included), optionally narrowed to notes (U21). */
export type LoopRange = PassageRange

export type LoopEdge = 'start' | 'end'
export type StepDirection = -1 | 1

export interface LoopStepAvailability {
  readonly startEarlier: boolean
  readonly startLater: boolean
  readonly endEarlier: boolean
  readonly endLater: boolean
}

const clampOcc = (occ: number, lastOcc: number): number => Math.min(Math.max(Math.trunc(occ), 0), Math.max(lastOcc, 0))

/**
 * Which of the four bar-step buttons can act.
 *
 * With no loop only the outward buttons work: "start earlier" makes a loop of the bar before the
 * current bar plus the current bar, "end later" makes the current bar plus the next. With a loop
 * each edge moves to the next barline, but never past the other edge (a loop is at least one bar
 * of barlines apart) and never outside `0..lastOcc`. A note-level edge can always snap outward to
 * its own bar's barline.
 */
export function loopStepAvailability(
  loop: LoopRange | null,
  currentOcc: number,
  lastOcc: number,
): LoopStepAvailability {
  if (loop === null) {
    const current = clampOcc(currentOcc, lastOcc)
    return { startEarlier: current > 0, startLater: false, endEarlier: false, endLater: current < lastOcc }
  }
  return {
    startEarlier: loop.start !== undefined || loop.fromOcc > 0,
    startLater: loop.fromOcc < loop.toOcc,
    endEarlier: loop.toOcc > loop.fromOcc,
    endLater: loop.end !== undefined || loop.toOcc < lastOcc,
  }
}

/**
 * The loop after pressing a bar-step button, or `null` when that button is unavailable (the caller
 * leaves the loop unchanged). `currentOcc` is the bar under the cursor line in the current view.
 * The edge that does not move keeps its exact note-level position.
 */
export function stepLoop(
  loop: LoopRange | null,
  edge: LoopEdge,
  dir: StepDirection,
  currentOcc: number,
  lastOcc: number,
): LoopRange | null {
  const available = loopStepAvailability(loop, currentOcc, lastOcc)
  const allowed =
    edge === 'start'
      ? dir < 0
        ? available.startEarlier
        : available.startLater
      : dir < 0
        ? available.endEarlier
        : available.endLater
  if (!allowed) return null
  if (loop === null) {
    const current = clampOcc(currentOcc, lastOcc)
    return edge === 'start' ? { fromOcc: current - 1, toOcc: current } : { fromOcc: current, toOcc: current + 1 }
  }
  const keepEnd = loop.end ? { end: loop.end } : {}
  const keepStart = loop.start ? { start: loop.start } : {}
  if (edge === 'start') {
    // Earlier: a note-level start snaps to its bar's barline first.
    const fromOcc = dir < 0 ? (loop.start ? loop.fromOcc : loop.fromOcc - 1) : loop.fromOcc + 1
    return { fromOcc, toOcc: loop.toOcc, ...keepEnd }
  }
  // Later: a note-level end snaps to its bar's end first.
  const toOcc = dir > 0 ? (loop.end ? loop.toOcc : loop.toOcc + 1) : loop.toOcc - 1
  return { fromOcc: loop.fromOcc, toOcc, ...keepStart }
}
